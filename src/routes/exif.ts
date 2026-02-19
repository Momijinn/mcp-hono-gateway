import { createMcpProxy } from '../lib/mcp-proxy.js'

const isProd = process.env.NODE_ENV === 'production'

export const exifRoute = createMcpProxy({
  command: 'node',
  args: isProd ? ['dist/mcp-servers/exif.js'] : ['--import', 'tsx', 'src/mcp-servers/exif.ts'],
})
