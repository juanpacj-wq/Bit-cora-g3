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

## 9. Asiento automático del despacho de XM (D-064)

> **La regla que gobierna todo este bloque: PRIMERO el dashboard, DESPUÉS Bitácora.** No es una
> recomendación. Con Bitácora arriba y el dashboard no, todo funciona **exactamente como hoy** —esa es
> la degradación pedida, RN-05.c— pero el único rastro es **una línea** en `journalctl` y nadie va a
> notar que el renglón no sale. Y el relleno del mes corrido antes que el dashboard deja el mes entero
> con **hora estimada** aunque las horas reales de los últimos días fueran a estar disponibles.

### 9.1 Orden de la puesta en marcha

| # | Dónde | Qué | Cómo se sabe que quedó |
|---|---|---|---|
| 1 | `dashboard-gen-gec3` | Desplegar la rama con L01 y **reiniciar**. Su `initDB()` crea `dashboard.despacho_recibido` (patrón `IF OBJECT_ID … IS NULL`, **sin** tabla de flags). | `SELECT OBJECT_ID('dashboard.despacho_recibido','U')` **no** nulo. |
| 2 | BD | Esperar a la primera detección real (XM publica hacia las 3 p.m.) **o** aceptar que el primer día quede con hora estimada. | `SELECT TOP 5 * FROM dashboard.despacho_recibido ORDER BY fecha_despacho DESC` |
| 3 | `Bit-cora-g3` | Desplegar y **reiniciar**. `F36.A1` corre en el arranque y siembra el tipo `'Despacho económico'`. | `journalctl -u bitacora-api -n 200` sin errores + la query de 9.3. |
| 4 | `Bit-cora-g3/server` | Correr **una sola vez** el relleno del mes en curso (§9.2), **con el sweeper apagado**. | La línea final del CLI (§9.2) y el conteo en la BD. |

**Lo primero del smoke, y la única pieza que no se pudo probar antes:** que el `SELECT` del lector
funcione contra la tabla **de verdad**. Hasta el paso 1 esa tabla no existe en ninguna base, así que
en dev solo se ejercitó el camino de degradación. Después del paso 3, en el log tiene que **dejar de
aparecer** la línea `[despacho-xm] no se pudo leer dashboard.despacho_recibido: Invalid object name …`.

**Lo segundo del smoke:** que el **próximo cierre de turno real archive** las filas del relleno. Su
`fecha_evento` cae fuera de la ventana del turno abierto (son días pasados), así que salen con el
`turno_id` del turno **ABIERTO** al momento de escribir o con `NULL`; en el segundo caso las levanta
el rescate de huérfanos de D-063. Los dos caminos están cubiertos por diseño, pero no se ejercitaron
sin escribir en planta real.

### 9.2 El relleno del mes en curso — una sola pasada

**Apaga el barrido antes de correrlo.** El CLI recorre `[día 1, hoy]` y el sweeper barre
`[hoy-2, hoy+1]`: **los tres últimos días los piden los dos**, ninguno toma lock de rango y son dos
procesos distintos, así que un día podría salir duplicado. Dos formas, cualquiera sirve:

```bash
# (a) con el servicio detenido — la más simple si la ventana lo permite
sudo systemctl stop bitacora-api

# (b) o con el sweeper apagado en el unit, sin bajar el servicio
sudo systemctl edit bitacora-api      # → Environment=DESPACHO_XM_SWEEPER_ENABLED=0
sudo systemctl restart bitacora-api
# el arranque lo confirma:  [despacho-xm] sweeper DESHABILITADO (DESPACHO_XM_SWEEPER_ENABLED=0)
```

El comando (desde `Bit-cora-g3/server`). **`DB_NAME` va DELANTE**: la variable del entorno prevalece
sobre la del `--env-file`, y `DB_NAME_PROD` del `.env` **no la lee nadie** — es inerte (convención 35):

```bash
# 1. Ensayo. NO escribe una sola fila.
DB_NAME=PortalG3 node --env-file=../.env scripts/relleno-asiento-despacho.js \
  --confirm-db PortalG3 --dry-run --log /tmp/relleno-despacho-dry.log

# 2. De verdad.
DB_NAME=PortalG3 node --env-file=../.env scripts/relleno-asiento-despacho.js \
  --confirm-db PortalG3 --log /tmp/relleno-despacho.log
```

Comprueba primero que el **guardrail** funciona: con un `--confirm-db` que no sea el `DB_NAME` activo
tiene que **rechazar antes de abrir el pool**, sin tocar una conexión.

> ⚠️ **El `--dry-run` NO prueba que el camino real funcione.** El ensayo nunca llega al escritor —pasó
> limpio durante todo el desarrollo con el CLI roto por los live bindings (GATE-O2, R1)—. "El dry-run
> salió bien" no es evidencia de nada más que de que el rango y los guardrails están bien.

**Y "terminó" NO es que el proceso salga con 0.** El CLI le vuelve a **preguntar a la BD** qué días del
mes tienen asiento —una consulta aparte, no el acumulador del bucle, y mirando las **dos** tablas— y
nombra los que falten. Ese es el número que hay que leer:

```
[relleno] verificación (consultada a la BD): 31/31 días del mes con asiento — 3 con hora real, 28 con hora estimada
[relleno] no queda ningún día del mes sin asiento.
```

