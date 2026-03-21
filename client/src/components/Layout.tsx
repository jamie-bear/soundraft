import { useState, useRef, useCallback } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import Player from './Player'

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const touchStartX = useRef<number | null>(null)

  // Swipe-left-to-close on mobile sidebar
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX
  }, [])

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (touchStartX.current === null) return
    const deltaX = e.changedTouches[0].clientX - touchStartX.current
    if (deltaX < -60) {
      setSidebarOpen(false)
    }
    touchStartX.current = null
  }, [])

  return (
    <div className="flex h-screen flex-col bg-surface-950">
      {/* Mobile header */}
      <header className="flex items-center gap-3 border-b border-surface-800 bg-surface-900 px-4 py-3 sm:hidden">
        <button
          onClick={() => setSidebarOpen(true)}
          className="flex h-10 w-10 items-center justify-center rounded-lg text-surface-300 hover:bg-surface-800 hover:text-white transition-colors"
        >
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <a href="/" className="flex items-center gap-2">
          <img src="/soundraft-logo.svg" alt="SoundRaft" className="h-8 w-8" />
          <span className="text-lg font-bold text-white">SoundRaft</span>
        </a>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Mobile sidebar overlay */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50 sm:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar - hidden on mobile, shown as overlay when toggled */}
        <div
          className={`fixed inset-y-0 left-0 z-50 w-64 transform transition-transform duration-200 sm:relative sm:translate-x-0 ${
            sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <Sidebar onClose={() => setSidebarOpen(false)} />
        </div>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          <Outlet />
        </main>
      </div>

      {/* Persistent audio player */}
      <Player />
    </div>
  )
}
