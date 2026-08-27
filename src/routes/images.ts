import { Hono } from 'hono'
import { eq, and, ilike, inArray, asc, desc } from 'drizzle-orm'
import { createDb, folders, images, imageTags, tags } from '../db'
import {
  isAllowedMimeType,
  MAX_FILE_SIZE,
  buildR2Key,
  buildImageUrl,
  uploadToR2,
  deleteFromR2,
} from '../r2/client'
import { canConvertToWebP, convertToWebP, toWebPKey } from '../utils/imageOptimize'
import type { Env } from '../types'

export const imageRoutes = new Hono<{ Bindings: Env }>()

/** Bygger webpUrl fra original nøkkel og baseUrl dersom bildet er konvertert */
function maybeWebpUrl(baseUrl: string, key: string, mimeType: string): string | undefined {
  return canConvertToWebP(mimeType) ? buildImageUrl(baseUrl, toWebPKey(key)) : undefined
}

/**
 * Collects a folder id together with every folder beneath it, breadth-first.
 * Guards against cycles so a corrupt parent chain cannot hang the request.
 */
function collectFolderSubtree(
  all: Array<{ id: string; parentId: string | null }>,
  rootId: string
): string[] {
  const childrenByParent = new Map<string, string[]>()
  for (const folder of all) {
    if (!folder.parentId) continue
    const bucket = childrenByParent.get(folder.parentId)
    if (bucket) bucket.push(folder.id)
    else childrenByParent.set(folder.parentId, [folder.id])
  }

  const collected = new Set<string>([rootId])
  const queue: string[] = [rootId]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const childId of childrenByParent.get(current) ?? []) {
      if (collected.has(childId)) continue
      collected.add(childId)
      queue.push(childId)
    }
  }
  return [...collected]
}

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

  const tenantId = (formData.get('tenantId') as string) || 'default'
  const altText = (formData.get('altText') as string) || null
  const folderId = (formData.get('folderId') as string) || null

  const id = crypto.randomUUID()
  const key = buildR2Key(tenantId, mimeType, id)
  const buffer = await file.arrayBuffer()

  // Last opp original
  await uploadToR2(c.env.R2_BUCKET, key, buffer, mimeType)

  // Konverter til WebP (best-effort — feiler ikke opplastingen om det går galt)
  if (canConvertToWebP(mimeType)) {
    try {
      const webpBuffer = await convertToWebP(buffer, mimeType)
      await uploadToR2(c.env.R2_BUCKET, toWebPKey(key), webpBuffer, 'image/webp')
    } catch (err) {
      console.error('WebP conversion failed:', err)
    }
  }

  const [image] = await db
    .insert(images)
    .values({ id, key, filename: file.name, size: file.size, mimeType, altText, folderId: folderId ?? undefined, tenantId })
    .returning()

  const baseUrl = new URL(c.req.url).origin
  return c.json(
    {
      id: image.id,
      url: buildImageUrl(baseUrl, key),
      webpUrl: maybeWebpUrl(baseUrl, key, mimeType),
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
  const tenantId = c.req.query('tenantId') || 'default'
  const folderId = c.req.query('folderId')
  const search = c.req.query('search')
  const tagIds = c.req.queries('tagId') ?? []
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200)
  const offset = parseInt(c.req.query('offset') || '0')
  const sortBy = c.req.query('sortBy') || 'createdAt'
  const sortOrder = c.req.query('sortOrder') || 'desc'
  // recursive=true makes a folder match its whole subtree, not just its direct children.
  const recursive = c.req.query('recursive') === 'true'

  let tagImageIds: string[] | undefined
  if (tagIds.length > 0) {
    const tagRows = await db
      .select({ imageId: imageTags.imageId })
      .from(imageTags)
      .where(inArray(imageTags.tagId, tagIds))
    tagImageIds = [...new Set(tagRows.map((r) => r.imageId))]
    if (tagImageIds.length === 0) return c.json({ data: [], limit, offset })
  }

  let folderIds: string[] | undefined
  if (folderId) {
    if (recursive) {
      const allFolders = await db
        .select({ id: folders.id, parentId: folders.parentId })
        .from(folders)
        .where(eq(folders.tenantId, tenantId))
      folderIds = collectFolderSubtree(allFolders, folderId)
    } else {
      folderIds = [folderId]
    }
  }

  const conditions = [
    eq(images.tenantId, tenantId),
    ...(folderIds ? [inArray(images.folderId, folderIds)] : []),
    ...(search ? [ilike(images.filename, `%${search}%`)] : []),
    ...(tagImageIds ? [inArray(images.id, tagImageIds)] : []),
  ]

  const sortColumn = sortBy === 'filename' ? images.filename
    : sortBy === 'size' ? images.size
    : images.createdAt
  const orderExpr = sortOrder === 'asc' ? asc(sortColumn) : desc(sortColumn)

  const rows = await db.select().from(images).where(and(...conditions)).orderBy(orderExpr).limit(limit).offset(offset)
  const baseUrl = new URL(c.req.url).origin

  // Hent tags for alle bildene i én ekstra query (unngår N+1)
  const tagsByImage: Record<string, Array<{ id: string; name: string; slug: string; color: string | null }>> = {}
  if (rows.length > 0) {
    const imageIds = rows.map((img) => img.id)
    const tagRows = await db
      .select({
        imageId: imageTags.imageId,
        id: tags.id,
        name: tags.name,
        slug: tags.slug,
        color: tags.color,
      })
      .from(imageTags)
      .innerJoin(tags, eq(tags.id, imageTags.tagId))
      .where(inArray(imageTags.imageId, imageIds))
      .orderBy(tags.name)

    for (const row of tagRows) {
      const bucket = tagsByImage[row.imageId]
      if (bucket) {
        bucket.push({ id: row.id, name: row.name, slug: row.slug, color: row.color })
      } else {
        tagsByImage[row.imageId] = [{ id: row.id, name: row.name, slug: row.slug, color: row.color }]
      }
    }
  }

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
  const [updated] = await db.update(images).set(updates).where(eq(images.id, id)).returning()
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

  const [updated] = await db.update(images).set({ filename: file.name, size: file.size, mimeType }).where(eq(images.id, id)).returning()
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
