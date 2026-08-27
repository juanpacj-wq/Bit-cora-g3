# D-061 — GATE-O1 (cierre de la ola O1)

> Lo escribe **solo el integrador** al correr `/cerrar-ola D-061 O1`. Es un expediente
> **inmutable**: si algo de acá se revierte después, se enmienda encima ("REVERTIDA el … por …"),
> no se borra. Fecha: `2026-08-26 17:05` (Bogotá). Rama `feat/sis-carbon-cierre-2026-08`.

## 1. Semáforo al cerrar
```
D-061 · rama feat/sis-carbon-cierre-2026-08

O1 [abierta]
  L01  done        L01-1542     Núcleo SIS: planta_id + concurrencia en scrapeDia, mutex sis-lock, discover.js
  L02  done        L02-1542     Backend COMB: catálogo TST, GET con valor_sis, vaciar = override 0, POST revertir
  L03  done        L03-1542     Front: badge de override + tooltip + Revertir + auto-refresco con gavela + chip SIS

O2 [pendiente]
  L04  pending                  Scrape manual asíncrono: sis-job + POST /sis/scrape (202/409) + GET /sis/estado ← L01,L02
  L05  pending                  Backfill histórico: discover v2, CLI --concurrencia, fixture .xls, calibración y corrida dev ← L01
  L06  pending                  Higiene D-055: tests de COMB/SIS a TEST_PLANTA, guard ampliado, residuos ← L01,L02

O3 [pendiente]
  L07  pending                  Docs + cleanup: BIT-MODBD 2.5, BIT-RF 1.9, architecture, glosario, DEPLOY, git rm scraper y prompts D-029 ← L04,L05,L06

test-lock: libre
```
Lotes sin cierre commiteado: ninguno (L01 `ea8fcb8`, L02 `c69f791`, L03 `882f3f8`). Los tres
chats dejaron `LOTES.json` con sus `claim/done` sin commitear (correcto: lo commitea este gate).
Bloqueos registrados: L02 → `consumos_combustible.test.js:330` (resuelto acá, D1).

## 2. Territorios
```
L01 · 2 commit(s): ea8fcb8 939f1a8
archivos tocados (7): cierres/L01.md, server/tests/sis_concurrencia.test.js, server/tests/sis_lock.test.js,
  server/utils/sis/carbon-scraper.js, server/utils/sis/discover.js, server/utils/sis/sis-lock.js,
  server/utils/sis/sis-sweeper.js
[lotes] territorio respetado

L02 · 2 commit(s): c69f791 ada04b0
archivos tocados (4): cierres/L02.md, server/db.js, server/routes/combustibles.js, server/tests/sis_endpoints.test.js
[lotes] territorio respetado

L03 · 2 commit(s): 882f3f8 528b12d
archivos tocados (6): cierres/L03.md, src/components/Combustibles/ConsumosGrid.jsx, combustibles.css,
  override.js, override.test.js, src/hooks/useCombustibles.js
[lotes] territorio respetado
```
Violaciones: ninguna. Ningún lote tocó `server/package.json`, `helpers.js`, `BitacorasGecelca3.jsx`
ni el territorio de otro.

## 3. Verificación de la ola (bajo test-lock `GATE-O1`)
- Tests enganchados a `server/package.json` (script `test`, orden pedido por los cierres):
  `tests/sis_endpoints.test.js` (después de `consumos_combustible`), `tests/sis_lock.test.js`
  (después de `sis_sweeper`), `tests/sis_concurrencia.test.js` (después de `sis_scraper_ownership`).
  `zzz_session_leak_guard` sigue último. `override.test.js` cae solo en el `include` de vitest.
- Ediciones del gate en compartidos: `server/tests/consumos_combustible.test.js` (D1: 2 asserts
  acotados a `GEC3`/`GEC32`) y `server/db.js` (D2: `SKIP_INITDB=1` resuelve los live bindings;
  H12: `MERGE … WITH (HOLDLOCK)`; H4: `export async function seedCatalogoCombTest(db)`, que
  `initDB` llama en el mismo punto). `node --check` + eslint en verde sobre ambos.
