import { create } from 'zustand'
import { Howl, Howler } from 'howler'
import { ApiError, mediaApi } from '../lib/api'

type Share = { type: 'track' | 'playlist'; token: string }
interface Track {
  id: string; title: string; artist?: string; versionId: string; streamUrl: string
  version: number; duration: number; coverArt?: string; share?: Share
}
interface PlayerState {
  currentTrack: Track | null; queue: Track[]; queueIndex: number; isPlaying: boolean
  progress: number; volume: number; howl: Howl | null
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'offline' | 'error'; error: string
  playTrack: (track: Track, queue?: Track[]) => void
  playNext: () => void; playPrevious: () => void; togglePlay: () => void; pause: () => void
  seek: (progress: number) => void; setVolume: (volume: number) => void; setProgress: (progress: number) => void
  retry: () => void
}
Howler.autoUnlock = true

// This is only a scheduling hint. Authorization always happens on the server.
export function expiresSoon(url: string): boolean {
  try {
    const token = new URL(url, window.location.origin).searchParams.get('grant')!
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(part))
    return !Number.isFinite(payload.exp) || payload.exp * 1000 - Date.now() < 30_000
  } catch { return true }
}
function currentShare(): Share | undefined {
  const match = /^\/share\/(track|playlist)\/([^/]+)$/.exec(window.location.pathname)
  return match ? { type: match[1] as Share['type'], token: decodeURIComponent(match[2]) } : undefined
}

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


export const usePlayerStore = create<PlayerState>((set, get) => {
  let generation = 0
  let progressFrame = 0
  let retrying = false
  let desiredPlaying = false

  function stopOld() {
    cancelAnimationFrame(progressFrame)
    get().howl?.unload()
    set({ howl: null, isPlaying: false })
  }
  async function start(track: Track, position = 0, renew = false, automatic = false) {
    const sequence = ++generation
    stopOld()
    desiredPlaying = true
    set({ currentTrack: track, progress: position, status: navigator.onLine ? 'loading' : 'offline', error: '' })
    try {
      if (!navigator.onLine) throw new Error('You are offline. Reconnect and retry playback.')
      if (renew || expiresSoon(track.streamUrl)) {
        const result = await mediaApi.renew(track.versionId, track.share)
        track = { ...track, streamUrl: result.stream_url }
      }
      if (sequence !== generation) return
      set({ currentTrack: track })
      const howl = new Howl({
        // Signed routes have no filename extension; HTML audio detects the actual MIME type.
        src: [track.streamUrl], format: ['mp3', 'wav'], html5: true, volume: get().volume,
        onload: () => {
          if (sequence !== generation) return
          if (position > 0) howl.seek(position * howl.duration())
          if (desiredPlaying) howl.play()
          else set({ status: 'paused' })
        },
        onplay: () => {
          if (sequence !== generation) return
          retrying = false
          set({ isPlaying: true, status: 'playing', error: '' })
          setMediaSessionPlaybackState('playing')
          cancelAnimationFrame(progressFrame)
          let last = 0
          const tick = (now: number) => {
            if (sequence !== generation || !howl.playing()) return
            if (now - last > 200 && howl.duration() > 0) {
              set({ progress: Number(howl.seek()) / howl.duration() }); last = now
            }
            progressFrame = requestAnimationFrame(tick)
          }
          progressFrame = requestAnimationFrame(tick)
        },
        onpause: () => {
          if (sequence !== generation) return
          set({ isPlaying: false, status: 'paused' }); setMediaSessionPlaybackState('paused')
        },
        onend: () => {
          if (sequence !== generation) return
          set({ isPlaying: false, progress: 0, status: 'paused' }); get().playNext()
        },
        onloaderror: () => {
          if (sequence !== generation) return
          if (!automatic && navigator.onLine) { void start(track, get().progress, true, true); return }
          retrying = false
          set({ isPlaying: false, status: navigator.onLine ? 'error' : 'offline', error: 'Audio could not load. Check your connection and retry.' })
        },
        onplayerror: () => {
          if (sequence !== generation) return
          retrying = false
          set({ isPlaying: false, status: 'error', error: 'Playback was interrupted. Press Retry to continue.' })
        },
      })
      set({ howl })
      updateMediaSession(track)
    } catch (error) {
      if (sequence !== generation) return
      retrying = false
      set({ isPlaying: false, status: navigator.onLine ? 'error' : 'offline', error: error instanceof ApiError || error instanceof Error ? error.message : 'Playback failed' })
    }
  }
  const retry = () => {
    const { currentTrack, progress } = get()
    if (currentTrack && !retrying) { retrying = true; void start(currentTrack, progress, true, true) }
  }
  window.addEventListener('offline', () => {
    if (get().currentTrack) { get().pause(); set({ status: 'offline', error: 'You are offline. Reconnect and retry playback.' }) }
  })
  window.addEventListener('online', () => {
    if (get().status === 'offline') set({ status: 'error', error: 'You are back online. Retry to resume playback.' })
  })
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => { if (!get().isPlaying) get().togglePlay() })
    navigator.mediaSession.setActionHandler('pause', () => get().pause())
    navigator.mediaSession.setActionHandler('nexttrack', () => get().playNext())
    navigator.mediaSession.setActionHandler('previoustrack', () => get().playPrevious())
    navigator.mediaSession.setActionHandler('seekto', details => {
      if (details.seekTime != null && get().currentTrack?.duration) get().seek(details.seekTime / get().currentTrack!.duration)
    })
  }
  return {
    currentTrack: null, queue: [], queueIndex: -1, isPlaying: false, progress: 0, volume: 0.8, howl: null, status: 'idle', error: '',
    playTrack: (track, queue) => {
      const share = track.share || currentShare()
      const items = (queue || []).map(item => ({ ...item, share: item.share || share }))
      set({ queue: items, queueIndex: items.findIndex(item => item.versionId === track.versionId) })
      retrying = false
      void start({ ...track, share })
    },
    playNext: () => {
      const { queue, queueIndex } = get()
      if (queueIndex >= 0 && queueIndex + 1 < queue.length) {
        set({ queueIndex: queueIndex + 1 }); void start(queue[queueIndex + 1])
      }
    },
    playPrevious: () => {
      const { queue, queueIndex, progress, currentTrack } = get()
      if (currentTrack && progress * currentTrack.duration > 3) { get().seek(0); return }
      if (queueIndex > 0) { set({ queueIndex: queueIndex - 1 }); void start(queue[queueIndex - 1]) }
    },
    togglePlay: () => {
      const { howl, currentTrack, isPlaying, status, progress } = get()
      if (!currentTrack) return
      if (isPlaying || status === 'loading') { get().pause(); return }
      if (status === 'error' || status === 'offline' || expiresSoon(currentTrack.streamUrl)) { retry(); return }
      desiredPlaying = true
      if (howl) howl.play(); else void start(currentTrack, progress)
    },
    pause: () => { desiredPlaying = false; get().howl?.pause(); set({ isPlaying: false, status: 'paused' }) },
    seek: value => {
      const progress = Math.max(0, Math.min(1, value))
      const { currentTrack, howl, isPlaying } = get()
      if (!currentTrack) return
      if (expiresSoon(currentTrack.streamUrl)) {
        void start(currentTrack, progress, true); desiredPlaying = isPlaying
      } else if (howl && howl.duration() > 0) howl.seek(progress * howl.duration())
      set({ progress })
    },
    setVolume: volume => { const bounded = Math.max(0, Math.min(1, volume)); get().howl?.volume(bounded); set({ volume: bounded }) },
    setProgress: progress => set({ progress }), retry,
  }
})
