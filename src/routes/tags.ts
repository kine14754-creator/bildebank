import { Hono } from 'hono'
import { and, eq, sql } from 'drizzle-orm'
import { createDb, imageTags, tags } from '../db'
import type { Env } from '../types'

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export const tagRoutes = new Hono<{ Bindings: Env }>()

// GET / — list all tags for a tenant with image count
tagRoutes.get('/', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const tenantId = c.req.query('tenantId') || 'default'

  const rows = await db
    .select({
      id: tags.id,
      name: tags.name,
      slug: tags.slug,
      color: tags.color,
      tenantId: tags.tenantId,
      createdAt: tags.createdAt,
      imageCount: sql<number>`count(${imageTags.imageId})::int`,
    })
    .from(tags)
    .leftJoin(imageTags, eq(imageTags.tagId, tags.id))
    .where(eq(tags.tenantId, tenantId))
    .groupBy(tags.id)
    .orderBy(tags.name)

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
  const slug = toSlug(body.name)

  const existing = await db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.tenantId, tenantId), eq(tags.slug, slug)))
    .limit(1)

  if (existing.length > 0) {
    return c.json({ error: 'A tag with this name already exists' }, 409)
  }

  const [tag] = await db
    .insert(tags)
    .values({ name: body.name.trim(), slug, color: body.color ?? null, tenantId })
    .returning()

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
