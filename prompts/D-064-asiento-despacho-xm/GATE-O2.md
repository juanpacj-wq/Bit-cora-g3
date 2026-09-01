# D-064 — GATE-O2 (cierre de la ola O2)

> Expediente **inmutable** del gate. Lo escribe solo el integrador. Si algo de acá se revierte
> después, se enmienda encima ("REVERTIDA el … por …"), no se borra.
> Fecha: **2026-08-31 21:00** (Bogotá) · Rama: `feat/asiento-despacho-xm-2026-08` ·
> Subrepo: `Bit-cora-g3/` · Diff de la ola: `8790c23..HEAD` (9 archivos, +2.824 líneas).

## 1. Semáforo al cerrar

```
D-064 · rama feat/asiento-despacho-xm-2026-08

O1 [cerrada] gate: GATE-O1.md
  L01  done        L01-1057     Persistir la llegada del despacho (repo dashboard-gen-gec3)
  L02  done        L02-1057     Motor del asiento de sistema (puro)
  L03  done        L03-1057     Catálogo del tipo de evento (F36.A1) y colapso en el libro F03

O2 [abierta]
  L04  done        L04-1438     Lector del hecho, creador del asiento y barrido cada 5 min ← L01,L02,L03
  L05  done        L05-1537     CLI del relleno del mes (resumible, --dry-run) ← L04

test-lock: libre
```

**Lotes sin cierre commiteado: ninguno.** Los dos de la ola cerraron solos, con su
`cierres/LNN.md` en el mismo commit del código y un segundo commit `docs(…)` para estampar el SHA.
**Ningún lote quedó `in-progress` ni `blocked`**, así que el gate no tuvo que reconstruir nada ni
resolver un bloqueo: los dos cierres dicen "Bloqueos: ninguno" y los dos lo justifican nombrando los
contratos que consumieron y dónde los encontraron.

## 2. Territorios

```
L04 · 2 commit(s): 8863bf5 d8d7883
archivos tocados (6):
  prompts/D-064-asiento-despacho-xm/cierres/L04.md
  server/server.js
  server/tests/despacho_xm.test.js
  server/utils/despacho-xm/asiento.js
  server/utils/despacho-xm/lector.js
  server/utils/despacho-xm/sweeper.js

[lotes] territorio respetado
==========
L05 · 2 commit(s): 48fb08e e2ccdad
archivos tocados (3):
  prompts/D-064-asiento-despacho-xm/cierres/L05.md
  server/scripts/relleno-asiento-despacho.js
  server/tests/relleno_despacho_xm.test.js

[lotes] territorio respetado
```

**Violaciones: ninguna.** Y las dos abstenciones que el plan pedía se verificaron a mano, porque son
las que sostienen dos criterios enteros:

- **`server/middleware/permissions.js` está intacto en TODA la implementación**, no solo en la ola:
  `git diff --stat 5cc84a2..HEAD -- server/middleware/permissions.js` sale vacío. CA-11 sale de
  D-049, no de una excepción nueva.
- **`server/package.json` lo tocó el gate y nadie más.** L05 lo dice explícito en su cierre; la
  verificación de territorios lo confirma.
- **Lo que el gate SÍ escribió, además del expediente** (decisión **D4**, por el hallazgo R1):
  `server/db.js` (compartido, sin escritor en la O2 → territorio del gate),
  `server/scripts/relleno-asiento-despacho.js` y `server/tests/relleno_despacho_xm.test.js`. Los
  dos últimos son territorio de **L05**, ya cerrado: es la misma excepción que el GATE-O1 usó en
  sus decisiones D4 y D5 sobre territorios de L02 y L03, y va con su verificación bidireccional.
- **Autoría y firmas:** los 4 commits de la ola van con `juanpacj-wq <cjjuanpa@gmail.com>` como autor
  y committer, y el `grep` de `co-authored|claude|anthropic|generated with|🤖` sobre los cuerpos sale
  vacío.

## 3. Verificación de la ola (bajo test-lock `GATE-O2`)

- **Tests enganchados a `server/package.json`** (el gate es el único escritor):
  `tests/despacho_xm.test.js` **después de** `tests/registros_solo_autor.test.js` y
  `tests/relleno_despacho_xm.test.js` **inmediatamente después**, exactamente como pidieron los dos
  cierres (comparten las plantas-fixture, el desmonte de cabeceras `turno_unidad` y el marcador de
  limpieza; las fechas-fixture son de 1901 y 1902, así que no se pisan). **61 archivos** en el
  script; `zzz_session_leak_guard` sigue **último**.
- **Suite backend con el código de la rama**, contra un efímero `SERVER_PORT=3199
  AUTH_TEST_BYPASS=1` (BD `PortalG3_dev`), corrida **en bloques** porque la suite pasa de largo los
  ~20 min que sobrevive un proceso en background:

  | Bloque | Archivos | Resultado |
  |---|---|---|
  | 1 | guards disp/histórico, ws_origin, auth_bypass, entra_roles, catálogos, tipos espejo, split_sala, campos_validate, asientos, asientos_catalogo | `tests 104 · pass 104 · fail 0` (297 s) |
  | 2a | **asiento_despacho_xm**, reflejo_disponibilidad, f03_libro, f03_datos | `tests 68 · pass 68 · fail 0` (122 s) |
  | 2b | **f03_despacho_xm**, revalidate_gate, fechas_bogota, turno-entidad, auth_middleware | `tests 107 · pass 107 · fail 0` (268 s) |
  | 2c | auth_reactivate, disponibilidad, disponibilidad_anios, disponibilidad_reflejo_http | `tests 47 · pass 47 · fail 0` (290 s) |
  | 3a-1 | cierre_y_fechas, sala_de_mando_batch | `tests 90 · pass 90 · fail 0` (345 s) |
  | 3a-2 | conformacion_turno, consumos_combustible | `tests 35 · pass 35 · fail 0` (166 s) |
  | 3b | sis_endpoints, **sis_scrape_endpoint**, finalizar_turno, cambiar_unidad | `tests 53 · pass 47 · fail 1 · skipped 5` (309 s) |
  | 3c | registros_turno_id, registros_solo_autor, **despacho_xm**, **relleno_despacho_xm** | `tests 31 · pass 31 · fail 0` (308 s) |
  | 4 | turno_transicion, turno_seguimiento, históricos ×2, 3 guards de scripts, rol_coordinador, rol_usuario_consulta, sis_schema, sis_parser, sis_parser_hardening | `tests 82 · pass 82 · fail 0` (425 s) |
  | 5 | sis_discover/sweeper/lock/ownership/concurrencia, contrato_eventos_dashboard, http_hardening, errores, ia_cliente, ia_endpoint, **zzz_session_leak_guard** | `tests 107 · pass 107 · fail 0` (484 s) |
  | | **Total** | **724 corridos · 718 pass · 1 fail · 5 skipped** (~50 min) |

