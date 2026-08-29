# D-063 · Ola O2 · Lote L05 — Documentación: BIT-MODBD 2.6, BIT-RF 2.2 (RF-077), REQ-02, REQ-06, architecture

> **Un lote = un chat.** Este archivo tiene que bastar, junto con las secciones de
> `_CONTEXTO-BASE.md` que cita, para ejecutarlo completo. No relees el scaffolding entero.
> Fecha de redacción: 2026-08-28. Escrito por el integrador en la fase 2; el gate de la O1 lo
> enmienda en cabecera si hizo falta.

## ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto
- **ENMIENDA G1 (GATE-O1, 2026-08-28) — léela antes que el resto.** Los tres lotes de la O1 cerraron con 666/666 + 319/319 y cero violaciones; las decisiones D1–D5 están en `GATE-O1.md` §5. Lo que sigue es la copia literal de `GATE-O1.md` §6:
- **`registros.js` cambió de líneas (L04):** la rama DISP del POST va en `:187-299`
  (`insertNuevoEstado` `:278`, `commit` `:291`); la rama DISP del PUT en `:516-644`
  (`actualizarVigente` `:614`, `commit` `:638`). El helper `respAsientoReflejado(db, res, reg, accion)`
  (`:85-111`) y el espejo SQL (`:152`) son de L04 y **no se tocan**; los 403 de PUT/DELETE ya llaman
  `respAsientoReflejado` (`:676`, `:855`).
- **Firmas reales de L01** (`server/utils/reflejo-sala.js`): `crearReflejoDisponibilidad(tx, {
  planta_id, disponibilidad_id, evento, detalle, fecha_inicio_estado, creado_por, snapshots: {
  ingenieros_snapshot, jdts_snapshot, jefes_snapshot } })` — la clave es **`jefes_snapshot`**
  (mapear desde `jefes_planta_snapshot`; `gerentes_produccion_snapshot` no viaja);
  `actualizarReflejoDisponibilidad(tx, { …, modificado_por })`; `anularReflejoDisponibilidad(tx, {
  planta_id, disponibilidad_id, anulado_por: { usuario_id, nombre_completo, cargo } })` — la clave es
  **`cargo`** (pasar `sesion.cargo_nombre`). Las tres aceptan `disponibilidad_id` numérico o string
  numérico; el predicado compara **texto con texto** (`PREDICADO_COPIAS_DISP`, `@id NVarChar`).
  `resolverTurnoAbierto(tx, …)` funciona con la transacción. `TSR` refleja aunque esté `activa=0`
  (el módulo no pasa por `plantaCheck`) — pero el POST/PUT DISP siguen exigiendo `activa=1`, así
  que el toggle de PREGUNTAS #4 sigue siendo necesario para el test HTTP.
- **`campos_extra` de la copia DISP** es exactamente `{"origen_bitacora":"DISP","origen_disponibilidad_id":123}`
  (número) y anulada suma `"anulado":{"por":<int>,"nombre":<string|null>,"cargo":<string|null>,"en":"<ISO UTC>"}`
  como objeto. `JSON_MODIFY` **reemplaza** una clave existente sin fallar: la idempotencia de anular
  vive SOLO en `AND JSON_VALUE(campos_extra,'$.anulado.en') IS NULL`.
- **`permissions.js`** exporta además `origenDeAsientoReflejado(registro) → 'MAND'|'DISP'|null`.
- **El 403 `asiento_reflejado`** ya no dice "Operación 24h": trae `origen_bitacora` +
  `origen_bitacora_nombre` (nombre del catálogo por `codigo`) y el mensaje nombra ese origen. Mensajes:
  editar → "Este asiento se generó en X. Corrígelo allá y se actualiza acá solo."; eliminar →
  "Este asiento se generó en X. Elimínalo o deshazlo allá y esta copia lo refleja."
- **Front:** los helpers `estadoReflejo`, `tituloAnulado`, `fechaHoraBogota`, `ChipAnulado` y la
  prop `anulado` de `DetalleCell` viven en `src/components/historicos/HistoricoTable.jsx`
  (exportados); la grilla los importa. El chip "Anulado" se muestra en todo modo de lectura,
  incluida la grilla bloqueada. Históricos no muestra el nombre del origen.
