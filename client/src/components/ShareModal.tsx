import { useState, useEffect } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { tracksApi, playlistsApi, Track, Playlist } from '../lib/api'

type EntityType = 'track' | 'playlist'

interface ShareModalProps {
  entityType: EntityType
  entity: Track | Playlist
  isOpen: boolean
  onClose: () => void
  onUpdate: (updated: Track | Playlist) => void
}

export default function ShareModal({
  entityType,
  entity,
  isOpen,
  onClose,
  onUpdate,
}: ShareModalProps) {
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  
  // Local state for settings
  const [isPublic, setIsPublic] = useState(false)
  const [commentAccess, setCommentAccess] = useState<'PRIVATE' | 'PUBLIC_VIEW' | 'PUBLIC_FULL'>('PRIVATE')

  // Initialize local state from entity
  useEffect(() => {
    if (isOpen) {
      if (entityType === 'track') {
        const track = entity as Track
        setIsPublic(track.release_status === 'PUBLIC')
        setCommentAccess(track.comment_access)
      } else {
        const playlist = entity as Playlist
        setIsPublic(playlist.is_public)
        setCommentAccess(playlist.comment_access)
      }
    }
  }, [isOpen, entity, entityType])

  const shareToken = entity.share_token
  const baseUrl = window.location.origin
  const shareUrl = entityType === 'track' 
    ? `${baseUrl}/share/track/${shareToken}`
    : `${baseUrl}/share/playlist/${shareToken}`

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      setError('Failed to copy link')
    }
  }

  const handleRegenerateLink = async () => {
    setLoading(true)
    setError('')
    
    try {
      if (entityType === 'track') {
        const { shareToken: newToken } = await tracksApi.share(entity.id, isPublic)
        onUpdate({ ...entity, share_token: newToken } as Track)
      } else {
        const { shareToken: newToken } = await playlistsApi.share(entity.id, isPublic)
        onUpdate({ ...entity, share_token: newToken } as Playlist)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to regenerate link')
    } finally {
      setLoading(false)
    }
  }

  const handleVisibilityChange = async (newIsPublic: boolean) => {
    setLoading(true)
    setError('')
    
    try {
      if (entityType === 'track') {
        const { track } = await tracksApi.update(entity.id, { 
          release_status: newIsPublic ? 'PUBLIC' : 'PRIVATE' 
        })
        setIsPublic(newIsPublic)
        onUpdate(track)
      } else {
        const { playlist } = await playlistsApi.update(entity.id, { 
          is_public: newIsPublic 
        })
        setIsPublic(newIsPublic)
        onUpdate(playlist)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update visibility')
    } finally {
      setLoading(false)
    }
  }

  const handleCommentAccessChange = async (newAccess: typeof commentAccess) => {
    setLoading(true)
    setError('')
    
    try {
      if (entityType === 'track') {
        const { track } = await tracksApi.update(entity.id, { comment_access: newAccess })
        setCommentAccess(newAccess)
        onUpdate(track)
      } else {
        const { playlist } = await playlistsApi.update(entity.id, { comment_access: newAccess })
        setCommentAccess(newAccess)
        onUpdate(playlist)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update comment access')
    } finally {
      setLoading(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/70"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative w-full max-w-md rounded-xl border border-surface-800 bg-surface-900 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-surface-800 p-4">
          <div>
            <h2 className="text-lg font-semibold text-white">
              Share {entityType === 'track' ? 'Track' : 'Playlist'}
            </h2>
            <p className="text-sm text-surface-400 truncate max-w-xs">
              {entityType === 'track' ? (entity as Track).title : (entity as Playlist).title}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-surface-400 hover:bg-surface-800 hover:text-white transition-colors"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-6">
          {error && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
              {error}
            </div>
          )}

          {/* Share Link */}
          <div>
            <label className="mb-2 block text-sm font-medium text-surface-300">Share Link</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={shareUrl}
                readOnly
                className="flex-1 rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-white"
              />
              <button
                onClick={handleCopyLink}
                className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 transition-colors"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          {/* QR Code */}
          <div className="flex flex-col items-center">
            <div className="rounded-lg bg-white p-4">
              <QRCodeSVG 
                value={shareUrl} 
                size={150}
                level="M"
              />
            </div>
            <p className="mt-2 text-xs text-surface-500">Scan to open</p>
          </div>

          {/* Visibility Setting */}
          <div>
            <label className="mb-2 block text-sm font-medium text-surface-300">Visibility</label>
            <div className="flex gap-2">
              <button
                onClick={() => handleVisibilityChange(false)}
                disabled={loading}
                className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  !isPublic
                    ? 'bg-primary-600 text-white'
                    : 'bg-surface-800 text-surface-400 hover:bg-surface-700'
                }`}
              >
                Private
              </button>
              <button
                onClick={() => handleVisibilityChange(true)}
                disabled={loading}
                className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isPublic
                    ? 'bg-primary-600 text-white'
                    : 'bg-surface-800 text-surface-400 hover:bg-surface-700'
                }`}
              >
                Public
              </button>
            </div>
            <p className="mt-1 text-xs text-surface-500">
              {isPublic 
                ? 'Anyone with the link can access' 
                : 'Only people with the share link can access'}
            </p>
          </div>

          {/* Comment Access */}
          <div>
            <label className="mb-2 block text-sm font-medium text-surface-300">Comment Access</label>
            <select
              value={commentAccess}
              onChange={(e) => handleCommentAccessChange(e.target.value as typeof commentAccess)}
              disabled={loading}
              className="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-white focus:border-primary-500 focus:outline-none"
            >
              <option value="PRIVATE">Private - Only you can view and comment</option>
              <option value="PUBLIC_VIEW">View Only - Others can view comments</option>
              <option value="PUBLIC_FULL">Full Access - Others can add comments</option>
            </select>
          </div>

          {/* Regenerate Link */}
          <button
            onClick={handleRegenerateLink}
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-400 hover:bg-surface-700 hover:text-white transition-colors disabled:opacity-50"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {loading ? 'Regenerating...' : 'Regenerate Link'}
          </button>
        </div>

        {/* Footer */}
        <div className="border-t border-surface-800 p-4">
          <button
            onClick={onClose}
            className="w-full rounded-lg bg-surface-800 py-2 text-sm font-medium text-white hover:bg-surface-700 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
