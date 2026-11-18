/**
 * Test doubles for the worker: an in-memory Postgres (PGlite, with the real
 * drizzle migrations applied), R2, KV and the Cloudflare Images binding.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import * as schema from '../src/db/schema'
import type { Db } from '../src/db'
import type { Env } from '../src/types'

const MIGRATIONS_DIR = new URL('../drizzle/', import.meta.url)

export async function makeDb(): Promise<Db> {
  const client = new PGlite()
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const file of files) {
    const sql = readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8')
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) await client.exec(statement)
    }
  }
  // Same query builder API as the neon-http driver the worker uses.
  return drizzle(client, { schema }) as unknown as Db
}

export function makeR2() {
  const store = new Map<string, { bytes: Uint8Array; contentType?: string }>()
  const bucket = {
    async put(key: string, body: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) {
      store.set(key, { bytes: new Uint8Array(body.slice(0)), contentType: opts?.httpMetadata?.contentType })
    },
    async get(key: string) {
      const entry = store.get(key)
      if (!entry) return null
      return {
        body: new Response(entry.bytes).body,
        arrayBuffer: async () => entry.bytes.slice().buffer,
        writeHttpMetadata(headers: Headers) {
          if (entry.contentType) headers.set('Content-Type', entry.contentType)
        },
      }
    },
    async delete(key: string) {
      store.delete(key)
    },
  }
  return { bucket: bucket as unknown as R2Bucket, store }
}

export function makeKv(): KVNamespace {
  const store = new Map<string, string>()
  const kv = {
    async get(key: string, opts?: unknown) {
      const v = store.get(key)
      if (v === undefined) return null
      const type = typeof opts === 'string' ? opts : (opts as { type?: string })?.type
      return type === 'json' ? JSON.parse(v) : v
    },
    async put(key: string, value: string) {
      store.set(key, value)
    },
    async delete(key: string) {
      store.delete(key)
    },
    async list({ prefix = '' }: { prefix?: string } = {}) {
      return {
        keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      }
    },
  }
  return kv as unknown as KVNamespace
}

/**
 * Fake Images binding: "encodes" to a WebP-tagged buffer whose size scales with
 * width × quality, so the byte-budget loop in preview.ts can be exercised.
 */
export function makeImagesBinding(bytesPerPixelAtQ100 = 1) {
  const calls: { width?: number; quality?: number }[] = []
  const binding = {
    input(_stream: ReadableStream) {
      let width = 0
      const transformer = {
        transform(t: { width?: number }) {
          width = t.width ?? width
          return transformer
        },
        async output(o: { format: string; quality?: number }) {
          const quality = o.quality ?? 100
          calls.push({ width, quality })
          const size = Math.round(width * width * bytesPerPixelAtQ100 * (quality / 100) * 0.5)
          const bytes = new Uint8Array(Math.max(size, 16))
          bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
          return {
            image: () => new Response(bytes).body,
            contentType: () => o.format,
            response: () => new Response(bytes),
          }
        },
      }
      return transformer
    },
  }
  return { binding: binding as unknown as ImagesBinding, calls }
}

export function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    R2_BUCKET: makeR2().bucket,
    // Parsed but never connected to: tool tests pass a PGlite db directly.
    DATABASE_URL: 'postgresql://user:pass@db.test/bildebank',
    API_SECRET: 'correct-key',
    ADMIN_SECRET: 'admin-key',
    ENVIRONMENT: 'test',
    OAUTH_KV: makeKv(),
    ...extra,
  }
}

/** 1×1 transparent PNG. */
export const TINY_PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  ),
  (c) => c.charCodeAt(0)
)

/** A "JPEG" of the given size: valid magic bytes, zero padding. */
export function fakeJpeg(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes)
  out.set([0xff, 0xd8, 0xff, 0xe0])
  return out
}
