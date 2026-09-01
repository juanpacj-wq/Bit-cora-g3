# D-065 — Contexto base (compartido por todos los lotes)

> **Inmutable** una vez cerrada la fase de planificación (2026-08-31). Cada prompt de lote
> referencia **secciones concretas** de este archivo; ningún lote lo relee entero ni lo edita. Si
> algo de acá cambia durante la ejecución, se registra en el cierre del lote y el gate lo propaga
> como "hecho que cambia" en `GATE-On.md`.
>
> Repo: `Bit-cora-g3/` (git independiente; React 19 + Node ESM + MSSQL, backend en `:3002`).
> Rama del flujo: **`feat/rotacion-turnos-2026-08`**, nacida de **`feat/integrar-asientos-D-059`**
> (la rama de integración vigente según `../docs/deployment-unificado.md`, SHA base `5cc84a2`).

---

## 1. Objetivo

Construir el módulo **Rotación de Turnos**: la app ya sabe **quién estuvo** en cada turno
(`turno_participante` / `conformacion_turno`, D-045); este módulo aporta **quién debía estar**.

Tres superficies, y ninguna más:

- **A · Configuración anual** — se usa una vez al año. Patrón por rol + asignación de grupo por
  persona. De ahí sale el titular de cualquier fecha, **sin materializar días**.
- **B · Popup de toma de control** — aparece al iniciar sesión, solo a quien aplica.
- **C · Vista de cumplimiento** — consulta de solo lectura.

**Mandato de simplicidad (del requerimiento, §2):** si aparece una cuarta pantalla o una tarea
recurrente, el diseño se desvió. Cero intervención entre una carga anual y la siguiente (CA-23).

**Fuera de alcance, explícitamente:** vacaciones y supernumerarios como entrada obligatoria (una
persona sin grupo YA es supernumeraria); el análisis de coincidencias operador↔jefe de turno (queda
**habilitado y no cerrado por diseño**, pero no se implementa); cualquier cambio a MAND, DISP, COMB,
F03 o al despacho XM de D-064.

**No toca contratos cross-repo.** `evento_dashboard` y `disponibilidad_dashboard` quedan intactas;
`../docs/interfaces-cross-repo.md` **no cambia** en este flujo.

---

## 2. Fuentes / insumos

| Insumo | Dónde | Para qué |
|---|---|---|
| Documento del requerimiento (12 secciones) | Prompt de la Fase 1 · copia en `prompts/rotacion-turnos/PROMPT.txt` (sin trackear) | Alcance y semántica |
| **Oráculo del Excel** | `prompts/D-065-rotacion-turnos/oraculo-rotacion-2026.json` | CA-1: los 730 pares `(fecha, turno)` verificados |
| `Rotacion2026.xlsx` | Raíz del umbrella `PORTAL GENERACIÓN/` | Fuente del oráculo. **Ningún lote necesita abrirlo**: ya está volcado |
| Directorio de Entra ID | Microsoft Graph, `client_credentials` | Personas + rol (la cuadrilla real) |
| Legacy NestJS/Mongo | `C:\Users\jcespedes\Documents\Code\legacy` | **NO consultar.** Descartado por el usuario (§3 del requerimiento) |

### 2.1 Validaciones del dominio ya hechas (no repetirlas)

Medidas el 2026-08-31 sobre `Rotacion2026.xlsx`, 365 días × 2 mallas:

- **0 discrepancias** entre `V[((fecha − ancla) + desfase) % 8]` y el Excel, con
  `ancla = 2026-02-01`, `desfase OPS = 3`, `desfase ING = 2`.
- **0 rupturas** de continuidad nocturna (el T2 de un día empalma con la madrugada del siguiente).
- **0 violaciones** de la periodicidad de 8 días.
- El año de la malla **no es calendario**: va del **1-feb al 31-ene** siguiente.

### 2.2 Vectores del patrón (dato duro)

```
OPS  T1 [06:00-18:00) = [1, 1, 3, 3, 4, 4, 2, 2]     desfase 3 sobre ancla 2026-02-01
OPS  T2 [18:00-06:00) = [4, 2, 2, 1, 1, 3, 3, 4]

ING  T1 [06:00-18:00) = [1, 1, 2, 2, 4, 4, 3, 3]     desfase 2 sobre ancla 2026-02-01
ING  T2 [18:00-06:00) = [4, 3, 3, 1, 1, 2, 2, 4]
```

**Gotcha medido, y es el corazón de CA-2:** los 8 pares `(V1[i], V2[i])` son **todos distintos**,
pero `V1` por sí solo toma **4 valores distintos en 8 índices**. Preguntarle al administrador
únicamente "qué grupo arranca" deja **dos** desfases posibles. Por eso la UI pide **fecha de inicio
+ grupo de T1 + grupo de T2 de ese día**, y el motor resuelve el desfase único. Nunca se le pide
"ancla" ni "desfase" (requerimiento §4).

### 2.3 Entra ID (medido contra el tenant real, 2026-08-31)

SP `LOGIN_PORTAL_GENERACIÓN` (`appId 6730b1e5-9465-4a7c-b0f6-ff85acc99189`),
`appRoleAssignmentRequired = true`, 14 App Roles, **13 grupos + 1 usuario directo**.

