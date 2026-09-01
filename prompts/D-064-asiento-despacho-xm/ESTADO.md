# D-064 — ESTADO (tablero por olas)

> Lo escribe **solo el integrador** (fase 2 y cada gate). Los lotes NO lo tocan: su estado vive en
> `cierres/LNN.md` y en `LOTES.json`. Este archivo es corto a propósito; el detalle está en los
> cierres y en los `GATE-On.md`.

## Tablero

| Ola | Lote | Título | Repo | Estado | Cierre | Gate |
|---|---|---|---|---|---|---|
| O1 | L01 | Persistir la llegada del despacho | `dashboard-gen-gec3` | ✅ | `cierres/L01.md` | — |
| O1 | L02 | Motor del asiento de sistema (puro) | `Bit-cora-g3` | ✅ | `cierres/L02.md` | — |
| O1 | L03 | Tipo de evento (`F36.A1`) y colapso en el libro | `Bit-cora-g3` | ✅ | `cierres/L03.md` | — |
| — | **GATE-O1** | 3 lotes · 0 violaciones · CA-2 y CA-3 confirmados | | ✅ | | `GATE-O1.md` |
| O2 | L04 | Lector, creador del asiento y barrido | `Bit-cora-g3` | ✅ | `cierres/L04.md` | — |
| O2 | L05 | CLI del relleno del mes | `Bit-cora-g3` | ✅ | `cierres/L05.md` | — |
| — | **GATE-O2** | 2 lotes · 0 violaciones · los 11 CA de código confirmados · 1 hallazgo bloqueante arreglado | | ✅ | | `GATE-O2.md` |
| Cierre | — | ADR D-064 + `CLAUDE.md` 37 + `BIT-MODBD` v2.7 + `BIT-RF` v2.3/RF-078 + REQ-05 + `git rm` | | ⬜ | | |

Leyenda: ⬜ pendiente · 🟡 en curso · ✅ done (lote) / cerrada con visto bueno (ola) · ⛔ bloqueado.
La verdad operativa es `lotes.mjs status`; esta tabla es la foto que deja cada gate.

## Baseline de la suite

| Momento | Resultado | Duración |
|---|---|---|
| Antes de O1 (rama base) | **681/681 backend · 324/324 front · 0 violaciones** — heredado del gate O2 de D-063 (`9dfbbe3`, 2026-08-29), sobre la rama que se mergeó a `feat/integrar-asientos-D-059`. No se volvió a correr en planeación. | ~40 min |
| GATE-O1 | **700/700 backend** (701 corridos; el único rojo es el guard del stub del SIS ausente, verde al relanzarlo con `SIS_HOST`) · **324/324 front** · **236/236 dashboard** · build ✔ · 0 violaciones · cero residuos. **+20 casos** sobre el baseline (8 de L02 + 12 de L03). | ~42 min backend, en 5 bloques |
| GATE-O2 | **724/724 backend** · **324/324 front** · build ✔ · 0 violaciones · cero residuos · cero asientos `DESPACHO_XM` en toda la BD. La cuenta: **701 (GATE-O1) + 3 + 20 = 724**; los **+3** ya eran de la O1 (el commit `7ac264e` los sumó *después* de la corrida de ese gate) y los **+20** son de esta ola (11 de L04 + 9 de L05). Un solo rojo, el mismo de siempre: el guard del stub del SIS ausente, verde al relanzarlo con `SIS_HOST` (10/10). El arreglo del hallazgo R1 agregó **un caso más** (el 9 de L05) y re-verificó 70 casos: el árbol de hoy da **725**. | ~50 min backend, en 10 bloques + 70 casos de re-verificación |

> **Deuda conocida de la base, no la confundas con una regresión:** `npm test` a secas contra un
> efímero **sin `SIS_HOST`** deja rojos los 5 casos del scrape manual (convención 35). Si aparecen,
> son de la base, no de este flujo.

## Hechos descubiertos (acumulado, breve)

- **Planeación (2026-08-31):** `asientoLiteralSala` habría prefijado la unidad al texto literal
  (`UNIDAD_YA_NOMBRADA` no matchea `"Se recibe del XM…"`), rompiendo CA-2. De ahí el marcador
  `origen_sistema` y el colapso de L03.
- **Planeación (2026-08-31):** el esquema `dashboard` **es visible** con las credenciales de
  Bitácora (query a `sys.schemas`), y `dashboard.despacho_recibido` **no existe**. Confirma la
  premisa de REQ-05 §5.1: la comunicación es por BD, sin endpoint nuevo.
- **Planeación (2026-08-31):** CA-11 (nadie edita el asiento) **sale gratis** de D-049
  (`canEditarRegistro` exige autoría y `SISTEMA` nunca tiene sesión). `permissions.js` **no se
  toca** en toda la implementación: se verifica, no se implementa.
