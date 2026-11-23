/**
 * MCP tools for Bildebank: list_folders, search_images, view_image, get_image,
 * list_tags, get_upload_session (read) and upload_image, create_upload_link,
 * update_image, create_tag, set_image_tags (write).
 *
 * Same layout as the Broadcast MCP (nimlas-sites/packages/broadcast-worker/src/mcp.ts):
 * every tool calls the worker's own service layer directly (src/services/*) —
 * no HTTP round trip to /api — and is served at /mcp behind OAuth (see oauth.ts).
 * There are deliberately no delete tools; update_image is the only way to rename
 * an image or move it to another folder.
 *
 * Access levels: every personal access token is "read" or "write". Tools that
 * change data are registered inside writeTools(), which leaves them off the
 * server entirely for read tokens, and their functions also call requireWrite()
 * so they refuse a read context even if invoked some other way. Any new tool
 * that mutates data must do both.
 */
import { McpServer } from '@modelcontextprotocol/server'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { createDb, folders, type Db, type Image } from './db'
import { buildImageUrl, getFromR2, MAX_FILE_SIZE } from './r2/client'
import {
  directImageCounts,
  folderPaths,
  collectFolderSubtree,
  listTenantFolders,
} from './services/folders'
import {
  findImagesByFilename,
  getImageById,
  getImagesByIds,
  maybeWebpUrl,
  queryImages,
  storeImage,
  tagsForImages,
  updateImage as updateImageRow,
  type ImageTag,
  type ImageUpdate,
} from './services/images'
import {
  addTagsToImage,
  existingTagIds,
  findExistingTag,
  insertTag,
  listTagsWithCounts,
  removeTagsFromImage,
} from './services/tags'
import { makePreview } from './utils/preview'
import {
  cleanFilename,
  deriveFilename,
  fetchRemoteImage,
  RemoteFetchError,
  validateSourceUrl,
} from './utils/remoteFetch'
import type { Access } from './tokens'
import {
  createUploadSession,
  getUploadSession as loadUploadSession,
  isExpired,
  listUploadedFiles,
  UPLOAD_SESSION_MAX_FILES,
  UPLOAD_SESSION_MINUTES,
  UPLOAD_FILE_FIELD,
  UPLOAD_FORCE_FIELD,
  uploadUrl,
  type Actor,
} from './uploadSessions'
import type { Env } from './types'

/** Every MCP call works on the default tenant, like the Studio plugin. */
export const TENANT_ID = 'default'
export const SEARCH_DEFAULT_LIMIT = 25
export const SEARCH_MAX_LIMIT = 50
export const VIEW_MAX_IMAGES = 6
export const VIEW_DEFAULT_SIZE = 512
export const VIEW_MAX_SIZE = 1024

export interface ToolContext {
  env: Env
  db: Db
  /** Public origin used to build file URLs, e.g. https://bildebank.x.workers.dev */
  baseUrl: string
  /** Access level of the signed-in token. Write tools refuse anything but "write". */
  access: Access
  /** The personal access token behind this request, for attributing writes. */
  actor?: Actor
}

// ── Tool results ────────────────────────────────────────────────────────────

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export type ToolResult = {
  content: Content[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

class ToolError extends Error {}

function ok(payload: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  }
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function guarded(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof ToolError || err instanceof RemoteFetchError) return fail(err.message)
    return fail(`Unexpected error: ${errorMessage(err)}`)
  }
}

/** Throw unless the caller's token has write access. Call first in every write tool. */
function requireWrite(ctx: ToolContext): void {
  if (ctx.access !== 'write') {
    throw new ToolError(
      'This personal access token is read-only. Ask the Bildebank admin for write access.'
    )
  }
}

// ── Shared lookups ──────────────────────────────────────────────────────────

const uuid = z.string().uuid()

/** Folder rows plus each folder's display path, loaded once per call. */
async function loadFolders(db: Db) {
  const rows = await listTenantFolders(db, TENANT_ID)
  return { rows, paths: folderPaths(rows) }
}