- `npm run build`: ✓ `built in 14.24s` (`index-CdlqQINo.js` 551 kB; el aviso de chunk >500 kB
  es previo a la ola).
- vitest (front): `Test Files 14 passed · Tests 126 passed (126)` — 10,85 s (98 antes de O1 + 28
  de `override.test.js`).
- Suite backend completa (server efímero `:3199` con el código de la rama **sin** `SKIP_INITDB`,
  `AUTH_TEST_BYPASS=1`, BD `PortalG3_dev`): `ℹ tests 608 · suites 31 · pass 607 · fail 0 · cancelled 0 · skipped 1 · duration_ms 1815933` (30,3 min; el skip es el parser sin fixture, lo cierra L05). Corrida desacoplada (`npm test` → log en el scratchpad de la sesión), monitor sobre el log; el proceso terminó a las 16:58.
- Baseline anterior: `577 · pass 576 · fail 0 · skipped 1` (antes de O1, 28,0 min) → **608/607 = +31 tests, exactamente los enganchados** (7 `sis_concurrencia` + 10 `sis_lock` + 14 `sis_endpoints`); sin degradación, cero rojos nuevos. El test 12 de `consumos_combustible` (rojo conocido por el bloqueo de L02) queda verde con D1.
- **Recorrida tras las ediciones H4/H12 en `db.js`** (hechas después de la suite para no cambiar el código bajo prueba): backend reiniciado en `:3199` y `node --test --test-concurrency=1 tests/sis_endpoints.test.js tests/consumos_combustible.test.js` → `ℹ tests 31 · pass 31 · fail 0` (158 s). `SKIP_INITDB=1 … initDB()` → `{ USUARIO_SISTEMA_ID: 94, COMB_BITACORA_ID: 17 }`; `seedCatalogoCombTest(db)` sobre BD sembrada → `0 insertadas` (idempotente).
- Residuos en BD: ninguno. `npm run test:residuos` → 8 checks en `ok`, `[residuos] cero residuos`. Query directa (las dos tablas que ese script no cuenta): `consumo_combustible` y `sis_scrape_log` en `TST`/`TSR` = 0; en las fechas fijas de los tests sobre planta real (`2026-04-15/16/17`) = 0 filas; sesiones sintéticas activas = 0; `catalogo_TST = 10` (fixture residente, no residuo), `catalogo_total = 28`.
- `/code-review` del diff de la ola (`36fb8bb..HEAD`, nivel high): 15 hallazgos entregados (13 candidatos → 9 confirmados/plausibles y 2 refutados; barrida de huecos +6, 1 refutado — el de vitest/TZ). Solo dos tocan archivos compartidos y **se arreglaron acá**: H12 (`MERGE` del seed TST sin `HOLDLOCK`) y H4 (el seed se exporta como `seedCatalogoCombTest(db)` para que el harness lo siembre tras la planta; L06 lo cablea). El resto se reparte en §7: **8 de UI → L08 (lote nuevo)**, 2 → L04 (CA-36), 1 → L06 (H1, alta), 2 → decisión/ADR (D5, H8). Nota de cobertura del revisor: 4 de sus 10 ángulos no reportaron; el ángulo principal lo cubrió con lectura línea a línea del diff completo.
- `/security-review` (corrido porque L02 tocó gating por matriz + SQL en `routes/combustibles.js`
  y `db.js`): **sin hallazgos** con confianza ≥ 0,7. Verificado: los 4 endpoints de COMB tras `requireEntra` + `loadAppSession` + `hasPermisoBitacora` (`puede_ver`/`puede_crear`; falla cerrado con `bitacora_id=null`); CSRF global cubre el POST nuevo; SQL 100 % parametrizado (`.input()` tipado; el único template es la constante `SELECT_CELDA`); `revertir` localiza la celda por `(planta, fecha, periodo, combustible)` sin id opaco y valida `periodo`/pertenencia antes de la transacción; sin `dangerouslySetInnerHTML`; sin PII nueva. Candidatos descartados y anotados para el ADR: `revertir` no llama `plantaMatch` (replica el POST batch, edición colaborativa cross-planta documentada en `permissions.js`); `'TST'` queda operable por API en prod para cualquier `puede_crear` (ruido inocuo en una planta-fixture, igual que MAND).

