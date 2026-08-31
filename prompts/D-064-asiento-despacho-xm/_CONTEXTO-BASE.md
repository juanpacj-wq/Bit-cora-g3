# D-064 — Contexto base (compartido por todos los lotes)

> **Inmutable** desde el cierre de la fase de planificación (2026-08-31). Cada prompt de lote
> referencia **secciones concretas** de este archivo: no lo releas entero, lee lo que tu prompt
> te diga. Si algo de acá resulta falso durante la ejecución, se registra en tu cierre bajo
> `Bloqueos`/`Hallazgos` y el gate lo propaga como "hecho que cambia" en `GATE-On.md`. **No se
> edita este archivo.**
>
> **Dos repos, dos ramas, un solo flujo.** Los dos son git independientes, con historiales
> separados; ninguno es submódulo del otro.
>
> | Repo | Rama del flujo | Nacida de | Stack / puerto |
> |---|---|---|---|
> | `Bit-cora-g3/` | `feat/asiento-despacho-xm-2026-08` | `feat/integrar-asientos-D-059` (`5cc84a2`) | React 19 + Node ESM + MSSQL · backend 3002 |
> | `dashboard-gen-gec3/` | `feat/asiento-despacho-xm-2026-08` | `main` (`d8f8f5e`) | React 19 + Node WS + MSSQL · backend 3001 |
>
> La rama de Bitácora **no** nace de `main`: `feat/integrar-asientos-D-059` ya trae D-056/57/58,
> D-059/60 y D-063, de los que este flujo depende. Nada de esto está desplegado y **el despliegue
> no es parte de este flujo**.

## 1. Objetivo

Cuando XM publica el despacho económico del día siguiente —hacia las 3 p.m.—, dejar
automáticamente **un renglón** en las bitácoras de Sala del Jefe de Turno y del Ingeniero de
Operación, y por lo tanto en el libro **GENE-F03**, que diga:

```
Se recibe del XM despacho económico de G3.0 y G3.2 para el DD-MM-AAAA
```

con la **hora real** en que el dashboard detectó el archivo. Hoy ese renglón lo escribe una
persona a mano y el dato solo lo tiene el otro repo.

**Fuera de alcance, explícitamente** (REQ-05 §7 — no lo reabras, ni "de paso"):

- Todo lo del **redespacho por correo del CND**: `emailDispatch.js` **no se abre**.
- El **redespacho tecleado en la grilla**: ya funciona (D-058 + D-063). No se toca.
- El **bug de `getColombiaDate()` + `.toISOString()`** del otro repo (corre el "hoy" al día
  siguiente pasadas las 19:00). Está declarado fuera de alcance: **no lo arregles**, pero
  **tampoco construyas encima suponiendo que no existe** (ver §4.5).
- Reactivar `dashboard.despacho_programado`, detenida desde el 2026-07-19. **No es la fuente.**
- Asentar el retorno al despacho programado, o despachos de las Guajiras (`TGJ1`/`TGJ2`).
- Reconstruir meses anteriores al mes en curso.
- **Ningún canal HTTP entre los repos**: ni endpoint, ni token servicio-a-servicio, ni
  notificación. Ver §2.

**Contrato cross-repo:** este flujo lo toca. `../docs/interfaces-cross-repo.md` se actualiza
**antes** de la O1, por el integrador — y **ningún lote lo edita**.

## 2. Fuentes / insumos

- **`docs/requerimientos/REQ-05-asiento-cambio-despacho.md`** — la fuente. Sus criterios de
  aceptación (§6, 1–12) son los CA de este flujo. Estado 🟢, sin preguntas abiertas.
- **`prompts/D-064-asiento-despacho-xm/PREGUNTAS-D-064.md`** — las cuatro decisiones de
  implementación que el REQ no toma, ya congeladas, **y las dos desviaciones conscientes**.
- **`docs/requerimientos/FORMATO-ASIENTOS-OPERACION.md`** — la especificación del motor de
  asientos (D-058). Ojo con §4: este asiento es una **excepción deliberada** a la convención de
  unidades (ver §5.2).