- **GATE-O1 — el marcador no es inyectable por HTTP.** `validateCamposExtra` (AUD-39) arma el JSON
  **solo** con las claves declaradas en `definicion_campos`, y `SALAJDT`/`SALAING` la tienen en
  `NULL`: el `POST`/`PUT` genérico **descarta entero** el `campos_extra` que mande un operador a una
  bitácora de Sala. Junto al `seleccionable = 0` de `F36.A1`, nadie puede teclear algo que finja
  venir del sistema — y L04 no necesita defensa nueva.
- **GATE-O1 — una fila de sistema sin `clave_asiento` NO se colapsa** y ningún constraint lo impide:
  saldría cuatro veces en el libro sin que nada falle. La coherencia la sostiene
  `camposExtraDespacho`, no la BD (H5).
- **GATE-O1 — escribir y leer un flag son la misma tabla o no son nada.** El escritor coaccionaba
  `hora_estimada` con `Boolean` y el lector tenía su propia lista de afirmativos: un `'false'` de un
  `JSON_VALUE` (que devuelve nvarchar) se escribía `true` y se leía `false`. Ahora los dos pasan por
  `normalizarHoraEstimada`, con test que fija las dos puntas (R5).
- **GATE-O1 — el colapso del libro tenía tres huecos que borraban un renglón sin error**, los tres
  encontrados por el `/code-review` y arreglados en el gate (D4): cruzaba días (la ventana de
  `armarMes` abre ±1 día y el recorte va después del dedupe), mezclaba el espacio de nombres de la
  clave con el `id|<n>` de lo tecleado, y reservaba la clave **antes** de saber si había texto —así
  una fila con `detalle` vacío silenciaba a sus tres hermanas—. Ahora la agrupación es
  `sys|<día>|<clave>` y se reserva después del guard.
- **GATE-O1 — `claveAsientoDespacho` y `camposExtraDespacho` también LANZAN** con fecha inválida (el
  contrato C2 solo lo documentaba para `asientoDespachoXM`). Validar con `Date` sola habría fechado
  mal el asiento sin excepción: `new Date('2026-02-30')` rueda al 2 de marzo (medido).
- **GATE-O1 — la tabla `dashboard.despacho_recibido` NO existe todavía** en `PortalG3_dev`: nace con
  el `initDB()` del **otro** repo. Durante toda la O2 ese es el estado normal, y es exactamente el
  que C4 manda tratar como `[]` sin lanzar.
- **GATE-O1 — hueco conocido en el origen:** si la BD está caída en el instante de la detección, el
  hecho de ese día se pierde (`#foundTomorrow` se prende antes de escribir). Decidido no arreglarlo
  (GATE-O1 §5 D2): lo cubren el reinicio del servicio y el relleno de L05 con hora estimada. **La
  ausencia de una fila no prueba que no llegó el despacho.**
- **GATE-O1 — deuda anterior a este ADR:** una fila de Sala con `campos_extra` malformado tumba el
  libro del mes entero (`JSON_VALUE` lanza; no hay CHECK `ISJSON`). Viene de D-058/D-063; no se
  toca acá (GATE-O1 §5 D3), corrección de una línea ya redactada en `cierres/L03.md`.
- **GATE-O2 — un proceso que no es el server no tiene live bindings, y `getDB()` no se los da.**
  `USUARIO_SISTEMA_ID` lo resuelve solo `initDB()`, así que el CLI del relleno lanzaba en **cada**
  día del mes y salía con un resumen de ceros en vez de con un error de arranque — mientras el
  `--dry-run` pasaba limpio, porque nunca llega al escritor. Y ninguno de los 9 casos del lote podía
  verlo: el harness llama a `initDB()` en su `before`. **Arreglado en el gate** con
  `resolverLiveBindings` exportada (dos `SELECT`, no `initDB()` entero) y un caso 9 que corre en un
  **proceso hijo** (GATE-O2 §5 D4, hallazgo R1).
- **GATE-O2 — el duplicado que teme H4 de L05 lo absorbe el propio libro.** El colapso agrupa por
  `sys|<día Bogotá>|<clave>`, y las dos tandas de una carrera comparten clave **y** `fecha_evento`:
  el renglón sale una sola vez y las 4 filas de más quedan invisibles salvo que alguien lea la
  tabla. El único caso que sí se vería son dos detecciones en días Bogotá distintos. *Lectura del
  código del colapso, no medición.*
- **GATE-O2 — hallazgos que quedan como deuda, todos `LOW`:** la verificación de cierre del CLI está
  acotada por planta mientras la idempotencia del creador es global (R2, imposible de disparar hoy);
  el `_` de `DESPACHO_XM` es comodín de `LIKE` (R3); y `stopDespachoXMSweeper()` no corta un tick en
  vuelo (R4, mismo patrón que `sis-sweeper.js`, inocuo porque el único llamador hace `process.exit`
  en la línea siguiente).

## Desviaciones acumuladas respecto a `REQ-05` / `_CONTEXTO-BASE.md`

