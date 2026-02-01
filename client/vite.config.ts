import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // Load env from parent directory (where .env is located)
  const env = loadEnv(mode, '../', '')
  
  // Parse allowed hosts from env (comma-separated)
  const allowedHosts = env.VITE_ALLOWED_HOSTS 
    ? env.VITE_ALLOWED_HOSTS.split(',').map(h => h.trim())
    : []

  return {
    plugins: [react()],
    server: {
      host: true,
      port: 5173,
      allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined
    }
  }
})
