# D-065 — ESTADO (tablero por olas)

> Lo escribe **solo el integrador** (fase 2 y cada gate). Los lotes NO lo tocan: su estado vive en
> `cierres/LNN.md` y en `LOTES.json`. Este archivo es corto a propósito: el detalle está en los
> cierres y en los `GATE-On.md`.

## Tablero

| Ola | Lote | Título | Estado | Cierre | Gate |
|---|---|---|---|---|---|
| O1 | L01 | Motor puro del patrón de rotación | ✅ | `cierres/L01.md` | — |
| O1 | L02 | Schema `F37.A1` + flag de cargo `F37.A2` | ✅ | `cierres/L02.md` | — |
| O1 | L03 | Cliente de Graph y sincronización del directorio | ✅ | `cierres/L03.md` | — |
| — | **GATE-O1** | 3 lotes · 781/781 backend · 324/324 front · 0 violaciones | ✅ | | `GATE-O1.md` |
| O2 | L04 | Endpoints de configuración anual | ✅ | `cierres/L04.md` | — |
| O2 | L05 | Toma de control del rol (backend) | ✅ | `cierres/L05.md` | — |
| O2 | L06 | Cumplimiento y congelado al cerrar | ✅ | `cierres/L06.md` | — |
| O2 | L11 | Correcciones de la O1 (abierto por el GATE-O1, D5) | ✅ | `cierres/L11.md` | — |
| — | **GATE-O2** | 4 lotes · 861/861 backend · 324/324 front · 0 violaciones | ✅ | | `GATE-O2.md` |
| O3 | L07 | Pantalla de configuración anual | ✅ | `cierres/L07.md` | — |
| O3 | L08 | Popup de toma de control | ✅ | `cierres/L08.md` | — |
| O3 | L09 | Vista de cumplimiento | ✅ | `cierres/L09.md` | — |
| O3 | L12 | Correcciones de la O2 (abierto por el GATE-O2, D5) | ✅ | `cierres/L12.md` | — |
| — | **GATE-O3** | 4 lotes · 894/894 backend · 392/392 front · 0 violaciones | ✅ | | `GATE-O3.md` |
| O4 | L10 | Cableado en el componente raíz y rutas hash | ⬜ | — | — |
| O4 | L13 | Correcciones de la O3 (abierto por el GATE-O3, D5) | ⬜ | — | — |
| — | **GATE-O4** | | ⬜ | | `GATE-O4.md` |
| Cierre | — | ADR D-065 + `CLAUDE.md` 38 + BIT-MODBD v2.8 + BIT-RF v2.4/RF-079 + `git rm` | ⬜ | | |

Leyenda: ⬜ pendiente · 🟡 en curso · ✅ done (lote) / cerrada con visto bueno (ola) · ⛔ bloqueado.
La verdad operativa es `lotes.mjs status`; esta tabla es la foto que deja cada gate.

## Baseline de la suite

| Momento | Resultado | Duración |
|---|---|---|
| Rama base `feat/integrar-asientos-D-059` (heredado de GATE-O2 de D-063, `9dfbbe3`, 2026-08-29) | backend **681/681** · front **324/324** · 0 violaciones | ~40 min backend |
| Antes de O1 (medición propia) | no se corrió — el GATE-O1 la sustituye (ver nota abajo) | |
| **GATE-O1** (2026-09-01, server efímero `:3199`, `PortalG3_dev`) | backend **781/781** · front **324/324** · build ok · 0 violaciones · 0 residuos | ~44 min backend (12 bloques) · 50 s front |
| **GATE-O2** (2026-09-01, server efímero `:3199` sin credencial de Graph y con stub del SIS, `PortalG3_dev`) | backend **861/861** · front **324/324** · build ok · 0 violaciones · 0 residuos (20 checks) | ~76 min backend (16 bloques) · 65 s front |
| **GATE-O3** (2026-09-02, server efímero `:3199` sin credencial de Graph y con stub del SIS, `PortalG3_dev`) | backend **894/894** · front **392/392** · build ok · 0 violaciones · 0 residuos (20 checks) | ~70 min backend (16 bloques) · 18 s front |
| GATE-O4 | | |

