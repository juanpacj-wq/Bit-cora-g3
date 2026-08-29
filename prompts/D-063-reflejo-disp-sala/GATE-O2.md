# D-063 — GATE-O2 (cierre de la ola O2)

> Lo escribe **solo el integrador** al correr `/cerrar-ola D-063 O2`. Expediente **inmutable**:
> si algo de acá se revierte después, se enmienda encima ("REVERTIDA el … por …"), no se borra.
> Fecha: `2026-08-29` (Bogotá). Rama `feat/reflejo-disp-sala-2026-08`.

## 1. Semáforo al cerrar
```
O2 [abierta]
  L02  done        L02-0142     Enganches DISP: POST/PUT en registros.js, deshacer en disponibilidad.js, test HTTP sobre TSR, guard final ← L01,L04
  L05  done        L05-2043     Docs: BIT-MODBD 2.6, BIT-RF 2.2 (RF-077), REQ-02, REQ-06, architecture ← L01,L03,L04
  L06  done        L06-2043     Front + guard: tooltip honesto en copia anulada, helpers en src/utils/reflejo.js, stripper del guard (GATE-O1 D7) ← L03,L04
  L07  done        L07-2043     Módulo: reloj único en anular, normalizador de id, rescate de huérfanos sin cota inferior (GATE-O1 D6/D7) ← L01
test-lock: libre
```
Lotes sin cierre commiteado: ninguno. Commits de la ola (desde `55bc450`): L06 `717cbfd` + `e5d7f68` ·
L05 `ca67a87` + `9a9f8de` · L07 `6f7b505` + `096fcbd` + `41d6f34` + `891fdae` + `998b6f4` ·
L02 `4fa4ed3` + `55fc2ee` + `4068cc0`.

## 2. Territorios
```
L02 · 3 commit(s) — 5 archivos — [lotes] territorio respetado
L05 · 2 commit(s) — 7 archivos — [lotes] territorio respetado
L06 · 2 commit(s) — 7 archivos — [lotes] territorio respetado
L07 · 5 commit(s) — 5 archivos — [lotes] territorio respetado
```
Violaciones: **ninguna**.

## 3. Verificación de la ola (bajo test-lock `GATE-O2`)
- Tests enganchados a `server/package.json`: `tests/disponibilidad_reflejo_http.test.js` (tras
  `disponibilidad_anios`, como fijó GATE-O1). L05/L06/L07 no pidieron ninguno (los suyos ya estaban
  en la lista o los recoge `vitest run src`).
- **Arreglos de compartidos en el gate** (hallazgos de L02 y L07, fuera de sus territorios):
  `tests/helpers.js` — `cleanupTestRegistros` borra también el CIET "Deshacer disponibilidad" de
  usuarios sintéticos en `TST` (`detalle = NULL`, autor humano de fixture; se acumulaba en corridas
  parciales); `tests/residuos.js` — sonda nueva `turno_unidad en planta de test` (L07 vio una cabecera
  `PROGRAMADO` #2366 en TST que ninguna sonda contaba; el gate la borró por PK + `planta_id='TST'` +
  sin dependientes antes de correr). Guards estáticos 17/17 con esos cambios.
- `npm run build`: ✓ built in 5.26s.
- Front `npx vitest run`: **17 archivos · 324/324** (baseline 319 + 5 de L06).
- Suite backend completa contra el efímero `:3199` (`AUTH_TEST_BYPASS=1`, `SIS_HOST` = stub `:3154`,
  con `initDB`), 9 bloques en primer plano, mismos flags y orden del script `test`:
  ```
  B1 117/117 (411 s) · B2 145/145 (358 s) · B3 46/46 (366 s) · B4 85/85 (282 s) · B5 61/61 (347 s, 0 skipped)
  B6 46/46 (480 s) · B7 53/53 (239 s) · B8 79/79 (414 s) · B9 49/49 (117 s)
  TOTAL ℹ tests 681 · pass 681 · fail 0 · ≈ 50 min
  ```
- Baseline anterior: 666/666 (GATE-O1) → **sin degradación**; los 15 nuevos son exactamente los
  declarados (11 `disponibilidad_reflejo_http` + `guardas ×4` + meta del stripper + CA-22 de
  `turno-entidad` + guard TSR de `zzz_session_leak_guard`).