- **El recorte del F03 real**, `docs/requerimientos/formatos/2026-07-F03-asiento-despacho-dia-siguiente.png`:
  el renglón que se automatiza, tal como lo escribe hoy una persona.

### La comunicación cross-repo es por BD compartida, no por HTTP

**Los dos repos usan la misma base de datos**, con esquemas distintos: `bitacora` + `lov_bit` para
Bitácora, `dashboard` para el dashboard. Verificado el 2026-08-31 por query desde las credenciales
de Bitácora (`sys.schemas` devuelve `dashboard`).

Eso elimina el canal HTTP y, con él, la pregunta de las notificaciones perdidas: si Bitácora está
caída cuando llega el despacho, lo asienta cuando vuelva, porque el hecho quedó **escrito**.

> **Regla de propiedad — no se negocia.** Cada repo escribe **solo en su esquema**. El dashboard
> escribe el hecho en `dashboard`; Bitácora lo **lee** y escribe el asiento en `bitacora`.
> Ninguno escribe en el esquema del otro, por más que la conexión lo permita.

## 3. Lo que ya existe

Los números de línea son del snapshot de planeación (2026-08-31): **confírmalos con Grep antes de
editar**, no los uses a ciegas.

### En `Bit-cora-g3/`

| Qué | Dónde | Lo que importa |
|---|---|---|
| Motor de asientos (D-058) | `server/utils/asientos/{index,formato,plantillas}.js` | Módulo **puro** (sin BD, sin reloj, sin red). Fuente única del texto normalizado, con tres consumidores. |
| `asientoLiteralSala` | `utils/asientos/index.js:70` | Le antepone `GEC3 — ` al texto **salvo** que ya nombre la unidad. |
| `UNIDAD_YA_NOMBRADA` | `utils/asientos/formato.js:19` | `/^\s*(GEC3\b\|GEC32\b\|U?G\s?3[.,]?[02]\b)/i`. **No matchea** `"Se recibe del XM…"` (verificado). |
| Armado del libro F03 | `server/utils/f03-datos.js` (499 líneas) | Solo lee. Cuatro fuentes; `PLANTAS_F03 = ['GEC3','GEC32']` (`:57`) es **inyectable para tests**. |
| `eventosSala` | `f03-datos.js:307-344` | Dedup **solo por `registro_id`** (`:336`); excluye reflejados con `origen_bitacora IS NULL` (`:324`); clave de orden `3|${registro_id}` (`:341`). |
| Reflejo a Sala (D-058/D-063) | `server/utils/reflejo-sala.js` (662 líneas) | `insertarCopias` (`:171`) es el **único INSERT** de copias: la forma canónica de una fila de Sala escrita por el sistema. `BITACORAS_REFLEJO = ['SALAJDT','SALAING']` (`:32`). |
| Tipos de evento espejo | `server/db.js:1080-1108` (`F34.A1`) | Seed idempotente por `NOT EXISTS` + **`UPDATE` complementario** que fuerza `seleccionable = 0` en cada arranque. |
| `registro_activo` | `server/db.js:681-699` | `turno TINYINT NOT NULL CHECK (1,2)`; `detalle`, los **tres** `*_snapshot` y `creado_por` son `NOT NULL`; `campos_extra NVARCHAR(MAX) NULL`. |
| Usuario `SISTEMA` | `server/db.js:1700-1707`, `USUARIO_SISTEMA_ID` (`:132`, resuelto en `:362`) | `activo = 0`, `password_hash = '!disabled!'`. **Nunca loguea** (D-015). |
| `canEditarRegistro` | `server/middleware/permissions.js:122-134` | Exige `registro.creado_por === sesion.usuario_id`. **De acá sale CA-11 gratis.** |
| Sweeper diario MAND | `server/utils/mand-sweeper.js` | El patrón de barrido a copiar: `INTERVAL_MS`, `start*/stop*`, idempotencia por tabla-log. |
| Cableado de sweepers | `server/server.js:40-43`, `:55-57` | `startTurnoSweeper` / `startMandSweeper` / `startSisSweeper` (este último tras un flag). |
| CLI de backfill (D-060/61) | `server/scripts/backfill-carbon-gec32.js` (13 KB) | El patrón del CLI: `parseArgs`, `--confirm-db`, `--dry-run`, resumible, `--log`. |

