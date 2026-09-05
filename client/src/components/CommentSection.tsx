import PageControls from './PageControls'
import { useState } from 'react'
import { Comment, commentsApi } from '../lib/api'
import { usePlayerStore } from '../stores/playerStore'
import { useAuthStore } from '../stores/authStore'

interface CommentSectionProps {
  nextCursor?: string | null
  onLoadMore?: () => Promise<void>
  entityType: 'track' | 'playlist'
  entityId: string
  comments: Comment[]
  canPost: boolean
  isOwner: boolean
  shareToken?: string
  currentTrackId?: string  // For seeking to timestamp in track comments
  duration?: number        // Track duration for timestamp calculation
  onCommentAdded: (comment: Comment) => void
  onCommentDeleted: (commentId: string) => void
}

export default function CommentSection({
  nextCursor, onLoadMore,
  entityType,
  entityId,
  comments,
  canPost,
  isOwner,
  shareToken,
  currentTrackId,
  duration,
  onCommentAdded,
  onCommentDeleted,
}: CommentSectionProps) {
  const [newComment, setNewComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const playerState = usePlayerStore()
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)
  const isTrack = entityType === 'track'

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newComment.trim() || !canPost) return

    setSubmitting(true)
    setError('')

    try {
      let audioTimestamp: number | undefined

      // For track comments, capture current playback position if playing this track
      if (isTrack && currentTrackId === entityId && duration) {
        audioTimestamp = playerState.progress * duration
      }

      const { comment } = isTrack
        ? await commentsApi.createTrackComment(entityId, newComment, audioTimestamp, shareToken)
        : await commentsApi.createPlaylistComment(entityId, newComment, shareToken)

      onCommentAdded(comment)
      setNewComment('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add comment')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (commentId: string) => {
    if (!window.confirm('Delete this comment?')) return
    try {
      await commentsApi.delete(commentId)
      onCommentDeleted(commentId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete comment')
    }
  }

  const handleSeekToTimestamp = (timestamp: number) => {
    if (duration && duration > 0) {
      playerState.seek(timestamp / duration)
    }
  }

  const formatTimestamp = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Add comment form */}
      {canPost ? (
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="text"
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            aria-label="Comment"
            placeholder={isTrack ? "Add a comment (timestamped if playing)..." : "Add a comment..."}
            className="flex-1 rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-white placeholder-surface-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            disabled={submitting}
          />
          <button
            type="submit"
            disabled={!newComment.trim() || submitting}
            className="rounded-lg bg-primary-600 px-4 py-2 font-medium text-white hover:bg-primary-700 disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Posting...' : 'Post'}
          </button>
        </form>
      ) : (
        <p className="text-sm text-surface-500 italic">
          {!isAuthenticated ? 'Sign in to comment' : 'Comments are view-only for shared links'}
        </p>
      )}

      {onLoadMore && <PageControls cursor={nextCursor} load={onLoadMore} />}
      {/* Comments list */}
      {comments.length === 0 ? (
        <p className="py-8 text-center text-surface-500">No comments yet</p>
      ) : (
        <div className="space-y-3">
          {comments.map((comment) => (
            <div key={comment.id} className="rounded-lg border border-surface-800 bg-surface-900 p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-white">{comment.user_email}</span>
                <div className="flex items-center gap-2 text-xs text-surface-500">
                  {/* Timestamp link for track comments */}
                  {isTrack && comment.audio_timestamp !== null && comment.audio_timestamp !== undefined && (
                    <button
                      onClick={() => handleSeekToTimestamp(comment.audio_timestamp!)}
                      className="text-primary-400 hover:text-primary-300"
                    >
                      @{formatTimestamp(comment.audio_timestamp)}
                    </button>
                  )}
                  <span>{new Date(comment.created_at).toLocaleDateString()}</span>
                  
                  {/* Delete button for owner */}
                  {isOwner && (
                    <button
                      onClick={() => handleDelete(comment.id)}
                      className="ml-2 text-surface-500 hover:text-red-400 transition-colors"
                      title="Delete comment"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
              <p className="text-surface-300">{comment.body}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
