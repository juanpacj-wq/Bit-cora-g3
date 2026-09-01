# D-065 — GATE-O1 (cierre de la ola O1)

> Expediente **inmutable** del gate. Lo escribe solo el integrador. Si algo de acá se revierte
> después, se enmienda encima ("REVERTIDA el … por …"), no se borra.
> Fecha: **2026-09-01 12:55 (Bogotá)** · Rama: `feat/rotacion-turnos-2026-08` · BD: `PortalG3_dev`.

## 1. Semáforo al cerrar

```
D-065 · rama feat/rotacion-turnos-2026-08

O1 [abierta]
  L01  done        L01-1034     Motor puro del patrón de rotación
  L02  done        L02-1055     Schema de rotación (F37.A1) y flag de cargo (F37.A2)
  L03  done        L03-1055     Cliente de Microsoft Graph y sincronización del directorio

O2 [pendiente]
  L04  pending                  Endpoints de configuración anual (superficie A) ← L01,L02,L03
  L05  pending                  Toma de control del rol (superficie B, backend) ← L02
  L06  pending                  Cumplimiento y congelado al cerrar (superficie C, backend) ← L01,L02

test-lock: libre
```

Lotes sin cierre commiteado: **ninguno**. Los tres dejaron su `cierres/LNN.md` y ninguno quedó
`in-progress` ni `blocked`. Cero lotes reconstruidos por el gate.

## 2. Territorios

```
=== L01 ===   L01 · 3 commit(s): f6dd4ea c87233b 50c79bc
  prompts/D-065-rotacion-turnos/cierres/L01.md
  server/tests/fixtures/rotacion-oraculo-2026.json
  server/tests/rotacion_patron.test.js
  server/utils/rotacion/patron.js
[lotes] territorio respetado

=== L02 ===   L02 · 2 commit(s): bcb98ba e4c4ec1
  prompts/D-065-rotacion-turnos/cierres/L02.md
  server/db.js
  server/tests/rotacion_schema.test.js
[lotes] territorio respetado

=== L03 ===   L03 · 2 commit(s): b30e3f8 51aa23d
  prompts/D-065-rotacion-turnos/cierres/L03.md
  server/tests/rotacion_sync_entra.test.js
  server/utils/graph/cliente.js
  server/utils/graph/directorio.js
[lotes] territorio respetado
```

**Violaciones: ninguna.** Los tres lotes corrieron con el `pre-commit` y `LOTE_SESION`, así que la
comprobación no es de palabra: la hizo el hook. Ningún lote tocó un archivo compartido ajeno —
`db.js` lo escribió solo L02— y los tres hallazgos que pedían editar `middleware/auth.js`,
`utils/sesion-contexto.js`, `utils/errores.js` y `server.js` se **reportaron sin tocarlos**, que es
exactamente lo que manda el §8.

## 3. Verificación de la ola (bajo test-lock `GATE-O1`)

**Tests enganchados a `server/package.json`** (61 → 64 archivos; `zzz_session_leak_guard` sigue
último): `tests/rotacion_patron.test.js`, `tests/rotacion_schema.test.js`,
`tests/rotacion_sync_entra.test.js`, en las posiciones 12–14 — tras `campos_validate` y antes de
`asientos`, el bloque de los unitarios, como pidieron los tres cierres. Ninguno compite por puerto
ni por planta con nadie.

**Backend efímero** con el código de la rama:
`SERVER_PORT=3199 AUTH_TEST_BYPASS=1 node --env-file=../.env server.js` → `[SERVER] Escuchando en
puerto 3199`, `/health` 200. La suite se corrió en **12 bloques en primer plano** porque la corrida
completa excede el tope de 10 min por comando de esta sesión; los resultados se suman abajo.

| Bloque | Archivos | Resultado |
|---|---|---|
| 1 | guards ×2, ws_origin, auth_bypass, entra_roles, catálogos, tipos espejo, split sala | `tests 52 · pass 52 · fail 0` |
| 2 | guards ×2, campos_validate, **rotación ×3**, asientos ×2 | `tests 109 · pass 109 · fail 0` |
| 3 | asiento/reflejo despacho, F03 ×3, revalidate, fechas_bogota, turno-entidad | `tests 164 · pass 164 · fail 0` |
| 4a | auth_middleware, auth_reactivate, disponibilidad ×2 | `tests 47 · pass 47 · fail 0` |
| 4b | disponibilidad_reflejo_http, cierre_y_fechas | `tests 16 · pass 16 · fail 0` |
| 4c | sala_de_mando_batch | `tests 85 · pass 85 · fail 0` |
| 5a | conformacion_turno, consumos_combustible, sis_endpoints | `tests 51 · pass 51 · fail 0` |
| 5b | sis_scrape_endpoint, finalizar_turno, cambiar_unidad | `tests 37 · pass 31 · fail 1 · skipped 5` ⚠ |
| 5c | registros ×2, despacho_xm, relleno_despacho_xm | `tests 32 · pass 32 · fail 0` |
| 6 | transición/seguimiento de turno, históricos ×2, 3 guards de no-auto-ejecución | `tests 37 · pass 37 · fail 0` |
| 7 | rol coordinador, rol consulta, sis ×6 | `tests 86 · pass 86 · fail 0` |
| 8 | sis ×2, contrato dashboard, http_hardening, errores, ia ×2, **zzz_session_leak_guard** | `tests 66 · pass 66 · fail 0` |

**El único rojo (bloque 5b) es la deuda conocida de D-061, no una regresión.**
`sis_scrape_endpoint` salta sus 5 casos HTTP si el backend no trae `SIS_HOST`, y el propio archivo
falla a propósito (`CA-53`) para que el salto **no pase en silencio**, imprimiendo el comando exacto
que falta. Remedido con el stub, relanzando el backend con `SIS_HOST=http://localhost:3154`:

