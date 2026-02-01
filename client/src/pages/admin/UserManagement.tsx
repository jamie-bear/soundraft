import { useState, useEffect } from 'react'
import { adminApi, AdminUser } from '../../lib/api'

export default function UserManagement() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [editingUser, setEditingUser] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    loadUsers()
  }, [])

  const loadUsers = async (searchQuery?: string) => {
    try {
      setLoading(true)
      const { users: data } = await adminApi.listUsers({ search: searchQuery })
      setUsers(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    loadUsers(search)
  }

  const handleRoleChange = async (userId: string, newRole: string) => {
    try {
      await adminApi.updateUser(userId, { role: newRole })
      setUsers(users.map(u => u.id === userId ? { ...u, role: newRole as 'USER' | 'ADMIN' } : u))
      setEditingUser(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user')
    }
  }

  const handleToggleActive = async (userId: string, currentStatus: boolean) => {
    try {
      await adminApi.updateUser(userId, { is_active: !currentStatus })
      setUsers(users.map(u => u.id === userId ? { ...u, is_active: !currentStatus } : u))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user')
    }
  }

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
  }

  const formatDate = (date: string | null) => {
    if (!date) return 'Never'
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">User Management</h2>
        
        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by email..."
            className="w-64 rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-white placeholder-surface-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
          />
          <button
            type="submit"
            className="rounded-lg bg-surface-800 px-4 py-2 text-sm font-medium text-white hover:bg-surface-700 transition-colors"
          >
            Search
          </button>
        </form>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-surface-800">
          <table className="w-full">
            <thead className="bg-surface-900">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-surface-400">Email</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-surface-400">Role</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-surface-400">Tracks</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-surface-400">Playlists</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-surface-400">Storage</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-surface-400">Last Login</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-surface-400">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-800">
              {users.map((user) => (
                <tr key={user.id} className="bg-surface-950 hover:bg-surface-900/50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-600/20 text-sm font-medium text-primary-400">
                        {user.email.charAt(0).toUpperCase()}
                      </div>
                      <span className="text-sm text-white">{user.email}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {editingUser === user.id ? (
                      <select
                        value={user.role}
                        onChange={(e) => handleRoleChange(user.id, e.target.value)}
                        onBlur={() => setEditingUser(null)}
                        autoFocus
                        className="rounded border border-surface-600 bg-surface-800 px-2 py-1 text-sm text-white focus:border-primary-500 focus:outline-none"
                      >
                        <option value="USER">User</option>
                        <option value="ADMIN">Admin</option>
                      </select>
                    ) : (
                      <button
                        onClick={() => setEditingUser(user.id)}
                        className={`rounded-full px-2 py-1 text-xs font-medium ${
                          user.role === 'ADMIN'
                            ? 'bg-red-500/20 text-red-400'
                            : 'bg-surface-700 text-surface-300'
                        } hover:opacity-80 transition-opacity`}
                      >
                        {user.role}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center text-sm text-surface-300">
                    {user.track_count}
                  </td>
                  <td className="px-4 py-3 text-center text-sm text-surface-300">
                    {user.playlist_count}
                  </td>
                  <td className="px-4 py-3 text-right text-sm text-surface-300">
                    {formatBytes(user.total_storage_bytes)}
                  </td>
                  <td className="px-4 py-3 text-sm text-surface-400">
                    {formatDate(user.last_login_at)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={() => handleToggleActive(user.id, user.is_active)}
                      className={`rounded-full px-2 py-1 text-xs font-medium transition-colors ${
                        user.is_active
                          ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                          : 'bg-surface-700 text-surface-400 hover:bg-surface-600'
                      }`}
                    >
                      {user.is_active ? 'Active' : 'Disabled'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          
          {users.length === 0 && (
            <div className="py-12 text-center text-surface-500">
              No users found
            </div>
          )}
        </div>
      )}
    </div>
  )
}
