# D-061 — GATE-O2 (cierre de la ola O2)

> Lo escribe **solo el integrador** al correr `/cerrar-ola D-061 O2`. Es un expediente
> **inmutable**: si algo de acá se revierte después, se enmienda encima ("REVERTIDA el … por …"),
> no se borra. Fecha: `2026-08-26 22:05` (Bogotá). Rama `feat/sis-carbon-cierre-2026-08`.

## 1. Semáforo al cerrar
```
D-061 · rama feat/sis-carbon-cierre-2026-08

O1 [cerrada] gate: GATE-O1.md
  L01  done        L01-1542     Núcleo SIS: planta_id + concurrencia en scrapeDia, mutex sis-lock, discover.js
  L02  done        L02-1542     Backend COMB: catálogo TST, GET con valor_sis, vaciar = override 0, POST revertir
  L03  done        L03-1542     Front: badge de override + tooltip + Revertir + auto-refresco con gavela + chip SIS

O2 [abierta]
  L04  done        L04-1938     Scrape manual asíncrono: sis-job + POST /sis/scrape (202/409) + GET /sis/estado ← L01,L02
  L05  done        L05-1938     Backfill histórico: discover v2, CLI --concurrencia, fixture .xls, calibración y corrida dev ← L01
  L06  done        L06-1938     Higiene D-055: tests de COMB/SIS a TEST_PLANTA, guard ampliado, residuos ← L01,L02
  L08  done        L08-1939     Correcciones del front COMB tras el code-review de la O1 (revertir, refetch seguro, override 0, popover) ← L03

O3 [pendiente]
  L07  pending                  Docs + cleanup: BIT-MODBD 2.5, BIT-RF 1.9, architecture, glosario, DEPLOY, git rm scraper y prompts D-029 ← L04,L05,L06,L08

test-lock: libre
```
Lotes sin cierre commiteado: **ninguno** (L04 `7bbf427`, L05 `3c173fb`, L06 `0c9b572`, L08 `9da067f`).
Los cuatro chats dejaron `LOTES.json` con sus `claim`/`done` sin commitear (correcto: lo commitea
este gate). **Bloqueos registrados: ninguno** — los cuatro cierres dicen "Ninguno" y ningún lote
necesitó tocar un archivo fuera de su territorio.

## 2. Territorios
```
L04 · 2 commit(s): 7bbf427 8ed2d46
archivos tocados (5): cierres/L04.md, server/routes/combustibles.js, server/tests/sis_endpoints.test.js,
  server/tests/sis_scrape_endpoint.test.js, server/utils/sis/sis-job.js
[lotes] territorio respetado

L05 · 2 commit(s): 3c173fb b3799b8
archivos tocados (6): cierres/L05.md, server/scripts/backfill-carbon-gec32.js,
  server/tests/fixtures/sis-period.xls, server/tests/sis_discover.test.js,
  server/tests/sis_parser.test.js, server/utils/sis/discover.js
[lotes] territorio respetado

L06 · 2 commit(s): 0c9b572 1955c48
archivos tocados (8): cierres/L06.md, server/tests/consumos_combustible.test.js,
  server/tests/guard_no_prod_historico_destruction.test.js, server/tests/helpers.js,
  server/tests/residuos.js, server/tests/rol_coordinador_carbon_maquinaria.test.js,
  server/tests/sis_concurrencia.test.js, server/tests/sis_scraper_ownership.test.js
[lotes] territorio respetado

L08 · 2 commit(s): 9da067f f14918b
archivos tocados (6): cierres/L08.md, src/components/Combustibles/ConsumosGrid.jsx,
  src/components/Combustibles/ConsumosGrid.test.jsx, src/components/Combustibles/combustibles.css,
  src/components/Combustibles/override.js, src/components/Combustibles/override.test.js
[lotes] territorio respetado
```
Violaciones: **ninguna**. Ningún lote tocó `server/package.json`, `server/db.js`, `server/server.js`
ni el territorio de otro. `server/tests/_tmp_guard.test.js` (el ofensor deliberado con el que L06
verificó CA-27 en las dos direcciones) se creó, se corrió y se borró antes de commitear:
`git log --diff-filter=A -- server/tests/_tmp_guard.test.js` sale vacío y el archivo no está en el
árbol.

## 3. Verificación de la ola (bajo test-lock `GATE-O2`)

