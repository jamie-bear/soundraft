import { useState, useRef } from 'react'
import { TrackVersion, tracksApi } from '../lib/api'

interface VersionListProps {
  trackId: string
  currentVersionId: string | undefined
  versions: TrackVersion[]
  onVersionsChange: (versions: TrackVersion[]) => void
  onCurrentVersionChange: (versionId: string) => void
}

interface VersionItemProps {
  version: TrackVersion
  trackId: string
  isCurrent: boolean
  isOnlyVersion: boolean
  onRename: (id: string, newName: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onSetCurrent: (id: string) => Promise<void>
}

function VersionItem({
  version,
  trackId,
  isCurrent,
  isOnlyVersion,
  onRename,
  onDelete,
  onSetCurrent,
}: VersionItemProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(version.filename)
  const [saving, setSaving] = useState(false)
  const [settingCurrent, setSettingCurrent] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleStartEdit = () => {
    setEditName(version.filename)
    setIsEditing(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const handleSaveEdit = async () => {
    if (!editName.trim() || editName === version.filename) {
      setIsEditing(false)
      return
    }

    setSaving(true)
    try {
      await onRename(version.id, editName.trim())
      setIsEditing(false)
    } catch (err) {
      // Revert on error
      setEditName(version.filename)
    } finally {
      setSaving(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveEdit()
    } else if (e.key === 'Escape') {
      setEditName(version.filename)
      setIsEditing(false)
    }
  }

  const handleSetCurrent = async () => {
    if (isCurrent || settingCurrent) return
    setSettingCurrent(true)
    try {
      await onSetCurrent(version.id)
    } finally {
      setSettingCurrent(false)
    }
  }

  const formatSize = (bytes: number) => {
    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }
    return `${(bytes / 1024).toFixed(1)} KB`
  }

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  return (
    <div
      className={`flex items-center gap-3 rounded-lg border p-3 ${
        isCurrent
          ? 'border-primary-500/50 bg-primary-500/10'
          : 'border-surface-800 bg-surface-900'
      }`}
    >
      {/* Version Number Badge */}
      <div
        className={`flex h-10 w-10 items-center justify-center rounded-lg font-bold ${
          isCurrent
            ? 'bg-primary-600 text-white'
            : 'bg-surface-800 text-surface-400'
        }`}
      >
        v{version.version_number}
      </div>

      {/* Version Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={handleSaveEdit}
              onKeyDown={handleKeyDown}
              disabled={saving}
              className="w-full rounded border border-surface-700 bg-surface-800 px-2 py-1 text-sm text-white focus:border-primary-500 focus:outline-none"
            />
          ) : (
            <button
              onClick={handleStartEdit}
              className="truncate font-medium text-white hover:text-primary-400 transition-colors text-left"
              title="Click to rename"
            >
              {version.filename}
            </button>
          )}
          {isCurrent && (
            <span className="shrink-0 rounded-full bg-primary-600/20 px-2 py-0.5 text-xs font-medium text-primary-400">
              Current
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-3 text-xs text-surface-500">
          <span>{formatSize(version.size_bytes)}</span>
          {version.duration_seconds > 0 && (
            <span>{formatDuration(version.duration_seconds)}</span>
          )}
          <span>{new Date(version.created_at).toLocaleDateString()}</span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1">
        {/* Set as Current */}
        {!isCurrent && (
          <button
            onClick={handleSetCurrent}
            disabled={settingCurrent}
            className="rounded p-1.5 text-surface-400 hover:bg-surface-800 hover:text-primary-400 transition-colors disabled:opacity-50"
            title="Set as current version"
          >
            {settingCurrent ? (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
            ) : (
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
        )}

        {/* Download */}
        <button
          onClick={async () => { window.location.assign(await tracksApi.getVersionDownloadUrl(trackId, version.id)) }}
          className="rounded p-1.5 text-surface-400 hover:bg-surface-800 hover:text-white transition-colors"
          title="Download"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
        </button>

        {/* Delete */}
        <button
          onClick={() => onDelete(version.id)}
          disabled={isOnlyVersion}
          className="rounded p-1.5 text-surface-400 hover:bg-surface-800 hover:text-red-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title={isOnlyVersion ? 'Cannot delete the only version' : 'Delete version'}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
    </div>
  )
}

export default function VersionList({
  trackId,
  currentVersionId,
  versions,
  onVersionsChange,
  onCurrentVersionChange,
}: VersionListProps) {
  const [error, setError] = useState('')

  const handleRename = async (id: string, newName: string) => {
    try {
      const { version: updated } = await tracksApi.renameVersion(trackId, id, newName)
      onVersionsChange(
        versions.map((v) => (v.id === id ? { ...v, filename: updated.filename } : v))
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename version')
      throw err
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this version? This cannot be undone.')) return

    try {
      await tracksApi.deleteVersion(trackId, id)
      const newVersions = versions.filter((v) => v.id !== id)
      onVersionsChange(newVersions)
      
      // If we deleted the current version, the backend will have set a new current
      // We should reload to get the updated track state
      if (id === currentVersionId && newVersions.length > 0) {
        // The parent component should reload the track data
        onCurrentVersionChange(newVersions[newVersions.length - 1].id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete version')
    }
  }

  const handleSetCurrent = async (id: string) => {
    try {
      await tracksApi.activateVersion(trackId, id)
      onCurrentVersionChange(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set current version')
      throw err
    }
  }

  // Sort versions by version_number descending (newest first)
  const sortedVersions = [...versions].sort((a, b) => b.version_number - a.version_number)
  const isOnlyVersion = versions.length === 1

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
          {error}
          <button
            onClick={() => setError('')}
            className="ml-2 text-red-300 hover:text-red-200"
          >
            Dismiss
          </button>
        </div>
      )}

      {sortedVersions.length === 0 ? (
        <p className="py-4 text-center text-surface-500">No versions yet</p>
      ) : (
        <div className="space-y-2">
          {sortedVersions.map((version) => (
            <VersionItem
              key={version.id}
              version={version}
              trackId={trackId}
              isCurrent={version.id === currentVersionId}
              isOnlyVersion={isOnlyVersion}
              onRename={handleRename}
              onDelete={handleDelete}
              onSetCurrent={handleSetCurrent}
            />
          ))}
        </div>
      )}

      {/* Help text */}
      <p className="text-xs text-surface-500 text-center">
        Click filename to rename. The current version is what plays by default.
      </p>
    </div>
  )
}
