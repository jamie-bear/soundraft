import { useEffect } from 'react'
import { Routes, Route } from 'react-router-dom'
import { useAuthStore } from './stores/authStore'
import Layout from './components/Layout'
import ProtectedRoute from './components/ProtectedRoute'
import Dashboard from './pages/Dashboard'
import TracksPage from './pages/TracksPage'
import PlaylistsPage from './pages/PlaylistsPage'
import Login from './pages/Login'
import Register from './pages/Register'
import TrackDetail from './pages/TrackDetail'
import PlaylistDetail from './pages/PlaylistDetail'
import SharedTrackPage from './pages/SharedTrackPage'
import SharedPlaylistPage from './pages/SharedPlaylistPage'
import AdminLayout from './pages/admin/AdminLayout'
import UserManagement from './pages/admin/UserManagement'
import SystemSettings from './pages/admin/SystemSettings'

function App() {
  const checkAuth = useAuthStore((state) => state.checkAuth)

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  return (
    <Routes>
      {/* Public routes */}
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      
      {/* Public shared views */}
      <Route path="/share/track/:token" element={<SharedTrackPage />} />
      <Route path="/share/playlist/:token" element={<SharedPlaylistPage />} />

      {/* Protected routes */}
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="tracks" element={<TracksPage />} />
        <Route path="tracks/:id" element={<TrackDetail />} />
        <Route path="playlists" element={<PlaylistsPage />} />
        <Route path="playlists/:id" element={<PlaylistDetail />} />
      </Route>

      {/* Admin routes */}
      <Route
        path="/admin"
        element={
          <ProtectedRoute>
            <AdminLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<UserManagement />} />
        <Route path="settings" element={<SystemSettings />} />
      </Route>
    </Routes>
  )
}

export default App
