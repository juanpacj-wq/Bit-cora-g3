# D-058 — ESTADO (bitácora viva)

> **Puente de contexto entre sesiones.** A diferencia de `_CONTEXTO-BASE.md` (inmutable), este
> archivo se actualiza en CADA etapa:
> - **Al empezar** una etapa: leerlo para saber qué quedó hecho, qué se descubrió y qué
>   desviaciones acumuladas hay.
> - **Al terminar** una etapa: registrar qué se hizo, archivos tocados, resultado de tests,
>   desviaciones y datos descubiertos.
>
> Una etapa solo se ejecuta si **todas las anteriores figuran ✅** en el tablero.
>
> Branch sugerido: `feat/asientos-operacion-2026-07`.

## Tablero de avance

| Etapa | Estado | Resumen |
|---|---|---|
| E0 — Andamiaje | ✅ | `PREGUNTAS-D-058.md` (15 respuestas, 3 rondas), `_CONTEXTO-BASE.md`, `ESTADO.md`, `E1..E10`. |
| E1 — Motor de asientos (puro) | ✅ | `utils/asientos/` (puro) + 28 tests unitarios + 6 guards contra el catálogo real. Nadie lo importa todavía. |
| E2 — El asiento en el listado del día + copiar | ✅ | `GET /lotes` devuelve `asiento`; el listado lo pinta a todo el ancho + copiar renglón / copiar el día. Cierra REQ-04 §8.1 y §8.3. |
| E3 — `seleccionable` + los 8 tipos espejo | ✅ | Columna `seleccionable` (F33.A1) + 8 tipos espejo sembrados en `SALAJDT`/`SALAING` con `0`; el selector los esconde y el POST/PUT genérico los rechaza. 11 tests nuevos. |
| E4 — Reflejo a Sala: crear | ✅ | `utils/reflejo-sala.js` (`crearReflejoLote`) enganchado en `POST /guardar`: cada lote se asienta en SALAJDT **y** SALAING dentro de la misma transacción. 6 tests nuevos sobre una segunda planta-fixture. |
| E5 — Reflejo a Sala: corregir y borrar | ✅ | `actualizarReflejoLote`/`borrarReflejoLote` enganchados en el `PUT` y el `DELETE` de lotes: corregir regenera el asiento en las dos copias y borrar las borra, en la transacción del origen. 7 tests nuevos; suite 489/488. |
| E6 — El asiento reflejado es de solo lectura | ✅ | El asiento reflejado no se edita ni se borra en su destino **ni por su autor** (que es el del origen): `canEditarRegistro` + su espejo SQL, con `codigo` propio `asiento_reflejado` y chip de origen en la fila. 5 tests nuevos (2 back, 3 front); suite 491/490. |
| E7 — XLSX ESM + plantilla F03 derivada | ⬜ | — |
| E8 — Consulta unificada y armado del día | ⬜ | — |
| E9 — Endpoint mensual + selector y botón | ⬜ | — |
| E10 — Docs + ADR D-058 + cleanup | ⬜ | — |

Leyenda: ⬜ pendiente · 🟡 en progreso · ✅ hecho y probado · ⛔ bloqueado.

### Dependencias entre etapas

```
E1 ──┬─> E2
     ├─> E4 (necesita también E3)
     └─> E8
E3 ──> E4 ──> E5 ──> E6
E4 ──> E8   (E8 excluye los reflejados: necesita la marca ya definida y poblada)
E7 ──> E9
E8 ──> E9
```

## Decisiones / desviaciones acumuladas

> Cambios respecto a `_CONTEXTO-BASE.md`/`PREGUNTAS` que surgieron al ejecutar. Cada uno con la
> etapa que lo originó y si tiene o no impacto funcional.

- **E1 — `carga()` resuelve la preposición del tramo de periodos.** El insumo fija solo el caso
  frecuente (rango contiguo → `del P17 al P19`). Para los otros dos, escribir `del P20` o
  `del P3, P7 y P19` queda agramatical, así que el motor emite `en el P20` y
  `en los P3, P7 y P19`. Los tres ejemplos literales del insumo salen idénticos. Sin impacto
  funcional; si el usuario prefiere otra redacción, se cambia en `formato.js:tramoPeriodos`.
- **E1 — `potenciaMW(null)` devuelve `''`, no `'0 MW'`.** `Number(null)` es `0` y un cero
  inventado es indistinguible del redespacho plano a cero, que es un caso REAL (06/01). El vacío
  se descarta antes de convertir, tanto en `potenciaMW` como en el filtro de celdas.
- **E1 — se agregó un segundo archivo de tests no previsto en el plan** (`asientos_catalogo.test.js`,
  solo lectura). Motivo: el motor **lanza** ante un tipo/estado desconocido, y eso solo es seguro
  mientras sus enums sean espejo de los `CHECK` de la BD. Habilitado porque el `.env` de la sesión
  apunta a `PortalG3_dev`; aun así **no** escribe nada, así que sigue siendo seguro contra prod.
- **E1 — el commit incluye dos rutas fuera de la lista del `.md` de la etapa**: `server/package.json`
  (enganchar los tests al script `test` es regla dura del contexto base — el guard de D-041 existía
  y no corría por saltarse esto) y `prompts/D-058-asientos-operacion/` (el andamiaje estaba sin
  trackear; D-057 lo llevó versionado hasta su cleanup).
- **E2 — en el LISTADO el asiento se degrada a `null` en vez de propagar el throw del motor.** El
  contrato de E1 (lanzar ante un tipo desconocido) se mantiene intacto donde el texto se PERSISTE
  —el reflejo de E4—, pero `GET /lotes` es la única vista de lo registrado hoy y
  `notificar_dashboard_tipo` es NULLABLE (`db.js` anticipa "tipos que NO notifican"): un tipo MAND
  nuevo dejaría el día ENTERO en 500. Se pierde un renglón y se loguea, no la jornada.
- **E2 — el asiento va en una segunda fila a todo el ancho, no en una columna más.** Es una frase
  completa y truncarla la volvería inútil justo para lo que existe (copiar y pegar). Las columnas
  de D-056/D-057 quedan intactas.
- **E2 — se ajustó una aserción de `lote-correccion-gate.test.jsx` (D-057)**, que contaba CERO
  botones sin `puedeCrear` como proxy de "no hay acciones". Ahora hay botones de copiar sin
  `puede_crear` (RN-04.f: copiar no es escribir), así que la aserción pasó a nombrar los controles
  de ESCRITURA, que es lo que ese test cuida. Su intención no cambió.
- **E2 — `useSalaDeMando.js` no se tocó** (estaba en la lista del commit del `.md`): `getLotes`
  devuelve el payload tal cual y `asiento` viaja dentro de cada lote. No hacía falta cambiar nada y
  agregar código muerto habría sido peor.
