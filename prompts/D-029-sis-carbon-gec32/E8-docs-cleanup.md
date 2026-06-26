# E8 — Docs + cleanup + commit

## CONTEXTO ACUMULADO (no borrar)
- Lee `_CONTEXTO-BASE.md` y `ESTADO.md`. Etapas previas requeridas: E0–E7 ✅ (todas probadas).
- Convención del repo (CLAUDE.md item 12): el andamiaje `prompts/D-0XX-*` es **efímero**; una vez
  mergeada la feature y volcada la decisión a docs, **se borra** (`git rm`). El historial git lo conserva.

## Objetivo
Documentar D-029, limpiar el andamiaje y el scraper standalone, y commitear todo.

## Tareas
1. **`docs/decisions.md`** — ADR-lite **D-029** (sigue la numeración existente), formato
   Contexto / Decisión / Consecuencias (4–8 líneas):
   - Contexto: scraper standalone del SIS para carbón GEC32; necesidad de ingesta horaria + histórico.
   - Decisión: sweeper horario en backend + `valor_sis`/`sis_scrape_log`; regla operador-gana con
     revertir; autor SISTEMA; backfill resumible; GEC3 fuera de alcance.
   - Consecuencias: dependencia de red al SIS (tolerada con logs); celdas ALIM GEC32 semi-automáticas;
     `consumo_combustible` gana columnas SIS.
2. **`BIT-MODBD-2026-001.md` §4.9**: documentar columnas `valor_sis`, `sis_actualizado_en`, la tabla
   `bitacora.sis_scrape_log`, y la **regla de ownership** (tabla de `_CONTEXTO-BASE.md`).
3. **`Bit-cora-g3/CLAUDE.md`**: agregar convención crítica (item 13) — ingesta SIS de carbón GEC32:
   job horario (`sis-sweeper`), regla operador-gana + `valor_sis`, autor SISTEMA, endpoints
   `sis/scrape` y `consumos/revertir`, GEC3 fuera de alcance. 1–3 frases + link a D-029.
   - Si la sección "Bitácoras especiales / COMB" lo amerita, añadir una frase sobre el origen SIS.
4. **Cleanup**:
   - `git rm -r prompts/D-029-sis-carbon-gec32/`
   - `git rm -r js-scraper-carbon-g32/` (o `Remove-Item` si nunca se trackeó; está untracked).
   - Quitar fixtures temporales que no quieras versionar (decidir si `server/tests/fixtures/*.xls`
     se versiona; si es necesario para tests, mantenerlo).
5. **Commit** (en `Bit-cora-g3/`): un commit cohesivo (o pocos) con mensaje tipo
   `feat(combustibles): D-029 ingesta horaria de carbón GEC32 desde SIS + backfill`. Incluir el
   Co-Authored-By requerido. **No** commitear `.env`. Revisar `git status`/`git diff` antes.

## Prueba
- `cd server && npm test` completo (baseline T4/C5 flaky conocido; el resto verde).
- `npm run lint` y `npm run build` (frontend) verdes.
- `git log`/`git show` confirma que el andamiaje quedó en historia y fuera del árbol.

## Al terminar
Actualiza `ESTADO.md`: E8 ✅ (último update antes de que la carpeta se borre — el ESTADO final queda
en el historial git). Cierra D-029.
