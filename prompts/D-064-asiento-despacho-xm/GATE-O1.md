# D-064 — GATE-O1 (cierre de la ola O1)

> Expediente **inmutable** del integrador. Si algo de acá se revierte después, se enmienda encima
> ("REVERTIDA el … por …"), no se borra. Fecha: **2026-08-31 14:05** (Bogotá).
>
> **Cifra titular:** 3 lotes, **701 tests corridos · 0 rojos nuevos** (backend 700/700 con el stub
> del SIS + front 324/324 + dashboard 236/236), **0 violaciones de territorio**, cero residuos.

## 1. Semáforo al cerrar

```
D-064 · rama feat/asiento-despacho-xm-2026-08

O1 [abierta]
  L01  done        L01-1057     Persistir la llegada del despacho (repo dashboard-gen-gec3)
  L02  done        L02-1057     Motor del asiento de sistema (puro)
  L03  done        L03-1057     Catálogo del tipo de evento (F36.A1) y colapso en el libro F03

O2 [pendiente]
  L04  pending                  Lector del hecho, creador del asiento y barrido cada 5 min ← L01,L02,L03
  L05  pending                  CLI del relleno del mes (resumible, --dry-run) ← L04

test-lock: libre
```

Lotes sin cierre commiteado: **ninguno**. Ninguno quedó `in-progress` ni `blocked`; los tres
dejaron su `cierres/LNN.md` commiteado y ninguno reportó bloqueos.

## 2. Territorios

```
=== L01 ===
L01 · 1 commit(s): b92244f
archivos tocados (1):
  prompts/D-064-asiento-despacho-xm/cierres/L01.md
[lotes] territorio respetado

=== L02 ===
L02 · 3 commit(s): 6a963de f772663 442dd0d
archivos tocados (3):
  prompts/D-064-asiento-despacho-xm/cierres/L02.md
  server/tests/asiento_despacho_xm.test.js
  server/utils/asientos/sistema.js
[lotes] territorio respetado

=== L03 ===
L03 · 2 commit(s): f6bfe21 74bb641
archivos tocados (4):
  prompts/D-064-asiento-despacho-xm/cierres/L03.md
  server/db.js
  server/tests/f03_despacho_xm.test.js
  server/utils/f03-datos.js
[lotes] territorio respetado
```

**Violaciones: ninguna.** El verificador solo ve el repo de Bitácora, así que el gate revisó a mano
el commit de L01 en `dashboard-gen-gec3` (rama `feat/asiento-despacho-xm-2026-08`, nacida de `main`
`d8f8f5e`, creada por el propio lote como autoriza su prompt §0):

```
399f536 feat(D-064 L01): persistir la llegada del despacho del día siguiente
 server/__tests__/despachoscraper.test.js | 101 +++++++-
 server/db.js                             |  41 +++
 server/despachoscraper.js                |  28 +-
```

Los tres archivos son su territorio declarado. `emailDispatch.js`, `despacho_programado` y
`getColombiaDate()` quedaron intactos, como manda el fuera-de-alcance. Árbol limpio en los dos
repos.

## 3. Verificación de la ola (bajo test-lock `GATE-O1`)

- **Tests enganchados a `server/package.json`** (los engancha el gate, único escritor):
  `tests/asiento_despacho_xm.test.js` tras `tests/asientos_catalogo.test.js` (unitario puro), y
  `tests/f03_despacho_xm.test.js` inmediatamente después de `tests/f03_datos.test.js` (comparten las
  plantas-fixture, con meses distintos para que no se pisen), como pidieron los dos cierres. 59
  archivos en el script; `zzz_session_leak_guard` sigue **último**.
- **Suite backend, con el código de la rama**, contra un efímero `SERVER_PORT=3199
  AUTH_TEST_BYPASS=1` (BD `PortalG3_dev`). Corrida **en 5 bloques** (la suite pasa de los ~20 min
  que sobrevive un proceso en background), sumados:

  | Bloque | Archivos | Resultado |
  |---|---|---|
  | 1 | guards, ws_origin, auth_bypass, entra_roles, catálogos, tipos espejo, split_sala, campos, asientos | `tests 98 · pass 98 · fail 0` (226 s) |
  | 2 | asientos_catalogo, **asiento_despacho_xm**, reflejo_disponibilidad, f03_libro, f03_datos, **f03_despacho_xm**, revalidate, fechas, turno-entidad, auth_middleware, auth_reactivate, disponibilidad | `tests 208 · pass 208 · fail 0` (631 s) |
  | 3 | disponibilidad_anios/reflejo_http, cierre_y_fechas, sala_de_mando_batch, conformacion, consumos, sis_endpoints, **sis_scrape_endpoint**, finalizar_turno, cambiar_unidad, registros_turno_id, registros_solo_autor | `tests 206 · pass 200 · fail 1 · skipped 5` (1.042 s) |
  | 4 | turno_transicion, turno_seguimiento, históricos, 3 guards de scripts, rol_coordinador, rol_usuario_consulta, sis_schema/parser/hardening | `tests 82 · pass 82 · fail 0` (342 s) |
  | 5 | sis_discover/sweeper/lock/ownership/concurrencia, contrato_eventos_dashboard, http_hardening, errores, ia_*, **zzz_session_leak_guard** | `tests 107 · pass 107 · fail 0` (284 s) |
  | | **Total** | **701 corridos · 695 pass · 1 fail · 5 skipped** |

