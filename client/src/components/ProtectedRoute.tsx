import { Navigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'

interface ProtectedRouteProps {
  children: React.ReactNode
}

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { isAuthenticated, isLoading, authError, checkAuth, logout } = useAuthStore()
  const location = useLocation()

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-950">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
      </div>
    )
  }

  if (authError) {
    return <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-surface-950 text-white" role="alert">
      <p>{authError}</p>
      <button className="btn-primary" onClick={() => checkAuth()}>Retry</button>
      <button className="btn-secondary" onClick={() => { logout(); useAuthStore.setState({ authError: null }) }}>Sign out</button>
    </div>
  }

  if (!isAuthenticated) {
    // Redirect to login, but save the attempted URL
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return <>{children}</>
}
