# D-063 — GATE-O1 (cierre de la ola O1)

> Lo escribe **solo el integrador** al correr `/cerrar-ola D-063 O1`. Expediente **inmutable**:
> si algo de acá se revierte después, se enmienda encima ("REVERTIDA el … por …"), no se borra.
> Fecha: `2026-08-28 20:40` (Bogotá). Rama `feat/reflejo-disp-sala-2026-08`.

## 1. Semáforo al cerrar
```
D-063 · rama feat/reflejo-disp-sala-2026-08

O1 [abierta]
  L01  done        L01-1804     Módulo de reflejo DISP en reflejo-sala.js (crear / actualizar / anular)
  L03  done        L03-1804     Front: marcador origen_bitacora + estado Anulado en grilla de Sala e Históricos
  L04  done        L04-1804     Marcador universal origen_bitacora: helper + espejo SQL + 403 + exclusión F03 + guard

O2 [pendiente]
  L02  pending                  Enganches DISP … ← L01,L04
  L05  pending                  Docs … ← L01,L03,L04

test-lock: libre
```
Lotes sin cierre commiteado: ninguno. Commits de la ola (desde el scaffolding `7b7154d`):
`e2216da` + `fd0f1af` (L03) · `f11b76b` + `a0cca57` (L01) · `478218c` + `4a1b184` (L04).

## 2. Territorios
```
L01 · 2 commit(s): a0cca57 f11b76b — 3 archivos — [lotes] territorio respetado
L03 · 2 commit(s): fd0f1af e2216da — 6 archivos — [lotes] territorio respetado
L04 · 2 commit(s): 4a1b184 478218c — 7 archivos — [lotes] territorio respetado
```
Violaciones: **ninguna**.

## 3. Verificación de la ola (bajo test-lock `GATE-O1`)
- Tests enganchados a `server/package.json`: `tests/reflejo_disponibilidad.test.js` (tras
  `asientos_catalogo`), `tests/guard_marcador_reflejo.test.js` (tras `guard_tipo_evento_coherente`).
  Los vitest de L03 los recoge `vitest run` por el `include` de `src/**`.
- `npm run build`: ✓ built in 4.68s.
- Front `npx vitest run`: **17 archivos · 319/319** (baseline 304 + 15 nuevos de L03).
- Suite backend completa contra el efímero `:3199` (`AUTH_TEST_BYPASS=1`, `SIS_HOST` = stub
  `:3154`, **con `initDB`** — nadie tocó `db.js`), corrida en 9 bloques en primer plano con los
  mismos flags del script `test` (`--test-concurrency=1`, mismo orden):
  ```
  B1 115/115 (413 s) · B2 144/144 (369 s) · B3 35/35 (272 s) · B4 85/85 (300 s) · B5 61/61 (385 s, 0 skipped)
  B6 46/46 (555 s) · B7 53/53 (261 s) · B8 79/79 (421 s) · B9 48/48 (125 s)
  TOTAL ℹ tests 666 · pass 666 · fail 0 · ≈ 52 min
  ```
- Baseline anterior: 641/641 (cierre de D-061) → **sin degradación**; los 25 tests nuevos son
  exactamente los declarados (12 módulo DISP + 8 guard + 3 `registros_solo_autor` + 2 `f03_datos`).
- Residuos en BD: **ninguno** — `npm run test:residuos` → `[residuos] cero residuos`; query directa:
  `TSR.activa = 0`, `turno_unidad` de TST/TSR = 0, sesiones sintéticas activas = 0,
  `registro_activo` TST/TSR = 0, `disponibilidad_estado` TST/TSR = 0.
- Incidente durante el gate: la BD `192.168.17.20` estuvo inalcanzable ≈ 20 min (ping 100 %
  perdido); el primer efímero murió en `initDB`. Se esperó la red y se repitió desde B1. No afecta
  el resultado.