- `[relleno] no queda ningún día del mes sin asiento.` → listo.
- `[relleno] días del mes SIN asiento: …` y **exit 1**: **relanza el MISMO comando completo**. Es
  resumible por la idempotencia del creador; no hay un flag de "solo los que faltan" y no hace falta.
  (Con `--dry-run` o `--solo-con-hecho` la lista sale igual pero **no** hay exit 1: ahí quedan días
  sin renglón a propósito.)
- `[relleno] OJO: N asiento(s) quedaron con HORA ESTIMADA (15:00 Bogotá …)` → es lo esperado para los
  días pasados: su hora real **nunca se guardó**. La marca vive en `campos_extra.hora_estimada` y
  **no se pinta en el front**.

Si prefieres la lectura estricta de RN-05.d —solo los días con fila en `dashboard.despacho_recibido`—
agrega `--solo-con-hecho`: los días sin hecho se **omiten** y quedan sin renglón. Ten presente que la
**ausencia de una fila no prueba que no llegó** el despacho (hay una ventana conocida en la que el
hecho se pierde en el origen), así que esa opción puede dejar huecos legítimos.

**Al terminar, vuelve a encender el sweeper** (`systemctl start` o revertir el `Environment=`), y
confirma en el log que arrancó: `[despacho-xm] sweeper iniciado`.

### 9.3 Verificación end-to-end

```sql
-- 1. El tipo de evento quedó sembrado por F36.A1, oculto y en las DOS Salas (esperado: 2 filas)
SELECT b.codigo, te.nombre, te.orden, te.seleccionable
FROM lov_bit.tipo_evento te
JOIN lov_bit.bitacora b ON b.bitacora_id = te.bitacora_id
WHERE te.nombre = N'Despacho económico';

-- 2. Los asientos escritos, por día y por planta (esperado: 4 filas por día — 2 bitácoras × 2 unidades)
SELECT CAST(DATEADD(HOUR,-5,ra.fecha_evento) AS DATE) AS dia_bogota,
       ra.planta_id, b.codigo, COUNT(*) AS filas,
       MAX(JSON_VALUE(ra.campos_extra,'$.hora_estimada')) AS hora_estimada
FROM bitacora.registro_activo ra
JOIN lov_bit.bitacora b ON b.bitacora_id = ra.bitacora_id
WHERE ISJSON(ra.campos_extra) = 1
  AND JSON_VALUE(ra.campos_extra,'$.origen_sistema') = 'DESPACHO_XM'
GROUP BY CAST(DATEADD(HOUR,-5,ra.fecha_evento) AS DATE), ra.planta_id, b.codigo
ORDER BY 1 DESC, 2, 3;

-- 3. Ningún asiento se escapó a una planta que no sea GEC3/GEC32 (esperado: 0 filas)
SELECT DISTINCT planta_id FROM bitacora.registro_activo
WHERE ISJSON(campos_extra) = 1
  AND JSON_VALUE(campos_extra,'$.origen_sistema') = 'DESPACHO_XM'
  AND planta_id NOT IN ('GEC3','GEC32');
```

Y en la aplicación:

- El renglón aparece en la grilla de **Sala de Mando — Jefe de Turno** y de **Ing. de Operación**, en
  las dos unidades, **sin lápiz ni basurero** (autor `SISTEMA`; D-049).
- El tipo `'Despacho económico'` **no** está en el selector al crear un registro a mano.
- El libro **GENE-F03** del mes trae **un solo** renglón por día, con el texto literal y en el bloque
  de turno de su hora. Ojo con el borde: **el asiento del día 1 sale en el libro del mes ANTERIOR**,
  porque la detección ocurrió esa tarde. No es un error.
- La grilla de captura de **Operación 24h** sigue **vacía**: el asiento no la toca.

### 9.4 Qué mirar si el renglón no sale

| Síntoma en `journalctl -u bitacora-api` | Qué significa |
|---|---|
| `[despacho-xm] sweeper DESHABILITADO (…)` | El barrido no está corriendo. Si el motivo es `AUTH_TEST_BYPASS=1`, **el servicio arrancó con el backdoor de test encendido**: eso es un problema mayor que el asiento. |
| `[despacho-xm] no se pudo leer dashboard.despacho_recibido: Invalid object name …` | El dashboard **no se ha desplegado** con el DDL nuevo. Es el paso 1 de §9.1. |
| Nada, ni una línea | El sweeper corre y no hay hecho que leer: XM no publicó, o el scraper del dashboard no lo detectó. Revisa `dashboard.despacho_recibido` directamente. |

> **Ventana ciega conocida y aceptada** (no la busques como bug): si la BD está caída **justo** en el
> instante de la detección, el hecho de ese día se pierde —`#foundTomorrow` se prende antes de
> escribir—. Lo cubren cualquier reinicio del dashboard antes de medianoche y el relleno con hora
> estimada. **La ausencia de una fila no prueba que no llegó el despacho.**

> **El día que Bitácora corra en más de un proceso contra la misma base** (dos instancias tras nginx,
> un `node -e` a mano en paralelo), este runbook deja de alcanzar: ahí el `sp_getapplock` por clave
> dentro de `crearAsientoDespacho` pasa a ser obligatorio. Está anotado en D-064.

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
