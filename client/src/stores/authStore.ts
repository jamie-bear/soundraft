import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { authApi, User } from '../lib/api'

interface AuthState {
  user: User | null
  token: string | null
  isLoading: boolean
  isAuthenticated: boolean
  
  // Actions
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string) => Promise<void>
  logout: () => void
  checkAuth: () => Promise<void>
  setUser: (user: User | null) => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, _get) => ({
      user: null,
      token: null,
      isLoading: true,
      isAuthenticated: false,

      login: async (email: string, password: string) => {
        const { user, token } = await authApi.login(email, password)
        localStorage.setItem('token', token)
        set({ user, token, isAuthenticated: true })
      },

      register: async (email: string, password: string) => {
        const { user, token } = await authApi.register(email, password)
        localStorage.setItem('token', token)
        set({ user, token, isAuthenticated: true })
      },

      logout: () => {
        localStorage.removeItem('token')
        set({ user: null, token: null, isAuthenticated: false })
      },

      checkAuth: async () => {
        const token = localStorage.getItem('token')
        
        if (!token) {
          set({ isLoading: false, isAuthenticated: false })
          return
        }

        try {
          const { user } = await authApi.me()
          set({ user, token, isAuthenticated: true, isLoading: false })
        } catch (error) {
          // Token invalid or expired
          localStorage.removeItem('token')
          set({ user: null, token: null, isAuthenticated: false, isLoading: false })
        }
      },

      setUser: (user: User | null) => {
        set({ user, isAuthenticated: !!user })
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ token: state.token }),
    }
  )
)
