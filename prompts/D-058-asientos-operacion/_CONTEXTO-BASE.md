# D-058 — Contexto base (compartido por todas las etapas)

> **Bloque de contexto acumulado** que cada prompt de etapa referencia. Es **inmutable** desde el
> cierre de la planificación (2026-07-26): si algo cambia durante la ejecución, se registra en
> `ESTADO.md` (desviaciones) y en el commit de la etapa, **no acá**.
> Léelo completo al iniciar cualquier etapa, junto con `ESTADO.md` (estado vivo de avance).
>
> Repo: `Bit-cora-g3/` — git independiente dentro del workspace `PORTAL GENERACIÓN/`.
> React 19 + Vite 5 (front) · Node ≥20 ESM + Express (backend, **puerto 3002**) · SQL Server
> (`lov_bit` catálogos + `bitacora` transaccional).
>
> **Insumo autoritativo:** [`docs/requerimientos/FORMATO-ASIENTOS-OPERACION.md`](../../docs/requerimientos/FORMATO-ASIENTOS-OPERACION.md).
> Sus decisiones **A..H** (§6.1 y §6.3) están cerradas y **no se reabren**.
> Las respuestas 1..15 de `PREGUNTAS-D-058.md` son igual de autoritativas.

---

## Objetivo

Normalizar el texto con que se narran los eventos de operación y **generarlo desde el sistema**, con
**un motor y cuatro consumidores**:

1. **Motor** (núcleo, server-side, puro): recibe un evento y devuelve su asiento en texto. Cubre
   `AUTH`, `REDESP`, `PRUEBA`, los cuatro estados de `DISP`, y el paso-a-través **literal** de
   `SALAJDT`/`SALAING`. **Fuente única**: las tres salidas de abajo no pueden divergir.
2. **REQ-04 §8.1** — el renglón del listado del día de Operación 24h se muestra con ese asiento
   (era "el formato de WhatsApp" que bloqueaba REQ-04), con acción de copiar (§8.3).
3. **REQ-02** — el asiento se **copia** a `SALAJDT` **y** `SALAING` al registrar, se **reescribe** al
   corregir y se **borra** al borrar (decisión H). **Solo desde MAND** en este ADR.
4. **REQ-06** — libro mensual `.xlsx` calcado del formato controlado **GENE-F03**: una hoja por día,
   tres bloques de turno, las dos unidades mezcladas en orden cronológico ascendente.

### Fuera de alcance (explícito)

- **El reflejo de DISP a las bitácoras de Sala** (crear / editar / `deshacer → copia anulada`).
  Se siembran sus tipos espejo, pero **no se cablea**: merece su propio ADR (respuesta 13).
- El segundo formato (`Reporte diario de generación y combustible G3 y G32`) y **REQ-01**.
- Enviar el mensaje a WhatsApp desde la app.
- Capturar la rutina diaria con plantillas asistidas: en Sala se escribe libre (decisión D).
- **Contratos cross-repo**: D-058 **no** toca `evento_dashboard` ni `disponibilidad_dashboard`. Nada
  que coordinar con `dashboard-gen-gec3/`.

### La adopción es real y baja — el generador no la compensa

Consulta a la BD productiva el 2026-07-26: `MAND` = 26 filas / 10 lotes (en uso real);
`DISP` = 1 evento de prueba; `SALAJDT`+`SALAING`+`SALAOP` = 6 registros, todos de prueba.
**El generador es correcto aunque la hoja salga casi vacía.** El F03 se llena hoy a mano y las
bitácoras de Sala todavía no se usan: la hoja se parecerá al formato conocido **cuando la gente
registre ahí**, no cuando el código exista. Es adopción, no software — y es la razón por la que
**no** hay que autogenerar texto para tapar el hueco.

---

## Fuentes / insumos

