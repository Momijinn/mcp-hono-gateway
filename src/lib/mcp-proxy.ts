import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { type JSONRPCMessage, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { Hono } from 'hono'

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
  }

  const sessions = new Map<string, Session>()

  // ユーティリティ: JSON-RPCエラーレスポンス
  const jsonRpcError = (status: number, code: number, message: string) =>
    new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })

  const cleanupSession = async (sessionId: string) => {
    const session = sessions.get(sessionId)
    if (!session) return

    sessions.delete(sessionId)
    console.log(`[mcp-proxy] Cleaning up session: ${sessionId}`)

    try {
      session.child.kill()
      await session.transport.close()
    } catch (e) {
      console.error('[mcp-proxy] Error during cleanup:', e)
    }
  }

  app.all('/', async (c) => {
    const method = c.req.method.toUpperCase()
    if (!['POST', 'GET', 'DELETE'].includes(method)) return c.body(null, 405)

    const sessionIdHeader = c.req.header('mcp-session-id')
    let parsedBody: unknown | undefined

    if (method === 'POST') {
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

      return await enqueueSessionRequest(session, () =>
        session.transport.handleRequest(c.req.raw, { parsedBody }),
      )
    }

    // --- 新規セッションの開始 ---
    if (method !== 'POST' || !isInitializeRequest(parsedBody)) {
      return jsonRpcError(400, -32000, 'Bad Request: Initialize expected')
    }

    const child = spawn(config.command, config.args, {
      env: { ...process.env, ...config.env, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'], // stderrを明示的に受け取る
    })

    // stderr のログ出力（重要）
    child.stderr.on('data', (data) => {
      console.error(`[mcp-server-stderr]: ${data.toString().trim()}`)
    })

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (newSessionId) => {
        sessions.set(newSessionId, {
          transport,
          child,
          requestQueue: Promise.resolve(),
        })
      },
      onsessionclosed: (closedSessionId) => {
        void cleanupSession(closedSessionId)
      },
    })

    // Stdio -> Transport の橋渡し
    const rl = createInterface({ input: child.stdout })
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
