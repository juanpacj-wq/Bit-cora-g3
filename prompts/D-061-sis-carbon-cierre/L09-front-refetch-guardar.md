# D-061 · Ola O3 · Lote L09 — El refetch preservado no puede convertirse en un borrado al guardar

> **Un lote = un chat.** Este archivo tiene que bastar, junto con las secciones de
> `_CONTEXTO-BASE.md` que cita y los `GATE-O1.md`/`GATE-O2.md`, para ejecutarlo completo.
> Fecha de redacción: 2026-08-26. **Lote de corrección** creado por el gate de la O2 (`GATE-O2.md`
> §7, hallazgos H24, H25, H26, H27): el `/code-review` del diff de la O2 encontró que el arreglo de
> L08 al latido (CA-33) dejó abierto el camino de vuelta — el snapshot se actualiza y el buffer no,
> así que el **Guardar** siguiente manda como cambios celdas que el operador nunca tocó. Lote
> **puro** (vitest + build, sin BD ni backend).

## ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto
- Este prompt nace enmendado: ya incorpora `GATE-O1.md` y `GATE-O2.md`. Léelos igual (§6 y §7 de
  cada uno).
- **El hallazgo H24 es de pérdida de datos sobre planta real.** No es cosmética: hoy, en
  producción, un operador que teclee mientras corre el auto-refresco puede borrar con su Guardar
  una lectura que el SIS acababa de escribir, y la ownership de D-029 impide que el scraper la
  reponga. Es lo primero que arreglas y lo primero que pruebas.

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
node "../metodología de implementación/herramientas/lotes.mjs" --impl D-061 claim L09 --sesion L09-HHMM
export LOTE_SESION=L09-HHMM
```
Si falla (O3 no abierta, L08 sin `done`, lote reclamado), **detente y reporta**.

## 1. Lee, en este orden y solo esto
1. `_CONTEXTO-BASE.md` §1, §3.4, §5.5, §6 (filas C4, C5, C6, C11), §9.
2. `GATE-O2.md` §6 y §7 (los hallazgos **H24, H25, H26, H27** son tu lista de trabajo) y
   `cierres/L08.md` completo (qué arregló, con qué mutaciones lo verificó y qué dejó como sospecha
   — la del popover por índice es tu H26).
3. Tu territorio (abajo). Solo lectura: `src/hooks/useCombustibles.js`, `src/utils/fecha.js`,
   `server/routes/combustibles.js` (para entender qué hace el backend con cada forma del diff).
4. `CLAUDE.md` del subrepo, convenciones 9, 11, 16, 17.

## 2. Territorio — lo único que puedes crear o editar
- `src/components/Combustibles/ConsumosGrid.jsx`
- `src/components/Combustibles/combustibles.css`
- `src/components/Combustibles/override.js`
- `src/components/Combustibles/override.test.js`
- `src/components/Combustibles/ConsumosGrid.test.jsx`
- `prompts/D-061-sis-carbon-cierre/cierres/L09.md`

**NO tocas** `src/hooks/useCombustibles.js` (si necesitas algo del hook, es un **bloqueo**),
`src/BitacorasGecelca3.jsx`, `SelectorFecha.jsx`, `server/**` (**L10** vive en esta ola),
`package.json`, `vitest.config.js`, `ESTADO.md`, `docs/`. Cambio fuera del territorio →
`Bloqueos` + `lotes.mjs block`.

## 3. Contrato
> No produces ni cambias contratos. Consumes C4/C5/C6 y C11 (tu propio módulo: puedes **añadir**
> funciones puras; las 10 existentes conservan nombre y firma).

## 4. Trabajo
**Qué se sabe (verificado por el gate O2 leyendo `f14918b`):** confirma los números de línea con
Grep antes de editar.

1. **H24 (alta) — el refetch preservado deja el buffer viejo contra un snapshot nuevo, y el Guardar
   siguiente manda esa diferencia como si fuera del operador.** `refetch()` (`:97-116`) actualiza
   `setSnapshot(r.celdas)` **siempre** y `setBuffer` solo si no hay edición en curso (`:111`). Eso
   arregló CA-33 (no perder lo tecleado) y abrió el camino inverso: `calcularDiff()` (`:267-287`)
   compara buffer contra snapshot, así que una celda **nueva** que el SIS escribió durante el GET
   aparece como "solo en snapshot" y se manda con `cantidad: null` — el backend la convierte en
   override 0 a nombre del operador (C6) o la borra, y desde ese momento la ownership de D-029
   impide que el scraper la reponga. La cara simétrica: una celda que el SIS **actualizó** durante
   el GET se pisa con el número viejo del buffer.
   - **Escenario reproducible** (el que tiene que quedar como test): GEC32/hoy, el `focus` dispara
     el latido, el operador teclea 22 en P3/ALIM_1 mientras el GET está en vuelo, y la respuesta
     trae una celda nueva P5/ALIM_1 = 7. Hoy el body del Guardar es
     `[{periodo:3,…,cantidad:22}, {periodo:5,…,cantidad:null}]`. **Debe ser solo la primera.**
   - **Arreglo:** el diff tiene que distinguir "lo que el operador tocó" de "lo que cambió debajo".
     La forma barata y verificable es llevar el **conjunto de celdas editadas** (un `Set` de
     `"periodo|combustible_id"`, alimentado por `setCelda`) y que `calcularDiff` solo emita celdas
     de ese conjunto; al aplicar un snapshot nuevo sin pisar el buffer, las celdas que NO están en
     el conjunto se reconcilian desde el snapshot (se queda lo tecleado, entra lo del server).
     Descartar, Guardar y cambiar de coordenada vacían el conjunto. Elige la forma que prefieras,
     pero el criterio no se negocia: **una celda que el operador nunca tocó no puede aparecer en el
     body del POST**, ni siquiera cuando el server la cambió debajo.
   - Si hay conflicto real (el operador tecleó una celda que el SIS cambió en el mismo intervalo),
     gana lo tecleado —es el override— pero el badge tiene que reflejar el `valor_sis` nuevo, que
     ya viene del snapshot.

2. **H25 (media) — limpiar y volver a escribir una celda le borra el comentario.** `setCelda`
   (`:224-247`): vaciar hace `delete fila[k]` (`:238`); volver a teclear reconstruye
   `fila[k] = { ...(fila[k] || {}), cantidad }` (`:242`) sobre un `fila[k]` que ya no existe, así
   que la celda pierde `detalle`. `calcularDiff` manda `detalle: b.detalle ?? null` y el backend
   (`routes/combustibles.js:355-366`, rama de UPDATE con cambio de cantidad) hace `detalle=NULL`.
   Resultado: 18,5 con la nota "Tolva atascada" → el operador corrige a 20 → la nota desaparece con
   un 200 que dice "1 actualizado".
   - **Arreglo:** al reconstruir la celda, sembrarla desde el snapshot
     (`{ ...(fila[k] || snapshotRef.current[p]?.[k] || {}), cantidad }`) para que `detalle` —y
     cualquier otro campo de la celda— sobreviva a un limpiar-y-reescribir.
   - La otra mitad —que el backend no borre `detalle` cuando el body no trae la clave, igual que ya
     hace la rama de vaciado (CA-36)— es de **L10**, no tuya. No toques `server/**`.

3. **H26 (media) — el popover decide hacia dónde abre por índice de fila, no por dónde está en el
   viewport.** `ConsumosGrid.jsx:529`: `p >= 19` enciende `comb-tip--arriba`, y el comentario dice
   "periodos altos (P22–P24)". Con `.comb-scroll` mostrando ~10–12 filas, basta con desplazar la
   tabla para que P19 quede arriba del todo: el popover abre hacia arriba contra el `thead` sticky
   y contra el borde superior — el mismo recorte que L08 vino a arreglar, espejado.
   - **Arreglo:** medir al abrir. Un solo `getBoundingClientRect()` del banderín contra el rect de
     `.comb-scroll` en el manejador que abre el popover (no en cada scroll), y de ahí salen las dos
     clases. L08 eligió el índice porque *jsdom no hace layout*; el test sigue siendo posible si la
     decisión vive en una **función pura** de `override.js` que reciba los dos rects (por ejemplo
     `ladoPopover({ banderin, contenedor, alto, ancho })` devolviendo `{ arriba, izq }`) y el
     componente solo la llame con rects reales. Prueba la función pura con rects sintéticos y deja
     el cableado cubierto por el humo de render.
   - Corrige también el comentario para que diga lo que hace el código.

4. **H27 (baja, calidad) — trabajo repetido en el render.** `nAlim` (`:355`) vuelve a filtrar
   `catalogo` por `tipo === 'ALIMENTADOR'`, cosa que `columnasOrdenadas` (`:344`) ya hizo: derívalo
   de ese arreglo para que haya un solo lugar donde se decide qué es un alimentador. Y `tipClases`
   se arma para las 240 celdas en cada render (tres concatenaciones por celda, en cada tecla)
   aunque solo se use cuando `marcada` es true: constrúyelo dentro de esa rama.

5. Tuteo colombiano en todo texto nuevo, comentarios incluidos. Sin voseo.

## 5. Criterios de aceptación y sus verificadores
| CA | Criterio | Verificador (tuyo) |
|---|---|---|
| CA-37 | Una celda que el operador no tocó **nunca** aparece en el body del POST, aunque el server la haya creado o cambiado durante un refetch preservado; lo tecleado sobrevive y el badge muestra el `valor_sis` nuevo. | `ConsumosGrid.test.jsx › CA-37` — el escenario de §4.1 con sus dos caras (celda nueva del SIS y celda actualizada por el SIS), afirmando sobre el **body real del POST** |
| CA-38 | Limpiar una celda comentada y volver a escribir un número conserva `detalle` en el body. | `ConsumosGrid.test.jsx › CA-38` |
| CA-39 | El lado hacia el que abre el popover se decide midiendo, no por índice; la función que lo decide es pura y está probada en las cuatro combinaciones (arriba/abajo × izquierda/derecha). | `override.test.js › ladoPopover` + humo de render |
| CA-40 | `nAlim` sale de `columnasOrdenadas` y `tipClases` solo se construye para celdas marcadas; vitest y build siguen en verde. | lectura del diff + `npx vitest run src/components/Combustibles` + `npm run build` |

## 6. Verificación que corres (solo la tuya)
```bash
npx vitest run src/components/Combustibles      # 3 pasadas seguidas, sin intermitencias
npx eslint src/components/Combustibles
npm run build
```
**Verificador bidireccional obligatorio para CA-37 y CA-38:** rompe a propósito cada arreglo
(vuelve `calcularDiff` a emitir sin el conjunto de editadas; vuelve `setCelda` a `fila[k] || {}`),
corre, pega el rojo literal, restaura y vuelve a correr. Un test que no sabe fallar no prueba nada.
No abras backend ni toques la BD: este lote es puro y **no** toma el test-lock.

## 7. Cierre (obligatorio, en este orden)
1. `prompts/D-061-sis-carbon-cierre/cierres/L09.md` (plantilla `CIERRE-LOTE.md`, con
   `### Aporte al ADR`).
2. `git commit -- src/components/Combustibles/ prompts/D-061-sis-carbon-cierre/cierres/L09.md`
   con el scope `(D-061 L09)` en el título. Sin firmas de IA.
3. `lotes.mjs --impl D-061 done L09 --sesion <tu sesión>`
4. Mensaje final con la forma fija (`L09 cerrado.` …).

## Reglas (no negociables)
- `git commit -- <rutas>` siempre; nunca `git add -A` ni `git add .`; nada de stash, reset,
  checkout, restore, switch, rebase, amend, push, merge.
- Un cambio fuera del territorio es un **bloqueo**, no una excepción.
- No te asciendas solo: los CA los confirma el gate.
- Tuteo colombiano estándar; sin voseo.
