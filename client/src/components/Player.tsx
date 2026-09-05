import { useState } from 'react'
import { usePlayerStore } from '../stores/playerStore'

export default function Player() {
  const { status, error, retry, currentTrack, queue, queueIndex, isPlaying, progress, volume, togglePlay, seek, setVolume, playNext, playPrevious } = usePlayerStore()
  const [showVolume, setShowVolume] = useState(false)

  const hasNext = queue.length > 0 && queueIndex >= 0 && queueIndex < queue.length - 1
  const hasPrevious = queue.length > 0 && queueIndex > 0

  // Format time as MM:SS
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  return (
    <footer className="shrink-0 border-t border-surface-800 bg-surface-900 px-3 sm:px-4 py-2 sm:py-3">
      <div role="status" aria-live="polite" className="text-sm text-surface-300">
        {status === 'loading' ? 'Buffering audio…' : error}
        {(status === 'error' || status === 'offline') && <button onClick={retry} className="ml-3 underline">Retry playback</button>}
      </div>
      {/* Mobile layout (stacked) */}
      <div className="flex flex-col gap-2 sm:hidden">
        {/* Top row: track info + play controls */}
        <div className="flex items-center gap-3">
          {/* Track info */}
          <div className="flex flex-1 items-center gap-3 min-w-0">
            {currentTrack ? (
              <>
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-surface-700">
                  {currentTrack.coverArt ? (
                    <img src={currentTrack.coverArt} alt="" className="h-full w-full rounded object-cover" />
                  ) : (
                    <svg className="h-5 w-5 text-surface-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                    </svg>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white">{currentTrack.title}</p>
                  <p className="truncate text-xs text-surface-400">Version {currentTrack.version}</p>
                </div>
              </>
            ) : (
              <p className="text-sm text-surface-400">No track selected</p>
            )}
          </div>

          {/* Play controls (compact) + mobile volume toggle */}
          <div className="flex items-center gap-1">
            <button
              aria-label="Show volume" onClick={() => setShowVolume(!showVolume)}
              className="flex h-11 w-11 items-center justify-center rounded-full active:bg-surface-700 text-surface-400 hover:text-white sm:hidden"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
              </svg>
            </button>
            <button
              aria-label="Previous track" onClick={playPrevious}
              disabled={!currentTrack}
              className={`flex h-11 w-11 items-center justify-center rounded-full active:bg-surface-700 ${hasPrevious ? 'text-surface-400 hover:text-white' : 'text-surface-600'}`}
            >
              <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
              </svg>
            </button>
            <button
              aria-label={isPlaying ? "Pause" : "Play"} onClick={togglePlay}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-surface-900 hover:scale-105 active:scale-95 transition-transform"
              disabled={!currentTrack}
            >
              {isPlaying ? (
                <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                </svg>
              ) : (
                <svg className="h-5 w-5 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>
            <button
              aria-label="Next track" onClick={playNext}
              disabled={!hasNext}
              className={`flex h-11 w-11 items-center justify-center rounded-full active:bg-surface-700 ${hasNext ? 'text-surface-400 hover:text-white' : 'text-surface-600'}`}
            >
              <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
              </svg>
            </button>
          </div>
        </div>

        {/* Mobile volume slider (toggle) */}
        {showVolume && (
          <div className="flex items-center gap-2 px-1 sm:hidden">
            <svg className="h-4 w-4 text-surface-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
            </svg>
            <input
              aria-label="Volume" type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              className="min-w-0 flex-1 h-1 bg-surface-700 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
              style={{ touchAction: 'none' }}
            />
          </div>
        )}

        {/* Bottom row: progress bar — larger touch target */}
        <div className="flex items-center gap-2">
          <span className="w-9 text-right text-xs text-surface-400 tabular-nums">
            {formatTime(progress * (currentTrack?.duration || 0))}
          </span>
          <div className="min-w-0 flex-1 py-2" style={{ touchAction: 'none' }}>
            <input
              aria-label="Playback position" type="range"
              min="0"
              max="1"
              step="0.001"
              value={progress}
              onChange={(e) => seek(parseFloat(e.target.value))}
              className="w-full h-1 bg-surface-700 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
              disabled={!currentTrack}
            />
          </div>
          <span className="w-9 text-xs text-surface-400 tabular-nums">
            {formatTime(currentTrack?.duration || 0)}
          </span>
        </div>
      </div>

      {/* Desktop layout (horizontal) */}
      <div className="hidden sm:flex items-center gap-4">
        {/* Track info */}
        <div className="flex min-w-0 w-64 items-center gap-3">
          {currentTrack ? (
            <>
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-surface-700">
                {currentTrack.coverArt ? (
                  <img src={currentTrack.coverArt} alt="" className="h-full w-full rounded object-cover" />
                ) : (
                  <svg className="h-6 w-6 text-surface-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                  </svg>
                )}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white">{currentTrack.title}</p>
                <p className="truncate text-xs text-surface-400">Version {currentTrack.version}</p>
              </div>
            </>
          ) : (
            <p className="text-sm text-surface-400">No track selected</p>
          )}
        </div>

        {/* Playback controls */}
        <div className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <div className="flex items-center gap-4">
            {/* Previous */}
            <button
              aria-label="Previous track" onClick={playPrevious}
              disabled={!currentTrack}
              className={hasPrevious ? 'text-surface-400 hover:text-white' : 'text-surface-600'}
            >
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
              </svg>
            </button>

            {/* Play/Pause */}
            <button
              aria-label={isPlaying ? "Pause" : "Play"} onClick={togglePlay}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-surface-900 hover:scale-105 transition-transform"
              disabled={!currentTrack}
            >
              {isPlaying ? (
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                </svg>
              ) : (
                <svg className="h-4 w-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            {/* Next */}
            <button
              aria-label="Next track" onClick={playNext}
              disabled={!hasNext}
              className={hasNext ? 'text-surface-400 hover:text-white' : 'text-surface-600'}
            >
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
              </svg>
            </button>
          </div>

          {/* Progress bar */}
          <div className="flex w-full max-w-xl items-center gap-2">
            <span className="w-10 text-right text-xs text-surface-400">
              {formatTime(progress * (currentTrack?.duration || 0))}
            </span>
            <input
              aria-label="Playback position" type="range"
              min="0"
              max="1"
              step="0.001"
              value={progress}
              onChange={(e) => seek(parseFloat(e.target.value))}
              className="min-w-0 flex-1 h-1 bg-surface-700 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
              disabled={!currentTrack}
            />
            <span className="w-10 text-xs text-surface-400">
              {formatTime(currentTrack?.duration || 0)}
            </span>
          </div>
        </div>

        {/* Volume control */}
        <div className="flex w-32 shrink-0 items-center gap-2">
          <svg className="h-5 w-5 shrink-0 text-surface-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
          </svg>
          <input
            aria-label="Volume" type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            className="min-w-0 flex-1 h-1 bg-surface-700 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
          />
        </div>
      </div>
    </footer>
  )
}
