# D-040 — Contexto base (compartido por todas las etapas)

> Bloque de contexto acumulado que cada prompt de etapa referencia. **Inmutable** una vez
> cerrada la planificación: si algo cambia en ejecución, va a `ESTADO.md` (desviaciones).
> Léelo completo al iniciar cualquier etapa, junto con `ESTADO.md`.
> Repo: `Bit-cora-g3/` (git independiente; React 19 + Vite front, Node ESM + Express backend
> puerto 3002, MSSQL con `useUTC=true`, esquemas `lov_bit` + `bitacora`).
> **Branch sugerido del flujo:** `feat/D-040-finalizar-turno-revertible` (crearlo en E1 si no
> estás en él; hoy el repo está en `sec/audseg-remediation`).

## Objetivo
Arreglar y blindar la funcionalidad **"Finalizar Turno"** de las bitácoras: un ingeniero
declara que terminó de registrar en su turno, puede **revertir** libremente si se equivocó, y
mientras esté finalizado se **inhibe crear/editar registros en bitácoras genéricas** (MAND,
DISP y COMB siguen operables). Ver bitácoras NUNCA debe reponerlo como "pendiente". No toca
contratos cross-repo (no se altera `evento_dashboard`/`disponibilidad_dashboard` ni
`GET /api/eventos-dashboard`).

## Fuentes / insumos — causa raíz auditada (con evidencia)
`bitacora.sesion_bitacora.finalizada_en` está **sobrecargada**: mezcla *presencia
por-bitácora* con *finalización de turno* (decisión única por-usuario-por-turno). De ahí:

1. **Bug visible:** `POST /api/bitacora/abrir` (`server/routes/bitacora.js:36-45`), disparado
   por `useBitacoraSesion` (`src/hooks/useBitacoraSesion.js:7-12`) en CADA apertura/cambio de
   bitácora (invocado con `activeBitacora` en `src/BitacorasGecelca3.jsx:1665`), hace
   `MERGE ... WHEN MATCHED THEN UPDATE SET finalizada_en = NULL` (`bitacora.js:39`). Como
   `ingenieros_no_finalizados` filtra `sb.finalizada_en IS NULL` (`cierre.js:87`), **ver una
   bitácora des-finaliza el turno** y el ingeniero reaparece como pendiente.
2. **Estado client-only:** `turnoFinalizado` sale 100% de `localStorage`/`shiftInstanceId`
   (`src/BitacorasGecelca3.jsx:130-135, 1694-1704`); nunca consulta el backend → diverge
   tras F5 y tras el reset de `/abrir`.
3. **No hay revertir:** el único camino a NULL es el reset accidental de `/abrir`.
4. **Finalizar no inhibe registrar:** `req.sesion` (`SELECT_SESION`,
   `server/middleware/auth.js:24-31`) no trae la columna; los POST solo chequean
   `hasPermisoBitacora(...,'puede_crear')` + `plantaMatch`.

## Destino en BD (lo que ya existe)
- `bitacora.sesion_activa` (`server/db.js:451-460`; +`cerrada_en` en el ALTER ~`:487-488`):
  PK `sesion_id`, `usuario_id, planta_id, cargo_id, turno, inicio_sesion, ultima_actividad,
  activa BIT DEFAULT 1, cerrada_en`. Es la **sesión de app** (D-031). D-035 garantiza **una
  sola `activa=1` por usuario** (`select-context` desactiva las demás, `sesion.js:81-85`).
- `bitacora.sesion_bitacora` (`server/db.js:513-526`): PK, `sesion_id FK→sesion_activa`,
  `bitacora_id FK`, `abierta_en`, `finalizada_en NULL`, `UNIQUE(sesion_id,bitacora_id)`,
  índice filtrado `WHERE finalizada_en IS NULL`. Presencia por-bitácora.
- Bloque paridad TZ Bogotá en `db.js` (~`:1497-1565`; `sesion_activa` ya tiene
  `inicio_sesion_bogota`, `ultima_actividad_bogota`, `cerrada_en_bogota`).
