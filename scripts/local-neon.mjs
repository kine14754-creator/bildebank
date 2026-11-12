#!/usr/bin/env node
/**
 * Local stand-in for Neon's HTTP SQL endpoint, so `wrangler dev` can run without
 * a Neon database or Docker.
 *
 * Runs Postgres in-process with PGlite, applies the drizzle migrations, and
 * answers the requests @neondatabase/serverless makes (POST /sql with
 * {query, params} or {queries: [...]}, rows returned as raw text). Point the
 * worker at it with DATABASE_URL=postgresql://postgres:postgres@localhost:4444/bildebank
 * in .dev.vars — createDb() routes localhost URLs here.
 *
 *   node scripts/local-neon.mjs            # data kept in .wrangler/local-neon
 *   node scripts/local-neon.mjs --memory   # fresh database every start
 */
import { createServer } from 'node:http'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const PORT = Number(process.env.PORT ?? 4444)
const root = new URL('../', import.meta.url)
const inMemory = process.argv.includes('--memory')

let db
if (inMemory) {
  db = new PGlite()
} else {
  const dir = new URL('.wrangler/local-neon/', root)
  mkdirSync(dir, { recursive: true })
  db = new PGlite(dir.pathname)
}

// Migrations are idempotent enough to re-run (CREATE TABLE IF NOT EXISTS, guarded
// constraints); the ALTER TABLE ADD COLUMN in 0001 is skipped once applied.
const migrations = new URL('drizzle/', root)
for (const file of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(new URL(file, migrations), 'utf8')
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (!statement.trim()) continue
    try {
      await db.exec(statement)
    } catch (err) {
      if (!/already exists/.test(err.message)) throw err
    }
  }
}

// Return every value as Postgres text, as Neon does with Neon-Raw-Text-Output;
// the driver parses it with its own type parsers.
const raw = new Proxy({}, { get: () => (value) => value })

async function run({ query, params = [] }) {
  const result = await db.query(query, params, { rowMode: 'array', parsers: raw })
  return {
    command: query.trim().split(/\s+/)[0].toUpperCase(),
    rowCount: result.affectedRows ?? result.rows.length,
    fields: result.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
    rows: result.rows.map((row) => row.map((v) => (v === null ? null : String(v)))),
    rowAsArray: true,
  }
}

createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let payload
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (Array.isArray(body.queries)) {
      // Batches run in order; no isolation (dev only).
      const results = []
      for (const q of body.queries) results.push(await run(q))
      payload = { results }
    } else {
      payload = await run(body)
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ message: err.message, code: err.code }))
  }
}).listen(PORT, () => {
  console.log(`local-neon: http://localhost:${PORT}/sql (${inMemory ? 'in-memory' : '.wrangler/local-neon'})`)
})
