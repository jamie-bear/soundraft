import { useState, useRef } from 'react'
import { getAssetUrl } from '../lib/api'

interface CoverArtUploadProps {
  currentCoverUrl?: string
  onUpload: (file: File) => Promise<void>
  onDelete?: () => Promise<void>
  size?: 'sm' | 'md' | 'lg'
  disabled?: boolean
}

const sizeClasses = {
  sm: 'h-24 w-24',
  md: 'h-40 w-40',
  lg: 'h-48 w-48',
}

export default function CoverArtUpload({
  currentCoverUrl,
  onUpload,
  onDelete,
  size = 'md',
  disabled = false,
}: CoverArtUploadProps) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const MAX_SIZE = 20 * 1024 * 1024 // 20MB
  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

  const validateFile = (file: File): string | null => {
    if (!ALLOWED_TYPES.includes(file.type)) {
      return 'Invalid file type. Only JPEG, PNG, WebP, and GIF allowed.'
    }
    if (file.size > MAX_SIZE) {
      return 'File size exceeds 20MB limit.'
    }
    return null
  }

  const handleFile = async (file: File) => {
    const validationError = validateFile(file)
    if (validationError) {
      setError(validationError)
      return
    }

    setError('')
    setUploading(true)

    try {
      await onUpload(file)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      handleFile(file)
    }
    // Reset input so same file can be selected again
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)

    if (disabled || uploading) return

    const file = e.dataTransfer.files[0]
    if (file) {
      handleFile(file)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    if (!disabled && !uploading) {
      setDragOver(true)
    }
  }

  const handleDragLeave = () => {
    setDragOver(false)
  }

  const handleDelete = async () => {
    if (!onDelete || !currentCoverUrl) return

    setUploading(true)
    setError('')

    try {
      await onDelete()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-2">
      <div
        className={`relative ${sizeClasses[size]} shrink-0 rounded-xl bg-surface-800 overflow-hidden group ${
          dragOver ? 'ring-2 ring-primary-500' : ''
        } ${disabled || uploading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => !disabled && !uploading && fileInputRef.current?.click()}
      >
        {/* Current cover or placeholder */}
        {currentCoverUrl ? (
          <img
            src={getAssetUrl(currentCoverUrl)}
            alt="Cover art"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center text-surface-500">
            <svg className="h-10 w-10 mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <span className="text-xs">Add Cover</span>
          </div>
        )}

        {/* Uploading overlay */}
        {uploading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
          </div>
        )}

        {/* Hover overlay */}
        {!uploading && !disabled && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity">
            <div className="flex flex-col items-center text-white">
              <svg className="h-8 w-8 mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              <span className="text-xs font-medium">
                {currentCoverUrl ? 'Change' : 'Upload'}
              </span>
            </div>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          onChange={handleFileChange}
          className="hidden"
          disabled={disabled || uploading}
        />
      </div>

      {/* File info */}
      <p className="text-xs text-surface-500 text-center">
        Max 20MB. Square images work best.
      </p>

      {/* Delete button */}
      {currentCoverUrl && onDelete && !disabled && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            handleDelete()
          }}
          disabled={uploading}
          className="w-full rounded-lg bg-surface-800 px-2 py-1.5 text-xs font-medium text-surface-400 hover:bg-surface-700 hover:text-red-400 transition-colors disabled:opacity-50"
        >
          Remove Cover
        </button>
      )}

      {/* Error message */}
      {error && (
        <p className="text-xs text-red-400 text-center">{error}</p>
      )}
    </div>
  )
}
