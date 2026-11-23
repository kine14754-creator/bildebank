/**
 * Pixel dimensions read from an image file's header, without decoding it.
 * Used by storeImage, so every upload path records width and height.
 *
 * JPEG: the first SOF marker, swapped when EXIF orientation is 5–8 (rotated
 * 90°/270°), so the result is the size the picture is displayed at.
 * PNG: IHDR. WebP: VP8, VP8L or VP8X header. SVG: numeric width/height
 * attributes (px or unitless), else the viewBox.
 *
 * Returns null when the size can't be read; the upload still succeeds.
 */
import type { AllowedMimeType } from '../r2/client'

export interface ImageSize {
  width: number
  height: number
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!
const u32be = (b: Uint8Array, i: number) =>
  ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n))

const valid = (width: number, height: number): ImageSize | null =>
  Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width: Math.round(width), height: Math.round(height) }
    : null

export function readImageSize(buffer: ArrayBuffer, mimeType: AllowedMimeType): ImageSize | null {
  const bytes = new Uint8Array(buffer)
  try {
    switch (mimeType) {
      case 'image/jpeg':
        return jpegSize(bytes)
      case 'image/png':
        return bytes.length >= 24 && ascii(bytes, 12, 4) === 'IHDR'
          ? valid(u32be(bytes, 16), u32be(bytes, 20))
          : null
      case 'image/webp':
        return webpSize(bytes)
      case 'image/svg+xml':
        return svgSize(bytes)
    }
  } catch {
    return null
  }
}

/** SOF markers carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) are not frames. */
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc

function jpegSize(b: Uint8Array): ImageSize | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null
  let orientation = 1
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]!
    if (marker === 0xff) {
      i++ // fill byte
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2 // no length field
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null // end of image / start of scan before any frame
    const length = u16be(b, i + 2)
    if (marker === 0xe1 && ascii(b, i + 4, 6) === 'Exif\0\0') {
      orientation = exifOrientation(b.subarray(i + 10, i + 2 + length)) ?? orientation
    }
    if (isSof(marker) && i + 9 <= b.length) {
      const height = u16be(b, i + 5)
      const width = u16be(b, i + 7)
      return orientation >= 5 && orientation <= 8 ? valid(height, width) : valid(width, height)
    }
    i += 2 + length
  }
  return null
}

/** Tag 0x0112 from IFD0 of a TIFF block (the EXIF payload). */
function exifOrientation(t: Uint8Array): number | null {
  if (t.length < 8) return null
  const le = ascii(t, 0, 2) === 'II'
  const u16 = (i: number) => (le ? t[i]! | (t[i + 1]! << 8) : u16be(t, i))
  const u32 = (i: number) =>
    le ? (t[i]! | (t[i + 1]! << 8) | (t[i + 2]! << 16) | (t[i + 3]! << 24)) >>> 0 : u32be(t, i)
  const ifd = u32(4)
  if (ifd + 2 > t.length) return null
  const count = u16(ifd)
  for (let n = 0; n < count; n++) {
    const entry = ifd + 2 + n * 12
    if (entry + 12 > t.length) return null
    if (u16(entry) === 0x0112) return u16(entry + 8)
  }
  return null
}

function webpSize(b: Uint8Array): ImageSize | null {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null
  switch (ascii(b, 12, 4)) {
    case 'VP8 ': // lossy: 14-bit sizes after the frame tag and start code
      return valid((b[26]! | (b[27]! << 8)) & 0x3fff, (b[28]! | (b[29]! << 8)) & 0x3fff)
    case 'VP8L': // lossless: 14-bit sizes minus one, packed after the 0x2f signature
      if (b[20] !== 0x2f) return null
      return valid(
        1 + (((b[22]! & 0x3f) << 8) | b[21]!),
        1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6))
      )
    case 'VP8X': // extended: 24-bit canvas sizes minus one
      return valid(
        1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)),
        1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16))
      )
    default:
      return null
  }
}

function svgSize(b: Uint8Array): ImageSize | null {
  const head = new TextDecoder().decode(b.subarray(0, 4096))
  const tag = /<svg\b[^>]*>/i.exec(head)?.[0]
  if (!tag) return null
  const attr = (name: string) =>
    new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1]?.trim()
  const px = (v: string | undefined) => {
    const m = v ? /^(\d+(?:\.\d+)?)(px)?$/i.exec(v) : null
    return m ? Number(m[1]) : NaN
  }
  const fromAttrs = valid(px(attr('width')), px(attr('height')))
  if (fromAttrs) return fromAttrs
  const box = attr('viewBox')
    ?.split(/[\s,]+/)
    .map(Number)
  return box && box.length === 4 ? valid(box[2]!, box[3]!) : null
}
