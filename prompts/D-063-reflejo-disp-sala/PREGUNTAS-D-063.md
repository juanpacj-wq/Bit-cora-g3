# D-063 — Preguntas y respuestas (congeladas)

> Sesión de planeación 2026-08-28. Estas respuestas son **autoritativas** para toda la
> implementación. Una vez cerradas no se reabren: si algo cambia durante la ejecución, es una
> **desviación** y se documenta en el cierre del lote + el gate, no acá.
>
> Lo que `CLAUDE.md`, `docs/decisions.md` (D-058), `docs/requerimientos/REQ-02` y BIT-RF §RF-074
> ya responden **no se preguntó**: los criterios de aceptación de REQ-02 §6 son la fuente y no se
> reabren. Solo se preguntaron las decisiones de modelado que REQ-02 §5.1 deja explícitamente al
> implementador, y el reparto.

## Fuente del requerimiento
- `docs/requerimientos/REQ-02-reflejo-bitacoras-sala.md` §3.4 (RQ-02.10, RQ-02.11, RQ-02.12), §4
  (RN-02.a…f), §5.1 (decisiones de modelado 1–3) y §6 (criterios 1–10). D-058 implementó la mitad
  de MAND y dejó DISP con "ADR propio pendiente" (D-058 Consecuencias (a)).
- Reservas dadas por el usuario y verificadas por él contra las ramas del repo: **D-063**
  (D-062 = rediseño grilla COMB), convención **36** de `CLAUDE.md`, **BIT-MODBD 2.6**, **BIT-RF
  2.2**, **RF-077**, migración **F35.A1** solo si hiciera falta (no hace falta: sin DDL).

## Lo medido antes de preguntar (2026-08-28)
- `PortalG3_dev`: `disponibilidad_estado` tiene 9 filas (GEC3), 1 vigente, 1 editada; 9 CIET
  "Deshacer disponibilidad" (todos en 90 días); 12 copias MAND en `registro_historico`, 0 vivas;
  tipos espejo `Cambio de Disponibilidad` = `tipo_evento_id` 37 (SALAJDT) y 33 (SALAING),
  `seleccionable=0`; migraciones F30.A1…F33.A1; plantas GEC3/GEC32/TST(`activa=1`)/TSR(`activa=0`).
- `PortalG3` (prod): 14 filas DISP (10 GEC3 + 4 GEC32, todas en 60 días), 10 deshacer; **F34.A1 NO
  está aplicada** (no existe `seleccionable`, 0 copias MAND, 1 solo tipo en cada Sala) → **D-058 no
  está desplegado en prod**; D-063 se desplegará con él. Prod no conoce `TSR`.
- `feat/integrar-asientos-D-059` está exactamente en `6d7e1e2`; `feat/sis-carbon-cierre-2026-08`
  tiene un docs-commit más (`3e9db44`, solo `.md`) que la rama de integración no tiene.
- `TSR` (segunda planta-fixture, la única que refleja) está sembrada con `activa=0`; la rama DISP
  de `POST/PUT /api/registros` rechaza `activa<>1` con 400 "planta_id no es operativa".
- El motor ya trae `asientoDisponibilidad({ planta_id, evento, detalle })` con los 4 estados
  (`server/utils/asientos/index.js:45`, plantillas en `plantillas.js:44`), probado en
  `tests/asientos.test.js:160-163`.
- Hoy CUATRO lugares discriminan "asiento reflejado" por `campos_extra.origen_lote_id` (GUID de
  lote MAND): `permissions.js:80-91` (`CLAVE_ORIGEN_REFLEJO`), espejo SQL de `GET /activos`
  (`registros.js:112`), exclusión del F03 (`f03-datos.js:320`) y el front
  (`BitacorasGecelca3.jsx:1545`). DISP no tiene lote: su origen es `disponibilidad_estado.disponibilidad_id` (INT IDENTITY).

## Ronda 1 — decisiones de modelado (REQ-02 §5.1)

