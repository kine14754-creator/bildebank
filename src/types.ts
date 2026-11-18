export interface Env {
  R2_BUCKET: R2Bucket
  DATABASE_URL: string
  API_SECRET: string
  /**
   * Guards the /admin routes (personal access tokens for /mcp). Separate from
   * API_SECRET, which ships to browsers in the Studio plugin. Without it the
   * admin routes answer 503.
   */
  ADMIN_SECRET?: string
  ENVIRONMENT: string
  /** Grants, tokens, clients and sign-in rate-limit counters for the /mcp OAuth flow. */
  OAUTH_KV?: KVNamespace
  /** Cloudflare Images binding, used to resize previews for the MCP view_image tool. */
  IMAGES?: ImagesBinding
  /** Public origin of this worker. Optional — defaults to the request's origin. */
  PUBLIC_ORIGIN?: string
}