## 4. Criterios confirmados (solo lo que el gate vio en verde)
| CA | Propuesto por | Estado confirmado | Verificador corrido por el gate |
|---|---|---|---|
| CA-1 | L01 | `cumple` | `tests/sis_concurrencia.test.js` › 1–3 ✔ en suite completa |
| CA-2 | L01 | `cumple` | `tests/sis_concurrencia.test.js` › 4–7 ✔ en suite completa |
| CA-3 | L01 | `cumple` | `tests/sis_lock.test.js` › 1–5 ✔ |
| CA-4 | L01 | `cumple` | `tests/sis_lock.test.js` › 6–10 ✔ (puro, `ejecutarTick` con mocks) |
| CA-5 | L02 | `cumple` | `tests/sis_endpoints.test.js` › CA-5 ×2 ✔ (suite + recorrida tras H12) |
| CA-6 | L02 | `cumple` | `tests/sis_endpoints.test.js` › CA-6 ✔ |
| CA-7 | L02 | `cumple` | `tests/sis_endpoints.test.js` › CA-7 ×2 ✔ |
| CA-8 | L02 | `cumple` | `tests/sis_endpoints.test.js` › CA-8 ×2 ✔ |
| CA-9 | L02 | `cumple` | `tests/sis_endpoints.test.js` › CA-9 ×6 ✔ |
| CA-10 | L02 (`parcial`) | `cumple` | `tests/sis_endpoints.test.js` › CA-10 ✔ + `tests/consumos_combustible.test.js` 16/16 ✔ (test 12 con D1) + `tests/rol_usuario_consulta.test.js` ✔ en suite |
| CA-11 | L03 | `cumple` | `src/components/Combustibles/override.test.js` 28/28 ✔ (vitest, TZ hostil) |
| CA-12 | L03 (`parcial`) | `parcial` → smoke visual del usuario (D4) + L08 en O2 (los 8 hallazgos de UI tocan justo esta pantalla) | `npm run build` ✔; humo de render de L03 (no versionado; L08 lo versiona) |
| CA-13 | L03 | `parcial` → L08 CA-33 | `override.test.js` › `politicaRefresco` ✔; pero H3: un refetch en vuelo pisa teclas y una respuesta tardía puede aterrizar en otra fecha ("pausado con `hayCambios`" no se cumple durante el GET) |
| CA-14 | L03 | `cumple` (con H6 → L08 CA-33: la gavela sigue viva al cruzar medianoche) | `override.test.js` › `restanteGavela`/`formatoMMSS` ✔ + humo de render |
| CA-15 | L03 | `cumple` | `override.test.js` › `textoChipSis` ✔ + build ✔ |

## 5. Decisiones tomadas en este gate
### D1 — Bloqueo de L02: el conteo global del catálogo en `consumos_combustible.test.js:330`
- **Qué lo provoca:** el seed C12 sube `lov_bit.combustible` de 18 a 28 filas; el test 12
  (`F26.B1 idempotente`) fijaba 18 sobre el conteo **global**. Archivo de territorio L06 (O2).
- **Opciones:** a) aplicar en el gate el diff de 2 asserts que propuso L02 (acotar a
  `planta_id IN ('GEC3','GEC32')`, también el `n2` de estabilidad) · b) dejarlo a L06 y aceptar
  un rojo conocido en O1 · c) bajar el seed de TST a un flag opt-in — **Recomendada:** a.
- **Decidido:** a (integrador, 2026-08-26). Un rojo conocido en el baseline esconde los rojos
  nuevos; L06 no ha arrancado, así que no hay conflicto de escritor.
- **Qué cambia / qué NO cambia:** solo los dos asserts; el test sigue verificando idempotencia.
  L06 **no** repite esta edición.
- **Enmiendas que produce:** prompt L06 (cabecera).