- **Planeación D1 — cuatro filas en vez de dos.** RQ-05.8/RQ-05.10 dicen "un registro en `SALAJDT`
  y otro en `SALAING`" / "las dos filas"; se implementan **cuatro** (las dos bitácoras × las dos
  plantas) para que el asiento sea visible en la Sala de las dos unidades. El espíritu de RQ-05.5
  se conserva: un solo texto, un solo renglón en el libro. **El cierre actualiza el REQ.**
  Ver `PREGUNTAS-D-064.md` § Desviaciones.
- **GATE-O1 D1 — CA-4 tiene dueño en las dos puntas.** `LOTES.json` se lo asigna solo a L04, pero la
  tabla §5 del prompt de L01 se lo suma, y L01 lo implementó y verificó (dos ticks → una escritura,
  con guard estático de que el SQL no tiene `MERGE`/`UPDATE`). El gate lo registra como `parcial`
  con mitad de origen en L01 y mitad de destino en L04. **Cerrado en el GATE-O2:** las dos mitades
  verdes, CA-4 pasa a `cumple`. **No se editó `LOTES.json`.**
- **GATE-O2 D4 — el gate escribió en territorio de un lote cerrado.** El arreglo de R1 tocó
  `scripts/relleno-asiento-despacho.js` y su test, que son de L05. Es la misma excepción que el
  GATE-O1 usó en D4/D5 sobre `f03-datos.js` y `sistema.js`, y va con verificación bidireccional
  propia. `db.js` no cuenta como excepción: es compartido y en la O2 no tiene escritor, así que es
  del gate por `_CONTEXTO-BASE §8`.
- **GATE-O2 D2 — no se abrió una O3.** El plan preveía 2 olas y así quedó; lo que sigue es
  `/cerrar-implementacion D-064`. `PLAN-OLAS.md` no se modificó.

## Bitácora

- **2026-08-31** · Fase 1 cerrada: dos rondas, 7 preguntas, todas congeladas en
  `PREGUNTAS-D-064.md`. El REQ-05 llegó sin preguntas abiertas, así que las rondas fueron solo de
  decisiones de implementación.
- **2026-08-31** · Fase 2 cerrada: scaffolding + reservas commiteados. Rama
  `feat/asiento-despacho-xm-2026-08` en los **dos** repos (Bitácora desde
  `feat/integrar-asientos-D-059` `5cc84a2`; dashboard desde `main` `d8f8f5e`).
  `docs/interfaces-cross-repo.md` del umbrella actualizado **antes** de la O1.
- **2026-08-31** · O1 abierta con 3 chats (L01, L02, L03).
- **2026-08-31** · **O1 cerrada** (`GATE-O1.md`). Los tres lotes `done`, sin bloqueos y sin salirse
  del territorio. Suite completa en 5 bloques contra un efímero en 3199 + build + vitest del front +
  suite del repo del dashboard: **sin degradación** frente al baseline heredado. Se engancharon al
  script `test` los dos archivos nuevos (`asiento_despacho_xm`, `f03_despacho_xm`), 59 en total, con
  `zzz_session_leak_guard` último. **CA-2 y CA-3 confirmados `cumple`**; CA-1/4/7/8/12 quedan
  `parcial` por diseño del reparto (nadie escribe filas hasta L04). El `/code-review` (nivel high)
  devolvió **14 hallazgos**, verificados uno por uno: **9 arreglados en el gate** —los tres del
  colapso en `f03-datos.js` y el separador del ADR (D4, re-verificados con 56/56 y 98/98), más las
  cinco correcciones de `sistema.js` y de los tests (D5, 59/59)—, 3 como deuda documentada, 2
  pasados a enmienda de la O2 y 2 rechazados con razón. Cinco decisiones (D1-D5) y siete hallazgos
  consolidados, ninguno bloqueante. **O2 abierta con el visto bueno del usuario (L04 y L05).**
- **2026-08-31** · **O2 cerrada** (`GATE-O2.md`). Los dos lotes `done`, sin bloqueos y sin salirse
  del territorio. Suite completa en 10 bloques contra un efímero en 3199 + build + vitest del
  front: **sin degradación**. Se engancharon `despacho_xm` y `relleno_despacho_xm` al script `test`
  (61 archivos, `zzz_session_leak_guard` último). **Los 11 CA de código quedan `cumple`** —
  incluidas las cuatro mitades que la O1 había dejado `parcial`—; solo CA-12 sigue `parcial`, y su
  pendiente es documental. El `/code-review` (nivel high) devolvió **4 hallazgos**: **R1 era
  bloqueante y se arregló en el gate** (el CLI nunca resolvía `USUARIO_SISTEMA_ID`: la corrida real
  habría fallado los 31 días escribiendo cero asientos, con el `--dry-run` pasando limpio), con
  reproducción, caso 9 de regresión y ruptura deliberada; los otros 3 son `LOW` y quedan como deuda
  documentada. Cuatro decisiones (D1-D4). **Sin O3: lo que sigue es `/cerrar-implementacion D-064`,
  pendiente del visto bueno del usuario.**
