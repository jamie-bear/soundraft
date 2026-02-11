import { create } from 'zustand'
import { Howl } from 'howler'

interface Track {
  id: string
  title: string
  versionId: string
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

const API_URL = import.meta.env.VITE_API_URL || '/api'

export const usePlayerStore = create<PlayerState>((set, get) => ({
  currentTrack: null,
  queue: [],
  queueIndex: -1,
  isPlaying: false,
  progress: 0,
  volume: 0.8,
  howl: null,

  playTrack: (track: Track, queue?: Track[]) => {
    const { howl: currentHowl } = get()

    // Stop and unload current track
    if (currentHowl) {
      currentHowl.stop()
      currentHowl.unload()
    }

    // Update queue if provided
    let newQueueIndex = -1
    if (queue && queue.length > 0) {
      newQueueIndex = queue.findIndex((t) => t.id === track.id)
      set({ queue, queueIndex: newQueueIndex })
    } else {
      // Single track, clear queue
      set({ queue: [], queueIndex: -1 })
    }

    // Create new Howl instance for streaming
    const newHowl = new Howl({
      src: [`${API_URL}/stream/${track.versionId}`],
      html5: true, // Required for streaming/seeking
      volume: get().volume,
      onplay: () => {
        set({ isPlaying: true })
        // Start progress update loop
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
      onpause: () => set({ isPlaying: false }),
      onstop: () => set({ isPlaying: false, progress: 0 }),
      onend: () => {
        set({ isPlaying: false, progress: 0 })
        // Auto-play next track if available
        get().playNext()
      },
      onloaderror: (_id, error) => {
        console.error('Audio load error:', error)
      },
    })

    newHowl.play()

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
        // Play next track, keeping the same queue
        const { howl: currentHowl } = get()
        if (currentHowl) {
          currentHowl.stop()
          currentHowl.unload()
        }

        set({ queueIndex: nextIndex })

        const newHowl = new Howl({
          src: [`${API_URL}/stream/${nextTrack.versionId}`],
          html5: true,
          volume: get().volume,
          onplay: () => {
            set({ isPlaying: true })
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
          onpause: () => set({ isPlaying: false }),
          onstop: () => set({ isPlaying: false, progress: 0 }),
          onend: () => {
            set({ isPlaying: false, progress: 0 })
            get().playNext()
          },
          onloaderror: (_id, error) => {
            console.error('Audio load error:', error)
          },
        })

        newHowl.play()
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

      const newHowl = new Howl({
        src: [`${API_URL}/stream/${prevTrack.versionId}`],
        html5: true,
        volume: get().volume,
        onplay: () => {
          set({ isPlaying: true })
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
        onpause: () => set({ isPlaying: false }),
        onstop: () => set({ isPlaying: false, progress: 0 }),
        onend: () => {
          set({ isPlaying: false, progress: 0 })
          get().playNext()
        },
        onloaderror: (_id, error) => {
          console.error('Audio load error:', error)
        },
      })

      newHowl.play()
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
}))
