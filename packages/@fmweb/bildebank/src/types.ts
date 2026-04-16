export interface BildebankImage {
  id: string
  url: string
  filename: string
  size: number
  mimeType: string
  altText: string | null
  folderId: string | null
  tenantId: string
  createdAt: string
  updatedAt: string
}

export interface ListImagesResponse {
  data: BildebankImage[]
  limit: number
  offset: number
}

export interface UploadImageOptions {
  file: File | Blob
  filename?: string
  tenantId?: string
  altText?: string
  folderId?: string
}

export interface ListImagesOptions {
  tenantId?: string
  folderId?: string
  limit?: number
  offset?: number
}

export interface BildebankClientOptions {
  baseUrl: string
  apiSecret: string
}