- **El único rojo es la deuda conocida de la base, no una regresión.** Es
  `sis_scrape_endpoint › CA-53. los casos HTTP no se saltean en silencio`, el guard que la propia
  suite tiene para que la ausencia del stub del SIS **no** pase desapercibida (el `.env` no trae
  `SIS_HOST`; convención 35 y la nota del `ESTADO.md`). Relanzando ese archivo como el propio test
  indica —`SIS_HOST=http://localhost:3154` en el efímero **y** en `node --test`, que levanta el
  stub—:

  ```
  ℹ tests 10 · pass 10 · fail 0 · skipped 0    (tests/sis_scrape_endpoint.test.js, 50,9 s)
  ```

  Con el stub, la suite backend queda en **700/700, sin rojos**.

- **Evidencia literal de los dos archivos nuevos** (los CA de esta ola), corridos aparte para
  capturar su salida completa:

  ```
  ✔ texto literal del F03 (4.5564ms)
  ✔ un día de un dígito sale con cero a la izquierda (0.3758ms)
  ✔ rechaza fechas inválidas en vez de inventar (1.973ms)
  ✔ clave y campos_extra (2.1203ms)
  ✔ no usa la clave del reflejo (0.427ms)
  ✔ predicados no se caen con basura (0.9244ms)
  ✔ hora estimada: la ausencia es false y el texto de JSON_VALUE se entiende (0.2777ms)
  ✔ las constantes del contrato C2 son las que importan L03, L04 y L05 (0.2483ms)
  ℹ tests 8 · pass 8 · fail 0      (tests/asiento_despacho_xm.test.js — CA-2)

  ▶ D-064 L03 — F36.A1, el tipo del asiento automático
    ✔ F36.A1 siembra el tipo en las dos bitácoras, oculto y con orden 5 (3.6116ms)
    ✔ el nombre del tipo es el del contrato C2, sin divergencia entre el seed y el motor (1.0777ms)
    ✔ un segundo arranque no duplica el tipo ni le sube el flag (seed idempotente) (16470.1169ms)
    ✔ el UPDATE complementario devuelve el flag a 0 si alguien lo sube fuera del arranque (17631.2194ms)
  ▶ D-064 L03 — CA-3, el colapso de las 4 filas en un renglón
    ✔ colapsa las 4 filas en un renglón, con el texto literal y en el bloque de su hora (1186.7339ms)
    ✔ dos jornadas distintas son dos renglones: la clave agrupa por FECHA, no por marcador (1591.776ms)
    ✔ los registros normales no se colapsan (625.0932ms)
    ✔ dos registros tecleados con el MISMO texto y la MISMA hora siguen siendo dos renglones (527.5107ms)
    ✔ el prefijo de unidad sigue vivo para lo tecleado (645.73ms)
    ✔ el asiento de sistema ENTRA al libro: el filtro de reflejados no lo alcanza (897.8698ms)
    ✔ el predicado degrada ante un campos_extra corrupto (y SQL lanza antes: ver hallazgo H4) (1.2036ms)
    ✔ un asiento de sistema SIN clave de agrupación no se colapsa, pero tampoco se prefija (654.4043ms)
  ℹ tests 12 · pass 12 · fail 0    (tests/f03_despacho_xm.test.js — CA-3)
  ```

  > Nota de infraestructura, no del código: el primer intento de esta corrida aislada murió con
  > `RequestError: Connection lost - read ECONNRESET` contra `192.168.17.20`, en el `before` del
  > archivo de L03 (12 casos cancelados); el efímero registró el mismo corte en su log. Con la BD de
  > vuelta (`SELECT 1` OK) el archivo corrió 12/12. Esos mismos 12 ya habían pasado dentro del
  > bloque 2.

- **Front:** `npm run build` ✔ (`built in 10.90s`, sin errores) y `npx vitest run` →
  `Test Files 17 passed · Tests 324 passed`, **idéntico al baseline**. Ningún lote tocó `src/`.
- **Repo `dashboard-gen-gec3`:** `npm test` (vitest; ese `package.json` **no** lleva lista manual,
  descubre `__tests__/*.test.js` solo, y el gate **no lo tocó**) →
  `Test Files 16 passed · Tests 236 passed`, con los 5 casos nuevos de L01 adentro.
- **Baseline anterior:** 681/681 backend · 324/324 front (heredado del gate O2 de D-063, `9dfbbe3`).
  → **Sin degradación.** El backend sube a 701 corridos porque esta ola agregó exactamente 20 casos
  (8 de L02 + 12 de L03); el front queda igual; el rojo del stub es de la base y se cierra
  levantándolo.
- **Residuos en BD:** `npm run test:residuos` → **cero** (12/12 checks en 0, BD `PortalG3_dev`): sin
  filas en `'TST'`/`'TSR'` (registros, históricos, turnos, disponibilidad, `evento_dashboard`,
  consumos, `sis_scrape_log`), sin `TEST_TAG` en planta real, sin sesiones sintéticas activas, y
  `'TSR'` de vuelta en `activa = 0`.
