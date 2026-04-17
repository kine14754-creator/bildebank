import React from 'react'
import type { AssetSourceComponentProps } from 'sanity'
import type { SanityBildebankPluginOptions } from './types'

type Props = AssetSourceComponentProps & SanityBildebankPluginOptions

/**
 * React-komponent som rendres inne i Sanity Studio når brukeren
 * klikker "Velg fra Bildebank". Full UI implementeres i BL-13.
 */
export function BildebankAssetSource({ onClose, apiUrl, apiKey }: Props) {
  // apiUrl og apiKey er tilgjengelig her for bruk i BL-13 (listImages, upload)
  void apiUrl
  void apiKey

  return (
    <div style={{ padding: 24 }}>
      <p>Bildebank bildevelger — kommer i neste steg.</p>
      <button onClick={onClose}>Lukk</button>
    </div>
  )
}