| Insumo | Ruta | Qué aporta |
|---|---|---|
| Especificación del texto | `docs/requerimientos/FORMATO-ASIENTOS-OPERACION.md` | Plantillas §5, convenciones §4, layout 1:1 §7, algoritmo §7.2, decisiones A..H |
| REQ-02 | `docs/requerimientos/REQ-02-reflejo-bitacoras-sala.md` | Reglas del reflejo (RQ-02.*, RN-02.*) |
| REQ-04 | `docs/requerimientos/REQ-04-historico-en-apartado.md` | Listado del día; §8.1 y §8.3 los cierra D-058 |
| REQ-06 | `docs/requerimientos/REQ-06-excel-eventos-operacion.md` | Libro mensual (RQ-06.*, RN-06.*) |
| Formato controlado real | `2026_01_OPG3-F03 Estado G3 y eventos diarios de operación.xlsx` (raíz) | **Origen de la plantilla `.xlsx`**. 32 hojas, 342 eventos, estilos, logo, áreas de impresión |
| Escritor OOXML | `js-scraper-carbon-g32/xlsx-write.js` | Base a portar a ESM: ZIP **stored** + CRC32 + XML. CommonJS, mono-hoja, **solo escribe** |

### Anatomía del `.xlsx` de referencia (medida, no supuesta)

- **170 entradas**, todas `DEFLATE` salvo `xl/media/image1.png` (`STORED`).
- 32 hojas (`sheet1..sheet32`), nombres `YYYY-MM-DD` — más una duplicada `2026-01-24 (2)`, que es
  el **primer** sheet del libro. La plantilla se deriva de una hoja limpia, no de esa.
- Cada hoja trae: `sheetPr/pageSetUpPr`, `dimension`, `sheetViews`, `cols`, `sheetData`,
  `sheetProtection`, `mergeCells` (39 en el día 1), `printOptions`, `pageMargins`,
  `pageSetup r:id` (→ `printerSettings{N}.bin`) y `drawing r:id` (→ el logo).
- `xl/workbook.xml` trae **32 `<definedName name="_xlnm.Print_Area" localSheetId="N">`**, con rangos
  distintos por día: `$A$6:$I$25` … `$A$6:$I$32`. **Hay que recalcularlos por hoja** (respuesta 15).
- Partes compartidas que se copian tal cual: `xl/styles.xml`, `xl/theme/theme1.xml`,
  `xl/sharedStrings.xml`, `xl/media/image1.png`, `_rels/.rels`, `docProps/core.xml`.

### Layout de la hoja (§7 del insumo)

```
 fila  A                        B / D
  1    Código: GENE-F03         D: Título: Estado G3 y eventos diarios de operación
  2    Versión: 0
  3    Página 1 de 1            D: Responsable: Gerente de Producción
  4    Fecha: 01/06/2017        ← fecha de emisión del FORMATO. Es FIJA, no la del día
  6    FECHA:                   B: <día de la hoja, dd/mm/aaaa>
 ── bloque 1 ────────────────────────────────────────────────────────────────
  9    TURNO:                   D: 00:00-06:00      ← cola del T2 que arrancó AYER
 10    JEFE DE TURNO:           D: <nombre>
 11    INGENIERO DE TURNO:      D: <nombre> - <nombre>
 12    HH:MM                    B: DESCRIPCIÓN EVENTO Y/O ACTIVIDAD
 13..  <hora>                   B: <asiento>        ← n filas, ASCENDENTE por hora
 ── bloque 2: TURNO 06:00 - 18:00 (T1 de HOY) — mismo patrón ────────────────
 ── bloque 3: TURNO 18:00 - 00:00 (cabeza del T2 de HOY) — mismo patrón ─────
```

Los tres bloques **crecen hacia abajo**: las filas 13+ no son fijas y los `mergeCells`, la
`dimension` y el `Print_Area` se recalculan con el alto real de la hoja.

---

## Destino en BD (lo que ya existe)

