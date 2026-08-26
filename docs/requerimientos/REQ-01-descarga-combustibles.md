# REQ-01 — Descarga del reporte mensual de Combustibles

| Campo | Valor |
|---|---|
| **Código** | REQ-01 |
| **Título** | Botón de descarga del reporte mensual en el apartado de Combustibles |
| **Estado** | 🟡 **Bloqueado** — falta el layout exacto de la hoja (ver §8.1) |
| **Origen** | `pendientes_Ernesto.md`: *"Boton descargar archivo en apartado de combustible"* |
| **Depende de** | Nada. Es el requerimiento más desacoplado de los seis. |
| **Hereda** | ⚠️ **La dependencia se invirtió.** El plan era construir acá la infraestructura de escritura `.xlsx` y que [REQ-06](./REQ-06-excel-eventos-operacion.md) la reutilizara; como este requerimiento siguió bloqueado por su layout, **la construyó D-058**: `server/utils/xlsx.js` (leer/escribir ZIP OOXML en ESM, **sin dependencias**) + el patrón "derivar la plantilla offline con un script versionado y clonar bytes en runtime" + las tres trampas ya pagadas (`inlineStr`, `Print_Area` por hoja, alto de fila estimado en celdas combinadas). Acá solo falta **el layout de su propio formato**. |

---

## 1. Contexto y problema

La pestaña **Consumos de Combustibles** (COMB) captura, para cada día y cada planta, una grilla de
24 periodos × N combustibles. Es un reporte numérico que hoy solo vive dentro de la aplicación: para
consolidarlo, enviarlo o cruzarlo con otras fuentes, alguien tiene que transcribirlo a mano.

El reporte mensual de generación y combustible ya existe como formato controlado fuera del sistema
y se sigue armando manualmente. El objetivo es que la aplicación lo genere.

**No existe hoy ninguna funcionalidad de descarga en todo el proyecto** — ni en el frontend
(cero `Blob` / `createObjectURL` / `<a download>` en `src/`) ni en el backend (cero
`Content-Disposition` en `server/routes/`). Este requerimiento estrena esa capacidad.

## 2. Comportamiento actual

| Aspecto | Situación hoy | Referencia |
|---|---|---|
| UI | Barra superior con título, selector de fecha, leyenda de escala y botón **Guardar** (o chip "Solo lectura") | `src/components/Combustibles/ConsumosGrid.jsx:221-260` |
| Datos en pantalla | Un solo día: el de la fecha seleccionada | `GET /api/combustibles/consumos?planta_id=&fecha=` — `server/routes/combustibles.js:41` |
| Storage | `bitacora.consumo_combustible` (formato largo: una fila por planta+fecha+periodo+combustible) | BIT-MODBD |
| Catálogo | `lov_bit.combustible` (`codigo`, `nombre`, `unidad`, `tipo`, `orden`, `cantidad_max`) | D-027, D-034 |
| Agregado | Vista `bitacora.v_consumo_periodo` — ya calcula `total_carbon_ton`, `caliza_ton`, `acpm_gal` por planta/fecha/periodo | `server/db.js:2002-2013` |
| Descarga | **No existe** | — |

## 3. Comportamiento requerido

### 3.1 Ubicación y disparo

- **RQ-01.1** — En la barra superior del apartado Combustibles aparece un botón **Descargar**, junto
  al botón Guardar / chip "Solo lectura" (bloque `comb-topbar-right`,
  `ConsumosGrid.jsx:230-260`).
- **RQ-01.2** — El botón **no** abre controles adicionales: el periodo a descargar es **el mes de la
  fecha que ya está seleccionada en la grilla**. Si quieres otro mes, cambias la fecha.
- **RQ-01.3** — Al pulsarlo se descargan **dos archivos**: uno para GEC3 y otro para GEC32.
  La descarga no depende de en qué unidad esté la sesión del usuario.

### 3.2 Estructura del archivo

