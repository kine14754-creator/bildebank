import { createElement } from 'react'
import type { AssetSource } from 'sanity'
import { BildebankAssetSource } from './BildebankAssetSource'
import type { SanityBildebankPluginOptions } from './types'

/**
 * Bygger et Sanity AssetSource-objekt med options bakt inn i komponenten.
 */
export function createBildebankAssetSource(
  options: SanityBildebankPluginOptions,
): AssetSource {
  const Component = (props: Parameters<typeof BildebankAssetSource>[0]) =>
    createElement(BildebankAssetSource, { ...props, ...options })
  Component.displayName = 'BildebankAssetSourceWrapper'

  return {
    name: 'bildebank',
    title: 'Bildebank',
    component: Component,
  }
}