| Objeto | Dónde | Notas |
|---|---|---|
| `bitacora.registro_activo` | `db.js:572` | Día en curso. `campos_extra NVARCHAR(MAX)` JSON. `estado='borrador'`. Columnas de la escritura: `bitacora_id, planta_id, fecha_evento, turno, detalle, campos_extra, tipo_evento_id, estado, ingenieros_snapshot, jdts_snapshot, jefes_snapshot, creado_por, turno_id` |
| `bitacora.registro_historico` | `db.js:607` | Archivado por cierre de turno (`turno_id`) o por `cerrarDiaMand` (MAND). **Inmutable — RF-032** |
| `lov_bit.tipo_evento` | `db.js:445` | `(tipo_evento_id, bitacora_id, nombre, es_default, orden, notificar_dashboard_tipo)`. **No tiene columna de visibilidad** → la agrega D-058 |
| `bitacora.disponibilidad_estado` | `db.js:1713` | DISP (D-026). `estado IN ('En Servicio','En Reserva','Indisponible','Mantenimiento')`, `fecha_inicio_estado`/`fecha_fin_estado` |
| `bitacora.conformacion_turno` | BIT-MODBD §4.7 | Snapshot **al cerrar** el turno (D-045). `(fecha_operativa, planta_id, turno, usuario_nombre, cargo_nombre, …)` |
| `bitacora.turno_participante` | BIT-MODBD §4.10 | Presencia **viva** por unidad. Fallback del encabezado cuando el turno no cerró |
| `bitacora.turno_unidad` | BIT-MODBD §4.10 | Cabecera del turno. `estado ∈ PROGRAMADO/ABIERTO/CERRADO` |

### Cambio de schema que introduce D-058

Uno solo, idempotente, en `initDB()` (patrón `cantidad_max` de D-034):

```sql
-- F33.A1
IF COL_LENGTH('lov_bit.tipo_evento','seleccionable') IS NULL
  ALTER TABLE lov_bit.tipo_evento ADD seleccionable BIT NOT NULL
    CONSTRAINT DF_tipo_evento_seleccionable DEFAULT 1 WITH VALUES;
```

**`seleccionable`, no `activo`** — deliberado: `activo` se confunde con "bitácora activa".
Los tipos existentes quedan en `1` por el `DEFAULT`; los 8 espejo se siembran con `0`.

---

## Endpoints existentes (lo que ya existe)

| Endpoint | Archivo | Qué hace / qué cambia |
|---|---|---|
| `GET /api/sala-de-mando/lotes?planta_id=&fecha=` | `routes/mand.js:124` | Lotes del día agrupados por `lote_id`, gated por `puede_ver`. **D-058 le suma el campo `asiento`** |
| `POST /api/sala-de-mando/guardar` | `routes/mand.js:674` | Captura append-only por lotes (D-056). **D-058 engancha el reflejo dentro de su transacción** |
| `PUT /api/sala-de-mando/lotes/:lote_id` | `routes/mand.js:263` | Diff quirúrgico (D-057). **Enganche del reflejo ya anotado en `mand.js:532`** |
| `DELETE /api/sala-de-mando/lotes/:lote_id` | `routes/mand.js:572` | Borrado real del lote (D-057). **Enganche anotado en `mand.js:645`** |
| `GET /api/catalogos/bitacoras/:id/tipos-evento` | `routes/catalogos.js:58` | Devuelve **todos** los tipos sin filtrar → alimenta el selector de `GrillaRegistros`. **D-058 le agrega `WHERE seleccionable = 1`** |
| `GET /api/registros/activos` | `routes/registros.js:91` | Expone el espejo por fila `puede_editar` (D-049). **D-058 lo hace `0` para los asientos reflejados** |
| `PUT`/`DELETE /api/registros/:id` | `routes/registros.js:442,762` | Rama genérica, gated por `canEditarRegistro`. **D-058 hace que rechace los reflejados** |
| `POST /api/disponibilidad/deshacer` | `routes/disponibilidad.js:109` | **No se toca** (el reflejo DISP está fuera de alcance) |

### Endpoint nuevo

```
GET /api/sala-de-mando/reporte-mensual?mes=YYYY-MM
```

- Gate: `hasPermisoBitacora(sesion, MAND_ID, 'puede_crear')` — **data-driven**, nunca por cargo
  (RQ-06.11/12). Ojo: MAND es visible para **todos** por la matriz, así que el gate **no** puede
  derivarse de `puede_ver`.
