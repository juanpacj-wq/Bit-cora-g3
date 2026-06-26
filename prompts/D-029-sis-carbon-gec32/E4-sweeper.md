# E4 — Sweeper horario + wiring en server.js

## CONTEXTO ACUMULADO (no borrar)
- Lee `_CONTEXTO-BASE.md` y `ESTADO.md`. Etapas previas requeridas: E0–E3 ✅.
- Usa `scrapeDia` de `server/utils/sis/carbon-scraper.js` (E3).
- Patrón de sweeper: copia `server/utils/mand-sweeper.js` (timer, tick, try/catch, reprograma en
  finally, catchup al primer tick, start/stop). Se cablea en `server.js` tras `initDB()` junto a
  `startMandSweeper(db)` (~`server.js:2657`) y se para en el handler `SIGTERM/SIGINT`.

## Objetivo
Job interno que cada hora re-scrapea el día de hoy para GEC32, resiliente a SIS caído.

## Tareas — `server/utils/sis/sis-sweeper.js`
1. `const INTERVAL_MS = 3_600_000;` (1 hora). `let timer = null;`
2. `export function startSisSweeper(pool)`:
   - Idempotente (`if (timer) return;`), log `[sis-sweeper] iniciado`.
   - `tick()`:
     - `try { await scrapeDia(pool, { fecha: hoyBogota(), scrape_tipo: 'horario' }); }`
       `catch (err) { console.error('[sis-sweeper]', err.message); }`
       `finally { timer = setTimeout(tick, INTERVAL_MS); }`
     - **Importante**: un SIS inalcanzable debe quedar atrapado y logueado (no romper el proceso).
       `scrapeDia` ya tolera fetch fallidos por periodo; aquí además protege el tick entero.
   - **Catchup** al arranque: hacer un primer `tick()` poco después de iniciar (p. ej.
     `timer = setTimeout(tick, 10_000)` para no competir con el arranque del server). Opcional:
     re-scrapear también "ayer" una vez si su `sis_scrape_log` no está `completo`.
3. `export function stopSisSweeper()`: `clearTimeout(timer); timer = null;`.
4. En `server/server.js`:
   - Import `import { startSisSweeper, stopSisSweeper } from './utils/sis/sis-sweeper.js';`
   - Tras `startMandSweeper(db)` agregar `startSisSweeper(db);`
   - En el cleanup `SIGTERM/SIGINT` agregar `stopSisSweeper();`

## Prueba
- Arrancar `cd server && npm run dev`: el server levanta, loguea `[sis-sweeper] iniciado`, y NO
  crashea aunque el SIS no responda (verás errores de fetch logueados, no excepción no atrapada).
- Si hay acceso al SIS: tras ~10s el primer tick puebla `consumo_combustible` de GEC32 para hoy;
  `GET /api/combustibles/consumos?planta_id=GEC32&fecha=<hoy>` muestra `valor_sis`.
- Si NO hay acceso: confirmar que el server sigue vivo (otros endpoints responden) y el error se
  loguea. Documentar el comportamiento observado en ESTADO.md.
- `cd server && npm test` sigue verde (baseline T4/C5).

## Al terminar
Actualiza `ESTADO.md`: E4 ✅, archivos (`server/utils/sis/sis-sweeper.js`, `server/server.js`),
comportamiento ante SIS caído observado, y si el catchup de "ayer" se incluyó o no.
