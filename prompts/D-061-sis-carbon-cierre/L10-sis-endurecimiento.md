# D-061 · Ola O3 · Lote L10 — Endurecer el descubrimiento del SIS y hacer honesta la cobertura del scrape manual

> **Un lote = un chat.** Este archivo tiene que bastar, junto con las secciones de
> `_CONTEXTO-BASE.md` que cita y los `GATE-O1.md`/`GATE-O2.md`, para ejecutarlo completo.
> Fecha de redacción: 2026-08-26. **Lote de corrección** creado por el gate de la O2 (`GATE-O2.md`
> §7, hallazgos H28–H33): el `/code-review` del diff de la O2 encontró que `discover` v2 puede
> devolver una fecha de inicio equivocada sin decirlo, que los 9 casos del scrape manual **se
> saltean en silencio** en cualquier `npm test` normal, y que un sweeper apagado se ve igual que
> uno roto.

## ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto
- Este prompt nace enmendado: ya incorpora `GATE-O1.md` y `GATE-O2.md`. Léelos igual (§6 y §7 de
  cada uno).
- **La fecha `2018-06-13` que descubrió L05 NO está en duda.** Esa corrida tuvo **0 errores de red
  en 58 sondeos** y llegó al barrido diario con una ventana de confirmación completa (evidencia
  literal en `cierres/L05.md` §CA-23), así que ninguno de los defectos de abajo la afectó. Lo que
  arreglas es que la **próxima** corrida no pueda mentir en silencio.
- El backfill de dev (y, si el usuario lo autorizó, el de prod) puede seguir vivo mientras trabajas.
  **No lo toques y no corras el CLI contra ninguna BD.** Tus tests son puros.

### Hechos que cambian (copia literal de `GATE-O2.md` §6)

- **La fecha de inicio de GEC32 en el SIS es `2018-06-13`**, no "fines de 2016": 58 sondeos
  literales, 14 min de red, 0 errores (`cierres/L05.md` §CA-23). Ese primer día trae 0,13 MW, fuera
  de servicio y las 8 tolvas en 0; **el primer carbón medido es del 2018-07-15**. El histórico
  completo son **2.996 días**, casi el triple de los ~1.100 que estimaba la planeación.
- **La concurrencia tolerada por el SIS es 6** (el tope de C1), no 4: 24 periodos en 78,6 s con
  cero errores y RSS plano en 132 MB — 4,2× sobre secuencial. Un día completo (red + transacción +
  throttle) cuesta **~95 s**, no ~5,2 min. **Queda descartada** la sospecha del GATE-O1 sobre el RSS
  con `concurrencia=6`.
- **El histórico real de GEC32 tiene huecos de más de 60 días** (agosto–octubre de 2018,
  confirmado por sondeo) que la ventana por defecto de `discover` v2 (K=6, W=60) **no distingue**
  del pre-inicio. Por eso `--from auto` es una **calibración de una sola vez** cuyo resultado se fija
  a mano en el comando; dev y prod corren con `--from 2018-06-13`. El CLI no expone
  `--ventana-dias`/`--sondeos-ventana`; el módulo sí los acepta.
- `server/utils/sis/discover.js` exporta ahora también `addDays`, `diffDays` y `offsetsVentana`
  (aditivo). `discoverEarliestDate` conserva nombre y firma **hasta L10**, que enmienda C3 para que
  devuelva `{ fecha, motivo, sondeos }` — su único llamador es el CLI de backfill.
- El CLI de backfill acepta `--concurrencia 1..6`, `--from auto`, `--confirm-from` y `--log`,
  imprime **conteo por año** al final de toda corrida (incluido `--dry-run`) y **aborta con exit 2
  si `--confirm-from` no coincide con un `--from` explícito** (chequeo aditivo de L05, no estaba
  en C10). Su mensaje de `--from auto` ya está en tuteo ("repite", no "repetí").
- `POST /api/combustibles/sis/scrape` y `GET /api/combustibles/sis/estado` existen tal cual C7/C8,
  con dos aditivos: los 400/409 llevan también `error` y `mensaje` (paridad D-032 con el resto del
  router) e `iniciarScrapeJob` acepta un `log` opcional. **`plantaConSis()` es un helper nuevo**, no
  `plantaCombValida`: `GEC3` es planta válida para registrar consumos a mano pero da
  `planta_sin_sis` en el scrape.
- **El estado del job es volátil** (memoria de proceso): un reinicio lo borra aunque el scrape haya
  terminado bien. La verdad persistente de qué se scrapeó sigue siendo `bitacora.sis_scrape_log`.
  La rama `estado='error'` de C9 es hoy **inalcanzable** desde el endpoint (la guarda del lock es
  síncrona dentro de la misma llamada) y queda como código defensivo sin test.