- `/code-review` (nivel `high`) del diff `7b7154d..HEAD`: 15 hallazgos (7 confirmados, 1
  plausible, 7 sin verificar por su agente, 1 refutado); el gate verificó a mano los tres de
  más peso (H6, H10, H13) contra el código. Consolidados y con destino en §7: **1 arreglado en el
  gate** (H19), **2 lotes de corrección** en O2 (L06, L07 — D7), **tareas añadidas** a L02/L05, y 3
  deudas documentadas (H17, H18, H2). Ninguno invalida un criterio de la O1: todos son latentes (sin
  call site aún) o de texto/altitud.
- `/security-review` (corrido porque L04 tocó `permissions.js` y SQL con `JSON_VALUE`): **sin
  hallazgos con confianza ≥ 7**. Verificado: todo el SQL nuevo va parametrizado; `origen_bitacora`
  no es fabricable desde un body (`validateCamposExtra` solo arma claves declaradas y las Sala tienen
  `definicion_campos = NULL`); `canEditarRegistro` evalúa `esAsientoReflejado` antes que la autoría;
  sin `dangerouslySetInnerHTML`; las tres funciones DISP aún no tienen call site en producción.

## 4. Criterios confirmados (solo lo que el gate vio en verde)
| CA | Propuesto por | Estado confirmado | Verificador corrido por el gate |
|---|---|---|---|
| CA-1 | L01 | `cumple` | `reflejo_disponibilidad.test.js › crear ×1..×3` ✔ (B1) |
| CA-2 | L01 | `cumple` | idem › `actualizar ×1..×3` ✔ (B1) |
| CA-3 | L01 | `cumple` | idem › `anular ×1..×3` ✔ (B1) |
| CA-4 | L01 | `cumple` | idem › `guardas ×1..×3` ✔ + `sala_de_mando_batch` 85/85 sin editar (B4) |
| CA-5 | L04 | `cumple` | `registros_solo_autor.test.js` 6–10 ✔ (B6) |
| CA-6 | L04 | `cumple` | `f03_datos.test.js` E8.8/E8.8b/E8.8c ✔ (B2) |
| CA-7 | L04 | `cumple` | `guard_marcador_reflejo.test.js` 8/8 ✔ (B1, contra HEAD con L03 ya commiteado) |
| CA-8 | L03 | `cumple` | `grilla-asiento-anulado.test.jsx` 8/8 + `grilla-solo-autor-gate` 9/9 ✔ (vitest) |
| CA-9 | L03 | `cumple` | `historico-anulado.test.jsx` 6/6 ✔ + build ✔ |

## 5. Decisiones tomadas en este gate
### D1 — Residuo de CIET del sweeper MAND en `TST` (hallazgo de L01 y L04)
- **Qué lo provoca:** `cerrarDiaMand` (test 8 de `sala_de_mando_batch`) inserta un CIET con autor
  SISTEMA y `detalle = NULL`; `cleanupTestRegistros` barría por `detalle LIKE @tag` y `cleanMand` por
  la bitácora MAND → 2 filas por corrida y `test:residuos` en exit 2.
- **Opciones:** a) `cleanupTestRegistros` borra en `TEST_PLANTA` por autor SISTEMA + `motivo =
  'mand-sweeper-diario'` · b) `cleanMand` amplía a CIET · c) dejarlo y borrar a mano en cada gate —
  **Recomendada:** a.
- **Decidido:** a (integrador, 2026-08-28) — `server/tests/helpers.js`, archivo compartido, editado
  en el gate; acotado por `TEST_PLANTA_ID` (pasa `guard_no_prod_historico_destruction`). Verificado:
  tras B4 la suite terminó con residuos 0 sin intervención manual.
- **Qué cambia / qué NO cambia:** solo la limpieza de tests; ningún contrato.
- **Enmiendas que produce:** L02 §Trabajo (si copia la limpieza de TSR, no duplica esto).

### D2 — Divergencia teórica helper↔SQL para `origen_bitacora: ""` (hallazgo de L04)
- **Qué lo provoca:** el espejo SQL da `puede_editar=0` para cadena vacía y el helper JS "no reflejado".
- **Opciones:** a) `NULLIF(JSON_VALUE(…),'') IS NULL` en los dos SQL + regla C del guard · b) no tocar:
  ningún escritor produce ese shape y el cliente no puede inyectarlo (§3 security review) —
  **Recomendada:** b.
