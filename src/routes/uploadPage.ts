/**
 * The upload page behind the MCP create_upload_link tool (see src/uploadSessions.ts).
 * The POST endpoint is also called directly by Claude when it has the files itself
 * (create_upload_link returns it as uploadEndpoint); the page is for everyone else.
 *
 *   GET  /upload/:token   → minimal drag-and-drop / file-picker page
 *   POST /upload/:token   multipart { file, force? } → JSON, one file per request
 *
 * No sign-in: the token in the path is the only credential, and it only allows
 * uploading into its own session, until the session expires. Files go through the
 * same pipeline as POST /api/images/upload and the MCP upload_image tool (storeImage:
 * same types, 20 MB limit, WebP handling), with upload_image's magic-byte check and
 * same-filename check, and get the session's folder and tags.
 *
 * POST answers:
 *   201 { status: 'uploaded', image }   stored
 *   200 { status: 'existing', image }   an image with that filename exists; nothing stored
 *                                       (send again with force=1 to upload anyway)
 *   4xx { status: 'error', error }      not stored (unknown/expired link, bad file, limit reached)
 */
import { Hono, type Context } from 'hono'
import { createDb } from '../db'
import { publicOrigin } from '../oauth'
import { buildImageUrl, isAllowedMimeType, MAX_FILE_SIZE } from '../r2/client'
import { findImagesByFilename, storeImage } from '../services/images'
import { cleanFilename, matchesMagicBytes } from '../utils/remoteFetch'
import {
  findSessionByToken,
  isExpired,
  listUploadedFiles,
  recordUploadedFile,
  UPLOAD_FILE_FIELD,
  UPLOAD_FORCE_FIELD,
  type UploadSession,
} from '../uploadSessions'
import type { Env } from '../types'

type Ctx = Context<{ Bindings: Env }>

const TENANT_ID = 'default'
const MAX_MB = MAX_FILE_SIZE / 1024 / 1024

export const uploadPageRoutes = new Hono<{ Bindings: Env }>()

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )

function pageHeaders(nonce?: string): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': [
      "default-src 'none'",
      nonce ? `script-src 'nonce-${nonce}'` : '',
      "style-src 'unsafe-inline'",
      "connect-src 'self'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ]
      .filter(Boolean)
      .join('; '),
    'X-Frame-Options': 'DENY',
    // The token is in the path: never send it on in a Referer.
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
  }
}

const STYLE = `
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; --line: #8884; --ok: #1a7f37; --bad: #c22; --muted: #888; }
  body { max-width: 40rem; margin: 2.5rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.35rem; margin-bottom: .25rem; }
  .meta { color: var(--muted); margin-top: 0; }
  .drop { border: 2px dashed var(--line); border-radius: 10px; padding: 2.5rem 1rem; text-align: center; cursor: pointer; }
  .drop.over { border-color: currentColor; }
  .drop input { display: none; }
  .drop button { font: inherit; padding: .45rem 1rem; cursor: pointer; }
  ul { list-style: none; padding: 0; }
  li { display: flex; gap: .75rem; align-items: baseline; justify-content: space-between; padding: .5rem 0; border-bottom: 1px solid var(--line); }
  .name { overflow-wrap: anywhere; }
  .status { white-space: nowrap; color: var(--muted); }
  .status.ok { color: var(--ok); }
  .status.bad { color: var(--bad); white-space: normal; text-align: right; }
  .status button { font: inherit; margin-left: .5rem; cursor: pointer; }
  .error { color: var(--bad); font-weight: 600; }
`