**Tests enganchados a `server/package.json`** (script `test`, en el orden que pidieron los cierres):
`tests/sis_scrape_endpoint.test.js` (después de `sis_endpoints`) y `tests/sis_discover.test.js`
(después de `sis_parser_hardening`). `zzz_session_leak_guard` sigue último; el script quedó con 54
archivos. L06 y L08 no pidieron enganchar nada: los cinco archivos de L06 ya estaban en la lista y
`ConsumosGrid.test.jsx` cae solo en el `include` de vitest.

**Ediciones del gate en compartidos** (las tres antes de arrancar la suite, para no probar código
viejo; `node --check` + `npx eslint` en verde sobre las tres):
- `server/server.js` — flag `SIS_SWEEPER_ENABLED` (decisión **D7**).
- `server/routes/combustibles.js:226` — `codigo: 'fecha_futura'` en el POST de consumos (**D8**).
- `server/scripts/backfill-carbon-gec32.js:144` — "repetí" → "repite" (voseo, **D8**).

**Suite backend completa** — server efímero `:3199` con el código de la rama, `AUTH_TEST_BYPASS=1`,
**sin** `SKIP_INITDB`, `SIS_HOST=http://localhost:3154` y `SIS_SWEEPER_ENABLED=0`; el proceso de
`node --test` con el mismo `SIS_HOST`; BD `PortalG3_dev`; corrida desacoplada con el log en el
scratchpad de la sesión:
```
ℹ tests 632 · suites 31 · pass 632 · fail 0 · cancelled 0 · skipped 0 · todo 0 · duration_ms 3480272.0093
```
**58,0 min** (la corrida coincidió con el backfill de dev escribiendo en la misma BD; el gate O1,
sin esa competencia, tardó 30,3 min).

**Contra el baseline** (`608 · pass 607 · fail 0 · skipped 1`, GATE-O1): **+24 tests, todos verdes,
y el único `skip` de la suite cerrado.** Los 24 cuadran exactamente con lo prometido: 9 de
`sis_scrape_endpoint`, 13 de `sis_discover`, 1 de `sis_parser` (el fixture nuevo) y 1 de CA-36 en
`sis_endpoints`. **Cero rojos nuevos y cero rojos conocidos.** L06 no cambió el conteo: migró
cuatro archivos a `TEST_PLANTA` sin agregar casos, salvo el cuarto meta-test del guard, que ya
existía como suite.

**Los 9 casos del scrape manual corrieron de verdad, no se saltearon** (`skipped 0` lo prueba, y
están nombrados en el log):
```
✔ CA-18. el job corre el rango día a día como manual, secuencial y bajo el mutex (38515.7786ms)
✔ CA-18. un día que revienta se anota y el job sigue con los demás (11.8315ms)
✔ CA-18. soloHoy se activa únicamente para el día en curso (Bogotá) (16.4416ms)
✔ CA-19. arrancar con un job en curso o con el mutex tomado lanza scrape_en_curso (46.888ms)
✔ CA-16. POST scrape: el Ingeniero Químico lee pero no dispara (403) y no arranca nada (1251.3314ms)
✔ CA-16. POST scrape: las cinco validaciones de C7 responden 400 con su codigo (3516.562ms)
✔ CA-16. POST scrape de un día: 202, el job termina y queda la fila manual en sis_scrape_log (2526.3722ms)
✔ CA-19. un segundo POST mientras el job corre responde 409 con el job y el mutex (8261.1424ms)
✔ CA-17. GET estado va por puede_ver: el Ingeniero Químico lo lee (200) con job y lock (445.9152ms)
✔ CA-36. vaciar sin la clave detalle conserva el comentario; con la clave manda el body (11750.4635ms)
```

**Front:**
- `npm run build`: ✓ `built in 13.52s` (`index-A5u6Asje.js` 551,93 kB; el aviso de chunk >500 kB es
  previo a D-061).
- vitest: `Test Files 15 passed · Tests 160 passed (160)` — 22,17 s. Baseline O1: 126. **+34**
  (`override.test.js` 28→40 y `ConsumosGrid.test.jsx` nuevo con 22). El cierre de L08 anunció 148:
  la suma estaba mal, el número real es 160.

**Residuos en BD: ninguno.**
```
npm run test:residuos → 10 checks en ok · [residuos] cero residuos
```
Query directa, además del script:
```
fechas fijas de los suites en planta REAL (2026-04-15..20): celdas GEC3/GEC32 = 0 · logs = 0
sesiones sintéticas activas = 0
catálogo TST = 10 (fixture RESIDENTE, no residuo)
sis_scrape_log GEC32 HOY = { horario, periodos_ok:21, periodos_error:0, ultimo_periodo:21, completo:0 }
```
Esa última fila es la prueba de que **D7 funcionó**: L04 midió que un efímero con `SIS_HOST` al stub
deja la fila de hoy de GEC32 en `0/N` con `N` errores, y tras 58 minutos de suite la fila sigue sana
y escrita por el sweeper del backend real de dev. Las fechas fijas en planta real en cero son la
prueba de que la migración de L06 (CA-25/CA-26) hace lo que promete.