- **E3 — `seleccionable` también se hace cumplir en el POST/PUT genérico, no solo en el selector.**
  El `.md` pedía filtrar `GET /bitacoras/:id/tipos-evento`, pero ESCONDER el tipo no impide
  POSTearlo con el id directo — y esa fila es exactamente el asiento sin `origen_lote_id` que la
  etapa existe para evitar (lección de D-046: lo que solo bloquea el front es evadible por
  devtools). Se agregó `AND seleccionable = 1` a los dos lookups `(tipo_evento_id, bitacora_id)` de
  `registros.js`, que ya rechazaban con el mismo 400. **No es un bypass ni toca
  `canEditarRegistro`** (es una restricción, y la excepción de MAND sigue donde vive) y **no
  estorba a E4/E5**: el reflejo inserta por SQL directo, no por este endpoint.
- **E3 — el `UPDATE` complementario solo fuerza el `0` de las 8 filas espejo**, no `seleccionable=1`
  en el resto (el patrón `oculta` de CIET sí hace los dos lados). Forzar el 1 afirmaría que ningún
  otro tipo puede estar oculto jamás, que es más de lo que esta etapa sabe; los preexistentes ya
  quedan en 1 por el `DEFAULT WITH VALUES`.
- **E3 — dos tests no previstos en el `.md`**: un guard de que ningún tipo espejo tiene
  `notificar_dashboard_tipo` (RN-02.a: la copia no publica al dashboard; hoy es NULL porque el
  cableado F6 matchea `b.codigo='MAND'`, pero nada lo fija) y dos guards estáticos que verifican que
  los lookups de `registros.js` y `catalogos.js` conservan el filtro. Los estáticos corren sin BD y
  sin servidor: si el filtro se cae, no depende de que el test funcional esté levantado.
- **E4 — el guard de RN-02.e vive DENTRO del módulo, no replicado en cada enganche.** El `.md` lo
  pedía en `mand.js`; está en `crearReflejoLote` (y el enganche lo señala con un comentario). Motivo:
  E5 agrega dos call sites más y el ADR de DISP traerá otros — un guard copiado es un guard que
  alguien olvida (mismo criterio que `sesion-contexto.js`, D-054). Sin impacto funcional.
- **E4 — la planta-fixture que SÍ refleja vive en `tests/helpers.js`, NO en `db.js`, y se siembra con
  `activa = 0`.** El `.md` ofrecía "misma mecánica que `TEST_PLANTA_ID` en `db.js`", pero declararla
  en `db.js` obligaba a excluirla también en `catalogos.js`/`sesion-contexto.js`/`eventos-dashboard.js`
  — y ahí aparecía la incoherencia de fondo: si el código de producto la conociera como "planta de
  test", el reflejo terminaría excluyéndola y la suite dejaría de probar lo que dice probar.
  Producción no la conoce: para el producto es una planta cualquiera. El `activa = 0` es lo que la
  vuelve inofensiva — `GET /api/catalogos/plantas` y `validarPlantaOperable` filtran por `activa = 1`,
  así que ningún operador puede verla ni entrar a ella, y `sesion_activa` no valida la planta más allá
  de la FK.
- **E4 — usuario sintético propio (`test_reflejo_jdt`), no los de `setupSessions`.** `ensureSesion`
  desactiva las otras sesiones del mismo usuario (sesión única, D-035): reusar `test_jdt` habría
  matado su sesión sobre `TST` y el resto de la suite de MAND se habría dado 401 a sí misma (la
  lección de D-055, acá en versión "dos plantas"). Precedente: `test_opcarbon`/`test_coord_cym`.
- **E4 — dos guards tocados.** `guard_no_prod_historico_destruction` suma `TEST_PLANTA_REFLEJO`/`'TSR'`
  a sus acotadores (es una fixture, acota igual de fuerte que `'TST'`), y `zzz_session_leak_guard`
  excluye `TSR` de "planta real": con `activa = 0` una sesión ahí no puede aparecer en el panel
  CONECTADOS de nadie, que es exactamente lo que ese guard protege. Su `after()` la desactiva igual.
- **E4 — `crearReflejoLote` LANZA; no degrada.** Ante `hora_llamada` ausente/inválida, asiento vacío o
  tipo espejo faltante, corta la transacción. Es la contracara deliberada del degradado a `null` de
  E2: allá el texto se MUESTRA (perder un renglón es mejor que perder la jornada), acá se PERSISTE en
  el histórico — una copia muda o sin hora sería peor que un error.
- **E5 — el sello de auditoría de la copia va por `CASE` contra el valor anterior, no incondicional.**
  El `.md` pedía "sella `modificado_por`/`modificado_en` con el usuario que corrigió"; se implementó
  como lo hace el ORIGEN (D-057, decisión 2: solo se sellan las celdas AFECTADAS), así que un `PUT`
  que no mueve ni el asiento ni la hora deja la copia sin sellar. Sellar incondicionalmente diría que
  alguien corrigió un asiento que nadie tocó, y rompería la paridad con MAND. Cubierto por E5.7.
- **E5 — `turno_id` NO se re-resuelve al corregir.** Es el puntero de archivado que se fijó al crear
  la copia (D-045); reapuntarlo al turno abierto de HOY movería una copia de turno por el solo hecho
  de corregir el origen. Y no arreglaría nada: si su turno ya hubiera cerrado, la copia no estaría
  viva en `registro_activo`. Lo que sí se mueve con la hora es `fecha_evento` (narrativo) y la
  columna vieja `turno` (1|2), que describe cuándo pasó.
- **E5 — el `UPDATE`/`DELETE` van acotados también por `planta_id` y por `bitacora_id IN (…)`**, no
  solo por `origen_lote_id`. El `IN` no es decorativo: sin él, el DML por lote alcanzaría cualquier
  fila que mañana reuse la clave — el reflejo de DISP, que tiene su propio ADR pendiente.
- **E5 — la validación común de crear/corregir se extrajo a `normalizarLote`** (tipo, `lote_id`,
  hora, asiento no vacío y `turno`). Si cada función armara el asiento por su cuenta, un lote
  corregido podría quedar redactado distinto del mismo lote recién capturado — la divergencia que
  REQ-02 elimina. Sin cambio de contrato: `crearReflejoLote` se comporta igual que en E4.
- **E5 — un test más de los seis pedidos por el `.md`** (E5.7, el `PUT` que no cambia nada): es la
  única cobertura de la rama `ELSE` del `CASE` de auditoría, que si no quedaría sin probar.
- **E5 — se corrigió un comentario de E4 que afirmaba que `registro_activo.detalle` es `NOT NULL`.**
  No lo es desde una migración vieja (`db.js:547` lo pasa a `NULL`). El argumento que sostenía —una
  copia muda es peor que un error— no dependía de eso y quedó reescrito sin la premisa falsa.
