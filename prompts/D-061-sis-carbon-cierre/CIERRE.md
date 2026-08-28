# D-061 — CIERRE de la implementación (último gate)

> Expediente **inmutable**, igual que los `GATE-On.md`. Se commitea acá y el commit siguiente borra
> la carpeta entera: el historial lo conserva (`git show <sha>:prompts/D-061-sis-carbon-cierre/CIERRE.md`).
> Fecha: `2026-08-28` (Bogotá). Rama `feat/sis-carbon-cierre-2026-08`.

## 1. Precondiciones

```
D-061 · rama feat/sis-carbon-cierre-2026-08
O1 [cerrada]  L01 done · L02 done · L03 done          gate: GATE-O1.md
O2 [cerrada]  L04 done · L05 done · L06 done · L08 done   gate: GATE-O2.md
O3 [cerrada]  L09 done · L10 done                     gate: GATE-O3.md
O4 [cerrada]  L07 done · L11 done                     gate: GATE-O4.md
O5 [cerrada]  L12 done                                gate: GATE-O5.md
test-lock: libre (tomado por CIERRE-D061 para el smoke)
```
Cinco olas cerradas, **12 lotes `done`**, ninguno `in-progress` ni `blocked`. Vistos buenos: O1
`2026-08-26 19:32` · O2 `2026-08-26 23:11` · O3 `2026-08-27 09:14` · O4 `2026-08-27 12:05` ·
**O5 `2026-08-28 07:30`** (registrado por este cierre en `GATE-O5.md` §8, que era el único
`{{pendiente}}`). Árbol de trabajo limpio al abrir.

## 2. Smoke completo (bajo test-lock `CIERRE-D061`)

Backend efímero `:3199` con el código de la rama, **sin `SKIP_INITDB`** (las migraciones corren),
`AUTH_TEST_BYPASS=1`, `SIS_HOST=http://localhost:3154` y `SIS_SWEEPER_ENABLED=0`; BD `PortalG3_dev`.
`node --test --test-concurrency=1` con el mismo `SIS_HOST`, en los **mismos 7 bloques** que GATE-O5
(los 54 archivos del script `test`, en su orden, sin repetir ni omitir ninguno).

| Bloque | Archivos | `tests` | `fail` | `skipped` | `duration_ms` |
|---|---|---|---|---|---|
| 1 | `guard_no_prod_disp` … `split_sala_permisos` | 52 | 0 | 0 | 216.136,6 |
| 2 | `guard_tipo_evento_coherente` … `fechas_bogota` | 134 | 0 | 0 | 247.151,9 |
| 3 | `turno-entidad` … `conformacion_turno` | 189 | 0 | 0 | 845.343,9 |
| 4 | `consumos_combustible` … `turno_transicion_write_gate` | 82 | 0 | 0 | 725.267,0 |
| 5 | `turno_seguimiento` … `rol_usuario_consulta` | 57 | 0 | 0 | 354.679,5 |
| 6 | `sis_schema` … `sis_concurrencia` | 79 | 0 | 0 | 503.750,7 |
| 7 | `contrato_eventos_dashboard` … `zzz_session_leak_guard` | 48 | 0 | 0 | 138.785,4 |
| **Σ** | **54** | **641** | **0** | **0** | **3.031.115,0 (50,5 min)** |

**Contra el baseline:** resultado literal `tests 641 · suites 31 · pass 641 · fail 0 · cancelled 0 · skipped 0 · todo 0`.
Contra GATE-O5 (`641 · pass 641 · skipped 0`): **±0, bloque por bloque** — los siete bloques dan
exactamente los mismos siete números (52 · 134 · 189 · 82 · 57 · 79 · 48). Contra el baseline de
apertura de D-061 (`577 · pass 576 · skipped 1`, rama base `60c285e`): **+64 tests y el único skip
cerrado**. Ningún rojo, ningún saltado, ningún cancelado.

