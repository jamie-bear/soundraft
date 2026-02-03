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
  isPlaying: boolean
  progress: number
  volume: number
  howl: Howl | null
  
  // Actions
  playTrack: (track: Track) => void
  togglePlay: () => void
  pause: () => void
  seek: (progress: number) => void
  setVolume: (volume: number) => void
  setProgress: (progress: number) => void
}

const API_URL = import.meta.env.VITE_API_URL || '/api'

export const usePlayerStore = create<PlayerState>((set, get) => ({
  currentTrack: null,
  isPlaying: false,
  progress: 0,
  volume: 0.8,
  howl: null,

  playTrack: (track: Track) => {
    const { howl: currentHowl } = get()
    
    // Stop and unload current track
    if (currentHowl) {
      currentHowl.stop()
      currentHowl.unload()
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
      onend: () => set({ isPlaying: false, progress: 0 }),
      onloaderror: (id, error) => {
        console.error('Audio load error:', error)
      }
    })

    newHowl.play()
    
    set({
      currentTrack: track,
      howl: newHowl,
      progress: 0
    })
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
  }
}))
