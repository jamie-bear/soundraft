import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import Player from './Player'

export default function Layout() {
  return (
    <div className="flex h-screen flex-col bg-surface-950">
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <Sidebar />
        
        {/* Main content */}
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
      
      {/* Persistent audio player */}
      <Player />
    </div>
  )
}
