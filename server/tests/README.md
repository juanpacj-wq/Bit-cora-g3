# Tests del backend Bit-cora-g3

Suite de tests con `node --test` nativo (Node 20+). Corren en serie con `--test-concurrency=1` para evitar carreras sobre el mismo registro de prueba.

## Cómo correrlos

```bash
# Suite completa (necesita MSSQL accesible vía .env y server escuchando en 3002).
cd Bit-cora-g3/server
npm test

# Un archivo aislado.
node --env-file=../.env --test --test-concurrency=1 tests/fechas_bogota.test.js

# Override de TZ del host (sanity de TZ-agnosticismo). Node solo respeta TZ al arranque,
# por eso fechas_bogota.test.js usa sub-procesos con env vars distintos para validar.
TZ=Asia/Tokyo npm test
TZ=America/Bogota npm test
TZ=UTC npm test
```

## Estructura

| Archivo | Cobertura |
|---|---|
| `fechas_bogota.test.js` | F21.A: helpers `turno.js` (`periodoFromFechaBogota`, `fechaBogotaStr`, `fechaBogotaIso`, `turnoFromPeriodo`, `ventanaTurno`, `getTurnoColombia`) — unit + sub-procesos con TZ alterno. |
| `auth_middleware.test.js` | Middleware de sesión + permisos por cargo. |
| `auth_reactivate.test.js` | Reactivación de autorizaciones (deprecado post F18 — leak conocido, ver §Deuda). |
| `disponibilidad.test.js` | F12-F14: bitácora DISP (vigente, histórico, deshacer, edit, permisos). |
| `cierre_y_fechas.test.js` | F13.3: regresiones bug A (cierre arrastraba DISP) y bug B (`creado_en` consistente UTC). |
| `sala_de_mando_batch.test.js` | F16-F17: batch save MAND + cierre-diario + F21.B regresión T1 (madrugada Bogotá) + F21.C CIET fecha_cerrada Bogotá. |

## Convención TZ-agnóstica (post F19+F20+F21)

**Regla:** todo helper de fecha en backend (`server/utils/turno.js`, `mand-sweeper.js`, `ciet.js`) usa offset puro `-5h` con `getTime()` y `getUTC*()` — NUNCA `getHours()`, `getMonth()`, `toLocaleString` ni `getTimezoneOffset()`. Colombia no tiene DST, el offset puro es seguro.

**Validación:** los tests de helpers (`fechas_bogota.test.js`) corren un sub-proceso con `TZ=UTC|America/Bogota|Asia/Tokyo|America/New_York` y assertean output idéntico — si un helper introduce dependencia del TZ del host, el sub-proceso devolverá distinto y el test rompe.

**Stubear `Date.now()`:** los tests de integración HTTP NO pueden mockear el reloj del servidor (proceso separado). Para cubrir el flujo de la madrugada Bogotá (post 19:00, donde UTC ya es día siguiente), `sala_de_mando_batch.test.js` test 9 inserta un `registro_activo` directo con `fecha_evento` calculado vía `new Date(\`${HOY}T22:30:00-05:00\`)` y consulta el endpoint GET. Eso ejerce el predicado SQL `CAST(DATEADD(HOUR, -5, fecha_evento) AS DATE) = @fecha_bogota` sin necesidad de fake clock en el server.

## Patrones a respetar al agregar tests

1. **Reusar `helpers.js`:** `setupSessions`, `cleanupTestRegistros`, `call`, `TEST_TAG`, `PLANTA_ID` están centralizados. No duplicar lookup de bitácora ni inserción de usuarios.
2. **Marcar registros con `TEST_TAG`** en `detalle` para que `cleanupTestRegistros` los borre. Si el registro no acepta `detalle` (CIET emitido por sweeper, etc.), borrarlo explícitamente al final del test.
3. **Cleanup explícito** en `before/after`: las tablas con UNIQUE constraints (`mand_cierre_log` (planta, fecha)) deben limpiarse para que tests re-corran de un día al siguiente.
4. **Date.now() mock:** Node 20 permite `mock.method(Date, 'now', () => fixedMs)` — restaurar en `finally`. Solo afecta el proceso del test, NO el servidor.
5. **Subprocess para TZ:** la única forma de testear TZ override en el handler es lanzar el server en sub-proceso con `TZ` distinto. Hoy no se hace — deuda en §Deuda.

## Deuda conocida

| # | Item | Severidad | Plan |
|---|---|---|---|
| D1 | Sin tests de componentes con RTL (`HistoricoTable`, `EstadoActualCard`, `BarraEstado`, `SalaDeMandoGrid`) | Media | F22 si queda tiempo. Hoy se cubre solo `utils/fecha.js` vía vitest. |
| D2 | Sin CI matrix en GH Actions (3 TZ jobs) | Media | El repo no tiene `.github/workflows/`. Se documenta como deuda; cuando se monte CI, agregar TZ matrix. |
| D3 | Sin tests E2E con Playwright TZ override del navegador | Baja | Costo alto, beneficio marginal mientras todos los operadores estén en Bogotá (decisión C1=A en `preguntasfecha.md`). |
| D4 | `auth_reactivate.test.js` falla post F18 (endpoints `/api/autorizaciones*` quedaron deprecados) | Media | Reescribir o quitar; los tests apuntan a un endpoint con shim de warn. |
| D5 | `cierre_y_fechas.test.js` A5/B2 fallan por leftover `mand_cierre_log` o estado de prev runs | Media | Hardener cleanup en `before` global. |
| D6 | `auth_middleware.test.js` 7/9 (cierre Ing. Operación / JdT) fallan a veces | Baja | Aparentemente dependiente del orden — investigar timing del setup de permisos. |
| D7 | Sin fake clock en server-side flow | Alta para test exhaustivo, baja para regresión actual | Refactor del server para inyectar `clock` o usar TZ-agnostic helpers en todas las queries. |

Las fallas D4-D6 son pre-existentes a F19+F20+F21 (verificadas en baseline `git stash` durante F20). F21 NO introduce regresiones nuevas; el conteo total de fails con suite completa post-F21 sigue siendo 9 (mismo que baseline).

## Tests del frontend (root)

`Bit-cora-g3/package.json` agrega `npm test` con vitest (F21.D). Cubren `src/utils/fecha.js` y la convención canónica `Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Bogota' })` + offset `-05:00` que viven inline en `BitacorasGecelca3.jsx` y `CambiarEstadoModal.jsx`. Si el patrón cambia en el callsite, el test rompe y obliga a re-auditar.

> **Setup pendiente:** durante F21 el `npm install` colgó >30min (probable issue de red/proxy en el entorno de desarrollo) y vitest quedó listado en `devDependencies` sin instalar. El `vitest.config.js` y `src/utils/fecha.test.js` ya están commiteados; correr `npm install` cuando la red esté disponible y luego:

```bash
cd Bit-cora-g3
npm test
```