**`/code-review` del diff de la ola** (`125e0c9..HEAD`, nivel high): **15 hallazgos**. Dos los
verifiqué yo leyendo el código antes de enrutarlos, porque son de pérdida de datos (H24 y H25) y
confirman. Reparto: **4 → L09** (lote nuevo, front), **8 → L10** (lote nuevo, SIS + cobertura),
**1 arreglado acá** (el voseo del CLI), **2 → nota/ADR**. Ninguno tocaba un archivo compartido sin
dueño salvo el del CLI, así que el gate no arregló código de lote. Detalle en §7.

**`/security-review`** (corrido porque L04 agregó dos endpoints con gating por matriz y SQL, y L05
un CLI que escribe masivamente): **sin hallazgos con confianza ≥ 8**. Verificado y descartado con
traza completa: los dos endpoints nuevos nacen cerrados (`requireEntra` + `loadAppSession` +
`hasPermisoBitacora`, y con `COMB_BITACORA_ID = null` fallan **cerrados**); cero interpolación de
datos de usuario en SQL en todo el código nuevo; el tope de rango no se puede evadir con fechas con
desbordamiento (`diasDeRango` y `listarDias` usan la misma aritmética, más el cinturón
`MAX_DIAS_GUARDA=366`); `textoError` nunca deja salir un `err.message` de `mssql` (esos traen
`.code`, no `.codigo`); no hay SSRF (el host sale de `SIS_HOST`, validado contra el allowlist
interno al cargar el módulo — AUD-26 — y `discover` no es alcanzable por HTTP); `--confirm-db`
compara contra la misma variable que usa el pool; y `SIS_SWEEPER_ENABLED` **falla abierto**, que es
la dirección correcta. Tres notas sub-umbral quedan en §7 (H37, H41-nota) para el ADR.

## 4. Criterios confirmados (solo lo que el gate vio en verde)
| CA | Propuesto por | Estado confirmado | Verificador corrido por el gate |
|---|---|---|---|
| CA-16 | L04 | `cumple` | `tests/sis_scrape_endpoint.test.js › CA-16` ×3 ✔ en suite completa (403 del IngQuim, las seis validaciones con `codigo`, 202 del día suelto) |
| CA-17 | L04 | `cumple` | `tests/sis_scrape_endpoint.test.js › CA-17` ✔ |
| CA-18 | L04 | `cumple` | `tests/sis_scrape_endpoint.test.js › CA-18` ×3 ✔ (mutex tomado y liberado, día que revienta y el job sigue, `soloHoy`) |
| CA-19 | L04 | `cumple` | `tests/sis_scrape_endpoint.test.js › CA-19` ×2 ✔ (409 HTTP con `job`+`lock`, y la unidad) |
| CA-36 | L04 | `cumple` | `tests/sis_endpoints.test.js › CA-36` ✔ + `grep -c resolverSistemaId routes/combustibles.js` = 0 |
| CA-20 | L05 | `cumple` | `tests/sis_discover.test.js` 13/13 ✔ en suite completa |
| CA-21 | L05 | `cumple` | salidas literales del CLI en `cierres/L05.md` (7 guardrails + `--from auto` exit 3 + `--dry-run` + resumible); el gate no las repitió (cuestan red real) pero sí verificó `node --check` y eslint tras su edición del §voseo |
| CA-22 | L05 | `cumple` | `tests/sis_parser.test.js` ✔ **sin skip** — la suite pasó de `skipped 1` a `skipped 0` y ese era el único skip que había |
| CA-23 | L05 | `cumple` | evidencia literal de los 58 sondeos, la tabla de concurrencia N=1/2/4/6 y el spot-check 576/576 en `cierres/L05.md`; el gate la acepta como evidencia de una corrida contra el SIS real, irrepetible en el gate (14 min de red) |
| CA-24 | L05 | `cumple` | corrida viva verificada por el gate: PID 15424 vivo y `sis_scrape_log` GEC32 con **89 días**, `min 2018-06-13`, avanzando cronológicamente |
| CA-25 | L06 | `cumple` | `tests/consumos_combustible.test.js` + `rol_coordinador_carbon_maquinaria.test.js` ✔ en suite + query directa: 0 celdas y 0 logs de GEC3/GEC32 en `2026-04-15..20` |
| CA-26 | L06 | `cumple` | `tests/sis_scraper_ownership.test.js` + `sis_concurrencia.test.js` ✔ en suite + la misma query directa |
| CA-27 | L06 | `cumple` | `tests/guard_no_prod_historico_destruction.test.js` 4/4 ✔, incluido el meta-test nuevo que fija que **una fecha fija NO acota** |
| CA-28 | L06 | `cumple` | `npm run test:residuos` → 10 checks, los dos nuevos incluidos, `cero residuos` |
| CA-32 | L08 | `cumple` | `ConsumosGrid.test.jsx › CA-32` (5 casos) ✔ en vitest 160/160 |
| CA-33 | L08 | `parcial` → **L09 CA-37** | `ConsumosGrid.test.jsx › CA-33` (4 casos) ✔, pero el hallazgo H24 muestra que "no perder lo tecleado" se logró dejando el buffer viejo contra un snapshot nuevo: el **Guardar** siguiente manda celdas que el operador no tocó. El CA se cumple como está escrito y el comportamiento completo no |
| CA-34 | L08 | `cumple` | `ConsumosGrid.test.jsx › CA-34` (3 casos) + `override.test.js › esCeroNoOp`/`esVacioCantidad` ✔ |
| CA-35 | L08 (`parcial`) | `parcial` → **L09 CA-39** + smoke visual del usuario | `ConsumosGrid.test.jsx › CA-35` ✔ y las reglas verificadas en el bundle; pero H26: la decisión de hacia dónde abre el popover es por índice de fila, no por posición en el viewport, así que con la tabla desplazada el recorte vuelve |
| CA-12 | L03 (arrastrado de O1) | sigue `parcial` | pendiente del smoke visual del usuario (GATE-O1 D4). L09 va a mover esta pantalla otra vez: **el smoke conviene hacerlo después de L09**, no antes |
| CA-13 | L03 (arrastrado de O1) | `cumple` con matiz | lo que faltaba lo cerró L08 CA-33 (verificado arriba); el resto del comportamiento queda en L09 CA-37 |

