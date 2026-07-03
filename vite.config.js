import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Sub-path de despliegue. Configurable por env para no romper dev: sin APP_BASE_PATH el app
// vive en la raíz '/' (dev, con el redirect OIDC localhost:5174/auth/redirect intacto); en
// prod se construye con APP_BASE_PATH=/bitacora para convivir con el dashboard (/dashboard)
// bajo un mismo dominio. Vite expone el valor en import.meta.env.BASE_URL (ver src/config/paths.js).
// El backend debe recibir el MISMO APP_BASE_PATH en su .env (redirects OIDC + path de cookie).
const rawBase = process.env.APP_BASE_PATH || '/'
const base = rawBase.endsWith('/') ? rawBase : rawBase + '/'

export default defineConfig({
  base,
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