```
TEST_BASE_URL=http://localhost:3199 SIS_HOST=http://localhost:3154 \
  node --env-file=../.env --test --test-concurrency=1 tests/sis_scrape_endpoint.test.js
ℹ tests 10 · pass 10 · fail 0 · skipped 0 · duration_ms 56260.6
```

**Cifra de la ola, con el archivo del SIS medido con su stub:
`tests 781 · pass 781 · fail 0 · skipped 0`.** Sin stub —la forma canónica de `npm test` en esta
máquina— la cifra es `782 · 776 · 1 · 5`.

**Front:** `npm run build` → `✓ built in 11.75s`, exit 0. `npm test` (vitest) →
`Test Files 17 passed (17) · Tests 324 passed (324)`.

**Comparación con el baseline.** El heredado en `ESTADO.md` era 681/681 (GATE-O2 de D-063), pero la
rama recibió después el merge `bf24d65` con el cierre de D-064, así que el punto de comparación real
es **724/724** (GATE-O2 de D-064). Los tres archivos nuevos aportan 57 casos (29 + 17 + 11):
**781 − 57 = 724**, exactamente el baseline. **Cero rojos nuevos y cero tests preexistentes
perdidos.** (El 781 ya incluye el caso 12 que este gate agregó a `tests/errores.test.js`; el conteo
cuadra porque el archivo del SIS aporta 10 con stub y 11 sin él.)

**Residuos en BD: ninguno.** `npm run test:residuos` → `[residuos] cero residuos` (12 checks en
`ok`, exit 0). Y la consulta propia del territorio de la ola, que ese script todavía no cubre:

```
     0   filas rotacion_patron / rotacion_asignacion / rotacion_control / rotacion_cumplimiento
     0   usuarios con azure_oid de fixture (00000000-d065-%)
     0   usuarios username test_rot%
   111   TOTAL lov_bit.usuario          (idéntico al conteo previo al lote L03)
     2   cargos con puede_configurar_rotacion = 1   → Administrador y Debugging | Gerente de Producción
     1   filas F37.A1 en migracion_aplicada
```

**`/code-review` del diff de la ola (`bf24d65..HEAD`, nivel `high`):** 15 hallazgos propuestos. El
gate los triió uno por uno **contra el código, no contra el reporte** — dos no sobrevivieron enteros
y uno resultó mejor de lo que el revisor creía. Detalle en §7 (CR-1…CR-15). Los cinco que cambian
algo:

- **CR-1 (confirmado, el más serio de la ola).** El `WHEN MATCHED` del MERGE escribe
  `azure_upn = @upn` y `azure_tid = @tid` **incondicionalmente**, y los dos bindings pueden ser
  `NULL` (`upn || null`; `tenantId` es `M365_TENANT_ID || null`). La cadena de fallo está completa y
  la verificó el gate leyendo los dos extremos: una persona que Graph devuelva sin
  `userPrincipalName` queda con `azure_upn = NULL`, y en el **siguiente arranque**
  `enforceSingletonFlag` corre
  `UPDATE … SET es_jefe_planta = 0 WHERE es_jefe_planta = 1 AND (azure_upn IS NULL OR …)` y **degrada
  al Jefe de Planta**, que no vuelve hasta que esa persona se loguee otra vez. El arreglo es
  `COALESCE(@upn, t.azure_upn)` / `COALESCE(@tid, t.azure_tid)`.
- **CR-9 (confirmado, y refuta al cierre de L02).** El gate lo midió contra la BD: un
  `CHECK (grupo BETWEEN 1 AND 4)` sobre una columna NULLABLE **acepta `NULL`** y rechaza `0` y `5`.
  La razón que dio L02 para dejar `rotacion_cumplimiento.grupo` sin CHECK era falsa. Corregido en el
  §6.7 y propagado a los tres prompts de la O2.
- **CR-2 y CR-6/CR-7 (confirmados).** Un solo 404 de Graph —una asignación a alguien borrado, que
  Entra conserva hasta 30 días— aborta la lectura de las 89 personas; y el schema no tiene guard de
  solapamiento en `rotacion_asignacion`/`rotacion_patron` ni nada que ate `planta_id` con `turno_id`
  (el mismo drift invisible de D-053(iii)).
- **CR-4 (parcialmente refutado).** Es cierto que las filas que crea el MERGE quedan con
  `es_sintetico = 0` y que la cabecera del test dice lo contrario, y es cierto que `residuos.js` no
  mira `lov_bit.usuario`. Pero el riesgo que describe está acotado: `limpiarFixture()` borra por los
  GUIDs `…-d065-…` y corre en el **`before()` además del `after()`**, así que una corrida abortada se
  limpia en la siguiente — y acotar por GUID de fixture es **más** fuerte que acotar por
  `es_sintetico`, no menos. Baja, no media.
- **CR-8 (refutado como defecto).** El cierre de L01 ya lo había considerado y resuelto:
  `grupoT1 = 9` sale por `desfase_imposible`, que es la respuesta correcta y ya está en el contrato.
  Lo que el revisor propone —un `grupo_invalido` para dar mejor mensaje— es una mejora de UX de
  error que **ya estaba anotada** en el cierre de L01 como trabajo de L04, no un defecto del motor.

**`/security-review`:** corrido porque L03 toca autenticación de aplicación
(`client_credentials`), un secreto (`M365_CLIENT_SECRET`), PII de 89 personas y un `MERGE` sobre
`lov_bit.usuario`, y porque L02 toca la matriz de permisos de cargo.
**Resultado: cero hallazgos que superen la barra de confianza.** Lo revisado y por qué quedó limpio:

- **Inyección SQL en `directorio.js`**: limpio. Dos statements; el `MERGE` bindea **todo** valor
  externo por `.input()` con tipo y longitud explícitos, y el texto SQL no tiene un solo
  placeholder de plantilla. Nada de Graph entra como fragmento de string.
- **Toma de cuenta por `displayName`/UPN hostil**: limpio, y es la comprobación que sostiene todo.
  `ON t.azure_oid = s.azure_oid` es el **único** predicado de match; `UQ_usuario_oid` es un índice
  único filtrado, así que las filas legacy (`azure_oid IS NULL`) **no pueden** matchear jamás. El
  `WITH (HOLDLOCK)` replica el de `provisionEntraUser` (AUD-30), así que la sincronización y un
  primer login sobre el mismo oid se serializan en vez de insertar dos veces.
- **Escalada de privilegios por la sincronización**: limpio. El `WHEN MATCHED` escribe exactamente
  tres columnas (`nombre_completo`, `azure_upn`, `azure_tid`) — **estrictamente más estrecho** que
  `provisionEntraUser`, que en el match sí escribe `es_jefe_planta`/`es_jdt_default`/`email`. El
  `WHEN NOT MATCHED` fija `es_jefe_planta=0, es_jdt_default=0, password_hash=NULL` y toma `activo`
  de `accountEnabled` (fail-closed). `SISTEMA` (D-015) tiene `azure_oid IS NULL`: inalcanzable.
- **El fallback de `username`**: limpio, no puede pisar a nadie. Solo elige el valor de `INSERT` de
  una fila nueva; **no hay un solo `UPDATE` de `username` en el archivo**, así que el peor desenlace
  de una mala elección es una violación de `UNIQUE` que aborta la transacción, nunca una toma
  silenciosa de la fila de otra persona.
- **Manejo del secreto en `cliente.js`**: limpio. `M365_CLIENT_SECRET` va solo en el cuerpo del
  POST, nunca en una URL, un header ni un log; `redirect: 'error'` impide que ese cuerpo se reenvíe
  a un destino de redirección. Los caminos de fallo evitan `e.message` a propósito y exponen solo
  `e.name` + `e.cause.code`. El bearer de Graph está **anclado por host** en `graphFetch` con
  `startsWith('https://graph.microsoft.com/')`, y esa barra final derrota tanto a
  `graph.microsoft.com.evil.tld` como a `graph.microsoft.com@evil.tld`: un `@odata.nextLink` hostil
  no puede exfiltrar el token del directorio.
- **`F37.A2`**: fila por fila contra la preimagen, las cuatro columnas de valor previas
  (`solo_lectura`, `puede_cerrar_turno`, `puede_cambiar_unidad`, `es_observador`) quedan **idénticas
  en los 14 cargos**; solo se agrega la nueva. El Gerente conserva `solo_lectura = 1` y
  `USUARIO DE CONSULTA` conserva sus flags de invisibilidad (D-059).
- **`F37.A1`**: puramente aditiva. Cuatro `CREATE TABLE` gateados por `IF OBJECT_ID`, dos
  `CREATE INDEX` por `IF NOT EXISTS`, un `ALTER … ADD` por `IF COL_LENGTH`. **Ningún `DROP`, ningún
  `ALTER` de columna existente, ninguna constraint relajada, ninguna vista ni trigger** — la
  superficie de vistas de solo lectura de D-041 queda intacta.
- **`patron.js`**: sin I/O, sin `eval`/`Function`, sin escritura de propiedad dinámica desde la
  entrada, sin bucle no acotado. Las dos regex están ancladas y no backtrackean. Validación
  fail-closed, incluido el round-trip de `Date.UTC` que rechaza `2026-02-30`.

Hecho que acota el impacto de todo lo anterior: **la ola no agrega ni una superficie HTTP
alcanzable.** Los únicos importadores de `utils/graph/*` y `utils/rotacion/patron.js` son los
tests: no hay ruta, ni sweeper, ni llamada desde el bootstrap. La revisión de autorización de
verdad es la de la O2, cuando L04 monte los endpoints.

La revisión levantó además **una advertencia hacia adelante** que no es un defecto de este código
pero sí un modo de falla real si L04 se descuida: va al §6, punto 5, y es la razón de que ese punto
esté redactado como prohibición y no como recomendación.

## 4. Criterios confirmados

Solo se marca `cumple` lo que el gate vio en verde él mismo, dentro de la suite completa.

| CA | Propuesto por | Confirmado | Verificador que el gate vio en verde |
|---|---|---|---|
| CA-1 | L01 | `cumple` | `rotacion_patron.test.js › el motor reproduce el oráculo del Excel sin una sola discrepancia` — 1.460 pares (730 **por malla**, y el test afirma `pares === 1460`, así que un fixture recortado no pasa por victoria), 0 discrepancias |
| CA-2 | L01 | `cumple` | `rotacion_patron.test.js › derivarDesfase` (8 subtests): con `V2 = V1` sale `desfase_ambiguo`; el motor **no adivina** |
| CA-3 | L02 | `cumple` | `rotacion_schema.test.js › F37.A1 · 1…11`; el caso 11 corre `initDB()` de nuevo y comprueba que no falla ni duplica el flag |
| CA-4 | L02 | `cumple` | `rotacion_schema.test.js › F37.A2 · 12…17`; el 14 pone el flag a mano en un tercer cargo y comprueba que `initDB()` lo baja a 0 (lo que separa el MERGE de un `UPDATE` one-shot), y el 16 fija `solo_lectura = 1` del Gerente |
| CA-5 | L03 | `cumple` | `rotacion_sync_entra.test.js › aprovisiona por azure_oid — la persona que ya existe no duplica` y `› dos nombres casi iguales con azure_oid distintos → DOS filas` |
| CA-6 | L03 | `cumple` ⚠ | `rotacion_sync_entra.test.js › degradación (a)/(b)/(b bis)/(b ter)/(c)`: el `codigo` y "el server sigue vivo" están verdes. **La mitad HTTP (el status 503) esta ola no la puede probar: todavía no hay endpoint.** El gate arregló lo que la hacía imposible (H1/D2) y su confirmación por HTTP queda **asignada al GATE-O2** |
| CA-23 | (gate) | `en pie` | `grep -E "setInterval|cron|sweeper"` sobre `patron.js`, `graph/cliente.js`, `graph/directorio.js` y el diff de `db.js`: **cero** ocurrencias reales (las que salen son la palabra "sincronización" en comentarios). Se re-verifica en cada gate |