- **Guard `guard_marcador_reflejo`** audita `registros.js`: las ramas DISP que L02 escriba no pueden
  usar `origen_lote_id` como marcador (regla A) — usar las funciones de L01, no SQL propio.
- **`cleanupTestRegistros`** (gate, D1) ahora borra el CIET del sweeper MAND en `TEST_PLANTA`:
  L02 no lo duplica en su limpieza de TSR.
- **Baseline de suite:** 666/666 backend (con los dos tests nuevos ya enganchados) · 319/319 front.
  `tests/disponibilidad_reflejo_http.test.js` (L02) va en `package.json` después de
  `tests/disponibilidad_anios.test.js` — lo engancha el gate O2.

## 0. Puerta de arranque (obligatorio, primero)
```bash
node "../metodología de implementación/herramientas/lotes.mjs" --impl D-063 claim L05 --sesion L05-HHMM
export LOTE_SESION=L05-HHMM
```
Falla si la O2 no está abierta o si L01/L03/L04 no están `done`. **Detente y reporta** si falla.

## 1. Lee, en este orden y solo esto
1. `_CONTEXTO-BASE.md` §1, §2, §5 completo, §6 completo, §7, §9.
2. `GATE-O1.md` completo y `cierres/L01.md`, `cierres/L03.md`, `cierres/L04.md` (sus
   `### Aporte al ADR` y `Desviaciones`: documentas lo REAL, no el plan).
3. Tu territorio, solo las secciones que tocas: `BIT-MODBD-2026-001.md` §7.11 (`:1648-1690`) y el
   changelog §8 (última fila 2.5); `BIT-RF-2026-001.md` RF-074 (`:543-549`), RF-076 (`:629`, para
   ubicar dónde va RF-077) y el changelog (última fila 2.1, `:904`); `docs/architecture.md:72-74`
   y `:230-232`; `docs/requerimientos/REQ-02-reflejo-bitacoras-sala.md` cabecera (Estado), §3.4 y
   §8; `docs/requerimientos/REQ-06-excel-eventos-operacion.md` §8.3.
4. Solo lectura, para citar con precisión: `server/utils/reflejo-sala.js` (JSDoc de las funciones
   DISP), `server/middleware/permissions.js:70-95`, `server/routes/registros.js` (payload del 403 y
   espejo), `server/routes/disponibilidad.js` (**si L02 ya cerró**; si no, documenta el contrato
   C5 y marca "pendiente de verificación en GATE-O2").
5. `CLAUDE.md` § "Cómo evolucionar este archivo" (para NO escribir ahí: es del cierre) y las
   convenciones 25 y 32 (estilo de las entradas que describen reflejo/nombres).

## 2. Territorio — lo único que puedes crear o editar
- `BIT-MODBD-2026-001.md`
- `BIT-RF-2026-001.md`
- `docs/architecture.md`
- `docs/requerimientos/REQ-02-reflejo-bitacoras-sala.md`
- `docs/requerimientos/REQ-06-excel-eventos-operacion.md`
- `docs/domain-glossary.md` (añadido por el gate O1: H12)
- `prompts/D-063-reflejo-disp-sala/cierres/L05.md`

**NO tocas** nada más: `docs/decisions.md` y `CLAUDE.md` (cierre), `server/**` y `src/**` (L02
vivo en esta ola; L01/L03/L04 cerrados), `ESTADO.md`, `PLAN-OLAS.md`, y los archivos de L02/L06/L07 (vivos en esta ola).

## 3. Contrato
> Consumes C1–C7 de `_CONTEXTO-BASE.md §6` para documentarlos **tal como quedaron** (el gate O1
> puede haberlos enmendado: manda `GATE-O1.md` §6). No produces contratos.

## 4. Trabajo
**Qué se sabe (medido 2026-08-28):** BIT-MODBD está en **2.5** (2026-08-27) y BIT-RF en **2.1**
(RF-076, 2026-08-27); las versiones reservadas son **2.6** y **2.2**, y el requerimiento **RF-077**
(verifica con `grep -n "RF-077\|^| 2.2\|^| 2.6"` que siguen libres antes de escribir — D-061 se
llevó una colisión por no hacerlo). §7.11 de BIT-MODBD hoy documenta solo MAND y termina con "El
reflejo de Disponibilidad queda FUERA de D-058". REQ-02 tiene el aviso ⚠️ de §3.4 y el Estado en
cabecera dice "pendiente"; REQ-06 §8.3 dice "hoy no hay copia que anular".
**La sospecha (verifícala):** que en `docs/architecture.md` haya más de dos menciones a
`reflejo-sala.js`/"reflejo" (busca `grep -n "reflej" docs/architecture.md`) y alguna tabla de
endpoints donde `POST /api/disponibilidad/deshacer` deba ganar `copias_anuladas`.

