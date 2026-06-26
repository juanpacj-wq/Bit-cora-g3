# E7 — CLI de backfill + corrida histórica única

## CONTEXTO ACUMULADO (no borrar)
- Lee `_CONTEXTO-BASE.md` y `ESTADO.md`. Etapas previas requeridas: E0–E6 ✅.
- Usa `scrapeDia` y `discoverEarliestDate` de `server/utils/sis/carbon-scraper.js` (E3).
- Resumabilidad vía `bitacora.sis_scrape_log` (`completo=1` ⇒ saltar día).
- **Claude corre esto una vez** desde este equipo (alcanza BD `192.168.17.20` y SIS `192.168.18.201`).

## Objetivo
Cargar todo el histórico de carbón de GEC32 desde el inicio de operación (fecha descubierta).

## Tareas — `server/scripts/backfill-carbon-gec32.js` (ESM)
1. Parsear flags: `--from YYYY-MM-DD`, `--to YYYY-MM-DD` (default hoy), `--throttle-ms`, `--dry-run`.
2. Si no hay `--from`: `discoverEarliestDate(pool)` y loguear la fecha hallada (pedir confirmación o
   exigir `--from` explícito si la heurística no es concluyente).
3. Iterar día por día de `from` a `to`:
   - Saltar días con `sis_scrape_log.completo=1` (resumible).
   - `await scrapeDia(pool, { fecha, scrape_tipo: 'backfill', soloHoy:false })` con throttling entre
     requests para no saturar el SIS.
   - Log de progreso: `fecha`, periodos ok/error, filas escritas, % avance, ETA aproximada.
4. Cierre limpio del pool al terminar; resumen final (días procesados, rango, totales).

## Procedimiento de la corrida única (lo ejecuta Claude)
1. **Sondeo de conectividad y de fecha de inicio**: antes del backfill completo, probar manualmente
   el SIS para fechas candidatas (p. ej. `2018-01-01`, `2019-01-01`, `2020-01-01`, `2021-01-01`) y
   determinar a partir de cuándo hay datos reales. Calibrar los umbrales de `discoverEarliestDate`
   con lo observado. Anotar la **fecha de inicio GEC32** en ESTADO.md y en la decisión D-029.
2. **Prueba acotada**: correr el backfill para 1–2 días históricos conocidos y **spot-check**:
   comparar las celdas escritas contra el `.xlsx` que produce `js-scraper-carbon-g32/scrape.js`
   para esa misma fecha (los `tolvasVal` deben coincidir con `ALIM_1..8`).
3. **Corrida completa**: lanzar `from = fecha_inicio` `to = hoy`. Es larga (años × 24 periodos);
   es resumible, así que si se interrumpe se reanuda. Throttle prudente.
4. **Verificación**:
   - `SELECT YEAR(fecha) y, COUNT(*) FROM bitacora.consumo_combustible WHERE planta_id='GEC32'
      AND combustible_id IN (ALIM_1..8) GROUP BY YEAR(fecha)` — conteos por año razonables.
   - `MIN(fecha)` ≈ fecha de inicio descubierta.
   - Revisar `sis_scrape_log` por días con `periodos_error>0` y reintentar si aplica.

## Prueba
- El CLI corre en `--dry-run` sin escribir. La corrida real es la verificación (paso 4).

## Al terminar
Actualiza `ESTADO.md`: E7 ✅, **fecha de inicio GEC32 descubierta**, rango efectivo cargado,
conteos por año, días con errores pendientes, y resultado del spot-check vs `.xlsx`.
