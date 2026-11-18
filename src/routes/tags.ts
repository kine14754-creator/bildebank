import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { createDb, tags } from '../db'
import { findExistingTag, insertTag, listTagsWithCounts } from '../services/tags'
import type { Env } from '../types'

export const tagRoutes = new Hono<{ Bindings: Env }>()

// GET / — list all tags for a tenant with image count
tagRoutes.get('/', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const tenantId = c.req.query('tenantId') || 'default'

  const rows = await listTagsWithCounts(db, tenantId)

  return c.json({ data: rows })
})

// POST / — create a new tag
tagRoutes.post('/', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const body = await c.req.json<{ name: string; color?: string; tenantId?: string }>()

  if (!body.name?.trim()) {
    return c.json({ error: 'name is required' }, 400)
  }

  const tenantId = body.tenantId || 'default'

  if (await findExistingTag(db, tenantId, body.name)) {
    return c.json({ error: 'A tag with this name already exists' }, 409)
  }

  const tag = await insertTag(db, { name: body.name, color: body.color, tenantId })

  return c.json(tag, 201)
})

// DELETE /:id — delete a tag (cascades to image_tags)
tagRoutes.delete('/:id', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const id = c.req.param('id')

  const deleted = await db.delete(tags).where(eq(tags.id, id)).returning({ id: tags.id })

  if (deleted.length === 0) {
    return c.json({ error: 'Tag not found' }, 404)
  }

  return c.json({ deleted: true })
})
