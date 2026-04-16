import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bearerAuth } from 'hono/bearer-auth'

export interface Env {
  R2_BUCKET: R2Bucket
  DATABASE_URL: string
  API_SECRET: string
  ENVIRONMENT: string
}

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
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  })
)

// Health check (no auth)
app.get('/health', (c) => c.json({ status: 'ok', env: c.env.ENVIRONMENT }))

// All /api/* routes require Bearer token
app.use('/api/*', async (c, next) => {
  const auth = bearerAuth({ token: c.env.API_SECRET })
  return auth(c, next)
})

// --- Images ---
app.post('/api/images/upload', async (c) => {
  // TODO (BL-17): implement image upload to R2
  return c.json({ message: 'Not implemented' }, 501)
})

app.get('/api/images', async (c) => {
  // TODO (BL-17): list images from DB
  return c.json({ message: 'Not implemented' }, 501)
})

app.get('/api/images/:id', async (c) => {
  return c.json({ message: 'Not implemented' }, 501)
})

app.delete('/api/images/:id', async (c) => {
  // TODO (BL-21): delete image from R2 + DB
  return c.json({ message: 'Not implemented' }, 501)
})

// --- Folders ---
app.get('/api/folders', async (c) => {
  // TODO (BL-22): list folders
  return c.json({ message: 'Not implemented' }, 501)
})

app.post('/api/folders', async (c) => {
  // TODO (BL-22): create folder
  return c.json({ message: 'Not implemented' }, 501)
})

// --- Tags ---
app.get('/api/tags', async (c) => {
  // TODO (BL-25): list tags
  return c.json({ message: 'Not implemented' }, 501)
})

export default app
