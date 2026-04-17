import decodeJpeg from '@jsquash/jpeg/decode'
import decodePng from '@jsquash/png/decode'
import encodeWebp from '@jsquash/webp/encode'

const CONVERTIBLE = new Set(['image/jpeg', 'image/png'])

export function canConvertToWebP(mimeType: string): boolean {
  return CONVERTIBLE.has(mimeType)
}

/** Deriverer WebP-nøkkelen fra original R2-nøkkel ved å bytte ut filendelse */
export function toWebPKey(key: string): string {
  return key.replace(/\.[^./]+$/, '.webp')
}

/** Konverterer JPEG eller PNG til WebP. Kaster feil ved ukjent format. */
export async function convertToWebP(buffer: ArrayBuffer, mimeType: string): Promise<ArrayBuffer> {
  let imageData: ImageData

  if (mimeType === 'image/jpeg') {
    imageData = await decodeJpeg(buffer)
  } else if (mimeType === 'image/png') {
    imageData = await decodePng(buffer)
  } else {
    throw new Error(`Cannot convert ${mimeType} to WebP`)
  }

  return encodeWebp(imageData, { quality: 85 })
}