## 5. Decisiones tomadas en este gate

### D1 — Los dos códigos de error que L01 agregó a C1

- **Qué lo provoca:** el contrato C1 dice qué pasa con un vector malo y con un turno malo, pero
  calla sobre una **fecha** malformada y sobre un **patrón** sin `desfase` entero. L01 los cubrió
  con `fecha_invalida` y `patron_invalido`, y lo declaró como desviación que pide visto bueno.
- **Opciones:** a) revertir a que el motor no valide y devuelva `NaN`/`undefined` (una línea en
  `msDelDiaIso` y otra en `validarPatron`) · b) **aceptarlos** y obligar a L04/L06 a mapearlos a
  400 · c) renombrarlos para que caigan bajo `vector_invalido`. — **Recomendada: b.**
- **Decidido: b.** Un grupo `undefined` viajando hasta la UI es el modo de falla de D-055 (el
  registro 4722), y a) lo reintroduce: `grupoDeTurno(patron, '2026-02-30', 1)` devolvería un grupo
  equivocado **en silencio**. c) miente sobre qué falló. El costo de b es una línea de mapeo por
  endpoint.
- **Qué cambia / qué NO cambia:** el camino feliz y los cuatro errores que C1 sí enumera quedan
  idénticos. Cambia que L04 y L06 tienen **seis** slugs que mapear, no cuatro.
- **Enmiendas que produce:** cabecera de `L04` y `L06` (bloque de hechos, punto 1).

### D2 — Quién arregla que `utils/errores.js` no clasifique `entra_no_disponible`

- **Qué lo provoca:** hallazgo 1 de L03. `clasificarError` solo ramifica por `err.codigo` para los
  dos códigos de IA; cualquier otro cae al catch-all `error_interno` **500**. CA-6 promete **503**.
  Verificado por el gate leyendo la rama 5.5 y el catch-all de `utils/errores.js`.
- **Opciones:** a) **arreglarlo en el gate** · b) ampliarle el territorio a L04 · c) dejarlo para el
  cierre. — **Recomendada: a.**
- **Decidido: a.** `utils/errores.js` es un compartido que **no tiene escritor en ninguna ola** del
  §8; dárselo a L04 lo obligaría a tocar, en paralelo con L05 y L06, un archivo del que cuelga media
  docena de routers. La edición estaba especificada al detalle en el cierre de L03 y es puramente
  aditiva: una entrada en `ETIQUETAS` y un tercer `codigo` en el `if` de la rama 5.5. **Hecho en
  este gate**, con su test y su verificador bidireccional:

  ```
  node --test tests/errores.test.js  → ℹ tests 12 · pass 12 · fail 0
  (era 11; el caso nuevo es "D-065: fallo del directorio de Entra … → 503 saneado")

  con la rama del if ROTA a propósito:
  ✖ D-065: fallo del directorio de Entra (codigo del cliente de Graph) → 503 saneado
    AssertionError: Expected values to be strictly equal
  ℹ tests 12 · pass 11 · fail 1        → restaurado: 12/12
  ```

  Y comprobado que la etiqueta resuelve a texto propio, no al genérico:
  `clasificarError → {status:503, codigo:'entra_no_disponible'}`, `mensajeUsuario` ≠
  `ETIQUETAS.error_interno`.
- **Qué cambia / qué NO cambia:** el 503 ya es alcanzable. **No** cambia que nadie lo haya probado
  por HTTP: eso lo hace L04 y lo confirma el GATE-O2.

### D3 — Quién lleva `puede_configurar_rotacion` hasta la sesión

- **Qué lo provoca:** hallazgo de L02. `/api/me` proyecta los flags de cargo **enumerándolos uno a
  uno** y el nuevo no está. Verificado por el gate: ni `SELECT_SESION` (`middleware/auth.js`) ni su
  espejo (`utils/sesion-contexto.js`) lo traen. El síntoma sería el peor posible —
  `sesion.puede_configurar_rotacion === undefined` → *falsy* → la pantalla **nunca aparece**, ni
  para el Administrador, **sin ningún error**.
- **Opciones:** a) arreglarlo en el gate · b) **ampliarle el territorio a L04** · c) dárselo a L07
  en la O3. — **Recomendada: b.**
- **Decidido: b.** A diferencia de D2, acá el consumidor es único e identificable: L04 necesita el
  flag para **gatear sus propios endpoints**, así que es quien puede probarlo end-to-end en
  `rotacion_endpoints.test.js` en vez de dejar la edición sin test. c) llega tarde: L04 quedaría sin
  gate. Se amplía el territorio de L04 con `server/middleware/auth.js` y
  `server/utils/sesion-contexto.js` en `LOTES.json` y `PLAN-OLAS.md`. **Los dos SELECT son espejos
  declarados: se cambian juntos.**
- **Qué cambia / qué NO cambia:** el reparto de la O2. **No** cambia el alcance de la implementación
  ni ningún contrato: el flag ya existe en la BD desde `F37.A2`, solo falta proyectarlo.