- **E6 — el rechazo lleva `codigo` propio (`asiento_reflejado`), no `solo_autor`.** El enforcement
  sigue siendo UNO (`canEditarRegistro`, que ya devuelve `false`); el endpoint solo elige el motivo,
  llamando al MISMO predicado. Razón: responderle "solo el autor puede editarlo" a quien **es** el
  autor es una explicación falsa, y lo deja sin saber que la corrección va por Operación 24h. Efecto
  lateral bueno: si alguien borra una de las dos ramas, la otra sigue bloqueando.
- **E6 — el `GET /activos` suma `origen_bitacora_nombre`** (LEFT JOIN al catálogo por `codigo`). Sin
  eso el chip tendría que hardcodear "Operación 24h" en el front, que es exactamente lo que prohíbe
  la convención 25 (D-052: el nombre visible vive SOLO en el seed). El front recibe el rótulo; del
  `campos_extra` solo lee el dato (`origen_lote_id`), nunca una etiqueta.
- **E6 — el `check` del `DELETE` no traía `campos_extra`** (el del `PUT` sí). El helper no puede
  decidir sobre una columna que el llamador no selecciona: sin agregarla, el gate habría quedado
  **inerte justo en el borrado** y verde en los tests del `PUT`. Es el mismo tipo de trampa que el
  `stripComments` de D-055.
- **E6 — NO hizo falta blindar el POST/PUT genérico contra un `origen_lote_id` forjado a mano.** Se
  evaluó (lección de E3: esconder no es impedir) y resultó ya cerrado por AUD-39: `validateCamposExtra`
  arma `campos_extra` **solo** con las claves declaradas en `definicion_campos`, y las bitácoras de
  Sala la tienen en `NULL` → por ese endpoint `campos_extra` sale `NULL`. Agregar un guard redundante
  habría sido código que nadie puede hacer fallar.
- **E6 — los tests marcan la copia a mano** (`UPDATE campos_extra … WHERE registro_id = @id`, acotado
  por PK) en vez de generarla con el reflejo real: `TEST_PLANTA` no refleja (RN-02.e) y el reflejo de
  verdad ya lo cubren E4/E5 sobre `'TSR'`. Lo que E6 prueba es el **gate**, que lo único que mira es
  `origen_lote_id` — así el test no depende de que MAND corra en esa planta.

## Datos descubiertos en ejecución

> Hechos que solo se conocen corriendo. Rellenar a medida.

- **Las 7 filas que migró `F32.A1` tienen un `lote_id` POR FILA**, así que no compactan: una
  autorización de `90 MW` en P1..P5 rinde **cinco renglones** (`… a generar 90 MW en el P1.`, …)
  en vez de uno solo con `del P1 al P5`. No es bug del motor —la compactación solo puede agrupar
  lo que el dato ya trae junto, y esas filas nacieron sueltas antes de que D-056 inventara el
  lote—, pero **E2 (listado) y E8 (libro F03) van a mostrarlo así** y conviene no confundirlo con
  un defecto. Los 3 lotes capturados después de D-056 compactan bien
  (`del P7 al P14`, `del P5 al P9`, `del P11 al P16`).
- **El `.env` de esta máquina apunta a `PortalG3_dev` (192.168.17.20), no a prod** — pero esa BD
  trae una **copia de los datos reales** (los mismos 26 registros / 10 lotes de MAND que reportó la
  planificación contra prod). La disciplina de `TEST_PLANTA`/`es_sintetico` NO se relaja: los
  guards estáticos la exigen a nivel de código y el próximo que corra la suite puede tener el
  `.env` apuntando a prod.
- **La suite HTTP necesita el backend levantado**: sin él, `turno_transicion_write_gate` y
  compañía fallan con `ECONNREFUSED 127.0.0.1:3002` (no es regresión). Se levanta con
  `cd server && AUTH_TEST_BYPASS=1 node --env-file=../.env server.js`; el puerto sale de
  `SERVER_PORT` del `.env` (3002), no de `PORT`.
- Volumen real hoy en la BD: MAND 26 celdas / 10 lotes · DISP 1 estado · Sala 5 registros — lo
  esperado por el contexto base.
- **Los `tipo_evento_id` que sembró F33.A1** (para depurar E4 — el código **nunca** los cachea, los
  resuelve por `(bitacora_id, nombre)`): `SALAING` → 30 `Autorización`, 31 `Pruebas`,
  32 `Redespacho`, 33 `Cambio de Disponibilidad`; `SALAJDT` → 34, 35, 36, 37 en el mismo orden.
  Los `Evento General` de Sala siguen siendo 17 (`SALAJDT`) y 28 (`SALAING`), y los de MAND
  20/21/22 y DISP 23 quedaron intactos. Total: 30 tipos, 8 con `seleccionable = 0`, cero duplicados
  `(bitacora_id, nombre)`. Ojo: los ids de `SALAING` salieron ANTES que los de `SALAJDT` (el
  `CROSS JOIN` ordena por `bitacora_id`, y `SALAING` es posterior en el catálogo pero menor en id).
- **Cómo quedó resuelta la planta-fixture que SÍ refleja (E5 y E8 dependen de esto).**
  `TEST_PLANTA_REFLEJO = 'TSR'` + `setupSesionReflejo()`, **ambos en `server/tests/helpers.js`** (no
  en `db.js`: producción no la conoce). Se siembra `activa = 0` → invisible en el selector del login
  y rechazada por `validarPlantaOperable`; la sesión se inserta directo en `sesion_activa`, que no
  valida la planta más allá de la FK. Usuario propio `test_reflejo_jdt` (cargo `Ingeniero Jefe de
  Turno`, con `puede_crear` en MAND por matriz). **E5 la reusa tal cual**: los tests de corrección y
  borrado van en `sala_de_mando_batch.test.js` con `sesionReflejo()` y limpian con `cleanReflejo()`
  (borra `registro_activo`/`registro_historico`/`evento_dashboard`/`mand_cierre_log` de `'TSR'`).
  **E8** debe excluir `'TSR'` del libro F03 igual que `'TST'` (RN-06.g).
- **`es_sintetico` se marca en el ARRANQUE** (`db.js`, `UPDATE … WHERE username LIKE 'test\_%'`), así
  que un usuario creado a mitad de corrida queda en `0` hasta el próximo restart: `deactivateSynthetic
  Sessions()` no lo alcanzaría y el guard final saldría rojo. Por eso `setupSesionReflejo` lo setea
  **explícito** en el MERGE. Vale para cualquier fixture nueva.
