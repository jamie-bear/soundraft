// Auto-detect API URL based on where the app is accessed from
function getApiUrl(): string {
  // Check for environment variable first (can still be overridden if needed)
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL
  }

  // SSR/build-time fallback
  if (typeof window === 'undefined') {
    return '/api'
  }
  
  // Use relative path - Vite dev server will proxy to backend
  // In production, your reverse proxy/tunnel should route /api to backend
  return '/api'
}

const API_URL = getApiUrl()

// Helper to get full URL for assets (cover art, etc.)
export function getAssetUrl(path: string | undefined | null): string | undefined {
  if (!path) return undefined
  // If it's already a full URL, return as-is
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path
  }
  // Relative paths work directly through Vite proxy (dev) or reverse proxy (prod)
  return path
}

interface RequestOptions extends RequestInit {
  auth?: boolean
}

class ApiError extends Error {
  status: number
  
  constructor(message: string, status: number) {
    super(message)
    this.status = status
    this.name = 'ApiError'
  }
}

async function request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const { auth = true, ...fetchOptions } = options
  
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...fetchOptions.headers,
  }

  // Add auth token if required
  if (auth) {
    const token = localStorage.getItem('token')
    if (token) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`
    }
  }

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...fetchOptions,
    headers,
  })

  // Handle non-JSON responses
  const contentType = response.headers.get('content-type')
  if (!contentType || !contentType.includes('application/json')) {
    if (!response.ok) {
      throw new ApiError('Request failed', response.status)
    }
    return {} as T
  }

  const data = await response.json()

  if (!response.ok) {
    throw new ApiError(data.error || 'Request failed', response.status)
  }

  return data
}

// Auth API
export const authApi = {
  login: (email: string, password: string) =>
    request<{ user: User; token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      auth: false,
    }),

  register: (email: string, password: string) =>
    request<{ user: User; token: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      auth: false,
    }),

  me: () => request<{ user: User }>('/auth/me'),
}

// Tracks API
export const tracksApi = {
  list: () => request<{ tracks: Track[] }>('/tracks'),

  get: (id: string, token?: string) =>
    request<{ track: Track; isOwner: boolean }>(
      `/tracks/${id}${token ? `?token=${token}` : ''}`
    ),

  create: (data: { title: string; status?: string; type?: string }) =>
    request<{ track: Track }>('/tracks', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Partial<Track>) =>
    request<{ track: Track }>(`/tracks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    request<{ success: boolean }>(`/tracks/${id}`, { method: 'DELETE' }),

  getVersions: (id: string) =>
    request<{ versions: TrackVersion[] }>(`/tracks/${id}/versions`),

  uploadVersion: async (
    id: string,
    file: File,
    onProgress?: (progress: number) => void
  ): Promise<{ version: TrackVersion }> => {
    const formData = new FormData()
    formData.append('audio', file)

    const token = localStorage.getItem('token')

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()

      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && onProgress) {
          const progress = Math.round((event.loaded / event.total) * 100)
          onProgress(progress)
        }
      })

      xhr.addEventListener('load', () => {
        try {
          const data = JSON.parse(xhr.responseText)
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(data as { version: TrackVersion })
          } else {
            reject(new ApiError(data.error || 'Upload failed', xhr.status))
          }
        } catch {
          reject(new ApiError('Upload failed', xhr.status))
        }
      })

      xhr.addEventListener('error', () => {
        reject(new ApiError('Upload failed', 0))
      })

      xhr.open('POST', `${API_URL}/tracks/${id}/versions`)
      xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      xhr.send(formData)
    })
  },

  share: (id: string, makePublic: boolean) =>
    request<{ shareToken: string; releaseStatus: string }>(`/tracks/${id}/share`, {
      method: 'POST',
      body: JSON.stringify({ makePublic }),
    }),

  // Version management
  renameVersion: (trackId: string, versionId: string, filename: string) =>
    request<{ version: TrackVersion }>(`/tracks/${trackId}/versions/${versionId}`, {
      method: 'PUT',
      body: JSON.stringify({ filename }),
    }),

  activateVersion: (trackId: string, versionId: string) =>
    request<{ track: Track }>(`/tracks/${trackId}/versions/${versionId}/activate`, {
      method: 'PUT',
    }),

  deleteVersion: (trackId: string, versionId: string) =>
    request<{ success: boolean }>(`/tracks/${trackId}/versions/${versionId}`, {
      method: 'DELETE',
    }),

  getVersionDownloadUrl: (trackId: string, versionId: string) => {
    const token = localStorage.getItem('token')
    return `${API_URL}/tracks/${trackId}/versions/${versionId}/download?auth=${token}`
  },

  uploadCover: async (id: string, file: File) => {
    const formData = new FormData()
    formData.append('cover', file)

    const token = localStorage.getItem('token')
    const response = await fetch(`${API_URL}/tracks/${id}/cover`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    })

    const data = await response.json()
    if (!response.ok) {
      throw new ApiError(data.error || 'Upload failed', response.status)
    }
    return data as { track: Track }
  },

  deleteCover: (id: string) =>
    request<{ track: Track }>(`/tracks/${id}/cover`, { method: 'DELETE' }),
}