> **El baseline de la O4 es 894, y esta vez la resta cuadra sola.** `894 − 861 = 33` = los 27 casos
> del archivo nuevo de L12 + los 3 que ganó `rotacion_control` al rehacer el verificador negativo de
> CA-11 + los 3 que agregó el propio GATE-O3 a `http_hardening`. Sin ajustes a mano y sin residuo.
> En el front, `392 − 324 = 68` = L07 (12) + L08 (30) + L09 (26). **Ojo con una cifra que engaña:**
> el `npm run build` de la O3 salió verde pero **no compiló las tres pantallas nuevas** — nadie las
> importa hasta que L10 las cablee, así que Rollup no las mete al grafo. Quien las compila es vitest.

> **El 861 del GATE-O2 y el 781 del GATE-O1 no se restan directo.** Los cuatro archivos nuevos de la
> O2 aportan 78 casos medidos (21 + 14 + 13 + 30), o sea 783 preexistentes contra los 781 que reportó
> el gate anterior. Esos **+2 no son tests nuevos: son la aritmética a mano del GATE-O1**, que midió
> sin el stub del SIS y ajustó la cifra dos veces (−1 por el archivo del SIS remedido, +1 por el caso
> que él mismo agregó a `errores.test.js`). El GATE-O2 midió los 68 archivos en una sola condición,
> así que 861 es medición directa y **el baseline de la O3 es 861**.

> **Por qué el baseline propio quedó pendiente y no es una omisión:** al cerrar la fase 2 (2026-08-31
> 21:30 Bogotá) había una sesión de `/cerrar-implementacion D-064` corriendo la suite completa en el
> árbol principal, con el **test-lock tomado** (`CIERRE-D064`, TTL 45 min). Correr la suite en
> paralelo la habría contaminado. El baseline heredado de D-063 es el punto de comparación válido
> —la rama base no ha cambiado desde ese gate salvo dos commits de `docs/`— y el GATE-O1 establece
> la medición propia bajo el lock.

## Hechos descubiertos (acumulado, breve)

- **Fase 2:** la cuadrilla OPS del Excel **cambia todos los meses** (69 de 308 celdas al año);
  la de ING no cambia ni una vez en 12. De ahí sale el modelo de asignación con vigencia.
- **Fase 2:** Entra ID ya aporta **persona + rol** para 81 personas en roles de rotación; lo único
  que falta es el grupo G1–G4. La cuadrilla del Excel calza en 71 de 81.
- **Fase 2:** el desfase **no se puede derivar de `grupo_t1` solo** — `V1` toma 4 valores distintos
  en 8 índices. Hacen falta los grupos de T1 **y** T2 del día de inicio.
- **Fase 2:** el grupo de Entra `ADMINISTRADOR Y DEBUGGING` está **vacío**, y es uno de los dos
  cargos que podrán configurar la malla. Hoy el único que puede usar la superficie A es el
  Gerente de Producción. Va al runbook del cierre.
- **O1 (L01):** el oráculo del Excel **no distingue** la aritmética de fechas correcta de la frágil —
  con `new Date(str)` los 1.460 pares pasan igual, porque el offset se cancela en los dos extremos.
  Lo que protege es el **parsing estricto**, no el oráculo.
- **O1 (L02):** un flag de cargo se agrega en DOS sitios y en ESE orden — el `ALTER` idempotente en la
  sección de catálogos (antes del MERGE) y el valor DENTRO del MERGE. Invertirlo no rompe la migración:
  rompe el arranque. Y el `ALTER` de un flag **no puede** registrarse en `migracion_aplicada` (esa tabla
  la crea `F16.A0` ~1.100 líneas más abajo).
- **O1 (L03):** el tenant tiene una **asignación directa de usuario** (Gerente de Producción) además de
  los 13 grupos; `appRoleAssignedTo` no da de ella el UPN, hace falta un `GET /users/{id}`. Y
  `personas.length` (89) **no** es la suma de `grupos[].miembros` (90): el Gerente está también en
  `USUARIO_CONSULTA` y `PRECEDENCE` lo deduplica.
