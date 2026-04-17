import { definePlugin } from 'sanity'
import { createBildebankAssetSource } from './assetSource'
import type { SanityBildebankPluginOptions } from './types'

/**
 * Sanity Studio-plugin for å velge bilder fra Bildebank.
 *
 * @example
 * // sanity.config.ts
 * import { bildebankPlugin } from '@fmweb/sanity-bildebank'
 *
 * export default defineConfig({
 *   plugins: [
 *     bildebankPlugin({
 *       apiUrl: 'https://bildebank.filipkronstad.workers.dev',
 *       apiKey: process.env.SANITY_STUDIO_BILDEBANK_API_KEY!,
 *     }),
 *   ],
 * })
 */
export const bildebankPlugin = definePlugin<SanityBildebankPluginOptions>(
  (options) => {
    return {
      name: '@fmweb/sanity-bildebank',
      form: {
        image: {
          assetSources: (prev) => [
            ...prev,
            createBildebankAssetSource(options),
          ],
        },
      },
    }
  },
)
