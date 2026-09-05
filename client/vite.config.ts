import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig(({ mode }) => {
  // Load env from parent directory (where .env is located)
  const env = loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), '')

  // Parse allowed hosts from env (comma-separated)
  const allowedHosts = env.VITE_ALLOWED_HOSTS
    ? env.VITE_ALLOWED_HOSTS.split(',').map(h => h.trim())
    : []

  // Disable HMR if VITE_DISABLE_HMR is set (useful for mobile testing)
  const disableHMR = env.VITE_DISABLE_HMR === 'true'

  return {
    plugins: [react()],
    build: { manifest: true },
    server: {
      host: true,
      port: 5173,
      allowedHosts: allowedHosts.length > 0 ? allowedHosts : true,
      // HMR configuration to prevent unwanted reloads
      hmr: disableHMR ? false : {
        // Increase timeout to prevent disconnects on slow/mobile connections
        timeout: 60000,
        // Use overlay only for errors, not warnings
        overlay: {
          errors: true,
          warnings: false,
        },
      },
      // Increase watch options stability
      watch: {
        // Use polling with longer interval for Docker volumes (more stable)
        usePolling: true,
        interval: 1000,
        // Ignore node_modules to reduce unnecessary watches
        ignored: ['**/node_modules/**', '**/.git/**'],
      },
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
