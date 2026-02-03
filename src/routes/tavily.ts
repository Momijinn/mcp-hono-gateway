import { createMcpProxy } from '../lib/mcp-proxy.js'

export const tavilyRoute = createMcpProxy({
  command: 'npx',
  args:   [
    "-y",
    "tavily-mcp@latest"
  ],
  env: {
    TAVILY_API_KEY: process.env.TAVILY_API_KEY ?? '',
  },
})
