/**
 * Personal access tokens for the /mcp sign-in.
 *
 * One record per person in OAUTH_KV. The raw token is shown once, at creation,
 * and only its SHA-256 hash is stored. Keys (the OAuth library owns every other
 * prefix in the namespace, so these stay under `pat:`):
 *
 *   pat:name:<lowercased name>  → TokenRecord (JSON)
 *   pat:hash:<sha-256 hex>      → lowercased name (lookup index for sign-in)
 *
 * Names are unique case-insensitively; the record keeps the name as typed.
 * Each record also carries a random id. Grants are issued to `pat-<id>`, so a
 * token that is revoked and then re-created under the same name never revives
 * a grant made with the old one.
 *
 * Access level: "read" (default) or "write". It is copied into the grant props
 * at sign-in, but /mcp reads the live value from the record on every request
 * (resolveTokenGrant), so changing it takes effect without reconnecting.
 */

export const ACCESS_LEVELS = ['read', 'write'] as const
export type Access = (typeof ACCESS_LEVELS)[number]

export interface TokenRecord {
  id: string
  name: string
  /** ISO 8601 timestamp. */
  createdAt: string
  /** SHA-256 of the raw token, lowercase hex. */
  hash: string
  /** Missing on a record means "read". */
  access?: Access
}

/** What the OAuth grant carries in `props` for a token sign-in. */
export interface TokenProps {
  user: string
  tokenName: string
  tokenId: string
  access: Access
}

export const accessOf = (record: Pick<TokenRecord, 'access'>): Access =>
  record.access === 'write' ? 'write' : 'read'

export function validateAccess(raw: unknown): Access {
  if (raw === undefined) return 'read'
  if (raw === 'read' || raw === 'write') return raw
  throw new TokenError('access must be "read" or "write".', 400)
}

const NAME_PREFIX = 'pat:name:'
const HASH_PREFIX = 'pat:hash:'
const TOKEN_PREFIX = 'bb_pat_'

export const MAX_NAME_LENGTH = 64
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._@+-]*$/u

const nameKey = (name: string) => `${NAME_PREFIX}${name.trim().toLowerCase()}`
const hashKey = (hash: string) => `${HASH_PREFIX}${hash}`

/** The OAuth subject every grant made with this token is issued to. */
export const userIdFor = (record: Pick<TokenRecord, 'id'>) => `pat-${record.id}`

export class TokenError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409
  ) {
    super(message)
  }
}

/** Trimmed name, or a TokenError explaining what is wrong with it. */
export function validateName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) throw new TokenError('A name is required.', 400)
  if (name.length > MAX_NAME_LENGTH) {
    throw new TokenError(`The name must be at most ${MAX_NAME_LENGTH} characters.`, 400)
  }
  if (!NAME_PATTERN.test(name)) {
    throw new TokenError(
      'The name may contain letters, digits, spaces and . _ @ + - and must start with a letter or digit.',
      400
    )
  }
  return name
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const b64 = btoa(String.fromCharCode(...bytes))
  return TOKEN_PREFIX + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function getToken(kv: KVNamespace, name: string): Promise<TokenRecord | null> {
  return kv.get<TokenRecord>(nameKey(name), 'json')
}

/** Create a token. Returns the record and the raw token, which is never stored. */
export async function createToken(
  kv: KVNamespace,
  rawName: unknown,
  rawAccess?: unknown
): Promise<{ record: TokenRecord; token: string }> {
  const name = validateName(rawName)
  const access = validateAccess(rawAccess)
  if (await getToken(kv, name)) {
    throw new TokenError(`A token named "${name}" already exists.`, 409)
  }
  const token = generateToken()
  const record: TokenRecord = {
    id: crypto.randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    hash: await sha256Hex(token),
    access,
  }
  // Index first: a record without its index is unusable, an index without its
  // record is ignored by findTokenByRawToken.
  await kv.put(hashKey(record.hash), nameKey(name).slice(NAME_PREFIX.length))
  await kv.put(nameKey(name), JSON.stringify(record))
  return { record, token }
}

export interface TokenSummary {
  name: string
  createdAt: string
  access: Access
}

export async function listTokens(kv: KVNamespace): Promise<TokenSummary[]> {
  const keys: string[] = []
  let cursor: string | undefined
  do {
    const page = await kv.list({ prefix: NAME_PREFIX, cursor })
    keys.push(...page.keys.map((k) => k.name))
    cursor = page.list_complete ? undefined : (page as { cursor?: string }).cursor
  } while (cursor)

  const records = await Promise.all(keys.map((k) => kv.get<TokenRecord>(k, 'json')))
  return records
    .filter((r): r is TokenRecord => r !== null)
    .map((r) => ({ name: r.name, createdAt: r.createdAt, access: accessOf(r) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Change a token's access level. Takes effect on the token's next /mcp request. */
export async function setAccess(
  kv: KVNamespace,
  rawName: unknown,
  rawAccess: unknown
): Promise<TokenSummary> {
  if (rawAccess === undefined) throw new TokenError('access must be "read" or "write".', 400)
  const access = validateAccess(rawAccess)
  const name = typeof rawName === 'string' ? rawName.trim() : ''
  const record = name ? await getToken(kv, name) : null
  if (!record) throw new TokenError(`No token named "${name}".`, 404)
  const updated: TokenRecord = { ...record, access }
  await kv.put(nameKey(name), JSON.stringify(updated))
  return { name: updated.name, createdAt: updated.createdAt, access }
}

/** Delete a token's record and index. Returns the deleted record (for grant revocation). */
export async function deleteToken(kv: KVNamespace, rawName: unknown): Promise<TokenRecord> {
  const name = typeof rawName === 'string' ? rawName.trim() : ''
  const record = name ? await getToken(kv, name) : null
  if (!record) throw new TokenError(`No token named "${name}".`, 404)
  await kv.delete(nameKey(name))
  await kv.delete(hashKey(record.hash))
  return record
}

/**
 * Find the record for a submitted raw token, by hash. The stored hash is
 * compared with `equal` (a constant-time comparison) rather than trusted from
 * the index lookup alone.
 */
export async function findTokenByRawToken(
  kv: KVNamespace,
  submitted: string,
  equal: (a: string, b: string) => Promise<boolean>
): Promise<TokenRecord | null> {
  if (!submitted.startsWith(TOKEN_PREFIX)) return null
  const hash = await sha256Hex(submitted)
  const lowerName = await kv.get(hashKey(hash))
  const record = lowerName ? await kv.get<TokenRecord>(`${NAME_PREFIX}${lowerName}`, 'json') : null
  if (!record) return null
  return (await equal(hash, record.hash)) ? record : null
}

/**
 * The live token record behind the props of a validated /mcp access token, or
 * null when that token has been revoked (or replaced by a new one with the same
 * name). Grants without a token name (the old shared-secret grants) never match.
 */
export async function resolveTokenGrant(
  kv: KVNamespace,
  props: unknown
): Promise<TokenRecord | null> {
  if (!props || typeof props !== 'object') return null
  const { tokenName, tokenId } = props as Partial<TokenProps>
  if (typeof tokenName !== 'string' || !tokenName || typeof tokenId !== 'string') return null
  const record = await getToken(kv, tokenName)
  return record && record.id === tokenId ? record : null
}