## 5. Decisiones tomadas en este gate

### D7 — Cómo corre el gate los tests del scrape manual sin envenenar el `sis_scrape_log` de GEC32
- **Qué lo provoca:** `sis_scrape_endpoint.test.js` hace `skip` de sus 9 casos si el proceso de
  tests **y** el backend no llevan `SIS_HOST=http://localhost:3154` (necesita que el job pegue
  contra un stub, no contra el SIS real). Pero con esa variable, el sweeper que `server.js:32`
  arranca incondicionalmente también apunta al stub: L04 midió que el tick deja la fila de HOY de
  GEC32 en `periodos_ok=0` con tantos errores como horas van del día (H38). Y con varios backends
  de lote vivos, son varios sweepers pidiéndole a GEC32 el mismo día (H-L06-3).
- **Opciones:** a) exportar `SIS_HOST` y aceptar el daño (se auto-sana en el siguiente tick real,
  y solo toca el log, no las celdas) · b) no exportarlo y aceptar 9 `skipped` en el expediente del
  gate · c) agregar `SIS_SWEEPER_ENABLED=0` a `server.js` —archivo compartido sin dueño en O2— para
  que un backend efímero no arranque el sweeper, y correr con el stub —
  **Recomendada:** c.
- **Decidido:** c (integrador, 2026-08-26). (b) es un verde mentiroso: 9 casos saltados se ven igual
  que 9 casos que pasan si nadie lee el conteo. (a) ensucia a propósito una tabla de GEC32 durante
  58 minutos y repite el problema en cada gate futuro. (c) es la mitigación que **los dos lotes**
  pidieron por escrito (`cierres/L04.md` H-L04-1 y `cierres/L06.md` H-L06-3) y la única que además
  arregla el tráfico duplicado contra el SIS durante toda una ola.
- **Qué cambia / qué NO cambia:** una constante y un `if` en `server.js`. **Solo el string exacto
  `'0'` apaga**: la ausencia de la variable, `'false'`, `'no'` o un `0` numérico dejan el sweeper
  encendido, para que ningún despliegue pierda la ingesta por omisión. El apagado se anuncia en el
  log de arranque (`[SIS] sweeper DESHABILITADO (SIS_SWEEPER_ENABLED=0)`), porque un sweeper mudo es
  indistinguible de uno roto. Verificado en el arranque del efímero, y verificado por el resultado:
  la fila de hoy de GEC32 quedó `horario · 21/0` tras la suite.