- Residuos en BD: **ninguno** — `npm run test:residuos` → `[residuos] cero residuos` (11 sondas, con
  la de `turno_unidad`); query directa: `TSR.activa = 0`, `turno_unidad` TST/TSR = 0, sesiones
  sintéticas activas = 0, `registro_activo`/`registro_historico`/`disponibilidad_estado` TST/TSR = 0.
- **Docs de L05 releídos contra el código de L02/L07** (lo pedía su cierre): los cuatro avisos
  "pendiente de verificación en GATE-O2" (BIT-RF RF-077, BIT-MODBD §7.11, REQ-02 §3.4,
  `architecture.md`) se reemplazaron por la constancia de verificación; `architecture.md` gana la
  ubicación real del vocabulario del front (`src/utils/reflejo.js`, hecho de L06 posterior a L05).
  Textos del 403 (L02) y del tooltip (L06) para la copia anulada: distintos en redacción pero
  consistentes en el hecho ("quedó anulado al deshacer … se conserva como constancia del turno" /
  "Su evento se deshizo allá; esta copia se conserva como constancia del turno") — se dejan así.
- `/code-review` (nivel `high`) del diff `55bc450..HEAD`: 15 hallazgos (2 confirmados por su
  pipeline, 4 plausibles, 4 refutados, el resto sin verificar); el gate confirmó a mano #1, #4, #6 y
  #15 contra el código. Consolidados en §7 (H30–H43): **4 arreglados/mitigados en el gate** (H30
  limpieza FK-segura de cabeceras, H31 sonda `TSR.activa`, H33 `cleanDispTestPlanta()` en RN-02.e,
  H43 precondición de jefes → aviso), 2 para el cierre (H35 drift de comentarios/ADR, H38 comentario
  de H10), el resto deuda documentada. Ninguno invalida un criterio de la O2.
- **Re-verificación tras los parches del gate** (bajo test-lock, efímero `:3199` con `SKIP_INITDB`):
  `sala_de_mando_batch` + `disponibilidad_reflejo_http` + `zzz_session_leak_guard` → **98/98**;
  `npm run test:residuos` → cero (la cabecera de `sala_de_mando_batch` la barrió
  `cleanupTestRegistros` sola; sondas nuevas `planta TSR encendida` y `turno_unidad` en 0);
  guards puros 17/17.
- `/security-review` (corrido porque L02 tocó `registros.js`/`disponibilidad.js` y L07 `cerrarTurno`):
  **sin hallazgos ≥ 7**. Verificado: SQL nuevo parametrizado; `creado_por`/`modificado_por`/
  `anulado_por` salen solo de `req.sesion` dentro de ramas ya gateadas por `puede_crear`; el `LEFT JOIN
  borigen` no amplía el `check` (codigo es UNIQUE) ni participa en `canEditarRegistro`; el rescate sin
  cota inferior sigue acotado por `planta_id`, `oculta = 0` y `NOT IN ('DISP','MAND')`;
  `src/utils/reflejo.js` sin `dangerouslySetInnerHTML`; ningún id del body llega al módulo.

## 4. Criterios confirmados (solo lo que el gate vio en verde)
| CA | Propuesto por | Estado confirmado | Verificador corrido por el gate |
|---|---|---|---|
| CA-10 | L02 | `cumple` | `disponibilidad_reflejo_http.test.js › POST DISP…` + `GET /activos…` ✔ (B3) |
| CA-11 | L02 | `cumple` | idem › `PUT del vigente…` + `PUT sobre la COPIA…` ✔ (B3) |
| CA-12 | L02 | `cumple` | idem › `deshacer ANULA…` + `segundo deshacer…` + `PUT y DELETE sobre una copia ANULADA…` ✔ (B3) |
| CA-13 | L02 | `cumple` | idem › `estado sembrado por SQL…` + `atomicidad por construcción…` ✔ (B3) |
| CA-14 | L02 | `cumple` | idem › `con turno ABIERTO…` + `RN-02.e…` ✔ (B3) + `zzz_session_leak_guard › TSR apagada` ✔ (B9) |
| CA-15 | L05 | `cumple` | lectura del gate contra el código de L02/L07; `grep RF-077` = 3; fila 2.6/2.2 en los changelogs; el `grep` de residuales solo deja historia (decisión D8) |
| CA-17 | L06 | `cumple` | `grilla-asiento-anulado.test.jsx` 11/11 ✔ (vitest) |
| CA-18 | L06 | `cumple` **para el reflejo** (propuesto `parcial`; decisión D9) | vitest + build ✔; una sola definición de cada helper en `src/utils/reflejo.js`; la `fechaHoraBogota` privada de COMB queda fuera de alcance |
| CA-19 | L06 | `cumple` | `guard_marcador_reflejo.test.js` 9/9 ✔ (B1) |
| CA-20 | L07 | `cumple` | `reflejo_disponibilidad.test.js › anular ×1` ✔ (B1) |
| CA-21 | L07 | `cumple` | idem › `guardas ×4` ✔ (B1) |
| CA-22 | L07 | `cumple` (D6 ejecutada con el OK del usuario) | `turno-entidad.test.js › CA-22` + huérfanos reescrito ✔ (B2); `sala_de_mando_batch` 85/85 (B4) |

