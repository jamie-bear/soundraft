import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { tracksApi, commentsApi, attachmentsApi, Track, TrackVersion, Comment, Attachment, getAssetUrl } from '../lib/api'
import { usePlayerStore } from '../stores/playerStore'
import CommentSection from '../components/CommentSection'
import CoverArtUpload from '../components/CoverArtUpload'
import AttachmentList from '../components/AttachmentList'
import VersionList from '../components/VersionList'
import AddToPlaylistModal from '../components/AddToPlaylistModal'
import ShareModal from '../components/ShareModal'
import ReactionBar from '../components/ReactionBar'

interface TrackDetailProps {
  shared?: boolean
}

const statusColors: Record<string, string> = {
  POC: 'bg-purple-500/20 text-purple-400',
  DRAFT: 'bg-orange-500/20 text-orange-400',
  WIP: 'bg-yellow-500/20 text-yellow-400',
  FINAL: 'bg-green-500/20 text-green-400',
}

export default function TrackDetail({ shared = false }: TrackDetailProps) {
  const { id, token } = useParams<{ id?: string; token?: string }>()
  const navigate = useNavigate()
  const playTrack = usePlayerStore((state) => state.playTrack)
  const currentTrack = usePlayerStore((state) => state.currentTrack)
  const isPlaying = usePlayerStore((state) => state.isPlaying)
  const togglePlay = usePlayerStore((state) => state.togglePlay)
  
  const [track, setTrack] = useState<Track | null>(null)
  const [versions, setVersions] = useState<TrackVersion[]>([])
  const [comments, setComments] = useState<Comment[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [isOwner, setIsOwner] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<'comments' | 'versions' | 'attachments'>('comments')
  const [canPostComments, setCanPostComments] = useState(false)
  const [showAddToPlaylist, setShowAddToPlaylist] = useState(false)
  const [showShareModal, setShowShareModal] = useState(false)
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [editedTitle, setEditedTitle] = useState('')
  
  const fileInputRef = useRef<HTMLInputElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)

  const trackId = shared ? undefined : id
  const shareToken = shared ? token : undefined

  useEffect(() => {
    loadTrack()
  }, [trackId, shareToken])

  const loadTrack = async () => {
    try {
      setLoading(true)
      
      // For shared tracks, we need to use the token to get the track
      // The API will look up the track by share_token
      const identifier = trackId || shareToken
      if (!identifier) return

      const { track: trackData, isOwner: owner } = await tracksApi.get(identifier, shareToken)
      setTrack(trackData)
      setIsOwner(owner)

      // Load comments using new API
      const { comments: commentsData, canPost } = await commentsApi.listTrackComments(trackData.id, shareToken)
      setComments(commentsData)
      setCanPostComments(canPost)

      // Load versions and attachments only for owner
      if (owner) {
        const { versions: versionsData } = await tracksApi.getVersions(trackData.id)
        setVersions(versionsData)

        const { attachments: attachmentsData } = await attachmentsApi.list(trackData.id)
        setAttachments(attachmentsData)
      }
    } catch (err) {
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
      })
    }
  }

  const handleVersionUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !track) return

    try {
      await tracksApi.uploadVersion(track.id, file)
      loadTrack() // Reload to get new version
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    }
  }

  const handleCommentAdded = (comment: Comment) => {
    setComments([...comments, comment])
  }

  const handleCommentDeleted = (commentId: string) => {
    setComments(comments.filter(c => c.id !== commentId))
  }

  const handleCommentAccessChange = async (newAccess: Track['comment_access']) => {
    if (!track || !isOwner) return
    
    try {
      const { track: updatedTrack } = await tracksApi.update(track.id, { comment_access: newAccess })
      setTrack(updatedTrack)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update comment access')
    }
  }

  const handleCoverUpload = async (file: File) => {
    if (!track) return
    const { track: updatedTrack } = await tracksApi.uploadCover(track.id, file)
    setTrack(updatedTrack)
  }

  const handleCoverDelete = async () => {
    if (!track) return
    const { track: updatedTrack } = await tracksApi.deleteCover(track.id)
    setTrack(updatedTrack)
  }

  const handleStatusChange = async (newStatus: Track['status']) => {
    if (!track || !isOwner) return
    try {
      const { track: updatedTrack } = await tracksApi.update(track.id, { status: newStatus })
      setTrack(updatedTrack)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status')
    }
  }

  const handleTitleEdit = () => {
    if (!track || !isOwner) return
    setEditedTitle(track.title)
    setIsEditingTitle(true)
    // Focus input after state update
    setTimeout(() => titleInputRef.current?.focus(), 0)
  }

  const handleTitleSave = async () => {
    if (!track || !isOwner || !editedTitle.trim()) {
      setIsEditingTitle(false)
      return
    }
    
    if (editedTitle.trim() === track.title) {
      setIsEditingTitle(false)
      return
    }

    try {
      const { track: updatedTrack } = await tracksApi.update(track.id, { title: editedTitle.trim() })
      setTrack(updatedTrack)
      setIsEditingTitle(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update title')
    }
  }

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleTitleSave()
    } else if (e.key === 'Escape') {
      setIsEditingTitle(false)
    }
  }

  const handleDelete = async () => {
    if (!track || !isOwner) return
    
    const confirmed = window.confirm(`Are you sure you want to delete "${track.title}"? This action cannot be undone.`)
    if (!confirmed) return

    try {
      await tracksApi.delete(track.id)
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete track')
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
      </div>
    )
  }

  if (error || !track) {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-4 text-red-400">
        {error || 'Track not found'}
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
    <div className="mx-auto max-w-3xl">
      {/* Track Card */}
      <div className="rounded-2xl bg-surface-900 p-6">
        {/* Track Header */}
        <div className="mb-6 flex gap-6">
          {/* Cover Art */}
          <div className="relative h-40 w-40 shrink-0 rounded-xl bg-surface-800 overflow-hidden">
            {isOwner ? (
              <CoverArtUpload
                currentCoverUrl={track.cover_art_path}
                onUpload={handleCoverUpload}
                onDelete={track.cover_art_path ? handleCoverDelete : undefined}
                size="md"
              />
            ) : (
              <>
                {track.cover_art_path ? (
                  <img src={getAssetUrl(track.cover_art_path)} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <svg className="h-16 w-16 text-surface-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                    </svg>
                  </div>
                )}
              </>
            )}

            {/* Play button overlay (non-owner only) */}
            {!isOwner && track.current_version_id && (
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
              {isOwner ? (
                <select
                  value={track.status}
                  onChange={(e) => handleStatusChange(e.target.value as Track['status'])}
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary-500/50 ${statusColors[track.status] || 'bg-surface-700 text-surface-300'}`}
                  style={{ 
                    backgroundImage: 'none',
                  }}
                >
                  <option value="POC" className="bg-surface-800 text-white">POC</option>
                  <option value="DRAFT" className="bg-surface-800 text-white">DRAFT</option>
                  <option value="WIP" className="bg-surface-800 text-white">WIP</option>
                  <option value="FINAL" className="bg-surface-800 text-white">FINAL</option>
                </select>
              ) : (
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColors[track.status] || 'bg-surface-700 text-surface-300'}`}>
                  {track.status}
                </span>
              )}
            </div>

            {/* Editable Title */}
            {isEditingTitle ? (
              <input
                ref={titleInputRef}
                type="text"
                value={editedTitle}
                onChange={(e) => setEditedTitle(e.target.value)}
                onBlur={handleTitleSave}
                onKeyDown={handleTitleKeyDown}
                className="mb-2 w-full bg-transparent text-2xl font-bold text-white border-b-2 border-primary-500 focus:outline-none"
              />
            ) : (
              <h1 
                className={`mb-2 text-2xl font-bold text-white truncate ${isOwner ? 'cursor-pointer hover:text-primary-400 transition-colors' : ''}`}
                onClick={isOwner ? handleTitleEdit : undefined}
                title={isOwner ? 'Click to edit title' : undefined}
              >
                {track.title}
              </h1>
            )}

            <p className="text-surface-400">
              Version {track.current_version_number || 1}
              {track.duration_seconds ? ` - ${formatDuration(track.duration_seconds)}` : ''}
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

            {/* Owner Action Buttons */}
            {isOwner && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-surface-800 px-3 py-1.5 text-xs font-medium text-surface-200 hover:bg-surface-700 hover:text-white transition-colors"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  Upload New Version
                </button>
                <button
                  onClick={() => setShowAddToPlaylist(true)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-surface-800 px-3 py-1.5 text-xs font-medium text-surface-200 hover:bg-surface-700 hover:text-white transition-colors"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  Add to Playlist
                </button>
                <button
                  onClick={() => setShowShareModal(true)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-surface-800 px-3 py-1.5 text-xs font-medium text-surface-200 hover:bg-surface-700 hover:text-white transition-colors"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                  </svg>
                  Share
                </button>
                <button
                  onClick={handleDelete}
                  className="inline-flex items-center gap-1.5 rounded-md bg-red-600/10 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-600/20 hover:text-red-300 transition-colors"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  Delete
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*"
                  onChange={handleVersionUpload}
                  className="hidden"
                />
              </div>
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
          {/* Tab Navigation */}
          {isOwner ? (
            <div className="mb-6 flex gap-1 border-b border-surface-800">
              <button
                onClick={() => setActiveTab('comments')}
                className={`px-4 py-2.5 text-sm font-semibold transition-all ${
                  activeTab === 'comments'
                    ? 'border-b-2 border-primary-500 text-primary-400 -mb-px'
                    : 'text-surface-400 hover:text-surface-200 border-b-2 border-transparent'
                }`}
              >
                Comments ({comments.length})
              </button>
              <button
                onClick={() => setActiveTab('versions')}
                className={`px-4 py-2.5 text-sm font-semibold transition-all ${
                  activeTab === 'versions'
                    ? 'border-b-2 border-primary-500 text-primary-400 -mb-px'
                    : 'text-surface-400 hover:text-surface-200 border-b-2 border-transparent'
                }`}
              >
                Versions ({versions.length})
              </button>
              <button
                onClick={() => setActiveTab('attachments')}
                className={`px-4 py-2.5 text-sm font-semibold transition-all ${
                  activeTab === 'attachments'
                    ? 'border-b-2 border-primary-500 text-primary-400 -mb-px'
                    : 'text-surface-400 hover:text-surface-200 border-b-2 border-transparent'
                }`}
              >
                Attachments ({attachments.length})
              </button>
            </div>
          ) : (
            <h3 className="mb-4 text-lg font-semibold text-white">Comments ({comments.length})</h3>
          )}

          {/* Tab Content */}
          {activeTab === 'comments' && (
            <div className="space-y-4">
              {/* Comment Access Control (owner only) */}
              {isOwner && (
                <div className="flex items-center justify-between rounded-lg border border-surface-800 bg-surface-900/50 px-4 py-3">
                  <div className="flex items-center gap-2.5 text-sm font-medium text-surface-400">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                    <span>Comment Access</span>
                  </div>
                  <select
                    value={track.comment_access}
                    onChange={(e) => handleCommentAccessChange(e.target.value as Track['comment_access'])}
                    className="rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm font-medium text-white focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 cursor-pointer"
                  >
                    <option value="PRIVATE">Private (only me)</option>
                    <option value="PUBLIC_VIEW">View Only (shared link can view)</option>
                    <option value="PUBLIC_FULL">Full Access (signed-in users can comment)</option>
                  </select>
                </div>
              )}

              {/* Comment Section */}
              <CommentSection
                entityType="track"
                entityId={track.id}
                comments={comments}
                canPost={canPostComments}
                isOwner={isOwner}
                shareToken={shareToken}
                currentTrackId={currentTrack?.id}
                duration={track.duration_seconds}
                onCommentAdded={handleCommentAdded}
                onCommentDeleted={handleCommentDeleted}
              />
            </div>
          )}

          {activeTab === 'versions' && isOwner && (
            <VersionList
              trackId={track.id}
              currentVersionId={track.current_version_id}
              versions={versions}
              onVersionsChange={setVersions}
              onCurrentVersionChange={(versionId) => {
                // Update track's current version
                const version = versions.find(v => v.id === versionId)
                if (version) {
                  setTrack({
                    ...track,
                    current_version_id: versionId,
                    current_version_number: version.version_number,
                    duration_seconds: version.duration_seconds,
                  })
                }
              }}
            />
          )}

          {activeTab === 'attachments' && isOwner && (
            <AttachmentList
              trackId={track.id}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
            />
          )}
        </div>
      </div>

      {/* Add to Playlist Modal */}
      {isOwner && (
        <AddToPlaylistModal
          trackId={track.id}
          trackTitle={track.title}
          isOpen={showAddToPlaylist}
          onClose={() => setShowAddToPlaylist(false)}
        />
      )}

      {/* Share Modal */}
      {isOwner && (
        <ShareModal
          entityType="track"
          entity={track}
          isOpen={showShareModal}
          onClose={() => setShowShareModal(false)}
          onUpdate={(updated) => setTrack(updated as Track)}
        />
      )}
    </div>
  )
}