- **`/code-review`** del diff de la ola (`5cc84a2..HEAD`, nivel high): ver §7.
- **`/security-review`:** el gate **no** corrió el pipeline completo; en su lugar hizo una pasada
  focalizada, porque la superficie de la ola es mínima y verificable a mano: **cero endpoints**
  nuevos o modificados, **cero** cambios en `permissions.js`, auth o sesiones, y el único SQL que
  recibe un dato de afuera es `saveDespachoRecibido`, **parametrizado**
  (`.input('fecha', sql.Date, …)`). Lo que sí se verificó a fondo, porque es lo que sostiene CA-11 y
  el diseño entero, es que **el marcador `origen_sistema` no es inyectable por HTTP** (hecho 5 de
  §6).

## 4. Criterios confirmados (solo lo que el gate vio en verde él mismo)

| CA | Propuesto por | Estado confirmado | Verificador corrido por el gate |
|---|---|---|---|
| **CA-2** (el texto literal) | L02 | **`cumple`** | `tests/asiento_despacho_xm.test.js` 8/8 ✔ (en el bloque 2 y en corrida aparte). Fija el texto calcado del F03 —sin punto final, sin prefijo de unidad, `G3.0`/`G3.2`— y que una fecha inválida **lanza** en los tres productores. |
| **CA-3** (una sola vez en el libro) | L03 | **`cumple`** | `tests/f03_despacho_xm.test.js` 12/12 ✔, más la no-regresión de `tests/f03_datos.test.js` 21/21 y `tests/f03_libro.test.js` ✔ dentro del bloque 2. |
| CA-1 (aparece en las dos Salas) | L01 | **`parcial`** — mitad de origen | `dashboard/__tests__/despachoscraper.test.js` ✔ (persiste la llegada). La otra mitad —las 4 filas que escribe Bitácora— es de **L04**. |
| CA-4 (un solo asiento) | L01 | **`parcial`** — mitad de origen | ✔ del lado del dashboard: dos ticks → una sola escritura, con guard estático de que el SQL es `INSERT … WHERE NOT EXISTS`, sin `MERGE`/`UPDATE`. La idempotencia del lado de Bitácora (`clave_asiento` en activo **e** histórico) es de **L04**. Ver decisión **D1**. |
| CA-7 (sin despacho no hay renglón) | L01 | **`parcial`** — mitad de origen | ✔ con el portal en 404 no se escribe nada y `getStateTomorrow()` sigue en `null`. La mitad de Bitácora es de L04. |
| CA-8 (degradación) | L01 | **`parcial`** — mitad de origen | ✔ el scraper no cae con la BD abajo ni sin la tabla (`Invalid object name`). La degradación del **lector** (tabla ausente → `[]`, log una vez) es de L04. |
| CA-12 (contrato cross-repo documentado) | integrador | **`parcial`** | `../docs/interfaces-cross-repo.md` ya trae el **Contrato 4** (commit `9756794` del umbrella, escrito **antes** de la O1) y su DDL coincide literalmente con el que implementó L01. El shape de `GET /api/eventos-dashboard` lo sigue fijando `tests/contrato_eventos_dashboard.test.js` ✔ (bloque 5). Se confirma entero en el cierre, cuando exista el lector. |
| CA-5, CA-6, CA-9, CA-10, CA-11 | — | **no aplican a esta ola** | Son de L04/L05 (O2). CA-11 se **verifica** allá, no se implementa: sale gratis de D-049. |

**Ningún CA quedó `bloqueado`.** Las cinco mitades `parcial` no son deuda: el plan las reparte así
desde el principio —la O1 son las tres raíces del grafo y nadie escribe filas hasta L04—.

## 5. Decisiones tomadas en este gate

### D1 — CA-4 también le pertenece a L01 (`LOTES.json` decía otra cosa)

- **Qué lo provoca:** lo señala el cierre de L01: `LOTES.json` le asigna `CA-1, CA-7, CA-8`, pero la
  tabla §5 de su propio prompt le suma **CA-4**. El lote implementó y verificó las cuatro.
- **Opciones:** a) dejar `LOTES.json` como está y contar CA-4 solo en L04 · b) reconocer la mitad de
  origen en L01 y dejar la otra mitad en L04 · c) mover CA-4 entero a L01. **Recomendada:** b.
- **Decidido: b.** CA-4 ("existe un solo asiento") tiene dos mitades reales y separadas: que el
  dashboard no escriba dos veces el hecho (verificado acá, con guard estático incluido) y que
  Bitácora no escriba dos veces el asiento (`clave_asiento` en `registro_activo` **y** en
  `registro_historico`, que es de L04). Contarlo solo en L04 borraría evidencia que ya existe;
  moverlo entero a L01 dejaría sin dueño la mitad que importa para el relleno del mes.
- **Qué cambia / qué NO cambia:** la tabla §4 registra CA-4 como `parcial`. **No** se edita
  `LOTES.json` para agregarlo (ese archivo solo se toca por `lotes.mjs`) y **no** cambia el alcance
  de L04, que ya lo tenía asignado.

### D2 — El hueco del scraper (BD caída justo en la detección) NO se arregla en esta ola

