import { useState, useEffect } from 'react'
import { tracksApi, playlistsApi, Track } from '../lib/api'

interface AddTrackModalProps {
  playlistId: string
  playlistTitle: string
  existingTrackIds: string[]
  isOpen: boolean
  onClose: () => void
  onTracksAdded: () => void
}

export default function AddTrackModal({
  playlistId,
  playlistTitle,
  existingTrackIds,
  isOpen,
  onClose,
  onTracksAdded,
}: AddTrackModalProps) {
  const [tracks, setTracks] = useState<Track[]>([])
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [showNewTrack, setShowNewTrack] = useState(false)
  const [newTrackTitle, setNewTrackTitle] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (isOpen) {
      loadTracks()
      setSelectedTrackIds(new Set())
      setShowNewTrack(false)
      setNewTrackTitle('')
    }
  }, [isOpen])

  const loadTracks = async () => {
    setLoading(true)
    setError('')
    try {
      const { tracks: data } = await tracksApi.list()
      // Filter out tracks already in the playlist
      const availableTracks = data.filter(t => !existingTrackIds.includes(t.id))
      setTracks(availableTracks)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tracks')
    } finally {
      setLoading(false)
    }
  }

  const toggleTrack = (trackId: string) => {
    const newSelected = new Set(selectedTrackIds)
    if (newSelected.has(trackId)) {
      newSelected.delete(trackId)
    } else {
      newSelected.add(trackId)
    }
    setSelectedTrackIds(newSelected)
  }

  const handleAddTracks = async () => {
    if (selectedTrackIds.size === 0) return

    setSaving(true)
    setError('')

    try {
      // Add tracks one by one
      for (const trackId of selectedTrackIds) {
        await playlistsApi.addTrack(playlistId, trackId)
      }
      onTracksAdded()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add tracks')
    } finally {
      setSaving(false)
    }
  }

  const handleCreateTrack = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newTrackTitle.trim()) return

    setCreating(true)
    setError('')

    try {
      const { track } = await tracksApi.create({ title: newTrackTitle.trim() })
      await playlistsApi.addTrack(playlistId, track.id)
      onTracksAdded()
      setNewTrackTitle('')
      setShowNewTrack(false)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create track')
    } finally {
      setCreating(false)
    }
  }

  // Filter tracks by search
  const filteredTracks = search.trim()
    ? tracks.filter(t => t.title.toLowerCase().includes(search.toLowerCase()))
    : tracks

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
            <h2 className="text-lg font-semibold text-white">Add Tracks</h2>
            <p className="text-sm text-surface-400 truncate max-w-xs">to {playlistTitle}</p>
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

        {/* Search */}
        <div className="border-b border-surface-800 p-4">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tracks..."
            className="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-white placeholder-surface-500 focus:border-primary-500 focus:outline-none"
          />
        </div>

        {/* Content */}
        <div className="max-h-80 overflow-y-auto p-4">
          {error && (
            <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
              {error}
            </div>
          )}

          {/* Create new track option */}
          {showNewTrack ? (
            <form onSubmit={handleCreateTrack} className="mb-4 flex gap-2">
              <input
                type="text"
                value={newTrackTitle}
                onChange={(e) => setNewTrackTitle(e.target.value)}
                placeholder="New track title..."
                className="flex-1 rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-white placeholder-surface-500 focus:border-primary-500 focus:outline-none"
                autoFocus
              />
              <button
                type="submit"
                disabled={!newTrackTitle.trim() || creating}
                className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50 transition-colors"
              >
                {creating ? '...' : 'Create'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowNewTrack(false)
                  setNewTrackTitle('')
                }}
                className="rounded-lg bg-surface-800 px-3 py-2 text-sm text-surface-400 hover:bg-surface-700 transition-colors"
              >
                Cancel
              </button>
            </form>
          ) : (
            <button
              onClick={() => setShowNewTrack(true)}
              className="mb-4 flex w-full items-center gap-2 rounded-lg border border-dashed border-surface-700 p-3 text-sm text-surface-400 hover:border-surface-600 hover:text-surface-300 transition-colors"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Create New Track
            </button>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
            </div>
          ) : filteredTracks.length === 0 ? (
            <p className="py-8 text-center text-surface-500">
              {tracks.length === 0 
                ? 'No tracks available to add' 
                : 'No tracks match your search'}
            </p>
          ) : (
            <div className="space-y-2">
              {filteredTracks.map((track) => (
                <button
                  key={track.id}
                  onClick={() => toggleTrack(track.id)}
                  className="flex w-full items-center gap-3 rounded-lg border border-surface-800 bg-surface-800/50 p-3 text-left hover:bg-surface-800 transition-colors"
                >
                  {/* Checkbox */}
                  <div className={`flex h-5 w-5 items-center justify-center rounded border ${
                    selectedTrackIds.has(track.id) 
                      ? 'border-primary-500 bg-primary-500' 
                      : 'border-surface-600'
                  }`}>
                    {selectedTrackIds.has(track.id) && (
                      <svg className="h-3 w-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    )}
                  </div>

                  {/* Track info */}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-white">{track.title}</p>
                    <p className="text-xs text-surface-500">
                      {track.status} · {track.type}
                      {track.duration_seconds && ` · ${Math.floor(track.duration_seconds / 60)}:${(track.duration_seconds % 60).toString().padStart(2, '0')}`}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-2 border-t border-surface-800 p-4">
          <button
            onClick={onClose}
            className="flex-1 rounded-lg bg-surface-800 py-2 text-sm font-medium text-white hover:bg-surface-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleAddTracks}
            disabled={selectedTrackIds.size === 0 || saving}
            className="flex-1 rounded-lg bg-primary-600 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50 transition-colors"
          >
            {saving 
              ? 'Adding...' 
              : `Add ${selectedTrackIds.size > 0 ? `(${selectedTrackIds.size})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}