Con esto, **CA-1…CA-15 y CA-17…CA-22 confirmados**; queda **CA-16** (cierre: ADR + conv. 36 + suite final).

## 5. Decisiones tomadas en este gate
### D8 — Verificador de CA-15 vs. changelog inmutable (pregunta de L05)
- **Opciones:** a) aceptar el `grep` con las 2 filas de changelog histórico (BIT-MODBD 2.3, BIT-RF 2.0)
  como hits esperados y 6 hits ajenos a DISP · b) reescribir esas filas · c) acotar el grep al cuerpo
  normativo — **Recomendada:** a.
- **Decidido:** a. El changelog no se reescribe (regla de `01-convenciones.md`); la retractación vive en
  las filas 2.6 y 2.2. Cero residuales en el cuerpo normativo (verificado por el gate).

### D9 — CA-18 "una sola `fechaHoraBogota`" y la copia privada de COMB (propuesto `parcial` por L06)
- **Opciones:** a) leer el criterio "para el reflejo" y confirmar `cumple`; la de
  `Combustibles/override.js:424` (privada, devuelve `null` vs `''`) queda como deuda de COMB · b) abrir
  un lote sobre `src/components/Combustibles/**` — **Recomendada:** a (D-062 es el rediseño de COMB;
  ahí cabe).
- **Decidido:** a. Deuda anotada para D-062 en el ADR.

### D10 — Textos del 403 (L02) y del tooltip (L06) para la copia anulada
- **Decidido:** se conservan ambos tal cual (consistentes en el hecho, distintos en superficie: API vs
  UI). No se abre lote.

### D11 — Hallazgos de L02 sobre compartidos (CIET de deshacer en TST; ambigüedad `dispPeek`)
- CIET de deshacer: **arreglado en el gate** (`helpers.js`, ver §3).
- Ambigüedad de ids `registro_id` ↔ `disponibilidad_id` en el `dispPeek` del PUT (preexistente
  D-026, latente): **deuda documentada** en el ADR; un guard exigiría separar las secuencias o
  prefijar el id de DISP en la ruta — fuera de D-063.

