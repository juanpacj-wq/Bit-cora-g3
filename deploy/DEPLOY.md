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
GEMINI_API_KEY=<key de Google AI Studio>  # opcional: habilita "Mejorar con IA" (D-047). Sin ella la
                                          # feature degrada limpio (503 ia_no_configurada). Requiere
                                          # además la CA corporativa (paso 7).
```

**Variables de la ingesta del SIS (carbón GEC32, D-029/D-060/D-061)** — las dos son opcionales y en producción **se dejan como están**:

```
# SIS_HOST=http://192.168.18.201    # opcional: default del código. Solo se toca para apuntar a otro
                                    # historiador o a un stub. Validado contra allowlist interna; el
                                    # servidor de prod necesita ruta HTTP hacia esa IP o el sweeper
                                    # deja el día en periodos_error (no rompe el backend).
# SIS_SWEEPER_ENABLED=0             # NO PONER EN PRODUCCIÓN. Apaga el sweeper horario del SIS.
                                    # Existe para los backends efímeros de test (con SIS_HOST
                                    # apuntando a un stub, el tick real ensucia el log de GEC32).
                                    # Solo el string exacto '0' apaga; ausente o cualquier otro
                                    # valor deja la ingesta encendida. El apagado se anuncia en el
                                    # log de arranque: [SIS] sweeper DESHABILITADO.
```

Con el sweeper encendido, el backend le pide el carbón de GEC32 al SIS **a HH:02 hora Bogotá** (y 10 s después de arrancar): completa el día de ayer si le falta algún periodo y vuelve a leer el de hoy. Un SIS inalcanzable **no rompe nada** — cuenta los periodos como error y reprograma.

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

## 7. CA corporativa para el fetch saliente a Gemini (D-047, "Mejorar con IA")

El FortiGate corporativo **intercepta el TLS saliente** (re-firma los certificados con su propia
CA). Node NO usa el almacén del sistema, así que sin esto el fetch a Gemini falla con
`SELF_SIGNED_CERT_IN_CHAIN`. La solución auditable es confiar en la CA corporativa vía
`NODE_EXTRA_CA_CERTS` (línea `Environment=` ya incluida en `bitacora-api.service`). **NUNCA**
desactivar la verificación TLS (`NODE_TLS_REJECT_UNAUTHORIZED=0`).

```bash
# 1. Extraer la CA del FortiGate desde la cadena que sirve (el 2º+ cert de la cadena):
echo | openssl s_client -connect generativelanguage.googleapis.com:443 \
  -servername generativelanguage.googleapis.com -showcerts 2>/dev/null \
  | awk '/BEGIN CERTIFICATE/{i++} i>=2 && /BEGIN CERTIFICATE/,/END CERTIFICATE/' \
  | sudo tee /usr/local/share/ca-certificates/corp-fortigate-ca.crt >/dev/null

# 2. Verificar que es la CA corporativa (issuer/subject deben decir Fortinet, no Google):
openssl x509 -in /usr/local/share/ca-certificates/corp-fortigate-ca.crt -noout -subject -issuer

# 3. Registrarla en el sistema (para curl/apt) y reiniciar el backend (Node la toma del unit):
sudo update-ca-certificates
sudo systemctl restart bitacora-api

# 4. Probar desde el propio Node del servidor (debe imprimir 403 = alcanzó Google sin key):
NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/corp-fortigate-ca.crt \
  node -e "fetch('https://generativelanguage.googleapis.com/v1beta/models').then(r=>console.log(r.status))"
