import { createMcpProxy } from '../lib/mcp-proxy.js'

export const awsKnowledgeRoute = createMcpProxy({
  command: 'uvx',
  args: ['fastmcp', 'run', 'https://knowledge-mcp.global.api.aws'],
})