- **`broadcastConteoBitacoras` NO necesitó cambio** (RQ-02.4): `fetchSnapshot` agrupa por
  `bitacora_id` sobre **todas** las bitácoras no ocultas de la planta, así que las dos copias entran
  al contador de SALAJDT/SALAING solas.
- **La BD de la red corporativa se cae sola, y más de una vez (E5, 2026-07-26/27).** Pasó **dos
  veces** en la misma sesión: `192.168.17.20:1433` deja de aceptar TCP (~25 min la primera; los
  adaptadores Ethernet quedan "medios desconectados" y el ping falla) y TODOS los archivos que tocan
  BD se ponen rojos: el primer test de cada archivo falla a los **~15 s** (el `connectionTimeout` de
  `mssql`) y los demás al instante; el `turno-sweeper` del server efímero loguea el mismo `Failed to
  connect … in 15000ms`. **Ese patrón —15 s el primero, 0 ms el resto, archivos enteros en rojo— es
  infra, no regresión**: confirmalo con `bash -c 'cat < /dev/null > /dev/tcp/192.168.17.20/1433'`
  antes de buscar la causa en el código.
- **Los procesos en background de la sesión mueren a los ~20 min** (server efímero y `npm test`, los
  dos con exit 127 al mismo tiempo). Como un `npm test` completo dura ~40 min, la forma que SÍ
  termina es **por bloques de archivos en primer plano** (cada uno bajo los 10 min del tool), con el
  server efímero levantado aparte y revisado con `curl /health` entre bloques. `zzz_session_leak_guard`
  va en el último bloque, como en el script `test`.
- **Levantar el server efímero dispara el catch-up del `mand-sweeper` sobre plantas REALES**
  (`cierre catch-up GEC3 2026-07-26: 17 registros`): archiva el día MAND anterior a
  `registro_historico`, que es lo que hace todos los días en producción. No es destrucción, pero
  después de levantarlo un lote de AYER responde `409 lote_cerrado` — no lo confundas con un bug.
- **`JSON_VALUE` LANZA ante texto no-JSON; no devuelve `NULL`** (comprobado:
  `SELECT JSON_VALUE('no soy json','$.x')` → *"JSON text is not properly formatted"*). Importa porque
  el espejo del `GET /activos` lo evalúa sobre **cada fila del listado**: una sola fila con
  `campos_extra` corrupto pondría la grilla entera en 500. Hoy es imposible —**cero** filas no-JSON en
  `registro_activo`, y todos los escritores guardan `JSON.stringify(objeto)` o `NULL`— así que ni el
  espejo ni el `UPDATE`/`DELETE` de E5 necesitan `ISJSON`. Si algún día se persistiera `campos_extra`
  crudo del cliente, los tres se caen juntos: es la premisa que sostiene a los tres.
- **El front NO ramifica por `codigo` en registros** (cero referencias a `solo_autor` en `src/`): el
  403 se muestra por su `mensaje`. Por eso `asiento_reflejado` no necesitó cableado extra en el front
  — el texto amigable ya viaja en la respuesta (D-032).
- **El puerto 3002 puede estar tomado por el backend del usuario.** El arranque igual corre
  `initDB()` (la migración se aplica) y luego muere con `EADDRINUSE`. Para los tests HTTP se levanta
  uno efímero: `cd server && AUTH_TEST_BYPASS=1 SERVER_PORT=3102 node --env-file=../.env server.js`
  y la suite con `TEST_BASE_URL=http://localhost:3102`. **Importante:** si se prueba contra el 3002
  ajeno, se está probando el código VIEJO — el test del filtro pasaría o fallaría por la razón
  equivocada.

## Baseline y riesgos conocidos al arrancar

- **La suite corre contra la BD productiva (D-030).** Ningún test escribe/borra en planta real:
  `TEST_PLANTA_ID` (`'TST'`) + `TEST_TAG` (sin `[` ni `]`).
- **Flaky conocido, no es regresión:** `finalizar_turno` (4a2/4a3/4e/4f), por borde de turno T1↔T2 y
  por fuga de estado con la cabecera TST `CERRADO`. `npm test` no respeta el orden de archivos de
  `package.json`.
- **`npm run lint` no existe** en este repo. La verificación de front es `npm run build`.
- Adopción real y baja al planificar (2026-07-26): MAND 26 filas / 10 lotes · DISP 1 evento de
  prueba · Sala 6 registros de prueba. Las hojas van a salir casi vacías y **eso es correcto**.

## Bitácora por etapa

### E0 — Andamiaje  ✅
- Creados: `PREGUNTAS-D-058.md` (15 preguntas en 3 rondas, todas respondidas y congeladas),
  `_CONTEXTO-BASE.md`, `ESTADO.md`, `E1-*.md` … `E10-*.md`.
- Verificado durante la planificación, contra código y contra el `.xlsx` real:
  el catálogo de `tipo_evento` (MAND `Autorización`/`Pruebas`/`Redespacho`; DISP
  `Cambio de Disponibilidad`; SALAJDT/SALAING `Evento General`), que
  `GET /api/catalogos/bitacoras/:id/tipos-evento` **no filtra** por visibilidad, que
  `resolverTurnoAbierto` (`turno-entidad.js:144`) acepta pool o transacción, que el F03 tiene
  **170 entradas ZIP** (todas DEFLATE salvo `media/image1.png`, STORED) y **32 `definedName`
  `_xlnm.Print_Area`** con rangos por hoja (`$A$6:$I$25` … `$A$6:$I$32`).
- Sin código de producto todavía.

### E1 — Motor de asientos (puro)  ✅

**Archivos tocados**
- `server/utils/asientos/formato.js` (nuevo) — convenciones canónicas §4: `unidadCanonica`,
  `potenciaMW`, `listaPeriodos`, `carga` (regla de compactación) y `UNIDAD_YA_NOMBRADA`.
- `server/utils/asientos/plantillas.js` (nuevo) — las plantillas de §5, una constante por tipo +
  el mapa de los 4 estados de DISP. Devuelven la frase SIN punto y SIN `detalle`.
- `server/utils/asientos/index.js` (nuevo) — `asientoLote` · `asientoDisponibilidad` ·
  `asientoLiteralSala`, y el único lugar donde se cierra la frase y se engancha el `detalle`.
- `server/tests/asientos.test.js` (nuevo) — 28 tests unitarios PUROS (sin BD, 275 ms).
- `server/tests/asientos_catalogo.test.js` (nuevo) — 6 guards de SOLO LECTURA contra el catálogo.
- `server/package.json` — los dos archivos enganchados al script `test`.

**Decisiones de implementación que no estaban en el plan**
- Un tipo/estado desconocido **LANZA** en vez de devolver `''`: viene de una columna con `CHECK`,
  así que es bug del llamador, y un renglón en blanco en el histórico o en el F03 es peor que un
  error. Es justo lo que fija el guard anti-drift de `asientos_catalogo.test.js`.