### D4 — El `turno-sweeper` escribiendo plantas reales bajo `AUTH_TEST_BYPASS=1`

- **Qué lo provoca:** hallazgo 5 de L03, confirmado por el gate en `server.js`: `startTurnoSweeper`
  y `startMandSweeper` arrancan **incondicionalmente**; solo el de despacho consulta
  `sweeperHabilitado()`. El backend efímero de cada lote abre cabeceras `turno_unidad` en
  GEC3/GEC32.
- **Opciones:** a) extender `sweeperHabilitado()` a los otros dos sweepers en este gate · b)
  **dejarlo fuera de alcance** y registrarlo como deuda de D-064 · c) abrir un lote de corrección en
  la O2. — **Recomendada: b.**
- **Decidido: b.** No es de D-065: es la convención 37(b) aplicada a medias por D-064, y **precede a
  esta rama**. a) es la opción cara y peligrosa —media suite de turnos depende de que el sweeper
  corra— y arreglarlo a ciegas dentro de un gate cuya suite ya está verde es exactamente cómo se
  introduce un rojo que después nadie sabe explicar. c) le mete a la O2 un lote que no comparte nada
  con el módulo de rotación. Se registra como deuda para el cierre de la implementación (H3).
- **Qué cambia / qué NO cambia:** nada del código. Cambia que queda **escrito y medido**, con el
  matiz que lo hace tolerable hoy: el turno-sweeper escribe **cabeceras idempotentes**, no registros
  de bitácora, y apunta a `PortalG3_dev`.

### D5 — Qué se hace con los 15 hallazgos del `/code-review` (**pendiente del visto bueno**)

- **Qué lo provoca:** el `/code-review` de la ola devolvió 15 hallazgos; tras el triaje del gate,
  **doce sobreviven** y tocan `utils/graph/directorio.js`, `utils/graph/cliente.js`, `db.js` y los
  tests de L02/L03 — es decir, **territorios de lotes ya cerrados**, ninguno de los cuales tiene
  escritor en la O2. La regla del gate ("arreglo acá si es un compartido; si no, lote de corrección")
  no aplica directo: no son compartidos del §8, son territorio muerto.
- **Opciones:**
  a) Arreglarlos **en este gate**, ahora.
  b) **Un lote de corrección `L11` en la O2**, con territorio disjunto de L04/L05/L06.
  c) Repartirlos entre L04/L05/L06 según qué archivo tocan.
  d) Dejarlos todos para el cierre de la implementación.
  — **Recomendada: b.**
- **Por qué b y no las otras.** a) mete a un solo chat —este— a reescribir un `MERGE` transaccional,
  la paginación de Graph y dos migraciones de schema **después** de haber corrido la suite completa,
  o sea: o invalido la verificación de la ola, o la corro otra vez entera (44 min) por hallazgos que
  ninguno bloquea la O2. c) es lo peor de todo: le mete a tres chats en paralelo ediciones en
  archivos que **no** son suyos, que es exactamente lo que el modelo de territorios existe para
  evitar. d) deja `db.js` sin constraints justo mientras L04, L05 y L06 escriben contra esas tablas
  — que es cuando los datos malos entran. b) los agrupa donde pertenecen, con su propio test y su
  propio territorio, y **en la misma ola** en que se necesitan.
- **Riesgo de b, dicho explícito:** L11 agrega constraints a tablas contra las que L04/L05/L06 van a
  escribir **al mismo tiempo**. Si un índice único nuevo choca con lo que inserta un test de L04, el
  rojo aparece en el GATE-O2 y no antes. Se mitiga así: **L11 no bloquea a nadie** (`depende_de: []`)
  y su prompt lleva la instrucción de que **toda constraint nueva va como migración `F37.A3`
  aditiva e idempotente**, nunca modificando el `CREATE TABLE` de `F37.A1` — que además no serviría,
  porque el `IF OBJECT_ID` lo salta en cualquier BD donde las tablas ya existan (todas, ya).
- **Decidido: _pendiente del visto bueno del usuario_.** Agregar un lote cambia el reparto de la ola,
  y ese es el único punto de este gate donde no decido solo. `L11` queda escrito en `LOTES.json` y
  `PLAN-OLAS.md` en estado `pending`, dentro de la O2 —que sigue `pendiente`, así que **nadie puede
  reclamarlo** hasta el `ola-abrir O2`—. Si el visto bueno lo rechaza, se retira con una enmienda
  encima de este expediente y los doce hallazgos pasan al cierre (opción d).
- **Qué NO entra en L11, y por qué:** H3 (los sweepers bajo `AUTH_TEST_BYPASS`, decisión D4) sigue
  fuera de alcance — es de D-064 y precede a esta rama. CR-8 y CR-12 tampoco: el primero es trabajo
  de L04 que el cierre de L01 ya había anotado, el segundo es eficiencia sin defecto.

## 6. Hechos que cambian lo que dicen los documentos anteriores

> Este bloque se copia **tal cual** al inicio de cada prompt de la ola O2.

1. **El motor del patrón lanza SEIS códigos, no cuatro** (D1). A los cuatro de C1 —
   `vector_invalido`, `desfase_imposible`, `desfase_ambiguo`, `turno_invalido`— se suman
   **`fecha_invalida`** (el string no es un `'YYYY-MM-DD'` real: trae hora, es un `Date`, o es un 30
   de febrero) y **`patron_invalido`** (el objeto `patron` no trae un `desfase` entero). Salen de
   `diasEntre`/`diaDelCiclo`, así que **`grupoDeTurno` también los propaga**. Mapéalos a un `400` con
   su slug, igual que a los otros cuatro, y **nunca** los dejes llegar crudos a la respuesta (D-032).
