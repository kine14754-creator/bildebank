import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { createDb, imageTags, images, tags } from '../db'
import type { Env } from '../types'

export const imageTagRoutes = new Hono<{ Bindings: Env }>()

// GET /:id/tags — list tags on an image
imageTagRoutes.get('/:id/tags', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const imageId = c.req.param('id')

  const rows = await db
    .select({
      id: tags.id,
      name: tags.name,
      slug: tags.slug,
      color: tags.color,
      tenantId: tags.tenantId,
      createdAt: tags.createdAt,
    })
    .from(imageTags)
    .innerJoin(tags, eq(tags.id, imageTags.tagId))
    .where(eq(imageTags.imageId, imageId))
    .orderBy(tags.name)

  return c.json({ data: rows })
})

// POST /:id/tags — add a tag to an image
imageTagRoutes.post('/:id/tags', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const imageId = c.req.param('id')
  const body = await c.req.json<{ tagId: string }>()

  if (!body.tagId) {
    return c.json({ error: 'tagId is required' }, 400)
  }

  const image = await db.select({ id: images.id }).from(images).where(eq(images.id, imageId)).limit(1)
  if (image.length === 0) return c.json({ error: 'Image not found' }, 404)

  const tag = await db.select({ id: tags.id }).from(tags).where(eq(tags.id, body.tagId)).limit(1)
  if (tag.length === 0) return c.json({ error: 'Tag not found' }, 404)

  await db.insert(imageTags).values({ imageId, tagId: body.tagId }).onConflictDoNothing()

  return c.json({ added: true }, 201)
})

// DELETE /:id/tags/:tagId — remove a tag from an image
imageTagRoutes.delete('/:id/tags/:tagId', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const imageId = c.req.param('id')
  const tagId = c.req.param('tagId')

  const deleted = await db
    .delete(imageTags)
    .where(and(eq(imageTags.imageId, imageId), eq(imageTags.tagId, tagId)))
    .returning()

  if (deleted.length === 0) {
    return c.json({ error: 'Tag not found on image' }, 404)
  }

  return c.json({ removed: true })
})
