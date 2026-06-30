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
      // changeOrigin:false es DELIBERADO (fix login 2026-06-30): conserva el header Host original
      // (localhost:5174) en vez de reescribirlo al target (localhost:3002). Así el backend ve
      // Host == Origin del navegador y las defensas same-origin que agregó la remediación —
      // CSRF de mutadores (AUD-19, csrfOriginAllowed) y anti-CSWSH del WS (AUD-21, originPermitido)—
      // reconocen al front de dev como mismo origen. Con changeOrigin:true el Host quedaba en :3002
      // y todo POST daba 403 / el WS se rechazaba. El proxy igual conecta a :3002 (solo cambia el header).
      '/api':  { target: 'http://localhost:3002', changeOrigin: false },
      // Login Entra ID: el flujo OIDC (login + callback) y la cookie httpOnly viven en el backend.
      // Proxyeamos /auth para que la cookie sea same-origin (localhost:5174) en dev.
      '/auth': { target: 'http://localhost:3002', changeOrigin: false },
      '/ws':   { target: 'ws://localhost:3002', ws: true, changeOrigin: false },
    },
  },
})
