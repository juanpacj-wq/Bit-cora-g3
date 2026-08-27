# D-061 · Ola O3 · Lote L07 — Docs + cleanup: BIT-MODBD 2.5, BIT-RF 1.9, architecture, glosario, DEPLOY, `git rm` del scraper standalone y de `prompts/D-029`

> **Un lote = un chat.** Este archivo tiene que bastar, junto con las secciones de
> `_CONTEXTO-BASE.md` que cita y los `GATE-O1.md`/`GATE-O2.md`, para ejecutarlo completo.
> Fecha de redacción: 2026-08-26. Escrito por el integrador en la fase 2; enmendado (solo en
> cabecera) por el gate de la O2 si hizo falta.

## ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto

> **ENMIENDA G1 (gate O2, 2026-08-26)** — léela antes que el resto del prompt.
>
> 1. **Las cifras del backfill cambiaron y son las que tienes que documentar.** La fecha de inicio
>    de GEC32 en el SIS es **`2018-06-13`** (no "fines de 2016"): 58 sondeos literales en
>    `cierres/L05.md` §CA-23. El histórico completo son **2.996 días**, no ~1.100. El primer día
>    trae 0,13 MW y **cero carbón**; el primer carbón medido es del **2018-07-15**. La concurrencia
>    verificada contra el SIS es **6** (no 4) y un día completo cuesta **~95 s**.
> 2. **`deploy/DEPLOY.md` (tu punto §4.5): el runbook va con el comando exacto de `GATE-O2.md` §5.**
>    Si al abrir tu chat la corrida de prod todavía está en vuelo (dura ~3,3 días), documentas el
>    runbook y el **estado de arranque** que registra `GATE-O2.md`/`ESTADO.md` (comando, PID, fecha
>    y rango), no conteos finales inventados. Los conteos finales los cierra
>    `/cerrar-implementacion`. Si la corrida de prod **no se autorizó**, el runbook igual se
>    escribe: es el procedimiento, no el registro.
> 3. **Variable de entorno nueva que documentar: `SIS_SWEEPER_ENABLED`** (`server/server.js`,
>    edición del gate O2). `=0` apaga el sweeper del SIS; cualquier otro valor —o su ausencia— lo
>    deja encendido; el apagado se anuncia en el log de arranque. Va en `deploy/DEPLOY.md` (y en
>    `docs/architecture.md` junto al sweeper). **No es para producción**: existe para los backends
>    efímeros de test. Documéntalo diciendo eso.
> 4. **`js-scraper-carbon-g32/scrape.js` no acepta argumentos: siempre raspa HOY, y no tiene
>    README** (hallazgo H-L05-1). Cuando lo retires (CA-31), la verificación independiente del
>    parser deja de poder repetirse. El spot-check de D-061 dio **576/576 celdas idénticas** en tres
>    días históricos, hecho con un arnés externo que hacía `require` de su parser CommonJS: dilo en
>    tu cierre para que el ADR lo recoja.
> 5. **`architecture.md` y el glosario:** el módulo `server/utils/sis/` quedó con seis archivos
>    (`carbon-scraper.js`, `sis-client.js`, `sis-lock.js`, `sis-job.js`, `sis-sweeper.js` +
>    `sis-sweeper-helpers.js`, `discover.js`, `xls-parser.js`). Documenta también el **job manual**
>    (`POST /api/combustibles/sis/scrape`, 202/409, estado volátil en memoria) y el **mutex de
>    proceso** `sis-lock`.
> 6. Todo lo demás del prompt sigue en pie. Los hechos completos están en **`GATE-O2.md` §6**,
>    copiados abajo.

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
node "../metodología de implementación/herramientas/lotes.mjs" --impl D-061 claim L07 --sesion L07-HHMM
export LOTE_SESION=L07-HHMM
```
Si falla, **detente y reporta**.

## 1. Lee, en este orden y solo esto
1. `_CONTEXTO-BASE.md` §1, §5 completo, §6 completo, §7 (versiones y RF reservados), §9.
2. `GATE-O1.md` y `GATE-O2.md` completos (§5 decisiones, §6 hechos, §7 hallazgos) y los seis
   `cierres/L01..L06.md` (sobre todo `### Aporte al ADR`, `Desviaciones`, la fecha de inicio de
   GEC32 y los conteos del backfill en L05, y el registro de la corrida prod en `GATE-O2.md`/`ESTADO.md`).