### D2 — Hallazgo de L02: `SKIP_INITDB=1` dejaba `COMB_BITACORA_ID=null` → todo COMB en 403
- **Qué lo provoca:** `initDB` retornaba antes de resolver los live bindings; el backend efímero
  de L04 (prompt §6: `SKIP_INITDB=1` en `:3104`) habría recibido 403 en `POST /sis/scrape` sin
  pista del motivo.
- **Opciones:** a) `db.js`: extraer `resolverUsuarioSistemaId` / `resolverCombBitacoraId` y
  llamarlas también en la rama `SKIP_INITDB` (dos SELECT, sin escritura) · b) enmendar el prompt de
  L04 para que arranque sin `SKIP_INITDB` · c) las dos — **Recomendada:** a.
- **Decidido:** a (integrador, 2026-08-26). `SKIP_INITDB` existe para que un lote que no es dueño
  de `db.js` levante un server **funcional** sin DDL; "solo abre el pool" era una definición que
  dejaba el server inservible para COMB y para cualquier sweeper que use `USUARIO_SISTEMA_ID`.
  Verificado: `SKIP_INITDB=1 node … initDB()` → `{ USUARIO_SISTEMA_ID: 94, COMB_BITACORA_ID: 17 }`.
- **Qué cambia / qué NO cambia:** el camino normal de `initDB` es idéntico (mismas queries en el
  mismo punto); solo cambia la rama `SKIP_INITDB`. Si el schema no estuviera aplicado, el `throw`
  de los resolvers lo dice en el arranque, no en un 403 mudo.
- **Enmiendas que produce:** prompt L04 (cabecera); `CLAUDE.md` conv. sobre `SKIP_INITDB` y
  `server/migrations/README.md:26` dicen "solo abre el pool" → se corrigen en el cierre / L07
  (hecho registrado en §6).

### D3 — `fecha_invalida` en GET y POST `/consumos` (desviación aditiva de L02)
- **Qué lo provoca:** C5 solo lo exigía en `revertir`; L02 lo agregó también al GET y al POST.
- **Opciones:** a) dejarlo (aditivo: esos endpoints ya respondían 400, ahora con `codigo`
  estable) · b) quitarlo para ceñirse al contrato — **Recomendada:** a.
- **Decidido:** a. El front ya ramifica por `codigo` (D-032); un 400 sin código era la deuda.
- **Enmiendas:** ninguna (L04 lo hereda al escribir en el mismo router).

### D4 — CA-12 (smoke visual del front) queda `parcial` y NO bloquea O2
- **Qué lo provoca:** L03 no pudo hacer el smoke contra `npm run dev` porque L02 seguía
  `in-progress`; el gate no tiene navegador. Ningún lote de O2 depende del front.
- **Opciones:** a) smoke manual del usuario con el checklist de `cierres/L03.md` §"Para el gate"
  (7 pasos, ~10 min) antes o durante O2, resultado al gate O2 · b) lote de smoke en O2 · c) bloquear
  O2 hasta el smoke — **Recomendada:** a.
- **Decidido:** a (pendiente del usuario; ver §8). Lo que sí verificó el gate: el humo de render
  de L03 (jsdom, 5 casos), `override.test.js` 28/28 bajo TZ hostil y el build.

### D5 — `plantaCombValida` conserva un conjunto explícito de plantas (H7 vs conv. 28)
- **Qué lo provoca:** el code-review señala que el helper reintroduce (y ensancha a `TST`) la
  allowlist que la convención 28 pidió no reintroducir en endpoints.
- **Opciones:** a) mantenerlo tal cual (contrato C4/CA-6 congelado en fase 1: `planta_id ∈
  {GEC3, GEC32, TEST_PLANTA_ID}`, 400 `planta_invalida` para el resto) y explicarlo en el ADR ·
  b) validar contra `lov_bit.planta` (`activa=1`) sin literal · c) exigir `plantaMatch` con la
  sesión — **Recomendada:** a.