// Playlists API
export interface PlaylistWithTrackInfo extends Playlist {
  contains_track?: boolean
}

export const playlistsApi = {
  list: (forTrack?: string) => 
    request<{ playlists: PlaylistWithTrackInfo[] }>(
      `/playlists${forTrack ? `?forTrack=${forTrack}` : ''}`
    ),

  get: (id: string, token?: string) =>
    request<{ playlist: Playlist; tracks: Track[]; isOwner: boolean }>(
      `/playlists/${id}${token ? `?token=${token}` : ''}`
    ),

  create: (data: { title: string; type?: string }) =>
    request<{ playlist: Playlist }>('/playlists', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Partial<Playlist>) =>
    request<{ playlist: Playlist }>(`/playlists/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    request<{ success: boolean }>(`/playlists/${id}`, { method: 'DELETE' }),

  addTrack: (id: string, trackId: string) =>
    request<{ success: boolean }>(`/playlists/${id}/tracks`, {
      method: 'POST',
      body: JSON.stringify({ trackId }),
    }),

  removeTrack: (id: string, trackId: string) =>
    request<{ success: boolean }>(`/playlists/${id}/tracks/${trackId}`, {
      method: 'DELETE',
    }),

  reorder: (id: string, trackIds: string[]) =>
    request<{ success: boolean }>(`/playlists/${id}/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ trackIds }),
    }),

  duplicate: (id: string) =>
    request<{ playlist: Playlist }>(`/playlists/${id}/duplicate`, {
      method: 'POST',
    }),

  uploadCover: async (id: string, file: File) => {
    const formData = new FormData()
    formData.append('cover', file)

    const token = localStorage.getItem('token')
    const response = await fetch(`${API_URL}/playlists/${id}/cover`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    })

    const data = await response.json()
    if (!response.ok) {
      throw new ApiError(data.error || 'Upload failed', response.status)
    }
    return data as { playlist: Playlist }
  },

  deleteCover: (id: string) =>
    request<{ playlist: Playlist }>(`/playlists/${id}/cover`, { method: 'DELETE' }),

  share: (id: string, makePublic: boolean) =>
    request<{ shareToken: string; isPublic: boolean }>(`/playlists/${id}/share`, {
      method: 'POST',
      body: JSON.stringify({ makePublic }),
    }),
}

// Comments API
export const commentsApi = {
  // Track comments
  listTrackComments: (trackId: string, token?: string) =>
    request<{ comments: Comment[]; canPost: boolean; commentsHidden?: boolean }>(
      `/comments/track/${trackId}${token ? `?token=${token}` : ''}`
    ),

  createTrackComment: (trackId: string, body: string, audioTimestamp?: number, token?: string) =>
    request<{ comment: Comment }>(`/comments/track/${trackId}`, {
      method: 'POST',
      body: JSON.stringify({ body, audioTimestamp, token }),
    }),

  // Playlist comments
  listPlaylistComments: (playlistId: string, token?: string) =>
    request<{ comments: Comment[]; canPost: boolean; commentsHidden?: boolean }>(
      `/comments/playlist/${playlistId}${token ? `?token=${token}` : ''}`
    ),

  createPlaylistComment: (playlistId: string, body: string, token?: string) =>
    request<{ comment: Comment }>(`/comments/playlist/${playlistId}`, {
      method: 'POST',
      body: JSON.stringify({ body, token }),
    }),

  // Delete (works for both)
  delete: (id: string) =>
    request<{ success: boolean }>(`/comments/${id}`, { method: 'DELETE' }),
}