- El `detalle` se aplana a un renglón (`\s+` → espacio) porque el asiento **es** una línea (celda
  del F03, fila del listado). No se corrige ni se reescribe su contenido. El texto de Sala, en
  cambio, no se toca ni con eso: pasa literal, y **no** se le agrega punto final (agregarlo sería
  normalizar).

**Verificación real**
- `node --test tests/asientos.test.js tests/asientos_catalogo.test.js` → **34/34 pass, 0 fail.**
  El archivo puro corre en 275 ms (si tardara, habría tocado la BD).
- Los 6 guards contra el catálogo real pasaron: los 4 estados de `PLANTILLA_DISP` son exactamente
  `CK_disp_estado_evento`; los 3 tipos de `PLANTILLA_LOTE` son exactamente
  `CK_te_notificar_dashboard_tipo`; MAND cablea `AUTH→Autorización`, `PRUEBA→Pruebas`,
  `REDESP→Redespacho` (los nombres literales que E3 tiene que copiar).
- **Smoke contra datos reales**: se renderizaron los 10 lotes de MAND (26 celdas, sobre
  `registro_activo` + `registro_historico`), el estado de DISP y los 5 registros de Sala. Ninguno
  lanzó, ninguno salió vacío, ninguno dijo `MWh`/`undefined`, ninguno perdió texto del operador ni
  duplicó el prefijo de unidad. Muestra generada:
  `Se recibe llamada del CND (juanpa) autorizando GEC3 a generar 20 MW del P7 al P14.` ·
  `GEC3 E/L en servicio.` · `GEC3 — Evento: Salida de mando`
- `cd server && npm test` (suite completa, con el backend levantado, contra `PortalG3_dev`):
  **tests 462 · suites 26 · pass 461 · fail 0 · cancelled 0 · skipped 1** (`parseXls`, skip
  declarado ajeno) en 34,9 min. Es el baseline de D-057 (428/427) **+ los 34 nuevos**, sin un solo
  rojo: ni siquiera el flaky conocido de `finalizar_turno`, y `zzz_session_leak_guard` corrió y
  pasó dentro de la corrida.
- Sin front en esta etapa → no aplica `npm run build`.

**Desviaciones** — las cuatro registradas arriba en "Decisiones / desviaciones acumuladas".
Ninguna cambia el contrato del motor ni las plantillas del insumo.

### E2 — El asiento en el listado del día  ✅

**Archivos tocados**
- `server/routes/mand.js` — `import { asientoLote }` + helper `asientoDeLote(lote, planta_id)` y el
  campo `asiento` en cada objeto de `GET /lotes`. El orden del listado no se tocó (`hora_llamada`
  DESC, sin-hora al final, desempate `creado_en` DESC — RN-04.a).
- `src/components/SalaDeMando/LotesDelDia.jsx` — el asiento en una segunda fila a todo el ancho +
  `copiarTexto()` (portapapeles con fallback) + `textoDelDia()` + botón de copiar por renglón y
  botón "Copiar el día" en la cabecera, con feedback breve por clave (`'dia'` o `lote_id`).
- `server/tests/sala_de_mando_batch.test.js` — 3 tests nuevos (D-058 E2.1/E2.2/E2.3).
- `src/components/lotes-del-dia-asiento-copiar.test.jsx` (nuevo) — 5 tests jsdom sobre el componente
  REAL, con el portapapeles instrumentado.
- `src/components/SalaDeMando/lote-correccion-gate.test.jsx` — la aserción "cero botones sin
  `puedeCrear`" pasó a nombrar los controles de escritura (ver desviaciones).

**Decisiones de implementación**
- El backend arma el texto y el front SOLO lo pinta (respuesta 6). El front no conoce ninguna
  plantilla: si mañana cambia una palabra del insumo, cambia en `utils/asientos/` y se propaga a los
  tres consumidores.
- El asiento va en una segunda fila con `colSpan`, no en una columna nueva: es una frase completa y
  truncarla la volvería inútil justo para lo que existe (copiar y pegar en WhatsApp). El borde
  inferior lo pinta la segunda fila para que el par se lea como un solo renglón.
- La hora se antepone al copiar el día (`HH:MM — asiento`), NUNCA dentro del asiento: los lotes sin
  hora salen sin prefijo, jamás un `null —`.
- Fallback de portapapeles con `textarea` + `execCommand`: `navigator.clipboard` exige contexto
  seguro y por HTTP plano no existe — sin fallback el botón sería decorativo justo donde más se usa.

**Verificación real**
- `npm run build` (raíz) → **verde**, 15,1 s.
- `npx vitest run` (front) → **82/82 pass, 12 archivos** (77 previos + los 5 nuevos).
- `node --test --test-concurrency=1 tests/sala_de_mando_batch.test.js` → **65/65 pass, 0 fail**
  (62 previos + los 3 nuevos), 242 s.
- `cd server && npm test` (suite completa, backend levantado, contra `PortalG3_dev`):
  **tests 465 · suites 26 · pass 464 · fail 0 · cancelled 0 · skipped 1** (`parseXls`, skip
  declarado ajeno) en 36,4 min. Baseline de E1 (462/461) **+ los 3 nuevos**, sin un solo rojo: ni el
  flaky conocido de `finalizar_turno`, y `zzz_session_leak_guard` corrió último y pasó.
- **Smoke visual**: se rasterizó el componente REAL (vitest+jsdom → HTML + el CSS del `dist` →
  Edge headless → PNG) con tres lotes: AUTH compacto con detalle, REDESP con valores distintos por
  periodo y un migrado sin hora. Las columnas de D-056/D-057 quedaron intactas, el asiento se lee
  completo en su fila, la hora sigue en SU columna y los botones de copiar aparecen donde deben.

**Desviaciones** — las cinco registradas arriba en "Decisiones / desviaciones acumuladas". Ninguna
cambia el contrato del motor, las plantillas del insumo ni el shape previo de `GET /lotes` (el campo
`asiento` se SUMA; nada se quitó ni se renombró).

### E3 — `seleccionable` + los 8 tipos espejo  ✅

**Archivos tocados**
- `server/db.js` — **F33.A1**, en dos puntos: (a) la columna `seleccionable BIT NOT NULL DEFAULT 1
  WITH VALUES` **junto al DDL de `lov_bit.tipo_evento`**, para que exista ANTES de cualquier seed;
  (b) el seed de los 8 tipos espejo (`CROSS JOIN` de los 4 nombres × `SALAJDT`/`SALAING`,
  idempotente por `NOT EXISTS (bitacora_id, nombre)`) más el `UPDATE` complementario que reafirma el
  `0` en cada arranque. El seed va después del cableado de `notificar_dashboard_tipo`, dentro del
  bloque de catálogos que se reconstruye en cada arranque.