### En `dashboard-gen-gec3/`

| Qué | Dónde | Lo que importa |
|---|---|---|
| Detección del despacho de mañana | `server/despachoscraper.js:302-322` (`#refreshTomorrow`) | Hoy **solo** hace `this.#foundTomorrow = true` + un `console.log`. **No persiste nada**: al reiniciar el servicio, el dato se pierde. |
| Cadencia del scraper | `server/despachoscraper.js:174` | `RETRY_MS = 5 * 60 * 1000`. De acá sale la cadencia de lectura de Bitácora (RQ-05.16). |
| DDL del esquema `dashboard` | `server/db.js:40-210` | Patrón `IF OBJECT_ID('dashboard.x','U') IS NULL CREATE TABLE …`, idempotente, sin tabla de flags de migración. |
| Suite | `server/__tests__/*.test.js` (incl. `despachoscraper.test.js`) | vitest puro, **sin BD**: cada lote corre su archivo sin test-lock. |

## 4. Patrones de infraestructura a reutilizar

1. **Escritura de una fila de Sala por el sistema** → cópiale la forma a `insertarCopias`
   (`reflejo-sala.js:171-200`): `estado='borrador'`, los tres snapshots a `'[]'` si no hay,
   `tipo_evento_id` resuelto por `(bitacora_id, nombre)` en **una sola** ida a la BD. Nunca
   resuelvas un `tipo_evento_id` de otra bitácora: no hay FK ni CHECK que lo impida y el drift es
   invisible hasta que alguien abre el editor (D-053, `guard_tipo_evento_coherente.test.js`).
2. **Autor de escrituras automáticas**: `USUARIO_SISTEMA_ID` importado de `../db.js`. Si viene
   `null`, **lanza** — no escribas con un autor inventado (`mand-sweeper.js:32-34`).
3. **`turno_id` es el puntero de ARCHIVADO, no narrativo** (D-045, D-058 gotcha (c)): sale del
   turno **ABIERTO** de esa planta al momento de escribir, o `NULL` si no hay ninguno. **Nunca**
   del turno que corresponde a la hora del evento: apuntarlo a un turno ya cerrado deja la fila
   viva en `registro_activo` para siempre. La columna `turno` (1|2) sí es la del evento.
4. **Barrido periódico**: patrón `mand-sweeper.js` — módulo con `start<X>Sweeper(pool)` /
   `stop<X>Sweeper()`, `let timer`, `setInterval`, y **todo el cuerpo del tick en try/catch** para
   que un error no tumbe el proceso. Se cablea en `server.js` junto a los otros tres.
5. **TZ (D-020 + RN-05.f) — el corazón de este requerimiento.** Hay **dos** relojes:
   - El **motor de la BD corre en hora Bogotá**: `SYSDATETIME()` da 08:56 mientras
     `SYSUTCDATETIME()` da 13:56. El esquema `dashboard` usa `GETDATE()` → sus columnas son
     **Bogotá**.
   - **Bitácora guarda UTC** en `fecha_evento`, `creado_en`, etc.
   - Por lo tanto: **`UTC = Bogotá + 5 h`**, y la conversión se hace **una sola vez, explícita, en
     el lector** (§6, contrato C2). No la repartas: dos conversiones parciales es el modo clásico
     de que el renglón salga cinco horas corrido.
   - Para el día Bogotá en SQL, la forma canónica del repo: `CAST(DATEADD(HOUR, -5, columna) AS DATE)`.
   - **El bug del otro repo** (`getColombiaDate()` seguido de `.toISOString()`, que pasadas las
     19:00 corre el "hoy" al día siguiente) **existe y está fuera de alcance**. Medido:
     `#refreshTomorrow` construye su fecha con `getFullYear/getMonth/getDate`, **sin**
     `.toISOString()`, así que **ese camino no lo tiene**. No lo arregles; tampoco escribas código
     que asuma que ningún `Date` del repo lo sufre.