/** The search/get representation of an image (text only). */
function describeImage(
  ctx: ToolContext,
  img: Image,
  imageTags: ImageTag[],
  paths: Map<string, string>
) {
  return {
    id: img.id,
    filename: img.filename,
    altText: img.altText,
    tags: imageTags.map((t) => ({ id: t.id, name: t.name })),
    folderId: img.folderId,
    folderPath: img.folderId ? (paths.get(img.folderId) ?? null) : null,
    width: img.width,
    height: img.height,
    url: buildImageUrl(ctx.baseUrl, img.key),
    webpUrl: maybeWebpUrl(ctx.baseUrl, img.key, img.mimeType) ?? null,
    createdAt: img.createdAt.toISOString(),
  }
}

/** Opaque pagination cursor: the offset of the next page. */
export function encodeCursor(offset: number): string {
  return btoa(JSON.stringify({ o: offset }))
}

export function decodeCursor(cursor: string): number {
  try {
    const { o } = JSON.parse(atob(cursor)) as { o: unknown }
    if (typeof o === 'number' && Number.isInteger(o) && o >= 0) return o
  } catch {
    // fall through
  }
  throw new ToolError('Invalid cursor. Pass the nextCursor value from a previous search_images result.')
}

async function assertFolderExists(db: Db, folderId: string): Promise<void> {
  const [row] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.id, folderId), eq(folders.tenantId, TENANT_ID)))
    .limit(1)
  if (!row) throw new ToolError(`Folder ${folderId} does not exist. Use list_folders to find folder ids.`)
}

async function assertTagsExist(db: Db, tagIds: string[]): Promise<void> {
  if (tagIds.length === 0) return
  const found = await existingTagIds(db, TENANT_ID, tagIds)
  const missing = tagIds.filter((id) => !found.has(id))
  if (missing.length) throw new ToolError(`Unknown tag id(s): ${missing.join(', ')}`)
}

// ── Tool implementations (exported for tests) ───────────────────────────────

export async function listFolders(
  ctx: ToolContext,
  input: { parentId?: string }
): Promise<ToolResult> {
  return guarded(async () => {
    const { rows, paths } = await loadFolders(ctx.db)
    const direct = await directImageCounts(ctx.db, TENANT_ID)

    // Recursive count = own images + every descendant's. Subtrees are small, so
    // collecting each folder's subtree is fine and stays cycle-safe.
    const refs = rows.map((f) => ({ id: f.id, parentId: f.parentId }))
    const recursiveCount = (id: string) =>
      collectFolderSubtree(refs, id).reduce((sum, fid) => sum + (direct.get(fid) ?? 0), 0)

    let scope = rows
    if (input.parentId) {
      if (!rows.some((f) => f.id === input.parentId)) {
        throw new ToolError(`Folder ${input.parentId} does not exist.`)
      }
      const subtree = new Set(collectFolderSubtree(refs, input.parentId))
      subtree.delete(input.parentId)
      scope = rows.filter((f) => subtree.has(f.id))
    }

    const list = scope
      .map((f) => ({
        id: f.id,
        name: f.name,
        parentId: f.parentId,
        path: paths.get(f.id) ?? f.name,
        imageCount: { direct: direct.get(f.id) ?? 0, recursive: recursiveCount(f.id) },
      }))
      .sort((a, b) => a.path.localeCompare(b.path))

    return ok({
      ...(input.parentId
        ? { parent: { id: input.parentId, path: paths.get(input.parentId) } }
        : {
            totalImages: [...direct.values()].reduce((a, b) => a + b, 0),
            imagesWithoutFolder: direct.get(null) ?? 0,
          }),
      folders: list,
    })
  })
}

export interface SearchInput {
  search?: string
  folderId?: string
  recursive?: boolean
  tagIds?: string[]
  limit?: number
  cursor?: string
}

export async function searchImages(ctx: ToolContext, input: SearchInput): Promise<ToolResult> {
  return guarded(async () => {
    const limit = Math.min(Math.max(input.limit ?? SEARCH_DEFAULT_LIMIT, 1), SEARCH_MAX_LIMIT)
    const offset = input.cursor ? decodeCursor(input.cursor) : 0
    if (input.folderId) await assertFolderExists(ctx.db, input.folderId)

    // One extra row tells us whether there is a next page.
    const rows = await queryImages(ctx.db, {
      tenantId: TENANT_ID,
      folderId: input.folderId,
      recursive: input.recursive ?? true,
      search: input.search?.trim() || undefined,
      searchAltText: true,
      tagIds: input.tagIds,
      limit: limit + 1,
      offset,
    })
    const page = rows.slice(0, limit)
    const [tagsByImage, { paths }] = await Promise.all([
      tagsForImages(ctx.db, page.map((r) => r.id)),
      loadFolders(ctx.db),
    ])

    return ok({
      count: page.length,
      images: page.map((img) => describeImage(ctx, img, tagsByImage[img.id] ?? [], paths)),
      nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
    })
  })
}

