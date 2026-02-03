import { Hono } from 'hono'

const jsonRpcError = (status: number, code: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

export const createMissingEnvVarRoute = (
  envVarName: string,
  opts?: {
    status?: number
    code?: number
    messagePrefix?: string
  },
) => {
  const app = new Hono()

  const status = opts?.status ?? 500
  const code = opts?.code ?? -32000
  const messagePrefix = opts?.messagePrefix ?? 'Missing'

  app.all('/', () => jsonRpcError(status, code, `${messagePrefix} ${envVarName}`))

  return app
}
