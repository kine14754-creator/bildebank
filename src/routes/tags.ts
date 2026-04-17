import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { createDb, tags } from '../db'
import type { Env } from '../types'

export const tagRoutes = new Hono<{ Bindings: Env }>()

// GET / — list all tags for a tenant, sorted by name
tagRoutes.get('/', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const tenantId = c.req.query('tenantId') || 'default'

  const rows = await db
    .select()
    .from(tags)
    .where(eq(tags.tenantId, tenantId))
    .orderBy(tags.name)

  return c.json({ data: rows })
})