6. **Tests (D-030, D-055, D-061)**: la suite corre contra la **BD productiva**. Reglas duras:
   - **Ningún test escribe ni borra en planta real.** Fixtures: `TEST_PLANTA_ID` (`'TST'`) y
     `'TSR'` (la del reflejo, `activa = 0` de fábrica: se enciende para el test HTTP y **se vuelve
     a apagar** — invariante vigilado por `residuos.js` y `zzz_session_leak_guard`).
   - Por eso **la lista de plantas del creador es inyectable** (§6, contrato C3), igual que
     `PLANTAS_F03`. Es la contramedida **estructural** de D-061: el guard estático solo ve DML
     literal en el test, así que una escritura que entra por el *default* de una función de
     producción le es invisible.
   - Toda limpieza va acotada por `TEST_TAG` / `TEST_PLANTA` / `es_sintetico = 1`,
     **léxicamente junto al statement** (`guard_no_prod_historico_destruction.test.js`).
     **Acotar por fecha NO acota.**
   - Sesiones sintéticas: **siempre** por `es_sintetico = 1`, nunca por username
     (`deactivateSyntheticSessions()` en `tests/helpers.js`).
   - Helpers: `tests/helpers.js` (`setupSessions({ planta })`, `TEST_TAG`, `cleanupTestRegistros`).

## 5. Diseño acordado

### 5.1 Cambios de BD

**En `dashboard` (lo escribe L01, repo `dashboard-gen-gec3`)** — el hecho:

```sql
IF OBJECT_ID('dashboard.despacho_recibido','U') IS NULL
CREATE TABLE dashboard.despacho_recibido (
  fecha_despacho DATE      NOT NULL PRIMARY KEY,   -- el día que ANUNCIA (mañana)
  detectado_en   DATETIME2 NOT NULL DEFAULT GETDATE()  -- hora BOGOTÁ (motor en Bogotá)
);
```

`fecha_despacho` es la PK: **de ahí sale la idempotencia del lado del dashboard** (RQ-05.13). El
scraper inserta con `IF NOT EXISTS` / `MERGE` y **no pisa** un `detectado_en` ya escrito: la
primera detección es la buena, las de los reintentos y reinicios no.

**En `bitacora` (lo escribe L03)** — `F36.A1`, el tipo de evento del asiento:

Se agrega `('Despacho económico', 5)` al seed de tipos espejo de `db.js:1080` **y** al `UPDATE`
complementario de `db.js:1101`. Las **dos** listas o el `seleccionable = 0` se pierde en el
siguiente restart. Igual que los 4 espejo: `seleccionable = 0` lo esconde del selector de la
grilla **y** de los lookups del POST/PUT genérico — nadie puede teclear a mano un asiento que
finja ser del sistema.

No hace falta ninguna otra migración: no se agregan columnas. El marcador y la clave viven en
`campos_extra`, que ya es `NVARCHAR(MAX) NULL`.

### 5.2 Lógica núcleo

**El texto** (RQ-05.4), literal del F03 real, sin punto final:

```
Se recibe del XM despacho económico de G3.0 y G3.2 para el DD-MM-AAAA
```

- `DD-MM-AAAA` es la fecha **del despacho** (el día siguiente), con **guiones**.
- `G3.0` / `G3.2` es una **excepción deliberada** a la convención `GEC3`/`GEC32` de
  `FORMATO-ASIENTOS-OPERACION.md` §4: acá el texto es una **frase fija**, no una plantilla
  parametrizada por unidad. No lo "normalices".
- **Un solo asiento nombra las dos unidades** (RQ-05.5): no se genera uno por unidad, y el texto
  **no** lleva prefijo de unidad (de ahí el marcador — respuesta 1).

**Las cuatro filas** (respuesta 2 — desviación consciente de RQ-05.8):

| bitácora | planta |
|---|---|
| `SALAJDT` | `GEC3` |
| `SALAING` | `GEC3` |
| `SALAJDT` | `GEC32` |
| `SALAING` | `GEC32` |