- Validación `^\d{4}-(0[1-9]|1[0-2])$`; mes futuro → `400 mes_futuro` (paridad con el
  `fecha_futura` de COMB). Mes vacío **no es error**: devuelve el libro con las hojas vacías.
- Responde el `Buffer` `.xlsx` con `Content-Disposition: attachment`. **Solo lectura**: no escribe
  nada en BD (RN-06.f).

---

## Patrones de infraestructura a reutilizar

- **Transacción**: `const t = new sql.Transaction(db); await t.begin(); try { … await t.commit() }
  catch { await t.rollback(); throw }`. Requests con `new sql.Request(t)`.
- **Router**: `router.use(loadAppSession)` + handlers en `asyncH` (D-037). Un endpoint nuevo **nace
  cerrado** por `requireEntra`. **No tocar `server.js`.**
- **Errores**: `responderError` / `mensajeUsuario` (`utils/errores.js`) — **nunca** devolver
  `err.message` crudo (D-032). El front ramifica por `codigo`, jamás por texto.
- **TZ (D-020)**: BD en UTC; presentación Bogotá **explícita**. Backend: `utils/turno.js`
  (`fechaBogotaStr`, `fechaBogotaIso`, `colombiaParts`, `turnoFromPeriodo`,
  `fechaOperativaDePeriodo`, `ventanaTurno`). Front: `src/utils/fecha.js`
  (`getTodayBogota`, `horaBogotaHHMM`). SQL: `CAST(DATEADD(HOUR, -5, columna) AS DATE)`.
  **Prohibido** `getHours()`/`getMonth()` sin shift, `toLocaleString()` para persistir,
  `getTimezoneOffset()`, `Date.now() - 5*3600*1000` ad hoc.
- **Turno**: `utils/turno-entidad.js` → `resolverTurnoAbierto(ctx, planta_id)` (`:144`, acepta pool
  **o** transacción porque solo usa `.request()`).
- **Snapshots**: `utils/snapshots.js` → `snapshotJDTs`, `snapshotJefes`, `snapshotIngenieros`.
  En el reflejo se **reusan** los que la transacción de MAND ya calculó, no se recalculan.
- **Usuario `SISTEMA`**: `dbBindings.USUARIO_SISTEMA_ID` — **no** se usa en el reflejo: el autor de
  la copia es el autor del origen (RN-02.c).
- **Navegación (D-035)**: la sección y su subestado viven en el hash. `src/routing/appRoute.js` +
  `src/hooks/useAppRoute.js`. El `mes` del reporte va como `#/op24h?mes=YYYY-MM` con
  `replaceState` (subestado), **sin** reutilizar el `fecha` de COMB ni el día de la grilla.
- **Front de MAND**: `src/components/SalaDeMando/` (`SalaDeMandoGrid.jsx` orquesta,
  `LotesDelDia.jsx` lista, `LoteEditorModal.jsx`, `LoteBorrarModal.jsx`) + `src/hooks/useSalaDeMando.js`.

### Tests

- **Backend serial siempre**: `cd server && npm test` (lleva `--test-concurrency=1`).
- **La suite corre contra la BD PRODUCTIVA (D-030).** Reglas duras que D-058 hereda:
  - Ningún test escribe/borra en planta real. Usar `TEST_PLANTA_ID` (`'TST'`) y `TEST_TAG`
    (sin `[` ni `]` — SQL Server los lee como wildcards de `LIKE` y el cleanup queda inerte).
  - Todo `DELETE`/`UPDATE` sobre `registro_historico`/`registro_activo`/`evento_dashboard` exige un
    acotador de fixture **léxicamente junto al statement** — lo verifica
    `guard_no_prod_historico_destruction.test.js` (D-055).
  - Sesiones de test se desactivan por `es_sintetico = 1`, **nunca** por username
    (`deactivateSyntheticSessions()`, guard `zzz_session_leak_guard.test.js`, último del script).
  - **Todos los tests de MAND van en `sala_de_mando_batch.test.js`** (D-055): `setupSessions()` mata
    las otras sesiones del mismo fixture (sesión única, D-035) y dos archivos sobre la misma fixture
    se dan 401 mutuo.
  - `guard_tipo_evento_coherente.test.js` (D-053) debe seguir verde: el `tipo_evento_id` de un
    registro **tiene** que pertenecer a su `bitacora_id`.
  - Al agregar un guard nuevo, **engancharlo al script `test` de `server/package.json`** — el de
    D-041 existía y no corría. Y si el guard hace `stripComments`, partir con `/\r?\n/`: con
    `.split('\n')` queda un `\r`, el `.` de una regex JS no lo matchea y el strip queda **inerte**.
