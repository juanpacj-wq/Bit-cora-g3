# Despliegue de Bitácora bajo `/bitacora` (reverse proxy compartido)

Bitácora se despliega en **el mismo servidor Ubuntu** que el dashboard, detrás de **un solo
nginx**, separados por ruta: `pgen.gecelca.com.co/bitacora` (con auth) y
`pgen.gecelca.com.co/dashboard` (sin auth). El backend de Bitácora escucha en `127.0.0.1:3002`;
nginx sirve `dist/` y proxia `/bitacora/api`, `/bitacora/auth`, `/bitacora/ws` quitando el
prefijo `/bitacora`.

**Requisito duro:** el login Entra OIDC exige **HTTPS** (Azure solo admite `http` en `localhost`)
y la cookie de sesión es `Secure`. Por eso Bitácora **solo se activa con TLS** (dominio + cert).

Convención de rutas en el servidor: `/var/www/bitacora/` (repo), `dist/`, `server/`, `.env`.

---

## 1. Backend `.env` (prod) — `/var/www/bitacora/.env`

Partiendo de `.env.example`, además de DB_* y M365_*:

```
NODE_ENV=production
APP_BASE_PATH=/bitacora                 # DEBE coincidir con el base del build (paso 2). Sin barra final.
SESSION_SECRET=<openssl rand -hex 32>   # obligatorio en prod (sin él, el arranque aborta)
SESSION_COOKIE_SECURE=true
SESSION_STORE=mssql                      # tabla [auth].[AppSessions]; NO 'memory' en prod
M365_REDIRECT_URI=https://pgen.gecelca.com.co/bitacora/auth/redirect
M365_POST_LOGOUT_REDIRECT_URI=https://pgen.gecelca.com.co/bitacora/
```

## 2. Build del frontend con el sub-path

El `base` de Vite se toma de `APP_BASE_PATH` en tiempo de build (ver `vite.config.js`):

```bash
cd /var/www/bitacora
npm ci
APP_BASE_PATH=/bitacora npm run build     # emite assets bajo /bitacora/...
cd server && npm ci
```

Verificar: `dist/index.html` debe referenciar `/bitacora/assets/...`.

## 3. systemd (backend 3002)

```bash
sudo cp /var/www/bitacora/deploy/bitacora-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bitacora-api
sudo systemctl status bitacora-api
curl -s http://127.0.0.1:3002/health      # {"status":"ok",...}
```

## 4. nginx — agregar las locations de Bitácora al server block compartido

Las locations viven en `deploy/nginx-bitacora.conf`. Pegar su contenido **dentro** del
`server { ... }` que ya sirve el dashboard (en `dashboard-gen-gec3/deploy/nginx.conf`, en el
placeholder "BITÁCORA (/bitacora)"). Luego:

```bash
sudo cp .../dashboard-gen/deploy/nginx.conf /etc/nginx/sites-available/dashboard-gen
sudo nginx -t && sudo systemctl reload nginx
```

## 5. Azure App Registration

En **Entra ID → App registrations → (la app) → Authentication → Web → Redirect URIs**, agregar:
- `https://pgen.gecelca.com.co/bitacora/auth/redirect`
- Front-channel logout / post-logout: `https://pgen.gecelca.com.co/bitacora/`

Mantener las de dev (`http://localhost:5174/...`) si se sigue desarrollando local.

## 6. TLS (obligatorio antes de activar) — certificado corporativo

El dominio `pgen.gecelca.com.co` usa un **certificado corporativo emitido por CA** (NO certbot /
Let's Encrypt): se recibe el certificado del host, la llave privada y el bundle de intermedios,
y se instalan a mano. El server block TLS ya vive en `dashboard-gen-gec3/deploy/nginx.conf`
(listen 443, rutas de cert, HSTS); este paso solo coloca los archivos.

```bash
# 1. Subir los 3 archivos al servidor (desde la máquina que los tiene):
scp certificado.crt private.key bundle-ca.crt <user>@pgen.gecelca.com.co:/tmp/

# 2. Armar el fullchain: PRIMERO el cert del host (leaf), DESPUÉS los intermedios.
#    El orden importa: nginx envía la cadena tal cual y los clientes la validan en orden.
cat /tmp/certificado.crt /tmp/bundle-ca.crt > /tmp/fullchain.crt

# 3. Verificar ANTES de instalar:
openssl verify -CAfile /tmp/bundle-ca.crt /tmp/certificado.crt          # → OK
# La llave debe corresponder al cert (los dos hashes deben ser IDÉNTICOS):
openssl x509 -noout -modulus -in /tmp/certificado.crt | openssl md5
openssl pkey -in /tmp/private.key -pubout -outform DER | openssl md5    # (RSA/EC ambos)
# Vigencia y SAN:
openssl x509 -noout -enddate -subject -ext subjectAltName -in /tmp/certificado.crt

# 4. Instalar con permisos estrictos (la llave NUNCA legible por otros):
sudo mkdir -p /etc/nginx/ssl/pgen.gecelca.com.co
sudo mv /tmp/fullchain.crt /etc/nginx/ssl/pgen.gecelca.com.co/fullchain.crt
sudo mv /tmp/private.key   /etc/nginx/ssl/pgen.gecelca.com.co/private.key
sudo chown -R root:root /etc/nginx/ssl/pgen.gecelca.com.co
sudo chmod 644 /etc/nginx/ssl/pgen.gecelca.com.co/fullchain.crt
sudo chmod 600 /etc/nginx/ssl/pgen.gecelca.com.co/private.key
rm -f /tmp/certificado.crt /tmp/bundle-ca.crt /tmp/private.key

# 5. Activar y validar la cadena servida:
sudo nginx -t && sudo systemctl reload nginx
openssl s_client -connect pgen.gecelca.com.co:443 -servername pgen.gecelca.com.co </dev/null \
  | grep -E 'Verify return code|subject='       # → Verify return code: 0 (ok)
```

**Renovación (manual, el cert corporativo NO se autorrenueva):** registrar la fecha de
`openssl x509 -enddate` y pedir el cert nuevo a la CA corporativa con anticipación. Renovar =
repetir pasos 2-5 con los archivos nuevos (mismo nombre y ruta → no se toca nginx.conf).

Confirmar que las locations de Bitácora envían `X-Forwarded-Proto https` (ya en el snippet) —
sin esto express-session descarta la cookie `Secure`.

---

## Verificación end-to-end

- `https://pgen.gecelca.com.co/bitacora/` → pantalla de login (paso "microsoft").
- Login → Microsoft → vuelve a `https://pgen.gecelca.com.co/bitacora/auth/redirect` → `/bitacora/?auth=ok`.
- DevTools → Application → Cookies: `bitacora.sid` con `Path=/bitacora`, `HttpOnly`, `Secure`, `SameSite=Lax`.
- Elegir planta → `GET /bitacora/api/me` = 200 con identidad + sesión.
- WS `/bitacora/ws/usuarios-activos` conecta (handshake por cookie).
- Un POST mutador responde 2xx (CSRF ok ⇒ Host/Origin bien reenviados).
- `https://pgen.gecelca.com.co/dashboard/` sigue sin pedir auth y no recibe la cookie de Bitácora.

## Dev (sin cambios)

En desarrollo NO se define `APP_BASE_PATH`: el app queda en la raíz `/` (dev server en
`localhost:5174`, redirect OIDC `http://localhost:5174/auth/redirect` intacto). `npm run dev`
y `node --env-file=../.env server.js` como siempre.
