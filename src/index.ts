import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { logger } from 'hono/logger'
import { awsKnowledgeRoute } from './routes/aws-knowledge.js'
import { awsPricingRoute } from './routes/aws-pricing.js'
import { context7Route } from './routes/context7.js'
import { exifRoute } from './routes/exif.js'
import { serverTimeRoute } from './routes/server-time.js'
import { tavilyRoute } from './routes/tavily.js'
import { yfmcpRoute } from './routes/yfmcp.js'

const app = new Hono()

const token = process.env.BEARER_TOKEN || ''

if (token) {
  app.use('*', bearerAuth({ token }))
}

app.use('*', logger())

app.route('/server-time', serverTimeRoute)
app.route('/aws-pricing', awsPricingRoute)
app.route('/aws-knowledge', awsKnowledgeRoute)
app.route('/context7', context7Route)
app.route('/exif', exifRoute)
app.route('/yfmcp', yfmcpRoute)
app.route('/tavily', tavilyRoute)

serve({
  fetch: app.fetch,
  port: 3000,
})

export default app