Las cuatro comparten `detalle` (el mismo texto), `fecha_evento` y `campos_extra.clave_asiento`, y
por eso **el libro las colapsa a un renglón**. Cada una resuelve su propio `turno_id` (turno
abierto **de su planta**) y su `turno` (1|2 según la hora). Las cuatro se escriben **en una sola
transacción**: o están las cuatro o no está ninguna.

**`campos_extra` de las cuatro filas:**

```json
{
  "origen_sistema":  "DESPACHO_XM",
  "clave_asiento":   "DESPACHO_XM|2026-07-14",
  "fecha_despacho":  "2026-07-14",
  "hora_estimada":   false
}
```

- **`origen_sistema` NO es `origen_bitacora`.** Usar `origen_bitacora` **excluiría el asiento del
  libro** (`eventosSala` filtra `origen_bitacora IS NULL`) y lo volvería inmutable por la vía del
  reflejo. RQ-05.9 lo prohíbe con razón: esto **no** es una copia reflejada, es un registro
  original de Sala.
- **`clave_asiento`** es la clave de agrupación de RQ-05.10. Determinística a partir de la fecha
  del despacho: la misma fecha produce siempre la misma clave. De ahí sale **también** la
  idempotencia del lado de Bitácora.
- **`hora_estimada`** va **siempre presente** (`true`/`false`), no ausente. Es la lección de D-056
  (b): "AUSENTE ≠ `false`" es una trampa cara. Aun así, **todo consumidor trata la ausencia como
  `false`**, por si una fila vieja llegara sin la clave.

**Idempotencia (RQ-05.13/15, CA-4/CA-5):** antes de escribir, se busca `clave_asiento` en
**`registro_activo` Y en `registro_historico`**. Si aparece en cualquiera de las dos, no se
escribe nada. **Las dos tablas**: un asiento de hace tres días ya fue archivado por el cierre de
turno y buscarlo solo en `registro_activo` lo duplicaría — es justo el caso del relleno del mes.

**Relleno del mes (RQ-05.14, CA-5):** para los días **ya pasados** del mes en curso, y para hoy si
el despacho ya llegó, se crean los asientos faltantes con **hora fija `15:00` Bogotá** y
`hora_estimada: true`, porque la hora real de esos días **no existe como dato y nunca se guardó**.
No pisa ningún asiento existente (la misma verificación de `clave_asiento`), así que uno con hora
real sobrevive intacto. **Nunca inventa un día**: si no hay evidencia de que llegó el despacho, no
hay renglón (RN-05.d).

**Degradación (RN-05.c, CA-8):** si `dashboard.despacho_recibido` no existe, o la consulta falla,
o el dashboard nunca escribió: se loguea **una vez** y Bitácora sigue operando **exactamente**
como hoy. Nunca se cae, nunca bloquea un tick, nunca propaga la excepción. Mismo criterio que la
mejora de texto con IA (D-047), que degrada sin configuración.

**Lo que el asiento NO hace:**

- **No llena ninguna celda** de la grilla de captura de Operación 24h (RQ-05.11, CA-9). No pasa
  por MAND en absoluto.
- **No publica nada al dashboard** (RQ-05.12, CA-10): no toca `evento_dashboard` ni
  `disponibilidad_dashboard`. El dato vino de allá; reenviarlo sería un ciclo.
- **No se edita ni se borra desde la interfaz** (RN-05.g, CA-11) — y **no hay que programarlo**:
  el autor es `SISTEMA` y `canEditarRegistro` ya exige autoría (D-049). **`permissions.js` no se
  toca.** L04 lo **verifica**, no lo implementa.
- **No está sujeto al bloqueo de turno finalizado ni de turno en transición** (RN-05.e): no entra
  por `POST /api/registros`, así que esos gates no aplican. Sale gratis; no agregues una excepción.

### 5.3 Módulos nuevos

Estos nombres son **parte del contrato** y del territorio de su lote.

