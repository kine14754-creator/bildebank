import { describe, expect, it } from 'vitest'
import { readImageSize } from './imageSize'
import { fakeJpeg, jpegWithSize, TINY_PNG } from '../../test/helpers'

const buf = (bytes: Uint8Array | number[]) => Uint8Array.from(bytes).buffer
const text = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer

/** RIFF/WEBP container with the given chunk header bytes from offset 12. */
function webp(chunk: string, body: number[]): ArrayBuffer {
  const out = new Uint8Array(40)
  out.set(new TextEncoder().encode('RIFF'), 0)
  out.set(new TextEncoder().encode('WEBP'), 8)
  out.set(new TextEncoder().encode(chunk), 12)
  out.set(body, 16)
  return out.buffer
}

describe('readImageSize', () => {
  it('reads JPEG frame sizes, swapped for EXIF orientation 5–8', () => {
    expect(readImageSize(buf(jpegWithSize(732, 1080)), 'image/jpeg')).toEqual({
      width: 732,
      height: 1080,
    })
    expect(readImageSize(buf(jpegWithSize(1080, 732, 1)), 'image/jpeg')).toEqual({
      width: 1080,
      height: 732,
    })
    expect(readImageSize(buf(jpegWithSize(1080, 732, 6)), 'image/jpeg')).toEqual({
      width: 732,
      height: 1080,
    })
  })

  it('reads PNG IHDR', () => {
    expect(readImageSize(buf(TINY_PNG), 'image/png')).toEqual({ width: 1, height: 1 })
  })

  it('reads lossy, lossless and extended WebP headers', () => {
    // VP8: chunk size (4) + frame tag (3) + start code 9d 01 2a, then 14-bit width/height LE.
    const vp8 = webp('VP8 ', [0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 0xdc, 0x02, 0x38, 0x04])
    expect(readImageSize(vp8, 'image/webp')).toEqual({ width: 732, height: 1080 })
    // VP8L: signature 0x2f, then 14-bit (w-1) and (h-1) packed LE: w=732, h=1080.
    const w = 731,
      h = 1079
    const bits = w | (h << 14)
    const vp8l = webp('VP8L', [
      0,
      0,
      0,
      0,
      0x2f,
      bits & 0xff,
      (bits >> 8) & 0xff,
      (bits >> 16) & 0xff,
      (bits >> 24) & 0xff,
    ])
    expect(readImageSize(vp8l, 'image/webp')).toEqual({ width: 732, height: 1080 })
    // VP8X: flags + reserved (8 bytes from 16), then 24-bit (w-1), (h-1) LE.
    const vp8x = webp('VP8X', [0, 0, 0, 0, 0, 0, 0, 0, 0xdb, 0x02, 0, 0x37, 0x04, 0])
    expect(readImageSize(vp8x, 'image/webp')).toEqual({ width: 732, height: 1080 })
  })

  it('reads SVG width/height, else the viewBox', () => {
    expect(
      readImageSize(
        text('<svg xmlns="http://www.w3.org/2000/svg" width="120px" height="80">'),
        'image/svg+xml'
      )
    ).toEqual({ width: 120, height: 80 })
    expect(
      readImageSize(
        text('<?xml version="1.0"?><svg viewBox="0 0 24 24.5" width="100%">'),
        'image/svg+xml'
      )
    ).toEqual({ width: 24, height: 25 })
    expect(
      readImageSize(text('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml')
    ).toBeNull()
  })

  it('returns null instead of throwing for headers it cannot read', () => {
    expect(readImageSize(buf(fakeJpeg(64)), 'image/jpeg')).toBeNull()
    expect(readImageSize(buf([0xff, 0xd8, 0xff]), 'image/jpeg')).toBeNull()
    expect(readImageSize(buf([1, 2, 3]), 'image/png')).toBeNull()
    expect(readImageSize(buf([1, 2, 3]), 'image/webp')).toBeNull()
  })
})
