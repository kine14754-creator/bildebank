import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Only exists inside workerd; the OAuth library imports it.
      'cloudflare:workers': fileURLToPath(
        new URL('./test/cloudflare-workers-stub.ts', import.meta.url)
      ),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    server: {
      deps: {
        // Run through Vite (not Node's loader) so the alias above applies to it.
        inline: ['@cloudflare/workers-oauth-provider'],
      },
    },
  },
})
