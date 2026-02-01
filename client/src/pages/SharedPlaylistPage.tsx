import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { playlistsApi, commentsApi, Playlist, Track, Comment, getAssetUrl } from '../lib/api'
import { usePlayerStore } from '../stores/playerStore'
import CommentSection from '../components/CommentSection'
import ReactionBar from '../components/ReactionBar'
import Player from '../components/Player'

export default function SharedPlaylistPage() {
  const { token } = useParams<{ token: string }>()
  const playTrack = usePlayerStore((state) => state.playTrack)
  const currentTrack = usePlayerStore((state) => state.currentTrack)
  const isPlaying = usePlayerStore((state) => state.isPlaying)
  const togglePlay = usePlayerStore((state) => state.togglePlay)

  const [playlist, setPlaylist] = useState<Playlist | null>(null)
  const [tracks, setTracks] = useState<(Track & { sort_order: number })[]>([])
  const [comments, setComments] = useState<Comment[]>([])
  const [canPostComments, setCanPostComments] = useState(false)
  const [commentsHidden, setCommentsHidden] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<'tracks' | 'comments'>('tracks')

  useEffect(() => {
    if (token) {
      loadPlaylist()
    }
  }, [token])

  const loadPlaylist = async () => {
    try {
      setLoading(true)
      setError('')

      const { playlist: playlistData, tracks: tracksData } = await playlistsApi.get(token!, token)
      setPlaylist(playlistData)
      setTracks(tracksData.map((t, i) => ({ ...t, sort_order: i })))

      // Load comments
      const { comments: commentsData, canPost, commentsHidden: hidden } = await commentsApi.listPlaylistComments(
        playlistData.id,
        token
      )
      setComments(commentsData)
      setCanPostComments(canPost)
      setCommentsHidden(hidden || false)
    } catch (err) {
      console.error('Load playlist error:', err)
      setError(err instanceof Error ? err.message : 'Failed to load playlist')
    } finally {
      setLoading(false)
    }
  }

  const handlePlay = (track: Track) => {
    if (!track.current_version_id) return

    const isCurrentTrack = currentTrack?.id === track.id

    if (isCurrentTrack) {
      togglePlay()
    } else {
      playTrack({
        id: track.id,
        title: track.title,
        versionId: track.current_version_id,
        version: 1,
        duration: track.duration_seconds || 0,
        coverArt: track.cover_art_path ? getAssetUrl(track.cover_art_path) : undefined,
      })
    }
  }

  const handleCommentAdded = (comment: Comment) => {
    setComments([...comments, comment])
  }

  const handleCommentDeleted = (commentId: string) => {
    setComments(comments.filter((c) => c.id !== commentId))
  }

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  // Calculate total duration
  const totalDuration = tracks.reduce((sum, t) => sum + (t.duration_seconds || 0), 0)

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-950 flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
      </div>
    )
  }

  if (error || !playlist) {
    return (
      <div className="min-h-screen bg-surface-950 flex flex-col items-center justify-center p-4">
        <div className="text-center">
          <div className="mb-4 text-6xl">404</div>
          <h1 className="mb-2 text-2xl font-bold text-white">Playlist Not Found</h1>
          <p className="text-surface-400">
            {error || 'This shared link may have expired or been removed.'}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-surface-950 flex flex-col">
      {/* Header with branding */}
      <header className="border-b border-surface-800 bg-surface-900">
        <div className="mx-auto max-w-3xl px-4 py-3">
          <a href="/" className="flex items-center gap-2 text-white">
            <img src="/soundraft-logo.svg" alt="SoundRaft" className="h-8 w-8" />
            <span className="font-semibold">SoundRaft</span>
          </a>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-auto pb-24">
        <div className="mx-auto max-w-3xl px-4 py-8">
          {/* Playlist Card */}
          <div className="rounded-2xl bg-surface-900 p-6">
            {/* Playlist Header */}
            <div className="mb-6 flex gap-6">
              {/* Cover Art */}
              <div className="h-40 w-40 shrink-0 rounded-xl bg-surface-800 overflow-hidden">
                {playlist.cover_art_path ? (
                  <img
                    src={getAssetUrl(playlist.cover_art_path)}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <svg
                      className="h-16 w-16 text-surface-600"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                      />
                    </svg>
                  </div>
                )}
              </div>

              {/* Playlist Info */}
              <div className="flex-1 min-w-0">
                <p className="mb-1 text-xs font-medium uppercase text-surface-400">
                  {playlist.type}
                </p>
                <h1 className="mb-2 text-2xl font-bold text-white truncate">{playlist.title}</h1>
                <p className="text-surface-400">
                  {tracks.length} {tracks.length === 1 ? 'track' : 'tracks'}
                  {totalDuration > 0 ? ` - ${formatDuration(totalDuration)}` : ''}
                </p>

                {/* Play All Button */}
                {tracks.length > 0 && tracks[0].current_version_id && (
                  <button
                    onClick={() => handlePlay(tracks[0])}
                    className="mt-4 flex items-center gap-2 rounded-full bg-primary-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-700 transition-colors"
                  >
                    <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                    Play All
                  </button>
                )}
              </div>
            </div>

            {/* Reactions */}
            <div className="mb-6 border-t border-surface-800 pt-6">
              <h3 className="mb-3 text-sm font-medium text-surface-400">
                React to this {playlist.type.toLowerCase()}
              </h3>
              <ReactionBar entityType="playlist" entityId={playlist.id} />
            </div>

            {/* Tabs */}
            <div className="mb-4 flex border-b border-surface-800">
              <button
                onClick={() => setActiveTab('tracks')}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'tracks'
                    ? 'border-b-2 border-primary-500 text-primary-400'
                    : 'text-surface-400 hover:text-white'
                }`}
              >
                Tracks ({tracks.length})
              </button>
              <button
                onClick={() => setActiveTab('comments')}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'comments'
                    ? 'border-b-2 border-primary-500 text-primary-400'
                    : 'text-surface-400 hover:text-white'
                }`}
              >
                Comments ({commentsHidden ? 0 : comments.length})
              </button>
            </div>

            {/* Tab Content */}
            {activeTab === 'tracks' && (
              <div className="space-y-2">
                {tracks.length === 0 ? (
                  <p className="py-8 text-center text-surface-500">
                    No tracks in this playlist yet
                  </p>
                ) : (
                  tracks.map((track, index) => {
                    const isCurrentTrack = currentTrack?.id === track.id
                    const isCurrentlyPlaying = isCurrentTrack && isPlaying

                    return (
                      <div
                        key={track.id}
                        className={`flex items-center gap-4 rounded-lg border p-3 ${
                          isCurrentTrack
                            ? 'border-primary-500/50 bg-primary-500/10'
                            : 'border-surface-800 bg-surface-800/50'
                        }`}
                      >
                        {/* Track number */}
                        <span className="w-6 text-center text-sm text-surface-500">
                          {index + 1}
                        </span>

                        {/* Play button */}
                        <button
                          onClick={() => handlePlay(track)}
                          disabled={!track.current_version_id}
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-700 text-white hover:bg-surface-600 disabled:opacity-50 transition-colors"
                        >
                          {isCurrentlyPlaying ? (
                            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                            </svg>
                          ) : (
                            <svg className="h-4 w-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M8 5v14l11-7z" />
                            </svg>
                          )}
                        </button>

                        {/* Track info */}
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-white">{track.title}</p>
                        </div>

                        {/* Duration */}
                        <span className="text-sm text-surface-500">
                          {track.duration_seconds ? formatDuration(track.duration_seconds) : '--:--'}
                        </span>
                      </div>
                    )
                  })
                )}
              </div>
            )}

            {activeTab === 'comments' && (
              commentsHidden ? (
                <p className="py-8 text-center text-surface-500">
                  Comments are private for this playlist
                </p>
              ) : (
                <CommentSection
                  entityType="playlist"
                  entityId={playlist.id}
                  comments={comments}
                  canPost={canPostComments}
                  isOwner={false}
                  shareToken={token}
                  onCommentAdded={handleCommentAdded}
                  onCommentDeleted={handleCommentDeleted}
                />
              )
            )}
          </div>
        </div>
      </main>

      {/* Fixed Player at bottom */}
      <div className="fixed bottom-0 left-0 right-0">
        <Player />
      </div>
    </div>
  )
}
