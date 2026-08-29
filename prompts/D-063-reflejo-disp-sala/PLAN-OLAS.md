# D-063 — Plan de olas

> Lo escribe el integrador en la fase 2 (2026-08-28) y lo commitea junto con el scaffolding. Es
> la fuente de `LOTES.json` y de los prompts `LNN-<slug>.md`. Solo el integrador lo edita (en un
> gate, con nota de por qué). Los lotes lo leen, no lo tocan.

## Grafo de dependencias
```
L01 (módulo DISP en reflejo-sala.js + test de módulo, BD/TSR) ──┐
L04 (marcador universal origen_bitacora: permissions + espejo + F03 + guard) ──┼─> L02 (enganches POST/PUT/deshacer + test HTTP) ─┐
L03 (front: grilla + Históricos + vitest, puro) ─────────────────┘                                                              ├─> cierre
                                                        L05 (docs BIT-*/REQ/architecture, puro) ───────────────────────────────┘
```
Camino crítico: **L01 + L04 → L02 → cierre**. Fuera del camino crítico: L03 (construye contra C2/C7
ya fijados), L05 (documenta los contratos de §6; el gate O2 corrige el drift si L02 pivotó).

## Olas
| Ola | Lotes | Por qué pueden ir juntos | Compartidos y su escritor |
|---|---|---|---|
| O1 | L01, L03, L04 | Tres raíces con territorios disjuntos: `utils/reflejo-sala.js` + su test (L01) / `src/**` + 3 vitest (L03) / `permissions.js` + `registros.js` (solo lecturas y 403) + `f03-datos.js` + 3 tests (L04). L04 es el **calibrador** del marcador universal: L01 escribe `origen_bitacora` en la copia y L03 lo lee, por contrato C2/C3, sin esperar a L04. | `registros.js` → L04 · `permissions.js` → L04 · `reflejo-sala.js` → L01 · `BitacorasGecelca3.jsx` → L03 |
| O2 | L02, L05, **L06**, **L07** | L02 consume C1 (L01) y C3/C4 (L04) ya verificados en GATE-O1, y engancha en `registros.js` (ahora libre) + `disponibilidad.js`. L05 documenta en `BIT-*`/`docs/` y no comparte ni un archivo con L02. **L06 y L07 los abrió el gate O1 (`GATE-O1.md` §5 D7)** con los hallazgos del `/code-review`: L06 vive en `src/**` + el guard estático (sin contratos nuevos: C2/C3/C7 intactos); L07 en `utils/reflejo-sala.js` + `utils/turno-entidad.js` + sus tests (C1 intacto: solo normalización interna, reloj único y el rescate de D6). Cuatro territorios disjuntos. | `registros.js`, `disponibilidad.js`, `zzz_session_leak_guard.test.js` → L02 · `BIT-*`, `docs/*` → L05 · `src/**`, `guard_marcador_reflejo.test.js` → L06 · `reflejo-sala.js`, `turno-entidad.js` → L07 |
| Cierre | `/cerrar-implementacion D-063` | ADR D-063 (desde los aportes), `CLAUDE.md` conv. 36, REQ-02 §8 revisado, `git rm prompts/D-063-*`, suite completa + build, checklist de smoke UI. Runbook de despliegue: prod recibe F32/F33/F34 con este mismo deploy. | `decisions.md`, `CLAUDE.md` → integrador |

## Lotes

### L01 — Módulo de reflejo DISP en `reflejo-sala.js` (crear / actualizar / anular)
- **Ola:** O1 · **Depende de:** — · **Puro (sin BD):** no (transacción directa sobre `TSR`, sin HTTP) · **Puerto de test:** 3101 (reservado; no levanta backend)
- **Territorio (escritura):** `server/utils/reflejo-sala.js`, `server/tests/reflejo_disponibilidad.test.js` (nuevo)
- **Contratos que produce:** C1, C2 · **que consume:** C3 (solo escribe `origen_bitacora`; no cambia predicados)
- **Criterios de aceptación:** CA-1, CA-2, CA-3, CA-4
- **Tests que corre:** `tests/reflejo_disponibilidad.test.js` (nuevo) + `tests/sala_de_mando_batch.test.js` **sin editarlo** (los E4 de D-058 deben seguir verdes tras el refactor del INSERT; necesita backend efímero en 3101 para esa regresión)
- **Riesgo / nota:** el refactor del INSERT compartido (`insertarCopias`) no puede cambiar ni una columna de lo que MAND escribe. `TSR` está `activa=0`: a nivel de módulo no importa (no pasa por `plantaCheck`), pero `resolverTurnoAbierto` devuelve NULL salvo que el test abra un turno con `resolverOAbrirTurnoAbierto(db, TEST_PLANTA_REFLEJO)` y lo borre al final (patrón `sala_de_mando_batch.test.js:3084-3125`). Limpieza acotada por `TEST_PLANTA_REFLEJO` (incluida `disponibilidad_estado` si siembra origen) — cero residuos.

