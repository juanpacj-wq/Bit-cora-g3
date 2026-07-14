# D-053 · E2 — Migración `F30.A1` + reporte pre-flight

## Antes de empezar (obligatorio)
1. Leé `_CONTEXTO-BASE.md` completo y `ESTADO.md`.
2. **Verificá que E1 figure ✅.** Si no, detenete: sin las 3 bitácoras en el catálogo esta etapa no
   tiene destino a dónde mover.
3. Releé "Datos descubiertos": E1 anotó los `bitacora_id` reales de SALAING/SALAOP.

## Alcance de esta etapa

**Entra:** la migración one-shot `F30.A1` que reparte los registros de `bitacora_id=14` según el cargo
del autor, en `registro_activo` y `registro_historico`; el reporte pre-flight de solo lectura para
prod; y su guardrail de no-auto-ejecución.

**NO entra:** tests (E3), docs/ADR (E4).

## Contexto que decide el diseño (leer antes de escribir SQL)

- **El cargo no está en el registro.** Se reconstruye por evidencia. Ver la escalera abajo.
- **La BD de planeación fue dev** (0 activos, 2 históricos, un autor con 5 cargos). **Prod es
  desconocido.** Por eso: reporte primero, migración después, y **nunca adivinar**.
- **Move-out por atribución positiva.** Tras el rename de E1 todos los registros ya están en id=14 =
  SALAJDT. La migración **solo mueve** lo que atribuye a IngOp o a Op de Sala. Lo no atribuible **no se
  toca** (identidad) y se cuenta. **No uses `THROW` para datos ambiguos**: tumbaría el arranque del
  backend en prod. El `THROW` se reserva para violaciones de integridad (ver tarea 3, paso 5).
- **Riesgo #1 — el acoplamiento que no perdona.** No existe FK ni CHECK que ate
  `registro.bitacora_id` ↔ `tipo_evento.bitacora_id`, y **ninguna lectura lo verifica**
  (`registros.js:107-112` y la vista `v_historico_busqueda`, `db.js:2300-2304`, joinean `te` por
  `tipo_evento_id` a secas). Un registro movido sin remapear su tipo **se ve perfecto en la grilla** y
  solo explota cuando alguien lo edita — cuando el drift ya viajó al histórico inmutable.
  **Todo `UPDATE` de `bitacora_id` remapea `tipo_evento_id` en el mismo statement.**

## Tareas

1. **Reporte pre-flight** — `sql/snippets/reporte-split-sala-D053.sql`. **Solo lectura** (solo
   `SELECT`; ni un `UPDATE`/`INSERT`/`DELETE`). Va con cabecera que explique qué es, cómo se corre
   (SSMS contra prod, antes del deploy) y que no modifica nada. Debe responder:
   - Conteo de registros en la bitácora 14, separado `registro_activo` / `registro_historico`.
   - Autores distintos y, por autor, cuántos `cargo_id` distintos tiene en `sesion_activa`.
   - Cuántos resuelve **cada escalón** de la escalera (1, 2, 3) por separado — no solo el total.
   - Desglose final por bitácora destino (SALAJDT / SALAING / SALAOP).
   - **El número que decide: cuántos quedan SIN atribuir.** Con detalle fila a fila
     (`registro_id`, `creado_por`, `turno_id`, `fecha_evento`) para poder triagearlos a mano.

2. **Guardrail** — `server/tests/guard_reporte_split_sala_no_auto_ejecutable.test.js`. Copiá el molde
   de `server/tests/guard_purga_no_auto_ejecutable.test.js`: estático (lee los fuentes, no toca BD),
   verifica que ni `db.js` ni `server.js` ni el runner de tests referencien el snippet, y —extra— que
   el propio `.sql` no contenga DML (`UPDATE|INSERT|DELETE|MERGE|DROP|TRUNCATE` fuera de comentarios).