1. **BIT-MODBD → 2.6**: amplía §7.11 (título "Asientos reflejados en las bitácoras de Sala
   (D-058 + D-063)"): marcador universal `origen_bitacora` (por qué dejó de ser `origen_lote_id`),
   los dos punteros (`origen_lote_id` GUID / `origen_disponibilidad_id` INT), el JSON de la copia
   DISP viva y anulada (C2), la regla "anular ≠ borrar" (RQ-02.12) y por qué `estado` sigue
   `borrador` (sin DDL: archivado/conteo/guards filtran por `borrador`), el predicado SQL con
   `origen_disponibilidad_id` + `bitacora_id IN`, `rowsAffected = 0` no es error también para
   DISP, `fecha_evento = fecha_inicio_estado` vs `turno_id = ABIERTO`, `JSON_MODIFY … JSON_QUERY`
   e idempotencia por `anulado.en IS NULL`, y que el N-1 restaurado no se toca. Fila **2.6** en §8
   con fecha real, "Sin DDL y sin migración (F35.A1 no consumida)", "sin cambios en el contrato
   cross-repo". Borra la frase "queda FUERA de D-058 … ADR propio pendiente" y reemplázala por la
   referencia a D-063.
2. **BIT-RF → 2.2**: nuevo **RF-077 — Reflejo de Disponibilidad a las bitácoras de Sala con copia
   anulada (D-063, <fecha>)** justo después de RF-076, con la tabla Descripción / Actores / Reglas /
   Permiso al estilo de RF-074: crear → 2 copias, editar → actualiza, deshacer → **anula** (visible,
   tachada, con quién y cuándo), autor = autor del origen, cross-planta (la copia va a la planta
   del origen), sin retroactividad, TST no refleja, solo lectura en destino con
   `403 asiento_reflejado` + `origen_bitacora`, respuesta de `/deshacer` + `copias_anuladas`, el
   F03 no incluye las copias ni el evento deshecho (REQ-06 §8.3). En RF-074 cambia "El reflejo de
   Disponibilidad queda fuera" por "Ver RF-077 (D-063)". Fila **2.2** en el changelog.
3. **`docs/architecture.md`**: `reflejo-sala.js` ahora "MAND **y DISP**"; en el párrafo `:230-232`
   agrega los tres enganches DISP y la anulación; si hay tabla de endpoints, `deshacer` gana
   `copias_anuladas`.
4. **REQ-02**: Estado en cabecera → "🟢 Implementado (MAND por D-058, DISP por D-063)"; en §3.4
   reemplaza el aviso ⚠️ por una nota "✅ Implementado por D-063" con los tres puntos resueltos
   (enganches, RQ-02.12, borde de medianoche: la copia DISP es un instante —
   `fecha_inicio_estado`— así que no cruza el día; el T2 partido por medianoche sigue siendo
   asunto del libro); en §5.1 marca las tres decisiones como resueltas (1: tipo espejo ya
   sembrado; 2: `origen_disponibilidad_id` + marcador `origen_bitacora`; 3: `puede_editar=false` +
   403); en §8.3 (menores) deja constancia de que el estado anulado se distingue con chip +
   tachado.
5. **REQ-06 §8.3**: agrega al final "Desde D-063 la copia en Sala SÍ existe y queda anulada; el
   libro sigue sin mostrarla (lee la tabla base y excluye toda copia por `origen_bitacora`)".
6. **Glosario (H12 del `/code-review`, `GATE-O1.md` §7):** `docs/domain-glossary.md:134` define el
   asiento reflejado como "se identifica por `campos_extra.origen_lote_id`" y solo "de un evento de
   Operación 24h". Reescríbelo: marcador universal `origen_bitacora` (MAND o DISP), punteros
   `origen_lote_id` / `origen_disponibilidad_id`, y el estado **anulado** (`campos_extra.anulado`,
   visible, tachado, con quién y cuándo). Si hace falta, entrada nueva "Copia anulada".
7. Verifica que los enlaces relativos que agregues existen (`ls` de cada ruta).

## 5. Criterios de aceptación y sus verificadores
| CA | Criterio | Verificador (tuyo) |
|---|---|---|
| CA-15 | BIT-MODBD 2.6 (§7.11 ampliada + changelog), BIT-RF 2.2 (RF-077 + nota en RF-074 + changelog), architecture.md, REQ-02 (Estado, §3.4, §5.1, §8.3), REQ-06 §8.3, **glosario** (H12) — todo consistente con `GATE-O1.md` §6 y los cierres. | `git diff --stat` acotado a tu territorio; `grep -n "RF-077" BIT-RF-2026-001.md` (≥ 3: sección, RF-074, changelog); `grep -n "2.6" BIT-MODBD-2026-001.md` en el changelog; ningún "pendiente"/"queda fuera" residual sobre DISP: `grep -n "ADR propio pendiente\|queda fuera" BIT-*.md docs/requerimientos/REQ-02*.md` vacío |

Revisión del gate O2: el integrador lee las secciones contra el código real.

## 6. Verificación que corres (solo la tuya)
```bash
git diff --stat -- BIT-MODBD-2026-001.md BIT-RF-2026-001.md docs/architecture.md docs/requerimientos/REQ-02-reflejo-bitacoras-sala.md docs/requerimientos/REQ-06-excel-eventos-operacion.md
grep -n "RF-077" BIT-RF-2026-001.md
grep -n "ADR propio pendiente\|queda fuera\|quedan fuera" BIT-MODBD-2026-001.md BIT-RF-2026-001.md docs/requerimientos/REQ-02-reflejo-bitacoras-sala.md
```
- Sin tests ni backend. Puerto 3105 reservado, no se usa. No corras `npm test`.

## 7. Cierre (obligatorio, en este orden)
1. Escribe `prompts/D-063-reflejo-disp-sala/cierres/L05.md` (plantilla `CIERRE-LOTE.md`, con
   `### Aporte al ADR`: qué quedó documentado dónde).
2. Commitea **solo tus rutas**: — los archivos **nuevos** primero con `git add <ruta exacta>` (uno por uno; nunca `-A`, `.` ni `-u`), porque `git commit -- <rutas>` solo toma lo ya rastreado:
   ```bash
   git commit -m "$(cat <<'EOF'
   docs(D-063 L05): BIT-MODBD 2.6, BIT-RF 2.2 (RF-077), REQ-02/REQ-06 y architecture con el reflejo DISP

   <qué se documentó y contra qué evidencia (GATE-O1, cierres)>
   EOF
   )" -- BIT-MODBD-2026-001.md BIT-RF-2026-001.md docs/architecture.md docs/requerimientos/REQ-02-reflejo-bitacoras-sala.md docs/requerimientos/REQ-06-excel-eventos-operacion.md docs/domain-glossary.md prompts/D-063-reflejo-disp-sala/cierres/L05.md
   ```
3. `node "../metodología de implementación/herramientas/lotes.mjs" --impl D-063 done L05 --sesion $LOTE_SESION`
4. Mensaje final, **con esta forma exacta**:
   ```
   L05 cerrado.
   Commits: <sha> <título>
   Criterios (propuestos, confirma el gate): CA-15 …
   Hallazgos nuevos: <ninguno | …>
   Bloqueos: <ninguno | …>
   Para el gate: <secciones que dependen de L02 y hay que releer en GATE-O2; propuesta de entrada para domain-glossary si aplica>
   ```

## Reglas (no negociables)
- `git commit -- <rutas>` siempre; nunca `git add -A`/`.`; nada de stash, reset, checkout,
  restore, switch, rebase, amend, push, merge.
- El changelog histórico no se reescribe: solo se agrega la fila nueva, en orden de versión.
- No inventes comportamiento: si algo no está verificado en un cierre o gate, escríbelo como
  "según contrato C5, pendiente de verificación en GATE-O2".
- Tuteo colombiano estándar en todo texto; sin voseo.