- `resolverSistemaId` y `sistemaIdCache` **ya no existen** en `routes/combustibles.js`: los dos usos
  pasaron a `dbBindings.USUARIO_SISTEMA_ID` tras la decisión D2 del gate O1.
- **`POST /api/combustibles/consumos` ahora sí responde `codigo: 'fecha_futura'`** (D8). El §6 del
  GATE-O1 afirmaba que todos los 400 del router traían `codigo` y era falso justo ahí.
  `registros.js` sigue con el slug solo en `error`: queda fuera de alcance de D-061.
- **`server.js` acepta `SIS_SWEEPER_ENABLED=0`** (D7): apaga el sweeper del SIS. **Solo ese valor
  exacto apaga**; la ausencia de la variable lo deja encendido y el apagado se anuncia en el log de
  arranque. Es un flag **para backends efímeros de test, no para producción**, y así hay que
  documentarlo. **L10** lo expone en `GET /sis/estado` para que "apagado" no se vea como "roto".
- **Los tests de COMB/SIS ya no escriben en GEC3/GEC32.** Los cuatro archivos migrados operan sobre
  `TEST_PLANTA` (`'TST'`); lo que queda de plantas reales son **lecturas** de catálogo, a propósito.
  `cleanupTestRegistros()` borra ahora también `consumo_combustible` y `sis_scrape_log` de
  `TST`/`TSR` (**sin cota de fecha**: un suite que escriba celdas en la fixture y lo llame a mitad de
  camino se queda sin ellas), `npm run test:residuos` los cuenta (10 checks) y
  `guard_no_prod_historico_destruction` protege las dos tablas, con un meta-test que fija que
  **acotar por fecha fija NO acota**.
- `helpers.js` gana `ensurePlantaCombTest()` (aditivo, no estaba en C13), para las suites que no
  abren sesión de app y por eso no pasan por `setupSessions`.
- El catálogo de `'TST'` (10 filas de `lov_bit.combustible`) es un **fixture residente, no residuo**,
  y el propio `residuos.js` lo dice por escrito para que nadie agregue un check ingenuo que lo
  cuente.
- `src/components/Combustibles/override.js` exporta **10 funciones**, no 7: L08 agregó
  `claveRefetch`, `esVacioCantidad` y `esCeroNoOp` (C11 solo creció).
- **El fixture `server/tests/fixtures/sis-period.xls` está versionado** (19.481 bytes, capturado del
  SIS el 2026-08-15) y su ausencia es ahora un **rojo**, no un `skip` silencioso. La suite pasó a
  `skipped 0`.
- **`js-scraper-carbon-g32/scrape.js` no acepta argumentos: siempre raspa HOY, y no tiene README.**
  El spot-check de D-061 (**576/576 celdas idénticas** en tres días históricos) se hizo con un arnés
  externo que hacía `require` de su parser CommonJS. Cuando **L07** lo retire, esa verificación
  independiente no se puede repetir: el ADR tiene que dejar constancia del resultado.
- **El orden de los archivos en el script `test` no es el orden en que `node --test` los corre.** El
  log de esta suite lo muestra sin lugar a duda. "Enganchar X después de Y" es una convención de
  lectura del `package.json`, no una garantía de ejecución; ningún test puede depender de correr
  antes o después de otro (`zzz_session_leak_guard` es una red de seguridad, no una secuencia).
- **La suite tarda ~58 min si hay un backfill escribiendo en la misma BD** (30 min sin esa
  competencia). Los gates de O3 y O4 deben presupuestar con el número alto mientras la corrida esté
  viva.

## 0. Puerta de arranque (obligatorio, primero)
```bash
node "../metodología de implementación/herramientas/lotes.mjs" --impl D-061 claim L10 --sesion L10-HHMM
export LOTE_SESION=L10-HHMM
```
Si falla (O3 no abierta, L04/L05 sin `done`, lote reclamado), **detente y reporta**.

## 1. Lee, en este orden y solo esto
1. `_CONTEXTO-BASE.md` §1, §3.2, §5.2, §6 (filas C1, C2, C3, C7, C8, C9, C10), §9.
2. `GATE-O2.md` §6 y §7 (los hallazgos **H28, H29, H30, H31, H32, H33** son tu lista de trabajo),
   `cierres/L05.md` (§CA-23 completo: los 58 sondeos y el hueco de 2018) y `cierres/L04.md`
   (§"Para el gate": por qué el archivo de tests necesita el stub).
