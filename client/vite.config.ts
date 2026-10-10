import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  server: {
    port: 5173,
    // Proxy API calls to the Express server during development. This exists so
    // the browser sees a single origin: the session cookie is SameSite=Lax and
    // is sent automatically, and we never need CORS or credentialed fetch
    // configuration. In production the Express server serves the built client
    // from the same origin, so this proxy is a dev-only convenience.
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },

  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
