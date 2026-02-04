import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'

// Prevent HMR from causing full page reloads on mobile/unstable connections
// This catches HMR errors and logs them instead of reloading
if (import.meta.hot) {
  import.meta.hot.on('vite:error', (err) => {
    console.warn('Vite HMR error (suppressed reload):', err)
  })
  import.meta.hot.on('vite:ws:disconnect', () => {
    console.warn('Vite HMR websocket disconnected - audio will continue playing')
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
