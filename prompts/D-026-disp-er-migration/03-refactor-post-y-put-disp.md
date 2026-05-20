# Prompt 03 — Refactor POST y PUT rama DISP (D-026)

**Working directory:** `Bit-cora-g3/`
**Plan global:** `prompts/D-026-disp-er-migration/00-README.md`
**Pre-requisitos:** prompts 01 (DDL) y 02 (helpers) ya corridos.

## Tu tarea

Reescribir dos branches de DISP en `server/server.js`:

(a) **POST /api/registros**, rama DISP (líneas ~580–749, ~170 LoC actuales).
(b) **PUT /api/registros/:id**, rama DISP (líneas ~940–1089, ~150 LoC actuales).

**El shape de request y response debe quedar BYTE-A-BYTE idéntico al actual.** Los 18 tests existentes en `server/tests/disponibilidad.test.js` deben pasar sin tocarse.

## Contexto

Hasta antes de este refactor, los handlers escribían a **dos tablas en paralelo**: `bitacora.registro_activo`/`registro_historico` (storage genérico con `campos_extra` JSON) y `bitacora.disponibilidad_dashboard` (tabla puente para cross-repo). Ahora hay **una sola tabla**: `bitacora.disponibilidad_estado`. La vista `disponibilidad_dashboard` deriva de ella, así que NO se escribe directamente.

Antes (pseudo-código):
```
SELECT vigente FROM registro_activo WITH (UPDLOCK, HOLDLOCK)
  → UPDATE registro_activo.fecha_fin_estado
  → INSERT registro_historico
  → DELETE registro_activo
  → snapshotJDTs/Jefes/Ingenieros
  → INSERT registro_activo (nuevo vigente)
  → upsertDisponibilidadDashboard
  → commit
```

Después:
```
SELECT vigente FROM disponibilidad_estado WITH (UPDLOCK, HOLDLOCK)
  → UPDATE disponibilidad_estado.fecha_fin_estado (cerrar vigente)
  → snapshotJDTs/Jefes/Ingenieros/GerentesProduccion
  → INSERT disponibilidad_estado (nuevo vigente)
  → commit
```

Mucho menos código. La vista `disponibilidad_dashboard` queda sincronizada automáticamente.

## Imports a agregar

En el header de `server/server.js`:

```js
import {
  findVigente, findUltimoCerrado, insertNuevoEstado,
  cerrarVigente, actualizarVigente,
} from './utils/notificador.js';

import {
  snapshotJDTs, snapshotJefes, snapshotIngenieros, snapshotGerentesProduccion,
} from './utils/snapshots.js';
```

Quitar imports a `upsertDisponibilidadDashboard`, `findDisponibilidadDashboard`, `deleteDisponibilidadDashboard` (helpers eliminados en prompt 02).

## (a) POST /api/registros — rama DISP

### Shape de input (sin cambio)

```js
{
  bitacora_id,          // int — debe ser el de DISP
  planta_id,            // 'GEC3' | 'GEC32'
  fecha_evento,         // ISO UTC — la fecha del cambio de estado
  campos_extra: {
    evento,             // 'En Servicio' | 'En Reserva' | 'Indisponible' | 'Mantenimiento'
    codigo,             // 1 | 0 | -1
    fecha_inicio_estado // opcional — si viene, usa esta; si no, usa fecha_evento
  },
  detalle               // string opcional
}
```

### Shape de response (sin cambio)

```js
// 201
{
  registro: { /* row insertado en disponibilidad_estado, con campos_extra reconstruido para compat */ },
  vigente_anterior_movido_id: <int>|null
}

// 409 mismo_estado
{
  error: 'mismo_estado',
  mensaje: `${planta_id} ya está en estado ${vigEvento}`,
  vigente: { registro_id, evento, fecha_inicio_estado }
}

// 409 fecha_anterior_a_vigente
{
  error: 'fecha_anterior_a_vigente',
  mensaje: '...',
  vigente: { registro_id, evento, fecha_inicio_estado }
}

// 400 / 422 — varios (input inválido, planta inactiva, evento inválido, fecha futura)
```

