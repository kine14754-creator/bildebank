import { beforeEach, describe, expect, it, vi } from 'vitest'
import { folders, imageTags, images, tags, type Db } from './db'
import worker from './index'
import {
  getImage,
  listFolders,
  searchImages,
  uploadImage,
  viewImages,
  type ToolContext,
  type ToolResult,
} from './mcp'
import { isAllowedRedirectUri, keysMatch } from './oauth'
import { isBlockedHost, validateSourceUrl } from './utils/remoteFetch'
import {
  fakeJpeg,
  makeDb,
  makeEnv,
  makeImagesBinding,
  makeR2,
  TINY_PNG,
} from '../test/helpers'

const BASE = 'https://bildebank.test'

// ── Fixtures ────────────────────────────────────────────────────────────────

interface Fixture {
  ctx: ToolContext
  db: Db
  r2: ReturnType<typeof makeR2>
  ids: {
    root: string
    child: string
    grandchild: string
    other: string
    tag: string
    rootImg: string
    childImg: string
    grandImg: string
    otherImg: string
    svgImg: string
  }
}

/**
 * Tree:  Natur (1 image) ─ Skog (1) ─ Gran (1)      Byer (1)     + 1 SVG with no folder
 */
async function setup(opts: { withImagesBinding?: boolean } = {}): Promise<Fixture> {
  const db = await makeDb()
  const r2 = makeR2()
  const imagesBinding = opts.withImagesBinding === false ? undefined : makeImagesBinding().binding
  const env = makeEnv({ R2_BUCKET: r2.bucket, IMAGES: imagesBinding })

  const [root] = await db.insert(folders).values({ name: 'Natur' }).returning()
  const [child] = await db.insert(folders).values({ name: 'Skog', parentId: root!.id }).returning()
  const [grandchild] = await db
    .insert(folders)
    .values({ name: 'Gran', parentId: child!.id })
    .returning()
  const [other] = await db.insert(folders).values({ name: 'Byer' }).returning()
  const [tag] = await db.insert(tags).values({ name: 'Sommer', slug: 'sommer' }).returning()

  const addImage = async (
    filename: string,
    folderId: string | null,
    bytes: Uint8Array,
    mimeType: string,
    altText: string | null = null,
    createdAt = new Date()
  ) => {
    const key = `default/2026/${crypto.randomUUID()}.${mimeType.split('/')[1]}`
    await r2.bucket.put(key, bytes.slice().buffer, { httpMetadata: { contentType: mimeType } })
    const [row] = await db
      .insert(images)
      .values({ key, filename, size: bytes.byteLength, mimeType, altText, folderId, createdAt })
      .returning()
    return row!.id
  }

  const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s))
  const rootImg = await addImage('fjell.png', root!.id, TINY_PNG, 'image/png', 'Fjelltopp i sol', t(1))
  const childImg = await addImage('skogsti.jpg', child!.id, fakeJpeg(400_000), 'image/jpeg', null, t(2))
  const grandImg = await addImage('granskog.jpg', grandchild!.id, fakeJpeg(2_000), 'image/jpeg', 'Mørk granskog', t(3))
  const otherImg = await addImage('oslo.jpg', other!.id, fakeJpeg(2_000), 'image/jpeg', null, t(4))
  const svgImg = await addImage(
    'logo.svg',
    null,
    new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    'image/svg+xml',
    null,
    t(5)
  )
  await db.insert(imageTags).values({ imageId: grandImg, tagId: tag!.id })

  return {
    ctx: { env, db, baseUrl: BASE, access: 'write' },
    db,
    r2,
    ids: {
      root: root!.id,
      child: child!.id,
      grandchild: grandchild!.id,
      other: other!.id,
      tag: tag!.id,
      rootImg,
      childImg,
      grandImg,
      otherImg,
      svgImg,
    },
  }
}

const data = <T>(res: ToolResult) => res.structuredContent as T

// ── list_folders ────────────────────────────────────────────────────────────

