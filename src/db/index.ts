import { drizzle } from 'drizzle-orm/neon-http'
import { neon, neonConfig } from '@neondatabase/serverless'
import * as schema from './schema'

export function createDb(databaseUrl: string) {
  // Local development only: a localhost DATABASE_URL is served over plain HTTP by
  // scripts/local-neon.mjs instead of Neon's https://api.<host>/sql endpoint.
  const { hostname, port } = new URL(databaseUrl)
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    neonConfig.fetchEndpoint = `http://${hostname}:${port || 4444}/sql`
  }
  const sql = neon(databaseUrl)
  return drizzle(sql, { schema })
}

export type Db = ReturnType<typeof createDb>
export * from './schema'