- **Qué lo provoca:** hallazgo H1 de L01 (§7). `#foundTomorrow = true` se pone **antes** de intentar
  la escritura, así que el tick siguiente ya no vuelve a pasar por ahí. Escenario: XM publica a las
  15:02, la BD está abajo de 15:00 a 15:30 y el servicio no se reinicia en lo que queda del día → la
  fecha nunca llega a `despacho_recibido`.
- **Opciones:** a) dejarlo y cubrirlo con el relleno del mes (L05) · b) separar el guard "archivo
  encontrado" del guard "hecho persistido" para reintentar cada 5 min · c) mover
  `#foundTomorrow = true` a después de la escritura. **Recomendada:** a.
- **Decidido: a**, y queda como deuda anotada en el ADR y en el runbook de despliegue. Razones:
  (i) **(c) es peor**: dejaría el scraper bajando el archivo de XM cada 5 minutos mientras la BD
  esté abajo, y mezcla dos estados que no son el mismo; (ii) **(b) le cambia el significado a
  `detectado_en`** —pasaría a ser la hora del reintento y no la de la publicación—, y eso es una
  decisión de contrato que no toma un gate a mitad de camino; (iii) la ventana exige que se junten
  tres cosas (BD caída + justo en ese instante + sin reinicio en todo el día) y ya tiene **dos**
  mitigaciones: cualquier reinicio antes de medianoche reintenta, y el relleno de L05 pone el
  renglón con `hora_estimada: true`, que es exactamente para lo que existe.
- **Qué cambia / qué NO cambia:** nada de código en esta ola. **L05 hereda un hecho** (§6, hecho 10):
  la ausencia de una fila **no prueba** que no llegó el despacho ese día. Sigue valiendo RN-05.d —sin
  evidencia no se inventa un día—, y es justamente por eso que el relleno no puede rellenar el mes a
  ciegas.

### D3 — H4 (`JSON_VALUE` con `campos_extra` corrupto) no se toca acá

- **Qué lo provoca:** hallazgo H1 del cierre de L03 (acá **H4**): una sola fila de Sala con
  `campos_extra` malformado tumba el libro del mes entero con `RequestError 13609`, porque
  `JSON_VALUE` lanza. Es **anterior a D-064** (llegó con D-058 y se universalizó en D-063).
- **Opciones:** a) arreglarlo en el gate con `ISJSON(...) = 0 OR JSON_VALUE(...) IS NULL` ·
  b) dejarlo documentado como deuda, con su corrección ya redactada · c) abrir un lote de corrección
  en la O2. **Recomendada:** b.
- **Decidido: b.** El arreglo es de una línea pero **cambia una semántica del libro** (una fila
  corrupta pasaría a *entrar* al F03 por el camino tecleado), y hoy no hay camino conocido para
  escribir esa fila: el `POST`/`PUT` genérico **descarta** todo `campos_extra` no declarado
  (`validateCamposExtra`, AUD-39) y las bitácoras de Sala tienen `definicion_campos = NULL`, así que
  tendría que entrar por SQL a mano. Meterlo en el gate mezclaría una corrección de D-058 con el
  diff de D-064 y le cambiaría el alcance a la ola sin verificación propia.
- **Qué cambia / qué NO cambia:** `f03-datos.js` queda como está. El hallazgo pasa al ADR y a la
  deuda del cierre, con la línea exacta ya escrita en el cierre de L03. Si aparece un camino que
  escriba `campos_extra` sin validar, sube de severidad y se atiende en su propio flujo.

### D4 — Tres defensas del colapso, arregladas en el gate (archivo compartido)

- **Qué lo provoca:** los hallazgos **R1, R2 y R3** del `/code-review`, los tres en `f03-datos.js`,
  que es un **archivo compartido** y por lo tanto territorio del gate. Los tres se verificaron
  contra el código antes de tocar nada, y los tres borran un renglón del libro **sin error ni log**
  —el peor modo de fallo posible en un formato controlado y firmado—.
- **Opciones:** a) dejarlos para un lote de corrección · b) arreglarlos acá, en el gate, y
  re-verificar los tres consumidores del libro · c) arreglar solo R2 (el más barato) y diferir el
  resto. **Recomendada:** b.
- **Decidido: b.** Son de un archivo compartido —la regla dice que ese es el gate—, ninguno cambia
  una firma ni un contrato, y los tres se verifican con las mismas suites que ya existen. Diferirlos
  significaba abrir la O2 con un libro que puede perder el asiento en un borde de mes.
- **Qué cambia:**
  1. **La agrupación se acota AL DÍA Bogotá** (`sys|<día>|<clave>`). La ventana de `armarMes` abre
     ±1 día y el recorte lo hace `porDia` **después** del dedupe: sin el día, una fila de la holgura
     ganaba el colapso y luego se descartaba, y el renglón no salía **ni en esa hoja ni en la del mes
     vecino**. Con el día, dos filas de la misma clave en días distintos salen cada una en su hoja:
     **duplicar es recuperable, perder el renglón no**.
  2. **La clave de sistema va prefijada `sys|`**, separada del `id|` de lo tecleado. `claveDeAgrupacion`
     devuelve *cualquier* `clave_asiento` (es genérica a propósito, para un segundo origen), así que
     una clave con la forma `id|4722` colisionaba con el registro tecleado 4722 y uno de los dos
     desaparecía en silencio.
  3. **`vistos.add` pasa a después del guard `if (asiento)`.** Si la fila de menor `registro_id`
     viniera con el `detalle` vacío, reservaba la clave y **silenciaba a sus tres hermanas**, que sí
     traen el texto. Ahora una fila muda no puede callar al asiento.