- **Enmiendas que produce:** prompt L07 (cabecera: documentarlo en `DEPLOY.md` y `architecture.md`
  **como flag de test, no de producción**) y §6. El code-review levantó de inmediato la contracara
  (H33: apagado ≠ roto desde fuera) → **L10 CA-46** lo expone en `GET /sis/estado`.

### D8 — Las dos correcciones menores del gate en archivos compartidos
- **Qué lo provoca:** dos hallazgos chicos que no son de ningún lote vivo. (i) H39: el §6 del
  GATE-O1 afirmaba como hecho que "los 400 de todo el router traen `codigo`" y era falso justo en
  `POST /consumos` con fecha futura (`combustibles.js:226`), donde el front ramifica por `codigo`
  (D-032) y ese caso caía al mensaje genérico. (ii) H35: el CLI de backfill imprime "repetí" — voseo,
  prohibido por la memoria global del usuario, en la única línea de cara al operador de todo el
  flujo `--from auto`.
- **Opciones:** a) arreglar las dos acá · b) enmendar el hecho del GATE-O1 y mandar el voseo a un
  lote · c) mandar las dos a L10 — **Recomendada:** a.
- **Decidido:** a (integrador). Son una clave y una palabra, ambas aditivas, en archivos que en O3
  cambian de dueño. Dejar el hecho falso en el expediente es peor que corregir la línea; y una regla
  de estilo del usuario no espera una ola. `error: 'fecha_futura'` se conserva tal cual, por paridad
  con `registros.js`, que usa el slug en `error` (queda fuera de alcance de D-061).
- **Qué cambia / qué NO cambia:** ningún test cambia de resultado (`consumos_combustible.test.js`
  test 4 afirma sobre `data.error`, que no se tocó) y la suite de 632 corrió **con** las dos
  ediciones dentro.
- **Enmiendas:** §6.

### D9 — El code-review de la O2 abre dos lotes de corrección y empuja L07 a una ola O4
- **Qué lo provoca:** de los 15 hallazgos, dos son de **pérdida de datos** y uno es un **agujero de
  cobertura**, y ninguno cae en un archivo compartido sin dueño: H24 y H25 viven en
  `ConsumosGrid.jsx` (territorio de L08), y H28–H33 en `discover.js` / `sis_scrape_endpoint.test.js`
  / `combustibles.js` (territorio de L05 y L04). La regla de §9 de la metodología dice: si no es un
  compartido, lote de corrección en la ola siguiente.
- **Opciones:** a) O3 = L07 + L09 + L10 (todo junto) · b) O3 = L09 + L10 y **O4 = L07** ·
  c) O3 = L09 + L07, y H28–H33 a deuda fuera de D-061 — **Recomendada:** b.
- **Decidido:** b (integrador; el usuario lo aprueba con el visto bueno). (a) rompe el orden que
  hace útil a L07: su prompt dice "documenta lo real, no el plan", y L10 cambia `discover.js`,
  el contrato C3 y la forma de `GET /sis/estado` **en la misma ola** — L07 documentaría un blanco
  móvil. (c) deja en el repo, con ADR y todo, una función de descubrimiento que puede devolver una
  fecha equivocada sin decirlo (H28/H30): eso no es deuda, es una trampa.
- **Qué cambia / qué NO cambia:** el reparto y el camino crítico (`L02 → L04 → {L09,L10} → L07 →
  cierre`). No cambia ningún contrato ya verificado: la única enmienda de contrato autorizada es
  **C3** (valor de retorno de `discoverEarliestDate`, cuyo único llamador es el CLI del propio L10)
  y el crecimiento aditivo de **C8**. Las correcciones de L09 no tocan contratos.
- **Enmiendas que produce:** `L09-front-refetch-guardar.md` y `L10-sis-endurecimiento.md` (nuevos),
  `PLAN-OLAS.md`, `LOTES.json` (L09 y L10 en O3; L07 pasa a O4 y depende también de ellos), y la
  cabecera de `L07-docs-cleanup.md`.

### D10 — La corrida del backfill contra producción (pendiente del visto bueno del usuario)
- **Qué lo provoca:** `PLAN-OLAS.md` la deja como tarea del integrador tras GATE-O2, y la pregunta
  #11 de la fase 1 exige visto bueno explícito. Escribe sobre `PortalG3`.
