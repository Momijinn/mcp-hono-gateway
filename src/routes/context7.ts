import { createMcpProxy } from '../lib/mcp-proxy.js'

const apiKey = process.env.CONTEXT7_API_KEY

if (!apiKey) {
  throw new Error('Missing CONTEXT7_API_KEY')
}

export const context7Route = createMcpProxy({
  command: 'npx',
  args: ['-y', '@upstash/context7-mcp', '--api-key', apiKey],
})
