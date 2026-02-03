import { createMcpProxy } from '../lib/mcp-proxy.js'
import { createMissingEnvVarRoute } from '../lib/missing-env-route.js'

const apiKey = process.env.CONTEXT7_API_KEY

export const context7Route = apiKey
  ? createMcpProxy({
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp', '--api-key', apiKey],
    })
  : createMissingEnvVarRoute('CONTEXT7_API_KEY')