**Front:** `npx vitest run src` → **`Test Files 15 passed · Tests 304 passed (304)`**, 70,7 s. Igual a GATE-O5 (304); **+206** sobre el baseline de 98 del merge previo a D-061.

**`npm run build`:** `npm run build` ✓ `built in 16,62 s`. **`index-DF3tohrB.css` 122,14 kB** y **`index-bzJdO9St.js` 554,25 kB** — los **mismos dos hashes** que GATE-O5, o sea que el cierre no tocó una línea de código de producción.

**Lint:** `npm run lint` → **0 errores**, 15 warnings, los mismos preexistentes de la O4/O5 (`auth.js`, `f03-libro.js`, los tres sweepers de WS, `BitacorasGecelca3.jsx`, `CambiarEstadoModal.jsx`, `DisponibilidadDashboard.jsx`, `useFlipReorder.js`). Ninguno en `src/components/Combustibles`.

**Residuos en BD:** **ninguno.** `npm run test:residuos` → los **10 checks en `ok`**, "cero residuos". Query directa
complementaria contra `PortalG3_dev`: 0 celdas de `consumo_combustible` y 0 filas de `sis_scrape_log`
en `TST`/`TSR`; 0 de `GEC3`/`GEC32` en la ventana de test `2026-04-15..20` (las dos tablas); 0 sesiones
sintéticas activas; catálogo `TST` = **10** (fixture residente) y catálogo global = **28**, los dos
valores que el ADR documenta.

## 3. Criterios de aceptación — tabla final

Estado **final** de los 59 criterios, resolviendo las cadenas `parcial → LNN` que abrieron los gates.