- **Decidido:** a (integrador). COMB es un reporte numérico sobre las dos plantas físicas + la
  fixture, con edición colaborativa cross-planta gateada por `puede_crear` (igual que DISP);
  la conv. 28 nació de MAND, donde el literal impedía usar `TST`. Acá el literal vive en **un**
  helper y ya admite la fixture. b/c cambian el contrato y son decisión de producto, no de gate.
- **Qué cambia / qué NO cambia:** nada en código. El ADR D-061 (cierre) documenta la excepción y
  matiza la conv. 28 ("no reintroduzcas una allowlist **en un endpoint**; un helper único que
  admite la fixture es otra cosa").

### D6 — Lote de corrección L08 en O2 para los hallazgos de UI
- **Qué lo provoca:** 8 hallazgos del code-review sobre `ConsumosGrid.jsx`/`combustibles.css`
  (H2, H3, H5, H6, H10, H11, H13, H14), ninguno en archivo compartido.
- **Opciones:** a) lote nuevo L08 en O2 (puro, disjunto, en paralelo con L04/L05/L06) · b)
  arreglarlos en el gate · c) posponerlos a O3 — **Recomendada:** a.
- **Decidido:** a. El gate no edita archivos de un lote (solo compartidos) y O3 es docs.
- **Enmiendas que produce:** `L08-correcciones-front.md` (nuevo), `PLAN-OLAS.md`, `LOTES.json`
  (L08 pendiente, depende de L03; L07 depende también de L08).

## 6. Hechos que cambian lo que dicen los documentos anteriores
> Este bloque se copia **tal cual** al inicio de cada prompt de la ola O2.
- **`SKIP_INITDB=1` ya resuelve los live bindings** (`USUARIO_SISTEMA_ID`, `COMB_BITACORA_ID`)
  antes de retornar (GATE-O1 D2). Un backend efímero con ese flag sirve COMB y los sweepers con
  normalidad; ya no hace falta arrancar sin él. Lo que dicen `CLAUDE.md` y
  `server/migrations/README.md` ("solo abre el pool") queda impreciso hasta el cierre.
- **El diff de `consumos_combustible.test.js:330` ya está aplicado por el gate** (D1): el test 12
  cuenta `lov_bit.combustible` acotado a `GEC3`/`GEC32` (18) y `n2` igual. **L06 no lo repite**;
  al migrar ese archivo a `TEST_PLANTA` conserva esos dos asserts tal cual.
- `discoverEarliestDate` **ya no se define** en `carbon-scraper.js`: vive en
  `server/utils/sis/discover.js` (cuerpo idéntico al v1) y `carbon-scraper.js` la re-exporta. L05
  trabaja sobre `discover.js`; los imports viejos siguen funcionando.
- `scrapeDia(pool, { planta_id='GEC32', concurrencia=1, … })` y `leerScrapeLog(pool, fecha,
  planta_id='GEC32')` están tal cual C1. El error de planta sin catálogo es
  `scrapeDia: planta sin catálogo ALIM_1..8: <p>` y se lanza **antes** del primer fetch.
- **`'TST'` es una planta con SIS válida para `scrapeDia`** (tiene `ALIM_1..8` por el seed C12).
  `GEC3` (usa `ALIM_A..F`) es el "sin catálogo" estable: **L06**, al migrar
  `sis_scraper_ownership` a `TEST_PLANTA`, deja el caso negativo apuntando a `GEC3`.
- El sweeper expone `ejecutarTick({ pool, scrapeFn, leerLogFn, lockFn, hoy, log })` y su tick corre
  **entero** bajo `withSisLock('sweeper <hoy>', …)`: mientras el job manual (L04) tenga el lock, el
  tick se omite completo (ni ayer ni hoy) y vuelve a la hora siguiente. `withSisLock` lanza `Error`
  con `.codigo='sis_ocupado'`, `.motivo` (del dueño) y `.desde`; `estadoSisLock()` sirve directo
  para el cuerpo del 409 de L04.
- **Con `concurrencia>1`, un periodo intermedio fallido deja el día no reanudable por
  `ultimo_periodo`** (`periodos_error=1`, `ultimo_periodo=24`, y `periodoDesdeDe` devuelve 1): la
  próxima pasada re-pide el día completo. Correcto; **L05** lo cuenta en su presupuesto.
