import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bearerAuth } from 'hono/bearer-auth'
import { imageRoutes } from './routes/images'
import { imageTagRoutes } from './routes/imageTags'
import { tagRoutes } from './routes/tags'
import { folderRoutes } from './routes/folders'
import { getFromR2 } from './r2/client'
import type { Env } from './types'

const app = new Hono<{ Bindings: Env }>()

// CORS -- allow Sanity Studio origins
app.use(
  '*',
  cors({
    origin: [
      'http://localhost:3333',
      'https://*.sanity.studio',
      'https://*.sanity.io',
      'https://sanity.fmweb.no',
    ],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  })
)

// Health check (no auth)
app.get('/health', (c) => c.json({ status: 'ok', env: c.env.ENVIRONMENT }))

// Public file serving from R2
app.get('/files/*', async (c) => {
  const key = c.req.path.replace('/files/', '')
  const object = await getFromR2(c.env.R2_BUCKET, key)

  if (!object) {
    return c.json({ error: 'Not found' }, 404)
  }

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')

  return new Response(object.body, { headers })
})

// All /api/* routes require Bearer token
app.use('/api/*', async (c, next) => {
  const auth = bearerAuth({ token: c.env.API_SECRET })
  return auth(c, next)
})

// Mount routes
app.route('/api/images', imageRoutes)
app.route('/api/images', imageTagRoutes)
app.route('/api/tags', tagRoutes)
app.route('/api/folders', folderRoutes)

export default app
