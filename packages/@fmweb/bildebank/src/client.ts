import type {
  BildebankClientOptions,
  BildebankImage,
  ListImagesOptions,
  ListImagesResponse,
  ListTagsOptions,
  ListTagsResponse,
  ReplaceImageOptions,
  UpdateImageOptions,
  UploadImageOptions,
} from './types'

export class BildebankClient {
  private baseUrl: string
  private apiSecret: string

  constructor(options: BildebankClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.apiSecret = options.apiSecret
  }

  private get authHeaders(): HeadersInit {
    return { Authorization: `Bearer ${this.apiSecret}` }
  }

  async uploadImage(options: UploadImageOptions): Promise<BildebankImage> {
    const formData = new FormData()
    const file = options.file instanceof File
      ? options.file
      : new File([options.file], options.filename ?? 'upload', { type: options.file.type })
    formData.append('file', file)
    if (options.tenantId) formData.append('tenantId', options.tenantId)
    if (options.altText) formData.append('altText', options.altText)
    if (options.folderId) formData.append('folderId', options.folderId)
    const res = await fetch(`${this.baseUrl}/api/images/upload`, { method: 'POST', headers: this.authHeaders, body: formData })
    if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`)
    return res.json() as Promise<BildebankImage>
  }

  async listImages(options: ListImagesOptions = {}): Promise<ListImagesResponse> {
    const params = new URLSearchParams()
    if (options.tenantId) params.set('tenantId', options.tenantId)
    if (options.folderId) params.set('folderId', options.folderId)
    if (options.search) params.set('search', options.search)
    if (options.tagId) params.set('tagId', options.tagId)
    if (options.limit != null) params.set('limit', String(options.limit))
    if (options.offset != null) params.set('offset', String(options.offset))
    const res = await fetch(`${this.baseUrl}/api/images?${params}`, { headers: this.authHeaders })
    if (!res.ok) throw new Error(`List failed: ${res.status} ${await res.text()}`)
    return res.json() as Promise<ListImagesResponse>
  }

  async getImage(id: string): Promise<BildebankImage> {
    const res = await fetch(`${this.baseUrl}/api/images/${id}`, { headers: this.authHeaders })
    if (!res.ok) throw new Error(`Get image failed: ${res.status} ${await res.text()}`)
    return res.json() as Promise<BildebankImage>
  }

  async updateImage(id: string, options: UpdateImageOptions): Promise<BildebankImage> {
    const res = await fetch(`${this.baseUrl}/api/images/${id}`, {
      method: 'PATCH',
      headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    })
    if (!res.ok) throw new Error(`Update failed: ${res.status} ${await res.text()}`)
    return res.json() as Promise<BildebankImage>
  }

  async replaceImage(id: string, options: ReplaceImageOptions): Promise<BildebankImage> {
    const formData = new FormData()
    formData.append('file', options.file)
    const res = await fetch(`${this.baseUrl}/api/images/${id}/replace`, {
      method: 'PUT',
      headers: this.authHeaders,
      body: formData,
    })
    if (!res.ok) throw new Error(`Replace failed: ${res.status} ${await res.text()}`)
    return res.json() as Promise<BildebankImage>
  }

  async deleteImage(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/images/${id}`, { method: 'DELETE', headers: this.authHeaders })
    if (!res.ok) throw new Error(`Delete failed: ${res.status} ${await res.text()}`)
  }

  async listTags(options: ListTagsOptions = {}): Promise<ListTagsResponse> {
    const params = new URLSearchParams()
    if (options.tenantId) params.set('tenantId', options.tenantId)
    const res = await fetch(`${this.baseUrl}/api/tags?${params}`, { headers: this.authHeaders })
    if (!res.ok) throw new Error(`List tags failed: ${res.status} ${await res.text()}`)
    return res.json() as Promise<ListTagsResponse>
  }
}

export function createBildebankClient(options: BildebankClientOptions): BildebankClient {
  return new BildebankClient(options)
}