- **O1 (GATE, `/code-review`):** el `MERGE` de la sincronización pisa `azure_upn` con `NULL` cuando
  Graph no devuelve UPN, y en el **siguiente arranque** `enforceSingletonFlag` degrada al Jefe de
  Planta a `0`. Es el hallazgo más serio de la ola (CR-1) y no lo veía nadie: los dos extremos están
  a 3.000 líneas de distancia en archivos distintos.
- **O1 (GATE, medido contra la BD):** un `CHECK (grupo BETWEEN 1 AND 4)` sobre una columna NULLABLE
  **acepta `NULL`** (evalúa a `UNKNOWN`, y un CHECK solo rechaza el `FALSE`). La razón por la que L02
  dejó `rotacion_cumplimiento.grupo` sin constraint era falsa: se podían tener las dos cosas.
- **O1 (GATE, `/security-review`):** cero hallazgos. El `MERGE` matchea **solo** por `azure_oid`, y su
  rama `WHEN MATCHED` es estrictamente más estrecha que la de `provisionEntraUser`. El bearer de
  Graph está anclado por host con la barra final (`'https://graph.microsoft.com/'`), lo que corta el
  `@odata.nextLink` hostil.
- **O1 (GATE):** `utils/errores.js` no clasificaba `entra_no_disponible` → habría salido **500**, no el
  503 que promete CA-6. Arreglado en el gate.
- **O1 (GATE):** el `turno-sweeper` y el `mand-sweeper` arrancan **incondicionalmente**, también bajo
  `AUTH_TEST_BYPASS=1`: la convención 37(b) de D-064 solo la aplica el sweeper de despacho. Deuda
  heredada, **fuera de alcance de D-065**.
- **Fase 2:** prod tiene **13 personas duplicadas** en `lov_bit.usuario` (fila legacy + fila Entra).
  Preexistente, **fuera de alcance**; el módulo se defiende trabajando solo sobre filas con
  `azure_oid`.
- **O2 (L04):** la pantalla anual no tenía **de dónde sacar la nómina**: `lov_bit.usuario` no tiene
  `cargo_id`, el directorio de Graph no se persiste y ningún endpoint listaba usuarios. `GET
  /asignaciones` la entrega ahora, con el cargo **inferido de la última sesión** — así que tras la
  primera sincronización real ~78 de 81 personas llegan sin cargo y la pantalla necesita un selector.
- **O2 (L05):** con **N titulares** en el mismo grupo el fondo de la pila los lleva a todos y el
  principal es el primero alfabéticamente, para mantener el invariante `principal ===
  pila[pila.length − 1]` que el popup puede asumir. Con un titular (las mallas de hoy) no se nota.
- **O2 (L06):** el congelado va **sin `try/catch`** dentro de `cerrarTurno` a propósito, y ese es el
  filo del módulo: un turno sellado sin su cumplimiento es peor que un cierre que hay que reintentar,
  pero cualquier error del módulo de rotación **bloquea el cierre de la planta** (CR2-1).
  `filas = 0` **no es error**: es el estado normal antes de la primera carga anual.
- **O2 (L11):** un `ALTER … ADD CONSTRAINT` sobre una tabla creada por una migración gateada con
  `IF OBJECT_ID` va en una migración **nueva**, nunca editando el `CREATE TABLE`: el `IF OBJECT_ID`
  lo salta en toda BD viva, así que el test pasa en una BD virgen mientras la real se queda sin la
  constraint.
- **O2 (GATE):** el guard estático de D-055 mira **700 caracteres hacia atrás** desde cada `DELETE`,
  y un batch SQL largo empuja su `.input()` fuera de esa ventana: el rojo dice "sin acotador" cuando
  el acotador existe. La respuesta correcta es partir el batch, no ensanchar el guard.