// Attachments API
export const attachmentsApi = {
  list: (trackId: string) =>
    request<{ attachments: Attachment[] }>(`/attachments/track/${trackId}`),

  upload: async (trackId: string, file: File) => {
    const formData = new FormData()
    formData.append('file', file)

    const token = localStorage.getItem('token')
    const response = await fetch(`${API_URL}/attachments/track/${trackId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    })

    const data = await response.json()
    if (!response.ok) {
      throw new ApiError(data.error || 'Upload failed', response.status)
    }
    return data as { attachment: Attachment }
  },

  getDownloadUrl: (id: string) => {
    const token = localStorage.getItem('token')
    return `${API_URL}/attachments/${id}/download?auth=${token}`
  },

  rename: (id: string, filename: string) =>
    request<{ attachment: Attachment }>(`/attachments/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ filename }),
    }),

  reorder: (trackId: string, attachmentIds: string[]) =>
    request<{ success: boolean }>(`/attachments/track/${trackId}/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ attachmentIds }),
    }),

  delete: (id: string) =>
    request<{ success: boolean }>(`/attachments/${id}`, { method: 'DELETE' }),
}

// Admin API
export const adminApi = {
  // Users
  listUsers: (params?: { search?: string; page?: number; limit?: number }) => {
    const query = new URLSearchParams()
    if (params?.search) query.set('search', params.search)
    if (params?.page) query.set('page', params.page.toString())
    if (params?.limit) query.set('limit', params.limit.toString())
    const queryStr = query.toString()
    return request<{ users: AdminUser[]; total: number; page: number; limit: number }>(
      `/admin/users${queryStr ? `?${queryStr}` : ''}`
    )
  },

  getUser: (id: string) =>
    request<{ user: AdminUser }>(`/admin/users/${id}`),

  updateUser: (id: string, data: { role?: string; is_active?: boolean }) =>
    request<{ user: AdminUser }>(`/admin/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  deleteUser: (id: string) =>
    request<{ success: boolean }>(`/admin/users/${id}`, { method: 'DELETE' }),

  // Stats
  getStats: () =>
    request<{
      users: { total: number; active: number; admins: number }
      content: { tracks: number; playlists: number }
      storage: { audio: number; attachments: number; total: number }
    }>('/admin/stats'),

  // Settings
  getSettings: () =>
    request<{ settings: Record<string, string> }>('/admin/settings'),

  updateSettings: (settings: Record<string, string>) =>
    request<{ success: boolean }>('/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings }),
    }),

  // Invitations
  listInvitations: () =>
    request<{ invitations: Invitation[] }>('/admin/invitations'),

  createInvitation: (email: string) =>
    request<{ invitation: Invitation }>('/admin/invitations', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  deleteInvitation: (id: string) =>
    request<{ success: boolean }>(`/admin/invitations/${id}`, { method: 'DELETE' }),
}

// Types
export interface User {
  id: string
  email: string
  role: 'USER' | 'ADMIN'
  created_at?: string
}

export interface AdminUser extends User {
  is_active: boolean
  last_login_at: string | null
  track_count: number
  playlist_count: number
  total_storage_bytes: number
}

export interface Invitation {
  id: string
  email: string
  token: string
  expires_at: string
  accepted_at: string | null
  created_at: string
  invited_by_email?: string
}

