/**
 * Options for the sanity-bildebank plugin.
 */
export interface SanityBildebankPluginOptions {
  /** Base URL til Bildebank-APIet, f.eks. https://bildebank.filipkronstad.workers.dev */
  apiUrl: string
  /** Bearer token for autentisering mot Bildebank-APIet */
  apiKey: string
}