| # | Pregunta | Respuesta |
|---|---|---|
| 1 | **Vínculo origen↔copia y marcador de "reflejado".** (a) `origen_bitacora` pasa a ser el marcador universal (ya lo traen las copias de D-058) y el puntero es por origen: la copia DISP lleva `{ origen_bitacora: 'DISP', origen_disponibilidad_id: <id> }`; se cambian juntos los 4 predicados. (b) Reusar `origen_lote_id` con el id de DISP (cero cambios, clave que miente). **Recomendada: a.** | **(a) `origen_bitacora` como marcador universal + `origen_disponibilidad_id`.** |
| 2 | **Representación de la copia ANULADA** (RQ-02.12), sin DDL. (a) `campos_extra.anulado = { por, nombre, cargo, en }` (shape de `autor_delete` del CIET) + `modificado_por/en` = quien deshizo; `detalle` intacto; `estado` sigue `borrador`. (b) Prefijo `[ANULADO]` en `detalle`. (c) Nuevo valor de `estado` con DDL F35.A1. **Recomendada: a.** | **(a) `campos_extra.anulado`, sin DDL, texto intacto.** |
| 3 | **Presentación.** (a) Grilla: texto tachado + chip "Anulado" (Ban) con tooltip "Deshecho por <nombre> el <fecha Bogotá>", conservando el chip de origen y el ojo; Históricos: mismo tachado + chip leyendo `campos_extra.anulado`. (b) Solo grilla. (c) Solo chip sin tachar. **Recomendada: a.** | **(a) Tachado + chip en grilla e Históricos.** |
| 4 | **Fixture del camino feliz** (`TSR` con `activa=0` vs DISP exige `activa=1`). (a) El test HTTP activa TSR en `before()` y la apaga en `after()`/finally; guard final en `zzz_session_leak_guard` que fuerza `activa=0` y falla si la encontró encendida. (b) Probar solo el módulo, sin HTTP. (c) Relajar el check para TSR (prod conocería la fixture). **Recomendada: a.** | **(a) Activar TSR solo durante el test + guard final.** |

## Ronda 2 — operativa y reparto

| # | Pregunta | Respuesta |
|---|---|---|
| 5 | **Rama base.** (a) `6d7e1e2` (rama de integración tal cual; el docs-commit `3e9db44` se lleva a `feat/integrar-asientos-D-059` aparte, fuera de este flujo). (b) `3e9db44`. **Recomendada: a.** | **(a) `6d7e1e2`.** |
| 6 | **`fecha_evento` y `turno_id` de la copia DISP.** (a) `fecha_evento = fecha_inicio_estado` aunque sea retro-fechada días atrás (aparece bajo el filtro F11 de ESA fecha); `turno` (1\|2) derivado de esa fecha; `turno_id` = turno ABIERTO de la planta del ORIGEN al insertar (o NULL); editar la fecha mueve la copia, `turno_id` no se re-resuelve. (b) `fecha_evento` = instante del registro. **Recomendada: a.** | **(a) Paridad con D-058 (4).** |
| 7 | **Alcance de `POST /deshacer` sobre las copias.** (a) Anula solo las copias del vigente eliminado; la copia del N-1 restaurado no se toca; sin copias → 0 filas sin error; la respuesta gana `copias_anuladas: n` (aditivo). (b) Igual sin tocar el shape. **Recomendada: a.** | **(a) Anula solo las del vigente eliminado; respuesta + `copias_anuladas`.** |

## Ronda final — reparto en olas
| # | Pregunta | Respuesta |
|---|---|---|
| R1 | Propongo **2 olas + cierre, sin `db.js`** (no hay DDL). **O1** = L01 módulo DISP en `reflejo-sala.js` + test de módulo (BD, tx sobre TSR) · L03 front (grilla + Históricos + 2 vitest, puro) · L04 marcador universal `origen_bitacora` (permissions.js + espejo SQL/403 de registros.js + f03-datos.js + tests + guard, HTTP). **O2** = L02 enganches (POST/PUT DISP en registros.js + deshacer en disponibilidad.js + test HTTP sobre TSR + guard en zzz_session_leak_guard) · L05 docs (BIT-MODBD 2.6, BIT-RF 2.2/RF-077, REQ-02/REQ-06, architecture). **Cierre** = ADR D-063 + CLAUDE.md conv. 36. Escritor único de `registros.js`: L04 en O1, L02 en O2. ¿De acuerdo? Alternativas: docs al cierre; fusionar L01+L04. | **De acuerdo.** |

