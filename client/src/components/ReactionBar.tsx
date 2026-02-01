import { useState, useEffect } from 'react'
import { reactionsApi, ReactionCounts, EmojiType } from '../lib/api'

interface ReactionBarProps {
  entityType: 'track' | 'playlist'
  entityId: string
}

// Emoji definitions matching the Unicode spec from the screenshot
const EMOJIS: { type: EmojiType; emoji: string; label: string }[] = [
  { type: 'heart', emoji: '\u2764\uFE0F', label: 'Red Heart' },        // U+2764 U+FE0F - Heavy Black Heart + Variation Selector-16
  { type: 'fire', emoji: '\uD83D\uDD25', label: 'Fire' },              // U+1F525 - Fire
  { type: 'laugh', emoji: '\uD83E\uDD23', label: 'Rolling on the Floor Laughing' }, // U+1F923 - ROFL
  { type: 'cry', emoji: '\uD83D\uDE2D', label: 'Loudly Crying Face' }, // U+1F62D - Loudly Crying Face
]

export default function ReactionBar({ entityType, entityId }: ReactionBarProps) {
  const [counts, setCounts] = useState<ReactionCounts>({
    heart: 0,
    fire: 0,
    laugh: 0,
    cry: 0,
  })
  const [myReaction, setMyReaction] = useState<EmojiType | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const visitorId = reactionsApi.getVisitorId()

  useEffect(() => {
    loadReactions()
  }, [entityId, entityType])

  const loadReactions = async () => {
    try {
      setLoading(true)
      const { counts: reactionCounts, visitorReaction } =
        entityType === 'track'
          ? await reactionsApi.getTrackReactions(entityId, visitorId)
          : await reactionsApi.getPlaylistReactions(entityId, visitorId)

      setCounts(reactionCounts)
      setMyReaction(visitorReaction)
    } catch (err) {
      console.error('Failed to load reactions:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleReaction = async (emojiType: EmojiType) => {
    if (submitting) return

    setSubmitting(true)

    try {
      // If clicking the same reaction, remove it
      if (myReaction === emojiType) {
        if (entityType === 'track') {
          await reactionsApi.removeTrackReaction(entityId, visitorId)
        } else {
          await reactionsApi.removePlaylistReaction(entityId, visitorId)
        }
        // Optimistic update: decrement the old reaction
        setCounts((prev) => ({
          ...prev,
          [emojiType]: Math.max(0, prev[emojiType] - 1),
        }))
        setMyReaction(null)
      } else {
        // Adding a new reaction (or changing)
        if (entityType === 'track') {
          await reactionsApi.addTrackReaction(entityId, emojiType, visitorId)
        } else {
          await reactionsApi.addPlaylistReaction(entityId, emojiType, visitorId)
        }
        // Optimistic update
        setCounts((prev) => {
          const updated = { ...prev }
          // Decrement old reaction if exists
          if (myReaction) {
            updated[myReaction] = Math.max(0, updated[myReaction] - 1)
          }
          // Increment new reaction
          updated[emojiType] = updated[emojiType] + 1
          return updated
        })
        setMyReaction(emojiType)
      }
    } catch (err) {
      console.error('Failed to update reaction:', err)
      // Reload to get correct state
      loadReactions()
    } finally {
      setSubmitting(false)
    }
  }

  const formatCount = (count: number): string => {
    if (count >= 1000000) {
      return `${(count / 1000000).toFixed(1)}M`
    }
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}K`
    }
    return count.toString()
  }

  const totalReactions = counts.heart + counts.fire + counts.laugh + counts.cry

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2">
        <div className="h-8 w-32 animate-pulse rounded-full bg-surface-800" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Reaction buttons */}
      <div className="flex items-center gap-2">
        {EMOJIS.map(({ type, emoji, label }) => {
          const count = counts[type]
          const isActive = myReaction === type

          return (
            <button
              key={type}
              onClick={() => handleReaction(type)}
              disabled={submitting}
              title={`${label}${count > 0 ? ` (${count})` : ''}`}
              className={`
                group relative flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm
                transition-all duration-200
                ${
                  isActive
                    ? 'bg-primary-600/20 ring-2 ring-primary-500/50'
                    : 'bg-surface-800 hover:bg-surface-700'
                }
                ${submitting ? 'cursor-wait opacity-70' : 'cursor-pointer'}
              `}
            >
              <span
                className={`text-lg transition-transform duration-200 ${
                  isActive ? 'scale-110' : 'group-hover:scale-110'
                }`}
              >
                {emoji}
              </span>
              {count > 0 && (
                <span
                  className={`font-medium tabular-nums ${
                    isActive ? 'text-primary-400' : 'text-surface-400'
                  }`}
                >
                  {formatCount(count)}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Summary text */}
      {totalReactions > 0 && (
        <p className="text-xs text-surface-500">
          {totalReactions} {totalReactions === 1 ? 'reaction' : 'reactions'}
          {myReaction && ' (including yours)'}
        </p>
      )}
    </div>
  )
}