- **Qué NO cambia:** el camino tecleado (su clave sigue siendo `id|<registro_id>`, y su orden
  relativo es idéntico: el prefijo es constante), el filtro de reflejados de D-063, y el colapso
  normal de las cuatro filas —que comparten `fecha_evento`, o sea día, y por eso siguen colapsando—.
- **Re-verificación (el gate la corrió después del parche, bajo test-lock):**
  `tests/f03_datos.test.js` + `tests/f03_libro.test.js` + `tests/f03_despacho_xm.test.js` →
  `tests 56 · pass 56 · fail 0`; y los otros dos consumidores del libro,
  `tests/sala_de_mando_batch.test.js` + `tests/reflejo_disponibilidad.test.js` →
  `tests 98 · pass 98 · fail 0`. Residuos: cero. También se corrigió el `---` duplicado de
  `docs/decisions.md` (R4).

### D5 — Cinco correcciones menores: ¿lote L06 o gate? — **PENDIENTE DEL USUARIO**

- **Qué lo provoca:** los hallazgos **R5, R6, R7** (en `utils/asientos/sistema.js`, territorio de
  L02) y **R8, R9** (en `tests/f03_despacho_xm.test.js`, territorio de L03). Los cinco están
  verificados, ninguno es urgente y **ninguno cae en un archivo compartido**, así que la regla del
  gate manda lote de corrección, no arreglo acá.
- **Opciones:**
  - **a) Lote `L06` en la O2** —"correcciones del gate O1"—, con territorio
    `utils/asientos/sistema.js` + `tests/asiento_despacho_xm.test.js` + `tests/f03_despacho_xm.test.js`,
    **disjunto** de L04 y L05, corriendo en paralelo con ellos. Es lo que dice la metodología.
  - **b) Que el gate los aplique ya**, como hizo con R1-R4. Los chats de L02 y L03 están cerrados y
    ningún lote de la O2 toca esos tres archivos, así que el riesgo que la regla previene —pisarle el
    árbol a un chat vivo— no existe hoy. A cambio, `LOTES.json` no tiene verbo para agregar un lote
    ("nunca lo edites a mano") y crear un chat entero para cuatro arreglos de pocas líneas es caro.
  - c) Dejarlos como deuda del cierre.
  **Recomendada: b**, por el costo/beneficio y porque la herramienta no soporta (a) sin editar el
  JSON a mano; (a) es la ortodoxa y es enteramente razonable si prefieres trazabilidad por lote.
- **Decidido:** _pendiente del visto bueno_.
- **Qué se arreglaría, en cualquiera de las dos formas:** (R5) normalizar `hora_estimada` con la
  misma tabla de negaciones que usa `esHoraEstimada`, para que un `'false'` de un `JSON_VALUE` no
  marque como estimada una hora medida; (R6) `clave_asiento: claveAsientoDespacho(fecha)`, un solo
  productor del string de contrato; (R7) congelar los arrays exportados y fijar con un test el espejo
  contra `BITACORAS_REFLEJO`; (R8) `try/finally` que restaure el `seleccionable` pase lo que pase;
  (R9) derivar el último día del mes con `diasDelMes` y extender la limpieza a la holgura ±1.

## 6. Hechos que cambian lo que dicen los documentos anteriores

> Este bloque se copia **tal cual** al inicio de cada prompt de la O2 (L04 y L05).

1. **`utils/asientos/sistema.js` ya existe** y exporta las 7 del contrato C2 con los nombres y las
   firmas exactas. **Impórtenlo. No repliquen** la validación de fecha ni el armado de la clave.
2. **`claveAsientoDespacho(fecha)` LANZA `TypeError`** con fecha inválida —el contrato solo
   documentaba el `@throws` de `asientoDespachoXM`; L02 lo extendió y el gate lo confirma—, y
   `camposExtraDespacho` igual. Quien las llame con un dato que viene de afuera (el lector, el CLI)
   tiene que decidir qué hace con el throw: lo natural es **saltarse ese día y loguearlo**, nunca
   caerse.
3. **`camposExtraDespacho(...)` devuelve el objeto ya normalizado** y su `clave_asiento` es idéntica
   a la de `claveAsientoDespacho(fecha)` de la misma fecha: **búsquenla con esa función, no la armen
   a mano**. `esAsientoDeSistema` / `claveDeAgrupacion` / `esHoraEstimada` aceptan el objeto **o** el
   string crudo de la columna y **nunca lanzan**.
4. **El libro colapsa por `campos_extra.clave_asiento`, y una fila de sistema SIN esa clave NO se
   colapsa**: cae al desempate por `registro_id` y sale tantas veces como filas haya. **Ningún
   constraint lo impide** (H5). Si L04 escribe las 4 filas con el `campos_extra` armado a mano y una
   clave distinta, el libro imprime cuatro renglones y **nada falla**.
