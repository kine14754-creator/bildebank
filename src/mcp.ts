/**
 * MCP tools for Bildebank: list_folders, search_images, view_image, get_image,
 * upload_image.
 *
 * Same layout as the Broadcast MCP (nimlas-sites/packages/broadcast-worker/src/mcp.ts):
 * every tool calls the worker's own service layer directly (src/services/*) —
 * no HTTP round trip to /api — and is served at /mcp behind OAuth (see oauth.ts).
 * There are deliberately no delete, move or rename tools.
 */
import { McpServer } from '@modelcontextprotocol/server'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { createDb, folders, tags, type Db, type Image } from './db'
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
  type ImageTag,
} from './services/images'
import { makePreview } from './utils/preview'
import {
  deriveFilename,
  fetchRemoteImage,
  RemoteFetchError,
  validateSourceUrl,
} from './utils/remoteFetch'
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
  const rows = await db
    .select({ id: tags.id })
    .from(tags)
    .where(and(inArray(tags.id, tagIds), eq(tags.tenantId, TENANT_ID)))
  const found = new Set(rows.map((r) => r.id))
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

// ── Server ──────────────────────────────────────────────────────────────────

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const

export function createBildebankMcpServer(env: Env, baseUrl: string): McpServer {
  const server = new McpServer({ name: 'bildebank', version: '0.1.0' })
  const ctx: ToolContext = { env, db: createDb(env.DATABASE_URL), baseUrl }

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
        'set, call again with it to get the next page. Read-only.',
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
        tagIds: z.array(uuid).optional().describe('Only images that have at least one of these tags.'),
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
    'upload_image',
    {
      title: 'Upload an image from a URL',
      description:
        'Add an image to the Bildebank library from a public https URL: the worker downloads it ' +
        'and stores it like a normal upload. JPEG, PNG, WebP and SVG up to 20 MB. If an image with ' +
        'the same filename already exists, that image is returned with existing: true and nothing ' +
        'is uploaded — pass force: true only when a second copy is really wanted. The filename ' +
        "defaults to the URL's last path segment. Returns id, url, webpUrl, filename, folderId, existing.",
      inputSchema: z.object({
        sourceUrl: z.string().url().describe('Public https URL of the image.'),
        filename: z.string().max(200).optional().describe('Filename to store (default: from the URL).'),
        altText: z.string().max(1000).optional().describe('Alt text describing the image.'),
        folderId: uuid.optional().describe('Folder to put it in (see list_folders).'),
        tagIds: z.array(uuid).optional().describe('Existing tag ids to attach.'),
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

  return server
}