| Grupo de Entra | App Role | Miembros |
|---|---|---|
| INGENIERO JEFE DE TURNO | `JEFE_DE_TURNO` | 7 |
| INGENIERO DE OPERACIÓN | `INGENIERO_OPERACION` | 14 |
| INGENIERO QUÍMICO | `INGENIERO_QUIMICO` | 2 |
| OPERADOR DE PLANTA - SALA DE MANDO | `OPERADOR_PLANTA_SDM` | 9 |
| OPERADOR DE PLANTA - CALDERA | `OPERADOR_PLANTA_CALDERA` | 9 |
| OPERADOR DE PLANTA - TURBOGRUPO | `OPERADOR_PLANTA_TURBOGRUPO` | 9 |
| OPERADOR DE PLANTA - CARBÓN Y CALIZA | `OPERADOR_PLANTA_CYC` | 9 |
| OPERADOR DE PLANTA- PLANTA DE AGUA | `OPERADOR_PLANTA_PDA` | 9 |
| OPERADOR DE PLANTA - MAQUINARIA | `OPERADOR_PLANTA_MAQUINARIA` | 9 |
| OPERADOR DE PLANTA - ANALISTA | `OPERADOR_PLANTA_ANALISTA` | 6 |
| USUARIOS DE CONSULTA PORTAL GENERACIÓN | `USUARIO_CONSULTA` | 6 |
| COORDINADOR DE CARBÓN Y MAQUINARIA | `COORDINADOR_CARBON_MAQUINARIA` | **0** |
| ADMINISTRADOR Y DEBUGGING | `ADMINISTRADOR_DEBUGGING` | **0** |
| *(asignación directa)* Ernesto Munoz Suarez | `GERENTE_PRODUCCION` | 1 |

**81 personas** en roles de rotación. Contra el Excel: **71 calzan**; de las 10 restantes, 6 son
typos del Excel (`Feliz`/Felix Oquendo, `Donaldo Cortez`/Cortes, `Meled`/Melecd Daza,
`Byron`/Bayron Jiménez, `Eduin`/Edwin Bello, `Hanner`/Haner Montiel) y 4 son diferencias reales.

**Riesgos ya identificados, no los redescubras:**
- `ADMINISTRADOR_DEBUGGING` está **vacío** y es uno de los dos cargos que pueden configurar la
  malla. Hoy la única persona que puede usar la superficie A es el Gerente de Producción.
- Prod tiene **13 personas duplicadas** en `lov_bit.usuario` (fila legacy `atafur` + fila Entra
  `atafur@GECELCA.COM.CO`). **Es un problema preexistente y NO se arregla en este flujo.** La
  defensa del módulo es que la sincronización y las asignaciones trabajan **solo sobre filas con
  `azure_oid`**: son las únicas que pueden loguear y por tanto aparecer en `turno_participante`.

---

## 3. Lo que ya existe (BD, endpoints, front)

> Los números de línea son del snapshot de planeación sobre `feat/integrar-asientos-D-059`
> (`5cc84a2`). **Confírmalos con Grep antes de editar.**

### 3.1 BD — tablas que este flujo LEE (y no modifica)

| Objeto | Dónde | Qué aporta |
|---|---|---|
| `bitacora.turno_unidad` | `server/db.js` (DDL) | Cabecera del turno real: `PROGRAMADO/ABIERTO/CERRADO`, `fecha_operativa`, `planta_id`, `turno`, `UQ_turno_unidad_natural (fecha_operativa, planta_id, turno)` |
| `bitacora.turno_participante` | `server/db.js` | Presencia viva por unidad: `turno_id`, `usuario_id`, `cargo_id`, `primer_ingreso`, `ultimo_egreso`, `presencia_acumulada_min`. `UQ (turno_id, usuario_id)` |
| `bitacora.conformacion_turno` | `server/db.js` | Snapshot congelado al cerrar. PK `(fecha_operativa, planta_id, turno, usuario_id)` |
| `lov_bit.cargo` | `server/db.js:470-505` (DDL) · `:864-888` (MERGE) | **El eje del modelo.** 14 filas; `solo_lectura`, `puede_cerrar_turno`, `puede_cambiar_unidad`, `es_observador` |
| `lov_bit.usuario` | `server/db.js` | `usuario_id`, `nombre_completo`, `azure_oid`, `azure_upn`, `azure_tid`, `activo`, `es_sintetico`. **NO tiene `cargo_id`** |
| `lov_bit.planta` | `server/db.js` | `GEC3`, `GEC32` + fixtures `TST` / `TSR` |

### 3.2 Backend — módulos que este flujo consume

| Archivo | Qué usa este flujo |
|---|---|
| `server/utils/turno.js` | `ventanaTurno(turno, fechaRef)` :59 · `fechaOperativaDePeriodo(fecha, periodo)` :49 · `fechaBogotaStr(input)` :112 · `getTurnoColombia()` :18 · `finalizacionVigente()` :100 |
| `server/utils/turno-entidad.js` | `cerrarTurno(pool, turno_id, {...})` **:257** — L06 engancha ahí el congelado · `resolverTurnoAbierto(pool, planta_id)` :144 · `marcarParticipante(...)` :543 |
| `server/utils/sesion-contexto.js` | `establecerContextoSesion(db, {...})` :65 — el chokepoint de login/cambio de unidad (D-054, D-059) |
| `server/utils/entra-roles.js` | `ROLE_TO_CARGO` :16 (App Role → `cargo.nombre`, 1:1 con los 14 cargos) · `PRECEDENCE` :39 |
| `server/utils/errores.js` | `responderError` / `mensajeUsuario` — **obligatorio** (D-032: nunca `err.message` crudo) |
| `server/routes/_middleware.js` | `loadAppSession` :90 · `asyncH` :156 · `esRutaPublica` :37 · `respTurnoCerrado` :132 |
| `server/auth/app.js` | Montaje de routers **:310-323**. Un endpoint nuevo se monta acá, **nunca** en `server.js` (D-037) |
| `server/tests/helpers.js` | `setupSessions({planta})` :215 · `TEST_TAG` :107 · `TEST_PLANTA` :12 · `call()` :151 · `cleanupTestRegistros()` :313 · `deactivateSyntheticSessions()` :128 |