5. **El marcador no es inyectable por HTTP — verificado por el gate.** `validateCamposExtra`
   (`utils/campos.js`, AUD-39) construye el JSON **solo** con las claves declaradas en
   `lov_bit.bitacora.definicion_campos`, y `SALAJDT`/`SALAING` la tienen en **`NULL`** (reforzado en
   cada arranque por el `MERGE` de `db.js`), así que el `POST`/`PUT` genérico **descarta entero**
   cualquier `campos_extra` que un operador mande a una bitácora de Sala. Sumado al
   `seleccionable = 0` del tipo (F36.A1), nadie puede teclear a mano algo que finja venir del
   sistema. **L04 no tiene que agregar ninguna defensa nueva por este lado.**
6. **El tipo de evento existe y se llama exactamente `'Despacho económico'`** en `SALAJDT` y
   `SALAING`, `orden = 5`, `seleccionable = 0`, sembrado por `F36.A1` en las **dos** listas de
   `db.js` (el `INSERT` y el `UPDATE` complementario). Resuélvanlo por `(bitacora_id, nombre)` con
   `TIPO_EVENTO_DESPACHO_XM`, **nunca por id fijo**: los ids son distintos en cada BD (en
   `PortalG3_dev` se recrearon durante la verificación bidireccional de L03).
7. **`seleccionable = 0` también cierra el `POST`/`PUT` genérico** (sus dos lookups filtran
   `seleccionable = 1`): **L04 no puede** escribir el asiento por `POST /api/registros` aunque
   quisiera. Tiene que insertar directo, como ya hace `reflejo-sala.js`.
8. **El escritor del hecho es `saveDespachoRecibido(fechaDespacho)`** en
   `dashboard-gen-gec3/server/db.js` (`'YYYY-MM-DD'`; devuelve `true` solo si esa llamada creó la
   fila). La tabla se crea en el `initDB()` **de ese repo**, sin tabla de flags: **existe recién
   cuando `dashboard-gen-gec3` se despliegue y arranque en esta rama**. Hasta entonces la consulta
   de Bitácora falla con `Invalid object name`, que es **exactamente** el estado que C4 manda tratar
   como `[]` sin lanzar. Y eso **no es un caso raro**: durante toda la O2 va a ser el estado normal
   en `PortalG3_dev`, así que los tests de L04/L05 tienen que poder correr con la tabla ausente.
9. **`detectado_en` es hora BOGOTÁ** (`DEFAULT GETDATE()`, motor en Bogotá). La conversión a UTC va
   **una sola vez, en el lector** (`DATEADD(HOUR, 5, …)`), tal cual C4.
10. **La ausencia de una fila NO prueba que no llegó el despacho** (decisión D2 + H1): hay una
    ventana conocida en la que el hecho se pierde —BD caída justo en la detección, sin reinicio ese
    día—. **No cambia RN-05.d** (sin evidencia no se inventa un día), pero L05 no debe razonar al
    revés ("no hay fila ⇒ no hubo despacho ⇒ nada que hacer") como si la ausencia fuera una prueba.
11. **El libro imprime el `detalle` LITERAL** de las filas de sistema: un espacio de más, un punto
    final o un prefijo de unidad quedan tal cual en el formato controlado.
12. **Las 4 filas tienen que compartir `fecha_evento` exacta.** El colapso agrupa por día Bogotá —el
    gate lo acotó así en D4, antes valía para el mes entero y una fila en la holgura de ±1 día
    borraba el renglón—, y dentro del día gana la de menor `registro_id`. Si las cuatro no comparten
    el día, el asiento sale **dos veces** (una por día), que es feo pero recuperable; si además
    difieren en el texto o la hora, se imprime el de la fila de menor id y las otras se descartan sin
    aviso (R12). Es el mismo cuidado del gotcha (b) de D-058: **la fecha se decide una vez y se
    hereda**, nunca se recalcula por fila.

13. **Falta el guard de coherencia de las 4 filas, y te toca a ti (R12).** El libro imprime el
    `detalle` y la hora de **una** de las cuatro —la de menor `registro_id`— y descarta las otras
    tres sin avisar. Ningún constraint sostiene que las cuatro coincidan: es exactamente lo que
    D-056 (c) resolvió para los lotes de MAND con `verificarCoherenciaDeLotes()` en
    `sala_de_mando_batch.test.js`. **Escribe el guard equivalente en `tests/despacho_xm.test.js`**
    (mismo `detalle`, mismo `fecha_evento`, mismo `clave_asiento` en las cuatro) y **usa un solo
    instante de Node bindeado como parámetro** para las cuatro filas — nunca `GETDATE()`/`new Date()`
    por `INSERT`, que es la lección de D-063 (b) con `anulado.en`.

## 7. Hallazgos consolidados (deduplicados entre los tres cierres)

