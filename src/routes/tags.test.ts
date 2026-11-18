/**
 * The /api tag routes, which now share src/services/tags.ts with the MCP tools.
 * createDb is swapped for an in-memory PGlite database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../db'
import { images, imageTags, tags } from '../db'
import { makeDb, makeEnv } from '../../test/helpers'

let db: Db
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  createDb: () => db,
}))
const { default: worker } = await import('../index')

const BASE = 'https://bildebank.test'
const ctxStub = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
const env = makeEnv()

const api = (method: string, path: string, body?: unknown) =>
  worker.fetch(
    new Request(`${BASE}/api${path}`, {
      method,
      headers: {
        Authorization: 'Bearer correct-key',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    env,
    ctxStub
  )

let imageId: string
let tagId: string
beforeEach(async () => {
  db = await makeDb()
  const [img] = await db
    .insert(images)
    .values({ key: 'default/2026/a.jpg', filename: 'a.jpg', size: 1, mimeType: 'image/jpeg' })
    .returning()
  const [tag] = await db.insert(tags).values({ name: 'Sommer', slug: 'sommer' }).returning()
  imageId = img!.id
  tagId = tag!.id
  await db.insert(imageTags).values({ imageId, tagId })
})

describe('/api/tags', () => {
  it('GET lists the tenant’s tags with image counts', async () => {
    await db.insert(tags).values({ name: 'Annen', slug: 'annen', tenantId: 'other' })
    const res = await api('GET', '/tags')
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: { id: string; name: string; imageCount: number }[] }
    expect(data.map((t) => [t.name, t.imageCount])).toEqual([['Sommer', 1]])
  })

  it('POST creates a tag and refuses a duplicate name (any case) with 409', async () => {
    const created = await api('POST', '/tags', { name: ' Vinter ', color: '#00f' })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ name: 'Vinter', slug: 'vinter', color: '#00f' })

    expect((await api('POST', '/tags', { name: 'vinter' })).status).toBe(409)
    expect((await api('POST', '/tags', { name: 'SOMMER' })).status).toBe(409)
    expect((await api('POST', '/tags', { name: '' })).status).toBe(400)
  })
})

describe('/api/images/:id/tags', () => {
  it('POST adds a tag (idempotently); DELETE removes it, then 404s', async () => {
    const [vinter] = await db.insert(tags).values({ name: 'Vinter', slug: 'vinter' }).returning()
    expect((await api('POST', `/images/${imageId}/tags`, { tagId: vinter!.id })).status).toBe(201)
    expect((await api('POST', `/images/${imageId}/tags`, { tagId: vinter!.id })).status).toBe(201)
    expect(await db.select().from(imageTags)).toHaveLength(2)

    expect((await api('DELETE', `/images/${imageId}/tags/${tagId}`)).status).toBe(200)
    expect((await api('DELETE', `/images/${imageId}/tags/${tagId}`)).status).toBe(404)
    expect(await db.select().from(imageTags)).toEqual([{ imageId, tagId: vinter!.id }])
  })
})
