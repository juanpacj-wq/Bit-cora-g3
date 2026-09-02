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
| O3 | L07 | Pantalla de configuración anual | ⬜ | — | — |
| O3 | L08 | Popup de toma de control | ⬜ | — | — |
| O3 | L09 | Vista de cumplimiento | ⬜ | — | — |
| O3 | L12 | Correcciones de la O2 (abierto por el GATE-O2, D5) | ⬜ | — | — |
| — | **GATE-O3** | | ⬜ | | `GATE-O3.md` |
| O4 | L10 | Cableado en el componente raíz y rutas hash | ⬜ | — | — |
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
| GATE-O3 | | |
| GATE-O4 | | |

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