describe('list_folders', () => {
  it('returns the whole tree with paths and direct + recursive image counts', async () => {
    const { ctx, ids } = await setup()
    const res = await listFolders(ctx, {})
    expect(res.isError).toBeUndefined()
    const out = data<{
      totalImages: number
      imagesWithoutFolder: number
      folders: { id: string; name: string; parentId: string | null; path: string; imageCount: { direct: number; recursive: number } }[]
    }>(res)

    expect(out.totalImages).toBe(5)
    expect(out.imagesWithoutFolder).toBe(1)
    expect(out.folders.map((f) => f.path)).toEqual([
      'Byer',
      'Natur',
      'Natur / Skog',
      'Natur / Skog / Gran',
    ])
    const natur = out.folders.find((f) => f.id === ids.root)!
    expect(natur.parentId).toBeNull()
    expect(natur.imageCount).toEqual({ direct: 1, recursive: 3 })
    const skog = out.folders.find((f) => f.id === ids.child)!
    expect(skog.parentId).toBe(ids.root)
    expect(skog.imageCount).toEqual({ direct: 1, recursive: 2 })
  })

  it('limits the list to the subtree beneath parentId', async () => {
    const { ctx, ids } = await setup()
    const out = data<{ folders: { id: string }[] }>(await listFolders(ctx, { parentId: ids.root }))
    expect(out.folders.map((f) => f.id)).toEqual([ids.child, ids.grandchild])
  })

  it('reports an unknown parentId', async () => {
    const { ctx } = await setup()
    const res = await listFolders(ctx, { parentId: crypto.randomUUID() })
    expect(res.isError).toBe(true)
  })
})

// ── search_images ───────────────────────────────────────────────────────────

describe('search_images', () => {
  type Out = {
    images: { id: string; folderPath: string | null; tags: { name: string }[]; url: string }[]
    nextCursor: string | null
  }

  it('searches a folder recursively by default', async () => {
    const { ctx, ids } = await setup()
    const out = data<Out>(await searchImages(ctx, { folderId: ids.root }))
    // Newest first.
    expect(out.images.map((i) => i.id)).toEqual([ids.grandImg, ids.childImg, ids.rootImg])
    expect(out.images[0]!.folderPath).toBe('Natur / Skog / Gran')
    expect(out.images[0]!.tags.map((t) => t.name)).toEqual(['Sommer'])
    expect(out.images[0]!.url).toMatch(new RegExp(`^${BASE}/files/default/2026/`))
  })

  it('searches only the folder itself with recursive: false', async () => {
    const { ctx, ids } = await setup()
    const out = data<Out>(await searchImages(ctx, { folderId: ids.root, recursive: false }))
    expect(out.images.map((i) => i.id)).toEqual([ids.rootImg])
  })

  it('matches alt text as well as filename, case-insensitively', async () => {
    const { ctx, ids } = await setup()
    const byAlt = data<Out>(await searchImages(ctx, { search: 'FJELLTOPP' }))
    expect(byAlt.images.map((i) => i.id)).toEqual([ids.rootImg])
    const byName = data<Out>(await searchImages(ctx, { search: 'oslo' }))
    expect(byName.images.map((i) => i.id)).toEqual([ids.otherImg])
  })

  it('filters by tag and paginates with a cursor', async () => {
    const { ctx, ids } = await setup()
    const tagged = data<Out>(await searchImages(ctx, { tagIds: [ids.tag] }))
    expect(tagged.images.map((i) => i.id)).toEqual([ids.grandImg])

    const page1 = data<Out>(await searchImages(ctx, { limit: 2 }))
    expect(page1.images).toHaveLength(2)
    expect(page1.nextCursor).toBeTruthy()
    const page2 = data<Out>(await searchImages(ctx, { limit: 2, cursor: page1.nextCursor! }))
    const page3 = data<Out>(await searchImages(ctx, { limit: 2, cursor: page2.nextCursor! }))
    expect(page3.nextCursor).toBeNull()
    const all = [...page1.images, ...page2.images, ...page3.images].map((i) => i.id)
    expect(new Set(all).size).toBe(5)
  })

  it('rejects a garbage cursor', async () => {
    const { ctx } = await setup()
    const res = await searchImages(ctx, { cursor: 'nope' })
    expect(res.isError).toBe(true)
  })
})