| # | Origen | Hallazgo | Severidad | Destino |
|---|---|---|---|---|
| **H1** | L01 | **El hecho se pierde si la BD está caída en el instante de la detección.** `#foundTomorrow = true` se pone antes de la escritura, así que el tick siguiente ya no vuelve a pasar. XM publica 15:02, BD abajo 15:00–15:30, sin reinicio ese día → la fecha nunca llega a `despacho_recibido`. | baja-media | **Deuda documentada** (decisión **D2**): no se arregla; mitigado por el reinicio y por el relleno de L05 con `hora_estimada`. Va al ADR y al runbook. |
| **H2** | L01 | **La degradación es silenciosa para el operador.** Si la tabla no existe, el único rastro es un `console.error` en `journalctl`; `/health/detailed` no dice nada. Bitácora desplegada antes que el dashboard → nadie ve el renglón ni una alarma. | baja | **Runbook del despliegue** (lo redacta el cierre): el orden es **dashboard primero**. Sin código. |
| **H3** | L02 | **Validar la fecha con `Date` sola produce el asiento con la fecha equivocada y ninguna excepción** (`new Date('2026-02-30')` → 2 de marzo, medido). Un asiento mal fechado se queda en un libro mensual firmado que nadie contrasta contra XM tres meses después. | alta *si se replica* | **Ya mitigado en el código** (regex + round-trip en `sistema.js`). Se convierte en el **hecho 2 de §6**: L04/L05 no replican la validación, llaman al módulo y manejan el `throw`. |
| **H4** | L03 | **Una sola fila de Sala con `campos_extra` malformado tumba el libro del MES ENTERO** (`JSON_VALUE` lanza, `RequestError 13609`; `registro_activo` no tiene CHECK `ISJSON`). Anterior a D-064 (D-058/D-063). | media-baja | **Deuda documentada** (decisión **D3**): la corrección de una línea ya está redactada en el cierre de L03; no se aplica acá porque cambia una semántica del libro y hoy no hay camino conocido para escribir esa fila (hecho 5 de §6). |
| **H5** | L03 | **Una fila de sistema sin `clave_asiento` no se colapsa, y ningún constraint lo impide**: el libro la imprimiría cuatro veces sin que nada falle. | media *para L04* | **Hecho 4 de §6** — enmienda en la cabecera del prompt de L04. La coherencia la sostiene `camposExtraDespacho`, igual que la metadata de un lote de MAND la sostiene su guard y no la BD (D-056 (c)). |
| **H6** | L02 | `esHoraEstimada` tolera `'true'`/`'1'` en texto, porque un `JSON_VALUE` devuelve nvarchar y ahí `Boolean('false')` daría `true`. | baja | **Cerrado en el código.** Queda como advertencia: no ramifiquen sobre un `JSON_VALUE` a mano; pasen por el predicado. |
| **H7** | **gate** | **El colapso del libro es global al mes y lo resuelve el `ORDER BY registro_id`**: si las 4 filas del asiento no comparten `fecha_evento` exacta, el renglón sale una sola vez —en la hoja de la fila de menor id— y las otras desaparecen **sin error**. Encontrado por el gate leyendo `eventosSala` (el `Set` de vistos es uno para todo el rango del mes). | media *para L04* | **Hecho 12 de §6** — enmienda en la cabecera de L04. No hay bug hoy: nace del diseño correcto (las 4 comparten fecha); es una trampa para quien escriba las filas. |

### Resultado del `/code-review` de la ola

Corrido sobre `5cc84a2..HEAD` en nivel `high`: **14 hallazgos**, que el gate verificó uno por uno
contra el código antes de aceptarlos. **Ninguno bloquea la ola**; tres se arreglaron acá porque caen
en archivos compartidos, cinco van a un lote de corrección, tres quedan como deuda documentada, dos
pasan a enmienda de la O2 y dos se rechazan con razón.

