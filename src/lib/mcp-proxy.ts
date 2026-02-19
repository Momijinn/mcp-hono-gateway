import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { type JSONRPCMessage, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { Hono } from 'hono'

const readIntEnv = (key: string, fallback: number) => {
  const raw = process.env[key]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

const MCP_MAX_SESSIONS = readIntEnv('MCP_MAX_SESSIONS', 50)
const MCP_SESSION_IDLE_MS = readIntEnv('MCP_SESSION_IDLE_MS', 15 * 60_000)
const MCP_SESSION_MAX_LIFETIME_MS = readIntEnv('MCP_SESSION_MAX_LIFETIME_MS', 2 * 60 * 60_000)
const MCP_MAX_INIT_BODY_BYTES = readIntEnv('MCP_MAX_INIT_BODY_BYTES', 1_000_000)
const MCP_MAX_POST_BODY_BYTES = readIntEnv('MCP_MAX_POST_BODY_BYTES', MCP_MAX_INIT_BODY_BYTES)
const MCP_LOG_MEMORY = process.env.MCP_LOG_MEMORY === '1'

const nowMs = () => Date.now()

const jsonRpcError = (status: number, code: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const terminateChild = async (child: ChildProcessWithoutNullStreams) => {
  if (child.exitCode !== null) return
  if (child.killed) return

  try {
    child.kill('SIGTERM')
  } catch {
    // ignore
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      resolve()
    }, 2_000)

    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export const createMcpProxy = (config: {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
}) => {
  const app = new Hono()

  type Session = {
    transport: WebStandardStreamableHTTPServerTransport
    child: ChildProcessWithoutNullStreams
    requestQueue: Promise<unknown>
    rl: ReturnType<typeof createInterface>
    createdAtMs: number
    lastActivityMs: number
    cleanupStarted?: true
  }

  const sessions = new Map<string, Session>()

  const isSessionExpired = (session: Session) => {
    const now = nowMs()
    if (MCP_SESSION_IDLE_MS > 0 && now - session.lastActivityMs > MCP_SESSION_IDLE_MS) return true
    if (MCP_SESSION_MAX_LIFETIME_MS > 0 && now - session.createdAtMs > MCP_SESSION_MAX_LIFETIME_MS)
      return true
    return false
  }

  const cleanupSession = async (sessionId: string) => {
    const session = sessions.get(sessionId)
    if (!session) return

    if (session.cleanupStarted) return
    session.cleanupStarted = true

    sessions.delete(sessionId)
    console.log(`[mcp-proxy] Cleaning up session: ${sessionId}`)

    try {
      session.rl.removeAllListeners()
      session.rl.close()

      session.child.stdout.removeAllListeners()
      session.child.stderr.removeAllListeners()
      session.child.stdin.removeAllListeners()

      try {
        session.child.stdin.end()
      } catch {
        // ignore
      }

      await terminateChild(session.child)
      await session.transport.close()
    } catch (e) {
      console.error('[mcp-proxy] Error during cleanup:', e)
    }
  }

  // 定期的にアイドル/長寿命セッションを掃除して、メモリ/子プロセスが溜まらないようにする
  const sweeper = setInterval(() => {
    let swept = 0
    for (const [sessionId, session] of sessions.entries()) {
      if (isSessionExpired(session)) {
        swept++
        void cleanupSession(sessionId)
      }
    }

    if (MCP_LOG_MEMORY) {
      const m = process.memoryUsage()
      console.log(
        `[mcp-proxy] sessions=${sessions.size} swept=${swept} rss=${m.rss} heapUsed=${m.heapUsed} heapTotal=${m.heapTotal}`,
      )
    }
  }, 60_000)
  sweeper.unref()

  app.all('/', async (c) => {
    const method = c.req.method.toUpperCase()
    if (!['POST', 'GET', 'DELETE'].includes(method)) return c.body(null, 405)

    const sessionIdHeader = c.req.header('mcp-session-id')
    let parsedBody: unknown | undefined

    if (method === 'POST') {
      const contentLength = c.req.header('content-length')
      if (contentLength) {
        const len = Number(contentLength)
        const maxBytes = sessionIdHeader ? MCP_MAX_POST_BODY_BYTES : MCP_MAX_INIT_BODY_BYTES
        if (Number.isFinite(len) && maxBytes > 0 && len > maxBytes) {
          return jsonRpcError(413, -32000, `Request body too large (maxBytes=${maxBytes})`)
        }
      }
      try {
        parsedBody = await c.req.raw.clone().json()
      } catch {
        // Bodyが空、またはJSONでない場合は無視
      }
    }

    // --- 既存セッションの処理 ---
    if (sessionIdHeader) {
      const session = sessions.get(sessionIdHeader)
      if (!session) return jsonRpcError(404, -32000, 'Invalid session ID')

      session.lastActivityMs = nowMs()

      if (isSessionExpired(session)) {
        await cleanupSession(sessionIdHeader)
        return jsonRpcError(440, -32000, 'Session expired')
      }

      return await enqueueSessionRequest(session, () =>
        session.transport.handleRequest(c.req.raw, { parsedBody }),
      )
    }

    // --- 新規セッションの開始 ---
    if (method !== 'POST' || !isInitializeRequest(parsedBody)) {
      return jsonRpcError(400, -32000, 'Bad Request: Initialize expected')
    }

    if (MCP_MAX_SESSIONS > 0 && sessions.size >= MCP_MAX_SESSIONS) {
      return jsonRpcError(503, -32000, 'Too many active sessions')
    }

    const child = spawn(config.command, config.args, {
      env: { ...process.env, ...config.env, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'], // stderrを明示的に受け取る
    })

    // stderr のログ出力（重要）
    child.stderr.on('data', (data) => {
      console.error(`[mcp-server-stderr]: ${data.toString().trim()}`)
    })

    // Stdio -> Transport の橋渡し
    const rl = createInterface({ input: child.stdout })

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (newSessionId) => {
        sessions.set(newSessionId, {
          transport,
          child,
          requestQueue: Promise.resolve(),
          rl,
          createdAtMs: nowMs(),
          lastActivityMs: nowMs(),
        })
      },
      onsessionclosed: (closedSessionId) => {
        void cleanupSession(closedSessionId)
      },
    })

    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line)
        void transport.send(msg as JSONRPCMessage)
      } catch {
        // 非JSONログは無視
      }
    })

    // Transport -> Stdio の橋渡し
    transport.onmessage = async (message) => {
      if (child.stdin.writable) {
        child.stdin.write(`${JSON.stringify(message)}\n`)
      }
    }

    child.on('exit', () => {
      if (transport.sessionId) void cleanupSession(transport.sessionId)
    })

    await transport.start()

    // 初回リクエストの処理
    return await transport.handleRequest(c.req.raw, { parsedBody })
  })

  // キューイング処理
  function enqueueSessionRequest<T>(session: Session, fn: () => Promise<T>): Promise<T> {
    const run = () => fn()
    const next = session.requestQueue.then(run, run)
    session.requestQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  return app
}