- **Baseline conocido:** `finalizar_turno` (4a2/4a3/4e/4f) es **flaky** por borde de turno y por
  fuga de estado con la cabecera TST CERRADO. No es regresión de D-058; documentarlo si aparece.
- **Front**: `npm run build` siempre antes de commitear (build roto bloquea). Vitest para módulos
  puros. **`npm run lint` no existe** en este repo.

---

## Diseño D-058 (acordado)

### 1. El motor — `server/utils/asientos/`

Módulo **puro**: sin BD, sin reloj, sin `fetch`. Entra un objeto plano, sale un string.

```
server/utils/asientos/
├── index.js        → asientoLote(...) · asientoDisponibilidad(...) · asientoLiteralSala(...)
├── formato.js      → unidadCanonica · potenciaMW · listaPeriodos · carga · UNIDAD_YA_NOMBRADA
└── plantillas.js   → las plantillas de §5, una constante por tipo
```

**Convenciones canónicas** (§4 del insumo — todas obligatorias):

| Elemento | Canónico |
|---|---|
| Unidad | `GEC3` · `GEC32` (decisión B) |
| Potencia | `150 MW` — entero, espacio antes de la unidad. **Es potencia por periodo, no `MWh`** |
| Periodo suelto | `P20` |
| Rango contiguo | `P17 al P19` |
| No contiguos | `P3, P7 y P19` |
| Valores distintos | `P17: 109 MW; P18: 134 MW; P19: 164 MW` |
| Cierre | Punto final, siempre |

**Regla de compactación:** si **todas** las celdas del lote comparten valor → forma compacta
(`150 MW del P17 al P19`); si difieren → lista con valor por periodo. Lo decide el sistema; el
operador no elige.

**Plantillas:**

```
AUTH    Se recibe llamada del CND ({funcionariocnd}) autorizando {unidad} a generar {carga}[. {detalle}]
REDESP  Se recibe del CND redespacho para {unidad}: {carga}[. {detalle}]
PRUEBA  Se declara prueba de {unidad} a {carga}[. {detalle}]

DISP · En Servicio     {unidad} E/L en servicio.[ {detalle}]
DISP · En Reserva      {unidad} disponible en reserva, sin generar.[ {detalle}]
DISP · Indisponible    {unidad} F/L indisponible.[ {detalle}]
DISP · Mantenimiento   {unidad} F/L en mantenimiento programado.[ {detalle}]

SALA    {texto del ingeniero, LITERAL} — sin plantilla, sin normalización, sin corregir ortografía
```

- **Sin verbo de sentido en AUTH** (decisión A): el sistema conoce el valor autorizado, no el
  vigente contra el cual compararlo. Nunca "subir"/"bajar"; el matiz va en `detalle`.
- **`detalle` al final, tras punto** (decisión C). Si no hay `detalle`, la frase **termina en el
  dato duro**: nada de rótulo huérfano ni `undefined`.
- **La hora NO va en el texto.** El `HH:MM` es la columna A de la hoja y una columna propia del
  listado. Los `16:38 — …` del insumo ilustran la fila completa, no la plantilla.
- **Prefijo de unidad solo en los renglones de Sala** (respuesta 12), y solo si el texto no la
  nombra ya:
  ```js
  const YA_NOMBRA_UNIDAD = /^\s*(GEC3\b|GEC32\b|U?G\s?3[.,]?[02]\b)/i;
  const asiento = YA_NOMBRA_UNIDAD.test(texto) ? texto.trim() : `${unidad} — ${texto.trim()}`;
  ```
  **Guion largo (`—`) con espacios, nunca `-`**: el corto ya separa nombres de ingenieros
  (`Jose Saavedra - Luis Zapata`). MAND y DISP **no** se prefijan: sus plantillas ya nombran la unidad.

