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
| `auth_reactivate.test.js` | Reactivación de eventos AUTH en `evento_dashboard` (GET + DELETE canónicos). Reescrito en D4. |
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
| D4 | **RESUELTO 2026-05-13** — `auth_reactivate.test.js` reescrito para usar `/api/eventos-dashboard?tipo=AUTH` (GET) y `/api/eventos-dashboard/:id` (DELETE). Endpoints legacy `/api/autorizaciones*` siguen vivos con warn deprecado; remover en próxima fase si nada más los usa. | — | — |
| D5 | **RESUELTO 2026-05-13** — A5/B2 ahora usan `fecha_evento` UTC determinística (2026-05-10). El root cause real (descubierto durante el fix) era que `TEST_TAG` contenía `[brackets]` interpretados por SQL Server como wildcards de conjunto en LIKE; `cleanupTestRegistros` nunca limpiaba registros tagged y los asserts con `LIKE %TEST_TAG%` fallaban silenciosamente. Fix: `TEST_TAG` sin corchetes en `helpers.js` + cleanup de `mand_cierre_log` con guard `fecha_cerrada >= 2026-05-01`. | — | — |
| D6 | `auth_middleware.test.js` 7/9 (cierre Ing. Operación / JdT) fallan a veces | Baja | Aparentemente dependiente del orden — investigar timing del setup de permisos. |
| D7 | Sin fake clock en server-side flow | Alta para test exhaustivo, baja para regresión actual | Refactor del server para inyectar `clock` o usar TZ-agnostic helpers en todas las queries. |

Las fallas D4-D6 son pre-existentes a F19+F20+F21 (verificadas en baseline `git stash` durante F20). F21 NO introduce regresiones nuevas; el conteo total de fails con suite completa post-F21 sigue siendo 9 (mismo que baseline).

## Tests del frontend (root)

`Bit-cora-g3/package.json` agrega `npm test` con vitest (F21.D). Cubren `src/utils/fecha.js` y la convención canónica `Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Bogota' })` + offset `-05:00` que viven inline en `BitacorasGecelca3.jsx` y `CambiarEstadoModal.jsx`. Si el patrón cambia en el callsite, el test rompe y obliga a re-auditar.

```bash
cd Bit-cora-g3
npm test
```

> **Nota de install:** durante F21 el `npm install` desde la red corporativa colgó (proxy o firewall corporativo cortando los binarios nativos de rollup/esbuild). Quedó resuelto cambiando a datos móviles — `added 35 packages in 15s` y `15/15` tests verdes. Si en otro equipo el install se cuelga, validar con `npm config get registry` que apunte a un mirror que tenga vitest 3.x cacheado, o usar conexión sin firewall corp.