export async function viewImages(
  ctx: ToolContext,
  input: { ids: string[]; maxSize?: number }
): Promise<ToolResult> {
  return guarded(async () => {
    const ids = [...new Set(input.ids)]
    if (ids.length === 0 || ids.length > VIEW_MAX_IMAGES) {
      throw new ToolError(`Pass between 1 and ${VIEW_MAX_IMAGES} image ids.`)
    }
    const maxSize = Math.min(Math.max(input.maxSize ?? VIEW_DEFAULT_SIZE, 64), VIEW_MAX_SIZE)
    const rows = await getImagesByIds(ctx.db, ids)
    const byId = new Map(rows.filter((r) => r.tenantId === TENANT_ID).map((r) => [r.id, r]))

    const content: Content[] = []
    let shown = 0
    // One at a time: keeps memory flat when previews are made from large originals.
    for (const id of ids) {
      const img = byId.get(id)
      if (!img) {
        content.push({ type: 'text', text: `id: ${id}\nNot found.` })
        continue
      }
      const url = buildImageUrl(ctx.baseUrl, img.key)
      const label = `id: ${img.id}\nfilename: ${img.filename}\nurl: ${url}`
      const object = await getFromR2(ctx.env.R2_BUCKET, img.key)
      if (!object) {
        content.push({ type: 'text', text: `${label}\nNo preview: the file is missing from storage.` })
        continue
      }
      const original = new Uint8Array(await object.arrayBuffer())
      const preview = await makePreview(ctx.env, original, img.mimeType, maxSize)
      if (preview.ok) {
        shown++
        content.push({ type: 'image', data: preview.data, mimeType: preview.mimeType })
        content.push({ type: 'text', text: label })
      } else {
        content.push({ type: 'text', text: `${label}\n${preview.reason}` })
      }
    }
    return { content, ...(shown === 0 ? { isError: true } : {}) }
  })
}

export async function getImage(ctx: ToolContext, input: { id: string }): Promise<ToolResult> {
  return guarded(async () => {
    const img = await getImageById(ctx.db, input.id)
    if (!img || img.tenantId !== TENANT_ID) throw new ToolError(`Image ${input.id} not found.`)
    const [tagsByImage, { paths }] = await Promise.all([
      tagsForImages(ctx.db, [img.id]),
      loadFolders(ctx.db),
    ])
    const described = describeImage(ctx, img, tagsByImage[img.id] ?? [], paths)
    return ok({
      ...described,
      tags: tagsByImage[img.id] ?? [],
      key: img.key,
      mimeType: img.mimeType,
      size: img.size,
      updatedAt: img.updatedAt.toISOString(),
      // What the Sanity Studio asset source stores on an image asset, so the
      // image can be ingested into Sanity attributed to Bildebank.
      sanity: {
        kind: 'url',
        url: described.url,
        source: { id: img.id, name: 'bildebank', url: described.url },
      },
    })
  })
}

export interface UploadInput {
  sourceUrl: string
  filename?: string
  altText?: string
  folderId?: string
  tagIds?: string[]
  force?: boolean
}

export async function uploadImage(
  ctx: ToolContext,
  input: UploadInput,
  fetchImpl?: typeof fetch
): Promise<ToolResult> {
  return guarded(async () => {
    requireWrite(ctx)
    const source = validateSourceUrl(input.sourceUrl)
    const filename = deriveFilename(input.filename, source)
    const tagIds = [...new Set(input.tagIds ?? [])]

    if (!input.force) {
      const [existing] = await findImagesByFilename(ctx.db, TENANT_ID, filename)
      if (existing) {
        return ok({
          id: existing.id,
          url: buildImageUrl(ctx.baseUrl, existing.key),
          webpUrl: maybeWebpUrl(ctx.baseUrl, existing.key, existing.mimeType) ?? null,
          filename: existing.filename,
          folderId: existing.folderId,
          existing: true,
          note: 'An image with this filename already exists, so nothing was uploaded. Pass force: true to upload anyway.',
        })
      }
    }

    if (input.folderId) await assertFolderExists(ctx.db, input.folderId)
    await assertTagsExist(ctx.db, tagIds)

    const remote = await fetchRemoteImage(source.toString(), { maxBytes: MAX_FILE_SIZE, fetchImpl })
    const image = await storeImage(ctx.env, ctx.db, {
      buffer: remote.buffer,
      mimeType: remote.mimeType,
      filename,
      altText: input.altText?.trim() || null,
      folderId: input.folderId ?? null,
      tenantId: TENANT_ID,
      tagIds,
    })
    logWrite(ctx, 'upload_image', { imageId: image.id, folderId: image.folderId, tagIds })

    return ok({
      id: image.id,
      url: buildImageUrl(ctx.baseUrl, image.key),
      webpUrl: maybeWebpUrl(ctx.baseUrl, image.key, image.mimeType) ?? null,
      filename: image.filename,
      folderId: image.folderId,
      existing: false,
    })
  })
}