```

**Ojo:** si el FortiGate rota su CA (cambio de equipo/firmware), el fetch vuelve a fallar con el
mismo error — repetir pasos 1-4.

## 8. Backfill del carbón GEC32 en prod (D-061)

El sweeper solo cubre hoy y ayer. Para cargar el **histórico** de GEC32 —o para reparar días viejos que quedaron incompletos— se corre a mano `server/scripts/backfill-carbon-gec32.js`. **No hay botón en la UI y no debe haberlo**: son días de proceso.

Es **resumible**: salta lo que ya está 24/24, así que se relanza con el mismo comando cuantas veces haga falta. La ownership de D-029 protege toda celda editada a mano; el backfill nunca pisa una corrección del operador.

### 8.1 Guardrails que trae el CLI

| Guardrail | Qué hace |
|---|---|
| `--confirm-db <nombre>` | **Obligatorio.** Debe ser exactamente el `DB_NAME` activo. Es lo que impide correr contra la base equivocada. |
| `--to` por defecto `hoy-2`, nunca `>= hoy` | No compite con el tick del sweeper, que es quien cierra ayer y hoy (D-060). |
| `--confirm-from YYYY-MM-DD` | Con `--from auto` es lo que **habilita la escritura**; con un `--from` explícito es un doble chequeo. |
| `--dry-run` | Dice qué pediría, no escribe nada. Igual imprime el conteo por año. |
| `--concurrencia 1..6` | Cuántos periodos le pide al SIS a la vez. Solo acelera la red. |
| `--log <ruta>` | Apila cada línea también en un archivo (imprescindible en corridas de días). |
| `--solo-parciales` | Salta los días **sin fila** en `sis_scrape_log` y completa solo los que ya tienen datos parciales. **Ojo con esto**, ver §8.4. |

`--from auto` sondea el SIS para descubrir desde cuándo hay datos y **sale sin escribir**. Sus códigos de salida:

| Exit | Significa | Qué hacer |
|---|---|---|
| `3` | Encontró el inicio y falta confirmarlo. | Repetir el comando agregando `--confirm-from <la fecha que imprimió>`. |
| `4` | **Llegó al tope de retroceso sin certificar el inicio.** La fecha que muestra es el día con datos más antiguo que alcanzó a ver: **puede haber historia más atrás**. | Verificar a mano antes de tomarla como la primera fecha del SIS. |
| `2` | El sondeo no sirve (nada respondió, o el SIS falló dos veces en el mismo día). | No hay fecha que confirmar: revisar la red contra el SIS y repetir. |

El sondeo cuesta decenas de fetch de ~13 s (la calibración de GEC32 fueron **58 sondeos en 14 min**). Es una **calibración de una sola vez**, no algo para un cron: su resultado se fija a mano en el comando. Y no es un oráculo — el histórico real de GEC32 tiene huecos de más de 60 días que la ventana por defecto no distingue del pre-inicio.

### 8.2 El comando

Se corre desde `Bit-cora-g3/server`, en una máquina con ruta hacia el SIS **y** hacia la BD. `DB_NAME=PortalG3` es lo que elige producción (**`DB_NAME_PROD` del `.env` no lo lee nadie**).

```
DB_NAME=PortalG3 node --env-file=../.env scripts/backfill-carbon-gec32.js \
  --confirm-db PortalG3 \
  --from 2018-06-13 --confirm-from 2018-06-13 \
  --to <hoy-2> \
  --concurrencia 6 \
  --log <ruta del log>
```

`2018-06-13` es la fecha de inicio de GEC32 en el SIS, ya descubierta y verificada (58 sondeos, 0 errores de red): **no hace falta volver a pagar el `--from auto`**. Ese primer día trae 0,13 MW y cero carbón; el primer carbón medido es del `2018-07-15`. El rango completo hasta 2026 son **2.996 días** a ~95 s cada uno: **ETA ≈ 3,3 días** de proceso.

Antes de lanzar, dos verificaciones que **no escriben**:

```
# 1. Que el guardrail de base funciona (debe RECHAZAR):
DB_NAME=PortalG3 node --env-file=../.env scripts/backfill-carbon-gec32.js --confirm-db PortalG3_dev --dry-run
#    → [backfill] --confirm-db debe ser exactamente el DB_NAME activo ("PortalG3"). Recibido: "PortalG3_dev".

# 2. Que NO reescribe lo que ya está completo (saltados=N, procesados=0):
DB_NAME=PortalG3 node --env-file=../.env scripts/backfill-carbon-gec32.js \
  --confirm-db PortalG3 --from 2026-08-20 --to 2026-08-22 --dry-run --concurrencia 6