| CA | Origen | Estado final | Verificador |
|---|---|---|---|
| CA-1 … CA-4 | L01 | `cumple` | `sis_concurrencia.test.js` 1–7, `sis_lock.test.js` 1–10 (GATE-O1) |
| CA-5 … CA-9 | L02 | `cumple` | `sis_endpoints.test.js › CA-5..CA-9` (GATE-O1) |
| CA-10 | L02 | `cumple` | `sis_endpoints.test.js › CA-10` + `consumos_combustible` 16/16 + `rol_usuario_consulta` (GATE-O1) |
| CA-11 | L03 | `cumple` | `override.test.js` bajo TZ hostil (GATE-O1) |
| **CA-12** | L03 | **`parcial` → smoke visual del autor** | `npm run build` ✔ y humo de render en jsdom; el paso por pantalla sigue sin hacerse (§5) |
| CA-13 | L03 | `cumple` | cerrado por L08 CA-33 → L09 CA-37 → L11 CA-48 → **L12 CA-55..CA-58** (GATE-O5) |
| CA-14 | L03 | `cumple` | `override.test.js › restanteGavela`/`formatoMMSS`; el cruce de medianoche lo cerró L08 |
| CA-15 | L03 | `cumple` | `override.test.js › textoChipSis` (GATE-O1) |
| CA-16 … CA-19 | L04 | `cumple` | `sis_scrape_endpoint.test.js › CA-16..CA-19` (GATE-O2) |
| CA-36 | L04 | `cumple` | `sis_endpoints.test.js › CA-36` + `resolverSistemaId` retirado (GATE-O2) |
| CA-20 | L05 | `cumple` | `sis_discover.test.js` 13/13 (GATE-O2) |
| CA-21 | L05 | `cumple` | salidas literales del CLI en `cierres/L05.md` (7 guardrails, `--from auto` exit 3, `--dry-run`, resumible) |
| CA-22 | L05 | `cumple` | `sis_parser.test.js` **sin skip** — la suite pasó de `skipped 1` a `skipped 0` |
| CA-23 | L05 | `cumple` | 58 sondeos, tabla de concurrencia N=1/2/4/6 y spot-check 576/576 en `cierres/L05.md` |
| CA-24 | L05 | `cumple` | corrida de dev verificada viva por el GATE-O2 (89 días, `min 2018-06-13`) |
| CA-25 … CA-28 | L06 | `cumple` | `consumos_combustible` + `rol_coordinador_carbon_maquinaria` + `sis_scraper_ownership` + `sis_concurrencia` + `guard_no_prod_historico_destruction` 4/4 + `test:residuos` 10 checks (GATE-O2) |
| CA-29 | L07 | `cumple` **con la numeración corregida** | BIT-MODBD **2.5**, BIT-RF **2.1** + **RF-076** (no 1.9/RF-071: ya eran de D-057 — H78) |
| CA-30 | L07 | `cumple` | `architecture.md`, 4 entradas de glosario, `DEPLOY.md` §8 (GATE-O4) |
| CA-31 | L07 | `cumple` | `git rm` de 15 rutas; las 2 referencias colgantes las cerró el gate O4 (D14) |
| CA-32 | L08 | `cumple` | `ConsumosGrid.test.jsx › CA-32` (GATE-O2) |
| CA-33 | L08 | `cumple` | cadena cerrada en **L12 CA-55..CA-58** (GATE-O5) |
| CA-34 | L08 | `cumple` | `ConsumosGrid.test.jsx › CA-34` + `override.test.js › esCeroNoOp`/`esVacioCantidad` |
| **CA-35** | L08 | **partido:** reglas de posición `cumple` (L11 CA-51); hover/Escape **`parcial` → `D-062`** (H67) + smoke visual | `override.test.js › ladoPopover` con márgenes ✔ (GATE-O4) |
| CA-37 | L09 | `cumple` | vía L11 CA-48 → **L12** (GATE-O5) |
| CA-38 | L09 | `cumple` | `ConsumosGrid.test.jsx › CA-38` (GATE-O3) |
| CA-39 | L09 | `cumple` en su parte medible → CA-51; el resto con CA-35 | `override.test.js › ladoPopover` (GATE-O4) |
| CA-40 | L09 | `cumple` con la desviación declarada | lectura del diff + build (GATE-O3) |
| CA-41 | L10 | `cumple` | `sis_discover.test.js › CA-41` (GATE-O3) |
| CA-42 | L10 | `cumple` | vía **L11 CA-52** (GATE-O4) |
| CA-43 | L10 | `cumple` | `sis_discover.test.js › CA-43` (GATE-O3) |
| CA-44 | L10 | `cumple` | vía **L11 CA-53** (GATE-O4), con **H71** como deuda declarada |
| CA-45 | L10 | `cumple` | 3 pasadas 10/10 con el sweeper **encendido**, corridas por el GATE-O3 |
| **CA-46** | L10 | **`cumple` como contrato, NO entregado como objetivo** | `GET /sis/estado` devuelve `sweeper.habilitado` ✔, pero **ninguna pantalla lo consume**: BIT-RF 2.1 lo documenta como requerimiento aparte |
| CA-47 | L10 | `cumple` | `sis_endpoints.test.js › CA-47` (GATE-O3) |
| CA-48 / CA-49 | L11 | `cumple` | vía **L12 CA-55..CA-58** (GATE-O5) |
| **CA-50** | L11 | **`parcial` → `D-062`** | H67: cerrar con Escape con el puntero encima devuelve el popover al lado por defecto; el test codifica el defecto (jsdom no tiene hover real) |
| CA-51 … CA-54 | L11 | `cumple` | `override.test.js › ladoPopover`, `sis_discover.test.js › CA-52/CA-54`, `sis_scrape_endpoint.test.js › CA-53` (GATE-O4) |
| CA-55 … CA-58 | L12 | `cumple` | `override.test.js › celdaEquivalente`/`coordenadasEditadas`/`hayEdicion`/`clon` + `ConsumosGrid.test.jsx › CA-56/57/58` bajo `<StrictMode>` (GATE-O5) |
| CA-59 | GATE-O5 | `cumple` | `ConsumosGrid.test.jsx › CA-59` ×2, con **M5** como verificador bidireccional |

**Resumen: 59 criterios — 56 `cumple`, 2 `parcial` con destino explícito (CA-12 → smoke visual del
autor; CA-50 → `D-062`) y 1 con matiz declarado (CA-46: contrato entregado, objetivo de UI no).**
Nada queda `bloqueado` y nada se pierde en silencio.

