/**
 * Upload sessions behind the MCP create_upload_link tool.
 *
 * The MCP server cannot read files on the user's computer, so create_upload_link
 * makes a short-lived session and hands back a link to an upload page in this
 * worker (src/routes/uploadPage.ts). The random token in that link is the only
 * credential: it allows uploading into this one session and nothing else.
 *
 * Stored in OAUTH_KV next to the personal access tokens (`pat:`), under `upload:`:
 *
 *   upload:token:<sha-256 of token>      → session id      (TTL: the upload window)
 *   upload:session:<id>                  → UploadSession   (TTL: RETAIN_SECONDS)
 *   upload:file:<id>:<imageId>           → UploadedFile    (TTL: RETAIN_SECONDS)
 *
 * The token itself is never stored. The session and its file list outlive the
 * upload window (RETAIN_SECONDS) so get_upload_session still works afterwards.
 * One key per file, rather than a list on the session, so two uploads finishing
 * at once cannot overwrite each other's entries.
 *
 * KV is eventually consistent, so the file limit is a brake, not an exact
 * counter: the page uploads one file at a time, which keeps it exact in practice.
 */
import { sha256Hex, type TokenProps } from './tokens'

export const UPLOAD_SESSION_MINUTES = 30
export const UPLOAD_SESSION_MAX_FILES = 50
/** How long get_upload_session can still read a session after it was created. */
export const UPLOAD_SESSION_RETAIN_SECONDS = 24 * 60 * 60
export const UPLOAD_PATH = '/upload'

const TOKEN_PREFIX = 'bb_up_'
const tokenKey = (hash: string) => `upload:token:${hash}`
const sessionKey = (id: string) => `upload:session:${id}`
const filePrefix = (id: string) => `upload:file:${id}:`

/** The personal access token that created a session (logged and stored for attribution). */
export type Actor = Pick<TokenProps, 'tokenName' | 'tokenId'>

export interface UploadSession {
  id: string
  /** ISO 8601. */
  createdAt: string
  /** ISO 8601. Uploads are refused from this moment. */
  expiresAt: string
  maxFiles: number
  folderId: string | null
  /** Snapshot for the page, taken when the session was created. */
  folderPath: string | null
  tagIds: string[]
  /** Snapshot for the page, taken when the session was created. */
  tagNames: string[]
  createdBy: Actor | null
}

export interface UploadedFile {
  imageId: string
  /** "uploaded": stored by this session. "existing": a same-named image was already there, so nothing was stored. */
  kind: 'uploaded' | 'existing'
  /** ISO 8601. */
  at: string
}

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const b64 = btoa(String.fromCharCode(...bytes))
  return TOKEN_PREFIX + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const isExpired = (session: UploadSession, now = new Date()) =>
  now.getTime() >= Date.parse(session.expiresAt)

export async function createUploadSession(
  kv: KVNamespace,
  input: Pick<UploadSession, 'folderId' | 'folderPath' | 'tagIds' | 'tagNames' | 'createdBy'>,
  now = new Date(),
): Promise<{ session: UploadSession; token: string }> {
  const ttl = UPLOAD_SESSION_MINUTES * 60
  const session: UploadSession = {
    id: crypto.randomUUID(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
    maxFiles: UPLOAD_SESSION_MAX_FILES,
    ...input,
  }
  const token = generateToken()
  // Session first: a token index pointing at nothing is just a dead link.
  await kv.put(sessionKey(session.id), JSON.stringify(session), {
    expirationTtl: UPLOAD_SESSION_RETAIN_SECONDS,
  })
  await kv.put(tokenKey(await sha256Hex(token)), session.id, {
    expirationTtl: ttl,
  })
  return { session, token }
}

export async function getUploadSession(kv: KVNamespace, id: string): Promise<UploadSession | null> {
  return kv.get<UploadSession>(sessionKey(id), 'json')
}

/** The session a link token belongs to, or null for an unknown token. Expiry is the caller's check. */
export async function findSessionByToken(
  kv: KVNamespace,
  token: string,
): Promise<UploadSession | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null
  const id = await kv.get(tokenKey(await sha256Hex(token)))
  return id ? getUploadSession(kv, id) : null
}

export async function recordUploadedFile(
  kv: KVNamespace,
  sessionId: string,
  file: Omit<UploadedFile, 'at'>,
  now = new Date(),
): Promise<void> {
  const key = `${filePrefix(sessionId)}${file.imageId}`
  // Picking a file again that this session already uploaded hits the duplicate
  // check; it must stay listed as uploaded, not turn into "existing".
  if (file.kind === 'existing') {
    const current = await kv.get<UploadedFile>(key, 'json')
    if (current?.kind === 'uploaded') return
  }
  const entry: UploadedFile = { ...file, at: now.toISOString() }
  await kv.put(key, JSON.stringify(entry), {
    expirationTtl: UPLOAD_SESSION_RETAIN_SECONDS,
  })
}

/** Every file recorded for a session, oldest first. */
export async function listUploadedFiles(
  kv: KVNamespace,
  sessionId: string,
): Promise<UploadedFile[]> {
  const keys: string[] = []
  let cursor: string | undefined
  do {
    const page = await kv.list({ prefix: filePrefix(sessionId), cursor })
    keys.push(...page.keys.map((k) => k.name))
    cursor = page.list_complete ? undefined : (page as { cursor?: string }).cursor
  } while (cursor)
  const entries = await Promise.all(keys.map((k) => kv.get<UploadedFile>(k, 'json')))
  return entries
    .filter((e): e is UploadedFile => e !== null)
    .sort((a, b) => a.at.localeCompare(b.at))
}

export const uploadUrl = (baseUrl: string, token: string) => `${baseUrl}${UPLOAD_PATH}/${token}`