### L03 — Front: marcador `origen_bitacora` + estado "Anulado" en la grilla de Sala y en Históricos
- **Ola:** O1 · **Depende de:** — (C2/C7 fijados) · **Puro:** sí (vitest + build) · **Puerto de test:** 3103 (reservado; no levanta backend)
- **Territorio:** `src/BitacorasGecelca3.jsx`, `src/components/historicos/HistoricoTable.jsx`, `src/components/grilla-solo-autor-gate.test.jsx`, `src/components/grilla-asiento-anulado.test.jsx` (nuevo), `src/components/historicos/historico-anulado.test.jsx` (nuevo)
- **Contratos que produce:** — · **que consume:** C2, C7
- **Criterios:** CA-8, CA-9
- **Tests que corre:** `npx vitest run src/components/grilla-asiento-anulado.test.jsx src/components/grilla-solo-autor-gate.test.jsx src/components/historicos`, `npm run build`
- **Riesgo / nota:** hasta que L04 cierre, el backend sigue devolviendo `puede_editar=false` por `origen_lote_id`; para una copia DISP real todavía no hay backend. El front decide SOLO por `campos_extra` (C2) y `puede_editar`; no ramifica por `origen_lote_id`. El tooltip formatea `anulado.en` en Bogotá con el helper de `src/utils/fecha.js`, nunca `toLocaleString` a secas.

### L04 — Marcador universal `origen_bitacora`: helper + espejo SQL + 403 + exclusión F03 + guard
- **Ola:** O1 · **Depende de:** — · **Puro:** no (HTTP: `registros_solo_autor` y `f03_datos` pegan a BD) · **Puerto de test:** 3104 (`SKIP_INITDB=1`)
- **Territorio:** `server/middleware/permissions.js`, `server/routes/registros.js` (**solo** el espejo SQL de `GET /activos` y los dos 403 `asiento_reflejado`; las ramas DISP de POST/PUT son de L02 en O2), `server/utils/f03-datos.js`, `server/tests/registros_solo_autor.test.js`, `server/tests/f03_datos.test.js`, `server/tests/guard_marcador_reflejo.test.js` (nuevo)
- **Contratos que produce:** C3, C4 · **que consume:** C2 (la copia DISP la siembra por SQL en sus tests)
- **Criterios:** CA-5, CA-6, CA-7
- **Tests que corre:** `tests/registros_solo_autor.test.js`, `tests/f03_datos.test.js`, `tests/guard_marcador_reflejo.test.js`, y `tests/tipos_evento_espejo.test.js` + `tests/sala_de_mando_batch.test.js` (regresión, sin editarlos)
- **Riesgo / nota:** el guard nuevo audita archivos de L03 (`BitacorasGecelca3.jsx`, `HistoricoTable.jsx`) que en O1 todavía están cambiando: se escribe para que pase con el estado FINAL de C3 y, si al correrlo en O1 el front aún no migró, se reporta como "rojo esperado hasta GATE-O1" en el cierre (no se edita `src/**`). No tocar `mand.js` ni `reflejo-sala.js` (L01).

### L02 — Enganches DISP: POST/PUT en `registros.js`, deshacer en `disponibilidad.js`, test HTTP sobre TSR, guard final
- **Ola:** O2 · **Depende de:** L01, L04 · **Puro:** no · **Puerto de test:** 3102 (`SKIP_INITDB=1`)
- **Territorio:** `server/routes/registros.js` (ramas DISP de POST y PUT), `server/routes/disponibilidad.js`, `server/tests/disponibilidad_reflejo_http.test.js` (nuevo), `server/tests/zzz_session_leak_guard.test.js`
- **Contratos que produce:** C5, C6 · **que consume:** C1, C2, C3, C4
- **Criterios:** CA-10, CA-11, CA-12, CA-13, CA-14
- **Tests que corre:** `tests/disponibilidad_reflejo_http.test.js`, `tests/disponibilidad.test.js` (regresión sobre `TST`, sin editarlo), `tests/zzz_session_leak_guard.test.js`
- **Riesgo / nota:** el test activa `TSR` (`activa=1`) en `before()` y la apaga en `after()` con `try/finally`; abre y borra su propio turno en `TSR` (FK: registros primero, cabecera después) para CA-14; limpia `disponibilidad_estado`/`registro_activo`/`registro_historico`/`evento_dashboard` de `TSR` por parámetro `TEST_PLANTA_REFLEJO` (nunca literal). La atomicidad REAL (error SQL a mitad del reflejo revierte el origen) se prueba a nivel de módulo en L01 (CA-4, patrón E4.6); por HTTP no hay forma limpia de forzar el fallo sin tocar el catálogo, así que CA-13 la fija **por construcción** con un guard léxico sobre los tres call sites (sin `try/catch` propio, dentro de la transacción).