### 2. El reflejo a Sala — `server/utils/reflejo-sala.js`

**Existe una sola vez** e invocable desde la transacción de MAND (REQ-02 §5.2). Tres funciones:
`crearReflejoLote` · `actualizarReflejoLote` · `borrarReflejoLote`.

| Campo de la copia | Valor |
|---|---|
| `bitacora_id` | `SALAJDT` **y** `SALAING` — las dos siempre (RQ-02.2). `SALAOP` nunca (RQ-02.3) |
| `tipo_evento_id` | Resuelto por `(bitacora_id, nombre)` contra la tabla. **Nunca un id literal cacheado** |
| `detalle` | El asiento renderizado por el motor |
| `campos_extra` | `{ "origen_bitacora": "MAND", "origen_lote_id": "<lote_id>" }` |
| `fecha_evento` | **`hora_llamada` del lote** (no el instante de la escritura) |
| `turno_id` | `resolverTurnoAbierto(tx, planta_id)?.turno_unidad_id ?? null` |
| `turno` | Derivado de la hora del asiento |
| `creado_por` | **El autor del origen** (RN-02.c) |
| `estado` | `'borrador'` |
| snapshots | Los que la transacción de MAND ya calculó |

**Por qué `fecha_evento` y `turno_id` van por criterios distintos** (respuesta 14): la hora es
narrativa — el asiento se lee donde el operador lo espera y coincide con el Excel y el listado.
`turno_id` **no** es narrativo: es el **puntero de archivado** (D-045). Si apunta a un turno ya
`CERRADO`, **nadie la archiva nunca** y la copia queda viva en `registro_activo` para siempre. El
rescate de huérfanos de D-045 tampoco la alcanza: ese solo levanta los de `turno_id IS NULL`
en-ventana. Con `NULL` en la ventana de transición (D-046), sí la levanta.
Esto **no** contradice a D-055 (b) — allá la celda pertenece a **un** periodo; acá el asiento es del
**lote entero**, cuyos periodos pueden caer en dos turnos, así que no hay turno semántico único.

**La búsqueda de las copias es por `lote_id`, nunca por `registro_id`** (la copia también migra al
histórico; no hay FK posible — mismo argumento de D-055 (c)):

```sql
FROM bitacora.registro_activo
WHERE JSON_VALUE(campos_extra, '$.origen_lote_id') = @lote_id
  AND bitacora_id IN (@salajdt, @salaing)
```

> **Comentar en el código:** `rowsAffected = 0` **no es error** — es el caso **esperado** tras el
> cierre de turno de Sala, que ya archivó las copias (respuesta 10). Es exactamente la clase de
> "cero filas" que alguien va a querer "arreglar" con un `throw`. **El histórico no se reescribe**
> (RF-032) y la corrección del origen **procede igual**: rechazarla con 409 volvería incorregible un
> lote a las 18:01 por el estado de su reflejo, invirtiendo la jerarquía y contradiciendo el
> criterio 12 de REQ-04, ya probado en D-057 (MAND está exenta de los gates de turno).

Otras reglas: sin retroactividad (RQ-02.13) · `TEST_PLANTA` no refleja (RN-02.e) · el reflejo **no**
notifica al dashboard (RN-02.a) ni cuenta para presencia/conformación (RN-02.b) · atómico con el
origen (RQ-02.9).

### 3. Los tipos espejo y `seleccionable`

Sin columna de visibilidad, **cualquier tipo espejo sembrado se vuelve tecleable a mano**: el JdT
vería `Autorización` en el selector de `SALAJDT` y podría crear un asiento que no refleja ningún
lote — sin `origen_lote_id`, indistinguible de un reflejo real para el Excel e imposible de
rastrear. Es justo la doble digitación que REQ-02 viene a eliminar.