- **O2 (GATE, medido):** `cerrarTurno` lee **dos tablas más** dentro de su transacción desde L06, y
  la corrida produjo un **deadlock real** contra el `turno-sweeper` (verde al relanzar). La huella de
  bloqueos del cierre creció y eso ya no es teórico.
- **O2 (GATE, `/code-review`):** **no hay forma de corregir un patrón cargado con error** — el router
  solo tiene GET y POST, `activo` siempre nace en 1, y la UQ `(cargo_id, fecha_inicio)` no filtra por
  `activo`, así que ni desactivarlo a mano libera esa fecha. Es la operación anual, y la primera vez
  la hace gente aprendiendo.
- **O2 (GATE, `/security-review`):** cero hallazgos. El riesgo hacia adelante que dejó abierto el
  GATE-O1 (que algo del cliente llegara a `sincronizarDirectorio({ directorio })` y escalara a
  `es_jefe_planta`) **quedó cerrado**: el único llamador de producción le pasa exactamente
  `{ por_usuario: req.sesion.usuario_id }` y no toca `req.body`.

- **O3 (L07):** la superficie A no puede asumir la nómina pre-agrupada — **el agrupamiento por rol es
  una función del buffer**, no del dato del servidor, y una **sola** fecha ("Vigente desde") gobierna
  a la vez la lectura (`?fecha=`) y la escritura (`vigente_desde`). Leer con una y escribir con la de
  hoy es la clase de error que nadie nota hasta que el titular sale mal.
- **O3 (L08):** "se muestra si y solo si `ya_respondi === false`" y "si eres principal, ofrece
  Abandonar" **son incompatibles al pie de la letra** (tomar el control deja `ya_respondi = true`).
  La regla quedó con `soy_principal` **antes** de `ya_respondi`, exportada como función pura para que
  ese orden sea una decisión con test y no un accidente del orden de los `if`.
- **O3 (L09 → enmendado por el usuario):** el panel de ausencias se implementó respondiendo *"¿quién
  dejó el rol sin cubrir?"*, dejando fuera a los ausentes de las filas cubiertas por relevo (que igual
  se ven, con su ✗, en la tabla). El gate recomendó dejarlo así y **el usuario decidió lo contrario**
  el 2026-09-02: el panel pasa a responder *"¿quién faltó?"*, o sea que mide **asistencia**. Va a L13.
  La lección de método: era una pregunta de producto, y el gate hizo bien en no resolverla solo.
- **O3 (L12):** **`LIKE` de SQL Server ignora los blancos finales del valor.** Un CHECK
  `col LIKE '[1-4],…'` acepta `'1,1,3,3,4,4,2,2 '` (medido: `MATCH`, `DATALENGTH 16`), y `LEN`
  tampoco los cuenta: el único que los ve es `DATALENGTH`.
- **O3 (L12):** **una constraint gateada por su nombre nunca adopta un cambio de definición.** Pasó
  dentro del propio lote. Cambiar una definición exige una migración **nueva con nombre nuevo**, no
  editar la que ya se desplegó.
- **O3 (L12):** el `UPDLOCK` que ordena los bloqueos frente a `cerrarTurno` **subsume** al
  `sp_getapplock` para dos escrituras del mismo turno, así que el applock ya no se puede medir con
  concurrencia: su verificador pasó a tomarlo **desde afuera**, donde la diferencia de granularidad
  (turno vs. turno+cargo) sí se ve.
- **O3 (GATE, y es el que más va a doler):** **`CLAUDE.md:22` documenta el comando de tests SIN
  `--test-concurrency=1`**, mientras `server/tests/README.md` advierte lo contrario. El gate cayó en
  la trampa y perdió una corrida: 17 rojos cuyo mensaje —`There is already an object named
  'autorizacion_dashboard'`— no se parece en nada a una carrera de `initDB()`. Con el flag, 52/52.
- **O3 (GATE, medido):** **8 de los 77 archivos `.test.js` del disco no están en el script `test`**, y
  los ocho están **verdes** (43/43). No es código podrido: es cobertura que nadie corre.
