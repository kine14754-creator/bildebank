import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { AssetFromSource, AssetSourceComponentProps } from 'sanity'
import { createBildebankClient } from '@fmweb/bildebank'
import type { BildebankImage, BildebankTag } from '@fmweb/bildebank'
import type { SanityBildebankPluginOptions } from './types'

type Props = AssetSourceComponentProps & SanityBildebankPluginOptions

const PAGE_SIZE = 40
const SEARCH_DEBOUNCE_MS = 300

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function makeAsset(image: BildebankImage): AssetFromSource {
  return {
    kind: 'url',
    value: image.url,
    label: image.filename,
    description: image.altText ?? undefined,
    source: { id: image.id, name: 'bildebank', url: image.url },
  }
}

/**
 * Asset source-dialogen som vises inne i Sanity Studio.
 * - Vis et responsivt bildegrid hentet fra Bildebank-APIet
 * - Fritekst-søk (debounced 300ms) og tag-filter
 * - Last opp bilder via knapp eller dra-og-slipp
 */
export function BildebankAssetSource({ onSelect, onClose, apiUrl, apiKey }: Props) {
  const clientRef = useRef(createBildebankClient({ baseUrl: apiUrl, apiSecret: apiKey }))
  const fileInputRef = useRef<HTMLInputElement>(null)

  // --- Bilder ---
  const [images, setImages] = useState<BildebankImage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)

  // --- Tags ---
  const [availableTags, setAvailableTags] = useState<BildebankTag[]>([])

  // --- Filtre ---
  const [searchInput, setSearchInput] = useState('')
  const [activeSearch, setActiveSearch] = useState('')
  const [selectedTagId, setSelectedTagId] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // --- Opplasting ---
  const [uploading, setUploading] = useState(false)
  const [uploadingName, setUploadingName] = useState('')
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const dragCounterRef = useRef(0)

  // Debounce søk
  const handleSearchChange = (value: string) => {
    setSearchInput(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setActiveSearch(value), SEARCH_DEBOUNCE_MS)
  }

  // Last tags én gang
  useEffect(() => {
    clientRef.current
      .listTags()
      .then((res) => setAvailableTags(res.data))
      .catch(() => {})
  }, [])

  // Hent bilder
  const fetchImages = useCallback(async (currentOffset: number, search: string, tagId: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await clientRef.current.listImages({
        limit: PAGE_SIZE,
        offset: currentOffset,
        search: search || undefined,
        tagId: tagId || undefined,
      })
      setImages((prev) => (currentOffset === 0 ? res.data : [...prev, ...res.data]))
      setHasMore(res.data.length === PAGE_SIZE)
      setOffset(currentOffset + res.data.length)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke hente bilder')
    } finally {
      setLoading(false)
    }
  }, [])

  // Re-hent når filtre endres
  useEffect(() => {
    setImages([])
    setOffset(0)
    void fetchImages(0, activeSearch, selectedTagId)
  }, [activeSearch, selectedTagId, fetchImages])

  // --- Opplastingslogikk ---
  const handleUpload = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        setUploadError(`Ugyldig filtype: ${file.type}`)
        return
      }
      setUploading(true)
      setUploadingName(file.name)
      setUploadError(null)
      try {
        const uploaded = await clientRef.current.uploadImage({ file })
        // Prepend nytt bilde øverst i griden
        setImages((prev) => [uploaded, ...prev])
        // Auto-velg bildet umiddelbart
        onSelect([makeAsset(uploaded)])
      } catch (err) {
        setUploadError(
          err instanceof Error ? err.message : 'Opplasting mislyktes',
        )
      } finally {
        setUploading(false)
        setUploadingName('')
        // Nullstill fil-input slik at samme fil kan lastes opp igjen
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
    },
    [onSelect],
  )

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) void handleUpload(file)
  }

  // --- Drag-and-drop ---
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current += 1
    if (e.dataTransfer.types.includes('Files')) setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current -= 1
    if (dragCounterRef.current === 0) setIsDragging(false)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current = 0
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) void handleUpload(file)
  }

  const handleSelect = useCallback(
    (image: BildebankImage) => onSelect([makeAsset(image)]),
    [onSelect],
  )

  const isFiltered = Boolean(activeSearch || selectedTagId)

  return (
    <div
      style={{
        ...styles.container,
        ...(isDragging ? styles.containerDragging : {}),
      }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag-overlay */}
      {isDragging && (
        <div style={styles.dragOverlay}>
          <div style={styles.dragOverlayInner}>
            <span style={styles.dragOverlayIcon}>&#8613;</span>
            <span style={styles.dragOverlayText}>Slipp for å laste opp</span>
          </div>
        </div>
      )}

      {/* Skjult fil-input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleFileInput}
      />

      {/* Header */}
      <div style={styles.header}>
        <span style={styles.title}>Bildebank</span>
        <button onClick={onClose} style={styles.closeBtn} aria-label="Lukk dialog">
          ✕
        </button>
      </div>

      {/* Toolbar: søk + filter + last opp */}
      <div style={styles.toolbar}>
        <input
          type="search"
          placeholder="Søk på filnavn…"
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          style={styles.searchInput}
          aria-label="Søk på filnavn"
        />
        {availableTags.length > 0 && (
          <select
            value={selectedTagId}
            onChange={(e) => setSelectedTagId(e.target.value)}
            style={styles.tagSelect}
            aria-label="Filtrer på tag"
          >
            <option value="">Alle tags</option>
            {availableTags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          style={uploading ? { ...styles.uploadBtn, ...styles.uploadBtnDisabled } : styles.uploadBtn}
        >
          {uploading ? `Laster opp ${uploadingName}…` : '↑ Last opp'}
        </button>
      </div>

      {/* Feilmeldinger */}
      {error && <div style={styles.error}>⚠️ {error}</div>}
      {uploadError && <div style={styles.error}>⚠️ {uploadError}</div>}

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

      {loading && <div style={styles.statusMsg}>Laster bilder…</div>}
      {!loading && images.length === 0 && !error && (
        <div style={styles.statusMsg}>
          {isFiltered
            ? 'Ingen bilder matcher søket eller filteret.'
            : 'Ingen bilder ennå — last opp det første!'}
        </div>
      )}

      {!loading && hasMore && (
        <div style={styles.footer}>
          <button
            onClick={() => void fetchImages(offset, activeSearch, selectedTagId)}
            style={styles.loadMoreBtn}
          >
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
    position: 'relative' as const,
  },
  containerDragging: {
    outline: '3px dashed #2563eb',
    outlineOffset: -3,
  },
  dragOverlay: {
    position: 'absolute' as const,
    inset: 0,
    background: 'rgba(37,99,235,0.08)',
    zIndex: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none' as const,
  },
  dragOverlayInner: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 8,
    background: '#fff',
    border: '2px dashed #2563eb',
    borderRadius: 12,
    padding: '32px 48px',
  },
  dragOverlayIcon: {
    fontSize: 40,
    color: '#2563eb',
    lineHeight: 1,
  },
  dragOverlayText: {
    fontSize: 16,
    fontWeight: 600,
    color: '#2563eb',
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
  toolbar: {
    display: 'flex',
    gap: 8,
    padding: '12px 20px',
    borderBottom: '1px solid #e5e5e5',
    flexShrink: 0,
    flexWrap: 'wrap' as const,
  },
  searchInput: {
    flex: 1,
    minWidth: 120,
    padding: '8px 12px',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    fontSize: 14,
    outline: 'none',
  },
  tagSelect: {
    padding: '8px 12px',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    fontSize: 14,
    background: '#fff',
    cursor: 'pointer',
    flexShrink: 0,
  },
  uploadBtn: {
    padding: '8px 16px',
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 500,
    flexShrink: 0,
    whiteSpace: 'nowrap' as const,
  },
  uploadBtnDisabled: {
    background: '#93c5fd',
    cursor: 'not-allowed',
  },
  error: {
    margin: '8px 20px 0',
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