- **El único rojo es la MISMA deuda de la base que en el GATE-O1, no una regresión.** Es
  `sis_scrape_endpoint › CA-53. los casos HTTP no se saltean en silencio`: el `.env` no trae
  `SIS_HOST`, así que los 5 casos HTTP quedan en `skipped` y el guard de la convención 35 los delata
  a propósito. Relanzando ese archivo como el propio mensaje del guard indica —stub del SIS en 3154,
  `SIS_HOST` en el efímero **y** en `node --test`—:

  ```
  ℹ tests 10 · pass 10 · fail 0 · skipped 0    (tests/sis_scrape_endpoint.test.js, 66,9 s)
  ```

  → la suite backend queda en **724/724, sin rojos**.

- **La cuenta cierra contra el baseline, y el delta está explicado.** GATE-O1 registró **701**
  casos. Hoy hay **724**: `701 + 3 + 20`.
  - **+3** son de la propia O1, no de esta ola: el commit `7ac264e` (las correcciones D5 del
    GATE-O1) se hizo **después** de la corrida del gate anterior y agregó tres casos a
    `asiento_despacho_xm.test.js` — "el par de bitácoras es el mismo que el del reflejo (D-063)",
    "escribir y leer el flag no pueden divergir" y "la clave del `campos_extra` la produce
    `claveAsientoDespacho`". Ese archivo pasó de 8 a **11**. El GATE-O1 no llegó a contarlos.
  - **+20** son los de esta ola: **11** de `despacho_xm.test.js` y **9** de
    `relleno_despacho_xm.test.js`.
  - **Sin degradación:** ni un solo caso preexistente cambió de color.
  - **Y un `+1` posterior:** el arreglo del hallazgo R1 (decisión **D4**) agregó el caso 9 a
    `relleno_despacho_xm.test.js`, así que **el árbol que se commitea da 725**, no 724. La tabla de
    bloques de arriba es la del árbol previo al arreglo, que es cuando se corrió la suite entera.

- **Evidencia literal de los dos archivos nuevos**, dentro de la suite completa (bloque 3c):

  ```
  ✔ 1. crea los asientos con autor SISTEMA (CA-1)
  ✔ 2. idempotente ante repeticiones (activo e histórico) (CA-4)
  ✔ 3. solo GEC3 y GEC32 (CA-6)
  ✔ 4. sin hecho no hay asiento (CA-7)
  ✔ 5. degrada sin tabla (CA-8)
  ✔ 6. no toca Operación 24h (CA-9)
  ✔ 7. no republica al dashboard (CA-10)
  ✔ 8. no lo edita nadie, por autoría (CA-11)
  ✔ 9. el tick asienta cada hecho que lee, y repetirlo no duplica nada
  ✔ 10. la ventana del tick mira hacia adelante (el hecho de hoy anuncia MAÑANA) y dos días atrás
  ✔ 11. el sweeper NO arranca en un backend de test, y el apagado se anuncia

  ✔ 0. el recorrido del mes y la hora de la convención (piezas puras)
  ✔ 1. rellena los días pasados a las 15:00
  ✔ 2. no pisa la hora real
  ✔ 3. resumible e idempotente
  ✔ 4. dry-run no escribe
  ✔ 5. guardrail de BD equivocada
  ✔ 6. prefiere la hora real cuando el dashboard la tiene
  ✔ 7. --solo-con-hecho no inventa un día sin evidencia
  ✔ 8. la verificación de cierre se la pregunta a la BD, no al contador
  ```

- **El apagado del sweeper nuevo, medido en el arranque del efímero del gate** (es la evidencia
  operativa de H1 del cierre de L04, no una lectura del código):

  ```
  [mand-sweeper] iniciado
  [sis-sweeper] iniciado
  [despacho-xm] sweeper DESHABILITADO (AUTH_TEST_BYPASS=1 (backend de test: no escribe en plantas reales))
  [SERVER] Escuchando en puerto 3199
  ```

- **Front:** ningún lote tocó `src/` (`git diff --stat 8790c23..HEAD -- src/` vacío). Se corrió igual
  como no-regresión: `npm run build` ✔ (`built in 7.07s`) y `npx vitest run` →
  `Test Files 17 passed · Tests 324 passed`, **idéntico al baseline**.
- **Repo `dashboard-gen-gec3`:** no se tocó en esta ola (L01 fue de la O1) — no se volvió a correr.
- **Residuos en BD: cero.** `npm run test:residuos` → 12/12 checks en 0 sobre `PortalG3_dev`. Y la
  query que le corresponde a esta ola en particular, porque es la primera que tiene un escritor de
  filas, hecha **sin filtrar por planta** para que un escape a GEC3/GEC32 saliera a la luz:

  ```
  asientos DESPACHO_XM en TODA la BD: (ninguno, en ninguna planta)
  dashboard.despacho_recibido existe: false
  filas con campos_extra malformado (H4/H3): 0
  ```

  Y el respaldo estático: **las 11 llamadas a `crearAsientoDespacho` de los dos archivos de test
  inyectan `plantas`** con fixtures (`TST`/`TSR`). La contramedida estructural de D-061 no depende
  de que nadie se olvide.