## 4. Pendientes vivos que salen de D-061, con destino

| # | Pendiente | Destino | Dónde está escrito |
|---|---|---|---|
| 1 | **Backfill histórico de producción**: 368 de 2.996 días (12,3 %), las 368 completas, 0 parciales. Murió dos veces por corte de BD. | **Tarea operativa aparte** — decisión del usuario el 2026-08-28: no se relanza dentro del cierre (escribe sobre `PortalG3` ~3 días). Recuperación = **relanzar el comando completo** (D15). | ADR D-061 §Consecuencias · `deploy/DEPLOY.md` §8 · `GATE-O5.md` §8 |
| 2 | **Smoke visual de CA-12 / CA-35** (aplazado 4 veces por movimiento de la pantalla; ya no se mueve más) | **Checklist del autor** (§5) | acá + `cierres/L03.md`, `L08.md`, `L09.md` §"Para el gate" |
| 3 | **Rediseño de la grilla COMB**: popover a un portal `position: fixed`, fronteras del vaciado, dirty-check al cambiar de fecha, superficie de `override.js` | **`D-062`** (13 hallazgos: H67, H69, H70, H75 de la O4 + H81–H89, H-L12-3 de la O5) | `docs/decisions.md` §Próximas decisiones pendientes · `GATE-O4.md` §5 D16 · `GATE-O5.md` §7 |
| 4 | **H71**: `npm test` a secas contra un efímero **sin** `SIS_HOST` deja rojos los 5 casos del scrape manual | **Deuda declarada** | ADR D-061 §Consecuencias · `CLAUDE.md` conv. 35 |
| 5 | **`GET /sis/estado` sin consumidor de UI** (CA-46) | **Requerimiento aparte** | BIT-RF v2.1 / RF-076 |
| 6 | Verificación **independiente** del parser `.xls` (el spot-check 576/576 ya no se puede repetir) | **Registro histórico**, cerrado por eliminación | ADR D-061 §Consecuencias · `cierres/L07.md` |

## 5. Checklist de smoke UI manual — para el autor

Claude no lo automatiza (no hay Playwright en el repo). Contra `npm run dev` + backend `:3002` de
dev, con un usuario que tenga `puede_crear` en COMB, en **GEC32** y en **una fecha con carbón**:

1. **Badge y popover.** Una celda de `ALIM_*` con override muestra el banderín ámbar; el popover
   trae quién editó, cuándo y el `valor_sis`. Abrirlo cerca del borde derecho y en la última fila:
   no debe quedar recortado por el contenedor con scroll (H75, va a `D-062` — anotar cómo se ve).
2. **Revertir.** El botón devuelve el valor del SIS y el badge desaparece; el mensaje distingue
   `restaurado` de `sin_cambios`. Con `valor_sis = 0`, la celda desaparece (`eliminado`).
3. **Vaciar = override 0.** Borrar el número de una celda con lectura del SIS y guardar: la celda
   queda en `0` **con badge**, no vacía, y sigue ahí tras recargar.
4. **Comentario que sobrevive.** Corregir la cifra de una celda que tiene comentario: el comentario
   no se pierde.
5. **Gavela.** Teclear sin guardar: aparece la cuenta de 10 min y el auto-refresco se detiene;
   Guardar y Descartar la cierran. Con cambios sin guardar, **todos** los botones Revertir se apagan
   (es deliberado).
6. **Chip del SIS.** Muestra `N/24` y la hora del último scrape del día en pantalla.
7. **Cambio de fecha con la grilla llena** *(nuevo, GATE-O5)*: la grilla parpadea vacía ~1 s
   mientras vuelve el GET (H-L12-2/H81) — confirmar que **vuelve** con los números de la fecha nueva
   y que **no** se queda vacía y sin spinner (eso sería la regresión que CA-59 cerró).