// ── Tags ────────────────────────────────────────────────────────────────────

export const TAG_NAME_MAX = 100
export const SET_TAGS_MAX = 50

export async function listTags(ctx: ToolContext): Promise<ToolResult> {
  return guarded(async () => {
    const rows = await listTagsWithCounts(ctx.db, TENANT_ID)
    return ok({
      tags: rows.map((t) => ({ id: t.id, name: t.name, imageCount: t.imageCount })),
    })
  })
}

export async function createTag(ctx: ToolContext, input: { name: string }): Promise<ToolResult> {
  return guarded(async () => {
    requireWrite(ctx)
    const name = input.name.trim()
    if (!name) throw new ToolError('The tag name must not be empty.')
    if (name.length > TAG_NAME_MAX) {
      throw new ToolError(`The tag name must be at most ${TAG_NAME_MAX} characters.`)
    }

    const existing = await findExistingTag(ctx.db, TENANT_ID, name)
    if (existing) {
      return ok({
        id: existing.id,
        name: existing.name,
        existing: true,
        note: 'A tag with this name already exists, so it was returned instead of creating a duplicate.',
      })
    }
    const tag = await insertTag(ctx.db, { name, tenantId: TENANT_ID })
    logWrite(ctx, 'create_tag', { tagId: tag.id })
    return ok({ id: tag.id, name: tag.name, existing: false })
  })
}

export interface SetImageTagsInput {
  imageId: string
  addTagIds?: string[]
  removeTagIds?: string[]
}

export async function setImageTags(ctx: ToolContext, input: SetImageTagsInput): Promise<ToolResult> {
  return guarded(async () => {
    requireWrite(ctx)
    const add = [...new Set(input.addTagIds ?? [])]
    const remove = [...new Set(input.removeTagIds ?? [])]
    if (add.length === 0 && remove.length === 0) {
      throw new ToolError('Pass at least one tag id in addTagIds or removeTagIds.')
    }
    const both = add.filter((id) => remove.includes(id))
    if (both.length) {
      throw new ToolError(`Tag id(s) in both addTagIds and removeTagIds: ${both.join(', ')}`)
    }

    const img = await getImageById(ctx.db, input.imageId)
    if (!img || img.tenantId !== TENANT_ID) throw new ToolError(`Image ${input.imageId} not found.`)
    await assertTagsExist(ctx.db, [...add, ...remove])

    const removed = await removeTagsFromImage(ctx.db, img.id, remove)
    const added = await addTagsToImage(ctx.db, img.id, add)
    if (added.length || removed.length) logWrite(ctx, 'set_image_tags', { imageId: img.id, added, removed })
    const current = (await tagsForImages(ctx.db, [img.id]))[img.id] ?? []

    return ok({
      imageId: img.id,
      added,
      removed,
      unchanged: [...add, ...remove].filter((id) => !added.includes(id) && !removed.includes(id)),
      tags: current.map((t) => ({ id: t.id, name: t.name })),
    })
  })
}

// ── Image metadata ──────────────────────────────────────────────────────────

export const FILENAME_MAX = 200
export const ALT_TEXT_MAX = 1000

export interface UpdateImageInput {
  id: string
  altText?: string
  filename?: string
  folderId?: string
}