- **Incidente de infraestructura, no del código** (queda registrado porque cuesta ~10 min de gate):
  el primer intento del bloque 3a murió con `Failed to connect to 192.168.17.20:1433 in 15000ms`
  después de tres archivos verdes; el efímero registró el mismo corte
  (`[turno-sweeper] error abriendo turno vigente GEC3 …`). Con la BD de vuelta (`SELECT DB_NAME()`
  en 0,8 s) los cuatro archivos corrieron **125/125**. `test:residuos` inmediatamente después de la
  interrupción dio **cero**: el corte no dejó basura. Es el mismo `ECONNRESET` que el GATE-O1 anotó
  contra el mismo host.

- **`/code-review`** del diff de la ola (`8790c23..HEAD`, nivel `high`): **4 hallazgos**, ver §7.
  **Uno de ellos (R1) obligó a corregir código en el gate**, así que la verificación tiene dos
  tramos y conviene decirlo con precisión:
  - **La tabla de bloques de arriba corrió sobre el árbol PREVIO al arreglo** (`48fb08e`).
  - **Después del arreglo** (decisión **D4**) se re-corrieron, bajo el mismo test-lock y contra un
    efímero nuevo en 3199: los **4 guards estáticos**, `catalogo_bitacoras`,
    `asiento_despacho_xm` → `tests 35 · pass 35 · fail 0`; y los **cuatro archivos de D-064**
    (`f03_despacho_xm`, `despacho_xm`, `relleno_despacho_xm`) más `zzz_session_leak_guard` →
    `tests 35 · pass 35 · fail 0`. Total re-verificado: **70/70**.
  - **Por qué eso alcanza, y no una segunda pasada completa de 50 min:** el arreglo son tres
    ediciones y ninguna cambia comportamiento fuera del CLI. En `db.js` se le agregó la palabra
    `export` a una función que ya existía y que se sigue llamando desde el mismo lugar — en ESM
    agregar un export no puede alterar la evaluación del módulo, y ningún guard estático lee
    `db.js` como texto (verificado). En el CLI, lo único que cambió de conducta es `main()`, que
    **solo corre cuando el script es el punto de entrada**: los tests lo importan detrás del guard
    `esPrincipal`, así que los únicos casos que lo ejercitan son el 5 (rechazo del `--confirm-db`)
    y el 9 (nuevo), los dos verdes. Que `db.js` sigue cargando y que `initDB()` sigue corriendo lo
    prueba el propio archivo de L05, cuyo `before` lo llama: **10/10**.
- **Residuos después del arreglo: cero** otra vez (12/12 checks) y `asientos DESPACHO_XM en TODA la
  BD: (ninguno, en ninguna planta)`.
- **`/security-review`:** el gate **no** corrió el pipeline completo, por la misma razón que en la
  O1 —la superficie es chica y verificable a mano— pero esta vez sí hay un escritor de filas, así
  que la pasada focalizada fue más larga y queda registrada:
  - **Cero endpoints** nuevos o modificados. **Cero** cambios en `permissions.js`, en `auth/` o en
    el manejo de sesiones (verificado por `git diff` sobre el rango de la ola).
  - **Todo el SQL con dato variable va parametrizado**: `lector.js` bindea `@desde`/`@hasta`
    (`sql.Date`); `asiento.js` bindea las nueve columnas del `INSERT` y la `@clave` de la
    idempotencia; el CLI bindea `@patron` y una `@pN` por planta. Las **dos** interpolaciones que
    existen (`listaDeCodigos()` en `asiento.js` y su gemela en el CLI) construyen el `IN (...)`
    desde `BITACORAS_ASIENTO_SISTEMA`, que es `Object.freeze(['SALAJDT','SALAING'])` — una constante
    del módulo de L02, no un dato de entrada, y congelada precisamente por R7 del GATE-O1.
  - **El apagado del sweeper en tests no puede voltearse desde producción.** `sweeperHabilitado()`
    delega en `bypassHabilitado(env)`, que es
    `env.AUTH_TEST_BYPASS === '1' && env.NODE_ENV !== 'production'`, y el módulo `middleware/auth.js`
    **aborta el proceso al cargar** si alguien arranca con el bypass encendido en producción
    (AUD-06). O sea: en producción el sweeper no puede quedar apagado por esta vía, y en test no
    puede quedar encendido por olvido.
  - **El marcador sigue sin ser inyectable por HTTP** (hecho 5 del GATE-O1): esta ola no agregó
    ningún camino nuevo hacia `campos_extra` de una bitácora de Sala.
  - **El guardrail del CLI corre antes de abrir el pool** (leído en `main()`): con la BD equivocada
    el proceso muere sin haber tocado una conexión.

## 4. Criterios confirmados (solo lo que el gate vio en verde él mismo)