### D12 — Cabecera residual de `turno_unidad` en TST (hallazgo de L07)
- **Decidido:** borrada por el gate (#2366, sin dependientes) y `residuos.js` gana la sonda de
  `turno_unidad` para que no vuelva a pasar en silencio. `sala_de_mando_batch` no se toca: la sonda
  delatará al ofensor en el próximo gate si reincide (deuda menor para el cierre).

## 6. Hechos que cambian lo que dicen los documentos anteriores
> Para el cierre (`/cerrar-implementacion D-063`); no hay ola O3.
- **`GATE-O1.md` §6 "Front"** quedó desactualizado por L06: los helpers (`parseCamposExtra`,
  `estadoReflejo`, `tituloOrigen`, `tituloAnulado`, `fechaHoraBogota`, `ChipAnulado`,
  `CLASES_DETALLE_*`) viven en **`src/utils/reflejo.js`**; `HistoricoTable.jsx` NO re-exporta.
- **`respAsientoReflejado(res, reg, accion)`** es síncrono y sin `db`; los `check` de PUT/DELETE traen
  `origen_bitacora_nombre` por `LEFT JOIN borigen` (H16 hecho). Segundo mensaje del 403 para copia
  anulada (H9).
- **`cerrarTurno` rescata huérfanos sin cota inferior** (D6): el test de D-045 que afirmaba lo
  contrario fue reescrito por L07 (`turno-entidad.test.js:280`); la cota superior se mantiene. **El
  primer cierre tras desplegar archivará de golpe los huérfanos acumulados** de cada unidad
  (sospecha de L07): el runbook del cierre lo anticipa.
- **La deriva app↔BD es real: 89 ms** medidos (H10). Cualquier otro sitio que mezcle `new Date()` con
  `SYSUTCDATETIME()` en la misma fila muestra dos horas.
- `disponibilidad_id` mal formado → `TypeError` "disponibilidad_id inválido (…)" (antes "es
  obligatorio"); `Number.isSafeInteger` exigido.
- Baseline: **681/681** backend · **324/324** front.
- `cleanupTestRegistros` barre además el CIET de deshacer de sintéticos en TST; `residuos.js`
  cuenta `turno_unidad` de TST/TSR.
- Para el cierre: `CLAUDE.md` conv. 32 (H12), conv. 36 nueva con los aportes de los siete cierres;
  deudas al ADR: H2 (`origen_bitacora: ""`), H17 (constante no consumida, deliberado), H18
  (`JSON_VALUE` sin `ISJSON`, ahora en 7 sitios), D9 (`fechaHoraBogota` de COMB), D11 (`dispPeek`),
  D12 (`sala_de_mando_batch` deja cabecera).

## 7. Hallazgos consolidados (deduplicados entre lotes y revisiones)
| # | Origen | Hallazgo | Severidad | Destino |
|---|---|---|---|---|
| H20 | L02 | CIET "Deshacer disponibilidad" de fixtures en TST escapa de `cleanupTestRegistros` (solo en corridas parciales) | baja (tests) | **arreglado en el gate** (D11) |
| H21 | L02 | `dispPeek` del PUT hace ambiguo `registro_id` ↔ `disponibilidad_id` (preexistente D-026) | baja, latente | deuda en el ADR (D11) |
| H22 | L02 | H16 extiende a 2 sitios más la premisa "`campos_extra` es JSON" (= H18) | baja | deuda en el ADR |
| H23 | L05 | `architecture.md:259` documentaba el marcador viejo del F03 | media (doc) | **arreglado por L05** |
| H24 | L05 | El verificador de CA-15 choca con el changelog inmutable | baja | D8 |
| H25 | L06 | `fechaHoraBogota` privada de COMB (`null` vs `''`) | baja | D9 → D-062 |
| H26 | L06 | La regla D del guard NUNCA tuvo límite de un nivel (era el comentario, no el código) | nula | ADR: no acreditar ese "arreglo" |
| H27 | L07 | `sala_de_mando_batch` deja una cabecera `turno_unidad` PROGRAMADO en TST por corrida | baja | D12 (sonda nueva + borrado) |
| H28 | L07 | Deriva app↔BD medida: 89 ms | dato | ADR |
| H29 | L07 | El primer cierre post-deploy archiva de golpe los huérfanos acumulados | operativo | runbook del cierre |
| — | security review | sin hallazgos ≥ 7 | — | — |
| H30 | CR #1 (**confirmado** — el gate ya había visto la #2366) | La sonda nueva de `turno_unidad` no tenía limpieza pareja: `sala_de_mando_batch` ("D-055 2") abre una PROGRAMADO en TST y no la desmonta; en corridas parciales `test:residuos` saldría en exit 2 con todo verde. | media (tests) | **arreglado en el gate**: `cleanupTestRegistros` borra las cabeceras de TST/TSR **sin dependientes** (FK-seguro); re-verificado: tras `sala_de_mando_batch`, `turno_unidad` = 0 sin borrado manual |
| H31 | CR #2 | `TSR` queda `activa=1` durante todo `disponibilidad_reflejo_http`; si el proceso muere, nadie fuera del proceso la apaga y aparece en el selector de unidad real. | media (ventana corta; prod no conoce TSR pero la lista por `activa=1`) | **mitigado en el gate**: sonda `planta TSR encendida` en `residuos.js` (exit 2 si quedó encendida); `setupSesionReflejo` ya la reapaga en la corrida siguiente. Flip por caso en `try/finally` → deuda menor |
| H32 | CR #3 (= H18/H22) | `LEFT JOIN borigen` con `JSON_VALUE` sin `ISJSON` en los `check` de PUT/DELETE (7 sitios en total ya). | baja | deuda: candidata a `CHECK (ISJSON(campos_extra)=1)` con migración propia (fuera de D-063) |
| H33 | CR #4 (**confirmado**) | RN-02.e posteaba DISP en TST sin `cleanDispTestPlanta()` previo (única suite DISP-en-TST que no seguía la convención D-041). | baja (flaky en corridas parciales) | **arreglado en el gate** (llama `cleanDispTestPlanta()` antes del POST) |
| H34 | CR #5 | "Es copia anulada" se decide de tres formas (JS del 403: truthy; SQL de anular: `anulado.en IS NULL`; front: objeto no-array) sin lector único. | baja (latente: un solo escritor) | deuda en el ADR: `esCopiaAnulada(extra)` en `permissions.js` junto a `origenDeAsientoReflejado` |
| H35 | CR #6 (**confirmado**) | Drift de doc: comentario de `reflejo-sala.js:239`, D-058 (4) y conv. 21 siguen diciendo que el rescate es "en-ventana". | media (doc que reintroduce la cota) | **cierre**: pasada de comentarios + ADR D-063 + conv. 21/32/36 |
| H36 | CR #7 | `package.json` en HEAD no enganchaba `disponibilidad_reflejo_http`. | — | va en este commit del gate (era la mecánica normal) |
| H37 | CR #8 | El stripper nuevo no quita un `-- comentario` al final de una línea con código (falso positivo ruidoso, dirección benigna); los guards hermanos `guard_no_prod_*` siguen con el `--.*$` truncador. | baja | deuda: un `stripComments` compartido en `helpers.js` (con CR #13) |
| H38 | CR #9 | La justificación de H10 ("JSON_MODIFY no puede leer SYSUTCDATETIME() de su propio UPDATE") es inexacta: `DECLARE @now = SYSUTCDATETIME()` en un batch funciona; y `anular` es el único escritor de `modificado_en` con reloj de app (89 ms de deriva medida). | baja (ningún consumidor ordena por `modificado_en`) | **cierre**: reescribir el comentario; alternativa DB-clock documentada en el ADR como opción descartada por serialización del ISO |
| H39 | CR #10, #11 | `check` del PUT/DELETE duplicado (con el JOIN nuevo ×2) y predicado de rescate copiado ×3 en `cerrarTurno`. | altitud | deuda (refactor sin cambio de comportamiento; fuera de D-063) |
| H40 | CR #12 (= D5) | Siguen tres formateadores Bogotá (`HistoricoTable.fmtFecha`, `formatFechaHora`, `fechaHoraBogota`). | cosmética | D5/D9 → D-062 |
| H41 | CR #13 | 11 copias del bloque "desmontar cabeceras de turno de una planta-fixture", 3 `cleanReflejo`, 7 strippers en tests. | altitud (tests) | deuda: `limpiarTurnosFixture`/`cleanReflejoTestPlanta`/`stripComments` en `helpers.js` — parcialmente cubierto por H30 |
| H42 | CR #14 | El reflejo se cablea en los handlers (como MAND desde D-058) y el guard exige un solo call site por función; un escritor DISP futuro que vaya por `notificador.js` no reflejaría. | diseño | ADR: alternativa "reflejo dentro de `notificador.js`" registrada y descartada (paridad con MAND; `snapshots` y `sesion` viven en el handler) |
| H43 | CR #15 (plausible, **confirmado** por el gate) | CA-10 exigía `jefes_planta_snapshot !== '[]'`: dependencia de personal real (`es_jefe_planta`), no de la fixture. | baja (flaky por RR. HH.) | **arreglado en el gate**: precondición → aviso; el filo de H7 lo da `jdts` |

## 8. Ola siguiente
- No hay O3: la siguiente etapa es **`/cerrar-implementacion D-063`** (ADR, `CLAUDE.md` conv. 32 + 36,
  smoke UI, `git rm` del scaffolding, runbook de despliegue con F32/F33/F34 pendientes en prod y el
  aviso de H29).
- **Visto bueno del usuario:** pendiente.

## 9. Commit del gate
`9dfbbe3` `gate(D-063): O2 cerrada — 4 lotes, 681/681 backend + 324/324 front, 0 violaciones` (+ este commit de docs con el SHA).