export async function updateImage(ctx: ToolContext, input: UpdateImageInput): Promise<ToolResult> {
  return guarded(async () => {
    requireWrite(ctx)
    if (input.altText === undefined && input.filename === undefined && input.folderId === undefined) {
      throw new ToolError('Pass at least one of altText, filename or folderId.')
    }
    const img = await getImageById(ctx.db, input.id)
    if (!img || img.tenantId !== TENANT_ID) throw new ToolError(`Image ${input.id} not found.`)

    const patch: ImageUpdate = {}
    if (input.altText !== undefined) {
      if (input.altText.length > ALT_TEXT_MAX) {
        throw new ToolError(`altText must be at most ${ALT_TEXT_MAX} characters.`)
      }
      // An empty string clears the alt text.
      patch.altText = input.altText.trim() || null
    }
    if (input.filename !== undefined) {
      if (!input.filename.trim()) throw new ToolError('filename must not be empty.')
      if (input.filename.length > FILENAME_MAX) {
        throw new ToolError(`filename must be at most ${FILENAME_MAX} characters.`)
      }
      patch.filename = cleanFilename(input.filename)
    }
    if (input.folderId !== undefined) {
      await assertFolderExists(ctx.db, input.folderId)
      patch.folderId = input.folderId
    }

    // Renaming onto a name another image already has is allowed, but upload_image
    // and the upload page de-duplicate by filename, so say so.
    let note: string | undefined
    if (patch.filename && patch.filename.toLowerCase() !== img.filename.toLowerCase()) {
      const clash = (await findImagesByFilename(ctx.db, TENANT_ID, patch.filename)).find(
        (other) => other.id !== img.id
      )
      if (clash) note = `Another image (${clash.id}) already has the filename "${clash.filename}".`
    }

    await updateImageRow(ctx.db, img.id, patch)
    logWrite(ctx, 'update_image', { imageId: img.id, fields: Object.keys(patch) })
    const result = await getImage(ctx, { id: img.id })
    if (note && result.structuredContent) return ok({ ...result.structuredContent, note })
    return result
  })
}

// ── Upload links (files on the user's own computer) ─────────────────────────

/** One structured log line per attributed write, findable with `wrangler tail`. */
function logWrite(ctx: ToolContext, tool: string, details: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      event: 'mcp.write',
      tool,
      tokenName: ctx.actor?.tokenName ?? null,
      tokenId: ctx.actor?.tokenId ?? null,
      ...details,
    })
  )
}

function requireKv(ctx: ToolContext): KVNamespace {
  if (!ctx.env.OAUTH_KV) throw new ToolError('Upload links are not configured on this worker (no OAUTH_KV).')
  return ctx.env.OAUTH_KV
}

export async function createUploadLink(
  ctx: ToolContext,
  input: { folderId?: string; tagIds?: string[] },
  now = new Date()
): Promise<ToolResult> {
  return guarded(async () => {
    requireWrite(ctx)
    const kv = requireKv(ctx)
    const tagIds = [...new Set(input.tagIds ?? [])]
    if (tagIds.length > SET_TAGS_MAX) throw new ToolError(`Pass at most ${SET_TAGS_MAX} tag ids.`)

    let folderPath: string | null = null
    if (input.folderId) {
      await assertFolderExists(ctx.db, input.folderId)
      folderPath = (await loadFolders(ctx.db)).paths.get(input.folderId) ?? null
    }
    await assertTagsExist(ctx.db, tagIds)
    const tagNames = tagIds.length
      ? (await listTagsWithCounts(ctx.db, TENANT_ID)).filter((t) => tagIds.includes(t.id)).map((t) => t.name)
      : []

    const { session, token } = await createUploadSession(
      kv,
      {
        folderId: input.folderId ?? null,
        folderPath,
        tagIds,
        tagNames,
        createdBy: ctx.actor ?? null,
      },
      now
    )
    logWrite(ctx, 'create_upload_link', { sessionId: session.id, folderId: session.folderId, tagIds })

    // The page and its upload endpoint share one URL: GET serves the page, POST takes a file.
    const url = uploadUrl(ctx.baseUrl, token)
    return ok({
      url,
      uploadEndpoint: url,
      fileField: UPLOAD_FILE_FIELD,
      forceField: UPLOAD_FORCE_FIELD,
      expiresAt: session.expiresAt,
      sessionId: session.id,
      maxFiles: session.maxFiles,
      note:
        'If you can read the files yourself, POST each one as multipart/form-data to ' +
        `uploadEndpoint (field "${UPLOAD_FILE_FIELD}", with the file's name and image Content-Type), ` +
        'one request at a time. Otherwise give the url to the user to open in their browser. ' +
        'Anyone with the link can upload until it expires. Afterwards call get_upload_session ' +
        'with the sessionId.',
    })
  })
}