| CA | Propuesto por | Estado confirmado | Verificador corrido por el gate |
|---|---|---|---|
| **CA-1** (aparece en las dos Salas) | L01 (origen) + L04 (destino) | **`cumple`** — las dos mitades cerradas | `tests/despacho_xm.test.js › 1` ✔ en la suite completa: las 4 filas (`SALAJDT`/`SALAING` × 2 unidades) con autor `SISTEMA`, texto literal y la hora de detección, más el guard de coherencia de las 4. La mitad de origen ya estaba verde en el GATE-O1. |
| **CA-4** (un solo asiento) | L01 (origen) + L04 (destino) | **`cumple`** — cierra el `parcial` del GATE-O1 (D1) | idem › 2 ✔, incluida la mitad que importa para L05: el asiento **ya archivado** en `registro_historico` devuelve `{creado:false, filas:0, motivo:'ya_existe'}`. |
| **CA-5** (relleno del mes) | L05 | **`cumple` — pero SOLO después del arreglo R1 (D4)** | `tests/relleno_despacho_xm.test.js › 1, 2, 3, 4` ✔: 15:00 con `hora_estimada: true`, no pisa la hora real, resumible e idempotente, `--dry-run` no escribe una sola fila. **Los cuatro verificadores estaban en verde también con el bug**, porque ejercitan `ejecutarRelleno` y no `main()`: el CLI real, corrido con el comando documentado, habría fallado los 31 días y escrito **cero** asientos. El gate lo reprodujo, lo arregló y agregó el caso 9, que lo fija desde un proceso hijo. Sin ese arreglo, CA-5 estaría `bloqueado`. |
| **CA-6** (solo GEC3 y GEC32) | L04 | **`cumple`** | idem `despacho_xm › 3` ✔ — `PLANTAS_DESPACHO` congelada, sin Guajiras. |
| **CA-7** (sin despacho no hay renglón) | L01 + L04 | **`cumple`** — las dos mitades cerradas | idem › 4 ✔: el tick sin hecho devuelve `{revisados:0, creados:0}`. |
| **CA-8** (degradación) | L01 + L04 | **`cumple`** — las dos mitades cerradas | idem › 5 ✔ contra la BD real, donde la tabla **de verdad no existe** hoy; el lector devuelve `[]`, loguea una vez y el tick completa. |
| **CA-9** (no toca Operación 24h) | L04 | **`cumple`** | idem › 6 ✔ — conteo de `MAND` antes y después, sin variación. |
| **CA-10** (no republica al dashboard) | L04 | **`cumple`** | idem › 7 ✔ — `evento_dashboard` y `disponibilidad_estado` intactos. |
| **CA-11** (nadie lo edita) | L04 | **`cumple`** | idem › 8 ✔ — `canEditarRegistro` en `false` para toda sesión, incluido ADMIN, y `PUT`/`DELETE /api/registros/:id` en 403, **con `permissions.js` intacto** (verificado por `git diff` sobre toda la implementación). |
| **CA-2**, **CA-3** | L02, L03 | **`cumple`** (ya confirmados en el GATE-O1) | Re-verificados en esta suite: `asiento_despacho_xm` **11/11** ✔ (bloque 2a, ahora con los 3 casos de D5) y `f03_despacho_xm` **12/12** ✔ (bloque 2b), más `f03_datos`/`f03_libro` sin regresión. |
| **CA-12** (contrato cross-repo documentado) | integrador | **`parcial`** → **cierre** | `../docs/interfaces-cross-repo.md` (Contrato 4) ya describe lector, cadencia, zona horaria y degradación, y el gate contrastó ese texto contra el código de L04: **coincide**. Lo que falta no es código sino documental — el bloque dice "Estado: **en implementación**" y el orden de despliegue todavía no está en el runbook. Lo cierra `/cerrar-implementacion`. |

**Ningún CA quedó `bloqueado`, y no queda ninguna mitad `parcial` de las de la O1**: CA-1, CA-4,
CA-7 y CA-8 tenían dueño en las dos puntas (decisión D1 del GATE-O1) y esta ola cerró la segunda.
El único `parcial` que sobrevive es CA-12, y su pendiente es una línea de documentación.

## 5. Decisiones tomadas en este gate

### D1 — La carrera entre el barrido y el relleno se cierra en el runbook, no en el código

- **Qué lo provoca:** H1 del cierre de L05 (y la sospecha 2 del de L04). El CLI recorre
  `[día 1, hoy]` y el sweeper barre `[hoy-2, hoy+1]`: **los tres últimos días los piden los dos**.
  `existeAsiento` corre dentro de la transacción pero sin `UPDLOCK`/`HOLDLOCK` (un lock de rango
  sobre un predicado con `JSON_VALUE` obligaría a escanear), son dos procesos distintos y ningún
  mutex los serializa → las dos transacciones pueden no verse y el día sale **duplicado**.
- **Lo que el gate midió antes de decidir, y que ninguno de los dos cierres dice:** el daño visible
  es **menor de lo que el hallazgo sugiere**. El colapso del libro agrupa por
  `sys|<día Bogotá de fecha_evento>|<clave>` (`f03-datos.js:365`, tal como quedó tras el arreglo D4
  del GATE-O1), y las dos tandas duplicadas comparten `clave_asiento` **y** `fecha_evento` — el
  relleno usa la hora real cuando el dashboard la tiene, que es justo el escenario del solape. Es
  decir: **el libro imprime UN renglón igual**, y las 4 filas de más quedan invisibles salvo que
  alguien lea la tabla. El único caso en que sí se ven dos renglones es si las dos detecciones caen
  en días Bogotá distintos (XM publicando pasada la medianoche contra la convención de las 15:00 del
  día anterior). *Esto es una lectura del código del colapso, no una medición: no se reprodujo la
  carrera.*
- **Opciones:** **a)** dejarlo en el runbook, como lo dejó L05 (la cabecera del script ya manda
  correrlo con el servicio detenido o con `DESPACHO_XM_SWEEPER_ENABLED=0`) · **b)** agregar
  `sp_getapplock @LockMode='Exclusive', @LockOwner='Transaction'` por `clave` dentro de
  `crearAsientoDespacho` — la edición exacta está escrita en §Bloqueos del cierre de L05 · **c)**
  abrir una O3 con un lote de corrección de una línea.
  **Recomendada: (a).**
- **Decidido: (a)** — *pendiente del visto bueno del usuario*. Razones, en orden: el relleno es una
  **pasada única** después del despliegue, no una rutina; el runbook ya dice cómo evitarlo; el daño,
  medido arriba, es 4 filas invisibles en el libro salvo en un borde de medianoche; y `asiento.js`
  es territorio de un lote **cerrado**, así que tocarlo acá cambiaría el comportamiento del sweeper
  después de que su verificador bidireccional ya corrió. (c) es desproporcionado para una línea.
