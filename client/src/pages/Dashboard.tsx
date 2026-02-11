import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { tracksApi, playlistsApi, Track, Playlist, getAssetUrl } from '../lib/api'
import { usePlayerStore } from '../stores/playerStore'
import AddToPlaylistModal from '../components/AddToPlaylistModal'

const statusColors: Record<string, string> = {
  POC: 'bg-purple-500/20 text-purple-400',
  DRAFT: 'bg-orange-500/20 text-orange-400',
  WIP: 'bg-yellow-500/20 text-yellow-400',
  FINAL: 'bg-green-500/20 text-green-400',
}

export default function Dashboard() {
  const [tracks, setTracks] = useState<Track[]>([])
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [showCreateTrack, setShowCreateTrack] = useState(false)
  const [showCreatePlaylist, setShowCreatePlaylist] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [addToPlaylistTrack, setAddToPlaylistTrack] = useState<Track | null>(null)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  
  const playTrack = usePlayerStore((state) => state.playTrack)
  const currentTrack = usePlayerStore((state) => state.currentTrack)
  const isPlaying = usePlayerStore((state) => state.isPlaying)
  const togglePlay = usePlayerStore((state) => state.togglePlay)

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      setLoading(true)
      const [tracksRes, playlistsRes] = await Promise.all([
        tracksApi.list(),
        playlistsApi.list(),
      ])
      setTracks(tracksRes.tracks)
      setPlaylists(playlistsRes.playlists)
    } catch (err) {
      console.error('Failed to load data:', err)
    } finally {
      setLoading(false)
    }
  }

  const handlePlay = (track: Track, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    
    if (!track.current_version_id) return

    const isCurrentTrack = currentTrack?.id === track.id

    if (isCurrentTrack) {
      togglePlay()
    } else {
      playTrack({
        id: track.id,
        title: track.title,
        versionId: track.current_version_id,
        version: track.current_version_number || 1,
        duration: track.duration_seconds || 0,
      })
    }
  }

  const handleCreateTrack = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newTitle.trim()) return

    try {
      setCreating(true)
      await tracksApi.create({ title: newTitle })
      setNewTitle('')
      setShowCreateTrack(false)
      loadData()
    } catch (err) {
      console.error('Failed to create track:', err)
    } finally {
      setCreating(false)
    }
  }

  const handleCreatePlaylist = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newTitle.trim()) return

    try {
      setCreating(true)
      await playlistsApi.create({ title: newTitle })
      setNewTitle('')
      setShowCreatePlaylist(false)
      loadData()
    } catch (err) {
      console.error('Failed to create playlist:', err)
    } finally {
      setCreating(false)
    }
  }

  // Filter tracks and playlists by search query
  const filteredTracks = tracks.filter(track =>
    searchQuery === '' ||
    track.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (track.artist && track.artist.toLowerCase().includes(searchQuery.toLowerCase()))
  )

  const filteredPlaylists = playlists.filter(playlist =>
    searchQuery === '' ||
    playlist.title.toLowerCase().includes(searchQuery.toLowerCase())
  )

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Dashboard</h1>
            <p className="text-surface-400">Manage your tracks and playlists</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setShowCreatePlaylist(true)}
              className="flex items-center gap-2 rounded-lg bg-surface-800 px-4 py-2 text-sm font-medium text-white hover:bg-surface-700 transition-colors"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              New Playlist
            </button>
            <button
              onClick={() => setShowCreateTrack(true)}
              className="flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 transition-colors"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              New Track
            </button>
          </div>
        </div>

        {/* Search bar */}
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search tracks and playlists..."
          className="w-full rounded-lg border border-surface-700 bg-surface-800 px-4 py-2 text-white placeholder-surface-500 focus:border-primary-500 focus:outline-none"
        />
      </div>

      {/* Loading state */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
        </div>
      ) : (
        <>
          {/* Tracks Section */}
          <section className="mb-12">
            <h2 className="mb-4 text-lg font-semibold text-white">Recent Tracks</h2>

            {filteredTracks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-surface-700 bg-surface-900/50 p-8 text-center">
                <p className="mb-4 text-surface-400">
                  {searchQuery ? 'No tracks found matching your search' : 'No tracks yet'}
                </p>
                {!searchQuery && (
                  <button
                    onClick={() => setShowCreateTrack(true)}
                    className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 transition-colors"
                  >
                    Create your first track
                  </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {filteredTracks.map((track) => {
                  const isCurrentlyPlaying = currentTrack?.id === track.id && isPlaying
                  
                  return (
                    <div
                      key={track.id}
                      className="group relative rounded-xl border border-surface-800 bg-surface-900 p-4 hover:border-surface-700 transition-colors"
                    >
                      {/* Menu button */}
                      <div className="absolute top-2 right-2 z-10">
                        <button
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            setOpenMenuId(openMenuId === track.id ? null : track.id)
                          }}
                          className="rounded-lg p-1.5 text-surface-400 hover:bg-surface-800 hover:text-white opacity-0 group-hover:opacity-100 transition-all"
                        >
                          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                          </svg>
                        </button>
                        
                        {/* Dropdown menu */}
                        {openMenuId === track.id && (
                          <div className="absolute right-0 top-full mt-1 w-48 rounded-lg border border-surface-700 bg-surface-800 py-1 shadow-xl">
                            <button
                              onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                setAddToPlaylistTrack(track)
                                setOpenMenuId(null)
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-surface-300 hover:bg-surface-700 hover:text-white"
                            >
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                              </svg>
                              Add to Playlist
                            </button>
                            <Link
                              to={`/tracks/${track.id}`}
                              onClick={() => setOpenMenuId(null)}
                              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-surface-300 hover:bg-surface-700 hover:text-white"
                            >
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                              </svg>
                              View Details
                            </Link>
                            <hr className="my-1 border-surface-700" />
                            <button
                              onClick={async (e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                const confirmed = window.confirm(`Are you sure you want to delete "${track.title}"? This action cannot be undone.`)
                                if (confirmed) {
                                  try {
                                    await tracksApi.delete(track.id)
                                    setOpenMenuId(null)
                                    loadData()
                                  } catch (err) {
                                    console.error('Failed to delete track:', err)
                                  }
                                }
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-red-600/10 hover:text-red-300"
                            >
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                              Delete Track
                            </button>
                          </div>
                        )}
                      </div>

                      <Link to={`/tracks/${track.id}`}>
                        {/* Cover art */}
                        <div className="relative mb-4 aspect-square rounded-lg bg-surface-800 overflow-hidden">
                          {track.cover_art_path ? (
                            <img 
                              src={getAssetUrl(track.cover_art_path)} 
                              alt="" 
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="absolute inset-0 flex items-center justify-center">
                              <svg className="h-12 w-12 text-surface-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                              </svg>
                            </div>
                          )}
                          
                          {/* Play button overlay */}
                          {track.current_version_id && (
                            <button
                              onClick={(e) => handlePlay(track, e)}
                              className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-600 text-white">
                                {isCurrentlyPlaying ? (
                                  <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                                  </svg>
                                ) : (
                                  <svg className="h-6 w-6 ml-1" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M8 5v14l11-7z" />
                                  </svg>
                                )}
                              </div>
                            </button>
                          )}
                        </div>

                        {/* Track info */}
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <h3 className="truncate font-medium text-white">{track.title}</h3>
                            <p className="text-sm text-surface-400">
                              {track.current_version_number ? `v${track.current_version_number}` : 'No versions'}
                            </p>
                          </div>
                          <span className={`shrink-0 rounded-full px-2 py-1 text-xs font-medium ${statusColors[track.status] || 'bg-surface-700 text-surface-300'}`}>
                            {track.status}
                          </span>
                        </div>
                      </Link>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {/* Playlists Section */}
          <section>
            <h2 className="mb-4 text-lg font-semibold text-white">Playlists</h2>

            {filteredPlaylists.length === 0 ? (
              <div className="rounded-xl border border-dashed border-surface-700 bg-surface-900/50 p-8 text-center">
                <p className="mb-4 text-surface-400">
                  {searchQuery ? 'No playlists found matching your search' : 'No playlists yet'}
                </p>
                {!searchQuery && (
                  <button
                    onClick={() => setShowCreatePlaylist(true)}
                    className="inline-flex items-center gap-2 rounded-lg bg-surface-800 px-4 py-2 text-sm font-medium text-white hover:bg-surface-700 transition-colors"
                  >
                    Create your first playlist
                  </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {filteredPlaylists.map((playlist) => (
                  <div
                    key={playlist.id}
                    className="group relative rounded-xl border border-surface-800 bg-surface-900 p-4 hover:border-surface-700 transition-colors"
                  >
                    {/* Menu button */}
                    <div className="absolute top-2 right-2 z-10">
                      <button
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setOpenMenuId(openMenuId === playlist.id ? null : playlist.id)
                        }}
                        className="rounded-lg p-1.5 text-surface-400 hover:bg-surface-800 hover:text-white opacity-0 group-hover:opacity-100 transition-all"
                      >
                        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                        </svg>
                      </button>
                      
                      {/* Dropdown menu */}
                      {openMenuId === playlist.id && (
                        <div className="absolute right-0 top-full mt-1 w-48 rounded-lg border border-surface-700 bg-surface-800 py-1 shadow-xl">
                          <Link
                            to={`/playlists/${playlist.id}`}
                            onClick={() => setOpenMenuId(null)}
                            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-surface-300 hover:bg-surface-700 hover:text-white"
                          >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                            </svg>
                            View Details
                          </Link>
                          <hr className="my-1 border-surface-700" />
                          <button
                            onClick={async (e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              const confirmed = window.confirm(`Are you sure you want to delete "${playlist.title}"? This action cannot be undone.`)
                              if (confirmed) {
                                try {
                                  await playlistsApi.delete(playlist.id)
                                  setOpenMenuId(null)
                                  loadData()
                                } catch (err) {
                                  console.error('Failed to delete playlist:', err)
                                }
                              }
                            }}
                            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-red-600/10 hover:text-red-300"
                          >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                            Delete Playlist
                          </button>
                        </div>
                      )}
                    </div>

                    <Link to={`/playlists/${playlist.id}`}>
                      <div className="mb-4 aspect-square rounded-lg bg-surface-800">
                        {playlist.cover_art_path ? (
                          <img 
                            src={getAssetUrl(playlist.cover_art_path)} 
                            alt="" 
                            className="h-full w-full rounded-lg object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center">
                            <svg className="h-12 w-12 text-surface-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                            </svg>
                          </div>
                        )}
                      </div>
                      <h3 className="truncate font-medium text-white">{playlist.title}</h3>
                      <p className="text-sm text-surface-400">
                        {playlist.track_count || 0} tracks - {playlist.type}
                      </p>
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {/* Create Track Modal */}
      {showCreateTrack && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-xl border border-surface-800 bg-surface-900 p-6">
            <h2 className="mb-4 text-lg font-semibold text-white">Create New Track</h2>
            <form onSubmit={handleCreateTrack}>
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Track title"
                className="mb-4 w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-white placeholder-surface-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowCreateTrack(false)}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-surface-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating || !newTitle.trim()}
                  className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50 transition-colors"
                >
                  {creating ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create Playlist Modal */}
      {showCreatePlaylist && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-xl border border-surface-800 bg-surface-900 p-6">
            <h2 className="mb-4 text-lg font-semibold text-white">Create New Playlist</h2>
            <form onSubmit={handleCreatePlaylist}>
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Playlist title"
                className="mb-4 w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-white placeholder-surface-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowCreatePlaylist(false)}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-surface-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating || !newTitle.trim()}
                  className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50 transition-colors"
                >
                  {creating ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add to Playlist Modal */}
      {addToPlaylistTrack && (
        <AddToPlaylistModal
          trackId={addToPlaylistTrack.id}
          trackTitle={addToPlaylistTrack.title}
          isOpen={true}
          onClose={() => setAddToPlaylistTrack(null)}
        />
      )}

      {/* Click outside to close menu */}
      {openMenuId && (
        <div 
          className="fixed inset-0 z-0" 
          onClick={() => setOpenMenuId(null)}
        />
      )}
    </div>
  )
}