- **La fase de escritura cuesta ~12 s por día contra la BD dev** (192 statements en una
  transacción) y la concurrencia no la baja: un backfill de ~1.100 días tiene un piso de ≥ 3,7 h
  solo de escritura, aunque la red baje de ~5,2 a ~1,3 min/día con `concurrencia=4`. **L05**
  planifica con ese piso. Sospecha no medida: RSS del proceso con `concurrencia=6` y `.xls`
  grandes — mirarlo en la primera corrida real.
- **Una tolva ≤ 0,5 t/h se lee como 0 y un 0 sin fila previa no crea celda**
  (`extraerCarbonValidado`, filtro de ruido a propósito). **L05**: el fixture
  `sis-period.xls` debe traer tolvas > 0,5 o `discover` v2 lo leerá como día vacío.
- `routes/combustibles.js` ya tiene `plantaCombValida()` (admite `GEC3`, `GEC32`,
  `TEST_PLANTA_ID`), `mapCelda`, `SELECT_CELDA` y `resolverSistemaId`: **L04 los reúsa**, no los
  duplica. Los 400 de todo el router traen `codigo`; `fecha_invalida` aplica también a GET/POST
  `/consumos` (D3).
- El GET devuelve por celda `valor_sis`, `sis_actualizado_en`, `sis_owned`, `es_override` y el
  bloque `sis` tal cual C4; `revertir` devuelve `{ accion, celda }` con `celda` en el mismo shape
  del pivot (hay assert que lo fija). Vaciar una celda con `valor_sis` la deja viva en 0; si solo
  cambió `detalle` se actualiza sin tocar `modificado_por` y cuenta en `actualizados`.
- **`node --test a.js b.js` corre los archivos en paralelo** (un proceso por archivo): dos
  archivos HTTP con los mismos usuarios sintéticos se dan 401 mutuo (sesión única, D-035). Toda
  corrida conjunta lleva `--test-concurrency=1` (el script `test` ya lo trae). Los prompts de O2
  que listan dos archivos HTTP en una línea lo añaden.
- `npm run test:residuos` **no** cuenta `consumo_combustible` ni `sis_scrape_log`: el gate O1 los
  contó con query directa; L06 (CA-28) los agrega al script.
- `planta_invalida` ya existía como `codigo` en `routes/auth.js` (`cambiar-unidad`): el ADR no
  lo presenta como estreno (nota para el cierre).
- El seed del catálogo `'TST'` está guardado por la existencia de la fila `'TST'` en
  `lov_bit.planta` (la siembra el harness, no `initDB`): en una BD virgen el catálogo aparece en
  el **segundo** arranque. Dev y prod ya tienen la fila. L07 lo documenta en BIT-MODBD §4.9.
- Los tests de formato de fecha del repo corren en equipos en `America/Bogota`, así que **no
  distinguen** `timeZone` explícito de implícito (hallazgo H-1 de L03). `override.test.js` corre
  bajo `process.env.TZ='Asia/Tokyo'` y afirma que el default resuelto no es Bogotá; el resto del
  repo probablemente comparte la ceguera (deuda fuera de D-061; convención para el cierre).