- `server/routes/catalogos.js` — `GET /bitacoras/:id/tipos-evento` filtra `seleccionable = 1`.
- `server/routes/registros.js` — los dos lookups `(tipo_evento_id, bitacora_id)` (POST `:269` y
  PUT `:637`) exigen `seleccionable = 1` (ver desviaciones). Mismo 400 que ya devolvían.
- `server/tests/tipos_evento_espejo.test.js` (nuevo) — 11 tests.
- `server/package.json` — el archivo nuevo enganchado al script `test`, después de
  `catalogo_bitacoras`.

**Decisiones de implementación**
- La columna se llama `seleccionable`, no `activo`: `activo` se confunde con "bitácora activa" (y
  con `usuario.activo`). Los tipos preexistentes quedan en `1` por el `DEFAULT WITH VALUES` — la
  migración no toca ni una fila de datos.
- Los nombres son literales del catálogo de origen (`Autorización` con tilde, `Pruebas` en plural,
  `Cambio de Disponibilidad`) y el test 3 los fija contra MAND/DISP: si mañana se renombra uno allá,
  el espejo queda huérfano y ahora se entera un test, no el histórico.
- El cuarto tipo se sembró aunque el reflejo de DISP esté fuera de alcance (respuesta 13): el seed
  se reconstruye en cada arranque y así no hay que volver a tocar el bloque cuando llegue su ADR.
- Sembrar tipos NO tocó la matriz de permisos: el operador sigue tecleando en `Evento General`.

**Verificación real**
- `node --test --test-concurrency=1 tests/tipos_evento_espejo.test.js` (contra el server efímero en
  3102) → **11/11 pass, 0 fail**, 118 s.
- **Comprobación directa en la BD tras el arranque con la migración:** 30 tipos en total, exactamente
  **8 con `seleccionable = 0`** (los espejo, ids 30–37), **cero duplicados** `(bitacora_id, nombre)`,
  y **ninguna otra fila cambió** — `MAND` (20/21/22, con su `notificar_dashboard_tipo`
  `AUTH`/`PRUEBA`/`REDESP` intacto), `DISP` (23) y los `Evento General` de Sala (17/28) siguen en
  `seleccionable = 1`. Los 8 espejo quedaron con `notificar_dashboard_tipo = NULL` y
  `es_default = 0`.
- `cd server && npm test` (suite completa, contra `PortalG3_dev`, server efímero en 3102):
  **tests 476 · suites 26 · pass 475 · fail 0 · cancelled 0 · skipped 1** (`parseXls`, skip
  declarado ajeno) en 40,1 min. Baseline de E2 (465/464) **+ los 11 nuevos**, sin un solo rojo: ni
  el flaky conocido de `finalizar_turno`, y `zzz_session_leak_guard` corrió último y pasó.
  `guard_tipo_evento_coherente` verde.
- `npm run build` (raíz) → **verde**, 9,9 s. No se tocó front; se corrió como sanity del cambio de
  payload del selector (solo desaparecen opciones que nadie usaba).

**Desviaciones** — las cuatro registradas arriba en "Decisiones / desviaciones acumuladas". La única
con impacto funcional es el enforcement en el POST/PUT genérico, que **cierra** un hueco en vez de
abrirlo y no altera ningún camino existente (todos los tipos que ya se usaban quedaron en `1`).

### E4 — Reflejo a Sala: crear  ✅

**Archivos tocados**
- `server/utils/reflejo-sala.js` (nuevo) — `crearReflejoLote(tx, {...})` + `plantaRefleja` (guard
  RN-02.e, una sola vez) + `BITACORAS_REFLEJO` / `TIPO_ESPEJO_MAND`. Inserta las DOS copias con el
  asiento del motor de E1, resuelve `tipo_evento_id` por `(bitacora_id, nombre)` en cada llamada y
  no abre ni cierra transacciones: se compone con la del origen. E5 le agrega `actualizar`/`borrar`.
- `server/routes/mand.js` — `POST /guardar` acumula `lotesCreados` y, tras el recálculo de
  `evento_dashboard` y **dentro de la misma transacción**, llama al reflejo una vez por lote. Sin
  `try/catch`: si falla, revierte también el lote.
- `server/tests/helpers.js` — `TEST_PLANTA_REFLEJO` (`'TSR'`, `activa = 0`) + `setupSesionReflejo()`.
- `server/tests/sala_de_mando_batch.test.js` — 6 tests nuevos (E4.1..E4.6) + `cleanReflejo()`,
  `copiasDelLote()`, `registrosSalaReflejo()`; el `after()` del archivo limpia la fixture nueva.
- `server/tests/guard_no_prod_historico_destruction.test.js` — `TEST_PLANTA_REFLEJO`/`'TSR'` como
  acotadores de fixture.
- `server/tests/zzz_session_leak_guard.test.js` — `TSR` fuera de "planta real" (ver desviaciones).

**Decisiones de implementación**
- **`fecha_evento` y `turno_id` van por criterios DISTINTOS, y las dos razones quedaron comentadas en
  el código.** `fecha_evento` = la `hora_llamada` del lote (dato narrativo: el asiento se lee donde
  el operador lo espera y coincide con el listado y con el F03). `turno_id` = el turno **ABIERTO** de
  la unidad, porque no es narrativo sino el **puntero de archivado** (D-045): una copia apuntando a
  un turno ya CERRADO no la archiva nadie y queda viva en `registro_activo` para siempre, y el
  rescate de huérfanos tampoco la alcanza (solo levanta `turno_id IS NULL`). Por eso `NULL` cuando no
  hay turno abierto. **No contradice a D-055 (b)**: allá la celda pertenece a UN periodo; acá el
  asiento es del LOTE, cuyos periodos pueden caer en dos turnos.
- La columna vieja `turno` (1|2) sí sale de la hora del asiento
  (`turnoFromPeriodo(periodoFromFechaBogota(hora))`): describe cuándo pasó, no dónde se archiva.
- El vínculo es `campos_extra.origen_lote_id`, por LOTE y no por registro: la copia también migra al
  histórico, así que no hay FK posible (mismo argumento de D-055 (c)).
- El `tipo_evento_id` se resuelve en cada llamada por `(bitacora_id, nombre)` y **nunca se cachea**;
  si falta alguno de los 8 tipos de F33.A1, lanza en vez de insertar un tipo de otra bitácora (el
  drift invisible de D-053).
- Los snapshots se **reusan** de la transacción de MAND: recalcularlos costaría tres queries más y,
  con la sesión moviéndose, podría dar otro resultado.
