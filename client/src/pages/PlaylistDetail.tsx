import PageControls from '../components/PageControls'
import { appendUnique } from '../lib/pages'
import { useState, useEffect, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { playlistsApi, commentsApi, Playlist, Track, Comment, getAssetUrl } from '../lib/api'
import { usePlayerStore } from '../stores/playerStore'
import CommentSection from '../components/CommentSection'
import CoverArtUpload from '../components/CoverArtUpload'
import AddTrackModal from '../components/AddTrackModal'
import ShareModal from '../components/ShareModal'

interface PlaylistDetailProps {
  shared?: boolean
}

interface SortableTrackProps {
  track: Track & { sort_order: number }
  isOwner: boolean
  onPlay: (track: Track) => void
  currentTrackId?: string
  isPlaying: boolean
}

function SortableTrack({ track, isOwner, onPlay, currentTrackId, isPlaying }: SortableTrackProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: track.id, disabled: !isOwner })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const isCurrentTrack = currentTrackId === track.id

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 rounded-lg border p-3 ${
        isCurrentTrack
          ? 'border-primary-500/50 bg-primary-500/10'
          : 'border-surface-800 bg-surface-900'
      }`}
    >
      {isOwner && (
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab text-surface-500 hover:text-surface-300 active:cursor-grabbing"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8h16M4 16h16" />
          </svg>
        </button>
      )}

      {/* Track number */}
      <span className="w-5 text-center text-sm text-surface-500 shrink-0">{track.sort_order + 1}</span>

      {/* Cover art with play button overlay */}
      <button
        onClick={() => onPlay(track)}
        disabled={!track.current_version_id}
        className="relative h-12 w-12 shrink-0 rounded-lg overflow-hidden bg-surface-800 group disabled:opacity-50"
      >
        {track.cover_art_path ? (
          <img
            src={getAssetUrl(track.cover_art_path)}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <svg className="h-5 w-5 text-surface-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
            </svg>
          </div>
        )}
        {/* Play/pause overlay */}
        <div className={`absolute inset-0 flex items-center justify-center bg-black/50 transition-opacity ${
          isCurrentTrack ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}>
          {isCurrentTrack && isPlaying ? (
            <svg className="h-5 w-5 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
            </svg>
          ) : (
            <svg className="h-5 w-5 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </div>
      </button>

      <div className="min-w-0 flex-1">
        <Link
          to={`/tracks/${track.id}`}
          className="block truncate font-medium text-white hover:text-primary-400 transition-colors"
        >
          {track.title}
        </Link>
        <div className="flex items-center gap-2 text-sm text-surface-400">
          {track.artist && (
            <>
              <span className="truncate">{track.artist}</span>
              <span>-</span>
            </>
          )}
          <span>
            {track.duration_seconds
              ? `${Math.floor(track.duration_seconds / 60)}:${(track.duration_seconds % 60).toString().padStart(2, '0')}`
              : '--:--'}
          </span>
        </div>
      </div>
    </div>
  )
}