**CRÍTICO**: el `registro` en la response debe seguir teniendo `registro_id` (no `disponibilidad_id`) para que el frontend lo siga consumiendo. Mapear: `registro_id: row.disponibilidad_id`. Otros campos a mapear:
- `campos_extra: JSON.stringify({ evento: row.estado, codigo: row.codigo, fecha_inicio_estado: row.fecha_inicio_estado })` (reconstruir el JSON que el frontend lee)
- Resto de columnas tal cual (`planta_id`, `detalle`, `creado_por`, `creado_en`, `jdts_snapshot`, `jefes_snapshot` ← desde `jefes_planta_snapshot`, `ingenieros_snapshot`)

### Flujo nuevo

```js
if (bitacoraCodigo === 'DISP') {
  // 1. Permiso puede_crear en DISP
  if (!(await hasPermisoBitacora(sesion, bitacora_id, 'puede_crear'))) {
    return sendJSON(res, 403, { error: 'Sin permiso para crear en esta bitácora' });
  }

  // 2. Validar planta operativa
  // 3. Parsear campos_extra → extra.evento, extra.fecha_inicio_estado ?? body.fecha_evento
  // 4. Validar evento en DISP_EVENTOS_VALIDOS
  // 5. Validar fecha_inicio_estado parseable + no futura

  const codigoVal = DISP_CODIGO_POR_EVENTO[evento];

  const tx = new sql.Transaction(db);
  await tx.begin();
  try {
    const vigente = await findVigente(tx, { planta_id });
    let vigenteAnteriorMovidoId = null;

    if (vigente) {
      // 409 mismo_estado
      if (evento === vigente.estado) {
        await tx.rollback();
        return sendJSON(res, 409, {
          error: 'mismo_estado',
          mensaje: `${planta_id} ya está en estado ${vigente.estado}`,
          vigente: {
            registro_id: vigente.disponibilidad_id,
            evento: vigente.estado,
            fecha_inicio_estado: vigente.fecha_inicio_estado.toISOString(),
          },
        });
      }
      // 409 fecha_anterior_a_vigente
      if (fechaInicio.getTime() <= new Date(vigente.fecha_inicio_estado).getTime()) {
        await tx.rollback();
        return sendJSON(res, 409, {
          error: 'fecha_anterior_a_vigente',
          mensaje: `La fecha es anterior o igual al inicio del estado vigente`,
          vigente: {
            registro_id: vigente.disponibilidad_id,
            evento: vigente.estado,
            fecha_inicio_estado: vigente.fecha_inicio_estado.toISOString(),
          },
        });
      }
      await cerrarVigente(tx, { disponibilidad_id: vigente.disponibilidad_id, fecha_fin: fechaInicio });
      vigenteAnteriorMovidoId = vigente.disponibilidad_id;
    }

    const reqFactory = () => new sql.Request(tx);
    const jdts_snapshot = await snapshotJDTs(reqFactory, { planta_id });
    const jefes_planta_snapshot = await snapshotJefes(reqFactory);
    const gerentes_produccion_snapshot = await snapshotGerentesProduccion(reqFactory);
    const ingenieros_snapshot = await snapshotIngenieros(reqFactory, { planta_id });

    const row = await insertNuevoEstado(tx, {
      planta_id, estado: evento, codigo: codigoVal,
      fecha_inicio_estado: fechaInicio, detalle: detalle ?? null,
      jdts_snapshot, jefes_planta_snapshot, gerentes_produccion_snapshot, ingenieros_snapshot,
      creado_por: sesion.usuario_id,
    });

    await tx.commit();
    broadcastConteoBitacoras(planta_id).catch(() => {});

    // Mapear a shape compat
    const registro = mapDispRowToLegacyShape(row);  // helper definido abajo
    return sendJSON(res, 201, { registro, vigente_anterior_movido_id: vigenteAnteriorMovidoId });
  } catch (err) {
    try { await tx.rollback(); } catch {}
    throw err;
  }
}
```

### Helper de mapping (cerca del top de la rama DISP o en utils)

```js
function mapDispRowToLegacyShape(row) {
  return {
    registro_id: row.disponibilidad_id,
    bitacora_id: DISP_BITACORA_ID,                    // cachear al arranque o resolver del peek
    planta_id: row.planta_id,
    fecha_evento: row.fecha_inicio_estado,
    turno: null,
    detalle: row.detalle,
    campos_extra: JSON.stringify({
      evento: row.estado,
      codigo: row.codigo,
      fecha_inicio_estado: row.fecha_inicio_estado instanceof Date
        ? row.fecha_inicio_estado.toISOString()
        : row.fecha_inicio_estado,
    }),
    tipo_evento_id: null,
    estado: 'borrador',
    ingenieros_snapshot: row.ingenieros_snapshot,
    jdts_snapshot: row.jdts_snapshot,
    jefes_snapshot: row.jefes_planta_snapshot,          // compat: el frontend espera 'jefes_snapshot'
    creado_por: row.creado_por,
    creado_en: row.creado_en,
    modificado_por: row.modificado_por,
    modificado_en: row.modificado_en,
    fecha_fin_estado: row.fecha_fin_estado,
  };
}
```

