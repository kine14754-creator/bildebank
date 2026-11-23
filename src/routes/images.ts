import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { createDb, images } from '../db'
import {
  isAllowedMimeType,
  MAX_FILE_SIZE,
  buildImageUrl,
  uploadToR2,
  deleteFromR2,
} from '../r2/client'
import { canConvertToWebP, convertToWebP, toWebPKey } from '../utils/imageOptimize'
import { readImageSize } from '../utils/imageSize'
import { maybeWebpUrl, queryImages, storeImage, tagsForImages } from '../services/images'
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
  if (!file || !(file instanceof File)) return c.json({ error: 'Missing "file" field' }, 400)

  const mimeType = file.type
  if (!isAllowedMimeType(mimeType)) return c.json({ error: `Unsupported file type: ${mimeType}` }, 415)
  if (file.size > MAX_FILE_SIZE) return c.json({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` }, 413)

  const image = await storeImage(c.env, db, {
    buffer: await file.arrayBuffer(),
    mimeType,
    filename: file.name,
    altText: (formData.get('altText') as string) || null,
    folderId: (formData.get('folderId') as string) || null,
    tenantId: (formData.get('tenantId') as string) || 'default',
  })

  const baseUrl = new URL(c.req.url).origin
  return c.json(
    {
      id: image.id,
      url: buildImageUrl(baseUrl, image.key),
      webpUrl: maybeWebpUrl(baseUrl, image.key, mimeType),
      filename: image.filename,
      size: image.size,
      mimeType: image.mimeType,
      altText: image.altText,
      folderId: image.folderId,
      tenantId: image.tenantId,
      createdAt: image.createdAt,
      tags: [],
    },
    201
  )
})

// GET /
imageRoutes.get('/', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200)
  const offset = parseInt(c.req.query('offset') || '0')
  const sortBy = c.req.query('sortBy')

  const rows = await queryImages(db, {
    tenantId: c.req.query('tenantId') || 'default',
    folderId: c.req.query('folderId') || undefined,
    // recursive=true makes a folder match its whole subtree, not just its direct children.
    recursive: c.req.query('recursive') === 'true',
    search: c.req.query('search') || undefined,
    tagIds: c.req.queries('tagId') ?? [],
    limit,
    offset,
    sortBy: sortBy === 'filename' || sortBy === 'size' ? sortBy : 'createdAt',
    sortOrder: c.req.query('sortOrder') === 'asc' ? 'asc' : 'desc',
  })
  const baseUrl = new URL(c.req.url).origin
  const tagsByImage = await tagsForImages(db, rows.map((img) => img.id))

  return c.json({
    data: rows.map((img) => ({
      ...img,
      url: buildImageUrl(baseUrl, img.key),
      webpUrl: maybeWebpUrl(baseUrl, img.key, img.mimeType),
      tags: tagsByImage[img.id] ?? [],
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
  if (!image) return c.json({ error: 'Image not found' }, 404)
  const baseUrl = new URL(c.req.url).origin
  return c.json({
    ...image,
    url: buildImageUrl(baseUrl, image.key),
    webpUrl: maybeWebpUrl(baseUrl, image.key, image.mimeType),
  })
})

// PATCH /:id
imageRoutes.patch('/:id', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const id = c.req.param('id')
  let body: { filename?: string; altText?: string; folderId?: string | null }
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }
  if (!body.filename && body.altText === undefined && body.folderId === undefined) {
    return c.json({ error: 'Nothing to update' }, 400)
  }
  const [image] = await db.select().from(images).where(eq(images.id, id)).limit(1)
  if (!image) return c.json({ error: 'Image not found' }, 404)
  const updates: Record<string, unknown> = {}
  if (body.filename?.trim()) updates.filename = body.filename.trim()
  if (body.altText !== undefined) updates.altText = body.altText
  if (body.folderId !== undefined) updates.folderId = body.folderId ?? null
  // The row was found above, so the update returns it.
  const [updated] = (await db.update(images).set(updates).where(eq(images.id, id)).returning()) as [typeof image]
  const baseUrl = new URL(c.req.url).origin
  return c.json({ ...updated, url: buildImageUrl(baseUrl, updated.key), webpUrl: maybeWebpUrl(baseUrl, updated.key, updated.mimeType) })
})

// PUT /:id/replace
imageRoutes.put('/:id/replace', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const id = c.req.param('id')
  const [image] = await db.select().from(images).where(eq(images.id, id)).limit(1)
  if (!image) return c.json({ error: 'Image not found' }, 404)
  let formData: FormData
  try { formData = await c.req.formData() } catch { return c.json({ error: 'Invalid multipart/form-data' }, 400) }
  const file = formData.get('file')
  if (!file || !(file instanceof File)) return c.json({ error: 'Missing "file" field' }, 400)
  const mimeType = file.type
  if (!isAllowedMimeType(mimeType)) return c.json({ error: `Unsupported file type: ${mimeType}` }, 415)
  if (file.size > MAX_FILE_SIZE) return c.json({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` }, 413)

  const buffer = await file.arrayBuffer()
  await uploadToR2(c.env.R2_BUCKET, image.key, buffer, mimeType)

  if (canConvertToWebP(mimeType)) {
    try {
      const webpBuffer = await convertToWebP(buffer, mimeType)
      await uploadToR2(c.env.R2_BUCKET, toWebPKey(image.key), webpBuffer, 'image/webp')
    } catch (err) {
      console.error('WebP conversion failed on replace:', err)
    }
  }

  // The row was found above, so the update returns it.
  const dimensions = readImageSize(buffer, mimeType)
  const [updated] = (await db
    .update(images)
    .set({
      filename: file.name,
      size: file.size,
      mimeType,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      updatedAt: new Date(),
    })
    .where(eq(images.id, id))
    .returning()) as [typeof image]
  const baseUrl = new URL(c.req.url).origin
  return c.json({ ...updated, url: buildImageUrl(baseUrl, updated.key), webpUrl: maybeWebpUrl(baseUrl, updated.key, updated.mimeType) })
})

// DELETE /:id
imageRoutes.delete('/:id', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const id = c.req.param('id')
  const [image] = await db.select().from(images).where(eq(images.id, id)).limit(1)
  if (!image) return c.json({ error: 'Image not found' }, 404)
  // Slett original og eventuell WebP-versjon
  await deleteFromR2(c.env.R2_BUCKET, image.key)
  if (canConvertToWebP(image.mimeType)) {
    await deleteFromR2(c.env.R2_BUCKET, toWebPKey(image.key)).catch(() => {})
  }
  await db.delete(images).where(eq(images.id, id))
  return c.json({ success: true })
})