3. **Migración `F30.A1`** — `server/db.js`, **después** del bloque de la matriz y junto a las otras
   migraciones one-shot (patrón F28.A1, `db.js:2103-2147`, que es el molde más limpio). Estructura:

   ```
   guard: SELECT 1 FROM bitacora.migracion_aplicada WHERE codigo='F30.A1'  → if (!recordset[0]) {
     tx = new sql.Transaction(db); await tx.begin();
     try {
       paso 1 — resolver ids destino (SALAING, SALAOP) por codigo; si faltan, THROW (E1 no corrió).
       paso 2 — respaldo RF-032 (solo si aún no existe la tabla).
       paso 3 — mover registro_activo   (bitacora_id + tipo_evento_id acoplados).
       paso 4 — mover registro_historico (idem).
       paso 5 — validación de integridad → THROW si hay drift.
       paso 6 — INSERT INTO migracion_aplicada ('F30.A1')   ← último statement antes del commit
       await tx.commit();
       console.log('[F30.A1] …conteos movidos y no atribuidos…');
     } catch (err) { try { await tx.rollback(); } catch {} throw err; }
   }
   ```

   **Paso 2 — respaldo (obligatorio, RF-032).** Antes de tocar `registro_historico`, copiá las filas
   afectadas. Idempotente y dentro de la transacción:
   ```sql
   IF OBJECT_ID('bitacora.registro_historico_backup_D053','U') IS NULL
     SELECT * INTO bitacora.registro_historico_backup_D053
     FROM bitacora.registro_historico WHERE bitacora_id = @salajdt;
   ```
   Queda **residente** como evidencia de auditoría y habilita el rollback. No la borres en E4.

   **Pasos 3 y 4 — la escalera de atribución.** `COALESCE`, la primera que resuelve gana. Aplicá el
   mismo CTE a las dos tablas (`registro_historico` no tiene FKs; `registro_activo` sí — ambas
   soportan el `UPDATE`):
   ```sql
   ;WITH cargo_autor AS (
     SELECT r.registro_id,
            COALESCE(
              -- 1. evidencia exacta: presencia viva por turno
              (SELECT TOP 1 tp.cargo_id FROM bitacora.turno_participante tp
                WHERE tp.turno_id = r.turno_id AND tp.usuario_id = r.creado_por),
              -- 2. evidencia exacta: conformación congelada
              (SELECT TOP 1 ct.cargo_id FROM bitacora.conformacion_turno ct
                WHERE ct.turno_id = r.turno_id AND ct.usuario_id = r.creado_por),
              -- 3. el autor solo usó UN cargo en toda su historia de sesiones
              (SELECT MIN(sa.cargo_id) FROM bitacora.sesion_activa sa
                WHERE sa.usuario_id = r.creado_por
                HAVING COUNT(DISTINCT sa.cargo_id) = 1)
            ) AS cargo_id
     FROM bitacora.registro_historico r        -- (y su gemelo para registro_activo)
     WHERE r.bitacora_id = @salajdt
   )
   UPDATE r
      SET r.bitacora_id    = destino.bitacora_id,
          r.tipo_evento_id = destino.tipo_evento_id   -- ← acoplado, NUNCA por separado
   FROM bitacora.registro_historico r
   JOIN cargo_autor ca ON ca.registro_id = r.registro_id
   JOIN (…resolución de (cargo_id → bitacora destino + su 'Evento General')…) destino
        ON destino.cargo_id = ca.cargo_id
   WHERE r.bitacora_id = @salajdt;
   ```
   Mapeo de destino: `Ingeniero de Operación` → SALAING; `Operador de Planta - Sala de Mando` →
   SALAOP. **Todo lo demás** (JdT, Admin, cargo no resuelto → `cargo_id IS NULL`) **no matchea el JOIN
   y se queda en SALAJDT**, que es exactamente la política acordada. Resolvé el `tipo_evento_id`
   destino por `(bitacora_id, nombre='Evento General')`.

   Resolvé los cargos por **nombre** (`lov_bit.cargo.nombre`), no por id hardcodeado: los ids no son
   estables entre BDs (la matriz de `db.js` matchea por nombre justamente por eso).

   **Paso 5 — validación de integridad.** Esto **sí** va con `THROW` (es una violación, no una
   ambigüedad):
   ```sql
   IF EXISTS (
     SELECT 1 FROM bitacora.registro_historico r
     JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = r.tipo_evento_id
     WHERE te.bitacora_id <> r.bitacora_id
   ) THROW 50053, 'F30.A1: drift tipo_evento_id <> bitacora_id tras la migración', 1;
   ```
   Idem para `registro_activo`. Va **antes** del `INSERT` del flag → si falla, rollback y reintento en
   el próximo arranque.

   **Log post-commit**: cuántos se movieron a cada destino y **cuántos quedaron sin atribuir**. Ese
   número tiene que quedar en los logs de prod para la auditoría.