3. Tu territorio (abajo). Solo lectura: `server/utils/sis/sis-client.js`, `carbon-scraper.js`,
   `sis-lock.js`, `sis-sweeper.js`, `server/server.js`.
4. `CLAUDE.md` del subrepo, convenciones 9, 28, 34.

## 2. Territorio — lo único que puedes crear o editar
- `server/utils/sis/discover.js`
- `server/scripts/backfill-carbon-gec32.js`
- `server/routes/combustibles.js`
- `server/tests/sis_discover.test.js`
- `server/tests/sis_scrape_endpoint.test.js`
- `server/tests/sis_endpoints.test.js`
- `prompts/D-061-sis-carbon-cierre/cierres/L10.md`

**NO tocas** `server/utils/sis/{carbon-scraper,sis-client,sis-lock,sis-job,sis-sweeper}.js`,
`server/db.js`, `server/server.js`, `server/package.json` (es del gate), `server/tests/helpers.js`,
`src/**` (**L09** vive en esta ola), `BIT-*`, `docs/` (**L07**). Cambio fuera del territorio →
`Bloqueos` + `lotes.mjs block`.

## 3. Contrato
- **C3** (`discoverEarliestDate`) **cambia de tipo de retorno**: hoy devuelve
  `'YYYY-MM-DD' | null` y necesita poder decir *por qué* paró. Esta es la única enmienda de
  contrato que el gate autoriza en O3: pasa a `{ fecha: 'YYYY-MM-DD'|null, motivo: 'hallada' |
  'tope-alcanzado' | 'sin-datos' | 'error-de-sondeo', sondeos: number }`. **El único llamador es el
  CLI de tu propio territorio**, así que la migración es tuya y completa; deja el cambio anotado en
  tu cierre para que L07 documente la versión nueva.
- **C8** (`GET /api/combustibles/sis/estado`) **crece**: la respuesta gana
  `sweeper: { habilitado: boolean }`. Aditivo: `job` y `lock` no cambian de forma.
- **C7, C9, C10** intactos salvo lo que dice §4.
- **C1, C2** no se tocan.

## 4. Trabajo
Confirma los números de línea con Grep antes de editar.

1. **H28 (alta) — un sondeo que falló se memoriza como "vacío" para el resto de la corrida.**
   `discover.js:85` (`sondearDia`) guarda en `vistos` el resultado de un `fetchFn` que lanzó como si
   fuera un día sin datos. En una corrida real (~50–100 fetch de ~13 s contra el SIS), un bache de
   red que tumbe los 6 sondeos de una ventana la certifica como "pre-inicio", y la fase de
   confirmación **relee la misma caché** en vez de volver a preguntar. Resultado: una fecha de
   inicio meses o años posterior a la real, sin ningún aviso, y el backfill arranca ahí.
   - **Arreglo:** distinguir tres estados por sondeo (`datos` / `vacío` / `error`). Solo `datos` y
     `vacío` se memorizan. Un `error` no se cachea y **no cuenta como vacío** para la regla de
     ventana: si una ventana no puede decidirse porque hubo errores, se reintenta; si tras el
     reintento sigue habiendo errores, el descubrimiento termina con `motivo: 'error-de-sondeo'` y
     el CLI lo dice y sale distinto de 0. El log por sondeo ya distingue `datos|vacío|error`
     (test 11): ahora la lógica también.

2. **H29 (media) — la ventana del ancla se degenera a un solo sondeo.** `discover.js:99`: `ventana()`
   corta con `break` cuando `d > techo`, así que para el candidato igual al techo los offsets
   10..50 se descartan y queda K=1 — exactamente la debilidad de la v1 que la v2 vino a eliminar.
   Un solo día de parada en el techo (o un solo fetch fallido) da `hayDatos:false`, y sin `hint`
   sobre una BD virgen `discoverEarliestDate` devuelve `null` y el CLI muere con exit 2.
   - **Arreglo:** la ventana del ancla se extiende **hacia atrás** desde el techo, no hacia
     adelante. La regla sigue siendo la misma (K sondeos en W días); lo único que cambia es la
     dirección cuando el candidato toca el techo. El test 8 de `sis_discover.test.js` codifica hoy
     el comportamiento viejo como esperado: reescríbelo.