- **Decidido:** b. Queda documentado como deuda de endurecimiento en el ADR (no en código). Si algún
  día un tercer escritor de `campos_extra` aparece, se revisa junto con D-058 (g).

### D3 — `actualizarReflejoDisponibilidad` no excluye copias ya anuladas (sospecha de L01)
- **Opciones:** a) añadir `AND JSON_VALUE('$.anulado.en') IS NULL` al predicado de actualizar · b) no
  tocar: inalcanzable en el flujo (solo se edita el VIGENTE; una copia anulada corresponde a un
  estado ya eliminado; los ids son IDENTITY y no se reusan) — **Recomendada:** b.
- **Decidido:** b. L02 no necesita cubrirlo con test.

### D4 — Helpers del front compartidos viven en `HistoricoTable.jsx` (desviación de L03)
- **Qué lo provoca:** el prompt asumía un `fechaBogota` en `src/utils/fecha.js` que no existe; L03
  exportó `estadoReflejo`, `tituloAnulado`, `fechaHoraBogota`, `ChipAnulado` desde `HistoricoTable.jsx`
  y la grilla los importa (sin ciclo).
- **Opciones:** a) dejar así · b) moverlos a `src/utils/reflejo.js` en el cierre — **Recomendada:** a
  ahora, b como opcional del cierre (la regla D del guard acepta el import relativo de un nivel; si
  se mueven a `src/utils/`, actualizar la regla D en el mismo commit).
- **Decidido:** a. Anotado para el cierre.

### D5 — Formato de fecha de la fila (`03:15 p. m.`) vs tooltip del chip (`15:15`) (sospecha de L03)
- **Decidido:** no se toca en D-063; cosmético y fuera de alcance. Queda en el checklist de smoke UI
  del cierre para que el usuario decida si unifica.

### D6 — Copia con `turno_id NULL` y fecha pasada nunca se archiva (H6, del `/code-review`)
- **Qué lo provoca:** `cerrarTurno` rescata huérfanos solo con `fecha_evento >= inicio_nominal` del
  turno que cierra (`turno-entidad.js:357/385/394`). Una copia creada sin turno ABIERTO (auto-cierre
  sin sucesor, gavela D-046) lleva `turno_id NULL` y `fecha_evento` narrativa (pasada) → ningún
  cierre la alcanza; queda viva e imborrable en Sala. D-058 (4) asumía que "ahí sí lo levanta el
  rescate": es falso. Aplica a MAND desde D-058; DISP lo vuelve probable (retro-fechado).
- **Opciones:** a) quitar la cota inferior del rescate (`turno_id IS NULL AND planta AND
  fecha_evento <= @ahora`) en los tres sitios + test de regresión — un huérfano viejo de la unidad se
  archiva en el siguiente cierre, que es lo que "rescate" debería significar · b) que el reflejo,
  sin turno abierto, apunte al último turno CERRADO — no: lo archivaría nadie · c) deuda documentada
  — **Recomendada:** a, en un lote propio (L07) porque toca `cerrarTurno` (D-045).
- **Decidido:** a **condicionado al visto bueno del usuario** (cambia una regla de D-045). Sin OK,
  L07 ejecuta solo H10/H14 y H6 queda como deuda en el ADR.
- **Enmiendas que produce:** L07 (nuevo); nota en L02 (su test de CA-14 abre turno; el caso "sin
  turno" no es suyo).

### D7 — Reparto de la O2 ampliado con dos lotes de corrección
- **Qué lo provoca:** los hallazgos H6, H9–H11, H13, H14 del `/code-review` caen fuera de los
  territorios de L02/L05 (front cerrado de L03; módulo cerrado de L01; guard de L04).
- **Opciones:** a) O2 = L02 + L05 + **L06** (front + guard: tooltip anulado, `src/utils/reflejo.js`,
  stripper) + **L07** (módulo + rescate: reloj único, normalizador de id, D6) · b) dejar H9–H14 para
  el cierre · c) fusionar en L02 — **Recomendada:** a (territorios disjuntos: L02 `routes/*` +
  su test; L05 docs; L06 `src/**` + guard; L07 `utils/reflejo-sala.js` + `utils/turno-entidad.js` +
  sus tests).
