import { useState, useRef, useCallback, useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import Player from './Player'

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 639px)').matches)
  const navigation = useRef<HTMLDivElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 639px)')
    const update = () => setMobile(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (navigation.current) navigation.current.inert = mobile && !sidebarOpen
    if (mobile && sidebarOpen) navigation.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [mobile, sidebarOpen])
  const closeNavigation = () => { setSidebarOpen(false); menuButton.current?.focus() }
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
          ref={menuButton} aria-label="Open navigation" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)}
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
          ref={navigation} aria-hidden={mobile && !sidebarOpen ? true : undefined}
          onKeyDown={event => {
            if (!mobile || !sidebarOpen) return
            if (event.key === 'Escape') { event.preventDefault(); closeNavigation() }
            if (event.key === 'Tab') {
              const items = Array.from(navigation.current!.querySelectorAll<HTMLElement>('a[href],button:not([disabled])'))
              const first = items[0], last = items[items.length - 1]
              if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
              if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
            }
          }}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <Sidebar onClose={closeNavigation} />
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