## Criterios de aceptación congelados
| CA | Criterio (falsable) | Verificador previsto | Lote |
|---|---|---|---|
| CA-1 | `crearReflejoDisponibilidad` crea DOS copias (SALAJDT + SALAING, ninguna en SALAOP) con `detalle` = `asientoDisponibilidad`, `tipo_evento_id` = `Cambio de Disponibilidad` de **cada** bitácora destino (coherente D-053), `campos_extra = { origen_bitacora:'DISP', origen_disponibilidad_id }`, `fecha_evento = fecha_inicio_estado`, `turno` derivado de esa fecha, `turno_id` = turno ABIERTO de la planta del origen (NULL si no hay), `creado_por` = autor del origen, `estado='borrador'`. | `tests/reflejo_disponibilidad.test.js` | L01 |
| CA-2 | `actualizarReflejoDisponibilidad` regenera `detalle` + `fecha_evento` + `turno` en las copias VIVAS; `tipo_evento_id` y `turno_id` intactos; `modificado_por/en` solo si algo cambió; 0 filas no lanza. | `tests/reflejo_disponibilidad.test.js` | L01 |
| CA-3 | `anularReflejoDisponibilidad` escribe `campos_extra.anulado = { por, nombre, cargo, en }` + `modificado_por/en`, conserva `detalle` y `origen_*`, NO borra; idempotente (segunda llamada = 0 filas, `anulado.en` no se pisa); 0 filas sin copias no lanza. | `tests/reflejo_disponibilidad.test.js` | L01 |
| CA-4 | `TEST_PLANTA` no refleja (`{ copias:0, omitido:'planta_de_test' }`); estado desconocido / sin `disponibilidad_id` / sin autor / fecha inválida → lanza; **atomicidad a nivel de módulo** (patrón E4.6 de D-058: origen DISP + reflejo en UNA transacción con `creado_por` inexistente → el error se propaga y el rollback deja cero filas, crit. 8). Las tres funciones de MAND siguen verdes (`sala_de_mando_batch.test.js` E4, sin editarlo). | `tests/reflejo_disponibilidad.test.js` + E4 existente | L01 |
| CA-5 | `esAsientoReflejado` y el espejo SQL de `GET /activos` reconocen por `origen_bitacora`: una copia DISP (sembrada por SQL) da `puede_editar=false` y `PUT`/`DELETE` → `403 asiento_reflejado` con `origen_bitacora` y `origen_bitacora_nombre` en el payload y un mensaje que nombra el origen REAL; las copias MAND de D-058 siguen igual (regresión). | `tests/registros_solo_autor.test.js` (casos nuevos 8–9 + 6–7 verdes) | L04 |
| CA-6 | El libro F03 excluye toda copia de Sala por `origen_bitacora IS NULL` (DISP y MAND); un estado DISP con copias sale UNA sola vez (desde la tabla base). | `tests/f03_datos.test.js` (caso nuevo) | L04 |
| CA-7 | Guard estático: los cinco puntos que discriminan "reflejado" (`permissions.js`, espejo de `registros.js`, `f03-datos.js`, `BitacorasGecelca3.jsx`, `HistoricoTable.jsx`) usan `origen_bitacora` y ninguno usa `origen_lote_id IS NULL` / `!!…origen_lote_id` como marcador. | `tests/guard_marcador_reflejo.test.js` (nuevo) | L04 |
| CA-8 | Grilla de Sala: fila con `origen_bitacora` → chip de origen (nombre del catálogo) sin lápiz ni basurero; fila con `anulado` → texto tachado + chip "Anulado" con tooltip "Deshecho por <nombre> el <dd/mm/aaaa HH:mm> (Bogotá)"; el ojo de lectura sigue; `grilla-solo-autor-gate.test.jsx` verde con la fixture actualizada. | `src/components/grilla-asiento-anulado.test.jsx` (nuevo) | L03 |
| CA-9 | Históricos: `HistoricoTable` tacha y marca "Anulado" (tooltip con quién/cuándo) la fila cuyo `campos_extra.anulado` exista; las demás filas idénticas a hoy. `npm run build` verde. | `src/components/historicos/historico-anulado.test.jsx` (nuevo) | L03 |
| CA-10 | `POST /api/registros` (rama DISP) crea las 2 copias en la MISMA transacción, sin importar el cargo que originó (JdT o IngOp); `SALAOP` ninguna. (REQ-02 crit. 1, 2, 4; RQ-02.10) | `tests/disponibilidad_reflejo_http.test.js` | L02 |
| CA-11 | `PUT /api/registros/:id` (rama DISP) que cambia evento, fecha o detalle actualiza las 2 copias con el mismo contenido. (RQ-02.11; crit. 5) | `tests/disponibilidad_reflejo_http.test.js` | L02 |
| CA-12 | `POST /api/disponibilidad/deshacer` deja las 2 copias del vigente eliminado VISIBLES y anuladas (con quién), no toca la copia del N-1 restaurado, responde `copias_anuladas: n`. (RQ-02.12; crit. 7) | `tests/disponibilidad_reflejo_http.test.js` | L02 |
| CA-13 | No-retroactividad y atomicidad de los enganches: estado sembrado por SQL sin copias → `PUT` y `deshacer` responden 200 con 0 copias, sin fabricar ninguna (crit. 9, §8.2); guard estático en el mismo test: los tres call sites (`crearReflejoDisponibilidad`, `actualizarReflejoDisponibilidad`, `anularReflejoDisponibilidad`) viven dentro de la transacción del origen y **no** están envueltos en un `try/catch` propio (crit. 8 por construcción; la atomicidad real la prueba CA-4 a nivel de módulo). | `tests/disponibilidad_reflejo_http.test.js` | L02 |
| CA-14 | La copia se archiva con `cerrarTurno` (llega a `registro_historico` con su `campos_extra`); deshacer después → 0 filas y el histórico intacto. `TEST_PLANTA` no refleja por HTTP (RN-02.e). Guard final: `TSR` queda `activa=0` al cerrar la suite (falla si la encontró encendida y la apaga). | `tests/disponibilidad_reflejo_http.test.js` + `zzz_session_leak_guard.test.js` | L02 |
| CA-15 | Docs: BIT-MODBD **2.6** (§7.11 ampliada: DISP, marcador universal, `anulado`), BIT-RF **2.2** (**RF-077** + nota en RF-074), REQ-02 §3.4 y §8 marcados, REQ-06 §8.3 con la nota de la copia anulada, `docs/architecture.md`. | revisión del gate O2 | L05 |
| CA-16 | `guard_tipo_evento_coherente` y `tipos_evento_espejo` verdes (crit. 10); suite completa sin degradación contra el baseline; ADR D-063 reemplaza el stub; `CLAUDE.md` convención 36. | cierre | cierre |