- **RQ-01.4** — Formato **`.xlsx` real** (no CSV, no PDF).
- **RQ-01.5** — **Un archivo por planta.** Cada archivo cubre **un mes completo**.
- **RQ-01.6** — Dentro de cada archivo, **una hoja de cálculo por día del mes**.
- **RQ-01.7** — **Todas** las hojas del mes están presentes, incluso las de días sin ningún consumo
  registrado: en esos casos la hoja lleva los encabezados y ninguna fila de datos. El archivo tiene
  forma constante mes a mes.
- **RQ-01.8** — Cada hoja contiene la información de consumos de ese día para esa planta.
  ⚠️ El layout interno exacto está **bloqueado** — ver §8.1.

### 3.3 Permisos

- **RQ-01.9** — Puede descargar **únicamente quien tiene permiso de crear en COMB**: hoy
  `Ingeniero Jefe de Turno`, `Ingeniero de Operación` y `Administrador y Debugging` (D-048, D-039).
  Los cargos con solo `puede_ver` ven la pestaña pero **no** ven el botón.
- **RQ-01.10** — El enforcement es **data-driven**: se resuelve con `hasPermisoBitacora(sesion,
  COMB_BITACORA_ID, 'puede_crear')` (`server/middleware/permissions.js`), igual que el POST de
  consumos. **No se crea un permiso nuevo** (`puede_exportar` / `puede_descargar` no existen y no
  deben existir) y **no se hardcodea ningún cargo** ni en el endpoint ni en el front.
- **RQ-01.11** — El backend rechaza con **403** aunque el front se evada, igual que
  `POST /api/combustibles/consumos` (`server/routes/combustibles.js:114`).

## 4. Reglas de negocio y casos borde

- **RN-01.a** — Un mes puede contener días futuros (si descargas a mitad de mes). Esos días llevan su
  hoja vacía: el sistema no inventa datos ni omite la hoja.
- **RN-01.b** — La generación es **solo lectura**: descargar no modifica ningún dato ni deja registro
  en bitácora. No emite CIET.
- **RN-01.c** — Los valores se exportan tal como están guardados en `bitacora.consumo_combustible`,
  con la unidad del catálogo (`Ton` para alimentadores y caliza, `Gal` para ACPM). El **Total Carbón**
  es un derivado (`SUM(tipo='ALIMENTADOR')`) y debe salir del mismo cálculo que ya usa la vista
  `v_consumo_periodo`, **no** de una suma reimplementada.
- **RN-01.d** — La planta de test `TST` (D-030) **nunca** se exporta.
- **RN-01.e** — Un mes vacío completo (planta sin ningún registro ese mes) igual produce el archivo,
  con todas sus hojas vacías. No es un error.

## 5. Impacto técnico

### 5.1 Escritura de `.xlsx` — reutilizar, no agregar dependencias

**El workspace ya tiene un escritor OOXML completo, escrito a mano y sin dependencias externas:**
`js-scraper-carbon-g32/xlsx-write.js` (152 líneas). Implementa CRC32, un empaquetador ZIP *stored* y
la generación de `sheet1.xml`, `workbook.xml`, `[Content_Types].xml` y los `_rels`.

Para usarlo desde el backend hay que:
1. Portarlo a `server/utils/xlsx.js` como **ESM** (hoy es CommonJS; el server es `"type": "module"`).
2. Devolver un `Buffer` en vez de escribir a disco — hoy `fs.writeFileSync` en la línea 149 es el
   único punto acoplado al filesystem; el resto de la función es puro.
3. Extenderlo a **múltiples hojas**: hoy genera un solo `sheet1.xml`. Es el único cambio funcional
   real que necesita.
4. Descartar `assertWithinDir` (guard de path traversal, líneas 10-18): no aplica a una respuesta HTTP.

> **No agregar `exceljs`, `xlsx` ni `papaparse`.** El backend hoy tiene exactamente seis
> dependencias (`express`, `mssql`, `ws`, `express-session`, `connect-mssql-v2`, `@azure/msal-node`)
> y no hay razón para crecer.

### 5.2 Archivos a tocar