| Ruta | Responsabilidad | Lote |
|---|---|---|
| `server/utils/asientos/sistema.js` | **Puro.** El texto del asiento, el marcador, la clave de agrupación y el predicado. Fuente única del vocabulario del asiento de sistema. | L02 |
| `server/utils/despacho-xm/lector.js` | Lee `dashboard.despacho_recibido`, convierte Bogotá→UTC **una vez**, degrada si la tabla no está. | L04 |
| `server/utils/despacho-xm/asiento.js` | Crea las 4 filas en una transacción, idempotente por `clave_asiento`. Lo llaman el sweeper **y** el CLI. | L04 |
| `server/utils/despacho-xm/sweeper.js` | Barrido cada 5 min: lee el hecho y llama al creador. | L04 |
| `server/scripts/relleno-asiento-despacho.js` | CLI del relleno del mes: resumible, `--dry-run`, `--confirm-db`. | L05 |

### 5.4 Endpoints

**Ninguno.** No se crea, ni se modifica, ni se elimina un endpoint en este flujo. La comunicación
cross-repo es por BD (§2) y el asiento lo escribe un barrido interno.

### 5.5 Front

**Ninguno.** No se toca un solo archivo de `src/`. El asiento aparece en la grilla de Sala por el
camino que ya existe (es un registro común de `SALAJDT`/`SALAING`) y en el libro por
`f03-datos.js`. La bandera `hora_estimada` **no se pinta** (respuesta 4): vive en `campos_extra` y
la reporta el CLI. Si en algún momento se quiere un chip, es otro requerimiento.

## 6. Contratos entre lotes (fijos durante toda la implementación)

> Se escriben con la precisión de un `.d.ts`. Si un lote necesita cambiar algo de acá, es un
> **bloqueo** (`lotes.mjs block`) que decide el gate — **no** una licencia para cambiarlo.

| # | Contrato | Productor | Consumidores | Definición |
|---|---|---|---|---|
| **C1** | Tabla `dashboard.despacho_recibido` | L01 | L04, L05 | `fecha_despacho DATE NOT NULL PRIMARY KEY` · `detectado_en DATETIME2 NOT NULL DEFAULT GETDATE()` (**hora Bogotá**). El scraper la escribe **una sola vez por fecha** y no pisa un `detectado_en` existente. Que la tabla **no exista** es un estado válido y esperado (§5.2, degradación). |
| **C2** | `server/utils/asientos/sistema.js` | L02 | L03, L04, L05 | Ver el bloque de firmas de abajo. Módulo **puro**: sin BD, sin reloj, sin red. |
| **C3** | `crearAsientoDespacho(pool, opciones) → Promise<Resultado>` | L04 | L05 | `opciones: { fecha_despacho: string 'YYYY-MM-DD', detectado_en: Date (UTC), hora_estimada?: boolean = false, plantas?: string[] = PLANTAS_DESPACHO }`. Devuelve `{ creado: boolean, filas: number, motivo?: 'ya_existe' }`. **Idempotente**: si `clave_asiento` ya está en `registro_activo` **o** en `registro_historico`, devuelve `{ creado: false, filas: 0, motivo: 'ya_existe' }` sin escribir. Escribe las 4 filas en **una** transacción. `plantas` es inyectable **solo para tests** (§4.6). |
| **C4** | `leerDespachosRecibidos(pool, { desde, hasta }) → Promise<Array<{fecha_despacho: string, detectado_en: Date}>>` | L04 | L05 | `detectado_en` ya viene **convertido a UTC** (`DATEADD(HOUR, 5, …)`): el consumidor no vuelve a convertir. Si la tabla no existe o la consulta falla, devuelve `[]` y loguea una vez — **nunca lanza**. |
| **C5** | Colapso por clave en el libro | L03 | — | `eventosSala` (`f03-datos.js`) deduplica por `campos_extra.clave_asiento` cuando existe, y por `registro_id` cuando no. Para una fila con `origen_sistema`, el asiento es el `detalle` **literal**, sin prefijo de unidad. |
| **C6** | `tipo_evento` `'Despacho económico'` | L03 (`F36.A1`) | L04 | Sembrado en `SALAJDT` **y** `SALAING`, `orden = 5`, `seleccionable = 0`. L04 resuelve su `tipo_evento_id` por `(bitacora_id, nombre)`, **nunca** por id fijo. |