export interface Track {
  id: string
  owner_id: string
  title: string
  artist?: string
  status: 'POC' | 'DRAFT' | 'WIP' | 'FINAL'
  type: 'RELEASE' | 'RADIO_MIX' | 'ALT_MIX'
  release_status: 'PRIVATE' | 'PUBLIC'
  comment_access: 'PRIVATE' | 'PUBLIC_VIEW' | 'PUBLIC_FULL'
  cover_art_path?: string
  current_version_id?: string
  stream_url?: string
  share_token?: string
  duration_seconds?: number
  current_version_number?: number
  created_at: string
  updated_at: string
}

export interface TrackVersion {
  id: string
  track_id: string
  version_number: number
  filename: string
  storage_key: string
  mime_type: string
  size_bytes: number
  duration_seconds: number
  created_at: string
  stream_url?: string
}

export interface Playlist {
  id: string
  owner_id: string
  title: string
  artist?: string
  type: 'ALBUM' | 'EP' | 'SINGLE' | 'PLAYLIST'
  cover_art_path?: string
  is_public: boolean
  comment_access: 'PRIVATE' | 'PUBLIC_VIEW' | 'PUBLIC_FULL'
  share_token?: string
  track_count?: number
  created_at: string
}

export interface Comment {
  id: string
  user_id?: string
  user_email?: string
  track_id?: string
  playlist_id?: string
  body: string
  audio_timestamp?: number
  created_at: string
}

export interface Attachment {
  id: string
  track_id: string
  filename: string
  size_bytes: number
  sort_order: number
  created_at: string
}

// Reactions API
export type EmojiType = 'heart' | 'fire' | 'laugh' | 'cry'

export interface ReactionCounts {
  heart: number
  fire: number
  laugh: number
  cry: number
}

export const reactionsApi = {
  // Get visitor ID (creates one if doesn't exist)
  getVisitorId: (): string => {
    let visitorId = localStorage.getItem('soundraft_visitor_id')
    if (!visitorId) {
      visitorId = crypto.randomUUID().replace(/-/g, '')
      localStorage.setItem('soundraft_visitor_id', visitorId)
    }
    return visitorId
  },

  // Track reactions
  getTrackReactions: (trackId: string, visitorId?: string, token?: string) =>
    request<{ counts: ReactionCounts; visitorReaction: EmojiType | null }>(
      `/reactions/track/${trackId}?${new URLSearchParams({
        ...(visitorId ? { visitorId } : {}),
        ...(token ? { token } : {}),
      }).toString()}`
    ),

  addTrackReaction: (trackId: string, emojiType: EmojiType, visitorId: string, token?: string) =>
    request<{ success: boolean; emojiType: EmojiType }>(`/reactions/track/${trackId}`, {
      method: 'POST',
      body: JSON.stringify({ visitorId, emojiType, token }),
    }),

  removeTrackReaction: (trackId: string, visitorId: string, token?: string) =>
    request<{ success: boolean }>(`/reactions/track/${trackId}`, {
      method: 'DELETE',
      body: JSON.stringify({ visitorId, token }),
    }),

  // Playlist reactions
  getPlaylistReactions: (playlistId: string, visitorId?: string, token?: string) =>
    request<{ counts: ReactionCounts; visitorReaction: EmojiType | null }>(
      `/reactions/playlist/${playlistId}?${new URLSearchParams({
        ...(visitorId ? { visitorId } : {}),
        ...(token ? { token } : {}),
      }).toString()}`
    ),

  addPlaylistReaction: (playlistId: string, emojiType: EmojiType, visitorId: string, token?: string) =>
    request<{ success: boolean; emojiType: EmojiType }>(`/reactions/playlist/${playlistId}`, {
      method: 'POST',
      body: JSON.stringify({ visitorId, emojiType, token }),
    }),

  removePlaylistReaction: (playlistId: string, visitorId: string, token?: string) =>
    request<{ success: boolean }>(`/reactions/playlist/${playlistId}`, {
      method: 'DELETE',
      body: JSON.stringify({ visitorId, token }),
    }),
}

// Export API
export const exportApi = {
  getLibraryExportUrl: (mode: 'tracks' | 'playlists') => {
    const token = localStorage.getItem('token')
    return `${API_URL}/export/library?mode=${mode}&auth=${token}`
  },
}

export { ApiError }