- **Estado intermedio conocido hasta E6:** la copia nace con `creado_por` = el autor del origen, así
  que hoy ese autor **puede** editarla o borrarla desde su bitácora de Sala (`canEditarRegistro`
  exige autoría + `puede_crear`, D-049). RQ-02.5 lo cierra en E6, que es donde vive esa tarea; no se
  adelantó acá para no partir el gate entre dos etapas.

**Verificación real**
- `node --test --test-concurrency=1 --test-name-pattern="D-058 E4"` → **6/6 pass**, 90 s.
- `node --test --test-concurrency=1 tests/sala_de_mando_batch.test.js` (archivo completo) →
  **71/71 pass, 0 fail**, 307 s. Baseline de E2 (65) **+ los 6 nuevos**.
- `cd server && npm test` (suite completa, server efímero en 3102, contra `PortalG3_dev`):
  **tests 482 · suites 26 · pass 481 · fail 0 · cancelled 0 · skipped 1** (`parseXls`, skip declarado
  ajeno) en 40,8 min. Baseline de E3 (476/475) **+ los 6 nuevos**, sin un solo rojo: ni el flaky
  conocido de `finalizar_turno`, y `zzz_session_leak_guard` corrió último y pasó.
  `guard_tipo_evento_coherente` y `guard_no_prod_historico_destruction` verdes.
- **Consulta directa a la BD tras la corrida** (lo que pide la etapa): **cero** filas residuales en
  `'TSR'`, **cero** copias con `origen_lote_id` en cualquier planta, **cero** sesiones sintéticas
  activas, **cero** `turno_unidad` de la fixture, **cero** `evento_dashboard` de `'TST'`/`'TSR'`,
  **cero** incoherencias `tipo_evento.bitacora_id ≠ registro.bitacora_id`, y **cero** registros de
  Sala en GEC3/GEC32 (o sea: la suite no dejó ni un asiento en planta real). `'TSR'` quedó residente
  con `activa = 0` y `test_reflejo_jdt` con `es_sintetico = 1`.
- `npm run build` (raíz) → **verde**, 15,8 s. No se tocó front; se corrió como sanity.

**Desviaciones** — las cinco registradas arriba en "Decisiones / desviaciones acumuladas". La única
que cambia lo pedido por el `.md` es dónde viven el guard de RN-02.e y la planta-fixture; ninguna
altera el contrato del reflejo ni el comportamiento del `POST /guardar` para plantas reales.

### E5 — Reflejo a Sala: corregir y borrar (la cascada)  ✅

**Archivos tocados**
- `server/utils/reflejo-sala.js` — `actualizarReflejoLote` (UPDATE del asiento + `fecha_evento` +
  `turno`, con el sello de auditoría por `CASE`) y `borrarReflejoLote` (DELETE de las copias vivas),
  más `resolverBitacorasDestino` (los dos `bitacora_id` por `codigo`) y `normalizarLote` (el núcleo
  compartido con la captura). Arriba de las dos, el bloque que explica por qué `rowsAffected = 0`
  **no es error** y por qué no se responde 409.
- `server/routes/mand.js` — los dos puntos de enganche que D-057 dejó anotados sin código
  (`PUT` y `DELETE` de lotes) pasaron a llamar al módulo, **dentro de la transacción existente**,
  después del diff/borrado y del recálculo de `evento_dashboard`. Sin `try/catch`.
- `server/tests/sala_de_mando_batch.test.js` — 7 tests nuevos (E5.1..E5.7) + `seedLoteReflejo()`
  (siembra un lote con sus copias vía el módulo de producción, para el estado inicial que el `POST`
  rechaza por diseño: REDESP en periodo pasado). Se actualizó el comentario de la cabecera de
  D-057 E3 que declaraba la cascada "fuera de alcance".

**Decisiones de implementación**
- **Corregir REGENERA el texto de las copias** (decisión H): no se agrega un renglón de corrección.
  La bitácora de Sala muestra el estado ACTUAL y el rastro vive en `modificado_por`/`modificado_en`.
- **El `PUT` recibe el estado POSTERIOR al diff**, no el body crudo: el asiento tiene que describir
  lo que quedó en la BD. La búsqueda de las copias va por `origen_lote_id`, nunca por `registro_id`.
- **Un `409` por "copia archivada" habría sido un bug, no una protección**, y quedó comentado en el
  código para que nadie lo "arregle": volvería incorregible un lote a las 18:01 por el estado de su
  reflejo, invirtiendo la jerarquía y contradiciendo el criterio 12 de REQ-04 (MAND está exenta de
  los gates de turno, D-057). El histórico no se reescribe (RF-032) y el origen se corrige igual.
- Las tres decisiones restantes —sello por `CASE`, `turno_id` inmutable, acotadores del DML— están
  arriba, en "Decisiones / desviaciones acumuladas".

**Verificación real**
- `node --test --test-concurrency=1 --test-name-pattern="D-058 E5"` → **7/7 pass, 0 fail**, 113 s.
- `node --test --test-concurrency=1 tests/sala_de_mando_batch.test.js` (archivo completo) →
  **78/78 pass, 0 fail**, 423 s. Baseline de E4 (71) **+ los 7 nuevos**. Con ellos siguen verdes los
  14 criterios de D-057 (diff quirúrgico, retroceso del publicado, lock sobre el delta,
  `lote_sin_celdas`, `409 lote_cerrado`) y **los dos llamados a `verificarCoherenciaDeLotes()`** —
  el de la captura y el de la corrección (D-056 (c)).
- `guard_no_prod_historico_destruction` + `guard_no_prod_disp_destruction` +
  `guard_tipo_evento_coherente` → **10/10 pass**: el `UPDATE`/`DELETE` de los tests nuevos lleva su
  acotador de fixture léxicamente junto al statement (`registro_id = @r`, `TEST_PLANTA_REFLEJO`).