### 3.3 Front — puntos de contacto

| Archivo | Qué es |
|---|---|
| `src/BitacorasGecelca3.jsx` (2.682 líneas) | Componente raíz: layout, routing por sección, montaje de modales (:23-25), `ConfirmModal` :197. **Solo L10 lo toca** |
| `src/routing/appRoute.js` | `parseHash` :54 · `buildHash` :97 · `SLUG_BY_CODIGO` :17. Rutas nuevas van acá (D-035) |
| `src/hooks/useApi.js` | Cliente HTTP: traduce el rechazo de `fetch` a `codigo:'sin_conexion'` |
| `src/hooks/useAuth.js` | Sesión del front; `patchSesion` |
| `src/components/TurnoTransicionModal.jsx` (147 líneas) | **Modelo a copiar** para el popup de L08 |
| `src/components/SeguimientoTurnos.jsx` | **Modelo a copiar** para la vista de cumplimiento de L09 |

### 3.4 Gating de permisos vigente

Data-driven desde `lov_bit.cargo` + `lov_bit.cargo_bitacora_permiso`, reconstruido **en cada
arranque** por el MERGE de `db.js:864`. El front lo consume por `/api/catalogos/permisos/:cargo_id`.
**Nunca se hardcodea un `cargo_id` ni un nombre de cargo en un endpoint ni en el front**
(convención 12 de `CLAUDE.md`).

---

## 4. Patrones de infraestructura a reutilizar

- **Transacción canónica:** `const tx = new sql.Transaction(pool); await tx.begin(); … await tx.commit()`
  con `try/catch` + `rollback`. Todo lo que deba ser atómico va en UNA transacción (ver
  `cerrarTurno` en `utils/turno-entidad.js:257` como referencia viva).
- **Migraciones:** idempotentes, gated por `bitacora.migracion_aplicada`. Patrón exacto en
  `server/db.js:2890` (`F33.A1`). El código se reserva en §7 de este documento; **un código repetido
  se salta en silencio** y es un fallo mudo.
- **Flags de cargo:** columna `ALTER TABLE … IF COL_LENGTH(...) IS NULL` (patrón `db.js:489`) **más**
  su valor en el `MERGE lov_bit.cargo` de `db.js:864`. Un `UPDATE` one-shot **no sobrevive al
  restart** (convención 27).
- **TZ:** BD en UTC (`SYSUTCDATETIME()`); presentación con `America/Bogota` explícito; comparación
  de día Bogotá en SQL con `CAST(DATEADD(HOUR, -5, columna) AS DATE)`. **Prohibido** `getHours()`
  sin shift, `toLocaleDateString()` para persistir, `getTimezoneOffset()`.
- **Errores:** todo camino 5xx pasa por `utils/errores.js`. Los 4xx de dominio exponen su slug a
  propósito (`turno_cerrado`, `titular_no_abandona`, …) porque el front ramifica por `codigo`.
- **Degradación de dependencia externa:** el patrón de D-047 (Gemini) — sin credencial o con el
  servicio caído, **503 con código estable** y el server sigue en pie. Nunca se tumba el arranque.
- **Tests:** `node:test`; cada lote corre **solo sus archivos** contra un backend efímero en su
  puerto (`SERVER_PORT=31NN AUTH_TEST_BYPASS=1`), bajo **test-lock** si toca BD. Fixtures con
  `TEST_TAG` y planta `'TST'`; **cero residuos**. Fechas determinísticas
  (`new Date('2026-05-10T14:00:00Z')`), nunca `new Date()` + `setHours()`.
- **Front:** vitest (`npm test` en la raíz), sin lock. `npm run build` antes de commitear.

---

## 5. Diseño acordado

### 5.1 Schema — migración `F37.A1` (tablas) y `F37.A2` (flag de cargo)

Las cuatro tablas viven en el esquema `bitacora`. Todas llevan sus columnas `*_bogota` computadas,
como el resto de D-045.

