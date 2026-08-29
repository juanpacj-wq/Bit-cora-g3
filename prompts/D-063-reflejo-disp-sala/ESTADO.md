# D-063 — ESTADO (tablero por olas)

> Lo escribe **solo el integrador** (fase 2 y cada gate). Los lotes NO lo tocan: su estado vive en
> `cierres/LNN.md` y en `LOTES.json`. Corto a propósito: el detalle está en los cierres y en los
> `GATE-On.md`.

## Tablero
| Ola | Lote | Título | Estado | Cierre | Gate |
|---|---|---|---|---|---|
| O1 | L01 | Módulo de reflejo DISP en `reflejo-sala.js` (crear / actualizar / anular) | ✅ | `cierres/L01.md` (`f11b76b`, `a0cca57`) | GATE-O1 |
| O1 | L03 | Front: marcador `origen_bitacora` + estado "Anulado" (grilla + Históricos) | ✅ | `cierres/L03.md` (`e2216da`, `fd0f1af`) | GATE-O1 |
| O1 | L04 | Marcador universal `origen_bitacora`: helper + espejo SQL + 403 + F03 + guard | ✅ | `cierres/L04.md` (`478218c`, `4a1b184`) | GATE-O1 |
| — | GATE-O1 | 3 lotes · 666/666 backend · 319/319 front · 0 violaciones · CA-1…CA-9 `cumple` | ✅ visto bueno 2026-08-28 | | `GATE-O1.md` (`1784703`) |
| O2 | L02 | Enganches DISP (POST/PUT/deshacer) + test HTTP sobre TSR + guard final | ✅ | `cierres/L02.md` (`4fa4ed3`) | GATE-O2 |
| O2 | L05 | Docs: BIT-MODBD 2.6, BIT-RF 2.2 (RF-077), REQ-02, REQ-06, architecture, glosario | ✅ | `cierres/L05.md` (`ca67a87`) | GATE-O2 |
| O2 | L06 | Front + guard: tooltip honesto en copia anulada, helpers en `src/utils/reflejo.js`, stripper (GATE-O1 D7) | ✅ | `cierres/L06.md` (`717cbfd`) | GATE-O2 |
| O2 | L07 | Módulo: reloj único, normalizador de id, rescate de huérfanos sin cota inferior (GATE-O1 D6 aprobada) | ✅ | `cierres/L07.md` (`6f7b505`, `096fcbd`) | GATE-O2 |
| — | GATE-O2 | 4 lotes · 681/681 backend · 324/324 front · 0 violaciones · CA-10…CA-15, CA-17…CA-22 `cumple` | ✅ (visto bueno pendiente) | | `GATE-O2.md` |
| Cierre | — | ADR D-063 + `CLAUDE.md` conv. 32 y 36 + comentarios (H35/H38) + `git rm` del scaffolding + runbook | ⬜ | | |

Leyenda: ⬜ pendiente · 🟡 en curso · ✅ done (lote) / cerrada con visto bueno (ola) · ⛔ bloqueado.
La verdad operativa es `lotes.mjs status`; esta tabla es la foto que deja cada gate.

## Baseline de la suite
| Momento | Resultado | Duración |
|---|---|---|
| Antes de O1 (rama base `6d7e1e2`, cierre de D-061, 2026-08-27) | backend `641/641` · front `304/304` (documentado en el cierre de D-061; no se re-corrió) | ~40 min |
| GATE-O1 (2026-08-28) | backend **`666/666`** (9 bloques, efímero `:3199` con `initDB`, stub SIS) · front **`319/319`** · build ✓ · residuos 0 | ≈ 52 min |
| GATE-O2 (2026-08-29) | backend **`681/681`** (9 bloques, mismo montaje) · front **`324/324`** · build ✓ · residuos 0 (12 sondas: + `turno_unidad`, + `TSR.activa`) · re-verificación post-parches 98/98 | ≈ 50 min + 9 |
| Cierre | | |