## (b) PUT /api/registros/:id — rama DISP

### Shape de input (sin cambio)

```js
{
  campos_extra: { evento?, codigo?, fecha_inicio_estado? },
  detalle?,
  fecha_evento?  // alias legacy: si viene sin campos_extra.fecha_inicio_estado, usar este
}
```

### Shape de response (sin cambio)

```js
{ registro: { /* row actualizado con shape legacy */ } }
```

### Validaciones a preservar

- Solo se edita el vigente (`fecha_fin_estado IS NULL`). Si el `:id` no es el vigente → 422 `'Solo se puede editar el registro vigente de DISP'`.
- `planta_id` NO editable → 422 `'planta_id no editable en DISP'`.
- Si cambia `evento`: validar `nuevo !== N-1.estado` → 409 `mismo_estado_que_anterior` con `{ n_menos_1: { evento } }`.
- Si cambia `fecha_inicio_estado`: validar `>= N-1.fecha_inicio_estado` y `<= now`.

### Flujo nuevo

```js
// Branch DISP en PUT (después del lookup que determina el registro)
if (reg.bitacora_codigo === 'DISP') {
  // Validar es vigente
  if (reg.fecha_fin_estado !== null) {
    return sendJSON(res, 422, { error: 'Solo se puede editar el registro vigente de DISP' });
  }
  // Validar planta_id no editable
  if (body.planta_id && body.planta_id !== reg.planta_id) {
    return sendJSON(res, 422, { error: 'planta_id no editable en DISP' });
  }

  // Parsear extras del body
  const extraNuevo = parseExtra(body.campos_extra) ?? {};
  const evento_nuevo = extraNuevo.evento ?? reg.estado;
  const fecha_inicio_nuevo_raw = extraNuevo.fecha_inicio_estado ?? body.fecha_evento ?? reg.fecha_inicio_estado;
  const fecha_inicio_nuevo = new Date(fecha_inicio_nuevo_raw);
  const detalle_nuevo = body.detalle !== undefined ? body.detalle : reg.detalle;

  if (!DISP_EVENTOS_VALIDOS.includes(evento_nuevo)) {
    return sendJSON(res, 400, { error: `evento debe ser uno de: ${DISP_EVENTOS_VALIDOS.join(', ')}` });
  }
  if (Number.isNaN(fecha_inicio_nuevo.getTime())) {
    return sendJSON(res, 400, { error: 'fecha_inicio_estado inválido' });
  }
  if (fecha_inicio_nuevo.getTime() > Date.now()) {
    return sendJSON(res, 422, { error: 'fecha_inicio_estado no puede ser futuro' });
  }

  const codigo_nuevo = DISP_CODIGO_POR_EVENTO[evento_nuevo];

  const tx = new sql.Transaction(db);
  await tx.begin();
  try {
    const nMenos1 = await findUltimoCerrado(tx, { planta_id: reg.planta_id });

    // 409 mismo_estado_que_anterior
    if (nMenos1 && evento_nuevo !== reg.estado && evento_nuevo === nMenos1.estado) {
      await tx.rollback();
      return sendJSON(res, 409, {
        error: 'mismo_estado_que_anterior',
        mensaje: `No puede repetir el estado anterior (${nMenos1.estado})`,
        n_menos_1: { evento: nMenos1.estado },
      });
    }

    // Validar fecha vs N-1
    const fechaCambio = fecha_inicio_nuevo.getTime() !== new Date(reg.fecha_inicio_estado).getTime();
    if (fechaCambio && nMenos1) {
      if (fecha_inicio_nuevo.getTime() < new Date(nMenos1.fecha_inicio_estado).getTime()) {
        await tx.rollback();
        return sendJSON(res, 422, {
          error: 'fecha_inicio_anterior_a_n_menos_1',
          mensaje: 'La fecha no puede ser anterior al inicio del estado anterior',
        });
      }
    }

    // Snapshots actualizados (capturan estado actual del personal)
    const reqFactory = () => new sql.Request(tx);
    const jdts_snapshot = await snapshotJDTs(reqFactory, { planta_id: reg.planta_id });
    const jefes_planta_snapshot = await snapshotJefes(reqFactory);
    const gerentes_produccion_snapshot = await snapshotGerentesProduccion(reqFactory);
    const ingenieros_snapshot = await snapshotIngenieros(reqFactory, { planta_id: reg.planta_id });

    await actualizarVigente(tx, {
      disponibilidad_id: reg.disponibilidad_id ?? reg.registro_id,
      estado: evento_nuevo, codigo: codigo_nuevo,
      fecha_inicio_estado: fecha_inicio_nuevo, detalle: detalle_nuevo,
      jdts_snapshot, jefes_planta_snapshot, gerentes_produccion_snapshot, ingenieros_snapshot,
      modificado_por: sesion.usuario_id,
    });

    // Si la fecha cambió, actualizar N-1.fecha_fin_estado para mantener cronología sin gap
    if (fechaCambio && nMenos1) {
      await new sql.Request(tx)
        .input('id', sql.Int, nMenos1.disponibilidad_id)
        .input('fin', sql.DateTime2, fecha_inicio_nuevo)
        .query(`UPDATE bitacora.disponibilidad_estado SET fecha_fin_estado=@fin WHERE disponibilidad_id=@id`);
    }

    await tx.commit();

    // Re-fetch para devolver el row actualizado
    const actualizado = (await db.request()
      .input('id', sql.Int, reg.disponibilidad_id ?? reg.registro_id)
      .query(`SELECT * FROM bitacora.disponibilidad_estado WHERE disponibilidad_id=@id`)).recordset[0];

    return sendJSON(res, 200, { registro: mapDispRowToLegacyShape(actualizado) });
  } catch (err) {
    try { await tx.rollback(); } catch {}
    throw err;
  }
}
```

