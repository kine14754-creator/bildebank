import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm'
import { folders, images, imageTags, tags, type Db, type Image } from '../db'
import { buildImageUrl, buildR2Key, uploadToR2, type AllowedMimeType } from '../r2/client'
import { canConvertToWebP, convertToWebP, toWebPKey } from '../utils/imageOptimize'
import { collectFolderSubtree } from './folders'
import type { Env } from '../types'

export interface ImageTag {
  id: string
  name: string
  slug: string
  color: string | null
}

/** webpUrl is only set once the image has actually been converted. */
export function maybeWebpUrl(baseUrl: string, key: string, mimeType: string): string | undefined {
  return canConvertToWebP(mimeType) ? buildImageUrl(baseUrl, toWebPKey(key)) : undefined
}

/** Escape LIKE wildcards so a search for "50%_off" matches that text literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

// ── Reads ───────────────────────────────────────────────────────────────────

export interface ImageQuery {
  tenantId: string
  folderId?: string
  /** Match the folder's whole subtree, not just its direct images. */
  recursive?: boolean
  search?: string
  /** Also match the search text against alt text (filename only by default). */
  searchAltText?: boolean
  tagIds?: string[]
  limit: number
  offset: number
  sortBy?: 'createdAt' | 'filename' | 'size'
  sortOrder?: 'asc' | 'desc'
}

/** Image rows matching the query, newest first by default. */
export async function queryImages(db: Db, q: ImageQuery): Promise<Image[]> {
  let tagImageIds: string[] | undefined
  if (q.tagIds && q.tagIds.length > 0) {
    const tagRows = await db
      .select({ imageId: imageTags.imageId })
      .from(imageTags)
      .where(inArray(imageTags.tagId, q.tagIds))
    tagImageIds = [...new Set(tagRows.map((r) => r.imageId))]
    if (tagImageIds.length === 0) return []
  }

  let folderIds: string[] | undefined
  if (q.folderId) {
    if (q.recursive) {
      const allFolders = await db
        .select({ id: folders.id, parentId: folders.parentId })
        .from(folders)
        .where(eq(folders.tenantId, q.tenantId))
      folderIds = collectFolderSubtree(allFolders, q.folderId)
    } else {
      folderIds = [q.folderId]
    }
  }

  let searchCondition: SQL | undefined
  if (q.search) {
    const pattern = `%${escapeLike(q.search)}%`
    searchCondition = q.searchAltText
      ? or(ilike(images.filename, pattern), ilike(images.altText, pattern))
      : ilike(images.filename, pattern)
  }

  const conditions = [
    eq(images.tenantId, q.tenantId),
    ...(folderIds ? [inArray(images.folderId, folderIds)] : []),
    ...(searchCondition ? [searchCondition] : []),
    ...(tagImageIds ? [inArray(images.id, tagImageIds)] : []),
  ]

  const sortColumn =
    q.sortBy === 'filename' ? images.filename : q.sortBy === 'size' ? images.size : images.createdAt
  const order = q.sortOrder === 'asc' ? asc(sortColumn) : desc(sortColumn)

  return db
    .select()
    .from(images)
    .where(and(...conditions))
    // id as a tie-breaker keeps offset pages stable when timestamps collide.
    .orderBy(order, asc(images.id))
    .limit(q.limit)
    .offset(q.offset)
}

/** Tags for a set of images in one query (avoids N+1). */
export async function tagsForImages(db: Db, imageIds: string[]): Promise<Record<string, ImageTag[]>> {
  const byImage: Record<string, ImageTag[]> = {}
  if (imageIds.length === 0) return byImage
  const rows = await db
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
  for (const { imageId, ...tag } of rows) {
    const bucket = byImage[imageId]
    if (bucket) bucket.push(tag)
    else byImage[imageId] = [tag]
  }
  return byImage
}

export async function getImageById(db: Db, id: string): Promise<Image | undefined> {
  const [image] = await db.select().from(images).where(eq(images.id, id)).limit(1)
  return image
}

export async function getImagesByIds(db: Db, ids: string[]): Promise<Image[]> {
  if (ids.length === 0) return []
  return db.select().from(images).where(inArray(images.id, ids))
}

/** Images whose filename equals `filename`, ignoring case. */
export async function findImagesByFilename(db: Db, tenantId: string, filename: string): Promise<Image[]> {
  return db
    .select()
    .from(images)
    .where(and(eq(images.tenantId, tenantId), sql`lower(${images.filename}) = lower(${filename})`))
    .orderBy(asc(images.createdAt))
}

// ── Writes ──────────────────────────────────────────────────────────────────

export interface StoreImageInput {
  buffer: ArrayBuffer
  mimeType: AllowedMimeType
  filename: string
  altText: string | null
  folderId: string | null
  tenantId: string
  tagIds?: string[]
}

/**
 * The upload pipeline shared by POST /api/images/upload and the MCP upload_image
 * tool: original to R2, best-effort WebP variant, then the database row (and tags).
 * The caller validates type and size first.
 */
export async function storeImage(env: Env, db: Db, input: StoreImageInput): Promise<Image> {
  const id = crypto.randomUUID()
  const key = buildR2Key(input.tenantId, input.mimeType, id)

  await uploadToR2(env.R2_BUCKET, key, input.buffer, input.mimeType)

  // WebP conversion is best-effort — it never fails the upload.
  if (canConvertToWebP(input.mimeType)) {
    try {
      const webpBuffer = await convertToWebP(input.buffer, input.mimeType)
      await uploadToR2(env.R2_BUCKET, toWebPKey(key), webpBuffer, 'image/webp')
    } catch (err) {
      console.error('WebP conversion failed:', err)
    }
  }

  const [image] = await db
    .insert(images)
    .values({
      id,
      key,
      filename: input.filename,
      size: input.buffer.byteLength,
      mimeType: input.mimeType,
      altText: input.altText,
      folderId: input.folderId ?? undefined,
      tenantId: input.tenantId,
    })
    .returning()

  if (input.tagIds && input.tagIds.length > 0) {
    await db
      .insert(imageTags)
      .values(input.tagIds.map((tagId) => ({ imageId: id, tagId })))
      .onConflictDoNothing()
  }

  return image as Image
}

export interface ImageUpdate {
  filename?: string
  altText?: string | null
  folderId?: string
}

/**
 * Change metadata on one image (only the fields given) and bump updatedAt.
 * Returns the updated row, or undefined when there is no such image.
 */
export async function updateImage(db: Db, id: string, patch: ImageUpdate): Promise<Image | undefined> {
  const set: Partial<Image> = { updatedAt: new Date() }
  if (patch.filename !== undefined) set.filename = patch.filename
  if (patch.altText !== undefined) set.altText = patch.altText
  if (patch.folderId !== undefined) set.folderId = patch.folderId
  const [row] = await db.update(images).set(set).where(eq(images.id, id)).returning()
  return row
}