- Bitácora **CIET** (`oculta=1`, `db.js:801`): eventos de auditoría escritos por
  `server/utils/ciet.js`. Tipos sembrados en `db.js` (~`:1078-1090` está el de 'Deshacer
  disponibilidad', mismo patrón para el nuevo).
- Patrón de migración idempotente del subrepo: `IF COL_LENGTH(...) IS NULL ALTER TABLE ...`
  y `IF NOT EXISTS (SELECT 1 FROM sys.columns ...)` para columnas calculadas; corren en cada
  arranque dentro de `initDB()`.

## Endpoints existentes (lo que se toca)
- `POST /api/bitacora/abrir` (`bitacora.js:17-46`): UPSERT de presencia. **Queda igual** (su
  reset de `finalizada_en` deja de importar para la finalización).
- `POST /api/bitacora/finalizar` (`bitacora.js:50-88`): hoy UPDATE `sesion_bitacora` de todas
  las del usuario + CIET `tipo:'finalizacion'`. **Se reescribe** para setear la columna nueva.
- `POST /api/bitacora/finalizar-forzado` (`bitacora.js:91-149`, gated `puedeCerrarTurno`):
  fuerza finalización de usuarios objetivo. **Se extiende** para setear la columna nueva.
- `GET /api/bitacora/usuarios-en-bitacora` (`bitacora.js:152-179`): presencia por bitácora
  (`finalizada_en IS NULL`). **No se toca** (presencia sigue en `sesion_bitacora`).
- `GET /api/cierre/preview-masivo` (`cierre.js:52`, gated `puedeCerrarTurno`+`plantaMatch`):
  devuelve `bitacoras_pendientes` + `ingenieros_no_finalizados` (`:77-98`). **Se corrige** el
  criterio de "no finalizado".
- `GET /api/me` (via `loadByOid`) y `POST /api/sesion/select-context` (`sesion.js`): exponen
  la sesión al front. **Se extienden** para traer la columna nueva.
- Escritura de registros genéricos: `POST/PUT/DELETE /api/registros` (`registros.js`; rama
  genérica `:227-392`/`:395-685`/`:688-712` vs. rama DISP `:115-225`). El **write-gate** solo
  aplica a la rama **genérica**.

## Patrones de infraestructura a reutilizar
- **Transacción MSSQL:** `const tx = new sql.Transaction(pool); await tx.begin(); ... commit`
  ya usado en `bitacora.js:52-88`. El CIET va dentro de la misma transacción.
- **CIET:** `server/utils/ciet.js::registrarEventoCierre(tx, { tipo, sesion, forzado, motivo })`.
  Mapea `tipo` → `TIPO_NOMBRE` (`:6-9`). Reusa snapshots. Añadir `reapertura` al map habilita
  el evento sin duplicar código.
- **Saneamiento de errores (D-032):** `server/utils/errores.js` (`responderError`/
  `mensajeUsuario`) para el shape `{error, codigo, mensaje}`. El write-gate responde 409 con
  `codigo:'turno_finalizado'`. NUNCA devolver `err.message` crudo.
- **Middleware de ruta:** `server/routes/_middleware.js` (`loadAppSession` setea `req.sesion` o
  401; `asyncH` enruta throws; `requireEntra` allowlist). El guard de escritura se define acá.
- **Permisos:** `server/middleware/permissions.js` (`hasPermisoBitacora`, `puedeCerrarTurno`,
  `plantaMatch`, `canEditarRegistro`). El helper `turnoFinalizado(sesion)` se agrega acá.
- **Tests:** `server/tests/helpers.js` (`setupSessions`, bypass `AUTH_TEST_BYPASS=1` +
  `X-Sesion-Id`), planta de test **`'TST'`** (D-030) — sembrar y operar SOLO sobre ella,
  nunca GEC3/GEC32. Correr: `cd server && node --test --env-file=../.env tests/`.
  **Baseline conocido:** `T4/C5` (tiebreaker de cierre cronológico CALDERA) puede figurar
  rojo/flaky en `main` (documentado); el resto verde (~76/77). No degradar más allá de eso.
- **Front:** `useAuth.js` (patrón `sesionRef`/`persistAuth` para persistir la sesión),
  `useApi.js` (`api.post`), toasts (`showToast`), modal de confirmación (`setModal`).

## Diseño D-040 (acordado)

### Schema nuevo / cambios de BD (migración idempotente en `db.js`)
- `ALTER TABLE bitacora.sesion_activa ADD turno_finalizado_en DATETIME2 NULL` (guard
  `IF COL_LENGTH(...) IS NULL`).
- Columna calculada `turno_finalizado_en_bogota AS DATEADD(HOUR,-5,turno_finalizado_en)`
  (guard `IF NOT EXISTS (SELECT 1 FROM sys.columns ...)`).
- Seed `INSERT` de `tipo_evento` **'Reapertura de turno'** en la bitácora `codigo='CIET'` si
  no existe (mismo patrón que 'Deshacer disponibilidad').

### Lógica núcleo
- **Fuente única de finalización:** `sesion_activa.turno_finalizado_en` (NULL = turno vivo;
  no-NULL = finalizado). Revertible. Muere sola: el sweeper expulsa `activa=0` a fin de turno
  y `select-context` crea/reactiva sesión fresca con la columna en NULL.
- **`sesion_bitacora.finalizada_en` = SOLO presencia** (la gestionan `/abrir` y el sweeper).
- **Write-gate (solo genéricas):** si `turno_finalizado_en` no-NULL → 409 `turno_finalizado`
  en `POST/PUT/DELETE` de la rama genérica de `registros.js`. NO en DISP/MAND/COMB.
- **Revertir = self-service:** cualquier ingeniero limpia SU propia columna; sin permiso
  especial. Emite CIET `reapertura`.
- **Idempotencia:** UPDATEs con guarda `IS NULL`/`IS NOT NULL`; CIET solo si hubo fila
  afectada (doble finalizar / doble revertir no duplican evento).

### Endpoints nuevos / cambios
- Reescribe `POST /api/bitacora/finalizar` → columna + CIET (solo si cambió).
- **Nuevo `POST /api/bitacora/revertir-turno`** → columna a NULL + CIET `reapertura` (self).
- Extiende `POST /api/bitacora/finalizar-forzado` → setear columna del objetivo.
- Corrige `ingenieros_no_finalizados` en `cierre.js` → filtro por
  `sa.activa=1 AND sa.turno_finalizado_en IS NULL`, conservando `bitacoras_abiertas` vía
  `OUTER APPLY` a `sesion_bitacora`.
- `SELECT_SESION` (`auth.js`) + `select-context` (`sesion.js`) exponen la columna; reset a
  NULL en la rama de **reactivación** de `select-context` (turno nuevo).

### Front
- Elimina `localStorage`/`shiftInstanceId`; deriva `turnoFinalizado` de
  `sesion.turno_finalizado_en`. `patchSesion` en `useAuth` refleja finalizar/revertir sin
  refetch; F5 rehidrata por `/api/me`.
- Botón header togglea a **"Revertir finalización"** + banner cuando finalizado.
- Gate de UI **acotado a genéricas**: `puede_crear && !turnoFinalizado` SOLO en el botón
  "Nuevo Registro" genérico (`:1192`) y el prop `puedeCrear` de `GrillaRegistros`.
  MAND/DISP/COMB reciben el `puede_crear` crudo.

## Convenciones a respetar
- **TZ canónica:** BD en UTC (`SYSUTCDATETIME()`), presentación Bogotá explícita; paridad
  `*_bogota` obligatoria para cada `DATETIME2`.
- **Migraciones idempotentes** dentro de `initDB()`; re-arranque no debe fallar.
- **Saneamiento de errores (D-032):** shape `{error, codigo, mensaje}`, nunca `err.message`.
- **Auth por defecto (D-037):** endpoint nuevo nace cerrado tras `requireEntra` +
  `loadAppSession`; no agregar a la allowlist pública.
- **No romper contratos cross-repo** ni tocar DISP/MAND/COMB en el bloqueo.
- **Tests contra planta `'TST'`** (D-030), nunca GEC3/GEC32.
- Idioma de todo artefacto y comentario: **tuteo colombiano estándar, sin voseo**.