## Verificación (antes de commitear)

- `cd server && npm test` — mismo baseline que dejó E1 (los rojos de `ia_cliente` /
  `registros_solo_autor` siguen ahí hasta E3; **no deben aparecer rojos nuevos**).
- Reiniciá el backend y confirmá en dev:
  ```sql
  SELECT codigo FROM bitacora.migracion_aplicada WHERE codigo='F30.A1';   -- 1 fila

  -- Integridad: DEBE devolver 0 filas en ambas tablas.
  SELECT COUNT(*) FROM bitacora.registro_historico r
    JOIN lov_bit.tipo_evento te ON te.tipo_evento_id = r.tipo_evento_id
   WHERE te.bitacora_id <> r.bitacora_id;

  -- Reparto real
  SELECT b.codigo, COUNT(*) FROM bitacora.registro_historico r
    JOIN lov_bit.bitacora b ON b.bitacora_id = r.bitacora_id
   WHERE b.codigo LIKE 'SALA%' GROUP BY b.codigo;

  SELECT COUNT(*) FROM bitacora.registro_historico_backup_D053;  -- respaldo poblado
  ```
  **Esperado en dev** (según "Datos descubiertos"): los 2 registros históricos se quedan en SALAJDT
  (autores JdT y Admin → ninguno matchea el JOIN de move-out), respaldo con 2 filas, 0 drift.
- **Idempotencia**: reiniciá una segunda vez y confirmá que no vuelve a correr (el flag lo frena) y que
  los conteos no cambian.
- Corré el reporte pre-flight contra dev y verificá que sus conteos **coinciden** con el resultado real
  de la migración. Es la prueba de que el reporte predice bien antes de usarlo contra prod.

## Actualizar ESTADO.md (obligatorio antes de cerrar)
- Marcá E2 ✅ con resumen.
- Bloque `### E2 — Migración F30.A1 + reporte pre-flight  ✅` con **Archivos tocados**,
  **Verificación** (conteos reales) y **Desviaciones**.
- En "Datos descubiertos": el reparto real en dev y si el reporte predijo exacto.

## Commit

```bash
git add server/db.js sql/snippets/reporte-split-sala-D053.sql \
        server/tests/guard_reporte_split_sala_no_auto_ejecutable.test.js \
        prompts/D-053-split-sala-por-rol/ESTADO.md
git commit -m "$(cat <<'EOF'
feat(SALA): migración F30.A1 de registros por cargo del autor

Tras el rename de E1 todos los registros de Sala quedaron en SALAJDT. F30.A1 los
reparte a SALAING/SALAOP según el cargo del autor.

El cargo no está almacenado en el registro: creado_por es un usuario_id y el cargo
se resuelve desde el App Role de Entra en cada login, sin persistirse. Se
reconstruye por evidencia, en escalera: turno_participante y conformacion_turno por
turno_id (exactas, cubren todo lo post-D-045), y como último recurso sesion_activa
cuando el autor solo usó un cargo en toda su historia.

Política: move-out por atribución positiva. Solo se mueve lo atribuible a IngOp o a
Op de Sala; lo no atribuible NO se toca (se queda en SALAJDT) y se reporta en el log.
Nunca se adivina, y no hay THROW por ambigüedad — eso tumbaría el arranque en prod.

Todo UPDATE de bitacora_id remapea tipo_evento_id en el mismo statement: no existe
FK ni CHECK que ate registro.bitacora_id con tipo_evento.bitacora_id y ninguna
lectura lo verifica, así que el drift sería invisible hasta que alguien editara el
registro — con el dato corrupto ya en el histórico. Validación con THROW antes del
flag.

registro_historico es append-only por convención (RF-032, sin trigger). Tocarlo es
una excepción deliberada: las filas afectadas se respaldan en
registro_historico_backup_D053 dentro de la misma transacción, como rastro de
auditoría y para habilitar rollback.

El snippet de reporte pre-flight es de solo lectura y se corre a mano contra prod
antes del deploy: expone el reparto esperado y, sobre todo, cuántos registros
quedarían sin atribuir. Guardrail estático impide que initDB/CI lo invoquen.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```