- **Qué cambia / qué NO cambia:** no cambia código. **Cambia el ADR y el runbook**: el orden de la
  puesta en marcha pasa a ser una instrucción, no una recomendación. Y queda escrito el disparador
  que obligaría a reconsiderar (b): **si algún día corren dos procesos de Bitácora contra la misma
  base** (dos instancias tras nginx, un `node -e` a mano en paralelo), el applock deja de ser
  opcional, porque ahí ya no hay runbook que valga.
- **Enmiendas que produce:** entra al ADR D-064 como consecuencia, y al runbook del despliegue que
  redacta `/cerrar-implementacion`.

### D2 — No se abre una O3: la ola siguiente es el cierre

- **Qué lo provoca:** L04 y L05 son las **hojas del grafo** de `PLAN-OLAS.md` y no quedó ningún CA
  `bloqueado` ni ningún hallazgo que exija código.
- **Opciones:** **a)** cerrar acá y pasar a `/cerrar-implementacion D-064` · **b)** una O3 con un
  lote de corrección para D1 · **c)** una O3 para la deuda H4/R10 del GATE-O1 (el `ISJSON` faltante
  en `f03-datos.js`).
  **Recomendada: (a).**
- **Decidido: (a)** — *pendiente del visto bueno*. (b) queda descartado por D1. (c) sigue siendo
  deuda **anterior** a este ADR (viene de D-058/D-063, decisión D3 del GATE-O1) y meterla acá
  ampliaría el alcance de D-064 sin que nadie lo haya pedido; la corrección de una línea ya está
  redactada en `cierres/L03.md` para quien la tome. Lo que **sí** aporta esta ola es que el hueco
  tiene **dos** consumidores, no uno — ver el hecho 4 de §6.
- **Qué cambia / qué NO cambia:** `PLAN-OLAS.md` **no se modifica** (el reparto se cumplió tal cual:
  2 olas, 5 lotes, 2 gates). `LOTES.json` cierra O2 y no abre nada.

### D4 — El arreglo de R1 se aplica EN EL GATE, no en un lote de corrección

- **Qué lo provoca:** el hallazgo **R1** del `/code-review`, verificado y **reproducido** por el gate
  (ver §7). `main()` abría el pool con `getDB()` y nada más; los live bindings los resuelve
  `initDB()`, que en un script no corre, así que `USUARIO_SISTEMA_ID` quedaba en `null` y
  `crearAsientoDespacho` lanzaba en **cada** día del mes. Reproducción literal, sin escribir una
  fila (el `throw` ocurre antes de `transaction.begin()`):

  ```
  USUARIO_SISTEMA_ID tras getDB() sin initDB(): null
  LANZÓ: crearAsientoDespacho: USUARIO_SISTEMA_ID no inicializado (initDB no corrió)
  ```

- **Opciones:** **a)** arreglarlo en el gate con su test de regresión · **b)** abrir una O3 con un
  lote de corrección · **c)** dejarlo documentado en el runbook.
  **Recomendada: (a).**
- **Decidido: (a).** (c) está descartada de plano: no hay instrucción de runbook que resuelva esto
  —el binding es por proceso y el CLI **es** otro proceso—, así que documentarlo sería documentar
  que la herramienta no funciona. (b) es un gate completo por tres líneas, justo lo que D2
  descarta. Y hay **precedente en esta misma implementación**: el GATE-O1 aplicó nueve correcciones
  (D4 y D5) sobre `f03-datos.js`, `sistema.js` y dos archivos de test, todos territorios de lotes ya
  cerrados.
- **Qué cambia:** tres archivos.
  1. `server/db.js` — `resolverLiveBindings` pasa de privada a **exportada** (una palabra), con el
     porqué en el comentario. Es un **archivo compartido sin escritor en la O2**, o sea territorio
     del gate por `_CONTEXTO-BASE §8`.
  2. `server/scripts/relleno-asiento-despacho.js` — nueva `abrirPool()` exportada (`getDB()` +
     `resolverLiveBindings`), que `main()` usa en vez de `getDB()`.
  3. `server/tests/relleno_despacho_xm.test.js` — caso **9**, que corre `abrirPool()` en un
     **proceso hijo** y exige que el binding quede resuelto. El hijo es imprescindible: en el
     proceso del test `initDB()` ya corrió por `setupSessions()`, y por eso ninguno de los nueve
     casos existentes podía ver el bug.
- **Qué NO cambia:** **no se corre `initDB()` entero desde el CLI**. Un script de mantenimiento no
  debe aplicar DDL, seeds ni migraciones para conseguir dos enteros; `resolverLiveBindings` son dos
  `SELECT`, sin escritura, y lanza fuerte si el seed de `SISTEMA` no está. Es exactamente lo que ya
  hacía el camino `SKIP_INITDB=1` de `initDB()` desde el GATE-O1 de D-061.
- **Verificación bidireccional del propio arreglo** (la misma disciplina que se les pide a los
  lotes): con la llamada a `resolverLiveBindings` comentada, el caso 9 sale **rojo** con el mensaje
  que corresponde —`USUARIO_SISTEMA_ID quedó en null: el CLI abrió el pool sin resolver los live
  bindings y crearAsientoDespacho fallaría los 31 días del mes sin escribir nada`—; restaurado,
  el archivo entero da **10/10**.

### D3 — El `+3` del conteo no es un caso nuevo de esta ola, y queda dicho

- **Qué lo provoca:** la suite da 724 donde el GATE-O1 anotó 701 y esta ola agregó 20.
- **Decidido:** se registra en §3 con nombre y apellido de los tres casos y del commit que los trajo
  (`7ac264e`, las correcciones D5 del gate anterior, hechas **después** de su corrida). Sin esto, el
  próximo que compare baselines tiene que volver a averiguarlo. **El GATE-O1 queda enmendado de
  hecho: su cifra de "700/700" corresponde al árbol previo a sus propias correcciones.**

