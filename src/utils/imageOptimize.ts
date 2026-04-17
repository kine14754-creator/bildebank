// @jsquash WASM-pakker krever spesiell bundler-konfigurasjon for Cloudflare Workers.
// Deaktivert midlertidig slik at wrangler-bygg ikke feiler.
// TODO: re-implementer med korrekt WASM-initialisering (wrangler [[rules]] + init())

export function canConvertToWebP(_mimeType: string): boolean {
  return false
}

/** Deriverer WebP-nøkkelen fra original R2-nøkkel ved å bytte ut filendelse */
export function toWebPKey(key: string): string {
  return key.replace(/\.[^./]+$/, '.webp')
}

/** Stub — kaster alltid. Brukes ikke så lenge canConvertToWebP() returnerer false. */
export async function convertToWebP(_buffer: ArrayBuffer, mimeType: string): Promise<ArrayBuffer> {
  throw new Error(`WebP conversion not configured: ${mimeType}`)
}