```

**Lanzarlo desacoplado.** Son días de corrida: si muere la terminal, muere el backfill. En Windows, `Start-Process … -WindowStyle Hidden` con `WorkingDirectory` en `Bit-cora-g3/server`; en Linux, `systemd-run --user` o `nohup`. Anotar el **PID** y la ruta del log.

### 8.3 La corrida grande son DOS pasadas, no una

Con `concurrencia 6` sostenida durante horas el SIS **sí falla**: medido en las corridas de D-061, **~7–10 % de los días** quedan con algún periodo en error (22 de 331 en dev, 23 de 235 en prod). No se pierde nada: esos días quedan `completo = 0` y una **segunda pasada del mismo comando los re-pide enteros** (con `periodos_error != 0`, el scraper vuelve a arrancar en el periodo 1).

Bajar la concurrencia costaría días de calendario para evitar un reintento de minutos: se deja en 6 y se hace la segunda pasada.

### 8.4 Cómo se sabe que terminó — y por qué el proceso no sirve de criterio

**El criterio de "terminado" son estas dos consultas en cero, nunca que el proceso haya salido.** Un backfill puede morir sin imprimir su línea `FIN`, y puede terminar habiendo saltado días.

```sql
-- (a) Días con lectura incompleta: los cierra la segunda pasada.
SELECT COUNT(*) FROM bitacora.sis_scrape_log
WHERE planta_id = 'GEC32' AND completo = 0 AND fecha < CAST(DATEADD(HOUR,-5,SYSUTCDATETIME()) AS DATE);

-- (b) Días del rango SIN NINGUNA FILA de log: el backfill nunca los llegó a escribir.
WITH d AS (SELECT CAST('2018-06-13' AS DATE) AS ini,
                  CAST(DATEADD(DAY,-2, DATEADD(HOUR,-5,SYSUTCDATETIME())) AS DATE) AS fin)
SELECT COUNT(*) FROM (
  SELECT DATEADD(DAY, n.number, d.ini) AS f FROM d
  JOIN master.dbo.spt_values n ON n.type='P' AND n.number <= DATEDIFF(DAY, d.ini, d.fin)
) t
WHERE NOT EXISTS (SELECT 1 FROM bitacora.sis_scrape_log l
                  WHERE l.planta_id='GEC32' AND l.fecha = t.f);
```

**La consulta (b) es la que hay que mirar con más cuidado**, y de ahí sale la advertencia sobre `--solo-parciales`:

- Un día cuyo `scrapeDia` **reventó entero** (la BD dejó de responder, se cayó la red) queda **sin fila** en `sis_scrape_log`: el CLI lo anota como `FALLÓ` **en stderr**, espera 15 s y **sigue con el siguiente**. No lo reintenta.
- `--solo-parciales` **salta justamente los días sin fila**. Una segunda pasada con ese flag deja esos días vacíos para siempre, y la consulta (a) daría cero: "terminado" mentiroso.
- Por eso **la segunda pasada va con el comando completo, sin `--solo-parciales`**. El flag es solo para la variante barata cuando ya se sabe que todos los días del rango tienen fila.

Y por eso hay que **mirar el stderr, no solo el log principal**: las líneas `[backfill] <fecha>: FALLÓ — …` van ahí. Un `grep -c FALLÓ` sobre el `.stderr.log` dice de un vistazo cuántos días se perdieron.

Para ver cómo va, además de las dos consultas:

```sql
SELECT COUNT(*) AS dias, MIN(fecha) AS desde, MAX(fecha) AS hasta,
       SUM(CASE WHEN completo = 1 THEN 1 ELSE 0 END) AS completos
FROM bitacora.sis_scrape_log WHERE planta_id = 'GEC32';

SELECT YEAR(cc.fecha) AS anio, COUNT(*) AS celdas, COUNT(DISTINCT cc.fecha) AS dias
FROM bitacora.consumo_combustible cc
JOIN lov_bit.combustible c ON c.combustible_id = cc.combustible_id
WHERE cc.planta_id = 'GEC32' AND c.tipo = 'ALIMENTADOR'
GROUP BY YEAR(cc.fecha) ORDER BY 1;
```

**Un día sin celdas no es un fallo.** Si la unidad estuvo fuera de servicio las 24 horas, el SIS reporta ceros, el scraper no crea ninguna celda y solo queda la fila de log con `completo = 1`. Es la semántica acordada: los días en cero viven en el log, no en la tabla de consumos. Los primeros meses de 2018 son así.

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
