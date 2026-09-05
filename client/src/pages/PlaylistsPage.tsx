import PageControls from '../components/PageControls'
import { appendUnique } from '../lib/pages'
import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { playlistsApi, Playlist, getAssetUrl } from '../lib/api'

export default function PlaylistsPage() {
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [listError, setListError] = useState('')
  const [sort, setSort] = useState('newest')
  const [filter, setFilter] = useState('')
  const generation = useRef(0)
  const [showCreatePlaylist, setShowCreatePlaylist] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)

  useEffect(() => {
    generation.current++
    setNextCursor(null)
    const timer = setTimeout(() => { void loadPlaylists() }, 200)
    return () => { clearTimeout(timer); generation.current++ }
  }, [searchQuery, sort, filter])

  const loadPlaylists = async (cursor?: string | null) => {
    const requestGeneration = generation.current
    try {
      if (!cursor) { setLoading(true); setNextCursor(null) }
      setListError('')
      const res = await playlistsApi.list(undefined, { cursor, search: searchQuery, sort, filter })
      if (requestGeneration !== generation.current) return
      setPlaylists(previous => cursor ? appendUnique(previous, res.playlists) : res.playlists)
      setNextCursor(res.next_cursor)
    } catch (err) {
      if (requestGeneration === generation.current) setListError(err instanceof Error ? err.message : 'Could not load playlists')
    } finally {
      if (requestGeneration === generation.current) setLoading(false)
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
      loadPlaylists()
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Could not create playlist')
    } finally {
      setCreating(false)
    }
  }

  const filteredPlaylists = playlists

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Playlists</h1>
            <p className="text-surface-400">Manage your playlists</p>
          </div>
          <button
            onClick={() => setShowCreatePlaylist(true)}
            className="flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 transition-colors"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Playlist
          </button>
        </div>

        {/* Search bar */}
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Search playlists"
          placeholder="Search playlists by title..."
          className="w-full rounded-lg border border-surface-700 bg-surface-800 px-4 py-2 text-white placeholder-surface-500 focus:border-primary-500 focus:outline-none"
        />
      </div>

      <div className="mb-4 flex gap-3">
        <select aria-label="Sort playlists" value={sort} onChange={e => setSort(e.target.value)} className="rounded bg-surface-800 p-2">
          <option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="title">Title</option>
        </select>
        <select aria-label="Filter playlists" value={filter} onChange={e => setFilter(e.target.value)} className="rounded bg-surface-800 p-2">
          <option value="">All</option>
          { ['ALBUM', 'EP', 'SINGLE', 'PLAYLIST'].map(value => <option key={value}>{value}</option>) }
        </select>
      </div>
      {listError && <p role="alert">{listError} <button onClick={() => loadPlaylists()}>Retry</button></p>}
      <PageControls cursor={nextCursor} load={() => loadPlaylists(nextCursor)} />
      {/* Loading state */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
        </div>
      ) : filteredPlaylists.length === 0 ? (
        <div className="rounded-xl border border-dashed border-surface-700 bg-surface-900/50 p-8 text-center">
          <p className="mb-4 text-surface-400">
            {searchQuery ? 'No playlists found matching your search' : 'No playlists yet'}
          </p>
          {!searchQuery && (
            <button
              onClick={() => setShowCreatePlaylist(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 transition-colors"
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
                  aria-label="Playlist actions" onClick={(e) => {
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
                            loadPlaylists()
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
