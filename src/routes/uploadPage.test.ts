/**
 * The upload page behind create_upload_link, end to end: a session made with the
 * MCP tool, files posted to the page, and get_upload_session reading them back.
 * createDb is swapped for an in-memory PGlite database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../db'
import { folders, images, imageTags, tags } from '../db'
import { createUploadLink, getUploadSessionTool, type ToolContext } from '../mcp'
import { fakeJpeg, jpegWithSize, makeDb, makeEnv, makeR2, TINY_PNG } from '../../test/helpers'

let db: Db
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  createDb: () => db,
}))
const { default: worker } = await import('../index')

const BASE = 'https://bildebank.test'
const ctxStub = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext

let ctx: ToolContext
let r2: ReturnType<typeof makeR2>
let folderId: string
let tagId: string

beforeEach(async () => {
  db = await makeDb()
  r2 = makeR2()
  const env = makeEnv({ R2_BUCKET: r2.bucket })
  ctx = {
    env,
    db,
    baseUrl: BASE,
    access: 'write',
    actor: { tokenName: 'Kari', tokenId: 'tok-1' },
  }
  folderId = (await db.insert(folders).values({ name: 'Kampanje' }).returning())[0]!.id
  tagId = (await db.insert(tags).values({ name: 'Sommer', slug: 'sommer' }).returning())[0]!.id
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

async function newLink(now?: Date) {
  const res = await createUploadLink(ctx, { folderId, tagIds: [tagId] }, now)
  const out = res.structuredContent as { url: string; sessionId: string }
  return { ...out, path: new URL(out.url).pathname }
}

const getPage = (path: string) => worker.fetch(new Request(`${BASE}${path}`), ctx.env, ctxStub)

function post(path: string, file: File | null, extra: Record<string, string> = {}) {
  const form = new FormData()
  if (file) form.append('file', file)
  for (const [k, v] of Object.entries(extra)) form.append(k, v)
  return worker.fetch(
    new Request(`${BASE}${path}`, { method: 'POST', body: form }),
    ctx.env,
    ctxStub,
  )
}

const jpeg = (name: string, bytes = 2_000) =>
  new File([fakeJpeg(bytes)], name, { type: 'image/jpeg' })

describe('GET /upload/:token', () => {
  it('serves the upload page with the folder, tags and locked-down headers', async () => {
    const { path } = await newLink()
    const res = await getPage(path)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Upload images to Bildebank')
    expect(html).toContain('Kampanje')
    expect(html).toContain('Sommer')
    expect(html).toMatch(/type="file"[^>]*multiple/)
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const csp = res.headers.get('Content-Security-Policy')!
    const nonce = /script-src 'nonce-([a-f0-9]+)'/.exec(csp)![1]
    expect(html).toContain(`<script nonce="${nonce}">`)
    // The inline page script at least parses.
    const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)![1]!
    expect(() => new Function(script)).not.toThrow()
  })

  it('refuses unknown and expired links', async () => {
    expect((await getPage('/upload/bb_up_nope')).status).toBe(404)
    expect((await getPage('/upload/whatever')).status).toBe(404)
    const { path } = await newLink(new Date(Date.now() - 31 * 60 * 1000))
    const res = await getPage(path)
    expect(res.status).toBe(410)
    expect(await res.text()).toContain('expired')
  })
})

describe('POST /upload/:token', () => {
  it('stores the file with the session folder and tags, and get_upload_session lists it', async () => {
    const { path, sessionId } = await newLink()
    const res = await post(path, jpeg('Strand.jpg'))
    expect(res.status).toBe(201)
    const out = (await res.json()) as {
      status: string
      image: { id: string; filename: string; url: string }
    }
    expect(out).toMatchObject({
      status: 'uploaded',
      image: { filename: 'Strand.jpg' },
    })
    expect(out.image.url).toMatch(new RegExp(`^${BASE}/files/default/`))

    const [row] = await db.select().from(images)
    expect(row).toMatchObject({
      id: out.image.id,
      folderId,
      mimeType: 'image/jpeg',
      size: 2_000,
    })
    expect(await db.select().from(imageTags)).toEqual([{ imageId: out.image.id, tagId }])
    expect(r2.store.get(row!.key)?.contentType).toBe('image/jpeg')

    const session = (await getUploadSessionTool(ctx, { sessionId })).structuredContent as {
      images: { id: string; filename: string; url: string; altText: null }[]
      remaining: number
    }
    expect(session.images).toEqual([
      {
        id: out.image.id,
        filename: 'Strand.jpg',
        url: out.image.url,
        altText: null,
      },
    ])
    expect(session.remaining).toBe(49)

    // Attributed to the token that made the link.
    const logged = vi.mocked(console.log).mock.calls.map((c) => JSON.parse(c[0] as string))
    expect(logged).toContainEqual(
      expect.objectContaining({
        event: 'upload_link.upload',
        sessionId,
        imageId: out.image.id,
        tokenName: 'Kari',
      }),
    )
  })

  it('skips a duplicate filename (ignoring case) unless force=1', async () => {
    const { path, sessionId } = await newLink()
    const [older] = await db
      .insert(images)
      .values({
        key: 'default/2026/old.jpg',
        filename: 'Gammel.jpg',
        size: 1,
        mimeType: 'image/jpeg',
      })
      .returning()
    const old = await post(path, jpeg('gammel.jpg'))
    expect(await old.json()).toMatchObject({
      status: 'existing',
      image: { id: older!.id },
    })

    const first = (await (await post(path, jpeg('strand.jpg'))).json()) as {
      image: { id: string }
    }

    const dup = await post(path, jpeg('STRAND.JPG'))
    expect(dup.status).toBe(200)
    expect(await dup.json()).toMatchObject({
      status: 'existing',
      image: { id: first.image.id },
    })
    expect(await db.select().from(images)).toHaveLength(2)

    const forced = await post(path, jpeg('STRAND.JPG'), { force: '1' })
    expect(forced.status).toBe(201)
    expect(await db.select().from(images)).toHaveLength(3)

    const session = (await getUploadSessionTool(ctx, { sessionId })).structuredContent as {
      images: unknown[]
      alreadyInLibrary: { id: string }[]
    }
    // Re-picking a file this session uploaded keeps it under images; only the
    // image that was in the library before the session is under alreadyInLibrary.
    expect(session.images).toHaveLength(2)
    expect(session.alreadyInLibrary.map((i) => i.id)).toEqual([older!.id])
  })

  it('rejects wrong types, oversized, empty and mislabelled files', async () => {
    const { path } = await newLink()
    const cases: [File | null, number, RegExp][] = [
      [null, 400, /Missing "file"/],
      [new File(['%PDF'], 'a.pdf', { type: 'application/pdf' }), 415, /Unsupported file type/],
      [jpeg('big.jpg', 20 * 1024 * 1024 + 1), 413, /too large/],
      [new File([], 'empty.png', { type: 'image/png' }), 400, /empty/],
      [new File(['<html>'], 'fake.jpg', { type: 'image/jpeg' }), 415, /not a valid image\/jpeg/],
      [
        new File([TINY_PNG], 'png-as-webp.webp', { type: 'image/webp' }),
        415,
        /not a valid image\/webp/,
      ],
    ]
    for (const [file, status, message] of cases) {
      const res = await post(path, file)
      expect(res.status).toBe(status)
      expect(await res.json()).toMatchObject({
        status: 'error',
        error: expect.stringMatching(message),
      })
    }
    expect(await db.select().from(images)).toHaveLength(0)
  })

  it('refuses uploads after the link expires, with an unknown token, or past the file limit', async () => {
    const expired = await newLink(new Date(Date.now() - 31 * 60 * 1000))
    expect((await post(expired.path, jpeg('a.jpg'))).status).toBe(410)
    expect((await post('/upload/bb_up_nope', jpeg('a.jpg'))).status).toBe(404)

    const { path } = await newLink()
    for (let i = 0; i < 50; i++) expect((await post(path, jpeg(`f${i}.jpg`, 100))).status).toBe(201)
    const over = await post(path, jpeg('f50.jpg', 100))
    expect(over.status).toBe(409)
    expect(await over.json()).toMatchObject({
      error: expect.stringMatching(/at most 50/),
    })
    expect(await db.select().from(images)).toHaveLength(50)
  })

  it('accepts files posted directly the way the tool result describes (no browser)', async () => {
    const res = await createUploadLink(ctx, {})
    const link = res.structuredContent as {
      uploadEndpoint: string
      fileField: string
      forceField: string
      sessionId: string
    }
    // Only what the result gives: endpoint, field names. No cookies, no page visit.
    const send = (file: File, force = false) => {
      const form = new FormData()
      form.append(link.fileField, file)
      if (force) form.append(link.forceField, '1')
      return worker.fetch(
        new Request(link.uploadEndpoint, { method: 'POST', body: form }),
        ctx.env,
        ctxStub,
      )
    }
    expect((await send(jpeg('a.jpg'))).status).toBe(201)
    expect((await send(new File([TINY_PNG], 'b.png', { type: 'image/png' }))).status).toBe(201)
    expect((await send(jpeg('a.jpg'))).status).toBe(200)
    expect((await send(jpeg('a.jpg'), true)).status).toBe(201)

    const session = (await getUploadSessionTool(ctx, { sessionId: link.sessionId }))
      .structuredContent as { images: { filename: string }[] }
    expect(session.images.map((i) => i.filename)).toEqual(['a.jpg', 'b.png', 'a.jpg'])
  })

  it('needs no API secret, and the token gives no access to /api', async () => {
    const { path } = await newLink()
    const token = path.split('/').pop()!
    const api = await worker.fetch(
      new Request(`${BASE}/api/images`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      ctx.env,
      ctxStub,
    )
    expect(api.status).toBe(401)
  })
})

// ── Regressions from the first production test ─────────────────────────────

describe('production regressions', () => {
  it('shows an upload in get_upload_session at once, from another Cloudflare location', async () => {
    // In production the MCP call and the upload POST reach different Cloudflare
    // locations. Each location has its own cached view of KV; only the database
    // is shared and consistent. Model that: three envs with separate KV stores,
    // one database. With sessions in KV this read back images: [], remaining: 50.
    const mcpLocation = ctx
    const uploadLocation = makeEnv({ R2_BUCKET: r2.bucket })
    const readLocation: ToolContext = { ...ctx, env: makeEnv({ R2_BUCKET: r2.bucket }) }

    const link = (await createUploadLink(mcpLocation, {})).structuredContent as {
      uploadEndpoint: string
      sessionId: string
    }
    const form = new FormData()
    form.append('file', new File([jpegWithSize(732, 1080)], 'SGp1.jpg', { type: 'image/jpeg' }))
    const res = await worker.fetch(
      new Request(link.uploadEndpoint, { method: 'POST', body: form }),
      uploadLocation,
      ctxStub
    )
    expect(res.status).toBe(201)
    const { image } = (await res.json()) as { image: { id: string } }

    const session = (await getUploadSessionTool(readLocation, { sessionId: link.sessionId }))
      .structuredContent as { images: { id: string; filename: string }[]; remaining: number }
    expect(session.images).toEqual([expect.objectContaining({ id: image.id, filename: 'SGp1.jpg' })])
    expect(session.remaining).toBe(49)
  })

  it('stores the same metadata as /api/images/upload for the same file, including its size', async () => {
    const bytes = jpegWithSize(732, 1080)
    const viaApi = async () => {
      const form = new FormData()
      form.append('file', new File([bytes], 'api.jpg', { type: 'image/jpeg' }))
      const res = await worker.fetch(
        new Request(`${BASE}/api/images/upload`, {
          method: 'POST',
          headers: { Authorization: 'Bearer correct-key' },
          body: form,
        }),
        ctx.env,
        ctxStub
      )
      expect(res.status).toBe(201)
      return ((await res.json()) as { id: string }).id
    }
    const viaLink = async () => {
      const { path } = await newLink()
      const res = await post(path, new File([bytes], 'link.jpg', { type: 'image/jpeg' }))
      expect(res.status).toBe(201)
      return ((await res.json()) as { image: { id: string } }).image.id
    }

    const [apiId, linkId] = [await viaApi(), await viaLink()]
    const rows = await db.select().from(images)
    const pick = (id: string) => {
      const r = rows.find((row) => row.id === id)!
      return { width: r.width, height: r.height, mimeType: r.mimeType, size: r.size }
    }
    expect(pick(apiId)).toEqual({ width: 732, height: 1080, mimeType: 'image/jpeg', size: bytes.byteLength })
    expect(pick(linkId)).toEqual(pick(apiId))

    // webpUrl comes from the same place on both paths (WebP conversion is switched
    // off for now, see utils/imageOptimize.ts), so it matches too.
    const { getImage } = await import('../mcp')
    const webp = async (id: string) =>
      ((await getImage(ctx, { id })).structuredContent as { webpUrl: string | null }).webpUrl
    expect(await webp(linkId)).toBe(await webp(apiId))
  })
})