## 7. Hallazgos consolidados (deduplicados entre lotes)
| # | Origen | Hallazgo | Severidad | Destino |
|---|---|---|---|---|
| H1 | code-review | `sis_concurrencia.test.js` (y `sis_scraper_ownership`) borran/reescriben `consumo_combustible` + `sis_scrape_log` de **GEC32** en `2026-04-16/17`; hoy vacías, pero el backfill de L05 las va a poblar en O2 y la suite las destruiría. | alta | **L06**: territorio ampliado con `sis_concurrencia.test.js`, CA-26 ampliado; L05 no corre esos tests con el backfill vivo (enmiendas) |
| H2 | code-review | `onRevertir` → `refetch()` → `setBuffer(deepClone)` descarta en silencio las ediciones de las otras celdas; Revertir solo se deshabilita si la propia celda está sucia. | media | **L08** CA-32 |
| H3 | code-review | Latido de auto-refresco sin guarda de secuencia ni re-chequeo tras el `await`: pisa teclas en vuelo y puede aplicar la respuesta de otra fecha. | media | **L08** CA-33 |
| H4 | L02 (sospecha) + code-review | El seed del catálogo `'TST'` depende de la fila en `lov_bit.planta`, que siembra el harness **después** de `initDB`: en BD virgen el catálogo llega al segundo arranque y `sis_endpoints` fallaría con `TypeError` sin pista. | media | **gate**: `seedCatalogoCombTest(db)` exportado de `db.js`; **L06** lo llama en `setupSessions` tras la planta (CA-28) |
| H5 | code-review | Override 0: `setCelda` borra la clave del buffer con 0/'' mientras el snapshot conserva `cantidad: 0` → `hayCambios` por un no-op (Guardar, gavela, `beforeunload`). | baja | **L08** CA-34 |
| H6 | L03 (H-3) + code-review | `politica` memoriza `hoy`: una pestaña que cruza medianoche mantiene auto-refresco y gavela (que **descarta**) sobre un día ya pasado. | baja | **L08** CA-33 |
| H7 | code-review (convención) | `plantaCombValida` reintroduce/ensancha la allowlist `['GEC3','GEC32',TST]` que la conv. 28 pide no reintroducir. | nota | **D5**: se mantiene (contrato C4/CA-6 congelado en fase 1); el ADR D-061 lo explica y matiza la conv. 28 (cierre) |
| H8 | code-review | `revertir` pasa `creado_por` a SISTEMA conservando `creado_en` y `detalle` humanos; un scrape posterior con 0 borra la fila con el comentario. | baja | nota para el ADR (comportamiento de C5, ownership solo por autor); sin cambio |
| H9 | code-review | Vaciar con `valor_sis` escribe `detalle = c.detalle ?? null`; el diff del front no manda la clave → anula un comentario existente. | baja | **L04** CA-36 (conserva `detalle` si la clave no viene) |
| H10 | code-review | `.comb-override-wrap` con `z-index:1` crea contexto de apilamiento: el banderín vecino pinta encima del popover y le roba el hover. | media | **L08** CA-35 |
| H11 | code-review | El banderín (`<button>` 14×14 sobre la esquina del input) intercepta clics y añade hasta 192 tab stops. | baja | **L08** CA-35 |
| H12 | code-review | `MERGE` del seed TST sin `HOLDLOCK`: dos `initDB()` concurrentes en el primer seed chocan en la UQ. | baja | **arreglado en el gate** (`db.js`, `WITH (HOLDLOCK)`) |
| H13 | L03 (sospecha) + code-review | El popover siempre abre abajo/derecha y `.comb-scroll` lo recorta en P22–P24 y en la última columna. | media | **L08** CA-35 |
| H14 | code-review | `onRevertir` muestra "Revertido al valor SIS" también con `accion: 'sin_cambios'`. | baja | **L08** CA-32 |
| H15 | code-review | `resolverSistemaId`/`sistemaIdCache` del router quedan muertos tras D2 (comentario ya falso; semántica distinta a la del scraper). | baja | **L04** CA-36 (retirar; usar `dbBindings.USUARIO_SISTEMA_ID`) |
| H16 | L02 | `SKIP_INITDB=1` dejaba `COMB_BITACORA_ID=null` → todo COMB en 403 para los backends efímeros de O2. | alta | **arreglado en el gate** (D2) |
| H17 | L02 | `node --test a.js b.js` corre en paralelo → 401 mutuo entre archivos HTTP con la misma fixture. | media | enmiendas L04/L06 (`--test-concurrency=1` en sus líneas de §6) + §6 |
| H18 | L02 | `npm run test:residuos` no cuenta `consumo_combustible` ni `sis_scrape_log`. | media | **L06** CA-28 (ya previsto); el gate O1 los contó a mano |
| H19 | L02 | `planta_invalida` ya existía como `codigo` en `routes/auth.js`. | nota | ADR (cierre): no presentarlo como estreno |
| H20 | L01 | Una tolva ≤ 0,5 t/h se lee como 0 y un 0 sin fila previa no crea celda: un fixture con tolvas bajas "no tiene datos". | media (para fixtures) | **L05** (enmienda: fixture con tolvas > 0,5) |
| H21 | L01 | Escribir un día cuesta ~12 s en dev (192 statements en tx) y la concurrencia no lo baja: piso ≥ 3,7 h para ~1.100 días. | media (planificación) | **L05** (enmienda: presupuesto) + integrador (corrida prod tras GATE-O2) |
| H22 | L03 (H-1) | Los tests de formato de fecha del repo corren en equipos en Bogotá y no distinguen `timeZone` explícito de implícito; `override.test.js` ya corre bajo TZ hostil, el resto no. | media (metodológica) | deuda fuera de D-061; convención para `CLAUDE.md` (cierre, conv. 9) |
| H23 | security-review | `'TST'` operable por API en prod para cualquier `puede_crear`; `revertir` sin `plantaMatch` (igual que el POST batch). | nota | ADR (cierre): documentar como decisión consciente, igual que MAND |