| Archivo | Cambio |
|---|---|
| `server/utils/xlsx.js` | **Nuevo.** Port ESM del escritor, con soporte multi-hoja, devolviendo `Buffer`. |
| `server/routes/combustibles.js` | **Nuevo endpoint** de exportación: valida `puede_ver`→`puede_crear`, arma el mes, responde con `Content-Disposition: attachment`. |
| `src/components/Combustibles/ConsumosGrid.jsx` | Botón **Descargar** en `comb-topbar-right`, gateado por `puedeCrear`. |
| `src/components/Combustibles/combustibles.css` | Estilo del botón, dentro del scope `.comb-root` (D-033). |

### 5.3 Consultas

Fuente: `bitacora.consumo_combustible` ⨝ `lov_bit.combustible`, agrupada por día. La vista
`bitacora.v_consumo_periodo` ya entrega los agregados por periodo — conviene apoyarse en ella para
que el Total Carbón del Excel y el de la pantalla **no puedan divergir**.

### 5.4 Riesgos

- **Tamaño de respuesta.** Un mes × 2 plantas × 31 hojas × 24 periodos × ~10 combustibles es
  pequeño (decenas de KB), pero el endpoint debe generar en memoria y responder; no hay streaming.
- **Nombre de archivo.** Debe ser determinístico y legible (planta + mes). Sin acentos ni espacios
  problemáticos en el header HTTP.

## 6. Criterios de aceptación

1. **Dado** un usuario con cargo `Ingeniero Jefe de Turno`, **cuando** abre Combustibles,
   **entonces** ve el botón Descargar.
2. **Dado** un usuario con cargo `Operador de Planta - Carbón y Caliza` (solo lectura en COMB),
   **cuando** abre Combustibles, **entonces** **no** ve el botón; y si invoca el endpoint
   directamente, recibe **403**.
3. **Dado** que la grilla muestra la fecha `2026-07-14`, **cuando** pulso Descargar, **entonces**
   obtengo dos archivos `.xlsx` correspondientes a **julio de 2026**, uno de GEC3 y otro de GEC32.
4. **Dado** un mes de 31 días, **cuando** abro cualquiera de los dos archivos, **entonces** tiene
   exactamente 31 hojas, una por día, en orden.
5. **Dado** un día sin ningún consumo registrado, **cuando** abro su hoja, **entonces** tiene los
   encabezados y ninguna fila de datos (no está ausente, no da error).
6. **Dado** un día con consumos, **cuando** comparo el Total Carbón del Excel contra el que muestra
   la grilla en pantalla, **entonces** coinciden para los 24 periodos.
7. **Dado** el archivo generado, **cuando** lo abro en Excel, **entonces** abre sin advertencias de
   archivo corrupto o de recuperación.
8. **Dado** cualquier descarga, **cuando** reviso la base de datos, **entonces** no cambió ningún
   dato ni se creó ningún registro.

## 7. Fuera de alcance

- Cualquier formato que no sea `.xlsx` (CSV, PDF, impresión).
- Descargar rangos que no sean un mes calendario.
- Programar envíos automáticos del reporte por correo.
- Un apartado centralizado de "Reportes": la descarga vive en cada apartado.
- Modificar el modelo de datos de consumos.

## 8. Preguntas abiertas

### 8.1 🔴 BLOQUEANTE — layout de la hoja

El contenido y la estructura de cada hoja deben replicar **1 a 1** el formato de referencia:

> `2026_04 Reporte diario de generación y combustible G3 y G32 (1).xlsx` (raíz del repositorio)

Falta especificar: orden y rótulo de columnas, filas de encabezado, celdas de totales, formato de
números, y si hay bloques del formato original que el sistema **no** puede llenar (porque el dato no
existe en la aplicación) y deben quedar en blanco.

**Este punto se trata en una sesión aparte.** Hasta entonces el requerimiento no es implementable.

### 8.2 Menores

- ¿El archivo debe llamarse igual que el formato controlado (con su código `OPG3-Fxx`) o basta un
  nombre descriptivo?
- Si un mes está en curso, ¿el archivo se marca de alguna forma como parcial?
