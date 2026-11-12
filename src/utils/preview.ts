/**
 * Small previews for the MCP view_image tool, so the model can actually see a picture.
 *
 * Resizes on the worker with the Cloudflare Images binding (IMAGES) when it is
 * bound: longest side = maxSize, WebP, stepping quality and size down until the
 * result fits the byte budget. Without the binding (or if it fails) the stored
 * original is used as-is when it is a raster type already under the budget.
 * There are no stored small variants yet (WebP conversion is disabled), so that
 * is the only fallback.
 */
import type { Env } from '../types'

/** Largest preview returned to the model; bigger images cost context for little gain. */
export const PREVIEW_MAX_BYTES = 150 * 1024

/** Types an MCP image content block may carry and that Claude can read. */
const VIEWABLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

export type Preview =
  | { ok: true; data: string; mimeType: string; bytes: number; resized: boolean }
  | { ok: false; reason: string }

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

const streamOf = (bytes: Uint8Array) => new Response(bytes).body as ReadableStream<Uint8Array>

async function resizeWithBinding(
  images: ImagesBinding,
  original: Uint8Array,
  maxSize: number
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  // Quality first (cheap on detail), then dimensions.
  const attempts = [
    { size: maxSize, quality: 80 },
    { size: maxSize, quality: 60 },
    { size: Math.round(maxSize * 0.75), quality: 55 },
    { size: Math.round(maxSize * 0.5), quality: 50 },
  ]
  for (const { size, quality } of attempts) {
    const result = await images
      .input(streamOf(original))
      .transform({ width: size, height: size, fit: 'scale-down' })
      .output({ format: 'image/webp', quality })
    const bytes = new Uint8Array(await new Response(result.image()).arrayBuffer())
    if (bytes.byteLength <= PREVIEW_MAX_BYTES) return { bytes, mimeType: result.contentType() }
  }
  return null
}

export async function makePreview(
  env: Env,
  original: Uint8Array,
  mimeType: string,
  maxSize: number
): Promise<Preview> {
  if (mimeType === 'image/svg+xml') {
    return { ok: false, reason: 'SVG images cannot be previewed as a picture; open the url instead.' }
  }

  let bindingError: string | undefined
  if (env.IMAGES) {
    try {
      const resized = await resizeWithBinding(env.IMAGES, original, maxSize)
      if (resized) {
        return {
          ok: true,
          data: toBase64(resized.bytes),
          mimeType: resized.mimeType,
          bytes: resized.bytes.byteLength,
          resized: true,
        }
      }
      bindingError = `could not get the preview under ${PREVIEW_MAX_BYTES / 1024} KB`
    } catch (err) {
      bindingError = err instanceof Error ? err.message : String(err)
    }
  }

  if (VIEWABLE_TYPES.has(mimeType) && original.byteLength <= PREVIEW_MAX_BYTES) {
    return {
      ok: true,
      data: toBase64(original),
      mimeType,
      bytes: original.byteLength,
      resized: false,
    }
  }

  const why = env.IMAGES
    ? `resizing failed (${bindingError})`
    : 'image resizing is not configured on the worker (no IMAGES binding)'
  return {
    ok: false,
    reason: `No preview: ${why}, and the original is ${Math.round(original.byteLength / 1024)} KB.`,
  }
}
