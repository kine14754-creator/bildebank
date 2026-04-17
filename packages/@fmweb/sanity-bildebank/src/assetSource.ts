import { createElement } from 'react'
import type { ComponentType } from 'react'
import type { AssetSource, AssetSourceComponentProps } from 'sanity'
import { BildebankAssetSource } from './BildebankAssetSource'
import type { SanityBildebankPluginOptions } from './types'

/**
 * Bygger et Sanity AssetSource-objekt med plugin-options bakt inn i
 * React-komponenten, slik at den kan registreres via form.image.assetSources.
 */
export function createBildebankAssetSource(
  options: SanityBildebankPluginOptions,
): AssetSource {
  const Component: ComponentType<AssetSourceComponentProps> = (props) =>
    createElement(BildebankAssetSource, { ...props, ...options })
  Component.displayName = 'BildebankAssetSourceWrapper'

  return {
    name: 'bildebank',
    title: 'Bildebank',
    component: Component,
  }
}