3. **H30 (media) — "alcancé el tope" se devuelve igual que "encontré el inicio".** `discover.js:142`
   retrocede desde `conDatos = v.primera`, que puede ser el candidato + 50 días, así que cada vuelta
   de `maxYearsBack` avanza tan poco como 315 días y el alcance efectivo de `maxYearsBack = 10` son
   ~8,6 años. Cuando se alcanza el tope, la función devuelve una fecha truncada que el CLI imprime
   como `[backfill] fecha de inicio = …`, indistinguible de una respuesta real; solo una línea
   perdida del log dice `alcanzado maxYearsBack`. La etiqueta `(-${y}a)` de `:143` además ya no
   corresponde a años.
   - **Arreglo:** el `motivo` del contrato nuevo (§3) lo resuelve. Con `tope-alcanzado`, el CLI
     **no** imprime "fecha de inicio" a secas: dice que llegó al tope, muestra el día más antiguo
     con datos que conoce, y **exige** `--confirm-from` igual que hoy pero con un mensaje que
     admita que puede haber historia más atrás. Corrige también la etiqueta del log.

4. **H31 (alta, cobertura) — los 9 casos del scrape manual se saltean en silencio en cualquier
   `npm test` normal.** `sis_scrape_endpoint.test.js:32`: todo el archivo (incluidos los casos de
   unidad de CA-18/CA-19, que no tocan BD ni red) está gateado por
   `process.env.SIS_HOST === 'http://localhost:3154'`. Un `npm test` con el `.env` real deja los 9
   en `skipped` y la suite queda verde y vacía: una regresión en la tabla de validaciones del POST,
   en el 409 o en el manejo de errores por día no la ve nadie. El gate de la O2 los corrió pasando
   `SIS_HOST` a mano, pero eso no es una red que se sostenga sola.
   - **Arreglo, en dos partes:**
     a) **Los casos que no necesitan el stub dejan de estar gateados.** Los de unidad
        (`iniciarScrapeJob` con `scrapeFn` inyectado, la exclusión mutua, `listarDias`) corren
        siempre.
     b) **El skip de los casos HTTP deja de ser silencioso.** Agrega un test **que siempre corre** y
        que falla si `SIS_HOST` no apunta al stub **salvo** que exista un opt-out explícito
        (`SIS_STUB_OPCIONAL=1`). Así, la corrida normal es roja y dice qué falta, y quien de verdad
        quiera saltárselo lo declara. El mensaje tiene que traer el comando exacto que sí los corre.
   - Deja en tu cierre la línea literal que el gate debe usar para levantar el efímero.

5. **H32 (media) — dos flakes en ese mismo archivo.**
   - `:94` — `lanzarScrape` decide "este 409 es del sweeper" con `r.data?.job == null`, pero
     `estadoScrapeJob()` ya no vuelve a ser `null` después del primer job manual: una colisión real
     con el sweeper se clasifica como propia y el `assert.equal(primero.status, 202)` falla. El
     discriminador correcto es `lock.motivo` (empieza por `sweeper`), no la ausencia de `job`.
   - `:304` — `assert.deepEqual(await estadoSis(), antes, …)` compara dos fotos vivas que incluyen
     `lock.ocupado`/`lock.desde`, que el sweeper del propio backend voltea en su tick: un rojo
     ajeno al 403 que se está probando, con un mensaje que apunta al lugar equivocado. Compara
     **solo `job`**. Y el título dice "las cinco validaciones" para seis casos: corrígelo.

6. **H33 (media) — un sweeper apagado se ve igual que uno roto.** `SIS_SWEEPER_ENABLED=0`
   (`server.js:26`, del gate O2) solo se anuncia en una línea del log de arranque. Si esa variable
   llegara al `.env` de producción, el chip diría `SIS · sin lectura` día tras día y
   `GET /api/combustibles/sis/estado` respondería exactamente lo mismo que un sweeper sano en
   reposo.
   - **Arreglo:** `GET /sis/estado` devuelve además `sweeper: { habilitado: boolean }` (C8 crece,
     §3). Léelo de `process.env.SIS_SWEEPER_ENABLED !== '0'` en el router — misma expresión que
     `server.js`, sin importar nada de ahí. Actualiza el caso de CA-17 que fija las claves del
     cuerpo.

7. **Simetría de `detalle` en el POST de consumos (cierre de H-L04-3).** Hoy conviven dos reglas en
   el mismo endpoint: un body sin la clave `detalle` **conserva** el comentario en la rama de
   vaciado (CA-36, `combustibles.js:~300`) y lo **borra** en la rama de UPDATE con cambio de
   cantidad (`:355-366`, `c.detalle ?? null`). Aplica ahí el mismo `hasOwnProperty` que ya usa la
   rama de vaciado: clave ausente ⇒ se conserva; clave presente (aunque venga `null`) ⇒ manda el
   body. La causa concreta del borrado la arregla **L09** en el front; esto es la otra mitad, para
   que la API deje de contradecirse. El caso va en `server/tests/sis_endpoints.test.js`, que está en
   tu territorio, al lado del CA-36 que abrió esta asimetría.