export default function PlaylistDetail({ shared = false }: PlaylistDetailProps) {
  const { id, token } = useParams<{ id?: string; token?: string }>()
  const navigate = useNavigate()
  const playTrack = usePlayerStore((state) => state.playTrack)
  const currentTrack = usePlayerStore((state) => state.currentTrack)
  const isPlaying = usePlayerStore((state) => state.isPlaying)
  const togglePlay = usePlayerStore((state) => state.togglePlay)

  const [trackCursor, setTrackCursor] = useState<string | null>(null)
  const [playlist, setPlaylist] = useState<Playlist | null>(null)
  const [tracks, setTracks] = useState<(Track & { sort_order: number })[]>([])
  const [comments, setComments] = useState<Comment[]>([])
  const [commentCursor, setCommentCursor] = useState<string | null>(null)
  const [canPostComments, setCanPostComments] = useState(false)
  const [isOwner, setIsOwner] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<'tracks' | 'comments'>('tracks')
  const [showAddTrack, setShowAddTrack] = useState(false)
  const [showShareModal, setShowShareModal] = useState(false)
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [editedTitle, setEditedTitle] = useState('')
  const [isEditingArtist, setIsEditingArtist] = useState(false)
  const [editedArtist, setEditedArtist] = useState('')
  
  const titleInputRef = useRef<HTMLInputElement>(null)
  const artistInputRef = useRef<HTMLInputElement>(null)

  const playlistId = shared ? undefined : id
  const shareToken = shared ? token : undefined

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  useEffect(() => {
    loadPlaylist()
  }, [playlistId, shareToken])

  const loadPlaylist = async () => {
    try {
      setLoading(true)
      const identifier = playlistId || shareToken
      if (!identifier) return

      const { playlist: playlistData, next_cursor: tracksNext, tracks: tracksData, isOwner: owner } = await playlistsApi.get(
        identifier,
        shareToken
      )
      setPlaylist(playlistData)
      setTracks(tracksData)
      setTrackCursor(tracksNext)
      setIsOwner(owner)

      // Load comments
      const { comments: commentsData, next_cursor: commentsNext, canPost } = await commentsApi.listPlaylistComments(playlistData.id, shareToken)
      setComments(commentsData)
      setCommentCursor(commentsNext)
      setCanPostComments(canPost)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load playlist')
    } finally {
      setLoading(false)
    }
  }

  const moreTracks = async () => {
    const page = await playlistsApi.get(playlist!.id, shareToken, { cursor: trackCursor })
    setTracks(previous => appendUnique(previous, page.tracks)); setTrackCursor(page.next_cursor)
  }

  const handlePlay = (track: Track) => {
    if (!track.current_version_id || !track.stream_url) return

    const isCurrentTrack = currentTrack?.id === track.id

    if (isCurrentTrack) {
      togglePlay()
    } else {
      // Build queue from all playable tracks in the playlist
      const queue = tracks
        .filter((t) => t.current_version_id && t.stream_url)
        .map((t) => ({
          id: t.id,
          title: t.title,
          versionId: t.current_version_id!,
          streamUrl: t.stream_url!,
          version: 1,
          duration: t.duration_seconds || 0,
          coverArt: t.cover_art_path ? getAssetUrl(t.cover_art_path) : undefined,
        }))

      playTrack(
        {
          id: track.id,
          title: track.title,
          versionId: track.current_version_id,
          streamUrl: track.stream_url,
          version: 1,
          duration: track.duration_seconds || 0,
          coverArt: track.cover_art_path ? getAssetUrl(track.cover_art_path) : undefined,
        },
        queue
      )
    }
  }

  const handleCommentAdded = (comment: Comment) => {
    setComments([...comments, comment])
  }

  const handleCommentDeleted = (commentId: string) => {
    setComments(comments.filter(c => c.id !== commentId))
  }

  const handleCommentAccessChange = async (newAccess: Playlist['comment_access']) => {
    if (!playlist || !isOwner) return
    
    try {
      const { playlist: updatedPlaylist } = await playlistsApi.update(playlist.id, { comment_access: newAccess })
      setPlaylist(updatedPlaylist)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update comment access')
    }
  }

  const handleCoverUpload = async (file: File) => {
    if (!playlist) return
    const { playlist: updatedPlaylist } = await playlistsApi.uploadCover(playlist.id, file)
    setPlaylist(updatedPlaylist)
  }

  const handleCoverDelete = async () => {
    if (!playlist) return
    const { playlist: updatedPlaylist } = await playlistsApi.deleteCover(playlist.id)
    setPlaylist(updatedPlaylist)
  }

  const handleTitleEdit = () => {
    if (!playlist || !isOwner) return
    setEditedTitle(playlist.title)
    setIsEditingTitle(true)
    // Focus input after state update
    setTimeout(() => titleInputRef.current?.focus(), 0)
  }

  const handleTitleSave = async () => {
    if (!playlist || !isOwner || !editedTitle.trim()) {
      setIsEditingTitle(false)
      return
    }
    
    if (editedTitle.trim() === playlist.title) {
      setIsEditingTitle(false)
      return
    }

    try {
      const { playlist: updatedPlaylist } = await playlistsApi.update(playlist.id, { title: editedTitle.trim() })
      setPlaylist(updatedPlaylist)
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

  const handleArtistEdit = () => {
    if (!playlist || !isOwner) return
    setEditedArtist(playlist.artist || '')
    setIsEditingArtist(true)
    setTimeout(() => artistInputRef.current?.focus(), 0)
  }

  const handleArtistSave = async () => {
    if (!playlist || !isOwner) {
      setIsEditingArtist(false)
      return
    }
    
    if (editedArtist.trim() === (playlist.artist || '')) {
      setIsEditingArtist(false)
      return
    }

    try {
      const { playlist: updatedPlaylist } = await playlistsApi.update(playlist.id, { artist: editedArtist.trim() })
      setPlaylist(updatedPlaylist)
      setIsEditingArtist(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update artist')
    }
  }

  const handleArtistKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleArtistSave()
    } else if (e.key === 'Escape') {
      setIsEditingArtist(false)
    }
  }

  const handleDelete = async () => {
    if (!playlist || !isOwner) return
    
    const confirmed = window.confirm(`Are you sure you want to delete "${playlist.title}"? This action cannot be undone.`)
    if (!confirmed) return

    try {
      await playlistsApi.delete(playlist.id)
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete playlist')
    }
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    if (trackCursor) { setError('Load the remaining tracks before reordering.'); return }
    const { active, over } = event

    if (!over || active.id === over.id || !playlist) return

    const oldIndex = tracks.findIndex((t) => t.id === active.id)
    const newIndex = tracks.findIndex((t) => t.id === over.id)

    const newTracks = arrayMove(tracks, oldIndex, newIndex).map((t, i) => ({
      ...t,
      sort_order: i,
    }))

    try {
      await playlistsApi.reorder(
        playlist.id,
        newTracks.map((t) => t.id)
      )
      setTracks(newTracks)
    } catch (err) {
      // Revert on error
      loadPlaylist()
      setError(err instanceof Error ? err.message : 'Failed to reorder')
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
      </div>
    )
  }

  if (!playlist) {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-4 text-red-400">
        {error || 'Playlist not found'}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl">
      {error && <p role="alert" className="mb-4 rounded border border-red-500/20 bg-red-500/10 p-3 text-red-300">{error} <button onClick={() => setError('')} className="ml-2 underline">Dismiss</button></p>}
      <PageControls cursor={trackCursor} load={moreTracks} reload={loadPlaylist} />
      {/* Playlist Header */}
      <div className="mb-8 flex flex-col sm:flex-row gap-6">
        {isOwner ? (
          <div className="mx-auto sm:mx-0">
            <CoverArtUpload
              currentCoverUrl={playlist.cover_art_path}
              onUpload={handleCoverUpload}
              onDelete={playlist.cover_art_path ? handleCoverDelete : undefined}
              size="lg"
            />
          </div>
        ) : (
          <div className="mx-auto sm:mx-0 h-48 w-48 sm:h-60 sm:w-60 shrink-0 rounded-xl bg-surface-800 overflow-hidden">
            {playlist.cover_art_path ? (
              <img src={getAssetUrl(playlist.cover_art_path)} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <svg className="h-16 w-16 sm:h-20 sm:w-20 text-surface-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              </div>
            )}
          </div>
        )}

        <div className="flex-1 min-w-0 text-center sm:text-left">
          {/* Type selector */}
          <div className="mb-2 flex items-center justify-center sm:justify-start">
            {isOwner ? (
              <select
                value={playlist.type}
                onChange={async (e) => {
                  try {
                    const { playlist: updatedPlaylist } = await playlistsApi.update(playlist.id, { type: e.target.value as Playlist['type'] })
                    setPlaylist(updatedPlaylist)
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Failed to update type')
                  }
                }}
                className="rounded-full px-2.5 py-0.5 text-xs font-medium uppercase bg-surface-800 text-surface-300 border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary-500/50"
                style={{ backgroundImage: 'none' }}
              >
                <option value="PLAYLIST" className="bg-surface-800 text-white">Playlist</option>
                <option value="ALBUM" className="bg-surface-800 text-white">Album</option>
                <option value="EP" className="bg-surface-800 text-white">EP</option>
                <option value="SINGLE" className="bg-surface-800 text-white">Single</option>
              </select>
            ) : (
              <span className="rounded-full px-2.5 py-0.5 text-xs font-medium uppercase bg-surface-800 text-surface-300">
                {playlist.type}
              </span>
            )}
          </div>

          {/* Editable Title */}
          {isEditingTitle ? (
            <input
              aria-label="Title" ref={titleInputRef}
              type="text"
              value={editedTitle}
              onChange={(e) => setEditedTitle(e.target.value)}
              onBlur={handleTitleSave}
              onKeyDown={handleTitleKeyDown}
              className="mb-1 w-full bg-transparent text-3xl font-bold text-white border-b-2 border-primary-500 focus:outline-none"
            />
          ) : (
            <h1 
              className={`mb-1 text-3xl font-bold text-white line-clamp-2 ${isOwner ? 'cursor-pointer hover:text-primary-400 transition-colors' : ''}`}
              onClick={isOwner ? handleTitleEdit : undefined}
              title={isOwner ? 'Click to edit title' : undefined}
            >
              {playlist.title}
            </h1>
          )}

          {/* Editable Artist */}
          {isEditingArtist ? (
            <input
              aria-label="Artist" ref={artistInputRef}
              type="text"
              value={editedArtist}
              onChange={(e) => setEditedArtist(e.target.value)}
              onBlur={handleArtistSave}
              onKeyDown={handleArtistKeyDown}
              className="mb-2 w-full bg-transparent text-lg text-surface-300 border-b border-surface-600 focus:outline-none focus:border-primary-500"
              placeholder="Add artist name"
            />
          ) : (
            <p 
              className={`mb-2 text-lg text-surface-300 ${isOwner ? 'cursor-pointer hover:text-white transition-colors' : ''}`}
              onClick={isOwner ? handleArtistEdit : undefined}
              title={isOwner ? 'Click to edit artist' : undefined}
            >
              {playlist.artist || (isOwner ? 'Add Artist' : '')}
            </p>
          )}

          <p className="text-surface-400">{tracks.length} tracks</p>

          {isOwner && (
            <div className="mt-4 flex flex-wrap justify-center sm:justify-start gap-2">
              <button
                onClick={() => setShowAddTrack(true)}
                className="flex items-center gap-2 rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700 transition-colors"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add Tracks
              </button>
              <button
                onClick={() => setShowShareModal(true)}
                className="flex items-center gap-2 rounded-lg bg-surface-800 px-3 py-2 text-sm font-medium text-white hover:bg-surface-700 transition-colors"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                </svg>
                Share
              </button>
              <button
                onClick={async () => {
                  try {
                    await playlistsApi.duplicate(playlist.id)
                    // Could navigate to new playlist
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Failed to duplicate')
                  }
                }}
                className="rounded-lg bg-surface-800 px-3 py-2 text-sm font-medium text-white hover:bg-surface-700 transition-colors"
              >
                Duplicate
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-6 flex border-b border-surface-800">
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
          Comments ({comments.length})
        </button>
        {isOwner && (
          <button
            onClick={() => setActiveTab('delete' as any)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === ('delete' as any)
                ? 'border-b-2 border-red-500 text-red-400'
                : 'text-surface-400 hover:text-red-400'
            }`}
          >
            Delete
          </button>
        )}
      </div>

      {/* Tab Content */}
      {activeTab === 'tracks' && (
        <>
          {tracks.length === 0 ? (
            <div className="rounded-xl border border-dashed border-surface-700 bg-surface-900/50 p-12 text-center">
              <p className="text-surface-500">No tracks in this playlist</p>
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={tracks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                <div className="space-y-2">
                  {tracks.map((track) => (
                    <SortableTrack
                      key={track.id}
                      track={track}
                      isOwner={isOwner}
                      onPlay={handlePlay}
                      currentTrackId={currentTrack?.id}
                      isPlaying={isPlaying}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </>
      )}

      {activeTab === 'comments' && (
        <div className="space-y-4">
          {/* Comment Access Control (owner only) */}
          {isOwner && (
            <div className="flex items-center justify-between rounded-lg border border-surface-800 bg-surface-900 p-3">
              <div className="flex items-center gap-2 text-sm text-surface-400">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                <span>Comment Access</span>
              </div>
              <select
                value={playlist.comment_access}
                onChange={(e) => handleCommentAccessChange(e.target.value as Playlist['comment_access'])}
                className="rounded-lg border border-surface-700 bg-surface-800 px-3 py-1.5 text-sm text-white focus:border-primary-500 focus:outline-none"
              >
                <option value="PRIVATE">Private (only me)</option>
                <option value="PUBLIC_VIEW">View Only (shared link can view)</option>
                <option value="PUBLIC_FULL">Full Access (signed-in users can comment)</option>
              </select>
            </div>
          )}

          {/* Comment Section */}
          <CommentSection
                nextCursor={commentCursor}
                onLoadMore={async () => {
                  const page = await commentsApi.listPlaylistComments(playlist!.id, shareToken, { cursor: commentCursor })
                  setComments(previous => appendUnique(previous, page.comments)); setCommentCursor(page.next_cursor)
                }}
            entityType="playlist"
            entityId={playlist.id}
            comments={comments}
            canPost={canPostComments}
            isOwner={isOwner}
            shareToken={shareToken}
            onCommentAdded={handleCommentAdded}
            onCommentDeleted={handleCommentDeleted}
          />
        </div>
      )}

      {activeTab === ('delete' as any) && isOwner && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-6">
          <h3 className="mb-2 text-lg font-medium text-red-400">Danger Zone</h3>
          <p className="mb-4 text-sm text-surface-300">
            Deleting this playlist will permanently remove it. The tracks within the playlist will not be deleted from your library. This action cannot be undone.
          </p>
          <button
            onClick={handleDelete}
            className="inline-flex items-center gap-2 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Delete Playlist
          </button>
        </div>
      )}

      {/* Add Track Modal */}
      {isOwner && (
        <AddTrackModal
          playlistId={playlist.id}
          playlistTitle={playlist.title}
          existingTrackIds={tracks.map(t => t.id)}
          isOpen={showAddTrack}
          onClose={() => setShowAddTrack(false)}
          onTracksAdded={loadPlaylist}
        />
      )}

      {/* Share Modal */}
      {isOwner && (
        <ShareModal
          entityType="playlist"
          entity={playlist}
          isOpen={showShareModal}
          onClose={() => setShowShareModal(false)}
          onUpdate={(updated) => setPlaylist(updated as Playlist)}
        />
      )}
    </div>
  )
}
