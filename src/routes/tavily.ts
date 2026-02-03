import { createMcpProxy } from '../lib/mcp-proxy.js'
import { createMissingEnvVarRoute } from '../lib/missing-env-route.js'

const apiKey = process.env.TAVILY_API_KEY

export const tavilyRoute = apiKey
  ? createMcpProxy({
      command: 'npx',
      args: ['-y', 'tavily-mcp@latest'],
      env: {
        TAVILY_API_KEY: apiKey,
      },
    })
  : createMissingEnvVarRoute('TAVILY_API_KEY')
