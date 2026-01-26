import { createMcpProxy } from '../lib/mcp-proxy.js'

export const yfmcpRoute = createMcpProxy({
  command: 'uvx',
  args: ['yfmcp@latest'],
})
