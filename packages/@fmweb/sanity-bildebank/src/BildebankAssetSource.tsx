import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { AssetFromSource, AssetSourceComponentProps } from 'sanity'
import { createBildebankClient } from '@fmweb/bildebank'
import type { BildebankImage } from '@fmweb/bildebank'
import type { SanityBildebankPluginOptions } from './types'

type Props = AssetSourceComponentProps & SanityBildebankPluginOptions

const PAGE_SIZE = 40

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Asset source-dialogen som vises inne i Sanity Studio når brukeren
 * velger "Bildebank" som bildekilde. Viser et responsivt grid med
 * alle bilder fra bildebanken, med lazy loading og størrelsesindikator.
 */
export function BildebankAssetSource({ onSelect, onClose, apiUrl, apiKey }: Props) {
  const clientRef = useRef(createBildebankClient({ baseUrl: apiUrl, apiSecret: apiKey }))
  const [images, setImages] = useState<BildebankImage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)

  const fetchImages = useCallback(async (currentOffset: number) => {
    setLoading(true)
    setError(null)
    try {
      const res = await clientRef.current.listImages({ limit: PAGE_SIZE, offset: currentOffset })
      setImages((prev) =>
        currentOffset === 0 ? res.data : [...prev, ...res.data],
      )
      setHasMore(res.data.length === PAGE_SIZE)
      setOffset(currentOffset + res.data.length)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke hente bilder fra bildebanken')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchImages(0)
  }, [fetchImages])

  const handleSelect = useCallback(
    (image: BildebankImage) => {
      const asset: AssetFromSource = {
        kind: 'url',
        value: image.url,
        label: image.filename,
        description: image.altText ?? undefined,
        source: {
          id: image.id,
          name: 'bildebank',
          url: image.url,
        },
      }
      onSelect([asset])
    },
    [onSelect],
  )

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.title}>Bildebank</span>
        <button onClick={onClose} style={styles.closeBtn} aria-label="Lukk dialog">
          ✕
        </button>
      </div>

      {/* Feilmelding */}
      {error && <div style={styles.error}>⚠️ {error}</div>}

      {/* Bildegrid */}
      <div style={styles.grid}>
        {images.map((image) => (
          <button
            key={image.id}
            onClick={() => handleSelect(image)}
            style={styles.card}
            title={image.filename}
          >
            <div style={styles.imageWrapper}>
              <img
                src={image.url}
                alt={image.altText ?? image.filename}
                loading="lazy"
                style={styles.image}
              />
            </div>
            <div style={styles.meta}>
              <span style={styles.filename}>{image.filename}</span>
              <span style={styles.size}>{formatBytes(image.size)}</span>
            </div>
          </button>
        ))}
      </div>

      {/* Laster */}
      {loading && <div style={styles.statusMsg}>Laster bilder…</div>}

      {/* Tom tilstand */}
      {!loading && images.length === 0 && !error && (
        <div style={styles.statusMsg}>Ingen bilder funnet i bildebanken.</div>
      )}

      {/* Last inn flere */}
      {!loading && hasMore && (
        <div style={styles.footer}>
          <button onClick={() => void fetchImages(offset)} style={styles.loadMoreBtn}>
            Last inn flere
          </button>
        </div>
      )}
    </div>
  )
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    background: '#fff',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 20px',
    borderBottom: '1px solid #e5e5e5',
    flexShrink: 0,
  },
  title: {
    fontSize: 18,
    fontWeight: 600,
    color: '#1a1a1a',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    fontSize: 20,
    cursor: 'pointer',
    color: '#666',
    padding: '4px 8px',
    lineHeight: 1,
    borderRadius: 4,
  },
  error: {
    margin: '12px 20px',
    padding: '10px 14px',
    background: '#fff5f5',
    border: '1px solid #fca5a5',
    borderRadius: 6,
    color: '#b91c1c',
    fontSize: 13,
    flexShrink: 0,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
    gap: 12,
    padding: 20,
    overflowY: 'auto' as const,
    flex: 1,
  },
  card: {
    background: 'none',
    border: '2px solid #e5e5e5',
    borderRadius: 8,
    cursor: 'pointer',
    padding: 0,
    textAlign: 'left' as const,
    overflow: 'hidden',
    transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
  },
  imageWrapper: {
    width: '100%',
    aspectRatio: '1 / 1',
    overflow: 'hidden',
    background: '#f5f5f5',
  },
  image: {
    width: '100%',
    height: '100%',
    objectFit: 'cover' as const,
    display: 'block',
  },
  meta: {
    padding: '8px 10px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
  },
  filename: {
    fontSize: 12,
    fontWeight: 500,
    color: '#1a1a1a',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    display: 'block',
  },
  size: {
    fontSize: 11,
    color: '#888',
  },
  statusMsg: {
    textAlign: 'center' as const,
    padding: 32,
    color: '#888',
    fontSize: 14,
    flexShrink: 0,
  },
  footer: {
    display: 'flex',
    justifyContent: 'center',
    padding: '16px 20px',
    borderTop: '1px solid #e5e5e5',
    flexShrink: 0,
  },
  loadMoreBtn: {
    padding: '8px 24px',
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 500,
  },
}
