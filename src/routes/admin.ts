/**
 * Admin routes for the personal access tokens used to sign in to /mcp.
 * Mounted under /admin/mcp-tokens behind Bearer API_SECRET (see index.ts).
 *
 *   POST   /admin/mcp-tokens          { name, access? } → 201 { name, createdAt, access, token }
 *   GET    /admin/mcp-tokens                            → { tokens: [{ name, createdAt, access }] }
 *   PATCH  /admin/mcp-tokens/:name    { access }        → { name, createdAt, access }
 *   DELETE /admin/mcp-tokens/:name                      → { name, revokedGrants }
 *
 * The raw token is only ever in the POST response. DELETE removes the record and
 * revokes every OAuth grant issued with that token.
 */
import { Hono, type Context } from 'hono'
import { getOAuthRoles, publicOrigin, revokeAllGrants } from '../oauth'
import {
  accessOf,
  createToken,
  deleteToken,
  listTokens,
  setAccess,
  TokenError,
  userIdFor,
} from '../tokens'
import type { Env } from '../types'

type Ctx = Context<{ Bindings: Env }>

export const adminRoutes = new Hono<{ Bindings: Env }>()

adminRoutes.use('*', async (c, next) => {
  if (!c.env.OAUTH_KV) {
    return c.json({ error: 'The OAUTH_KV namespace binding is missing.' }, 503)
  }
  c.header('Cache-Control', 'no-store')
  await next()
})

adminRoutes.onError((err, c) => {
  if (err instanceof TokenError) return c.json({ error: err.message }, err.status)
  console.error('admin route failed', err)
  return c.json({ error: 'Internal error' }, 500)
})

async function jsonBody(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    throw new TokenError('Send a JSON body.', 400)
  }
}

adminRoutes.post('/', async (c) => {
  const body = await jsonBody(c)
  const { record, token } = await createToken(c.env.OAUTH_KV!, body.name, body.access)
  return c.json(
    { name: record.name, createdAt: record.createdAt, access: accessOf(record), token },
    201
  )
})

adminRoutes.get('/', async (c) => {
  return c.json({ tokens: await listTokens(c.env.OAUTH_KV!) })
})

adminRoutes.patch('/:name', async (c) => {
  const body = await jsonBody(c)
  return c.json(await setAccess(c.env.OAUTH_KV!, c.req.param('name'), body.access))
})

adminRoutes.delete('/:name', async (c) => {
  const record = await deleteToken(c.env.OAUTH_KV!, c.req.param('name'))
  const api = getOAuthRoles(publicOrigin(c.req.raw, c.env)).authServer.getOAuthApi(c.env)
  const revokedGrants = await revokeAllGrants(api, userIdFor(record))
  return c.json({ name: record.name, revokedGrants })
})