8. **Chip desincronizado** *(nuevo)*: durante ese ~1 s el chip del SIS sigue mostrando el conteo de
   la fecha anterior (H81, → `D-062`).
9. **Total Carbón durante la carga** *(nuevo)*: pinta `0.000` en los 24 periodos mientras carga —
   un cero medido, no una ausencia (H84, → `D-062`).
10. **Scrape manual.** El botón responde de inmediato (202) y el estado avanza; disparar dos veces
    seguidas da el aviso de `scrape_en_curso` en vez de encolar.
11. **GEC3.** La misma pantalla en GEC3 no ofrece nada del SIS (no tiene) y la captura manual sigue
    funcionando igual que antes.

## 6. Documentación permanente actualizada por este cierre

| Documento | Qué cambió |
|---|---|
| `docs/decisions.md` | **ADR `D-061` completo** en reemplazo del stub `(EN CURSO)`. Cross-ref de **D-060 corregida**: el scraper SIS ya no apunta a `[[D-029]]` (que documentó el rol Coordinador) sino a `[[D-061]]`. **`D-062` agregado** a §Próximas decisiones pendientes con sus 13 hallazgos. |
| `CLAUDE.md` | **Convención 35** (número reservado en la fase 2): dos escritores en la celda de COMB, override 0, revertir, el mutex sin cola, `SIS_SWEEPER_ENABLED` como flag de test, la pertenencia **calculada** en la grilla con sus tres gotchas, `--from auto` como calibración, la recuperación del backfill y el fixture residente de `'TST'`. **Convención 28 matizada**: se cierra el pendiente de `consumo_combustible` y se anotan los dos matices de D-061 (el helper único no es una allowlist en un endpoint; el guard estático no ve escrituras que entran por el default de una función de producción). **Metodología v2**: una reserva de versión se verifica contra el changelog del propio documento (H78) y los hooks no se saltan (H77). |
| `BIT-MODBD-2026-001.md` | Sin cambios en este commit — **v2.5** ya la dejó L07 (§4.9.1 ampliada + fila de changelog). Verificado consistente con el ADR. |
| `BIT-RF-2026-001.md` | Sin cambios en este commit — **v2.1 + RF-076** ya los dejó L07. Verificado consistente con el ADR. |
| `docs/architecture.md`, `docs/domain-glossary.md`, `deploy/DEPLOY.md` | Sin cambios — L07. Verificados. |
| `docs/requerimientos/REQ-*` | **Sin cambios: no aplica.** Ningún REQ cubre la ingesta SIS; las preguntas abiertas de REQ-01 §8 (layout del formato `.xlsx`, nombre del archivo) son de la **descarga** de combustibles y D-061 no las toca. |
| `../docs/interfaces-cross-repo.md` (umbrella) | **Sin cambios: no aplica.** D-061 no toca `evento_dashboard` ni `disponibilidad_dashboard` ni el endpoint cross-repo. Verificado. |
| `pendientes_Ernesto.md` | Sin cambios: su única línea de COMB es REQ-01 (descarga), que sigue bloqueada por el layout. |

## 7. Cleanup y commits

1. Commit del expediente (este archivo + `ESTADO.md` final + el visto bueno en `GATE-O5.md` §8).
2. Commit de cierre: docs permanentes + `git rm -r prompts/D-061-sis-carbon-cierre`.

## 8. Lo que NO hizo este cierre (requiere confirmación humana)

- `git push` de `feat/sis-carbon-cierre-2026-08`.
- Merge/PR hacia la rama que sirve producción (prod sirve hoy `feat/D-059`).
- Cualquier acción en el servidor `capibara`: checkout, build con `APP_BASE_PATH`, restart del
  servicio. **D-061 no trae migraciones `F-NN`**, así que el reinicio no aplica ninguna; lo que se
  verifica en la máquina que se certifica es la pantalla COMB y `GET /api/combustibles/sis/estado`
  respondiendo. Ver `deploy/DEPLOY.md` y `../docs/deployment-unificado.md`.
- Relanzar el backfill de producción (§4, pendiente 1).
