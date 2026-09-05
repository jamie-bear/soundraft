import { useState } from 'react'
import { useAuthStore } from '../stores/authStore'
import { exportApi } from '../lib/api'

export default function UserSettings() {
  const user = useAuthStore((state) => state.user)
  const [exporting, setExporting] = useState(false)
  const [exportMode, setExportMode] = useState<'tracks' | 'playlists'>('tracks')

  const handleExport = async () => {
    setExporting(true)
    try {
      const url = await exportApi.getLibraryExportUrl(exportMode)
      const a = document.createElement('a')
      a.href = url
      a.download = ''
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-white">Settings</h2>
        <p className="text-sm text-surface-400">Manage your account and data</p>
      </div>

      <div className="space-y-8">
        {/* Account Info Section */}
        <section className="rounded-xl border border-surface-800 bg-surface-900 p-6">
          <h3 className="mb-4 text-lg font-medium text-white">Account</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-surface-400">Email</span>
              <span className="text-sm text-white">{user?.email}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-surface-400">Role</span>
              <span className="text-sm text-white">{user?.role}</span>
            </div>
          </div>
        </section>

        {/* Export Library Section */}
        <section className="rounded-xl border border-surface-800 bg-surface-900 p-6">
          <h3 className="mb-2 text-lg font-medium text-white">Export Library</h3>
          <p className="mb-4 text-sm text-surface-400">
            Download your entire library as a .zip file including all track versions,
            cover art, attachments, and comments.
          </p>

          {/* Mode selector */}
          <div className="mb-4">
            <label className="mb-2 block text-sm font-medium text-surface-300">
              Folder structure
            </label>
            <div className="flex gap-3">
              <button
                onClick={() => setExportMode('tracks')}
                className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                  exportMode === 'tracks'
                    ? 'bg-primary-600 text-white'
                    : 'bg-surface-800 text-surface-300 hover:bg-surface-700'
                }`}
              >
                By Tracks
              </button>
              <button
                onClick={() => setExportMode('playlists')}
                className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                  exportMode === 'playlists'
                    ? 'bg-primary-600 text-white'
                    : 'bg-surface-800 text-surface-300 hover:bg-surface-700'
                }`}
              >
                By Playlists
              </button>
            </div>
          </div>

          {/* Description of selected mode */}
          <p className="mb-4 text-xs text-surface-500">
            {exportMode === 'tracks'
              ? 'Each track gets its own folder containing audio versions, cover art, attachments, and comments.'
              : 'Each playlist gets its own folder with track subfolders inside. Tracks in multiple playlists appear in all of them.'}
          </p>

          {/* Export button */}
          <button
            onClick={handleExport}
            disabled={exporting}
            className="flex items-center gap-2 rounded-lg bg-primary-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            {exporting ? 'Preparing download...' : 'Download Library'}
          </button>
        </section>
      </div>
    </div>
  )
}
