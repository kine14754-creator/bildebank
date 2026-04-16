import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import { createDb, images } from '../db'
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
    .values({
      id,
      key,
      filename: file.name,
      size: file.size,
      mimeType,
      altText,
      folderId: folderId ?? undefined,
      tenantId,
    })
    .returning()

  const baseUrl = new URL(c.req.url).origin
  return c.json(
    {
      id: image.id,
      url: buildImageUrl(baseUrl, key),
      filename: image.filename,
      size: image.size,
      mimeType: image.mimeType,
      altText: image.altText,
      folderId: image.folderId,
      tenantId: image.tenantId,
      createdAt: image.createdAt,
    },
    201
  )
})

// GET /
imageRoutes.get('/', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const tenantId = c.req.query('tenantId') || 'default'
  const folderId = c.req.query('folderId')
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200)
  const offset = parseInt(c.req.query('offset') || '0')

  const rows = await db
    .select()
    .from(images)
    .where(
      folderId
        ? and(eq(images.tenantId, tenantId), eq(images.folderId, folderId))
        : eq(images.tenantId, tenantId)
    )
    .limit(limit)
    .offset(offset)

  const baseUrl = new URL(c.req.url).origin
  return c.json({
    data: rows.map((img) => ({
      ...img,
      url: buildImageUrl(baseUrl, img.key),
    })),
    limit,
    offset,
  })
})

// GET /:id
imageRoutes.get('/:id', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const id = c.req.param('id')

  const [image] = await db.select().from(images).where(eq(images.id, id)).limit(1)

  if (!image) {
    return c.json({ error: 'Image not found' }, 404)
  }

  const baseUrl = new URL(c.req.url).origin
  return c.json({
    ...image,
    url: buildImageUrl(baseUrl, image.key),
  })
})

// DELETE /:id
imageRoutes.delete('/:id', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const id = c.req.param('id')

  const [image] = await db.select().from(images).where(eq(images.id, id)).limit(1)

  if (!image) {
    return c.json({ error: 'Image not found' }, 404)
  }

  await deleteFromR2(c.env.R2_BUCKET, image.key)
  await db.delete(images).where(eq(images.id, id))

  return c.json({ success: true })
})
