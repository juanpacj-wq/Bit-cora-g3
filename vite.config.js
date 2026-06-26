import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // Login Entra ID: fijamos el puerto (strictPort) para que el redirect URI registrado en la
    // App Registration (http://localhost:5174/auth/redirect) calce siempre; si 5174 está ocupado,
    // Vite falla en vez de saltar a otro puerto y romper el callback OIDC.
    port: 5174,
    strictPort: true,
    proxy: {
      '/api':  { target: 'http://localhost:3002', changeOrigin: true },
      // Login Entra ID: el flujo OIDC (login + callback) y la cookie httpOnly viven en el backend.
      // Proxyeamos /auth para que la cookie sea same-origin (localhost:5174) en dev.
      '/auth': { target: 'http://localhost:3002', changeOrigin: true },
      '/ws':   { target: 'ws://localhost:3002', ws: true, changeOrigin: true },
    },
  },
})