- **Foto de prod tomada por el gate (solo lectura, 2026-08-26):** `sis_scrape_log` GEC32 = **74
  días** (`2026-06-02 … 2026-08-26`), **74 completos, 0 incompletos**; 10.777 celdas ALIM en 59
  días. Los 12 días sin fila (06-10..06-27) siguen ahí. Nada de lo que ya está se reescribe: el CLI
  salta los días 24/24.
- **Opciones:** a) lanzarla ahora, desacoplada, con `--from 2018-06-13 --confirm-from 2018-06-13
  --to <hoy-2> --concurrencia 6 --confirm-db PortalG3`, y registrar el arranque acá y en
  `ESTADO.md`; los conteos finales los cierra `/cerrar-implementacion` (~3,3 días) · b) esperar a
  que termine la de dev (~3,5 días más) y usarla como canario completo antes de tocar prod ·
  c) no correrla en este flujo: dejar el runbook en `DEPLOY.md` y que sea una tarea operativa
  aparte — **Recomendada:** a, con la condición de recalcular `--to` el día que se lance.
- **Decidido:** **PENDIENTE DEL USUARIO** (ver §8). Razones para (a): la de dev ya lleva 89 días
  sin un solo error de red y valida el camino completo; el CLI es resumible, `--to ≤ hoy-2` no pisa
  al sweeper (D-060) y la ownership de D-029 protege toda celda editada a mano. Razón para dudar:
  son ~3,3 días de proceso lanzado desde este equipo, que tiene que quedar encendido, y escribe en
  la BD de producción.
- **Qué cambia / qué NO cambia:** no toca código. Si se autoriza, `deploy/DEPLOY.md` (L07) documenta
  el runbook con el comando exacto y el registro de arranque.

## 6. Hechos que cambian lo que dicen los documentos anteriores
> Este bloque se copia **tal cual** al inicio de cada prompt de las olas siguientes (O3 y O4).

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