## 6. Hechos que cambian lo que dicen los documentos anteriores

> **No hay ola siguiente**, así que este bloque no enmienda prompts: se copia tal cual al arranque
> de `/cerrar-implementacion D-064`, que es quien escribe el ADR, `CLAUDE.md` 37, `BIT-MODBD` v2.7,
> `BIT-RF` v2.3/RF-078 y el REQ-05.

1. **El flujo está completo de punta a punta y verificado, pero NO está probado contra la tabla
   real, porque no existe.** `dashboard.despacho_recibido` sigue sin existir en `PortalG3_dev`
   (medido en este gate). El `SELECT` del lector nunca se ejecutó contra la tabla de verdad: se
   verificó (i) contra la BD real en su camino de degradación —`Invalid object name`, literal—,
   (ii) de forma determinista con un `pool` que rechaza la consulta, y (iii) con la mitad "la tabla
   existe" escrita y activa, que empieza a correr sola el día que el dashboard se despliegue. **Es
   lo primero del smoke.**
2. **El orden del despliegue es DASHBOARD PRIMERO, y ya no es una recomendación.** Con Bitácora
   arriba y el dashboard no, todo funciona exactamente como hoy —esa es la degradación pedida— pero
   el único rastro es **una sola línea** en `journalctl` (la latch de RN-05.c). Nadie va a notar que
   el renglón no sale. Y el relleno de L05 corrido antes que el dashboard deja el mes entero con
   hora estimada aunque las horas reales de los últimos días fueran a estar disponibles.
3. **Todo sweeper que escriba filas de operación nace apagado bajo `AUTH_TEST_BYPASS`, no solo
   detrás de un flag.** Es la segunda mitad de la lección de D-061 y hoy no está escrita en ninguna
   parte: `SIS_SWEEPER_ENABLED` existía y el daño ocurrió igual, porque el apagado dependía de que
   alguien se acordara. `sweeperHabilitado()` lo invierte —apagado por defecto en cualquier proceso
   con el backdoor de test, encendido en producción, y el motivo **siempre** anunciado en el log—.
   **Candidata firme a convención 37 de `CLAUDE.md`.** Su corolario: la lista de plantas de un
   escritor automático es un **parámetro inyectable**, no una constante alcanzable solo por su
   `default`.
4. **El hueco del `campos_extra` malformado (H4 del GATE-O1) tiene DOS consumidores, no uno.** Se
   documentó como "tumba el libro del mes"; L04 mostró que también alcanza a `existeAsiento`, y ahí
   el efecto es peor en carácter: **ningún** asiento se podría escribir nunca más, con el sweeper
   logueando el error cada 5 minutos y el renglón simplemente sin aparecer. L04 lo mitigó en su lado
   (`ISJSON(campos_extra) = 1` antes de cada `JSON_VALUE`, en las dos consultas del creador; medido:
   sin el guard la consulta muere). `f03-datos.js` **sigue sin el guard** (deuda D3 del GATE-O1,
   confirmada acá). Hoy hay **0 filas malformadas** en `PortalG3_dev`.
5. **Un backfill "terminó" cuando una consulta lo dice, y esa consulta tiene que mirar las MISMAS
   dos tablas que la idempotencia.** La convención 35 ya trae la primera mitad (para el SIS); L05
   agrega la general: si el reporte de cierre solo mira `registro_activo`, declara faltantes los
   días que el cierre de turno ya archivó, y alguien los "rellena" de nuevo. Corolario para el ADR:
   *un CLI que escribe en plantas reales se prueba por sus funciones exportadas con la lista de
   plantas inyectada; de su `main()` solo se ejercita el camino de rechazo del `--confirm-db`.*