### C2 — firmas exactas de `server/utils/asientos/sistema.js`

```js
// El valor del marcador. Único, estable, y NO es `origen_bitacora`.
export const ORIGEN_DESPACHO_XM = 'DESPACHO_XM';

// Las dos bitácoras de Sala que reciben el asiento (mismo par que BITACORAS_REFLEJO).
export const BITACORAS_ASIENTO_SISTEMA = ['SALAJDT', 'SALAING'];

// El nombre del tipo de evento sembrado por F36.A1 (contrato C6).
export const TIPO_EVENTO_DESPACHO_XM = 'Despacho económico';

/**
 * El texto literal del asiento (RQ-05.4). SIN punto final y SIN prefijo de unidad.
 * @param {string} fecha_despacho  'YYYY-MM-DD' — el día que anuncia.
 * @returns {string} `Se recibe del XM despacho económico de G3.0 y G3.2 para el DD-MM-AAAA`
 * @throws {TypeError} si la fecha no es 'YYYY-MM-DD' válida. NO devuelve texto a medias:
 *   un asiento con la fecha mal es peor que ningún asiento.
 */
export function asientoDespachoXM(fecha_despacho) {}

/**
 * La clave de agrupación de RQ-05.10. Determinística: misma fecha → misma clave.
 * @returns {string} `DESPACHO_XM|YYYY-MM-DD`
 */
export function claveAsientoDespacho(fecha_despacho) {}

/**
 * El `campos_extra` completo de una fila del asiento, ya listo para `JSON.stringify`.
 * `hora_estimada` va SIEMPRE presente (true/false), nunca ausente.
 */
export function camposExtraDespacho({ fecha_despacho, hora_estimada = false }) {}

/**
 * ¿Esta fila es un asiento escrito por el sistema? Lee `campos_extra.origen_sistema`.
 * Acepta el objeto ya parseado o el string crudo de la columna; un JSON inválido es `false`,
 * no una excepción — el predicado lo consultan lecturas que no pueden caerse.
 */
export function esAsientoDeSistema(campos_extra) {}

/** La clave de agrupación de una fila, o `null` si no es un asiento de sistema. */
export function claveDeAgrupacion(campos_extra) {}

/** ¿La hora de esta fila es la convención de las 15:00 y no una medición? Ausente → false. */
export function esHoraEstimada(campos_extra) {}
```

## 7. Reservas (consumidas al planificar, 2026-08-31)

| Qué | Valor reservado | Verificado en |
|---|---|---|
| ADR | **`D-064`** (stub commiteado en `docs/decisions.md`) | `git grep "^## D-0"` en **las 7 ramas locales**: el máximo es `D-063`. `D-062` está **reservado por el usuario** para el rediseño de la grilla de Combustibles y **no se toca**. |
| Migración | **`F36.A1`** (lote L03) | `git grep -oE "F[0-9]{2}\.[A-Z][0-9]+"` en las 7 ramas: el máximo es `F35.A1`. Y en la BD viva `PortalG3_dev`: `migracion_aplicada` solo tiene `F30.A1, F31.A1, F32.A1, F33.A1`. **Libre.** |
| Convención `CLAUDE.md` | **37** | La última numerada es la 36 (D-063). La escribe el **cierre**. |
| `BIT-MODBD-2026-001.md` | **v2.7** | Changelog del propio doc: va en v2.6 (D-063). |
| `BIT-RF-2026-001.md` | **v2.3**, requisito **`RF-078`** | El doc va en v2.2 y el último requisito es `RF-077` (D-063). |
| Tabla nueva | `dashboard.despacho_recibido` | Verificado por query contra `PortalG3_dev`: **no existe**. |
| `tipo_evento` nuevo | `'Despacho económico'`, `orden = 5` | Los 4 espejo de `F34.A1` ocupan `orden` 1–4 en `SALAJDT`/`SALAING`. |
| Archivos de test nuevos | `tests/asiento_despacho_xm.test.js` (L02) · `tests/f03_despacho_xm.test.js` (L03) · `tests/despacho_xm.test.js` (L04) · `tests/relleno_despacho_xm.test.js` (L05) | Ninguno existe (`ls server/tests/`, 68 archivos). |
| Módulos nuevos | `utils/asientos/sistema.js` · `utils/despacho-xm/{lector,asiento,sweeper}.js` · `scripts/relleno-asiento-despacho.js` | Ninguno existe. |
| Puertos de test | L03 → **3103** · L04 → **3104** · L05 → **3105** | L01 (vitest sin BD) y L02 (puro) **no levantan backend**. |