2. **`utils/errores.js` YA clasifica `entra_no_disponible` → 503** (D2, hecho en este gate, con su
   caso en `tests/errores.test.js`). No lo vuelvas a agregar y no lo toques.
3. **`puede_configurar_rotacion` NO llega hoy a la sesión ni a `/api/me`**, y **L04 es quien lo
   lleva** (D3): su territorio se amplió con `server/middleware/auth.js` y
   `server/utils/sesion-contexto.js`. Agrega
   `CAST(c.puede_configurar_rotacion AS BIT) AS puede_configurar_rotacion` a **los dos** SELECT —son
   espejos declarados, con el comentario que lo dice— y fija el shape en tu propio test. Sin esto,
   CA-19 (la pantalla de L07) es infalsable: el flag sale `undefined`, la pantalla no aparece y **no
   hay ningún error** que lo delate.
4. **El directorio que devuelve L03 viene deduplicado por `azure_oid`** con el rol resuelto por
   `PRECEDENCE`: `personas.length` **no** es la suma de `grupos[].miembros` (hoy 89 vs 90 en el
   tenant real, porque el Gerente de Producción está también en `USUARIO_CONSULTA`). Si necesitas el
   conjunto completo de roles por persona, eso es **cambio de contrato**: pídelo, no lo derives.
5. **`sincronizarDirectorio` acepta un parámetro `directorio` que salta Graph por completo, y ese
   parámetro JAMÁS puede venir del cliente.** Existe para inyectar el directorio en los tests. Si el
   endpoint de L04 dejara que algo derivado de `req.body` llegue a esa opción, un usuario autenticado
   podría fabricar `personas` y reescribir `nombre_completo`/`azure_upn` de filas **arbitrarias** —
   y `azure_upn` es entrada de `enforceSingletonFlag`, que en cada arranque pone `es_jefe_planta = 1`
   a quien calce con `M365_JEFE_PLANTA_UPNS`: sería una escalada real de privilegio. Llámala
   **exactamente** como `sincronizarDirectorio(pool, { por_usuario })`, y que `directorio` y
   `fetchImpl` no aparezcan en el handler. (Lo levantó la revisión de seguridad de este gate como
   riesgo hacia adelante; hoy no es explotable porque no hay endpoint.)
6. **`sincronizarDirectorio` NO escribe** `activo` de una fila existente, ni `es_jefe_planta`, ni
   `es_jdt_default`, ni `email`, ni el cargo — a propósito. No asumas que la sincronización "arregla"
   ninguno de esos. Y **`por_usuario` no se persiste**: `lov_bit.usuario` no tiene columnas de
   auditoría, así que solo va al log del server. Trazabilidad de quién sincronizó = tabla nueva =
   schema, y el schema fue L02: eso sería una desviación, no una licencia.
7. **`rotacion_cumplimiento.grupo` no lleva CHECK, y la razón que dio L02 resultó ser FALSA.** El
   cierre de L02 lo dejó sin constraint creyendo que un `BETWEEN 1 AND 4` "rechazaría el caso
   legítimo `NULL`" que L06 necesita escribir. **No es así**, y este gate lo midió contra la BD: un
   `CHECK` solo rechaza cuando evalúa a `FALSE`, y con `NULL` evalúa a `UNKNOWN`.

   ```
   CHECK (grupo BETWEEN 1 AND 4) sobre columna NULLABLE:
     ACEPTA   grupo = 3     ACEPTA   grupo = NULL
     RECHAZA  grupo = 5     RECHAZA  grupo = 0
   ```

   O sea que se podía tener las dos cosas. Consecuencia para **L06**: hoy esa columna acepta `0`,
   `5` y `200` en un registro congelado y append-only, y **nada te va a rechazar un grupo malo** —
   no confíes en la BD para ese rango, valídalo tú. El CHECK se agrega en el lote de corrección
   **L11** (ver `GATE-O1.md`, decisión D5); si L11 ya corrió cuando leas esto, la columna sí lo
   tiene y `NULL` sigue siendo legítimo.
8. **Nombres de constraint que el contrato no fijaba y ahora existen** (por si capturas una
   violación por nombre): `CK_rotacion_patron_desfase`, `DF_rotacion_patron_activo`,
   `DF_rotacion_patron_creado_en`, `CK_rotacion_asig_grupo`, `DF_rotacion_asig_creado_en`,
   `CK_rotacion_control_accion`, `DF_rotacion_control_ocurrido_en`, `CK_rotacion_cumpl_turno`,
   `CK_rotacion_cumpl_estado`, `DF_rotacion_cumpl_snapshot_en`. Los que C2 sí fijaba quedaron **tal
   cual**. **Las FK van sin nombre** (inline con `REFERENCES`, como `turno_unidad`): captúralas por
   número de error (547), no por nombre.
9. **`rotacion_patron` y `rotacion_asignacion` tienen `creado_en_bogota`** además de `creado_en`. Un
   `SELECT *` sobre ellas trae esa columna de más.
10. **Las cuatro tablas están vacías en `PortalG3_dev` y `F37.A1` está aplicada** (una sola fila en
    `migracion_aplicada`). En `PortalG3` (prod) nada de esto existe: llega con el despliegue. El flag
    está en 1 exactamente para **`Administrador y Debugging`** y **`Gerente de Producción`**.
11. **Corrección al `_CONTEXTO-BASE.md §7`** (el documento no se edita; vale este renglón): dice que
    `server/tests/fixtures/` "no existe todavía". **Sí existe** y ya tenía tres archivos antes de
    L01. No hubo colisión de nombres, pero no vayas a crear la carpeta creyendo que la estrenas.