```sql
-- ── bitacora.rotacion_patron ── UNA FILA POR ROL Y PERIODO (decisión R14) ──
rotacion_patron_id  INT IDENTITY(1,1) PRIMARY KEY
cargo_id            INT          NOT NULL REFERENCES lov_bit.cargo(cargo_id)
fecha_inicio        DATE         NOT NULL          -- p.ej. 2026-02-01
fecha_fin           DATE         NOT NULL          -- p.ej. 2027-01-31
vector_t1           VARCHAR(32)  NOT NULL          -- '1,1,3,3,4,4,2,2'
vector_t2           VARCHAR(32)  NOT NULL          -- '4,2,2,1,1,3,3,4'
desfase             TINYINT      NOT NULL CHECK (desfase BETWEEN 0 AND 7)  -- DERIVADO, no se pide
activo              BIT          NOT NULL DEFAULT 1
creado_por          INT          NOT NULL REFERENCES lov_bit.usuario(usuario_id)
creado_en           DATETIME2    NOT NULL DEFAULT SYSUTCDATETIME()
CONSTRAINT UQ_rotacion_patron_natural UNIQUE (cargo_id, fecha_inicio)
CONSTRAINT CK_rotacion_patron_rango   CHECK (fecha_fin > fecha_inicio)

-- ── bitacora.rotacion_asignacion ── PERSONA → GRUPO, CON VIGENCIA (decisión R1) ──
rotacion_asignacion_id INT IDENTITY(1,1) PRIMARY KEY
usuario_id     INT       NOT NULL REFERENCES lov_bit.usuario(usuario_id)
cargo_id       INT       NOT NULL REFERENCES lov_bit.cargo(cargo_id)
grupo          TINYINT   NOT NULL CHECK (grupo BETWEEN 1 AND 4)
vigente_desde  DATE      NOT NULL
vigente_hasta  DATE      NOT NULL
creado_por     INT       NOT NULL REFERENCES lov_bit.usuario(usuario_id)
creado_en      DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
CONSTRAINT CK_rotacion_asig_rango CHECK (vigente_hasta >= vigente_desde)
INDEX IX_rotacion_asig_resolucion (cargo_id, vigente_desde, vigente_hasta) INCLUDE (usuario_id, grupo)

-- ── bitacora.rotacion_control ── LOG APPEND-ONLY: la pila LIFO se DERIVA de acá ──
rotacion_control_id INT IDENTITY(1,1) PRIMARY KEY
turno_id     INT          NOT NULL REFERENCES bitacora.turno_unidad(turno_unidad_id)
planta_id    VARCHAR(10)  NOT NULL REFERENCES lov_bit.planta(planta_id)
cargo_id     INT          NOT NULL REFERENCES lov_bit.cargo(cargo_id)
usuario_id   INT          NOT NULL REFERENCES lov_bit.usuario(usuario_id)
accion       VARCHAR(12)  NOT NULL CHECK (accion IN ('TOMAR','ABANDONAR','DESCARTAR'))
ocurrido_en  DATETIME2    NOT NULL DEFAULT SYSUTCDATETIME()
ocurrido_en_bogota AS DATEADD(HOUR, -5, ocurrido_en)
INDEX IX_rotacion_control_pila (turno_id, planta_id, cargo_id, rotacion_control_id)

-- ── bitacora.rotacion_cumplimiento ── CONGELADO al cerrar el turno ──
fecha_operativa   DATE          NOT NULL
planta_id         VARCHAR(10)   NOT NULL REFERENCES lov_bit.planta(planta_id)
turno             TINYINT       NOT NULL CHECK (turno IN (1,2))
cargo_id          INT           NOT NULL REFERENCES lov_bit.cargo(cargo_id)
cargo_nombre      VARCHAR(100)  NOT NULL       -- congelado (el nombre puede cambiar, D-052)
grupo             TINYINT       NULL           -- el que tocaba; NULL si el rol no tenía patrón
estado            VARCHAR(20)   NOT NULL CHECK (estado IN ('PENDIENTE','PARCIAL','COMPLETO','CUBIERTO_POR_RELEVO'))
titulares_json    NVARCHAR(MAX) NOT NULL       -- [{usuario_id, nombre, entro:bool}]
relevo_usuario_id INT           NULL REFERENCES lov_bit.usuario(usuario_id)
turno_id          INT           NOT NULL REFERENCES bitacora.turno_unidad(turno_unidad_id)
snapshot_en       DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
snapshot_en_bogota AS DATEADD(HOUR, -5, snapshot_en)
CONSTRAINT PK_rotacion_cumplimiento PRIMARY KEY (fecha_operativa, planta_id, turno, cargo_id)
```

**`F37.A2`** — `ALTER TABLE lov_bit.cargo ADD puede_configurar_rotacion BIT NOT NULL DEFAULT 0`
(patrón `db.js:489`) **más** la columna en el `MERGE lov_bit.cargo` de `db.js:864`, en `1` para
`'Administrador y Debugging'` y `'Gerente de Producción'` y en `0` para los otros doce.
**El `solo_lectura` del Gerente sigue en `1`: no se toca** (CA-4).

### 5.2 Lógica núcleo

**Resolución del titular** (pura, sin BD):

```
diaDelCiclo(patron, fechaOperativa) = ((fechaOperativa − patron.fecha_inicio).dias + patron.desfase) mod 8
grupoDeTurno(patron, fechaOperativa, turno)  = (turno === 1 ? patron.vector_t1 : patron.vector_t2)[diaDelCiclo]
```

`fechaOperativa` es el **día en que arrancó el turno**. Los periodos 1..6 de una grilla pertenecen
al T2 que arrancó el día anterior (D-055(b)); si algún lote necesita ir de periodo a turno, usa
`fechaOperativaDePeriodo` de `utils/turno.js`, **nunca** `inicio_nominal`/`fin_nominal` (los muta
`extenderTurno`, D-046).

**Derivación del desfase** (CA-2): dado `(vector_t1, vector_t2, grupo_t1, grupo_t2)`, buscar el
único `i ∈ 0..7` con `vector_t1[i] === grupo_t1 && vector_t2[i] === grupo_t2`.
0 soluciones → `desfase_imposible`. Más de 1 → `desfase_ambiguo`. **Jamás adivinar.**

**Titular de `(fecha, turno, cargo)`** = las asignaciones del `cargo_id` cuyo `grupo` es el de
guardia y cuya vigencia cubre la fecha. Un rol **sin patrón activo** no produce titulares (y su
gente no ve el popup).

**Materialización por planta:** el titular es **el mismo en GEC3 y GEC32** (decisión R3). El
cumplimiento sí se mide por planta.

**Pila de control (LIFO), derivada del log:**