> **Regla de la metodología que aplica acá:** una reserva se verifica contra el changelog del
> **propio documento** y contra **todas las ramas**, no contra la memoria del planificador — es
> lo que pasó cuando D-061 reservó "BIT-RF 1.9 / RF-071" y las dos ya estaban tomadas. Todo lo de
> esta tabla se midió hoy.

## 8. Archivos compartidos y su escritor en cada ola

| Archivo | O1 | O2 | Cierre |
|---|---|---|---|
| `Bit-cora-g3/server/db.js` | **L03** (único) | — | — |
| `Bit-cora-g3/server/utils/f03-datos.js` | **L03** (único) | — | — |
| `Bit-cora-g3/server/utils/asientos/**` | **L02** (único) | — | — |
| `Bit-cora-g3/server/server.js` | — | **L04** (único) | — |
| `Bit-cora-g3/server/package.json` (script `test`) | gate | gate | gate |
| `dashboard-gen-gec3/server/db.js` | **L01** (único) | — | — |
| `docs/decisions.md` | gate (stub ya puesto) | gate | integrador (ADR completo) |
| `CLAUDE.md`, `BIT-MODBD`, `BIT-RF`, `docs/requerimientos/REQ-05*` | — | — | integrador |
| `../docs/interfaces-cross-repo.md` (umbrella) | **integrador, antes de la O1** | — | — |
| `ESTADO.md`, `PLAN-OLAS.md`, `GATE-On.md` | integrador | integrador | integrador |
| `LOTES.json` | solo vía `lotes.mjs` | solo vía `lotes.mjs` | — |

**Nadie más toca `server/middleware/permissions.js`**: CA-11 sale de la regla que ya existe
(D-049). Tocarlo sería reintroducir una excepción por cargo, que es justo lo que D-049 prohíbe.

## 9. Convenciones a respetar

- **TZ**: BD en UTC, presentación Bogotá explícita. La conversión Bogotá→UTC de este flujo va
  **una sola vez**, en el lector (§4.5). Día Bogotá en SQL: `CAST(DATEADD(HOUR, -5, col) AS DATE)`.
- **Migraciones idempotentes** (`IF NOT EXISTS` / `NOT EXISTS`), y en Bitácora con su código
  reservado en el comentario. En el dashboard el patrón es `IF OBJECT_ID(...) IS NULL`, sin tabla
  de flags.
- **No romper el server** si una dependencia externa no responde: try/catch + log, degradación
  silenciosa (RN-05.c).
- **Ningún test escribe ni borra en planta real** (D-055/D-061). Fixtures `'TST'`/`'TSR'`,
  limpieza acotada léxicamente, sesiones sintéticas por `es_sintetico = 1`.
- **No se tocan**: `emailDispatch.js`, `dashboard.despacho_programado`, el bug de
  `getColombiaDate()`, la grilla de Operación 24h, `permissions.js`, ni un solo archivo de `src/`.
- **Commits** `tipo(D-064 LNN): …` con `git commit -- <rutas>`. Nunca `git add -A`/`.`; nada de
  stash, reset, checkout, restore, switch, rebase, amend, push, merge.
- **Sin firmas de IA** en ningún commit: ni `Co-Authored-By`, ni "Generated with". El autor es
  siempre la identidad git del usuario.
- **Los hooks no se saltan.** `git config core.hooksPath .githooks` una vez por clon. Si un
  `--no-verify` resultara inevitable, se **declara** en el cierre del lote.
- **Idioma** de todo artefacto, comentario y mensaje de commit: **tuteo colombiano estándar**, sin
  voseo.
