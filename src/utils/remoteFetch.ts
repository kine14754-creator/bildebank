/**
 * Fetching a user-supplied image URL server-side (MCP upload_image).
 *
 * Only public https URLs are fetched. The host is checked before every request,
 * redirects are followed by hand so each hop is checked again, and the body is
 * read with a byte cap so a lying or missing Content-Length cannot blow the limit.
 * The worker also runs with the global_fetch_strictly_public flag, so even a
 * hostname that resolves to a private address cannot reach an internal network.
 */
import { isAllowedMimeType, type AllowedMimeType } from '../r2/client'

export class RemoteFetchError extends Error {}

const MAX_REDIRECTS = 5

const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.corp',
  '.home.arpa',
  '.localdomain',
]

function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null
}

/** IPv4 addresses that are not on the public internet (RFC 6890 and friends). */
function isNonPublicIPv4([a, b]: number[]): boolean {
  if (a === undefined || b === undefined) return true
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // IETF protocol assignments / TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  )
}

/**
 * True when a URL hostname must not be fetched: localhost and internal-looking
 * names, single-label hosts, private/reserved IPv4 literals, and all IPv6
 * literals (a public image is never addressed by a bare IPv6 address in practice).
 * The WHATWG URL parser has already normalised decimal/hex IPv4 forms such as
 * `2130706433` or `0x7f.1` to dotted quads by the time this runs.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return true
  if (host.startsWith('[') || host.includes(':')) return true
  const v4 = parseIPv4(host)
  if (v4) return isNonPublicIPv4(v4)
  if (/^[\d.]+$/.test(host)) return true // malformed numeric host
  if (host === 'localhost' || !host.includes('.')) return true
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

/** Parse and vet a source URL; throws RemoteFetchError with an LLM-readable reason. */
export function validateSourceUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new RemoteFetchError(`Not a valid URL: ${raw}`)
  }
  if (url.protocol !== 'https:') {
    throw new RemoteFetchError(`Only https:// URLs are accepted (got ${url.protocol}).`)
  }
  if (url.username || url.password) {
    throw new RemoteFetchError('URLs with embedded credentials are not accepted.')
  }
  if (url.port && url.port !== '443') {
    throw new RemoteFetchError('Only the default https port (443) is accepted.')
  }
  if (isBlockedHost(url.hostname)) {
    throw new RemoteFetchError(
      `Refusing to fetch from "${url.hostname}": only public internet hosts are allowed.`
    )
  }
  return url
}

/** Content-Type header without parameters, lower-cased. */
function baseMimeType(header: string | null): string {
  return (header ?? '').split(';')[0]!.trim().toLowerCase()
}

/** Check the first bytes against the claimed type, so an HTML error page labelled image/jpeg is refused. */
export function matchesMagicBytes(bytes: Uint8Array, mimeType: AllowedMimeType): boolean {
  const at = (i: number) => bytes[i]
  switch (mimeType) {
    case 'image/jpeg':
      return at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff
    case 'image/png':
      return at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47
    case 'image/webp':
      return (
        String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
        String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
      )
    case 'image/svg+xml': {
      const head = new TextDecoder().decode(bytes.subarray(0, 1024)).toLowerCase()
      return head.includes('<svg')
    }
  }
}

async function readCapped(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<ArrayBuffer> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new RemoteFetchError(`The image is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out.buffer
}

export interface RemoteImage {
  buffer: ArrayBuffer
  mimeType: AllowedMimeType
  finalUrl: URL
}

export async function fetchRemoteImage(
  raw: string,
  opts: { maxBytes: number; fetchImpl?: typeof fetch }
): Promise<RemoteImage> {
  const doFetch = opts.fetchImpl ?? fetch
  let url = validateSourceUrl(raw)

  for (let hop = 0; ; hop++) {
    let res: Response
    try {
      res = await doFetch(url.toString(), {
        redirect: 'manual',
        headers: { Accept: 'image/jpeg,image/png,image/webp,image/svg+xml;q=0.8' },
      })
    } catch (err) {
      throw new RemoteFetchError(
        `Could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('Location')
      await res.body?.cancel().catch(() => {})
      if (!location) throw new RemoteFetchError(`Redirect from ${url} has no Location header.`)
      if (hop >= MAX_REDIRECTS) throw new RemoteFetchError('Too many redirects.')
      url = validateSourceUrl(new URL(location, url).toString())
      continue
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new RemoteFetchError(`Fetching ${url} failed with HTTP ${res.status}.`)
    }

    const mimeType = baseMimeType(res.headers.get('Content-Type'))
    if (!isAllowedMimeType(mimeType)) {
      await res.body?.cancel().catch(() => {})
      throw new RemoteFetchError(
        `Unsupported content type "${mimeType || 'none'}". Allowed: JPEG, PNG, WebP, SVG.`
      )
    }
    const declared = Number(res.headers.get('Content-Length') ?? '')
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      await res.body?.cancel().catch(() => {})
      throw new RemoteFetchError(
        `The image is larger than ${Math.round(opts.maxBytes / 1024 / 1024)} MB.`
      )
    }
    if (!res.body) throw new RemoteFetchError(`Empty response from ${url}.`)

    const buffer = await readCapped(res.body, opts.maxBytes)
    if (buffer.byteLength === 0) throw new RemoteFetchError(`Empty response from ${url}.`)
    if (!matchesMagicBytes(new Uint8Array(buffer), mimeType)) {
      throw new RemoteFetchError(`The response from ${url} is not a valid ${mimeType} file.`)
    }
    return { buffer, mimeType, finalUrl: url }
  }
}

/**
 * Filename to store: the given one, else the URL's last path segment. Computed
 * before the download so the duplicate check can run without fetching anything.
 */
export function deriveFilename(given: string | undefined, sourceUrl: URL): string {
  let name = given?.trim() ?? ''
  if (!name) {
    const last = sourceUrl.pathname.split('/').filter(Boolean).pop() ?? ''
    try {
      name = decodeURIComponent(last)
    } catch {
      name = last
    }
  }
  return cleanFilename(name)
}

/**
 * Make a filename safe to store: control characters and slashes become "_",
 * at most 200 characters, "image" if nothing is left. Shared by upload_image
 * and the upload-link page.
 */
export function cleanFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(0, 200) || 'image'
}