3. Tu territorio: `BIT-MODBD-2026-001.md` §4.9 y §4.9.1 (`:1046-1140`) y su changelog final;
   `BIT-RF-2026-001.md` §4.9 (COMB) y §10 (historial); `docs/architecture.md` (busca dónde van
   sweepers/utils; hoy **no menciona el SIS**); `docs/domain-glossary.md`; `deploy/DEPLOY.md`.
4. Solo lectura, para documentar lo real (no el plan): `server/routes/combustibles.js`,
   `server/utils/sis/*.js`, `server/scripts/backfill-carbon-gec32.js`, `src/components/Combustibles/override.js`.
5. `CLAUDE.md` del subrepo (solo para NO duplicar: la convención 35 y el ADR los escribe el cierre).

## 2. Territorio — lo único que puedes crear o editar
- `BIT-MODBD-2026-001.md`
- `BIT-RF-2026-001.md`
- `docs/architecture.md`
- `docs/domain-glossary.md`
- `deploy/DEPLOY.md`
- `js-scraper-carbon-g32/**` (solo `git rm -r` + borrar los 3 archivos no versionados: `xlsx-write.js`, `echo-worker.mjs`, `hang-worker.mjs`)
- `prompts/D-029-sis-carbon-gec32/**` (solo `git rm -r`)
- `prompts/D-061-sis-carbon-cierre/cierres/L07.md`

**NO tocas** `docs/decisions.md` ni `CLAUDE.md` (cierre), ningún código, `package.json`,
`ESTADO.md`, `prompts/D-061-*` salvo tu cierre. Si documentar revela un bug o una incoherencia
código↔docs, es un **hallazgo** para el gate, no una corrección tuya.

## 3. Contrato
- **Consumes** todos los contratos de `_CONTEXTO-BASE.md §6` tal como quedaron **verificados en
  los gates** (si un gate los enmendó, documenta la versión enmendada).
- **Produces**: versiones **BIT-MODBD 2.5** y **BIT-RF 1.9** (reservadas en §7), **RF-071**.

## 4. Trabajo
**Qué se sabe:** BIT-MODBD §4.9.1 (D-060) ya describe `valor_sis`, `sis_scrape_log`, ownership y
la semántica `completo`; falta: override (incluido el 0), revertir, scrape manual/job/lock,
concurrencia, backfill histórico (fecha de inicio real, conteos por año en dev y prod), catálogo
`'TST'`, `es_override`/`sis_owned` del GET. BIT-RF va por RF-070 (D-056) y 1.8. `architecture.md`
no menciona el SIS. `deploy/DEPLOY.md` tiene secciones numeradas (§7 = CA corporativa); el runbook
de backfill en prod va como sección nueva. El scraper standalone está parcialmente versionado
(`package.json`, `scrape.js`, `xls.js`) y tiene 3 sueltos.

1. **BIT-MODBD 2.5**: amplía §4.9.1 (tabla de ownership completa con la fila "override 0", tabla
   de decisión de revertir, `sis-lock`, job manual, `concurrencia`, `discover` v2 y la fecha de
   inicio real, catálogo `'TST'` como fixture) + fila **2.5** en el changelog (orden de versión,
   fecha del gate O2). No reescribas el histórico.
2. **BIT-RF 1.9**: en §4.9 (COMB) agrega **RF-071** (ingesta SIS: ownership "operador gana",
   override visible y revertir, vaciar = override 0, scrape manual asíncrono gated por
   `puede_crear`, backfill resumible; GEC3 fuera) + fila **1.9** en §10. Cross-ref a BIT-MODBD
   §4.9.1 y a D-061.