8. Tuteo colombiano en todo texto nuevo, mensajes de CLI incluidos. Sin voseo.

## 5. Criterios de aceptación y sus verificadores
| CA | Criterio | Verificador (tuyo) |
|---|---|---|
| CA-41 | Un sondeo que falla no se memoriza ni cuenta como vacío; una ventana con errores se reintenta y, si persiste, el descubrimiento termina con `motivo: 'error-de-sondeo'` y el CLI sale distinto de 0. | `tests/sis_discover.test.js › CA-41` (con `fetchFn` que lanza en offsets escogidos) |
| CA-42 | La ventana del ancla se extiende hacia atrás: con el techo en un día de parada, `discoverEarliestDate` sigue encontrando el inicio. | `tests/sis_discover.test.js › CA-42` (reemplaza el test 8 viejo) |
| CA-43 | `discoverEarliestDate` devuelve `{ fecha, motivo, sondeos }` y el CLI distingue "inicio hallado" de "tope alcanzado" en la salida y en el código de salida. | `tests/sis_discover.test.js › CA-43` + salida literal del CLI con `--from auto` sobre un `fetchFn` simulado |
| CA-44 | Los casos de unidad del scrape manual corren siempre; los HTTP, si el stub no está, dejan la suite **roja** con el comando exacto (salvo `SIS_STUB_OPCIONAL=1`). | `node --test tests/sis_scrape_endpoint.test.js` sin `SIS_HOST` → rojo explicativo; con el stub → todo verde |
| CA-45 | Los dos flakes cerrados: el 409 del sweeper se discrimina por `lock.motivo` y la comparación de "no arrancó nada" mira solo `job`. | `tests/sis_scrape_endpoint.test.js` verde en 3 pasadas con el sweeper del efímero **encendido** |
| CA-46 | `GET /sis/estado` expone `sweeper.habilitado` y CA-17 lo fija. | `tests/sis_scrape_endpoint.test.js › CA-17` |
| CA-47 | Un body sin la clave `detalle` conserva el comentario también cuando cambia la cantidad (simetría con CA-36). | `tests/sis_endpoints.test.js › CA-47` (verde/rojo) |

## 6. Verificación que corres (solo la tuya)
```bash
node --check utils/sis/discover.js scripts/backfill-carbon-gec32.js routes/combustibles.js
npx eslint utils/sis/discover.js scripts/backfill-carbon-gec32.js routes/combustibles.js tests/sis_discover.test.js tests/sis_scrape_endpoint.test.js
node --test tests/sis_discover.test.js                       # puro
# HTTP: efímero propio en :3110 con AUTH_TEST_BYPASS=1 SKIP_INITDB=1 SIS_HOST=http://localhost:3154
#       y el sweeper ENCENDIDO (es lo que CA-45 tiene que aguantar), bajo test-lock.
node --test --test-concurrency=1 tests/sis_scrape_endpoint.test.js tests/sis_endpoints.test.js
```
Toma el test-lock (`lotes.mjs test-lock --sesion L10-HHMM`) solo para la parte HTTP y suéltalo al
terminar. **No corras el CLI contra ninguna BD** y **no toques el proceso del backfill**.
**Verificador bidireccional obligatorio** para CA-41, CA-42 y CA-44: rompe cada arreglo, pega el
rojo literal, restaura y vuelve a correr.

## 7. Cierre (obligatorio, en este orden)
1. `prompts/D-061-sis-carbon-cierre/cierres/L10.md` (plantilla `CIERRE-LOTE.md`, con
   `### Aporte al ADR` y la enmienda de C3/C8 bien explicada, que L07 la tiene que documentar).
2. `git commit -- server/utils/sis/discover.js server/scripts/backfill-carbon-gec32.js server/routes/combustibles.js server/tests/sis_discover.test.js server/tests/sis_scrape_endpoint.test.js server/tests/sis_endpoints.test.js prompts/D-061-sis-carbon-cierre/cierres/L10.md`
   con el scope `(D-061 L10)` en el título. Sin firmas de IA.
3. `lotes.mjs --impl D-061 done L10 --sesion <tu sesión>`
4. Mensaje final con la forma fija (`L10 cerrado.` …).

## Reglas (no negociables)
- `git commit -- <rutas>` siempre; nunca `git add -A` ni `git add .`; nada de stash, reset,
  checkout, restore, switch, rebase, amend, push, merge.
- Un cambio fuera del territorio es un **bloqueo**, no una excepción.
- No te asciendas solo: los CA los confirma el gate.
- Tuteo colombiano estándar; sin voseo.