export async function getUploadSessionTool(
  ctx: ToolContext,
  input: { sessionId: string },
  now = new Date()
): Promise<ToolResult> {
  return guarded(async () => {
    const kv = requireKv(ctx)
    const session = await loadUploadSession(kv, input.sessionId)
    if (!session) {
      throw new ToolError(
        `Upload session ${input.sessionId} not found. Sessions can be read for 24 hours after they are created.`
      )
    }
    const files = await listUploadedFiles(kv, session.id)
    const rows = await getImagesByIds(ctx.db, files.map((f) => f.imageId))
    const byId = new Map(rows.filter((r) => r.tenantId === TENANT_ID).map((r) => [r.id, r]))
    const describe = (kind: 'uploaded' | 'existing') =>
      files
        .filter((f) => f.kind === kind)
        .map((f) => byId.get(f.imageId))
        // An image deleted since the upload simply drops out.
        .filter((img): img is Image => img !== undefined)
        .map((img) => ({
          id: img.id,
          filename: img.filename,
          url: buildImageUrl(ctx.baseUrl, img.key),
          altText: img.altText,
        }))
    const uploadedCount = files.filter((f) => f.kind === 'uploaded').length

    return ok({
      sessionId: session.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      expired: isExpired(session, now),
      folderId: session.folderId,
      tagIds: session.tagIds,
      maxFiles: session.maxFiles,
      remaining: Math.max(session.maxFiles - uploadedCount, 0),
      images: describe('uploaded'),
      // Files the user picked whose filename was already in the library: nothing
      // was uploaded for them, and these are the images that already existed.
      alreadyInLibrary: describe('existing'),
    })
  })
}

// ── Server ──────────────────────────────────────────────────────────────────

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const