## Detalles operativos confirmados
- **Sin DDL, sin migración, sin `db.js`.** Los 8 tipos espejo ya existen (F34.A1). `F35.A1` queda
  sin consumir (sigue libre para quien lo necesite).
- **El módulo es único:** las tres funciones DISP viven en `server/utils/reflejo-sala.js` junto a las
  de MAND, con el INSERT compartido refactorizado a un helper interno. Ningún endpoint arma copias.
- **Sin `try/catch` en los enganches** (RQ-02.9): si el reflejo falla, el estado DISP tampoco queda.
- **Copia = registro real** (`registro_activo`, `estado='borrador'`): cuenta en el contador WS,
  archiva por `cerrarTurno` vía `turno_id`, viaja al histórico con su `campos_extra` (incluido
  `anulado`). No publica al dashboard (RN-02.a), no marca participante (RN-02.b).
- **Cross-planta:** DISP lo puede cambiar cualquier cargo con `puede_crear` sobre CUALQUIER planta;
  la copia va a la planta del **origen** (`disponibilidad_estado.planta_id`), no a la de la sesión.
- **Snapshots** de la copia = los que la transacción DISP ya calculó (`jdts_snapshot`,
  `jefes_planta_snapshot → jefes_snapshot`, `ingenieros_snapshot`); no se recalculan.
- **`anulado.en`** lo pone el servidor (ISO UTC, `new Date().toISOString()`), nunca el cliente.
- **`origen_bitacora_nombre`** (chip) sigue saliendo del catálogo por `codigo` en `GET /activos`
  (D-052). En Históricos no hay ese JOIN: el chip de anulado no necesita el nombre del origen.
- **Retro-fechado:** un estado con `fecha_inicio_estado` de días atrás genera su copia con esa
  fecha; se ve en Sala bajo el filtro de esa fecha. Es el mismo comportamiento que una copia MAND
  con hora de llamada pasada.
- **Baseline de suite:** 641/641 backend + 304/304 front en `6d7e1e2` (cierre de D-061, 2026-08-27),
  reciente y documentado → no se re-corre antes de O1.
- **Prod** recibirá F32.A1, F33.A1 y F34.A1 (D-056/D-060/D-058) en el mismo despliegue que D-063:
  el runbook del cierre lo anota; no es trabajo de ningún lote.