## 7. Hallazgos consolidados (deduplicados entre lotes y revisiones)
| # | Origen | Hallazgo | Severidad | Destino |
|---|---|---|---|---|
| H24 | code-review (confirmado por el gate leyendo el código) | El refetch preservado actualiza `snapshot` y deja el `buffer` viejo: `calcularDiff` emite entonces celdas que el operador nunca tocó, y el Guardar siguiente **borra** (u override-0 a su nombre) una lectura que el SIS acababa de escribir; la ownership de D-029 impide reponerla. Cara simétrica: el número viejo del buffer pisa el valor fresco del SIS. | **alta** | **L09** CA-37 |
| H25 | code-review + `cierres/L04.md` (H-L04-3) | Limpiar una celda comentada y volver a escribir un número borra el `detalle`: `setCelda` reconstruye la celda desde cero y el backend, en la rama de UPDATE, hace `detalle = c.detalle ?? null`. La misma ausencia de la clave significa "conservar" 40 líneas más arriba (CA-36) y "borrar" acá. | media | **L09** CA-38 (la causa, en el front) + **L10** CA-47 (la simetría de la API) |
| H26 | code-review + `cierres/L08.md` (sospecha propia) | El popover decide hacia dónde abre por índice de fila (`p >= 19`), no por posición en el viewport, y el umbral contradice su propio comentario: con `.comb-scroll` desplazada vuelve el recorte, espejado. | media | **L09** CA-39 |
| H27 | code-review | `nAlim` repite el filtro de `columnasOrdenadas`; `tipClases` se arma para las 240 celdas en cada render aunque solo se use en las marcadas. | baja | **L09** CA-40 |
| H28 | code-review | `sondearDia` memoriza un fetch que **falló** como "vacío" para el resto de la corrida: un bache de red que tumbe los 6 sondeos de una ventana la certifica como pre-inicio, y la fase de confirmación relee la misma caché. La fecha de inicio puede salir meses o años tarde, sin aviso. | **alta** | **L10** CA-41 |
| H29 | code-review | `ventana()` corta con `break` cuando el offset pasa el techo, así que el sondeo del ancla se degenera a K=1 — la debilidad de la v1 que la v2 vino a eliminar. Un día de parada en el techo devuelve `null` y mata el CLI. | media | **L10** CA-42 |
| H30 | code-review | "Alcancé `maxYearsBack`" se devuelve igual que "encontré el inicio": el CLI imprime una fecha truncada como si fuera la respuesta. Además el retroceso desde `v.primera` reduce el alcance efectivo de 10 años a ~8,6, y la etiqueta `(-Na)` del log ya no son años. | media | **L10** CA-43 |
| H31 | code-review | Los 9 casos de `sis_scrape_endpoint.test.js` —incluidos los de unidad, que no tocan BD ni red— están gateados por `SIS_HOST`: un `npm test` normal los deja en `skipped` y la suite queda **verde y vacía** sobre el endpoint nuevo. | **alta (cobertura)** | **L10** CA-44 · el gate los corrió pasando `SIS_HOST` (§3), pero eso no es una red que se sostenga sola |
| H32 | code-review | Dos flakes en el mismo archivo: el discriminador "este 409 es del sweeper" usa `job == null`, que deja de ser cierto tras el primer job manual; y un `deepEqual` compara dos fotos vivas que incluyen `lock`, que el sweeper voltea en su tick. | media | **L10** CA-45 |
| H33 | code-review | Un sweeper apagado por `SIS_SWEEPER_ENABLED=0` (D7) solo se anuncia en una línea del log de arranque: desde `GET /sis/estado` se ve idéntico a uno sano en reposo. | media | **L10** CA-46 |
| H34 | code-review | `cleanupTestRegistros()` borra **todo** `consumo_combustible`/`sis_scrape_log` de `TST`/`TSR` sin cota de fecha: cualquier suite de otro proceso que lo llame borra las celdas de las cuatro suites de COMB/SIS a mitad de corrida. | media | **nota**: el **test-lock** de la metodología v2 es la mitigación vigente (serializa las corridas con BD entre chats) y la suite corre con `--test-concurrency=1`. Queda registrado en §6; si algún día se corren dos chats con BD a la vez, esto muerde |
| H35 | code-review | Voseo ("repetí") en la única línea de cara al operador del flujo `--from auto` del CLI. | baja | **arreglado en el gate** (D8) |
| H36 | code-review | `discoverEarliestDate(pool, …)` nunca usa `pool`; los tests le pasan `null`. | nota | ADR: la firma la fija C3; **L10** la enmienda de todos modos y puede limpiarlo de paso |
| H37 | code-review + security-review | Un scrape manual de 31 días retiene el mutex de proceso hasta ~2,6 h y **no se puede cancelar**: los ticks del sweeper se omiten mientras dure, y la única forma de soltarlo es reiniciar el backend (que además borra el estado del job). | nota | **ADR** (consecuencia consciente de C2/C9, ya documentada en la cabecera del módulo). Candidata a deuda: un `DELETE /sis/scrape` o un tope de rango más bajo |
| H38 | `cierres/L04.md` (H-L04-1) + `cierres/L06.md` (H-L06-3) | Todo backend efímero arranca el sweeper a los 10 s y sale a la red del SIS: contra un stub deja la fila de hoy de GEC32 con 24 errores, y con varios lotes vivos son varios scrapes simultáneos del mismo día (el mutex es de proceso). | media | **arreglado en el gate** (D7) |
| H39 | `cierres/L04.md` (H-L04-2) | `POST /consumos` respondía `fecha_futura` **sin** `codigo`, contra lo que afirmaba el §6 del GATE-O1. | baja | **arreglado en el gate** (D8) |
| H40 | `cierres/L05.md` (H-L05-2) | GEC32 tiene un hueco de ≥61 días en 2018 que la ventana por defecto no puede distinguir de "el SIS todavía no existía". | media | **ADR** + **L07** (documentar `--from auto` como calibración asistida). **L10** (H28/H29) lo endurece parcialmente; la mitigación operativa —fijar la fecha a mano— ya está aplicada |
| H41 | `cierres/L06.md` (H-L06-1) | Un test que se apoyaba en el **default silencioso** de `planta_id` de `scrapeDia` escribió 192 celdas y una fila `completo=1` en GEC32/`2026-04-17` de dev; con ese `completo=1` el backfill habría saltado el día para siempre dejándolo con datos inventados. | **alta, ya reparado por L06** | reparación verificada antes/después por L06 (`rowsAffected [192,1]`, GEC32 de vuelta a su estado previo) y **reverificada por el gate** (0 celdas y 0 logs de GEC3/GEC32 en `2026-04-15..20`). El arreglo estructural es `scrapeFixture()`. **Convención candidata para `CLAUDE.md`** (cierre): *toda escritura de un test pasa por un helper que fija la planta-fixture; el guard estático solo ve DML literal, una escritura que entra por un default es invisible para él* |
| H42 | `cierres/L05.md` (H-L05-1) | `js-scraper-carbon-g32/scrape.js` siempre raspa HOY, sin argumentos ni README: es inservible como verificador histórico. | baja | **L07** (CA-31 lo retira) + **ADR** (dejar constancia del 576/576, porque después no se puede repetir) |
| H43 | `cierres/L05.md` (H-L05-3) | Los días sin carbón cuestan 24 fetch igual (~80 s) para no escribir ni una celda; con el hueco de 2018 son varios meses así. | baja | nota de planificación (§6) |
| H44 | `cierres/L05.md` (H-L05-4) | El presupuesto real es **~95 s/día**, no el piso de ~12 s de escritura que sugería el cálculo del GATE-O1. | baja | §6 + **L07** (runbook) |
| H45 | `cierres/L08.md` (H-4) | Un test de componente que falla deja el componente **montado**: el `teardown()` al final del cuerpo se salta y los `setInterval`/listeners del zombi se cuelan en los casos siguientes, haciendo que una regresión real parezca romper media suite. L08 lo arregló en su archivo; **los otros tests jsdom del repo tienen el mismo patrón**. | media (metodológica) | **convención para `CLAUDE.md`** (cierre): desmontar en un `afterEach`, nunca al final del cuerpo. La deuda en los otros archivos queda fuera de D-061 |
| H46 | `cierres/L08.md` (H-5) | El `thead` sticky también le ganaba al popover, no solo el banderín vecino: el alcance real de H10 era mayor que lo que dijo el GATE-O1. | baja | **resuelto por el mismo cambio** (quitar el `z-index` del wrap); se anota para que el expediente no quede con un alcance mal medido |
| H47 | `cierres/L06.md` (H-L06-4) | El catálogo de `'TST'` es un fixture residente y un check ingenuo de residuos ("todo lo de TST es residuo") pondría el script en rojo en cada corrida limpia. | baja | anotado en el comentario de `residuos.js`; §6 |
| H48 | security-review (sub-umbral) | `/sis/scrape` no valida `plantaMatch`, y `plantaConSis` admite `'TST'` en producción. | nota | **ADR**: es el mismo modelo del resto de COMB (edición colaborativa cross-planta gateada por `puede_crear`, igual que DISP y que el POST batch); si alguna vez se cierra el eje horizontal, se cierra en los cuatro endpoints a la vez, no solo en el nuevo |

