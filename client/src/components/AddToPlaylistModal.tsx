import { useState, useEffect } from 'react'
import { playlistsApi, PlaylistWithTrackInfo } from '../lib/api'

interface AddToPlaylistModalProps {
  trackId: string
  trackTitle: string
  isOpen: boolean
  onClose: () => void
}

export default function AddToPlaylistModal({
  trackId,
  trackTitle,
  isOpen,
  onClose,
}: AddToPlaylistModalProps) {
  const [playlists, setPlaylists] = useState<PlaylistWithTrackInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [newPlaylistTitle, setNewPlaylistTitle] = useState('')
  const [showNewPlaylist, setShowNewPlaylist] = useState(false)

  useEffect(() => {
    if (isOpen) {
      loadPlaylists()
    }
  }, [isOpen, trackId])

  const loadPlaylists = async () => {
    setLoading(true)
    setError('')
    try {
      const { playlists: data } = await playlistsApi.list(trackId)
      setPlaylists(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load playlists')
    } finally {
      setLoading(false)
    }
  }

  const handleTogglePlaylist = async (playlist: PlaylistWithTrackInfo) => {
    setSaving(playlist.id)
    setError('')
    
    try {
      if (playlist.contains_track) {
        // Remove from playlist
        await playlistsApi.removeTrack(playlist.id, trackId)
        setPlaylists(playlists.map(p => 
          p.id === playlist.id 
            ? { ...p, contains_track: false, track_count: Number(p.track_count) - 1 } 
            : p
        ))
      } else {
        // Add to playlist
        await playlistsApi.addTrack(playlist.id, trackId)
        setPlaylists(playlists.map(p => 
          p.id === playlist.id 
            ? { ...p, contains_track: true, track_count: Number(p.track_count) + 1 } 
            : p
        ))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update playlist')
    } finally {
      setSaving(null)
    }
  }

  const handleCreatePlaylist = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newPlaylistTitle.trim()) return

    setSaving('new')
    setError('')

    try {
      // Create new playlist
      const { playlist } = await playlistsApi.create({ title: newPlaylistTitle.trim() })
      
      // Add track to it
      await playlistsApi.addTrack(playlist.id, trackId)
      
      // Update list
      setPlaylists([{ ...playlist, contains_track: true, track_count: 1 }, ...playlists])
      setNewPlaylistTitle('')
      setShowNewPlaylist(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create playlist')
    } finally {
      setSaving(null)
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
            <h2 className="text-lg font-semibold text-white">Add to Playlist</h2>
            <p className="text-sm text-surface-400 truncate max-w-xs">{trackTitle}</p>
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
        <div className="max-h-96 overflow-y-auto p-4">
          {error && (
            <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
              {error}
            </div>
          )}

          {/* Create new playlist */}
          {showNewPlaylist ? (
            <form onSubmit={handleCreatePlaylist} className="mb-4 flex gap-2">
              <input
                type="text"
                value={newPlaylistTitle}
                onChange={(e) => setNewPlaylistTitle(e.target.value)}
                placeholder="New playlist name..."
                className="flex-1 rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-white placeholder-surface-500 focus:border-primary-500 focus:outline-none"
                autoFocus
              />
              <button
                type="submit"
                disabled={!newPlaylistTitle.trim() || saving === 'new'}
                className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50 transition-colors"
              >
                {saving === 'new' ? '...' : 'Create'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowNewPlaylist(false)
                  setNewPlaylistTitle('')
                }}
                className="rounded-lg bg-surface-800 px-3 py-2 text-sm text-surface-400 hover:bg-surface-700 transition-colors"
              >
                Cancel
              </button>
            </form>
          ) : (
            <button
              onClick={() => setShowNewPlaylist(true)}
              className="mb-4 flex w-full items-center gap-2 rounded-lg border border-dashed border-surface-700 p-3 text-sm text-surface-400 hover:border-surface-600 hover:text-surface-300 transition-colors"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Create New Playlist
            </button>
          )}

          {/* Playlists list */}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
            </div>
          ) : playlists.length === 0 ? (
            <p className="py-8 text-center text-surface-500">No playlists yet</p>
          ) : (
            <div className="space-y-2">
              {playlists.map((playlist) => (
                <button
                  key={playlist.id}
                  onClick={() => handleTogglePlaylist(playlist)}
                  disabled={saving === playlist.id}
                  className="flex w-full items-center gap-3 rounded-lg border border-surface-800 bg-surface-800/50 p-3 text-left hover:bg-surface-800 transition-colors disabled:opacity-50"
                >
                  {/* Checkbox */}
                  <div className={`flex h-5 w-5 items-center justify-center rounded border ${
                    playlist.contains_track 
                      ? 'border-primary-500 bg-primary-500' 
                      : 'border-surface-600'
                  }`}>
                    {saving === playlist.id ? (
                      <div className="h-3 w-3 animate-spin rounded-full border border-white border-t-transparent" />
                    ) : playlist.contains_track ? (
                      <svg className="h-3 w-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    ) : null}
                  </div>

                  {/* Playlist info */}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-white">{playlist.title}</p>
                    <p className="text-xs text-surface-500">
                      {playlist.type} · {playlist.track_count} tracks
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
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