12. **`parsearVector` es estricto a propósito** (para L07 y para cualquiera que arme un vector):
    tolera espacios (`' 4, 2 ,2,…'`) pero rechaza ceros a la izquierda (`'01'`), decimales y
    negativos, para que `serializarVector(parsearVector(t)) === t` sea exacto. Si la pantalla arma el
    vector desde ocho selectores de 1..4 esto no se nota nunca; si lo arma a mano, que no rellene con
    ceros.
13. **El oráculo del Excel NO protege de la aritmética de fechas frágil** (medido en L01): con
    `new Date(str)` los 1.460 pares pasan igual, porque el offset se cancela en los dos extremos. Lo
    que protege es el **parsing estricto**. Si alguien "simplifica" `msDelDiaIso`, el test que se
    pone rojo es el de parsing, no el del oráculo — no lo toques.

## 7. Hallazgos consolidados (deduplicados entre lotes)

| # | Origen | Hallazgo | Severidad | Destino |
|---|---|---|---|---|
| H1 | L03 | `utils/errores.js` no clasifica `entra_no_disponible` → habría salido 500, no el 503 de CA-6 | media | **Arreglado en el gate** (D2), con test y verificador bidireccional |
| H2 | L02 | `puede_configurar_rotacion` no viaja en la sesión ni en `/api/me`; la pantalla de L07 nunca aparecería, sin error | media | **L04 en la O2** (D3): territorio ampliado con `middleware/auth.js` + `utils/sesion-contexto.js` |
| H3 | L03 | El `turno-sweeper` y el `mand-sweeper` arrancan bajo `AUTH_TEST_BYPASS=1`: cada backend de lote abre cabeceras `turno_unidad` en GEC3/GEC32. Convención 37(b) de D-064 aplicada a medias | media | **Fuera de alcance de D-065** (D4). Deuda heredada, al runbook del cierre |
| H4 | seguridad (gate) | `sincronizarDirectorio({ directorio })` salta Graph: si L04 dejara llegar ahí algo del cliente, sería escalada a `es_jefe_planta` vía `azure_upn` → `enforceSingletonFlag` | media (hacia adelante; hoy no explotable: no hay endpoint) | **Prohibición explícita en §6.5** para L04 |
| H5 | L01 | El oráculo no distingue la aritmética de fechas correcta de la frágil; lo que protege es el parsing estricto | baja | Hecho §6.13 + al ADR |
| H6 | L03 | `auth/provision.js` tiene la misma exposición de `UNIQUE` en `username` que L03 resolvió con el fallback al `azure_oid`: si el UPN de alguien ya lo ocupa una fila legacy, su primer login falla | baja (sospecha, no reproducida) | Deuda, al runbook del cierre. **No** se toca en D-065: es `auth/`, y ningún CA lo cubre |
| H7 | L02 | `GET /api/catalogos/cargos` proyecta solo 4 columnas del cargo; si una pantalla de la O3 quisiera mostrar quién puede configurar, habría que ampliarlo | baja | Sin destino: hoy ninguna superficie del §5.5 lo pide. Anotado para que no se descubra tarde |
| H8 | L01 | El periodo del Excel dura 365 días y **no** incluye un 29 de febrero: el patrón nunca se ejercitó contra un bisiesto sobre datos medidos | informativa | Zona sin oráculo, no defecto. Al ADR; rehacer la costura cuando se cargue 2028-02-01…2029-01-31 |
| H9 | L03 | La BD de dev tiene 111 filas en `lov_bit.usuario` y solo 11 con `azure_oid`: la primera sincronización real crearía ~78 filas | informativa | Confirma que el MERGE por `azure_oid` es lo correcto. **Nadie debe "limpiar" las legacy** |

### Del `/code-review` (triados por el gate contra el código)

Destino `L11` = el lote de corrección de la decisión **D5**, sujeto al visto bueno.