### L05 — Documentación: BIT-MODBD 2.6, BIT-RF 2.2 (RF-077), REQ-02, REQ-06, architecture
- **Ola:** O2 · **Depende de:** L01, L03, L04 (documenta lo verificado en GATE-O1) · **Puro:** sí · **Puerto de test:** 3105 (no aplica)
- **Territorio:** `BIT-MODBD-2026-001.md`, `BIT-RF-2026-001.md`, `docs/architecture.md`, `docs/requerimientos/REQ-02-reflejo-bitacoras-sala.md`, `docs/requerimientos/REQ-06-excel-eventos-operacion.md`
- **Contratos:** — · **consume:** C1–C7 (los documenta)
- **Criterios:** CA-15
- **Tests que corre:** ninguno (`git diff --stat` acotado a su territorio; enlaces relativos válidos)
- **Riesgo / nota:** el ADR D-063 y `CLAUDE.md` NO son suyos (cierre). Documenta la realidad de `GATE-O1.md` §6 (hechos que cambian) y los cierres de L01/L03/L04, no el plan. Si L02 pivota en O2, el gate O2 enmienda estos docs.

### L06 — Front + guard: tooltip honesto en la copia anulada, helpers en `src/utils/reflejo.js`, stripper del guard (añadido en GATE-O1)
- **Ola:** O2 · **Depende de:** L03, L04 · **Puro:** sí (vitest + build + guard estático) · **Puerto de test:** 3106 (reservado; no levanta backend)
- **Territorio:** `src/utils/reflejo.js` (nuevo), `src/BitacorasGecelca3.jsx`, `src/components/historicos/HistoricoTable.jsx`, `src/components/grilla-asiento-anulado.test.jsx`, `src/components/historicos/historico-anulado.test.jsx`, `server/tests/guard_marcador_reflejo.test.js`
- **Contratos:** ninguno nuevo (C2/C3/C7 intactos; los helpers cambian de módulo, no de firma)
- **Criterios:** CA-17, CA-18, CA-19
- **Tests que corre:** `npx vitest run src`, `npm run build`, `node --test tests/guard_marcador_reflejo.test.js`
- **Riesgo / nota:** creado por el gate O1 con H9 (tooltip), H11/H4 (helpers duplicados y en la tabla hoja), H13 (stripper `--` en JS). Al mover los helpers a `src/utils/`, la regla D del guard debe aceptar imports relativos de cualquier profundidad **en el mismo commit** (por eso el guard entra a su territorio). Disjunto de L02/L05/L07.

### L07 — Módulo: reloj único en anular, normalizador de id, y rescate de huérfanos sin cota inferior (añadido en GATE-O1)
- **Ola:** O2 · **Depende de:** L01 · **Puro:** no · **Puerto de test:** 3107 (`SKIP_INITDB=1` para la parte HTTP de `turno-entidad.test.js` si la necesita; el test de módulo corre sin server)
- **Territorio:** `server/utils/reflejo-sala.js`, `server/tests/reflejo_disponibilidad.test.js`, `server/utils/turno-entidad.js`, `server/tests/turno-entidad.test.js`
- **Contratos:** C1 intacto (firmas iguales; `disponibilidad_id` sigue aceptando número o string numérico, ahora solo `/^\d+$/`)
- **Criterios:** CA-20, CA-21, CA-22 (CA-22 **solo con el OK del usuario a D6**)
- **Tests que corre:** `tests/reflejo_disponibilidad.test.js`, `tests/turno-entidad.test.js`, y `tests/sala_de_mando_batch.test.js` (regresión, sin editarlo)
- **Riesgo / nota:** creado por el gate O1 con H10, H14 y H6 (D6). D6 toca `cerrarTurno` en tres sitios (`turno-entidad.js:357/385/394`): quitar `ra.fecha_evento >= @ini` del rescate y dejar `<= @ahora`. Corre en paralelo con L02, que **consume** `reflejo-sala.js` por contrato C1 sin editarlo: cambiar una firma es un bloqueo.

## Criterios de tamaño y reparto aplicados
- Partición por dependencias, no por volumen: L01/L03/L04 son las tres raíces; L02 consume sus
  contratos; L05 documenta lo verificado.
- ≤ 6 archivos de territorio y ≤ 8 CA por lote (L01 2/4, L03 5/2, L04 6/3, L02 4/5, L05 5/1); 3
  lotes en O1, 2 en O2.
- Un solo escritor por compartido y por ola: `registros.js` → L04 (O1) y L02 (O2); nadie toca
  `db.js` ni `package.json` (gate).
- Riesgo asimétrico aislado: el refactor del INSERT compartido de MAND (L01) va con la regresión
  E4 de `sala_de_mando_batch` en el mismo lote; el toggle `activa` de `TSR` (L02) va con su guard
  final en el mismo lote.
- Calibrador: L04 fija el marcador universal (C3/C4) que L02 hereda; L01 fija C1/C2 que L02 y L03
  consumen.
