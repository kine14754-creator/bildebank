export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/svg+xml',
] as const

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number]

const MIME_TO_EXT: Record<AllowedMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

export const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MB

export function isAllowedMimeType(mimeType: string): mimeType is AllowedMimeType {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)
}

export function buildR2Key(tenantId: string, mimeType: AllowedMimeType, id: string): string {
  const year = new Date().getFullYear()
  const ext = MIME_TO_EXT[mimeType]
  return `${tenantId}/${year}/${id}.${ext}`
}

export function buildImageUrl(baseUrl: string, key: string): string {
  return `${baseUrl}/files/${key}`
}

export async function uploadToR2(
  bucket: R2Bucket,
  key: string,
  body: ArrayBuffer,
  contentType: string
): Promise<void> {
  await bucket.put(key, body, { httpMetadata: { contentType } })
}

export async function deleteFromR2(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key)
}

export async function getFromR2(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
  return bucket.get(key)
}