export function createBildebankMcpServer(
  env: Env,
  baseUrl: string,
  access: Access = 'read',
  actor?: Actor
): McpServer {
  const server = new McpServer({ name: 'bildebank', version: '0.1.0' })
  const ctx: ToolContext = { env, db: createDb(env.DATABASE_URL), baseUrl, access, actor }

  /** Tools that change data are registered inside this, so read tokens never see them. */
  const writeTools = (register: () => void) => {
    if (access === 'write') register()
  }

  server.registerTool(
    'list_folders',
    {
      title: 'List image folders',
      description:
        'List the folders of the Bildebank image library as a flat list with id, name, parentId, ' +
        'full path ("Parent / Child") and image counts (direct = images in the folder itself, ' +
        'recursive = including all subfolders). Omit parentId for the whole tree; pass a folder ' +
        'id to get only the folders beneath it. Use this to find a folderId for search_images ' +
        'or upload_image. Read-only.',
      inputSchema: z.object({
        parentId: uuid.optional().describe('Only list folders beneath this folder.'),
      }),
      annotations: READ_ONLY,
    },
    async ({ parentId }) => listFolders(ctx, { parentId })
  )

  server.registerTool(
    'search_images',
    {
      title: 'Search images',
      description:
        'Find images in the Bildebank library by filename or alt text, folder and tags. ' +
        'Returns TEXT ONLY — metadata (id, filename, altText, tags, folder path, size in pixels, ' +
        'url, createdAt), never the pictures themselves. To actually look at candidates, pass a ' +
        'handful of the returned ids to view_image. Results are newest first; when nextCursor is ' +
        'set, call again with it to get the next page. To filter by tag, get tag ids from ' +
        'list_tags. Read-only.',
      inputSchema: z.object({
        search: z
          .string()
          .optional()
          .describe('Text to match anywhere in the filename or alt text (case-insensitive).'),
        folderId: uuid.optional().describe('Restrict to this folder (see list_folders).'),
        recursive: z
          .boolean()
          .optional()
          .describe('With folderId: include images in subfolders too (default true).'),
        tagIds: z
          .array(uuid)
          .optional()
          .describe('Only images that have at least one of these tags (ids from list_tags).'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SEARCH_MAX_LIMIT)
          .optional()
          .describe(`Results per page (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT}).`),
        cursor: z.string().optional().describe('nextCursor from a previous call.'),
      }),
      annotations: READ_ONLY,
    },
    async (input) => searchImages(ctx, input)
  )

  server.registerTool(
    'view_image',
    {
      title: 'View images',
      description:
        'Look at images: returns each picture as an image (resized so the longest side is ' +
        'maxSize) followed by its id, filename and url. This is the only tool that shows the ' +
        `actual picture. Call it on a handful of candidates (at most ${VIEW_MAX_IMAGES} ids per ` +
        'call) picked with search_images — not on whole folders. SVG files cannot be shown. Read-only.',
      inputSchema: z.object({
        ids: z
          .array(uuid)
          .min(1)
          .max(VIEW_MAX_IMAGES)
          .describe(`1–${VIEW_MAX_IMAGES} image ids from search_images.`),
        maxSize: z
          .number()
          .int()
          .min(64)
          .max(VIEW_MAX_SIZE)
          .optional()
          .describe(
            `Longest side in pixels (default ${VIEW_DEFAULT_SIZE}, max ${VIEW_MAX_SIZE}). ` +
              'Raise it only when you need to read fine detail.'
          ),
      }),
      annotations: READ_ONLY,
    },
    async (input) => viewImages(ctx, input)
  )

  server.registerTool(
    'get_image',
    {
      title: 'Get image details',
      description:
        'Full metadata for one image: filename, alt text, tags, folder, dimensions, MIME type, ' +
        'file size, url and timestamps, plus a `sanity` object with the url and the asset ' +
        "source ({ id, name: 'bildebank', url }) to use when adding the image to a Sanity " +
        'document via the Bildebank asset source. Text only. Read-only.',
      inputSchema: z.object({ id: uuid.describe('Image id.') }),
      annotations: READ_ONLY,
    },
    async ({ id }) => getImage(ctx, { id })
  )

  server.registerTool(
    'list_tags',
    {
      title: 'List tags',
      description:
        'All tags in the Bildebank library: id, name and how many images carry each, sorted by ' +
        'name. Use the ids to filter search_images, to tag uploads in upload_image, or with ' +
        'set_image_tags. Read-only.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => listTags(ctx)
  )

  server.registerTool(
    'get_upload_session',
    {
      title: 'Get the images uploaded through an upload link',
      description:
        'After the user has used a link from create_upload_link, list what they uploaded: ' +
        'images (id, filename, url, altText) stored by that session, plus alreadyInLibrary — ' +
        'files whose filename already existed, so the existing image is listed and nothing was ' +
        'uploaded. Also says whether the link has expired and how many uploads remain. Use the ' +
        'ids with update_image (alt text, filename, folder) and set_image_tags. Sessions can be ' +
        'read for 24 hours. Read-only.',
      inputSchema: z.object({
        sessionId: uuid.describe('sessionId returned by create_upload_link.'),
      }),
      annotations: READ_ONLY,
    },
    async ({ sessionId }) => getUploadSessionTool(ctx, { sessionId })
  )

  // ── Write tools: write-access tokens only ──
  writeTools(() => {
    server.registerTool(
      'upload_image',
      {
        title: 'Upload an image from a URL',
        description:
          'Add an image to the Bildebank library from a public https URL: the worker downloads it ' +
          'and stores it like a normal upload. This cannot read files on the user\'s computer — ' +
          'for image files (attached in the chat, in your workspace or on the user\'s computer), ' +
          'use create_upload_link instead. ' +
          'JPEG, PNG, WebP and SVG up to 20 MB. If an image with ' +
          'the same filename already exists, that image is returned with existing: true and nothing ' +
          'is uploaded — pass force: true only when a second copy is really wanted. The filename ' +
          "defaults to the URL's last path segment. To tag it, pass tag ids from list_tags (create " +
          'missing tags with create_tag first). Returns id, url, webpUrl, filename, folderId, existing.',
        inputSchema: z.object({
          sourceUrl: z.string().url().describe('Public https URL of the image.'),
          filename: z.string().max(200).optional().describe('Filename to store (default: from the URL).'),
          altText: z.string().max(1000).optional().describe('Alt text describing the image.'),
          folderId: uuid.optional().describe('Folder to put it in (see list_folders).'),
          tagIds: z.array(uuid).optional().describe('Existing tag ids to attach (see list_tags).'),
          force: z
            .boolean()
            .optional()
            .describe('Upload even if an image with the same filename exists (default false).'),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (input) => uploadImage(ctx, input)
    )

    server.registerTool(
      'create_upload_link',
      {
        title: 'Upload image files (not URLs)',
        description:
          'Use this to upload image files rather than public URLs (upload_image only takes URLs, ' +
          "and this server cannot read anyone's files). Creates a short-lived upload session — " +
          `valid for ${UPLOAD_SESSION_MINUTES} minutes, up to ${UPLOAD_SESSION_MAX_FILES} files — ` +
          'and returns { url, uploadEndpoint, fileField, forceField, expiresAt, sessionId }.\n\n' +
          'If the files are in your own workspace (attached in the chat, or in a folder you can ' +
          'read), upload them yourself: POST each file to uploadEndpoint as multipart/form-data ' +
          `with the file in the "${UPLOAD_FILE_FIELD}" field (keep its filename and send its ` +
          `image Content-Type, e.g. curl -F "${UPLOAD_FILE_FIELD}=@photo.jpg;type=image/jpeg" ` +
          '<uploadEndpoint>), one request at a time, not in parallel. No other authentication is ' +
          'needed. Each response is JSON: 201 { status: "uploaded", image }; 200 { status: ' +
          '"existing", image } when an image with that filename already exists (nothing stored; ' +
          `resend with ${UPLOAD_FORCE_FIELD}=1 only if a second copy is really wanted); or 4xx ` +
          '{ status: "error", error }.\n\n' +
          "Only if you cannot reach the files (they are on the user's computer), give the url to " +
          'the user instead: it opens a drag-and-drop page in their browser. The link is the only ' +
          'credential, so share it only with them.\n\n' +
          'Every file goes to folderId and gets tagIds, with the same rules as upload_image ' +
          '(JPEG, PNG, WebP, SVG up to 20 MB). Afterwards call get_upload_session with the ' +
          'sessionId to get the new image ids.',
        inputSchema: z.object({
          folderId: uuid.optional().describe('Folder every upload goes into (see list_folders).'),
          tagIds: z
            .array(uuid)
            .max(SET_TAGS_MAX)
            .optional()
            .describe('Existing tag ids to attach to every upload (see list_tags).'),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (input) => createUploadLink(ctx, input)
    )

    server.registerTool(
      'update_image',
      {
        title: 'Update image metadata',
        description:
          'Change the alt text, filename and/or folder of one existing image. Only the fields ' +
          'given are changed; pass at least one. An empty altText clears it. Tags are changed with ' +
          'set_image_tags, not here. The file itself is never touched. Returns the same metadata ' +
          'as get_image (plus a note if another image already has the new filename).',
        inputSchema: z.object({
          id: uuid.describe('Image id (from search_images or get_upload_session).'),
          altText: z
            .string()
            .max(ALT_TEXT_MAX)
            .optional()
            .describe('New alt text describing the image. Empty string clears it.'),
          filename: z.string().min(1).max(FILENAME_MAX).optional().describe('New filename.'),
          folderId: uuid.optional().describe('Folder to move the image to (see list_folders).'),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) => updateImage(ctx, input)
    )

    server.registerTool(
      'create_tag',
      {
        title: 'Create a tag',
        description:
          'Create a tag by name. If a tag with the same name (ignoring case) already exists, ' +
          'that tag is returned with existing: true and nothing is created. Returns id, name, ' +
          'existing. Check list_tags first to reuse existing tags.',
        inputSchema: z.object({
          name: z.string().min(1).max(TAG_NAME_MAX).describe('Tag name, e.g. "Sommer".'),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ name }) => createTag(ctx, { name })
    )

    server.registerTool(
      'set_image_tags',
      {
        title: 'Add or remove tags on an image',
        description:
          'Add and/or remove tags on one existing image. Tags not named are left as they are. ' +
          'Tag ids come from list_tags (or create_tag). Adding a tag the image already has, or ' +
          'removing one it lacks, is a no-op reported under unchanged. Returns the ids added and ' +
          "removed and the image's tags afterwards.",
        inputSchema: z.object({
          imageId: uuid.describe('Image id (from search_images).'),
          addTagIds: z
            .array(uuid)
            .max(SET_TAGS_MAX)
            .optional()
            .describe('Tag ids to add to the image.'),
          removeTagIds: z
            .array(uuid)
            .max(SET_TAGS_MAX)
            .optional()
            .describe('Tag ids to remove from the image.'),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) => setImageTags(ctx, input)
    )
  })

  return server
}