3. **`docs/architecture.md`**: sección "Ingesta SIS de carbón GEC32" (módulos de
   `server/utils/sis/`, sweeper HH:02, job manual, CLI, front `override.js`) en el lugar donde
   viven los sweepers/utils.
4. **`docs/domain-glossary.md`**: entradas `SIS`, `SIS-owned / humano-owned`, `override (COMB)`,
   `valor_sis`, `sis_scrape_log`.
5. **`deploy/DEPLOY.md`**: sección "Backfill del carbón GEC32 en prod" con el comando exacto que
   corrió el integrador (de `GATE-O2.md`), el guardrail `--confirm-db`, `--to ≤ hoy-2`, cómo
   reanudar y cómo verificar (conteos por año, `sis_scrape_log` incompletos).
6. **Cleanup**: `git rm -r js-scraper-carbon-g32 prompts/D-029-sis-carbon-gec32`; borra los 3
   sueltos; `git grep -n "js-scraper-carbon-g32"` debe quedar vacío fuera de `docs/decisions.md`
   (si aparece en código o tests, es un hallazgo: no lo edites).
7. Tuteo colombiano en todo texto nuevo.

## 5. Criterios de aceptación y sus verificadores
| CA | Criterio | Verificador (tuyo) |
|---|---|---|
| CA-29 | BIT-MODBD 2.5 (§4.9.1 ampliada + changelog) y BIT-RF 1.9 (RF-071 + changelog). | `grep -n "^| 2.5\|^| \*\*1.9\|RF-071" BIT-*.md` + lectura del gate |
| CA-30 | `architecture.md`, `domain-glossary.md` con SIS; `DEPLOY.md` con el runbook del backfill prod. | `grep -n -i "sis" docs/architecture.md docs/domain-glossary.md deploy/DEPLOY.md` |
| CA-31 | `git rm` del scraper standalone y de `prompts/D-029-*` + sueltos borrados; sin referencias fuera de `decisions.md`. | `git status --short js-scraper-carbon-g32 prompts/D-029-sis-carbon-gec32` (todo `D`) + `git grep js-scraper-carbon-g32` |

## 6. Verificación que corres (solo la tuya)
```bash
git grep -n "js-scraper-carbon-g32" -- . ':!docs/decisions.md' ':!prompts/D-061-sis-carbon-cierre'
ls js-scraper-carbon-g32 2>/dev/null || echo "carpeta retirada"
```
Sin tests ni backend. **No corras `npm test`**.

## 7. Cierre (obligatorio, en este orden)
1. `prompts/D-061-sis-carbon-cierre/cierres/L07.md` (plantilla `CIERRE-LOTE.md`, con
   `### Aporte al ADR`: qué quedó documentado y dónde).
2. Commit solo tus rutas (el `git rm` ya deja el índice listo para esas rutas):
   ```bash
   git commit -m "$(cat <<'EOF'
   docs(D-061 L07): ingesta SIS de carbón GEC32 en BIT-MODBD 2.5, BIT-RF 1.9, architecture y glosario; retiro del scraper standalone y del scaffolding D-029

   <por qué>
   EOF
   )" -- BIT-MODBD-2026-001.md BIT-RF-2026-001.md docs/architecture.md docs/domain-glossary.md deploy/DEPLOY.md js-scraper-carbon-g32 prompts/D-029-sis-carbon-gec32 prompts/D-061-sis-carbon-cierre/cierres/L07.md
   ```
3. `lotes.mjs --impl D-061 done L07 --sesion <tu sesión>`
4. Mensaje final con la forma fija (`L07 cerrado.` …).

## Reglas (no negociables)
- `git commit -- <rutas>` siempre; nunca `git add -A`/`.`; nada de stash, reset, checkout,
  restore, switch, rebase, amend, push, merge.
- Documenta lo real (código + gates), no el plan; una discrepancia es un hallazgo.
- No inventes cifras: conteos, fechas y SHA salen de los cierres y gates.
- No te asciendas solo.
- Tuteo colombiano estándar; sin voseo.
