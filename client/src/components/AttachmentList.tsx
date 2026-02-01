import { useState, useRef } from 'react'
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
import { Attachment, attachmentsApi } from '../lib/api'

interface AttachmentListProps {
  trackId: string
  attachments: Attachment[]
  onAttachmentsChange: (attachments: Attachment[]) => void
}

interface SortableAttachmentProps {
  attachment: Attachment
  onRename: (id: string, newName: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

function SortableAttachment({ attachment, onRename, onDelete }: SortableAttachmentProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(attachment.filename)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: attachment.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const handleStartEdit = () => {
    setEditName(attachment.filename)
    setIsEditing(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const handleSaveEdit = async () => {
    if (!editName.trim() || editName === attachment.filename) {
      setIsEditing(false)
      return
    }

    setSaving(true)
    try {
      await onRename(attachment.id, editName.trim())
      setIsEditing(false)
    } catch (err) {
      // Revert on error
      setEditName(attachment.filename)
    } finally {
      setSaving(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveEdit()
    } else if (e.key === 'Escape') {
      setEditName(attachment.filename)
      setIsEditing(false)
    }
  }

  const formatSize = (bytes: number) => {
    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }
    return `${(bytes / 1024).toFixed(1)} KB`
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 rounded-lg border border-surface-800 bg-surface-900 p-3"
    >
      {/* Drag Handle */}
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab text-surface-500 hover:text-surface-300 active:cursor-grabbing"
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8h16M4 16h16" />
        </svg>
      </button>

      {/* File Icon */}
      <div className="flex h-8 w-8 items-center justify-center rounded bg-surface-800 text-surface-400">
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
        </svg>
      </div>

      {/* Filename (editable) */}
      <div className="min-w-0 flex-1">
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
            className="block w-full truncate text-left font-medium text-white hover:text-primary-400 transition-colors"
            title="Click to rename"
          >
            {attachment.filename}
          </button>
        )}
        <p className="text-xs text-surface-500">
          {formatSize(attachment.size_bytes)}
        </p>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1">
        <a
          href={attachmentsApi.getDownloadUrl(attachment.id)}
          className="rounded p-1.5 text-surface-400 hover:bg-surface-800 hover:text-white transition-colors"
          title="Download"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
        </a>
        <button
          onClick={() => onDelete(attachment.id)}
          className="rounded p-1.5 text-surface-400 hover:bg-surface-800 hover:text-red-400 transition-colors"
          title="Delete"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
    </div>
  )
}

export default function AttachmentList({ trackId, attachments, onAttachmentsChange }: AttachmentListProps) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = attachments.findIndex((a) => a.id === active.id)
    const newIndex = attachments.findIndex((a) => a.id === over.id)

    const newAttachments = arrayMove(attachments, oldIndex, newIndex).map((a, i) => ({
      ...a,
      sort_order: i,
    }))

    // Optimistic update
    onAttachmentsChange(newAttachments)

    try {
      await attachmentsApi.reorder(trackId, newAttachments.map((a) => a.id))
    } catch (err) {
      // Revert on error
      setError(err instanceof Error ? err.message : 'Failed to reorder')
    }
  }

  const handleRename = async (id: string, newName: string) => {
    const { attachment: updated } = await attachmentsApi.rename(id, newName)
    onAttachmentsChange(
      attachments.map((a) => (a.id === id ? { ...a, filename: updated.filename } : a))
    )
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this attachment?')) return

    try {
      await attachmentsApi.delete(id)
      onAttachmentsChange(attachments.filter((a) => a.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
    }
  }

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setUploading(true)
    setError('')

    try {
      const { attachment } = await attachmentsApi.upload(trackId, file)
      onAttachmentsChange([...attachments, { ...attachment, sort_order: attachments.length }])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Upload Button */}
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-surface-700 bg-surface-900/50 p-4 text-sm text-surface-400 hover:border-surface-600 hover:text-surface-300 transition-colors disabled:opacity-50"
      >
        {uploading ? (
          <>
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
            Uploading...
          </>
        ) : (
          <>
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Attachment
          </>
        )}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        onChange={handleUpload}
        className="hidden"
        disabled={uploading}
      />

      {/* Attachments List */}
      {attachments.length === 0 ? (
        <p className="py-4 text-center text-surface-500">No attachments yet</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={attachments.map((a) => a.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {attachments.map((attachment) => (
                <SortableAttachment
                  key={attachment.id}
                  attachment={attachment}
                  onRename={handleRename}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  )
}