- **Decidido:** a (integrador). `PLAN-OLAS.md` y `LOTES.json` actualizados; prompts L06/L07 nuevos.
  L05 gana `docs/domain-glossary.md` (H12).

## 6. Hechos que cambian lo que dicen los documentos anteriores
> Este bloque se copia **tal cual** al inicio de cada prompt de la ola O2.
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

## 7. Hallazgos consolidados (deduplicados entre lotes y revisiones)
| # | Origen | Hallazgo | Severidad | Destino |
|---|---|---|---|---|
| H1 | L01, L04 | CIET del sweeper MAND en TST escapa de toda limpieza → `test:residuos` exit 2 | media (solo tests) | **arreglado en el gate** (D1, `helpers.js`) |
| H2 | L04 | `origen_bitacora: ""` diverge helper↔SQL (teórico, sin escritor) | baja | D2: documentar en ADR, sin código |
| H3 | L01 | actualizar no excluye copias anuladas (inalcanzable) | baja | D3: sin cambio |
| H4 | L03 | helpers compartidos en `HistoricoTable.jsx`, no en `src/utils/` | nula | D4: opcional del cierre |
| H5 | L03 | fecha de fila vs tooltip con formatos distintos | cosmética | D5: checklist de smoke del cierre |
| — | security review | sin hallazgos ≥ 7 | — | — |
| H6 | CR (2 finders; **verificado por el gate** en `turno-entidad.js:357/385/394`) | El rescate de huérfanos de `cerrarTurno` exige `fecha_evento >= inicio_nominal` del turno que cierra: una copia (DISP retro-fechada, o MAND con hora de llamada pasada) creada cuando NO hay turno ABIERTO queda con `turno_id NULL` y `fecha_evento` anterior a la ventana → **nunca se archiva**, visible en Sala para siempre e imborrable (403). Preexistente para MAND desde D-058 (4); DISP lo vuelve probable (retro-fechado). | **alta** (latente: requiere hueco sin turno abierto) | **D6 → L07** (O2), sujeto al OK del usuario porque toca `cerrarTurno` (D-045) |
| H7 | CR (sin verificar) | `insertarCopias` lee `snapshots.jefes_snapshot` y el origen DISP lo llama `jefes_planta_snapshot`: si L02 pasa las variables "a mano" sin mapear, la copia se archiva con `jefes_snapshot='[]'` en silencio. | media | **L02**: el contrato C5 ya mapea; el test de CA-10 debe afirmar que la copia trae el snapshot REAL del origen (no `'[]'`) |
| H8 | CR (sin verificar) | `anularReflejoDisponibilidad` lee `anulado_por.cargo`; la sesión expone `cargo_nombre` → pasar `anulado_por: sesion` sella `cargo: null` para siempre. | media | **L02**: C5 ya mapea `cargo: sesion.cargo_nombre`; el test de CA-12 debe afirmar `anulado.cargo` = nombre real del cargo |
| H9 | CR (**confirmado**) | El consejo del 403 `eliminar` ("Elimínalo o deshazlo allá y esta copia lo refleja") y el tooltip del chip de origen ("se actualiza sola") son falsos para una copia DISP **anulada** (su origen ya no existe) o de un estado N-2 (deshacer solo alcanza el vigente). | media (texto engañoso, sin efecto en datos) | **L02** (403: rama por `anulado`) + **L06** (tooltip por `anulado`) |
| H10 | CR (sin verificar; **verificado por el gate** en `reflejo-sala.js:594`) | `anulado.en` = reloj de Node y `modificado_en = SYSUTCDATETIME()` en el mismo UPDATE: con deriva app↔BD, el tooltip y la auditoría muestran minutos distintos. | baja | **L07**: un solo `@en` bindeado a ambos |
| H11 | CR (**confirmado**) | `parseCamposReflejo` (HistoricoTable) duplica `parseCamposExtra` (grilla) con semántica distinta, y `fechaHoraBogota` es la tercera copia del formateador Bogotá; helpers en la tabla hoja (= H4). | baja | **L06**: `src/utils/reflejo.js` con un solo parse y un solo formateador |
| H12 | CR (**confirmado**) | `docs/domain-glossary.md:134` y `CLAUDE.md` conv. 32 siguen diciendo "se identifica por `origen_lote_id`" y "el reflejo de DISP quedó FUERA". | media (doc que induce a reintroducir el bug) | glosario → **L05** (territorio ampliado); conv. 32 → **cierre** (junto con la 36) |
| H13 | CR (sin verificar; **verificado por el gate** en `guard_marcador_reflejo.test.js:59`) | El stripper aplica `--.*$` también a JS/JSX: una línea con `i--`/`--tw-*` se trunca antes de auditar (falso negativo/positivo). Hoy ningún archivo vigilado tiene una. | baja | **L06** (el guard entra a su territorio): `--` solo al inicio de línea (comentario SQL) |
| H14 | CR (sin verificar) | `Number(disponibilidad_id)` acepta `true`→1, `'1e2'`→100, `[7]`→7; bloque duplicado en actualizar/anular. Callers previstos pasan INT de la BD → latente. | baja | **L07**: `normalizarIdDisponibilidad` único con `/^\d+$/` |
| H15 | CR (plausible) | `ACCION_REFLEJO[accion]` con una acción desconocida lanza TypeError → 500 en vez de 403. Solo dos call sites válidos hoy. | baja | **L02**: `Object.freeze` + error claro (una línea) |
| H16 | CR (sin verificar) | `respAsientoReflejado` hace un SELECT propio al catálogo en la vía del 403 cuando el `check` ya hace `INNER JOIN lov_bit.bitacora`; dependencia de BD en la vía de rechazo. | baja | **L02** (opcional): `LEFT JOIN borigen` en los dos `check` y helper síncrono; si no cabe, deuda |
| H17 | CR (altitud) | `CLAVE_ORIGEN_REFLEJO` se exporta pero los SQL deletrean el literal; el guard regla C fija el literal. | nula | **Sin cambio, deliberado**: el guard vigila el string a propósito (un literal en SQL es lo que se audita); documentar en ADR |
| H18 | CR (plausible) | `JSON_VALUE` sin `ISJSON` en `PREDICADO_COPIAS_DISP` (y en MAND y el espejo): una fila con `campos_extra` no-JSON rompería el UPDATE dentro de la transacción del origen. Preexistente, documentado en BIT-MODBD §7.11 y D-058 (g). | baja | deuda documentada (ADR); sin cambio en D-063 |
| H19 | CR (altitud) | El comentario del arreglo D1 atribuye el CIET al "sweeper" cuando lo emiten las llamadas directas a `cerrarDiaMand` de `sala_de_mando_batch` (el sweeper solo corre GEC3/GEC32). | nula | **arreglado en el gate** (comentario de `helpers.js`) |
| — | CR (refutado) | `finally` de `crear ×3` en `reflejo_disponibilidad.test.js` | — | descartado |

## 8. Ola siguiente
- Prompts enmendados: `L02-enganches-disp.md` (cabecera + §4 tareas H7/H8/H9/H15/H16),
  `L05-docs.md` (cabecera + glosario H12), copiando §6.
- Reparto revisado: **O2 = L02 + L05 + L06 + L07** (D7). `PLAN-OLAS.md` y `LOTES.json`
  actualizados (L06/L07 agregados por el gate; `LOTES.json` editado con script atómico porque
  `lotes.mjs` no tiene verbo para añadir lotes). L07 ejecuta D6 **solo con el OK del usuario**.
- Para el cierre: reescribir `CLAUDE.md` conv. 32 (H12) al añadir la 36; checklist de smoke UI
  con D5; deudas H2/H17/H18 al ADR.
- **Visto bueno del usuario:** pendiente (incluye el OK explícito a D6).

## 9. Commit del gate
`1784703` `gate(D-063): O1 cerrada — 3 lotes, 666/666 backend + 319/319 front, 0 violaciones` (+ este commit de docs con el SHA).