- **O3 (GATE, `/code-review`):** **las dos mitades de CR2-8 se construyeron en olas distintas y no se
  encontraron.** El backend devuelve la fila corrupta con sus vectores **crudos** para que el
  administrador pueda listarla; el front hace `.join()` sobre ella y deja la pantalla en blanco. El
  500 se cambió por un vidrio roto, que es peor porque no queda en el log.
- **O3 (GATE, `/code-review`):** dos lotes de la MISMA ola resolvieron distinto el mismo problema —
  `useCumplimiento` descarta la respuesta obsoleta con `secuenciaRef`; `useTomaControl` no la descarta
  y su `desmontadoRef` no sirve, porque el efecto lo resetea a `false` para la unidad nueva antes de
  que aterrice el GET de la vieja.
- **O3 (GATE, `/security-review`):** cero hallazgos. El `PATCH` nuevo nace cerrado (allowlist pública,
  `requireEntra`, `loadAppSession`, gate por flag de cargo), el ancla del `@odata.nextLink` por host
  resiste las evasiones clásicas, y **ninguna** entrada de usuario alcanza el SQL dinámico del DDL de
  `F37.A4`.
- **O3 (GATE):** el deadlock que el GATE-O2 registró (su H4) **no se reprodujo**. Una corrida limpia
  no prueba que se cerró, y la otra mitad del abrazo —el `turno-sweeper` arrancando también bajo
  `AUTH_TEST_BYPASS`— sigue siendo deuda heredada, fuera de alcance de D-065.

## Desviaciones acumuladas respecto a `_CONTEXTO-BASE.md`

Todas **aceptadas** en el GATE-O1 (detalle y razón en `GATE-O1.md §5`). Ninguna cambia una ruta
especificada por un contrato: son aditivas o cubren caminos que el contrato dejó sin decir.

- **C1 (L01):** el motor lanza dos códigos de error que C1 no enumera — `fecha_invalida` y
  `patron_invalido`. Cubren la fecha malformada y el patrón sin desfase entero, que el contrato no
  especificaba; el camino feliz y los cuatro errores de C1 no cambian.
- **C2 (L02):** `F37.A1` usa el patrón de `F29.A1` (DDL con `IF OBJECT_ID` por statement, auto-reparable)
  y no el gateo del bloque entero por `migracion_aplicada`. `F37.A2` **no deja fila** en
  `migracion_aplicada` (esa tabla aún no existe en ese punto del arranque). Se nombraron los CHECK y
  DEFAULT que el contrato dejaba anónimos, y `rotacion_patron`/`rotacion_asignacion` ganaron
  `creado_en_bogota` (la prosa del §5.1 lo pedía para todas).
- **C3 (L03):** `leerDirectorioEntra` hace un quinto llamado a Graph (`GET /users/{id}`) para la
  asignación **directa** de usuario, devuelve **una** fila por persona con el rol resuelto por
  `PRECEDENCE`, y `sincronizarDirectorio` acepta dos parámetros opcionales de inyección
  (`directorio`, `fetchImpl`) que no cambian lo que L04 le pasa.

Las de la **O2**, todas aceptadas en el GATE-O2 (detalle en `GATE-O2.md §5` y en los cierres):

- **C4 (L04):** `GET /asignaciones` devuelve además `personas` (nómina asignable) y `POST
  /asignaciones` responde dos contadores más que el contrato, con el cuerpo que el contrato no
  fijaba. Aditivo: `{ asignaciones }` y el shape de C4 siguen igual. `titularesDeTurno` lanza un
  código más (`cargo_invalido`).
- **C5 (L05):** un 409 que el contrato no enumeraba, `rotacion_no_aplica` (el cargo no rota o está
  excluido por R12); `/descartar` devuelve el shape C5 **más** `ok: true`; y `GET /estado` con el
  turno cerrado responde `200 { aplica: false }`, no 409 — un GET informativo no falla porque la
  unidad esté entre turnos.
