import { createMcpProxy } from '../lib/mcp-proxy.js'

export const serverTimeRoute = createMcpProxy({
  command: 'uvx',
  args: ['mcp-server-time', '--local-timezone', 'Asia/Tokyo'],
})