## Hechos descubiertos (acumulado, breve)
- Fase 2: **prod (`PortalG3`) no tiene F34.A1** (ni F32.A1/F33.A1): D-058 no está desplegado allá.
  D-063 sale a prod en el mismo despliegue; el cierre lo anota en el runbook.
- Fase 2: `TSR` está `activa=0` y la rama DISP exige `activa=1` → el test HTTP de L02 la enciende
  solo durante la corrida y un guard final la apaga (PREGUNTAS #4).
- GATE-O1: el CIET del sweeper MAND en `TST` escapaba de toda limpieza (H1) → arreglado en
  `cleanupTestRegistros` (D1). `JSON_MODIFY` reemplaza una clave existente sin fallar: la idempotencia
  de anular vive solo en el predicado SQL (L01). El predicado de las copias DISP compara texto con
  texto (`JSON_VALUE` es NVARCHAR). El 403 `asiento_reflejado` es origin-aware (payload C4).
- GATE-O1: la BD estuvo inalcanzable ≈ 20 min durante el gate (red/VPN); se esperó y se repitió la
  suite desde el inicio. `/code-review` abrió L06/L07 (D7) y H6 → D6 (aprobada).
- GATE-O2: D6 ejecutada — `cerrarTurno` rescata huérfanos sin cota inferior (cambia una regla de
  D-045; el test que la afirmaba fue reescrito). Deriva app↔BD medida: 89 ms (H10 era real). Los
  helpers del front viven en `src/utils/reflejo.js` (invalida `GATE-O1.md` §6 "Front"). El CIET de
  deshacer de fixtures, las cabeceras `turno_unidad` huérfanas de TST/TSR y `TSR.activa` ahora se
  limpian/vigilan (`helpers.js`, `residuos.js`). El primer cierre tras el deploy archivará de golpe
  los huérfanos acumulados (H29, runbook). El test HTTP de L02 nació con CRLF (git lo normaliza).

## Desviaciones acumuladas respecto a `_CONTEXTO-BASE.md`
- GATE-O1 D4/D7: los helpers puros del front no viven en `src/utils/fecha.js` sino en
  `src/utils/reflejo.js` (L06); `HistoricoTable.jsx` no re-exporta.
- GATE-O1: §3.2 del contexto citaba líneas de `registros.js` que L04 movió; las nuevas están en
  `GATE-O1.md` §6.
- GATE-O2: `respAsientoReflejado` es síncrono y sin `db` (H16); el 403 de una copia anulada tiene
  un segundo mensaje (H9). `cerrarTurno` (D-045) rescata huérfanos sin cota inferior (D6).
  `disponibilidad_id` exige `/^\d+$/` + `Number.isSafeInteger` (mensaje de error distinto).

## Bitácora
- 2026-08-28 · Fase 1 cerrada: 2 rondas + reparto (`PREGUNTAS-D-063.md`).
- 2026-08-28 · Fase 2 cerrada: scaffolding + reservas commiteados (`7b7154d`).
- 2026-08-28 · O1 abierta; 3 chats (L01, L03, L04), los tres `done` entre 18:16 y 18:41.
- 2026-08-28 · GATE-O1 (`1784703`): suite 666/666 + front 319/319 + residuos 0; D1 aplicado en `helpers.js`;
  prompts L02/L05 enmendados; L06/L07 creados.
- 2026-08-28 · Visto bueno de la O1 y OK a D6; O2 abierta con 4 chats (L02, L05, L06, L07).
- 2026-08-28/29 · Los cuatro lotes de la O2 `done` (L05/L06/L07 el 28 entre 20:43 y 21:15; L02 el 29 a las 02:20).
- 2026-08-29 · GATE-O2: suite 681/681 + front 324/324 + residuos 0; compartidos arreglados
  (`helpers.js`, `residuos.js`, endurecimientos del test HTTP); avisos de L05 retirados de los docs;
  a la espera del visto bueno para `/cerrar-implementacion D-063`.
