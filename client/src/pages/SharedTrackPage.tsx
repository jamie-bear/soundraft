import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { tracksApi, commentsApi, Track, Comment, getAssetUrl } from '../lib/api'
import { usePlayerStore } from '../stores/playerStore'
import CommentSection from '../components/CommentSection'
import ReactionBar from '../components/ReactionBar'
import Player from '../components/Player'

const statusColors: Record<string, string> = {
  POC: 'bg-purple-500/20 text-purple-400',
  DRAFT: 'bg-orange-500/20 text-orange-400',
  WIP: 'bg-yellow-500/20 text-yellow-400',
  FINAL: 'bg-green-500/20 text-green-400',
}

export default function SharedTrackPage() {
  const { token } = useParams<{ token: string }>()
  const playTrack = usePlayerStore((state) => state.playTrack)
  const currentTrack = usePlayerStore((state) => state.currentTrack)
  const isPlaying = usePlayerStore((state) => state.isPlaying)
  const togglePlay = usePlayerStore((state) => state.togglePlay)

  const [track, setTrack] = useState<Track | null>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [canPostComments, setCanPostComments] = useState(false)
  const [commentsHidden, setCommentsHidden] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (token) {
      loadTrack()
    }
  }, [token])

  const loadTrack = async () => {
    try {
      setLoading(true)
      setError('')

      // The API expects the token to be passed - it will look up the track by share_token
      const { track: trackData } = await tracksApi.get(token!, token)
      setTrack(trackData)

      // Load comments
      const { comments: commentsData, canPost, commentsHidden: hidden } = await commentsApi.listTrackComments(
        trackData.id,
        token
      )
      setComments(commentsData)
      setCanPostComments(canPost)
      setCommentsHidden(hidden || false)
    } catch (err) {
      console.error('Load track error:', err)
      setError(err instanceof Error ? err.message : 'Failed to load track')
    } finally {
      setLoading(false)
    }
  }

  const handlePlay = () => {
    if (!track || !track.current_version_id) return

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

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-950 flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
      </div>
    )
  }

  if (error || !track) {
    return (
      <div className="min-h-screen bg-surface-950 flex flex-col items-center justify-center p-4">
        <div className="text-center">
          <div className="mb-4 text-6xl">404</div>
          <h1 className="mb-2 text-2xl font-bold text-white">Track Not Found</h1>
          <p className="text-surface-400">
            {error || 'This shared link may have expired or been removed.'}
          </p>
        </div>
      </div>
    )
  }

  const isCurrentlyPlaying = currentTrack?.id === track.id && isPlaying
  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
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
          {/* Track Card */}
          <div className="rounded-2xl bg-surface-900 p-6">
            {/* Track Header */}
            <div className="mb-6 flex gap-6">
              {/* Cover Art */}
              <div className="relative h-40 w-40 shrink-0 rounded-xl bg-surface-800 overflow-hidden">
                {track.cover_art_path ? (
                  <img
                    src={getAssetUrl(track.cover_art_path)}
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
                        d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
                      />
                    </svg>
                  </div>
                )}

                {/* Play button overlay */}
                {track.current_version_id && (
                  <button
                    onClick={handlePlay}
                    className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 hover:opacity-100 transition-opacity"
                  >
                    <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-600 text-white shadow-lg">
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

              {/* Track Info */}
              <div className="flex-1 min-w-0">
                <div className="mb-2 flex items-center gap-2">
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      statusColors[track.status] || 'bg-surface-700 text-surface-300'
                    }`}
                  >
                    {track.status}
                  </span>
                </div>

                <h1 className="mb-2 text-2xl font-bold text-white line-clamp-2">{track.title}</h1>
                {track.artist && (
                  <p className="mb-2 text-lg text-surface-300">
                    {track.artist}
                  </p>
                )}

                <p className="text-surface-400">
                  Version {track.current_version_number || 1}
                  {track.duration_seconds
                    ? ` - ${formatDuration(track.duration_seconds)}`
                    : ''}
                </p>

                {/* Large Play Button */}
                {track.current_version_id && (
                  <button
                    onClick={handlePlay}
                    className="mt-4 flex items-center gap-2 rounded-full bg-primary-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-700 transition-colors"
                  >
                    {isCurrentlyPlaying ? (
                      <>
                        <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                        </svg>
                        Pause
                      </>
                    ) : (
                      <>
                        <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                        Play
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>

            {/* Reactions */}
            <div className="mb-6 border-t border-surface-800 pt-6">
              <h3 className="mb-3 text-sm font-medium text-surface-400">React to this track</h3>
              <ReactionBar entityType="track" entityId={track.id} />
            </div>

            {/* Comments Section */}
            <div className="border-t border-surface-800 pt-6">
              <h3 className="mb-4 text-lg font-semibold text-white">
                Comments ({commentsHidden ? 0 : comments.length})
              </h3>
              {commentsHidden ? (
                <p className="py-8 text-center text-surface-500">
                  Comments are private for this track
                </p>
              ) : (
                <CommentSection
                  entityType="track"
                  entityId={track.id}
                  comments={comments}
                  canPost={canPostComments}
                  isOwner={false}
                  shareToken={token}
                  currentTrackId={currentTrack?.id}
                  duration={track.duration_seconds}
                  onCommentAdded={handleCommentAdded}
                  onCommentDeleted={handleCommentDeleted}
                />
              )}
            </div>
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
