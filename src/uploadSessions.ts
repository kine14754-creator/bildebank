/**
 * Upload sessions behind the MCP create_upload_link tool.
 *
 * The MCP server cannot read files on the user's computer, so create_upload_link
 * makes a short-lived session and hands back a link to an upload page in this
 * worker (src/routes/uploadPage.ts). The random token in that link is the only
 * credential: it allows uploading into this one session and nothing else.
 *
 * Stored in Postgres (tables upload_sessions and upload_session_files), not KV.
 * The upload POST and the MCP get_upload_session call usually arrive at different
 * Cloudflare locations, and KV reads are cached per location (up to ~60 s), so a
 * file recorded in KV by one could be invisible to the other. Postgres is one
 * consistent store: an upload is in the session as soon as the POST has answered.
 *
 * Only the SHA-256 of the link token is stored. A session is readable for
 * RETAIN_SECONDS after it is created; older ones are deleted when a new one is made.
 */
import { and, asc, count, eq, lt } from 'drizzle-orm'
import { uploadSessionFiles, uploadSessions, type Db } from './db'
import { sha256Hex, type TokenProps } from './tokens'

export const UPLOAD_SESSION_MINUTES = 30
export const UPLOAD_SESSION_MAX_FILES = 50
/** How long get_upload_session can still read a session after it was created. */
export const UPLOAD_SESSION_RETAIN_SECONDS = 24 * 60 * 60
export const UPLOAD_PATH = '/upload'

const TOKEN_PREFIX = 'bb_up_'
const TENANT_ID = 'default'

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

type Row = typeof uploadSessions.$inferSelect

const toSession = (row: Row): UploadSession => ({
  id: row.id,
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
  maxFiles: row.maxFiles,
  folderId: row.folderId,
  folderPath: row.folderPath,
  tagIds: row.tagIds,
  tagNames: row.tagNames,
  createdBy: row.createdBy ?? null,
})

export async function createUploadSession(
  db: Db,
  input: Pick<UploadSession, 'folderId' | 'folderPath' | 'tagIds' | 'tagNames' | 'createdBy'>,
  now = new Date()
): Promise<{ session: UploadSession; token: string }> {
  // Housekeeping: sessions past the read window (their file rows cascade).
  await db
    .delete(uploadSessions)
    .where(
      lt(uploadSessions.createdAt, new Date(now.getTime() - UPLOAD_SESSION_RETAIN_SECONDS * 1000))
    )

  const token = generateToken()
  const [row] = await db
    .insert(uploadSessions)
    .values({
      tokenHash: await sha256Hex(token),
      tenantId: TENANT_ID,
      folderId: input.folderId,
      folderPath: input.folderPath,
      tagIds: input.tagIds,
      tagNames: input.tagNames,
      maxFiles: UPLOAD_SESSION_MAX_FILES,
      createdBy: input.createdBy,
      createdAt: now,
      expiresAt: new Date(now.getTime() + UPLOAD_SESSION_MINUTES * 60 * 1000),
    })
    .returning()
  return { session: toSession(row!), token }
}

/** A session by id, or null when unknown or older than the read window. */
export async function getUploadSession(
  db: Db,
  id: string,
  now = new Date()
): Promise<UploadSession | null> {
  const [row] = await db.select().from(uploadSessions).where(eq(uploadSessions.id, id)).limit(1)
  if (!row) return null
  const tooOld = now.getTime() - row.createdAt.getTime() > UPLOAD_SESSION_RETAIN_SECONDS * 1000
  return tooOld ? null : toSession(row)
}

/** The session a link token belongs to, or null for an unknown token. Expiry is the caller's check. */
export async function findSessionByToken(db: Db, token: string): Promise<UploadSession | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null
  const [row] = await db
    .select()
    .from(uploadSessions)
    .where(eq(uploadSessions.tokenHash, await sha256Hex(token)))
    .limit(1)
  return row ? toSession(row) : null
}

export async function recordUploadedFile(
  db: Db,
  sessionId: string,
  file: Omit<UploadedFile, 'at'>,
  now = new Date()
): Promise<void> {
  // One row per (session, image). Picking a file again that this session already
  // uploaded hits the duplicate check; the existing "uploaded" row is kept, so it
  // never turns into "existing".
  await db
    .insert(uploadSessionFiles)
    .values({ sessionId, imageId: file.imageId, kind: file.kind, createdAt: now })
    .onConflictDoNothing()
}

/** Every file recorded for a session, oldest first. */
export async function listUploadedFiles(db: Db, sessionId: string): Promise<UploadedFile[]> {
  const rows = await db
    .select()
    .from(uploadSessionFiles)
    .where(eq(uploadSessionFiles.sessionId, sessionId))
    .orderBy(asc(uploadSessionFiles.createdAt), asc(uploadSessionFiles.imageId))
  return rows.map((r) => ({
    imageId: r.imageId,
    kind: r.kind === 'existing' ? 'existing' : 'uploaded',
    at: r.createdAt.toISOString(),
  }))
}

/** How many files this session has stored (duplicates that were skipped don't count). */
export async function countUploadedFiles(db: Db, sessionId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(uploadSessionFiles)
    .where(
      and(eq(uploadSessionFiles.sessionId, sessionId), eq(uploadSessionFiles.kind, 'uploaded'))
    )
  return Number(row?.n ?? 0)
}

export const uploadUrl = (baseUrl: string, token: string) => `${baseUrl}${UPLOAD_PATH}/${token}`

/** Multipart field names for POST /upload/:token (the page, or Claude posting directly). */
export const UPLOAD_FILE_FIELD = 'file'
/** Send "1" to upload even when an image with the same filename exists. */
export const UPLOAD_FORCE_FIELD = 'force'