- `npm run build` (raíz) → **verde**, 15,9 s. No se tocó front; se corrió como sanity.
- **Suite completa: `tests 489 · pass 488 · fail 0 · skipped 1`** (`parseXls`, skip declarado ajeno),
  contra `PortalG3_dev` con el server efímero en 3102. Baseline de E4 (482/481) **+ los 7 nuevos**,
  sin un solo rojo — **ni el flaky conocido de `finalizar_turno`** (44/44 su bloque) — y
  `zzz_session_leak_guard` corrió **último** y pasó, igual que en el script `test`.
  Se corrió en **10 bloques de archivos en vez de un `npm test` de una sola pieza**, por dos razones
  de entorno, ninguna del código: la red corporativa tiró la BD **dos veces** (ver "Datos
  descubiertos") y los procesos en background de esta sesión mueren a los ~20 min, así que un `npm
  test` de 40 min no llega al final. Cada bloque corrió en primer plano bajo los 10 min. Reparto:
  (1) guards estáticos + módulos puros 134/133+1skip · (2) catálogos/tipos espejo/coherencia 30 ·
  (3) revalidate + fechas + `turno-entidad` 83 · (4) auth + DISP 47 · (5) cierre + conformación 23 ·
  (6) `sala_de_mando_batch` 78 · (7) COMB + finalizar + cambiar unidad 44 · (8) registros + gate de
  transición + seguimiento 6+8 · (9) históricos + rol CyM + SIS + IA 35 · (10) leak guard 1.
- **Consulta directa a la BD tras la corrida**: **cero** filas en `'TSR'` (vivas e histórico), **cero**
  en `'TST'`, **cero** copias con `origen_lote_id` en CUALQUIER planta (o sea: la suite no dejó ni un
  asiento reflejado, tampoco archivado), **cero** registros de Sala en GEC3/GEC32, **cero** sesiones
  sintéticas activas, **cero** `evento_dashboard` de fixtures, **cero** incoherencias
  `tipo_evento.bitacora_id ≠ registro.bitacora_id`. MAND real intacto (26 celdas vivas en GEC3).

**Desviaciones** — las seis registradas arriba. La única que cambia lo pedido por el `.md` es el
sello condicional (`CASE`), que alinea la copia con el criterio del origen en vez de contradecirlo.

### E6 — El asiento reflejado es de solo lectura en su destino  ✅

**Archivos tocados**
- `server/middleware/permissions.js` — `esAsientoReflejado(registro)` + `CLAVE_ORIGEN_REFLEJO`
  (predicado único sobre `campos_extra.origen_lote_id`) y su condición dentro de
  `canEditarRegistro`, con la trampa del autor comentada.
- `server/routes/registros.js` — el espejo SQL del `GET /activos` suma la MISMA condición
  (`JSON_VALUE(r.campos_extra,'$.origen_lote_id') IS NULL`) y el campo `origen_bitacora_nombre`
  (LEFT JOIN al catálogo por `codigo`); el `PUT` y el `DELETE` responden `403 asiento_reflejado` con
  su mensaje; el `check` del `DELETE` pasó a traer `campos_extra`.
- `src/BitacorasGecelca3.jsx` — `RegistroRow` deriva `esReflejado` del `campos_extra` y pinta el chip
  de origen (mismo patrón que "Bloqueado"), al lado del ojo de lectura.
- `server/tests/registros_solo_autor.test.js` — 2 tests nuevos (E6.6 y E6.7) + `marcarComoReflejado()`.
- `src/components/grilla-solo-autor-gate.test.jsx` — 3 tests nuevos (chip + ojo + ausencia del chip).

**Decisiones de implementación**
- **El helper y su espejo SQL se cambiaron JUNTOS**, que es la regla de D-049 y lo único que impide
  que la grilla ofrezca un lápiz que el backend rechaza. El test 7 los enfrenta en la misma corrida:
  mismo autor, misma bitácora, misma planta, mismo cargo — lo único que cambia es el origen.
- **Es una RESTRICCIÓN, no un bypass.** D-049/D-039 prohíben *ampliar* quién edita; acá se recorta, y
  sin excepción para nadie (tampoco el ADMIN). La excepción de MAND no se tocó: sigue viviendo en el
  gate `puede_crear` de su endpoint por lote, y MAND ni siquiera pasa por `canEditarRegistro`
  (D-057 (c)). `sala_de_mando_batch` lo confirma en verde.
- El front **no** decide la editabilidad: la sigue derivando de `puede_editar` (D-049). Lo único que
  agrega el `campos_extra` es el chip — el dato, no la etiqueta, que viene resuelta del catálogo.
- Las cinco decisiones restantes están arriba, en "Decisiones / desviaciones acumuladas".

**Verificación real**
- `node --test --test-concurrency=1 tests/registros_solo_autor.test.js` → **7/7 pass, 0 fail**, 61 s
  (5 previos + los 2 nuevos). El 403 llega con `codigo: 'asiento_reflejado'` en `PUT` y en `DELETE`, y
  la copia queda con su texto intacto.
- `node --test --test-concurrency=1 tests/sala_de_mando_batch.test.js` → **78/78 pass, 0 fail**, 185 s.
  **El par se lee junto** (lo pide el `.md`): la corrección de un lote por un NO-autor sigue
  funcionando, y con ella los 14 criterios de D-057 y los 13 tests de D-058 E2/E4/E5.
- `npx vitest run src/components/grilla-solo-autor-gate.test.jsx` → **8/8 pass** (5 previos + 3
  nuevos). Suite front completa: **85/85 pass, 12 archivos** (82 previos + los 3).
- `npm run build` (raíz) → **verde**, 14,1 s.
- **Suite backend completa: `tests 491 · pass 490 · fail 0 · skipped 1`** (`parseXls`, skip declarado
  ajeno), contra `PortalG3_dev` con el server efímero en 3102. Baseline de E5 (489/488) **+ los 2
  nuevos**, sin un solo rojo — ni el flaky conocido de `finalizar_turno` (44/44 su bloque) — y
  `zzz_session_leak_guard` corrió **último** y pasó. Se corrió en **11 bloques en primer plano**, por
  las dos razones de entorno ya documentadas (los procesos en background mueren a los ~20 min y un
  `npm test` de una pieza dura ~40). Reparto: (1) guards estáticos + módulos puros 79 · (2) tipos
  espejo + coherencia + los dos guards de destrucción 21 · (3) revalidate + fechas + `turno-entidad`
  83 · (4) auth + DISP 47 · (5) cierre + conformación 23 · (6) `sala_de_mando_batch` 78 · (7) COMB +
  finalizar + cambiar unidad 44 · (8) `registros_turno_id` + gate de transición + seguimiento 9 ·
  (9) históricos + guards no-auto-ejecutables + rol CyM + SIS + hardening + errores + IA 106 (1 skip)
  · (10) `registros_solo_autor` 7 · (11) leak guard 1. Suma bruta 498; los dos guards de destrucción
  (7 tests) cayeron en dos bloques → **491 únicos**.
- **Smoke visual** (rasterizado del componente REAL: vitest+jsdom → HTML + el CSS del `dist` → Edge
  headless → PNG), con una bitácora de Sala mostrando las dos filas lado a lado: el asiento reflejado
  se lee completo, muestra el chip "Operación 24h" y el ojo de lectura, y **no** tiene lápiz ni
  basurero; el registro tecleado a mano por el mismo autor conserva los dos. El artefacto era
  temporal y se borró (no se commitea).

**Desviaciones** — las seis registradas arriba. La única que se aparta de lo pedido por el `.md` es el
`codigo` propio en vez de reusar `solo_autor`, que hace el rechazo *más* informativo sin partir el
enforcement.

<!-- Cada etapa agrega su bloque: ### EX — <título>  ✅ con Archivos tocados / Verificación / Desviaciones. -->