```
eventos = rotacion_control WHERE (turno_id, planta_id, cargo_id) AND accion IN ('TOMAR','ABANDONAR')
          ORDER BY rotacion_control_id
pila = []
por cada evento:  TOMAR → push(usuario);  ABANDONAR → pop() si el tope es ese usuario
principal = pila.tope  ||  (pila vacía → el titular del patrón)
```

- El **fondo conceptual** es el titular que designó el patrón; **no está en el log** y por eso no
  puede abandonar (`409 titular_no_abandona`, CA-12): la pila nunca queda vacía.
- **Serialización real, no optimismo** (requerimiento §7). `TOMAR`/`ABANDONAR` corren dentro de una
  transacción que primero toma `sp_getapplock` con `@Resource = 'rotacion-control-<turno_id>-<cargo_id>'`,
  `@LockMode='Exclusive'`, `@LockOwner='Transaction'`, `@LockTimeout=5000`. Timeout → `409 control_ocupado`.
- `DESCARTAR` es el "No" del popup: no entra en la pila, solo apaga la pregunta en ese turno (CA-13).
- Con el turno `CERRADO` los tres verbos responden `409 turno_cerrado` (CA-14).

**Estados de cumplimiento** (por `(turno, planta, cargo)`, resueltos **por `usuario_id`**, CA-15/16):

| Estado | Condición |
|---|---|
| `PENDIENTE` | Ningún titular asignado aparece en `turno_participante` de ese turno |
| `PARCIAL` | Aparece al menos uno, faltan otros |
| `COMPLETO` | Aparecen **todos** los titulares (decisión R9) |
| `CUBIERTO_POR_RELEVO` | El principal vigente **no es** titular (hubo `TOMAR`). Gana sobre los otros tres |

Que entren tres personas del rol y ninguna sea titular **deja el estado en `PENDIENTE`**. Los demás
siguen registrándose como participantes, pero no satisfacen el slot.

**Alcance del popup** (decisión R12): se ofrece a quien tenga **patrón activo para su cargo** y **no
sea titular** del turno en curso. Nunca a `Administrador y Debugging`, `Gerente de Producción` ni
`USUARIO DE CONSULTA` (`es_observador = 1`, D-059). El `Ingeniero Químico` y el
`Coordinador de carbón y maquinaria` **sí lo ven**: tienen su propio patrón como cualquier otro rol.

### 5.3 Módulos nuevos

| Ruta | Lote | Responsabilidad |
|---|---|---|
| `server/utils/rotacion/patron.js` | L01 | Motor **puro**: vectores, `derivarDesfase`, `diaDelCiclo`, `grupoDeTurno`, `continuidadSiguientePeriodo` |
| `server/tests/fixtures/rotacion-oraculo-2026.json` | L01 | Copia del oráculo (viene de `prompts/D-065-rotacion-turnos/oraculo-rotacion-2026.json`) |
| `server/utils/graph/cliente.js` | L03 | Token `client_credentials` + `GET` a Graph, con degradación 503 |
| `server/utils/graph/directorio.js` | L03 | Parser puro de la respuesta de Graph → `{ personas: [{azure_oid, nombre, upn, activo, role}] }` + aprovisionamiento por `azure_oid` |
| `server/utils/rotacion/titulares.js` | L04 | Resolución con BD: patrón + asignaciones → titulares de `(fecha, turno, cargo)` |
| `server/routes/rotacion.js` | L04 | Superficie A: patrones, asignaciones, sincronización, titulares |
| `server/utils/rotacion/control.js` | L05 | Pila LIFO derivada del log + `sp_getapplock` |
| `server/routes/rotacion-control.js` | L05 | Superficie B: estado, tomar, abandonar, descartar |
| `server/utils/rotacion/cumplimiento.js` | L06 | Cruce plan-vs-real + congelado |
| `server/routes/rotacion-cumplimiento.js` | L06 | Superficie C |
| `src/components/Rotacion/ConfiguracionRotacion.jsx` + `src/hooks/useRotacion.js` | L07 | Pantalla A |
| `src/components/Rotacion/PopupTomaControl.jsx` + `src/hooks/useTomaControl.js` | L08 | Popup B |
| `src/components/Rotacion/CumplimientoRotacion.jsx` + `src/hooks/useCumplimiento.js` | L09 | Pantalla C |

### 5.4 Endpoints

Todos bajo `requireEntra` (nacen cerrados, D-037) y con `router.use(loadAppSession)`.
Ninguno entra en la allowlist pública.

**L04 · `server/routes/rotacion.js`** — montado en `auth/app.js` como `/api/rotacion`:

| Método + ruta | Gate | Respuesta |
|---|---|---|
| `GET /api/rotacion/patrones` | sesión | `{ patrones: [...] }` |
| `POST /api/rotacion/patrones` | `puede_configurar_rotacion` | `{ patron }` · 403 `rotacion_no_autorizado` · 400 `desfase_ambiguo` / `desfase_imposible` |
| `GET /api/rotacion/asignaciones?cargo_id=&fecha=` | sesión | `{ asignaciones: [...] }` |
| `POST /api/rotacion/asignaciones` | `puede_configurar_rotacion` | `{ creadas, cerradas }` · 403 |
| `POST /api/rotacion/sincronizar-entra` | `puede_configurar_rotacion` | `{ creados, actualizados, total, por_rol }` · 503 `entra_no_disponible` |
| `GET /api/rotacion/titulares?fecha=&turno=&planta_id=` | sesión | `{ titulares: [...] }` |

**L05 · `server/routes/rotacion-control.js`** — montado como `/api/rotacion/control`:

| Método + ruta | Gate | Respuesta |
|---|---|---|
| `GET /api/rotacion/control/estado` | sesión | `{ aplica, cargo_id, cargo_nombre, principal, soy_principal, soy_titular, pila, ya_respondi }` |
| `POST /api/rotacion/control/tomar` | sesión con patrón | `{ principal }` · 409 `ya_es_principal` / `turno_cerrado` / `control_ocupado` |
| `POST /api/rotacion/control/abandonar` | sesión | `{ principal }` · 409 `no_es_principal` / `titular_no_abandona` / `turno_cerrado` |
| `POST /api/rotacion/control/descartar` | sesión | `{ ok: true }` |

**L06 · `server/routes/rotacion-cumplimiento.js`** — montado como `/api/rotacion/cumplimiento`:

| Método + ruta | Gate | Respuesta |
|---|---|---|
| `GET /api/rotacion/cumplimiento?desde=&hasta=&planta_id=` | sesión | `{ filas: [...], resumen: {...} }` |

### 5.5 Front

- **Sección nueva en el sidebar**, gated por `puede_configurar_rotacion` (configuración) y visible
  para todos (cumplimiento). Rutas hash `#/rotacion` y `#/rotacion/cumplimiento` (D-035: la sección
  y su subestado viven en la URL, sobreviven F5 y son deep-linkables).
- **El popup** se dispara al montar el dashboard con sesión de app viva, consultando
  `GET /api/rotacion/control/estado`. Si `aplica === false` o `ya_respondi === true`, no se muestra.
- Sin polling nuevo. Sin `sessionStorage` ni `localStorage` para el estado del popup: la fuente es
  el backend (mismo criterio que D-040 con `turno_finalizado_en`).

---

## 6. Contratos entre lotes (fijos durante la ola)

> Precisión de `.d.ts`. Si un lote necesita cambiar algo de acá, es un **bloqueo**
> (`lotes.mjs block`) que decide el gate — nunca una licencia para cambiarlo por su cuenta.

### C1 · Motor del patrón — produce **L01** · consumen **L04, L06**

```js
// server/utils/rotacion/patron.js   (PURO: sin BD, sin red, sin Date.now() implícito)

export const LARGO_CICLO = 8;

/** Parsea '1,1,3,3,4,4,2,2' → [1,1,3,3,4,4,2,2]. Lanza Error('vector_invalido') si no son
 *  exactamente 8 enteros en 1..4. */
export function parsearVector(texto) : number[]

/** Serializa [1,1,3,3,4,4,2,2] → '1,1,3,3,4,4,2,2'. */
export function serializarVector(vector) : string

/** Único i en 0..7 con vectorT1[i]===grupoT1 && vectorT2[i]===grupoT2.
 *  0 soluciones → lanza Error('desfase_imposible'); >1 → Error('desfase_ambiguo'). */
export function derivarDesfase({ vectorT1, vectorT2, grupoT1, grupoT2 }) : number

/** Días calendario Bogotá entre dos 'YYYY-MM-DD'. Negativo si b < a. Sin Date local. */
export function diasEntre(fechaIsoA, fechaIsoB) : number

/** ((diasEntre(fecha_inicio, fechaOperativa)) + desfase) mod 8, siempre en 0..7 (incluso si
 *  fechaOperativa < fecha_inicio: el módulo se normaliza a positivo). */
export function diaDelCiclo(patron, fechaOperativaIso) : number

/** Grupo de guardia. `turno` es 1 o 2; cualquier otro valor lanza Error('turno_invalido').
 *  patron = { fecha_inicio, vector_t1, vector_t2, desfase }  (vectores ya como arreglos). */
export function grupoDeTurno(patron, fechaOperativaIso, turno) : 1|2|3|4

/** Para "un año arranca donde terminó el anterior": desfase del periodo que empieza en
 *  `fechaInicioSiguiente` manteniendo la continuidad del patrón dado. */
export function desfaseDeContinuidad(patron, fechaInicioSiguienteIso) : number
```

Todas las fechas viajan como `'YYYY-MM-DD'` **en día Bogotá**. Ninguna función acepta ni devuelve
un `Date`.

### C2 · Columnas y migraciones — produce **L02** (`F37.A1`, `F37.A2`) · consumen **L04, L05, L06**

Las cuatro tablas y el flag tal cual el §5.1, con esos nombres exactos de tabla, columna y
constraint. `bitacora.rotacion_control.accion` acepta exactamente `'TOMAR' | 'ABANDONAR' | 'DESCARTAR'`.

### C3 · Directorio de Entra — produce **L03** · consume **L04**

```js
// server/utils/graph/directorio.js

/** Consulta Graph y devuelve el directorio de la Enterprise App. NO escribe en BD.
 *  Lanza Error con .codigo='entra_no_disponible' si falta credencial o Graph no responde. */
export async function leerDirectorioEntra() : Promise<{
  personas: Array<{ azure_oid: string, nombre: string, upn: string, activo: boolean,
                    role: string, cargo_nombre: string|null }>,
  grupos:   Array<{ nombre: string, role: string, miembros: number }>,
}>

/** Aprovisiona/actualiza lov_bit.usuario por azure_oid. NUNCA crea una fila si ya existe una con
 *  ese azure_oid; NUNCA hace match por nombre ni por username. */
export async function sincronizarDirectorio(pool, { por_usuario }) : Promise<{
  creados: number, actualizados: number, total: number,
  por_rol: Record<string, number>,
}>
```

`cargo_nombre` sale de `ROLE_TO_CARGO` (`utils/entra-roles.js`); es `null` si el App Role no está
en el mapa (equivale a "Default Access" → esa persona no puede entrar, D-031).

