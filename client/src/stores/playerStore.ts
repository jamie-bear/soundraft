import { create } from 'zustand'
import { Howl, Howler } from 'howler'

interface Track {
  id: string
  title: string
  artist?: string
  versionId: string
  streamUrl: string
  version: number
  duration: number
  coverArt?: string
}

interface PlayerState {
  currentTrack: Track | null
  queue: Track[]
  queueIndex: number
  isPlaying: boolean
  progress: number
  volume: number
  howl: Howl | null

  // Actions
  playTrack: (track: Track, queue?: Track[]) => void
  playNext: () => void
  playPrevious: () => void
  togglePlay: () => void
  pause: () => void
  seek: (progress: number) => void
  setVolume: (volume: number) => void
  setProgress: (progress: number) => void
}

// Ensure Howler auto-unlocks AudioContext on iOS
Howler.autoUnlock = true

/**
 * Update Media Session metadata for lock screen controls.
 * Provides artwork, title, and artist for system media notifications.
 */
function updateMediaSession(track: Track) {
  if (!('mediaSession' in navigator)) return

  const artwork: MediaImage[] = []
  if (track.coverArt) {
    artwork.push(
      { src: track.coverArt, sizes: '96x96', type: 'image/jpeg' },
      { src: track.coverArt, sizes: '256x256', type: 'image/jpeg' },
      { src: track.coverArt, sizes: '512x512', type: 'image/jpeg' },
    )
  }

  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist || `Version ${track.version}`,
    album: 'SoundRaft',
    artwork,
  })
}

function setMediaSessionPlaybackState(state: 'playing' | 'paused' | 'none') {
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = state
  }
}

/**
 * Create a Howl instance with consistent callbacks.
 * Eliminates duplicated Howl construction across playTrack/playNext/playPrevious.
 */
function createHowl(
  track: Track,
  get: () => PlayerState,
  set: (partial: Partial<PlayerState>) => void,
): Howl {
  const howl = new Howl({
    src: [track.streamUrl],
    html5: true,
    volume: get().volume,
    onplay: () => {
      set({ isPlaying: true })
      setMediaSessionPlaybackState('playing')
      requestAnimationFrame(function updateProgress() {
        const h = get().howl
        if (h && h.playing()) {
          const seek = h.seek() as number
          const duration = h.duration()
          if (duration > 0) {
            set({ progress: seek / duration })
          }
          requestAnimationFrame(updateProgress)
        }
      })
    },
    onpause: () => {
      set({ isPlaying: false })
      setMediaSessionPlaybackState('paused')
    },
    onstop: () => {
      set({ isPlaying: false, progress: 0 })
      setMediaSessionPlaybackState('paused')
    },
    onend: () => {
      set({ isPlaying: false, progress: 0 })
      // Auto-play next track — resume AudioContext for iOS
      if (typeof Howler.ctx !== 'undefined' && Howler.ctx.state === 'suspended') {
        Howler.ctx.resume()
      }
      get().playNext()
    },
    onloaderror: (_id, error) => {
      console.error('Audio load error:', error)
    },
  })

  return howl
}

export const usePlayerStore = create<PlayerState>((set, get) => {
  // Register Media Session action handlers once
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => get().togglePlay())
    navigator.mediaSession.setActionHandler('pause', () => get().pause())
    navigator.mediaSession.setActionHandler('previoustrack', () => get().playPrevious())
    navigator.mediaSession.setActionHandler('nexttrack', () => get().playNext())
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime != null) {
        const h = get().howl
        if (h) {
          const duration = h.duration()
          if (duration > 0) {
            h.seek(details.seekTime)
            set({ progress: details.seekTime / duration })
          }
        }
      }
    })
  }

  return {
    currentTrack: null,
    queue: [],
    queueIndex: -1,
    isPlaying: false,
    progress: 0,
    volume: 0.8,
    howl: null,

    playTrack: (track: Track, queue?: Track[]) => {
      const { howl: currentHowl } = get()

      if (currentHowl) {
        currentHowl.stop()
        currentHowl.unload()
      }

      let newQueueIndex = -1
      if (queue && queue.length > 0) {
        newQueueIndex = queue.findIndex((t) => t.id === track.id)
        set({ queue, queueIndex: newQueueIndex })
      } else {
        set({ queue: [], queueIndex: -1 })
      }

      const newHowl = createHowl(track, get, set)
      newHowl.play()

      updateMediaSession(track)

      set({
        currentTrack: track,
        howl: newHowl,
        progress: 0,
      })
    },

    playNext: () => {
      const { queue, queueIndex } = get()
      if (queue.length === 0 || queueIndex < 0) return

      const nextIndex = queueIndex + 1
      if (nextIndex < queue.length) {
        const nextTrack = queue[nextIndex]
        if (nextTrack.versionId) {
          const { howl: currentHowl } = get()
          if (currentHowl) {
            currentHowl.stop()
            currentHowl.unload()
          }

          set({ queueIndex: nextIndex })

          const newHowl = createHowl(nextTrack, get, set)
          newHowl.play()

          updateMediaSession(nextTrack)
          set({ currentTrack: nextTrack, howl: newHowl, progress: 0 })
        }
      }
    },

    playPrevious: () => {
      const { queue, queueIndex, progress, currentTrack } = get()

      // If more than 3 seconds into the track, restart it
      if (currentTrack && progress * (currentTrack.duration || 0) > 3) {
        get().seek(0)
        return
      }

      if (queue.length === 0 || queueIndex <= 0) return

      const prevIndex = queueIndex - 1
      const prevTrack = queue[prevIndex]
      if (prevTrack.versionId) {
        const { howl: currentHowl } = get()
        if (currentHowl) {
          currentHowl.stop()
          currentHowl.unload()
        }

        set({ queueIndex: prevIndex })

        const newHowl = createHowl(prevTrack, get, set)
        newHowl.play()

        updateMediaSession(prevTrack)
        set({ currentTrack: prevTrack, howl: newHowl, progress: 0 })
      }
    },

    togglePlay: () => {
      const { howl, isPlaying } = get()
      if (!howl) return

      if (isPlaying) {
        howl.pause()
      } else {
        howl.play()
      }
    },

    pause: () => {
      const { howl } = get()
      if (howl) {
        howl.pause()
      }
    },

    seek: (progress: number) => {
      const { howl, currentTrack } = get()
      if (!howl || !currentTrack) return

      const duration = howl.duration()
      if (duration > 0) {
        howl.seek(progress * duration)
        set({ progress })
      }
    },

    setVolume: (volume: number) => {
      const { howl } = get()
      if (howl) {
        howl.volume(volume)
      }
      set({ volume })
    },

    setProgress: (progress: number) => {
      set({ progress })
    },
  }
})