| # | Archivo | Hallazgo | Veredicto del gate | Severidad | Destino |
|---|---|---|---|---|---|
| CR-1 | `graph/directorio.js` | El `WHEN MATCHED` pisa `azure_upn`/`azure_tid` con `NULL`; en el siguiente arranque `enforceSingletonFlag` degrada al Jefe de Planta | **confirmado**, cadena de fallo leída de punta a punta | **alta** | **L11** — `COALESCE(@upn, t.azure_upn)` y `COALESCE(@tid, t.azure_tid)` |
| CR-2 | `graph/directorio.js` | Un solo 404 (asignación a alguien borrado; Entra las conserva 30 días) o un 429 aborta la lectura de las 89 personas: no hay tolerancia por asignación ni `Retry-After` | **confirmado** | media | **L11** |
| CR-9 | `db.js` | `rotacion_cumplimiento.grupo` sin CHECK acepta `0`, `5`, `200` en un registro congelado. La premisa de L02 era falsa | **confirmado y medido contra la BD** | media | **L11** — `CHECK (grupo IS NULL OR grupo BETWEEN 1 AND 4)` vía `F37.A3`. Ya corregido en §6.7 |
| CR-6 | `db.js` | Sin guard de solapamiento: dos `rotacion_asignacion` vigentes a la vez para la misma persona, o dos `rotacion_patron` activos que cubren la misma fecha → "quién debía estar" tiene dos respuestas | **confirmado** (hueco del contrato C2, no error de L02) | media | **L11** |
| CR-7 | `db.js` | `rotacion_control.planta_id` y `rotacion_cumplimiento.turno_id` son redundantes con `turno_unidad` y nada los ata: una fila puede nombrar el turno de una planta y el `planta_id` de otra, y la pila LIFO devuelve vacío en silencio | **confirmado** — es el drift invisible de D-053(iii) otra vez | media | **L11** + advertencia a L05/L06 |
| CR-3 | `graph/directorio.js` | ~81 `MERGE … WITH (HOLDLOCK)` dentro de una sola transacción acumulan range locks: es el bloqueo de logins que el comentario de al lado dice estar evitando | **confirmado** en mecánica; impacto acotado (sincronización manual, esporádica, ~89 filas) | baja-media | **L11** — batch o commit por tramos |
| CR-13 | `graph/cliente.js` | La clave del cache del token omite el `client_secret`: rotarlo no invalida el token, se sigue sirviendo hasta 1 h el minteado con el secreto retirado | **confirmado** | baja-media | **L11** |
| CR-10 | `graph/cliente.js` | El guard `MAX_RESPUESTA_BYTES` es inerte: `Number(null) === 0` cuando falta `content-length`, y Graph responde chunked. Nunca dispara | **confirmado** por lectura | baja | **L11** — o se hace de verdad, o se quita y el comentario deja de prometerlo |
| CR-5 | `tests/rotacion_schema.test.js` | El test pone `puede_configurar_rotacion = 1` en un cargo REAL de prod (`Ingeniero Químico`) y confía en dos reversiones best-effort | **confirmado**, con atenuante: el MERGE lo repara en cada arranque, y L02 lo había declarado | baja-media | **L11** — y un check de cargos en `residuos.js` |
| CR-4 | `tests/rotacion_sync_entra.test.js` | Las filas que crea el MERGE quedan `es_sintetico = 0`, contra lo que dice la cabecera; `residuos.js` no mira `lov_bit.usuario` | **parcialmente refutado**: `limpiarFixture()` acota por GUID de fixture (más fuerte que `es_sintetico`) y corre también en el `before()` | baja | **L11** — corregir la cabecera + check en `residuos.js` |
| CR-11 | `tests/rotacion_sync_entra.test.js` | El `after()` restaura una env var no definida como el string literal `'undefined'` | **confirmado**; no cruza archivos (`node --test` da un proceso por archivo) | baja | **L11** |
| CR-14 | `tests/rotacion_schema.test.js` | Tres statements arman el `WHERE` por interpolación en vez de `.input()`, en un `UPDATE` contra el catálogo de producción | **confirmado**; no explotable hoy (constante de módulo) pero es el patrón que el repo ya eliminó | baja | **L11** |
| CR-15 | `db.js` | `[F37.A1] schema de rotación creado` se imprime aunque el DDL no haya creado nada, si alguien borró el flag a mano | **confirmado** | baja | **L11** |
| CR-8 | `rotacion/patron.js` | `derivarDesfase` no valida `grupoT1`/`grupoT2`: un `"3"` o un `""` sale como `desfase_imposible` ("esa combinación no existe en la malla") en vez de error de entrada | **refutado como defecto**: el cierre de L01 ya lo resolvió — `desfase_imposible` es la respuesta correcta del contrato — y ya había anotado la validación de rango como trabajo de L04 | baja | **L04** (mensaje al administrador), sin tocar el motor |
| CR-12 | `graph/directorio.js` | Lectura de Graph secuencial (~15 round-trips) y refetch redundante de quien ya se conoce | **no es defecto**: eficiencia | informativa | Sin destino; anotado |

## 8. Ola siguiente

- **Prompts enmendados en cabecera** ("ENMIENDAS Y HECHOS QUE CAMBIAN — léelas antes que el resto"),
  con el §6 copiado tal cual: `L04-endpoints-configuracion.md`, `L05-toma-de-control.md`,
  `L06-cumplimiento.md`.
- **Reparto revisado — dos cambios**, los dos ya escritos en `PLAN-OLAS.md` y `LOTES.json`:
  1. **L04 amplía territorio** con `server/middleware/auth.js` y `server/utils/sesion-contexto.js` (D3).
  2. **La O2 pasa de 3 a 4 lotes** con `L11`, el lote de corrección (D5). Queda en `pending` dentro de
     una ola `pendiente`, así que **nadie puede reclamarlo** hasta el `ola-abrir O2` — que solo ocurre
     con el visto bueno. Si el visto bueno lo rechaza, se retira con una enmienda encima de este
     expediente.

  Lo que **no** cambió: las dependencias de L04/L05/L06, sus puertos (3114/3115/3116) y los siete
  contratos del `_CONTEXTO-BASE.md`.
- **Visto bueno del usuario:** {{pendiente}}.

| Lote | Título | Territorio |
|---|---|---|
| L04 | Endpoints de configuración anual (superficie A) | `routes/rotacion.js` · `utils/rotacion/titulares.js` · `auth/app.js` · **`middleware/auth.js`** · **`utils/sesion-contexto.js`** · `tests/rotacion_endpoints.test.js` · puerto 3114 |
| L05 | Toma de control del rol (superficie B, backend) | `routes/rotacion-control.js` · `utils/rotacion/control.js` · `tests/rotacion_control.test.js` · puerto 3115 |
| L06 | Cumplimiento y congelado al cerrar (superficie C, backend) | `routes/rotacion-cumplimiento.js` · `utils/rotacion/cumplimiento.js` · `utils/turno-entidad.js` · `tests/rotacion_cumplimiento.test.js` · puerto 3116 |
| L11 ⭑ | Correcciones de la O1 (schema, cliente de Graph y tests) | `db.js` · `utils/graph/cliente.js` · `utils/graph/directorio.js` · `tests/rotacion_correcciones.test.js` · `tests/rotacion_schema.test.js` · `tests/rotacion_sync_entra.test.js` · `tests/residuos.js` · puerto 3117 |

⭑ Lote nuevo, abierto por este gate (D5). **Sin dependencias y sin dependientes**: se puede abrir su
chat a la vez que los otros tres.

## 9. Commit del gate

`2ab576b` `gate(D-065): O1 cerrada — 3 lotes, 781/781 backend, 324/324 front, 0 violaciones`