// ── view_image ──────────────────────────────────────────────────────────────

describe('view_image', () => {
  it('returns an image content block followed by a text block per image', async () => {
    const { ctx, ids } = await setup()
    const res = await viewImages(ctx, { ids: [ids.childImg, ids.rootImg] })
    expect(res.isError).toBeUndefined()
    expect(res.content.map((c) => c.type)).toEqual(['image', 'text', 'image', 'text'])
    const [img, label] = res.content
    expect(img).toMatchObject({ type: 'image', mimeType: 'image/webp' })
    const bytes = atob((img as { data: string }).data).length
    expect(bytes).toBeLessThanOrEqual(150 * 1024)
    expect((label as { text: string }).text).toContain(`id: ${ids.childImg}`)
    expect((label as { text: string }).text).toContain('filename: skogsti.jpg')
    expect((label as { text: string }).text).toContain(`url: ${BASE}/files/`)
  })

  it('steps size/quality down until the preview fits the byte budget', async () => {
    const { ctx, ids } = await setup()
    const { binding, calls } = makeImagesBinding(1.2)
    ctx.env.IMAGES = binding
    const res = await viewImages(ctx, { ids: [ids.childImg], maxSize: 1024 })
    expect(res.content[0]!.type).toBe('image')
    expect(calls.length).toBeGreaterThan(1)
    expect(calls[0]).toEqual({ width: 1024, quality: 80 })
  })

  it('without the Images binding, serves a small original and explains a large one', async () => {
    const { ctx, ids } = await setup({ withImagesBinding: false })
    const res = await viewImages(ctx, { ids: [ids.rootImg, ids.childImg] })
    expect(res.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect((res.content[2] as { text: string }).text).toMatch(/No preview: image resizing is not configured/)
  })

  it('explains SVGs and unknown ids instead of failing the call', async () => {
    const { ctx, ids } = await setup()
    const missing = crypto.randomUUID()
    const res = await viewImages(ctx, { ids: [ids.svgImg, missing, ids.otherImg] })
    expect(res.content.map((c) => c.type)).toEqual(['text', 'text', 'image', 'text'])
    expect((res.content[0] as { text: string }).text).toMatch(/SVG/)
    expect((res.content[1] as { text: string }).text).toContain(`${missing}\nNot found.`)
  })
})

// ── get_image ───────────────────────────────────────────────────────────────

describe('get_image', () => {
  it('includes the Sanity asset-source fields', async () => {
    const { ctx, ids } = await setup()
    const out = data<{
      id: string
      folderPath: string
      sanity: { url: string; source: { id: string; name: string; url: string } }
    }>(await getImage(ctx, { id: ids.grandImg }))
    expect(out.folderPath).toBe('Natur / Skog / Gran')
    expect(out.sanity.source).toEqual({ id: ids.grandImg, name: 'bildebank', url: out.sanity.url })
  })
})

// ── upload_image ────────────────────────────────────────────────────────────

const imageResponse = (bytes: Uint8Array, type = 'image/jpeg', headers: Record<string, string> = {}) =>
  new Response(bytes, { headers: { 'Content-Type': type, ...headers } })

describe('upload_image', () => {
  it('stores a fetched image through the upload pipeline', async () => {
    const { ctx, ids, r2, db } = await setup()
    const fetchImpl = vi.fn(async () => imageResponse(fakeJpeg(5_000)))
    const res = await uploadImage(
      ctx,
      {
        sourceUrl: 'https://cdn.example.com/photos/Strand%20i%20sol.jpg',
        altText: 'Strand',
        folderId: ids.other,
        tagIds: [ids.tag],
      },
      fetchImpl as unknown as typeof fetch
    )
    expect(res.isError).toBeUndefined()
    const out = data<{ id: string; filename: string; folderId: string; existing: boolean; url: string }>(res)
    expect(out).toMatchObject({ filename: 'Strand i sol.jpg', folderId: ids.other, existing: false })
    const key = out.url.replace(`${BASE}/files/`, '')
    expect(r2.store.get(key)?.contentType).toBe('image/jpeg')
    const tagRows = await db.select().from(imageTags)
    expect(tagRows).toContainEqual({ imageId: out.id, tagId: ids.tag })
  })

  it('returns the existing image for a duplicate filename without fetching', async () => {
    const { ctx, ids } = await setup()
    const fetchImpl = vi.fn(async () => imageResponse(fakeJpeg(5_000)))
    const res = await uploadImage(
      ctx,
      { sourceUrl: 'https://cdn.example.com/x/OSLO.JPG' },
      fetchImpl as unknown as typeof fetch
    )
    expect(data(res)).toMatchObject({ id: ids.otherImg, existing: true })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('uploads a duplicate anyway with force: true', async () => {
    const { ctx, ids } = await setup()
    const fetchImpl = vi.fn(async () => imageResponse(fakeJpeg(5_000)))
    const res = await uploadImage(
      ctx,
      { sourceUrl: 'https://cdn.example.com/x/oslo.jpg', force: true },
      fetchImpl as unknown as typeof fetch
    )
    const out = data<{ id: string; existing: boolean }>(res)
    expect(out.existing).toBe(false)
    expect(out.id).not.toBe(ids.otherImg)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each([
    ['http://example.com/a.jpg', /Only https/],
    ['https://localhost/a.jpg', /public internet/],
    ['https://127.0.0.1/a.jpg', /public internet/],
    ['https://10.1.2.3/a.jpg', /public internet/],
    ['https://169.254.169.254/latest/meta-data', /public internet/],
    ['https://192.168.0.10/a.jpg', /public internet/],
    ['https://[::1]/a.jpg', /public internet/],
    ['https://2130706433/a.jpg', /public internet/], // 127.0.0.1 in decimal
    ['https://intranet/a.jpg', /public internet/],
    ['https://nas.local/a.jpg', /public internet/],
    ['https://user:pw@example.com/a.jpg', /credentials/],
    ['https://example.com:8443/a.jpg', /port/],
    ['ftp://example.com/a.jpg', /Only https/],
  ])('rejects %s before fetching', async (sourceUrl, message) => {
    const { ctx } = await setup()
    const fetchImpl = vi.fn()
    const res = await uploadImage(ctx, { sourceUrl }, fetchImpl as unknown as typeof fetch)
    expect(res.isError).toBe(true)
    expect(res.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(message) })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('re-checks every redirect hop', async () => {
    const { ctx } = await setup()
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { Location: 'https://10.0.0.5/secret.jpg' } })
    )
    const res = await uploadImage(
      ctx,
      { sourceUrl: 'https://cdn.example.com/redirect.jpg' },
      fetchImpl as unknown as typeof fetch
    )
    expect(res.isError).toBe(true)
    expect(res.content[0]).toMatchObject({ text: expect.stringMatching(/10\.0\.0\.5/) })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('rejects non-image content, oversized files and mislabelled bodies', async () => {
    const { ctx } = await setup()
    const run = (response: Response, name: string) =>
      uploadImage(ctx, { sourceUrl: `https://cdn.example.com/${name}` }, (async () =>
        response) as unknown as typeof fetch)

    const html = await run(new Response('<html>', { headers: { 'Content-Type': 'text/html' } }), 'a.jpg')
    expect(html.content[0]).toMatchObject({ text: expect.stringMatching(/Unsupported content type "text\/html"/) })

    const big = await run(imageResponse(fakeJpeg(10), 'image/jpeg', { 'Content-Length': String(21 * 1024 * 1024) }), 'b.jpg')
    expect(big.content[0]).toMatchObject({ text: expect.stringMatching(/larger than 20 MB/) })

    const streamedBig = await run(imageResponse(fakeJpeg(20 * 1024 * 1024 + 1)), 'c.jpg')
    expect(streamedBig.content[0]).toMatchObject({ text: expect.stringMatching(/larger than 20 MB/) })

    const fake = await run(imageResponse(new TextEncoder().encode('<html>not a jpeg')), 'd.jpg')
    expect(fake.content[0]).toMatchObject({ text: expect.stringMatching(/not a valid image\/jpeg/) })
  })

  it('refuses a read-only token before doing anything', async () => {
    const { ctx, db } = await setup()
    const fetchImpl = vi.fn()
    const before = (await db.select().from(images)).length
    const res = await uploadImage(
      { ...ctx, access: 'read' },
      { sourceUrl: 'https://cdn.example.com/new.jpg' },
      fetchImpl as unknown as typeof fetch
    )
    expect(res.isError).toBe(true)
    expect(res.content[0]).toMatchObject({ text: expect.stringMatching(/read-only/) })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect((await db.select().from(images)).length).toBe(before)
  })

  it('refuses an unknown folder or tag before fetching', async () => {
    const { ctx } = await setup()
    const fetchImpl = vi.fn()
    const res = await uploadImage(
      ctx,
      { sourceUrl: 'https://cdn.example.com/new.jpg', folderId: crypto.randomUUID() },
      fetchImpl as unknown as typeof fetch
    )
    expect(res.isError).toBe(true)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('host checks', () => {
  it.each([
    ['example.com', false],
    ['images.unsplash.com', false],
    ['8.8.8.8', false],
    ['172.15.0.1', false],
    ['172.16.0.1', true],
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['224.0.0.1', true],
    ['printer.lan', true],
    ['metadata.google.internal', true],
    ['foo.localhost', true],
  ])('%s blocked=%s', (host, blocked) => expect(isBlockedHost(host)).toBe(blocked))

  it('normalises hex IPv4 hosts before checking', () => {
    expect(() => validateSourceUrl('https://0x7f.1/a.jpg')).toThrow(/public internet/)
  })
})

// ── HTTP / OAuth ────────────────────────────────────────────────────────────

const ctxStub = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext

describe('/mcp auth', () => {
  let env: ReturnType<typeof makeEnv>
  beforeEach(() => {
    env = makeEnv()
  })

  it('answers an unauthenticated request with 401 and a resource_metadata pointer', async () => {
    const res = await worker.fetch(new Request(`${BASE}/mcp`, { method: 'POST', body: '{}' }), env, ctxStub)
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toContain(
      `resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`
    )
    const meta = await worker.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource/mcp`), env, ctxStub)
    const body = (await meta.json()) as { resource: string; authorization_servers: string[] }
    expect(body.resource).toBe(`${BASE}/mcp`)
    expect(body.authorization_servers).toEqual([BASE])
  })

  it('rejects the raw API secret as a bearer token', async () => {
    const res = await worker.fetch(
      new Request(`${BASE}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer correct-key' }, body: '{}' }),
      env,
      ctxStub
    )
    expect(res.status).toBe(401)
  })

  it('leaves the API routes on the API secret', async () => {
    const res = await worker.fetch(new Request(`${BASE}/api/folders`), env, ctxStub)
    expect(res.status).toBe(401)
    const health = await worker.fetch(new Request(`${BASE}/health`), env, ctxStub)
    expect(health.status).toBe(200)
  })

  it('accepts only Claude callbacks as redirect URIs, and compares keys exactly', async () => {
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(isAllowedRedirectUri('https://evil.example/callback')).toBe(false)
    expect(await keysMatch('correct-key', 'correct-key')).toBe(true)
    expect(await keysMatch('correct-ke', 'correct-key')).toBe(false)
  })
})