- **C7 (L06):** `congelarCumplimiento` acepta un `incluirSinteticos` opcional (default `false`) que
  producción nunca pasa; sin él el congelado sería intesteable end-to-end. Un rol con patrón pero
  `personas: []` **no** produce fila (decisión D2 del gate).
- **C3 (L11):** `TRAMO_SYNC` es un export nuevo y la sincronización commitea **por tramos de 20**: un
  fallo a mitad deja los tramos previos escritos, y es idempotente. Las dos firmas y el shape del
  retorno quedan idénticos.
- **Fuera de contrato (GATE-O2):** `reabrirTurno` borra ahora el cumplimiento congelado del turno, y
  las cuatro tablas de rotación entraron a los barridos de fixtures, al guard estático de D-055 y a
  `residuos.js`. No cambia ningún contrato: cierra las trampas que dejó el schema nuevo.


Las de la **O3**, todas aceptadas en el GATE-O3 (detalle en `GATE-O3.md §5` y en los cierres):

- **C5 (L08):** la firma del popup lleva una prop más que el contrato, `onAbandonar`. El §3 listaba
  `estado`/`onTomar`/`onDescartar`/`onCerrar` y el §4.4 del mismo prompt exige ofrecer "Abandonar el
  control", que es otro endpoint: reusar `onTomar` habría pegado al equivocado. **L10 pasa cuatro
  handlers.** Nada más de C5 cambió: se consumió tal cual y sus 9 claves alcanzaron.
- **C8 (L07):** la fecha de vigencia quedó como estado **interno** del componente, no en la URL —
  coherente con C8, que define `'#/rotacion' → { vista: 'rotacion', params: {} }`. La pantalla ganó
  además un **selector de rol por persona** (lo pidió el §6.3 del GATE-O2) y con él el grupo "Sin rol
  asignado", que el prompt no preveía porque asumía la nómina ya agrupada.
- **C8 (L09):** el formateador de presentación de fechas quedó **local al componente**, con `timeZone`
  explícito, porque `src/utils/fecha.js` no tiene ninguno que sirva para mostrar (deriva fechas, no
  las presenta) y el prompt prohibía tocarlo. Se agregó `rangoPorDefecto()` al hook, que el contrato
  no pedía, para que L10 no invente el rango al aterrizar sin parámetros.
- **C4 (L12):** el `PATCH /patrones/:id` acepta también `activo: true` (reactivar, con `409` si choca)
  y responde `400 activo_invalido` si el cuerpo no trae un booleano. **Para L07 el contrato del §6.6
  se cumple tal cual**; esto es aditivo. Dos slugs nuevos de dominio, expuestos a propósito (D-032):
  `activo_invalido` y `patron_no_encontrado`.
- **C4 (L12):** `GET /patrones` puede traer una fila con `vector_invalido: true` y sus vectores en
  **texto crudo** en vez de arreglo — es la rama defensiva por fila de CR2-8, y para una fila sana el
  shape no cambia. La pantalla todavía no la contempla: es **CR3-1**, con destino L13.
- **Fuera de contrato (GATE-O3):** `MUTADORES` en `routes/_middleware.js` pasa a ser la fuente única
  del chequeo CSRF y queda **atada por test** al `Access-Control-Allow-Methods` de `utils/http.js`;
  `useApi` gana `patch` y `useRotacion` deja de traer su propio cliente HTTP. No cambia ningún
  contrato: cierra el hueco que abría estrenar un verbo.

## Bitácora

- **2026-08-31** · Fase 1 cerrada: 5 rondas de preguntas (incluida una ronda 0 de vocabulario y una
  ronda 4 de corrección del eje del modelo, de "área" a **rol**). 23 criterios de aceptación
  congelados en `PREGUNTAS-D-065.md`.
- **2026-08-31** · Fase 2 cerrada: scaffolding + reservas commiteados. Rama
  `feat/rotacion-turnos-2026-08` creada desde `feat/integrar-asientos-D-059` (`5cc84a2`) **en un
  worktree temporal**, porque el árbol principal tenía una sesión de cierre de D-064 corriendo la
  suite. El usuario hace `git checkout feat/rotacion-turnos-2026-08` en el árbol principal cuando esa
  sesión termine, antes de abrir los chats de la O1.