function shell(title: string, body: string, status: number, nonce?: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`
  return new Response(html, { status, headers: pageHeaders(nonce) })
}

const deadLinkPage = (message: string, status: number) =>
  shell(
    'Bildebank — upload link',
    `<h1>This upload link can't be used</h1><p class="error">${escapeHtml(message)}</p>
<p>Ask Claude for a new upload link.</p>`,
    status,
  )

const EXPIRED_MESSAGE = 'This upload link has expired.'
const UNKNOWN_MESSAGE = 'This upload link is not valid.'

async function loadSession(
  c: Ctx,
): Promise<
  { session: UploadSession; kv: KVNamespace } | { error: string; status: 404 | 410 | 503 }
> {
  const kv = c.env.OAUTH_KV
  if (!kv) return { error: 'Uploads are not configured on this worker.', status: 503 }
  const session = await findSessionByToken(kv, c.req.param('token') ?? '')
  if (!session) return { error: UNKNOWN_MESSAGE, status: 404 }
  if (isExpired(session)) return { error: EXPIRED_MESSAGE, status: 410 }
  return { session, kv }
}

uploadPageRoutes.get('/:token', async (c) => {
  const loaded = await loadSession(c)
  if ('error' in loaded) return deadLinkPage(loaded.error, loaded.status)
  const { session, kv } = loaded
  const used = (await listUploadedFiles(kv, session.id)).filter((f) => f.kind === 'uploaded').length

  const where = [
    session.folderPath ? `Folder: <strong>${escapeHtml(session.folderPath)}</strong>` : 'No folder',
    session.tagNames.length
      ? `Tags: <strong>${session.tagNames.map(escapeHtml).join(', ')}</strong>`
      : '',
  ]
    .filter(Boolean)
    .join(' · ')

  const nonce = crypto.randomUUID().replace(/-/g, '')
  const config = JSON.stringify({
    expiresAt: session.expiresAt,
    remaining: Math.max(session.maxFiles - used, 0),
    maxBytes: MAX_FILE_SIZE,
  }).replace(/</g, '\\u003c')

  const body = `
<h1>Upload images to Bildebank</h1>
<p class="meta">${where}<br>JPEG, PNG, WebP or SVG, up to ${MAX_MB} MB each.
<span id="left"></span> Link expires at <span id="expires"></span>.</p>
<div class="drop" id="drop">
  <p>Drag images here, or</p>
  <button type="button" id="pick">Choose files…</button>
  <input type="file" id="files" multiple accept="image/jpeg,image/png,image/webp,image/svg+xml">
</div>
<ul id="list"></ul>
<script nonce="${nonce}">${pageScript(config)}</script>`
  return shell('Bildebank — upload', body, 200, nonce)
})

/** Client side: queue files, upload one at a time, show a status per file. */
function pageScript(config: string): string {
  return `
(() => {
  const cfg = ${config};
  const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'];
  const $ = (id) => document.getElementById(id);
  const list = $('list'), drop = $('drop'), input = $('files');
  let remaining = cfg.remaining;
  const queue = [];
  let busy = false;

  $('expires').textContent = new Date(cfg.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const showLeft = () => { $('left').textContent = remaining + ' upload' + (remaining === 1 ? '' : 's') + ' left.'; };
  showLeft();

  function row(file) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = file.name;
    const status = document.createElement('span');
    status.className = 'status';
    li.append(name, status);
    list.append(li);
    return status;
  }

  function set(status, cls, text, link) {
    status.className = 'status' + (cls ? ' ' + cls : '');
    status.textContent = text;
    if (link) {
      const a = document.createElement('a');
      a.href = link; a.target = '_blank'; a.rel = 'noreferrer'; a.textContent = 'view';
      status.append(' (', a, ')');
    }
  }

  function add(files) {
    for (const file of files) {
      const status = row(file);
      if (!TYPES.includes(file.type)) { set(status, 'bad', 'Failed: not a JPEG, PNG, WebP or SVG file'); continue; }
      if (file.size > cfg.maxBytes) { set(status, 'bad', 'Failed: larger than ' + (cfg.maxBytes / 1048576) + ' MB'); continue; }
      set(status, '', 'Waiting…');
      queue.push({ file, status, force: false });
    }
    pump();
  }

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) await send(queue.shift());
    busy = false;
  }

  async function send(job) {
    set(job.status, '', 'Uploading…');
    const body = new FormData();
    body.append('file', job.file);
    if (job.force) body.append('force', '1');
    let res, out;
    try {
      res = await fetch(location.pathname, { method: 'POST', body });
      out = await res.json();
    } catch (err) {
      set(job.status, 'bad', 'Failed: network error, try again');
      return;
    }
    if (out.status === 'uploaded') {
      remaining = Math.max(remaining - 1, 0); showLeft();
      set(job.status, 'ok', 'Uploaded', out.image.url);
    } else if (out.status === 'existing') {
      set(job.status, '', 'Already in Bildebank — skipped', out.image.url);
      const again = document.createElement('button');
      again.type = 'button'; again.textContent = 'Upload anyway';
      again.onclick = () => { queue.push({ file: job.file, status: job.status, force: true }); pump(); };
      job.status.append(again);
    } else {
      set(job.status, 'bad', 'Failed: ' + (out.error || ('HTTP ' + res.status)));
    }
  }

  $('pick').onclick = (e) => { e.stopPropagation(); input.click(); };
  drop.onclick = () => input.click();
  input.onchange = () => { add(input.files); input.value = ''; };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); add(e.dataTransfer.files); };
})();`
}

uploadPageRoutes.post('/:token', async (c) => {
  c.header('Cache-Control', 'no-store')
  const fail = (error: string, status: 400 | 404 | 409 | 410 | 413 | 415 | 500 | 503) =>
    c.json({ status: 'error', error }, status)

  const loaded = await loadSession(c)
  if ('error' in loaded) return fail(loaded.error, loaded.status)
  const { session, kv } = loaded

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return fail('Invalid multipart/form-data', 400)
  }
  const file = form.get(UPLOAD_FILE_FIELD)
  if (!file || !(file instanceof File)) return fail(`Missing "${UPLOAD_FILE_FIELD}" field`, 400)
  const mimeType = file.type
  if (!isAllowedMimeType(mimeType)) {
    return fail(
      `Unsupported file type: ${mimeType || 'unknown'}. Allowed: JPEG, PNG, WebP, SVG.`,
      415,
    )
  }
  if (file.size > MAX_FILE_SIZE) return fail(`File too large (max ${MAX_MB} MB)`, 413)
  if (file.size === 0) return fail('The file is empty.', 400)

  const filename = cleanFilename(file.name)
  const baseUrl = publicOrigin(c.req.raw, c.env)
  const db = createDb(c.env.DATABASE_URL)
  const describe = (img: {
    id: string
    filename: string
    key: string
    altText: string | null
  }) => ({
    id: img.id,
    filename: img.filename,
    url: buildImageUrl(baseUrl, img.key),
    altText: img.altText,
  })

  const force = form.get(UPLOAD_FORCE_FIELD) === '1'
  if (!force) {
    const [existing] = await findImagesByFilename(db, TENANT_ID, filename)
    if (existing) {
      await recordUploadedFile(kv, session.id, {
        imageId: existing.id,
        kind: 'existing',
      })
      return c.json({ status: 'existing', image: describe(existing) }, 200)
    }
  }

  const used = (await listUploadedFiles(kv, session.id)).filter((f) => f.kind === 'uploaded').length
  if (used >= session.maxFiles) {
    return fail(
      `This link allows at most ${session.maxFiles} uploads. Ask Claude for a new link.`,
      409,
    )
  }

  const buffer = await file.arrayBuffer()
  if (!matchesMagicBytes(new Uint8Array(buffer), mimeType)) {
    return fail(`The file is not a valid ${mimeType} file.`, 415)
  }

  let image
  try {
    image = await storeImage(c.env, db, {
      buffer,
      mimeType,
      filename,
      altText: null,
      folderId: session.folderId,
      tenantId: TENANT_ID,
      tagIds: session.tagIds,
    })
  } catch (err) {
    // E.g. the session's folder or a tag was deleted after the link was made.
    console.error('upload link: storing failed', session.id, err)
    return fail('The image could not be stored. Ask Claude for a new upload link.', 500)
  }
  await recordUploadedFile(kv, session.id, {
    imageId: image.id,
    kind: 'uploaded',
  })
  console.log(
    JSON.stringify({
      event: 'upload_link.upload',
      sessionId: session.id,
      imageId: image.id,
      tokenName: session.createdBy?.tokenName ?? null,
      tokenId: session.createdBy?.tokenId ?? null,
    }),
  )
  return c.json({ status: 'uploaded', image: describe(image) }, 201)
})