**8 filas** (4 tipos × 2 bitácoras), con `seleccionable = 0`, nombres **literales** del catálogo:

| Bitácora | Tipos espejo a sembrar |
|---|---|
| `SALAJDT` | `Autorización` · `Pruebas` · `Redespacho` · `Cambio de Disponibilidad` |
| `SALAING` | `Autorización` · `Pruebas` · `Redespacho` · `Cambio de Disponibilidad` |

> `Autorización` con tilde y `Pruebas` **en plural** — son los nombres exactos de MAND. Si no se
> copian literales, el histórico termina con dos etiquetas para lo mismo.

El cuarto (`Cambio de Disponibilidad`) se siembra aunque su cableado esté fuera de alcance: el seed
se reconstruye en **cada arranque** y así no hay que volver a tocarlo cuando llegue el ADR de DISP.

### 4. El Excel — plantilla real clonada

**Cero dependencias nuevas** (REQ-01 §5.1: el backend tiene seis deps y así se queda).

- **Offline** — `scripts/derivar-plantilla-f03.mjs`: lee el F03 con `zlib.inflateRawSync` (nativo),
  toma una hoja limpia, **borra las filas de datos** conservando encabezado GENE-F03, logo, estilos,
  merges y área de impresión, y **re-emite el artefacto como ZIP `stored`** en
  `server/assets/f03-plantilla.xlsx`. El script queda en el repo para regenerarla si el formato cambia.
- **En runtime** — `server/utils/xlsx.js` (port ESM del writer) **solo clona bytes e inyecta los
  `sheetN.xml`**: cero `inflate`, cero deps en producción.

**Tres detalles que ahorran dolor:**

1. **`inlineStr` para las filas de datos**, no `sharedStrings`: evita reindexar la tabla de strings
   de la plantilla y corromperla. Las celdas del encabezado se clonan verbatim y conservan sus
   `t="s"` contra el `sharedStrings.xml` preservado.
2. El logo vive en `xl/media/` y se copia tal cual; su `drawing` referencia por `rId` y no hay que
   tocarlo **mientras no se muevan las filas del encabezado**.
3. **La trampa:** el área de impresión es **por hoja** (`<definedName name="_xlnm.Print_Area"
   localSheetId="N">`) y el original trae una por cada uno de sus 32 sheets, con rangos distintos
   (`$A$6:$I$25` … `$A$6:$I$32`). El generador emite **un `definedName` por hoja**, con su
   `localSheetId` (índice 0-based) y su **rango recalculado** al alto real. Clonar el bloque sin
   recalcular hace que Excel imprima rangos vacíos o corte los días largos.

**Partes a regenerar por libro:** `xl/workbook.xml` (sheets + definedNames),
`xl/_rels/workbook.xml.rels`, `[Content_Types].xml`, `docProps/app.xml`, y por día
`xl/worksheets/sheet{N}.xml` + su `_rels` + `xl/drawings/drawing{N}.xml` + su `_rels` +
`xl/printerSettings/printerSettings{N}.bin`.
**Partes intactas:** `styles.xml`, `theme1.xml`, `sharedStrings.xml`, `media/image1.png`,
`_rels/.rels`, `docProps/core.xml`.

### 5. El armado del libro (§7.2 del insumo)

1. Para el día **F**, resolver los tres bloques: `[F 00:00, F 06:00)` (del T2 abierto en **F-1**),
   `[F 06:00, F 18:00)` (T1 de F) y `[F 18:00, F+1 00:00)` (T2 de F).
2. Traer los eventos de **las cuatro fuentes**, de **ambas unidades**, con su hora canónica, y
   asignar cada uno a su bloque **por la hora del calendario**, no por el `turno_id`. Cada evento
   cae en **un solo** bloque de **un solo** día y aparece **una sola vez** en todo el libro.
3. Renderizar con el motor: plantilla para MAND y DISP, literal (con prefijo) para Sala.
4. Ordenar **ascendente** por hora dentro del bloque. (El listado en pantalla va **descendente** por
   `hora_llamada` — RN-04.a — y **son órdenes distintos a propósito**.)