## 8. Ola siguiente
- **Lotes nuevos** (D9): `L09-front-refetch-guardar.md` y `L10-sis-endurecimiento.md`, ambos escritos
  por este gate y ya enmendados de nacimiento.
- **Prompt enmendado:** `L07-docs-cleanup.md` (cabecera, ENMIENDA G1: cifras del backfill, el
  runbook de prod, la variable `SIS_SWEEPER_ENABLED`, el retiro del standalone y los seis módulos de
  `utils/sis/`) + §6 copiado tal cual.
- **Reparto revisado:** `PLAN-OLAS.md` y `LOTES.json` actualizados — **O3 = L09 + L10**, **O4 = L07**
  (que ahora depende también de L09 y L10). Camino crítico: `L02 → L04 → {L09, L10} → L07 → cierre`.

| Ola | Lote | Título | Territorio | Depende de |
|---|---|---|---|---|
| O3 | L09 | El refetch preservado no puede convertirse en un borrado al guardar | `src/components/Combustibles/**` (5 archivos) | L08 |
| O3 | L10 | Endurecer el descubrimiento del SIS y hacer honesta la cobertura del scrape manual | `server/utils/sis/discover.js`, `server/scripts/backfill-carbon-gec32.js`, `server/routes/combustibles.js`, `server/tests/{sis_discover,sis_scrape_endpoint,sis_endpoints}.test.js` | L04, L05 |
| O4 | L07 | Docs + cleanup: BIT-MODBD 2.5, BIT-RF 1.9, architecture, glosario, DEPLOY, `git rm` | `BIT-*`, `docs/`, `deploy/DEPLOY.md`, `js-scraper-carbon-g32/**`, `prompts/D-029-*` | L04, L05, L06, L08, L09, L10 |

- **Pendientes del usuario, además del visto bueno:**
  1. **La corrida del backfill contra prod** (D10): decisión suya, con el comando y la foto de prod
     en §5.
  2. **El smoke visual de CA-12/CA-35** (arrastrado de GATE-O1 D4): **conviene hacerlo después de
     L09**, que vuelve a mover esa misma pantalla. El checklist está en `cierres/L03.md` y
     `cierres/L08.md` §"Para el gate".
- **Visto bueno del usuario:** {{pendiente}}.

## 9. Commit del gate
`gate(D-061): O2 cerrada — 4 lotes, 632/632 en verde y 0 skips, 0 violaciones, L09 y L10 nuevos`
(el SHA se anota en `ESTADO.md` §Bitácora: el expediente viaja dentro del mismo commit).
