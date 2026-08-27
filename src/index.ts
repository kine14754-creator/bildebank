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

// Origins allowed to call the API from a browser. Patterns, not plain
// strings: Hono's cors() compares an `origin` array with array.includes(),
// so a literal 'https://*.sanity.studio' entry would never match anything.
const ALLOWED_ORIGINS = [
  // Local studio dev server (sanity dev picks a free port, not always 3333)
  /^http:\/\/localhost:\d+$/,
  /^http:\/\/127\.0\.0\.1:\d+$/,
  // Studios deployed with `sanity deploy` (<host>.sanity.studio)
  /^https:\/\/([a-z0-9-]+\.)*sanity\.studio$/,
  // Studios embedded in the Sanity dashboard (www.sanity.io/@<org>/studio/...)
  /^https:\/\/([a-z0-9-]+\.)*sanity\.io$/,
  // Self-hosted studio
  /^https:\/\/sanity\.fmweb\.no$/,
]

app.use(
  '*',
  cors({
    origin: (origin) => (ALLOWED_ORIGINS.some((pattern) => pattern.test(origin)) ? origin : null),
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
