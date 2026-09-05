import { useEffect, lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router-dom'
import { useAuthStore } from './stores/authStore'
import Layout from './components/Layout'
import ProtectedRoute from './components/ProtectedRoute'
const Dashboard = lazy(() => import('./pages/Dashboard'))
const TracksPage = lazy(() => import('./pages/TracksPage'))
const PlaylistsPage = lazy(() => import('./pages/PlaylistsPage'))
const Login = lazy(() => import('./pages/Login'))
const Register = lazy(() => import('./pages/Register'))
const TrackDetail = lazy(() => import('./pages/TrackDetail'))
const PlaylistDetail = lazy(() => import('./pages/PlaylistDetail'))
const SharedTrackPage = lazy(() => import('./pages/SharedTrackPage'))
const SharedPlaylistPage = lazy(() => import('./pages/SharedPlaylistPage'))
const UserSettings = lazy(() => import('./pages/UserSettings'))
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'))
const UserManagement = lazy(() => import('./pages/admin/UserManagement'))
const SystemSettings = lazy(() => import('./pages/admin/SystemSettings'))

function App() {
  const checkAuth = useAuthStore((state) => state.checkAuth)

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  return (
    <Suspense fallback={<div role="status" className="p-8 text-white">Loading…</div>}><Routes>
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
        <Route path="settings" element={<UserSettings />} />
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
    </Routes></Suspense>
  )
}

export default App