6. **El asiento del día 1 de un mes sale en el libro del mes ANTERIOR, y es correcto.** Su
   `fecha_evento` es la tarde del último día del mes previo, porque ahí ocurrió la detección. El
   libro F03 ordena por hora de calendario del evento (D-058 gotcha (b)), así que el renglón aparece
   en esa hoja. Contraintuitivo para quien audite ("corrí el relleno de septiembre y el día 1 no
   está") y **vale una línea en el runbook**.
7. **La marca `hora_estimada` no se pinta en ningún lado y el texto del asiento es idéntico**, así
   que un día que XM nunca publicó queda indistinguible de uno real salvo por
   `campos_extra.hora_estimada` y por la línea "OJO: N asiento(s) quedaron con HORA ESTIMADA" de la
   salida del CLI. Aceptable para una pasada única de puesta al día —para eso existe— y **no** para
   una rutina mensual. La contramedida disponible es `--solo-con-hecho` (la lectura estricta de
   RN-05.d); la de fondo es que el sweeper ya cubre los días nuevos y el relleno no debería volver a
   hacer falta.
8. **La `fecha_evento` del relleno cae fuera de la ventana del turno abierto y eso está bien, pero
   no se verificó end-to-end.** El creador resuelve `turno_id` del turno ABIERTO al momento de
   escribir (puntero de archivado, D-045 / D-058 (c)), no del que le tocaría a la hora del evento
   —que para un día de hace tres semanas ya está cerrado—. Con `turno_id = NULL` las levanta el
   rescate de huérfanos de D-063 (D6), así que los dos caminos están cubiertos por diseño, pero
   **que el próximo cierre de turno real las archive** no se pudo ejercitar sin escribir en planta
   real. **Es lo segundo del smoke**, después de la lectura de la tabla del dashboard.
9. **El hueco del origen sigue abierto y decidido así** (D2 del GATE-O1): si la BD está caída en el
   instante de la detección, el hecho de ese día se pierde, porque `#foundTomorrow` se prende antes
   de escribir. **La ausencia de una fila no prueba que no llegó el despacho** — que es exactamente
   por qué el relleno de L05 asienta por defecto todos los días del mes.
10. **Un proceso que no es el server no tiene live bindings, y `getDB()` no se los da.**
    `USUARIO_SISTEMA_ID` y `COMB_BITACORA_ID` los resuelve **solo** `initDB()`; un script que abra
    el pool con `getDB()` y escriba con autor SISTEMA lanza en cada intento. Peor: si el script
    aísla el fallo por ítem —como manda la buena práctica de los backfill— el error **no sube**, se
    convierte en un contador de `fallidos` y la corrida termina con un resumen de ceros en vez de
    con un error de arranque. La forma correcta es `resolverLiveBindings(pool)` (dos `SELECT`, sin
    escritura, exportada desde este gate), **no** `initDB()` entero: un script de mantenimiento no
    aplica DDL, seeds ni migraciones. **Candidata a `CLAUDE.md` junto con el hecho 3.** Y la lección
    de test que viene pegada: **un harness que llama a `initDB()` en su `before` no puede ver este
    bug jamás** — hace falta un proceso hijo. Ver decisión **D4** y hallazgo **R1**.
11. **El único guard del CLI contra la BD equivocada es `--confirm-db`, y el `--dry-run` no prueba
    que el camino real funcione.** El ensayo nunca llega al escritor: pasó limpio durante todo el
    lote con el CLI roto. Al desplegar, "el dry-run salió bien" **no** es evidencia de que el
    relleno vaya a escribir; la evidencia es la línea final —`no queda ningún día del mes sin
    asiento`— y el conteo en la BD.

## 7. Hallazgos consolidados (deduplicados entre los cierres y la revisión)

### De los cierres de lote

| # | Origen | Hallazgo | Severidad | Destino |
|---|---|---|---|---|
| **H1** | L04 | **Un sweeper que escribe filas de operación, arrancando en cada backend efímero.** El día que el dashboard se despliegue contra la misma base, cada corrida de `npm test` habría dejado 4 filas por día-hecho en `SALAJDT`/`SALAING` de GEC3 y GEC32, con autor SISTEMA, y una vez archivadas por el cierre de turno serían imborrables (RF-032). | alta *si no se cierra* | **Cerrado en el propio lote** (`sweeperHabilitado` derivado de `bypassHabilitado`), verificado por el gate en el log de arranque del efímero. La lección general va al **hecho 3 de §6** → `CLAUDE.md` 37. |
| **H2** | L04 | El `guard_no_prod_historico_destruction` marca como no acotado un `DELETE` que sí lo está, cuando va pegado a un `INSERT … SELECT` largo en el **mismo** `request()` (el acotador queda fuera de la ventana de 700 caracteres). | baja | **No se toca: es el comportamiento correcto.** La salida es partir en dos `request()`, no ensanchar la ventana. L05 lo aplicó antes de tropezar. Queda como nota de proceso. |
| **H3** | L04 | El hueco del `campos_extra` malformado alcanza **también** a `existeAsiento`, no solo al libro. | media-baja | **Mitigado en L04** (`ISJSON = 1` en las dos consultas del creador). Amplía H4 del GATE-O1 → **hecho 4 de §6**. `f03-datos.js` sigue en deuda (D3 del GATE-O1). |
| **H4** | L05 | **El relleno y el barrido se solapan tres días y ninguno toma lock de rango** → un día podría salir duplicado. Es la sospecha 2 de L04, dejada de ser hipotética. | baja | **Runbook** — decisión **D1**, con la medición del gate de que el colapso del libro absorbe el duplicado salvo en el borde de medianoche. |
| **H5** | L05 | El asiento del **día 1** del mes sale en el libro del mes **anterior**. Correcto y contraintuitivo. | baja / documental | **Hecho 6 de §6** → runbook. Fijado por el caso 1 y por la cabecera del script. |
| **H6** | L05 | El relleno declara "terminado" un mes donde un día quedó asentado **sin que hubiera despacho**, y nada lo distingue salvo `hora_estimada`. | media *si se volviera rutina* | **Hecho 7 de §6** → ADR + runbook. Contramedida disponible: `--solo-con-hecho`. |

### Resultado del `/code-review` de la ola

Corrido sobre `8790c23..HEAD` en nivel `high`: **4 hallazgos**, los cuatro verificados por el gate
contra el código antes de aceptarlos. **Uno era bloqueante** y se arregló acá; los otros tres son
`LOW` y quedan documentados.

| # | Archivo | Hallazgo | Verificado | Destino |
|---|---|---|---|---|
| **R1** | `scripts/relleno-asiento-despacho.js` | **HIGH — el CLI nunca resuelve `USUARIO_SISTEMA_ID`, así que la corrida real falla los 31 días y escribe cero asientos.** `main()` hacía `getDB()` a secas; el binding lo resuelve solo `initDB()`, que en un script no corre. El `try/catch` por día convierte el error en `fallidos` y la salida es un resumen de ceros con exit 1, no un error de arranque. El `--dry-run` pasa limpio porque nunca llega al escritor, y los 9 casos del lote tampoco lo ven porque el harness llama a `initDB()` en su `before`. | ✔ **reproducido** en un proceso limpio: `USUARIO_SISTEMA_ID … null` → `LANZÓ: … initDB no corrió` | **Arreglado en el gate** (decisión **D4**) + caso 9 de regresión, rojo con la ruptura y verde restaurado. |
| **R2** | idem, `clavesPresentes` | **LOW — la verificación de cierre está acotada por planta y la idempotencia del creador NO.** `existeAsiento` busca la `clave_asiento` en **todas** las plantas; `verificarMes` solo en las suyas. Si existiera una fila con la misma clave en otra planta, `crearAsientoDespacho` diría `ya_existe` mientras `verificarMes` seguiría listando el día como faltante → "quedaron días sin asiento", exit 1, y **repetir el comando nunca converge**. | ✔ la asimetría es real | **Deuda documentada.** Hoy no puede dispararse: las fechas-fixture son de 1901/1902 y el CLI solo trabaja el mes en curso, así que no hay clave que pueda coincidir. Arreglarlo exigiría cambiar el contrato C3 (idempotencia global, a propósito) o romper la inyección de `plantas` de `verificarMes`; ninguna de las dos vale por un caso imposible hoy. **Va al ADR** como el sitio exacto a mirar si alguien amplía el alcance a meses pasados. |
| **R3** | idem, línea 177 | **LOW — el `_` de `DESPACHO_XM` es un comodín de `LIKE`.** El patrón `DESPACHO_XM\|${mes}-%` también matchea `DESPACHO?XM\|…`. | ✔ | **Deuda cosmética.** No se toca: hoy existe una sola familia de claves, y cambiar el `LIKE` dejaría la conducta nueva sin verificador propio (los tests usan claves literales, que matchean igual antes y después). Se anota para el día que haya un segundo `origen_sistema` — que es el mismo día que dispara R11 del GATE-O1. |
| **R4** | `utils/despacho-xm/sweeper.js` | **LOW — `stopDespachoXMSweeper()` no detiene un tick en vuelo:** el `finally` del `tick` reprograma el timer incondicionalmente. | ✔ y **es la casa**: `sis-sweeper.js` tiene el mismo patrón | **Deuda documentada.** Inocuo hoy: el único llamador es el `SIGTERM`/`SIGINT` de `server.js`, que hace `process.exit(0)` en la línea siguiente, y ningún test arranca este sweeper. Pero **este es el único sweeper que escribe filas de operación**, así que un timer filtrado costaría más caro que en los otros: si algún día algo más llama a `stop`, la corrección es un `let vivo = false` chequeado en el `finally`. **Va al ADR.** |

**Lo que la revisión verificó y está bien** (vale registrarlo, porque es la mitad del valor de la
pasada): la conversión Bogotá→UTC ocurre **exactamente una vez** (`lector.js`, `DATEADD(HOUR,5,…)`,
con `useUTC:true` por defecto y sin override en `db.js`); `detectadoEnEstimado` cae en las 15:00
Bogotá del día D-1 **incluido el borde del día 1 del mes**, por la normalización con `Date.UTC`;
`periodoFromFechaBogota`/`turnoFromPeriodo` dan turno 1 para ese instante; `correrDias` es
UTC-safe; la lista de columnas del `INSERT` coincide con la de `reflejo-sala.js`;
`resolverTurnoAbierto(transaction, …)` es una llamada válida (`Transaction.request()` existe en
`mssql` y `reflejo-sala.js` la usa igual); y el guard `esPrincipal` impide que importar el CLI lo
ejecute.

## 8. Ola siguiente

- **No hay ola siguiente.** La O2 cierra el grafo: `PLAN-OLAS.md` preveía 2 olas, 5 lotes y 2 gates,
  y así salió. No se enmienda ningún prompt (no hay a quién) y **`PLAN-OLAS.md` no se modificó**.
- **Lo que sigue es `/cerrar-implementacion D-064`**, con este trabajo por delante:

  | Entregable | Reserva | Fuente |
  |---|---|---|
  | ADR **D-064** completo en `docs/decisions.md` (hoy hay un stub) | `D-064` | Los 4 bloques "Aporte al ADR" de los cierres + §5 y §6 de los dos gates |
  | `CLAUDE.md` convención **37** | 37 | Hecho 3 de §6 (sweeper apagado bajo bypass) + hecho 5 (el backfill y sus dos tablas) + hecho 10 (los live bindings de un script que no es el server) |
  | `BIT-MODBD-2026-001.md` **v2.7** | v2.7 | `dashboard.despacho_recibido`, el tipo `F36.A1`, el `campos_extra` del asiento |
  | `BIT-RF-2026-001.md` **v2.3**, requisito **RF-078** | v2.3 / RF-078 | RQ-05.* |
  | `REQ-05` actualizado | — | Desviación D1 de planeación: **cuatro** filas, no dos |
  | `docs/interfaces-cross-repo.md` (umbrella) | — | Quitar "Estado: en implementación" y agregar el orden de despliegue (hecho 2) → cierra **CA-12** |
  | Runbook del despliegue | — | Hechos 1, 2, 6, 7, 8 de §6 + los comandos del relleno del cierre de L05 |
  | `git rm` del scaffolding `prompts/D-064-asiento-despacho-xm/` | — | Metodología |

- **Deudas que el ADR tiene que nombrar** (ninguna toca código en esta ola): R2 (la verificación de
  cierre acotada por planta contra una idempotencia global — el sitio a mirar si alguien amplía el
  relleno a meses pasados), R3 (el `_` comodín, hermano de R11 del GATE-O1), R4
  (`stopDespachoXMSweeper` no corta un tick en vuelo) y la que viene de la O1: H4/R10, el `ISJSON`
  que le falta a `f03-datos.js`.
- **Y el otro repo:** `dashboard-gen-gec3` tiene su propia rama `feat/asiento-despacho-xm-2026-08`
  con L01 adentro. El cierre tiene que decidir cómo se integran las dos, y el despliegue **empieza
  por ahí**.
- **Visto bueno del usuario:** pendiente.

## 9. Commit del gate

`{{sha}}` `gate(D-064): O2 cerrada — 2 lotes, 724/724 backend, 324/324 front, 0 violaciones, 1 hallazgo bloqueante arreglado`

Archivos del commit: `server/package.json` · `server/db.js` ·
`server/scripts/relleno-asiento-despacho.js` · `server/tests/relleno_despacho_xm.test.js` ·
`prompts/D-064-asiento-despacho-xm/{ESTADO.md, GATE-O2.md, LOTES.json}`.
