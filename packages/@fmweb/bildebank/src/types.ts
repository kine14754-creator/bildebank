export interface BildebankImage {
  id: string
  url: string
  /** WebP-optimalisert versjon av bildet (kun for jpeg/png) */
  webpUrl?: string
  filename: string
  size: number
  mimeType: string
  altText: string | null
  folderId: string | null
  tenantId: string
  createdAt: string
  updatedAt: string
}

export interface BildebankTag {
  id: string
  name: string
  tenantId: string
  createdAt: string
}

export interface ListImagesResponse {
  data: BildebankImage[]
  limit: number
  offset: number
}

export interface ListTagsResponse {
  data: BildebankTag[]
}

export interface UploadImageOptions {
  file: File | Blob
  filename?: string
  tenantId?: string
  altText?: string
  folderId?: string
}

export interface UpdateImageOptions {
  filename?: string
  altText?: string
}

export interface ReplaceImageOptions {
  file: File
}

export interface ListImagesOptions {
  tenantId?: string
  folderId?: string
  /** Fritekst-søk — filtrerer på filename (case-insensitive) */
  search?: string
  /** Filtrer på en spesifikk tag-ID */
  tagId?: string
  limit?: number
  offset?: number
}

export interface ListTagsOptions {
  tenantId?: string
}

export interface BildebankClientOptions {
  baseUrl: string
  apiSecret: string
}
