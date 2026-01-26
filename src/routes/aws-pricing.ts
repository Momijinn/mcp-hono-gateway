import { createMcpProxy } from '../lib/mcp-proxy.js'

export const awsPricingRoute = createMcpProxy({
  command: 'uvx',
  args: ['awslabs.aws-pricing-mcp-server@latest'],
  env: {
    AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
  },
})