| # | Archivo | Hallazgo | Verificado | Destino |
|---|---|---|---|---|
| R1 | `f03-datos.js` | **El colapso cruzaba días.** `armarMes` abre la ventana **±1 día** y `eventosSala` deduplica **antes** de que `porDia` bucketee: una fila de la holgura con la misma clave ganaba el colapso y después se descartaba → el renglón desaparecía **de las dos hojas**. | ✔ (líneas 97-98 y 108-114) | **Arreglado en el gate** (D4) |
| R2 | `f03-datos.js` | **`vistos.add` iba antes del guard `if (asiento)`**: una sola fila del asiento con `detalle` vacío reservaba la clave y **suprimía a las otras tres**, sin log. | ✔ (el `add` estaba 21 líneas antes del `if`) | **Arreglado en el gate** (D4) |
| R3 | `f03-datos.js` | **El `Set` mezclaba dos espacios de nombres** (`id\|<n>` y la clave de agrupación, que es genérica): una `clave_asiento` con forma `id\|4722` se tragaba el registro tecleado 4722. | ✔ | **Arreglado en el gate** (D4) |
| R4 | `docs/decisions.md` | Dos `---` seguidos antes del apéndice, en el stub del ADR. | ✔ (líneas 1973-1975) | **Arreglado en el gate** (D4) |
| R5 | `sistema.js` | **`Boolean(hora_estimada)` convierte `'false'` y `'0'` en `true`**, contradiciendo a `esHoraEstimada` del mismo módulo, que los mapea a `false`. Marca una hora **medida** como inventada. | ✔ (la coacción está en el escritor; la tabla de negaciones solo en el lector) | **L06** (D5) |
| R6 | `sistema.js` | **`camposExtraDespacho` re-implementa la clave inline** en vez de llamar a `claveAsientoDespacho`: dos productores del mismo string de contrato, y el modo de fallo es el que la propia función documenta (buscar con una clave y escribir otra). | ✔ | **L06** (D5) |
| R7 | `sistema.js` | `BITACORAS_ASIENTO_SISTEMA` **duplica** `BITACORAS_REFLEJO` sin ningún guard que ate las dos listas (D-052 sí tiene uno para el espejo de nombres), y los arrays exportados no están congelados. | ✔ | **L06** (D5) |
| R8 | `tests/f03_despacho_xm.test.js` | El test **sube `seleccionable = 1` sobre la fila real del catálogo** y depende de que el `initDB()` siguiente lo revierta, **sin `try/finally`**: si el test falla, la BD se cae o se interrumpe la corrida, el tipo queda tecleable hasta el próximo arranque. Y ningún guard cubre DML sobre `lov_bit.tipo_evento`. | ✔ | **L06** (D5) |
| R9 | `tests/f03_despacho_xm.test.js` | `limpiarFixtures()` **hardcodea `'2026-03-31'`** (solo válido porque marzo tiene 31 días) y **no cubre la holgura ±1** que `armarMes` sí consulta. | ✔ | **L06** (D5) |
| R10 | `f03-datos.js` (SQL) | El filtro `JSON_VALUE(...'$.origen_bitacora')` **lanza 13609** con un `campos_extra` malformado y tumba el libro del mes; `eventosMand` **tiene el mismo hueco**. | ✔ | **Deuda** — es H4, decisión **D3**. El review confirma el diagnóstico y **amplía el alcance a `eventosMand`**. |
| R11 | `f03-datos.js` | **La rama literal se activa para CUALQUIER `origen_sistema`**, no solo `DESPACHO_XM`: un segundo origen de sistema **por unidad** perdería el prefijo `GEC3 — ` sin que nadie lo decida. "No lleva prefijo" es una propiedad del TEXTO, no de "viene del sistema". | ✔ (el predicado es genérico a propósito) | **Deuda / ADR.** Hoy no hay segundo origen. El día que lo haya, el dato tiene que viajar en la fila (p. ej. `sin_prefijo_unidad`), no inferirse del marcador. |
| R12 | `f03-datos.js` | **Falta el guard de coherencia de las 4 filas**, equivalente al `verificarCoherenciaDeLotes()` que D-056 (c) tiene para MAND: si las cuatro no coinciden en `detalle`/`fecha_evento`, el libro imprime las de la fila de menor id y descarta las otras sin avisar. | ✔ | **Enmienda a L04** (hecho 13 de §6): el guard va en `tests/despacho_xm.test.js`, que es su territorio. |
| R13 | `f03-datos.js` | Traer `r.campos_extra` (`NVARCHAR(MAX)`) entero para leer dos claves escalares. | ✔ | **Rechazado, con razón.** Es la desviación 1 del cierre de L03 y está bien argumentada: proyectar las rutas JSON en SQL las duplicaría en un segundo archivo (el drift de D-052 en versión JSON) y, hecho con `JSON_VALUE` desnudo, **reabre R10**. Las filas tecleadas traen `campos_extra` NULL. |
| R14 | `sistema.js` | Doble parseo del JSON por fila de sistema. | parcial | **Rechazado.** La medición no es exacta: `claveDeAgrupacion` llama a `esAsientoDeSistema` **con el objeto ya parseado**, y `comoObjeto` sobre un objeto no re-parsea — son 2 pasadas, no 3, y solo en filas con `campos_extra` no nulo. Ahorro nulo frente al costo de ensuciar el lazo. |

**Lo que la revisión verificó y está bien** (vale registrarlo): los commits van con la identidad
correcta y **sin firmas de IA**; `guard_marcador_reflejo` (Regla C) sigue satisfecho porque el filtro
`'$.origen_bitacora') IS NULL` no se tocó; `tipos_evento_espejo.test.js` no se rompe con el quinto
tipo porque filtra por `NOMBRES_ESPEJO`; los `DELETE` del test nuevo llevan su acotador de fixture
léxicamente junto al statement; y el Contrato 4 del umbrella ya está escrito.

## 8. Ola siguiente

- **Reparto:** O2 sigue siendo **L04** (lector + creador + sweeper, puerto 3104) y **L05** (CLI del
  relleno, puerto 3105, `depende_de: ["L04"]`, que el semáforo hace cumplir). La única variación
  posible es el **`L06` de correcciones** de la decisión **D5**, que espera el visto bueno: si el
  usuario lo prefiere como lote, se agrega a `PLAN-OLAS.md` y a `LOTES.json` antes de abrir la ola;
  si prefiere que el gate los aplique, la O2 queda con dos lotes y este expediente se enmienda
  encima. **`PLAN-OLAS.md` no se modificó todavía**, justamente porque esa decisión es del usuario.
- **Prompts enmendados en cabecera** (`ENMIENDA G1 — léela antes que el resto`, con los hechos de §6
  copiados tal cual): `L04-lector-creador-sweeper.md` y `L05-cli-relleno-mes.md`. Los dos llevan los
  14 puntos, incluidos el guard de coherencia que L04 tiene que escribir (R12) y el aviso de que
  `f03-datos.js` ya no es territorio de nadie.
- **Visto bueno del usuario:** pendiente.

## 9. Commit del gate

`415b6e8` `gate(D-064): O1 cerrada — 3 lotes, 700/700 backend, 324/324 front, 236/236 dashboard, 0 violaciones`