### C4 · Titulares — produce **L04** · consumen **L05, L06**

```js
// server/utils/rotacion/titulares.js

/** Titulares de un turno para TODOS los roles con patrón activo, o para uno solo si se pasa
 *  cargo_id. El resultado NO depende de la planta (decisión R3). */
export async function titularesDeTurno(pool, { fechaOperativa, turno, cargo_id = null })
 : Promise<Array<{
     cargo_id: number, cargo_nombre: string, grupo: 1|2|3|4,
     personas: Array<{ usuario_id: number, nombre: string }>,
   }>>
```

Un rol sin patrón activo en esa fecha **no aparece** en el arreglo.

### C5 · Estado del control — produce **L05** · consume **L08**

```jsonc
// GET /api/rotacion/control/estado  →  200
{
  "aplica": true,                  // false si el cargo no tiene patrón o es observador/admin/gerente
  "turno_id": 231,
  "cargo_id": 8,
  "cargo_nombre": "Operador de Planta - Sala de Mando",
  "principal": { "usuario_id": 61, "nombre": "Jefferson Ceballos Sanchez" },
  "soy_principal": false,
  "soy_titular": false,
  "ya_respondi": false,            // true tras TOMAR, ABANDONAR o DESCARTAR en este turno
  "pila": [ { "usuario_id": 61, "nombre": "…", "es_titular": true } ]
}
```

`POST /tomar`, `/abandonar` y `/descartar` van **sin cuerpo**: el turno, la planta y el cargo salen
de `req.sesion`. Devuelven el mismo shape que `/estado`.

### C6 · Cumplimiento — produce **L06** · consume **L09**

```jsonc
// GET /api/rotacion/cumplimiento?desde=2026-08-01&hasta=2026-08-31&planta_id=GEC3  →  200
{
  "filas": [
    {
      "fecha_operativa": "2026-08-15", "turno": 1, "planta_id": "GEC3",
      "cargo_id": 8, "cargo_nombre": "Operador de Planta - Sala de Mando",
      "grupo": 3, "estado": "PARCIAL",
      "titulares": [ { "usuario_id": 61, "nombre": "…", "entro": true },
                     { "usuario_id": 77, "nombre": "…", "entro": false } ],
      "relevo": null,
      "congelado": true            // true si vino de rotacion_cumplimiento; false si se derivó en vivo
    }
  ],
  "resumen": { "PENDIENTE": 4, "PARCIAL": 9, "COMPLETO": 51, "CUBIERTO_POR_RELEVO": 2 }
}
```

Rango máximo **93 días**; más → `400 rango_excesivo`. Turnos ya cerrados salen de
`rotacion_cumplimiento` (`congelado: true`); los del turno en curso se derivan en vivo.

### C7 · Congelado en el cierre — produce **L06** · afecta `utils/turno-entidad.js`

```js
/** Se invoca DENTRO de la transacción de cerrarTurno, después de congelar la conformación.
 *  Idempotente por la PK de rotacion_cumplimiento (NOT EXISTS). `filas = 0` NO es error:
 *  significa que ningún rol tenía patrón activo para esa fecha. */
export async function congelarCumplimiento(tx, { turno_id, fecha_operativa, planta_id, turno })
 : Promise<{ filas: number }>
```

### C8 · Rutas hash — produce **L10** · consumen **L07, L09**

`'#/rotacion'` → `{ vista: 'rotacion', params: {} }` ·
`'#/rotacion/cumplimiento?desde=&hasta=&planta='` → `{ vista: 'rotacion-cumplimiento', params: { desde, hasta, planta } }`.
L07 y L09 exponen sus componentes como **controlados** (reciben estado y `onChange`), igual que
DISP y COMB tras D-035; **no** leen ni escriben el hash por su cuenta.

---

## 7. Reservas (consumidas al planificar, 2026-08-31)

| Qué | Valor reservado | Verificado en |
|---|---|---|
| ADR | **`D-065`** (stub commiteado en `docs/decisions.md`) | `git show <rama>:docs/decisions.md` en **las 8 ramas locales**: el máximo es `D-064` (EN CURSO en `feat/asiento-despacho-xm-2026-08`). **`D-062` está reservado por el usuario** para el rediseño de la grilla de Combustibles y no se toca |
| Migraciones | **`F37.A1`** (tablas) y **`F37.A2`** (flag de cargo) — ambas del lote **L02** | `git grep -oE "F[0-9]{2}\.[A-Z][0-9]+"` en las 8 ramas: el máximo es **`F36.A1`** (D-064). En las dos BD vivas, `bitacora.migracion_aplicada` llega hasta `F33.A1` (`PortalG3_dev`, 16 filas) y `F31.A1` (`PortalG3`, 14 filas). **`F35.A1` quedó libre** (D-063 no la consumió) pero **no se usa acá** para no confundirla con la narrativa de D-063/D-064 |
| Convención `CLAUDE.md` | **38** | La última numerada es la **36** (D-063); **D-064 ya reservó la 37**. La escribe el **cierre** |
| `BIT-MODBD-2026-001.md` | **v2.8** | El doc va en v2.6; **D-064 reservó v2.7** |
| `BIT-RF-2026-001.md` | **v2.4**, requisito **`RF-079`** | El doc va en v2.2 y el último requisito es `RF-077`; **D-064 reservó v2.3 / RF-078** |
| Archivos de test nuevos | `tests/rotacion_patron.test.js` (L01) · `tests/rotacion_schema.test.js` (L02) · `tests/rotacion_sync_entra.test.js` (L03) · `tests/rotacion_endpoints.test.js` (L04) · `tests/rotacion_control.test.js` (L05) · `tests/rotacion_cumplimiento.test.js` (L06) · `src/components/Rotacion/configuracion-rotacion.test.jsx` (L07) · `src/components/Rotacion/popup-toma-control.test.jsx` (L08) · `src/components/Rotacion/cumplimiento-rotacion.test.jsx` (L09) · `src/routing/appRoute.test.js` (L10) | Ninguno existe (`ls server/tests/` → 61 archivos en el script `test`) |
| Fixture nuevo | `server/tests/fixtures/rotacion-oraculo-2026.json` (L01) | La carpeta `fixtures/` no existe todavía |
| Módulos nuevos | `utils/rotacion/{patron,titulares,control,cumplimiento}.js` · `utils/graph/{cliente,directorio}.js` · `routes/{rotacion,rotacion-control,rotacion-cumplimiento}.js` · `src/components/Rotacion/**` · `src/hooks/{useRotacion,useTomaControl,useCumplimiento}.js` | Ninguno existe |
| Puertos de test | L02 → **3112** · L03 → **3113** · L04 → **3114** · L05 → **3115** · L06 → **3116**. L01 es puro y L07–L10 son vitest: **no levantan backend** | Rango 3111–3120, elegido para **no chocar con los 3103–3105 de D-064**, que puede correr en paralelo |
| Prefijo de API | `/api/rotacion` (+ `/control`, `/cumplimiento`) | `grep "app.use('/api" server/auth/app.js` → 14 montajes, ninguno usa `rotacion` |

