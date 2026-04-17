import { Hono } from 'hono'
import { eq, and, ilike, inArray } from 'drizzle-orm'
import { createDb, images, imageTags } from '../db'
import {
  isAllowedMimeType,
  MAX_FILE_SIZE,
  buildR2Key,
  buildImageUrl,
  uploadToR2,
  deleteFromR2,
} from '../r2/client'
import type { Env } from '../types'

export const imageRoutes = new Hono<{ Bindings: Env }>()

// POST /upload
imageRoutes.post('/upload', async (c) => {
  const db = createDb(c.env.DATABASE_URL)

  let formData: FormData
  try {
    formData = await c.req.formData()
  } catch {
    return c.json({ error: 'Invalid multipart/form-data' }, 400)
  }

  const file = formData.get('file')
  if (!file || !(file instanceof File)) {
    return c.json({ error: 'Missing "file" field' }, 400)
  }

  const mimeType = file.type
  if (!isAllowedMimeType(mimeType)) {
    return c.json({ error: `Unsupported file type: ${mimeType}` }, 415)
  }

  if (file.size > MAX_FILE_SIZE) {
    return c.json({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` }, 413)
  }

  const tenantId = (formData.get('tenantId') as string) || 'default'
  const altText = (formData.get('altText') as string) || null
  const folderId = (formData.get('folderId') as string) || null

  const id = crypto.randomUUID()
  const key = buildR2Key(tenantId, mimeType, id)

  const buffer = await file.arrayBuffer()
  await uploadToR2(c.env.R2_BUCKET, key, buffer, mimeType)

  const [image] = await db
    .insert(images)
    .values({ id, key, filename: file.name, size: file.size, mimeType, altText, folderId: folderId ?? undefined, tenantId })
    .returning()

  const baseUrl = new URL(c.req.url).origin
  return c.json(
    { id: image.id, url: buildImageUrl(baseUrl, key), filename: image.filename, size: image.size, mimeType: image.mimeType, altText: image.altText, folderId: image.folderId, tenantId: image.tenantId, createdAt: image.createdAt },
    201
  )
})

// GET /
imageRoutes.get('/', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const tenantId = c.req.query('tenantId') || 'default'
  const folderId = c.req.query('folderId')
  const search = c.req.query('search')
  const tagId = c.req.query('tagId')
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200)
  const offset = parseInt(c.req.query('offset') || '0')

  let tagImageIds: string[] | undefined
  if (tagId) {
    const tagRows = await db.select({ imageId: imageTags.imageId }).from(imageTags).where(eq(imageTags.tagId, tagId))
    tagImageIds = tagRows.map((r) => r.imageId)
    if (tagImageIds.length === 0) return c.json({ data: [], limit, offset })
  }

  const conditions = [
    eq(images.tenantId, tenantId),
    ...(folderId ? [eq(images.folderId, folderId)] : []),
    ...(search ? [ilike(images.filename, `%${search}%`)] : []),
    ...(tagImageIds ? [inArray(images.id, tagImageIds)] : []),
  ]

  const rows = await db.select().from(images).where(and(...conditions)).limit(limit).offset(offset)
  const baseUrl = new URL(c.req.url).origin
  return c.json({ data: rows.map((img) => ({ ...img, url: buildImageUrl(baseUrl, img.key) })), limit, offset })
})

// GET /:id
imageRoutes.get('/:id', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const id = c.req.param('id')
  const [image] = await db.select().from(images).where(eq(images.id, id)).limit(1)
  if (!image) return c.json({ error: 'Image not found' }, 404)
  const baseUrl = new URL(c.req.url).origin
  return c.json({ ...image, url: buildImageUrl(baseUrl, image.key) })
})

// PATCH /:id — oppdater filename og/eller altText
imageRoutes.patch('/:id', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const id = c.req.param('id')

  let body: { filename?: string; altText?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (!body.filename && body.altText === undefined) return c.json({ error: 'Nothing to update' }, 400)

  const [image] = await db.select().from(images).where(eq(images.id, id)).limit(1)
  if (!image) return c.json({ error: 'Image not found' }, 404)

  const updates: Record<string, unknown> = {}
  if (body.filename?.trim()) updates.filename = body.filename.trim()
  if (body.altText !== undefined) updates.altText = body.altText

  const [updated] = await db.update(images).set(updates).where(eq(images.id, id)).returning()
  const baseUrl = new URL(c.req.url).origin
  return c.json({ ...updated, url: buildImageUrl(baseUrl, updated.key) })
})

// PUT /:id/replace — erstatt bildefil, behold samme R2-nøkkel/URL/ID
imageRoutes.put('/:id/replace', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const id = c.req.param('id')

  const [image] = await db.select().from(images).where(eq(images.id, id)).limit(1)
  if (!image) return c.json({ error: 'Image not found' }, 404)

  let formData: FormData
  try {
    formData = await c.req.formData()
  } catch {
    return c.json({ error: 'Invalid multipart/form-data' }, 400)
  }

  const file = formData.get('file')
  if (!file || !(file instanceof File)) return c.json({ error: 'Missing "file" field' }, 400)

  const mimeType = file.type
  if (!isAllowedMimeType(mimeType)) return c.json({ error: `Unsupported file type: ${mimeType}` }, 415)
  if (file.size > MAX_FILE_SIZE) return c.json({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` }, 413)

  // Overskriv filen i R2 med samme nøkkel — URL forblir uendret
  const buffer = await file.arrayBuffer()
  await uploadToR2(c.env.R2_BUCKET, image.key, buffer, mimeType)

  // Oppdater metadata i DB (behold key, id, tenantId)
  const [updated] = await db
    .update(images)
    .set({ filename: file.name, size: file.size, mimeType })
    .where(eq(images.id, id))
    .returning()

  const baseUrl = new URL(c.req.url).origin
  return c.json({ ...updated, url: buildImageUrl(baseUrl, updated.key) })
})

// DELETE /:id
imageRoutes.delete('/:id', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const id = c.req.param('id')
  const [image] = await db.select().from(images).where(eq(images.id, id)).limit(1)
  if (!image) return c.json({ error: 'Image not found' }, 404)
  await deleteFromR2(c.env.R2_BUCKET, image.key)
  await db.delete(images).where(eq(images.id, id))
  return c.json({ success: true })
})