- **2026-09-01** · **O1 cerrada** por `GATE-O1.md`: L01/L02/L03 `done`, cero violaciones de territorio,
  suite **781/781** backend (los tres archivos nuevos suman 57 casos; los 724 preexistentes calzan
  exactamente con el baseline de D-064) y **324/324** front. Cinco decisiones: un arreglo hecho en el
  gate (`utils/errores.js`), el territorio de L04 ampliado, el `turno-sweeper` declarado fuera de
  alcance y —**pendiente del visto bueno**— un lote de corrección **L11** en la O2 para los 12
  hallazgos confirmados del `/code-review`. `/security-review` sin hallazgos.
- **2026-09-01** · **O2 cerrada** por `GATE-O2.md`: L04/L05/L06/L11 `done`, cero violaciones de
  territorio, suite **861/861** backend (los cuatro archivos nuevos suman 78 casos) y **324/324**
  front, cero residuos con 20 checks. **Los 13 CA de la ola quedaron `cumple`**, incluido el CA-6 que
  el GATE-O1 dejó a medias: su mitad HTTP se confirmó corriendo los dos procesos sin credencial de
  Graph. Cinco decisiones: tres arreglos hechos en el gate (el cumplimiento congelado que `reabrirTurno`
  no borraba, los barridos de fixtures ciegos a las dos tablas nuevas, y el guard de D-055 en rojo por
  la ventana de 700 caracteres), la lectura de "un rol sin nadie en el grupo" resuelta a favor de L06,
  el deadlock observado registrado con destino, y un lote de corrección **L12** en la O3 para los 15
  hallazgos del `/code-review`, siete de ellos confirmados leyendo el fuente. `/security-review` sin
  hallazgos: el riesgo hacia adelante del GATE-O1 quedó cerrado.
- **2026-09-01** · **Visto bueno de la O2 dado.** `L12` aprobado y **O3 abierta** con cuatro lotes:
  L07, L08, L09 (front, uno por superficie) y L12 (backend, correcciones). Territorios disjuntos por
  construcción: L12 no comparte un solo archivo con los tres de front.
- **2026-09-02** · **O3 cerrada** por `GATE-O3.md`: L07/L08/L09/L12 `done`, cero violaciones de
  territorio, suite **894/894** backend (los tres archivos nuevos de front suman 68 casos y el de
  backend 27) y **392/392** front, cero residuos con 20 checks. **Los tres CA de la ola quedaron
  `cumple`** —CA-19, CA-20, CA-21— y **CA-3 se recuperó** de `parcial` a `cumple` al aplicar el
  bloqueo B1 de L12. Cinco decisiones: tres arreglos hechos en el gate (el B1 sobre `rotacion_schema`,
  el `PATCH` que nacía sin la defensa CSRF de AUD-19 **y sin anunciarse en el preflight**, y el
  `api.patch` que faltaba en `useApi`), la lectura del panel de ausencias resuelta a favor de L09, y
  un lote de corrección **L13** en la O4 para los cuatro hallazgos del `/code-review` que caen sobre
  territorios ya cerrados. `/security-review` sin hallazgos. **Los tres `cumple` son de nivel
  componente: ninguna pantalla está enchufada todavía** — eso lo hace L10 y con eso llega la
  confirmación end-to-end.
- **2026-09-02** · **Visto bueno de la O3 dado.** `L13` aprobado **en paralelo con L10** y **O4
  abierta** con dos lotes. La decisión **D4 del gate quedó enmendada por el usuario**: el panel
  "Titulares que no entraron" **sí** incluirá a los ausentes de los turnos cubiertos por relevo, así
  que L13 suma a su territorio `useCumplimiento.js`, `CumplimientoRotacion.jsx` y su test — y sigue
  sin compartir un archivo con L10. Regla dura de la ola, escrita en los dos prompts: **L13 no cambia
  la firma de props de ningún componente**, porque L10 cablea contra ellas al mismo tiempo.