## 8. Ola siguiente
- Prompts enmendados: L04 (G1 `SKIP_INITDB` válido + retirar `resolverSistemaId`; G2 CA-36;
  territorio + `sis_endpoints.test.js`; `--test-concurrency=1` en §6), L05 (G1 fixture/presupuesto;
  G2 no correr los tests de GEC32 con el backfill vivo), L06 (G1 D1 aplicado + caso negativo en
  GEC3; G2 territorio + `sis_concurrencia.test.js`, CA-26; G3 `seedCatalogoCombTest` en helpers,
  CA-28; `--test-concurrency=1` en §6). Los tres llevan §6 copiado tal cual.
- **L08 nuevo** (`L08-correcciones-front.md`, D6): puro, depende de L03, puerto 3108, CA-32..CA-35.
- Reparto revisado: `PLAN-OLAS.md` actualizado (O2 = L04, L05, L06, L08; sección L08; enmiendas
  del gate al final); `LOTES.json` (L08; territorios de L04/L06; L07 depende también de L08).
| Lote | Título | Territorio | Depende de |
|---|---|---|---|
| L04 | Scrape manual asíncrono: `sis-job.js` + `POST /sis/scrape` (202/409) + `GET /sis/estado` | `server/utils/sis/sis-job.js`, `server/routes/combustibles.js`, `server/tests/sis_scrape_endpoint.test.js`, `server/tests/sis_endpoints.test.js` | L01, L02 |
| L05 | Backfill histórico: `discover` v2, CLI `--concurrencia`, fixture `.xls`, calibración, corrida dev | `server/utils/sis/discover.js`, `server/scripts/backfill-carbon-gec32.js`, `server/tests/sis_discover.test.js`, `server/tests/fixtures/sis-period.xls`, `server/tests/sis_parser.test.js` | L01 |
| L06 | Higiene D-055: tests de COMB/SIS a `TEST_PLANTA`, guard ampliado, residuos | `server/tests/{consumos_combustible,rol_coordinador_carbon_maquinaria,sis_scraper_ownership,sis_concurrencia,guard_no_prod_historico_destruction}.test.js`, `helpers.js`, `residuos.js` | L01, L02 |
| L08 | Correcciones del front COMB tras el code-review | `src/components/Combustibles/{ConsumosGrid.jsx,combustibles.css,override.js,override.test.js,ConsumosGrid.test.jsx}` | L03 |

- Pendiente del usuario además del visto bueno: smoke visual de CA-12 (D4) con el checklist de
  `cierres/L03.md` §"Para el gate", contra `npm run dev` + backend `:3002` de dev.
- **Visto bueno del usuario:** dado el 2026-08-26 19:32 (Bogotá) — O2 abierta con L04, L05, L06, L08.

## 9. Commit del gate
`gate(D-061): O1 cerrada — 3 lotes, 607/608 en verde, 0 violaciones, L08 nuevo` (el SHA se anota en `ESTADO.md` § Bitácora: el expediente viaja dentro del mismo commit).