5. Escribir el bloque; si no tiene eventos, quedan el encabezado y ninguna fila.

**Hora canónica por fuente:**

| Fuente | Hora | Gotcha |
|---|---|---|
| MAND | `campos_extra.hora_llamada` (D-056) | **NUNCA `fecha_evento`**: un lote registrado 17:05 por una llamada de 16:38 va en la fila de las **16:38**. Puede estar **AUSENTE** (migrados por `F32.A1`: la clave no existe, no es `null`) → **derivarla del primer periodo del lote** (P17 → 16:00), que es dato real |
| DISP | `fecha_inicio_estado` | El estado se asienta **una vez**, en su instante de inicio — resuelve REQ-06 §8.2 |
| Sala | `fecha_evento` | Excluyendo las filas con `origen_lote_id` |

**Doble tabla sin duplicar** (RN-06.d): el día en curso vive en `registro_activo` y el resto en
`registro_historico`. Un mes que incluya hoy consulta las dos — necesita test explícito del día de
la transición. `TST` nunca se exporta (RN-06.g).

**Encabezado de cada bloque** (respuesta 4): `JEFE DE TURNO` = cargo `Ingeniero Jefe de Turno`,
`INGENIERO DE TURNO` = cargo `Ingeniero de Operación` unidos por ` - `. **Unión deduplicada de las
dos unidades**, sin etiquetar (como el papel). Fuente: `conformacion_turno` del turno que cubre el
bloque; si el turno **no cerró**, se completa con `turno_participante`; si no hay nada, celda en
blanco. El bloque `00:00-06:00` del día F corresponde a `(planta, fecha_operativa = F-1, turno = 2)`.

### 6. Front

- `LotesDelDia.jsx`: el renglón muestra el `asiento` que llega del backend + botón **copiar** por
  renglón y **copiar el día completo** (cierra REQ-04 §8.3).
- `SalaDeMandoGrid.jsx`: `<input type="month">` (default el mes en curso, en **Bogotá**) + botón
  **Descargar**, gateado por `puedeCrear`. Subestado en `#/op24h?mes=YYYY-MM` con `replaceState`.
- `GrillaRegistros`/`RegistroRow`: el asiento reflejado se identifica visiblemente por su origen y
  **no** ofrece lápiz ni basurero (RQ-02.5), derivado del flag advisory `puede_editar` (D-049).

---

## Convenciones a respetar

- **TZ**: BD en UTC (`SYSUTCDATETIME()`), presentación Bogotá explícita. Mes calculado con
  `fechaBogotaStr`, **nunca** `new Date().getMonth()`.
- **Migraciones idempotentes**, gated por `IF COL_LENGTH(...) IS NULL` / `IF NOT EXISTS`, dentro de
  `initDB()`. Los catálogos se reconstruyen en **cada arranque**: un `INSERT` one-shot no sirve.
- **Permisos data-driven**: `hasPermisoBitacora(...)`. **Nunca** hardcodear `cargo_id` ni el nombre
  del cargo en un endpoint ni en el front.
- **La excepción a D-049 no se toca**: MAND no pasa por `canEditarRegistro`; su gate por lote es
  `puede_crear`. Lo único que D-058 agrega a `permissions.js` es el **rechazo de los asientos
  reflejados** — que no es un bypass, es una restricción, y va junto con su espejo SQL del
  `GET /activos` (los dos siempre juntos).
- **No romper el server** si algo externo falla: `try/catch` + log. El reflejo, en cambio, es
  **atómico** con el origen: si falla, la operación entera se revierte (RQ-02.9).
- **No se tocan**: `evento_dashboard`, `disponibilidad_dashboard`, `recalcularEventoDashboard`, el
  lock de REDESP, el diff quirúrgico de D-057, el sweeper de MAND, ni `notify-dashboard.js`.
- **Nunca `INSERT/UPDATE/DELETE` sobre una vista dashboard** — siempre la tabla base (D-041).
- Idioma de todo artefacto, comentario y string visible: **tuteo colombiano estándar, sin voseo**.
