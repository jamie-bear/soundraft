import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({ mode }) => {
  // Load env from parent directory (where .env is located)
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '')
  
  // Parse allowed hosts from env (comma-separated)
  const allowedHosts = env.VITE_ALLOWED_HOSTS 
    ? env.VITE_ALLOWED_HOSTS.split(',').map(h => h.trim())
    : []

  return {
    plugins: [react()],
    server: {
      host: true,
      port: 5173,
      allowedHosts: allowedHosts.length > 0 ? allowedHosts : true,
      // Proxy API requests to backend
      proxy: {
        '/api': {
          target: 'http://api:8080',
          changeOrigin: true,
          secure: false
        }
      }
    }
  }
})