### Importante (PUT)

El lookup de `reg` al inicio del PUT debe traer también `bitacora_codigo` y `fecha_fin_estado` desde la tabla nueva (no `registro_activo`). Tenés que detectar primero si el `:id` corresponde a una row de `disponibilidad_estado` (es DISP por construcción) o a `registro_activo` (otras bitácoras). Hay dos formas:

- **Opción A (recomendada)**: nuevo path. Hacer un lookup combinado: `SELECT ... FROM bitacora.disponibilidad_estado WHERE disponibilidad_id=@id UNION SELECT ... FROM bitacora.registro_activo ra JOIN lov_bit.bitacora b ON b.bitacora_id=ra.bitacora_id WHERE ra.registro_id=@id`. Quedarte con la fila que matchee.
- **Opción B**: agregar un parámetro de query `?tipo=DISP` que el frontend ya manda. (Si NO lo manda, romper esto.)

Mirá el código actual del PUT para ver qué lookup hace hoy y adaptá. **Tip**: el frontend NO distingue DISP por path — usa `PUT /api/registros/:id` igual que para las demás. El backend tiene que distinguir leyendo el id en ambas tablas.

## Verificación

```powershell
cd server
node --check server.js  # debe pasar la sintaxis

# Levantar server
node --watch --env-file=../.env server.js

# En otra terminal: correr los 18 tests existentes (NO deben necesitar modificación)
node --test --env-file=../.env tests/disponibilidad.test.js

# Casos críticos a inspeccionar manualmente:
# - Test 1: crear primer estado → 201 con registro.registro_id + vigente_anterior_movido_id=null
# - Test 2: crear segundo estado → 201, vigente_anterior_movido_id no-null, anterior cerrado
# - Test 3: 409 mismo_estado (mensaje y shape exacto)
# - Test 4: 409 fecha_anterior_a_vigente
# - Test 6-7: PUT vigente cambia fecha → N-1 se ajusta
# - Test 15: rechaza evento legacy 'Disponible'
```

## Lo que NO hagas en este prompt

- NO toques `POST /api/disponibilidad/deshacer` (prompt 04).
- NO toques `GET /api/disponibilidad`, `metricas`, `eventos-dashboard` (prompt 04).
- NO modifiques tests (prompt 05).
- NO toques docs (prompt 06).
- NO escribas a `registro_activo`/`registro_historico` para DISP. Esas tablas ya no contienen DISP rows.