> **Regla que aplica acá:** una reserva se verifica contra el changelog del **propio documento** y
> contra **todas las ramas**, no contra la memoria del planificador. Todo lo de esta tabla se midió
> el 2026-08-31, **incluido el cruce con las reservas de D-064**, que está vivo en otra rama.

---

## 8. Archivos compartidos y su escritor en cada ola

| Archivo | O1 | O2 | O3 | O4 | Cierre |
|---|---|---|---|---|---|
| `server/db.js` | **L02** | — | — | — | — |
| `server/auth/app.js` (montaje de routers) | — | **L04** | — | — | — |
| `server/utils/turno-entidad.js` | — | **L06** | — | — | — |
| `server/package.json` (script `test`) | gate | gate | gate | gate | — |
| `package.json` raíz (vitest) | — | — | gate | gate | — |
| `src/BitacorasGecelca3.jsx` | — | — | — | **L10** | — |
| `src/routing/appRoute.js` | — | — | — | **L10** | — |
| `docs/decisions.md` | gate (stub ya puesto) | — | — | — | integrador |
| `CLAUDE.md`, `BIT-MODBD`, `BIT-RF` | — | — | — | — | integrador |
| `ESTADO.md`, `PLAN-OLAS.md`, `GATE-On.md` | integrador | integrador | integrador | integrador | integrador |
| `LOTES.json` | solo vía `lotes.mjs` | ídem | ídem | ídem | ídem |
| `.env` / `.env.example` | integrador, avisando | — | — | — | — |

**Nadie más toca esos archivos en su ola.** `server/routes/mand.js`, `server/tests/sala_de_mando_batch.test.js`,
`server/routes/combustibles.js` y todo lo de MAND/DISP/COMB/F03 **quedan fuera del flujo entero**:
son territorio de D-064 y de D-062.

---

## 9. Convenciones a respetar

- **TZ canónica:** BD en UTC (`SYSUTCDATETIME()`); presentación en Bogotá explícita
  (`Intl.DateTimeFormat` con `timeZone: 'America/Bogota'`); día Bogotá en SQL con
  `CAST(DATEADD(HOUR, -5, columna) AS DATE)`. Prohibidos `getHours()`/`getDate()` sin shift,
  `toLocaleDateString()` para persistir y `getTimezoneOffset()`.
- **Migraciones idempotentes**, gated por `bitacora.migracion_aplicada`; DDL con `IF NOT EXISTS` /
  `IF COL_LENGTH(...) IS NULL`.
- **Un flag de cargo vive en el MERGE de `db.js:864`**, no en un `UPDATE` one-shot: el MERGE corre
  en cada arranque y revierte cualquier cambio manual (convención 27).
- **Nunca hardcodear un `cargo_id` ni un nombre de cargo** en un endpoint ni en el front: todo el
  gating es data-driven desde `lov_bit.cargo` (convención 12).
- **Nunca devolver `err.message` crudo** (D-032): todo camino 5xx pasa por `utils/errores.js`.
- **No romper el server si Entra/Graph no responde**: try/catch + log + `503 entra_no_disponible`.
- **Ningún test escribe ni borra en planta REAL** (D-055): fixtures en `'TST'`, `TEST_TAG`,
  sesiones sintéticas desactivadas por `es_sintetico = 1` (nunca por username).
- **Endpoint nuevo nace cerrado** (D-037): bajo `requireEntra`, montado en `auth/app.js`, jamás en
  `server.js`, y **fuera** de la allowlist pública de `_middleware.js`.
- **Cero sweepers, crons o tareas periódicas nuevas** (CA-23). El módulo desaparece de la vida
  diaria entre una carga anual y la siguiente.
- Commits `tipo(D-065 LNN): …` con `git commit -- <rutas>`; **sin firmas de IA**, sin
  `Co-Authored-By`, sin "Generated with".
- Idioma de todo artefacto, comentario y copy: **tuteo colombiano estándar, sin voseo**.
