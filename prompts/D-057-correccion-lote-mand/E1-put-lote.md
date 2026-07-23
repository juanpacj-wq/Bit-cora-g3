# D-057 · E1 — `PUT /api/sala-de-mando/lotes/:lote_id` (diff quirúrgico)

## Antes de empezar (obligatorio)

1. Leé `_CONTEXTO-BASE.md` completo y `ESTADO.md`.
2. Verificá que E0 figure ✅ en el tablero de `ESTADO.md`.
3. Releé "Decisiones / desviaciones acumuladas" y "Datos descubiertos".
4. Confirmá que estás en el branch del flujo: `feat/mand-correccion-lote-2026-07` (si no existe,
   creálo desde `main`).

## Alcance de esta etapa

**Entra:** el endpoint `PUT /api/sala-de-mando/lotes/:lote_id` en `server/routes/mand.js` — resolución
del lote, validaciones, diff quirúrgico transaccional, recálculo de la publicación por celda tocada
y notificación post-commit. **Más una prueba de humo happy-path** en
`server/tests/sala_de_mando_batch.test.js` (la matriz completa es E3, pero esta etapa no aterriza sin
cobertura — decisión 8).

**NO entra:** el `DELETE` (E2), el front (E4), la cascada a SALAJDT/SALAING (fuera de alcance: solo
el comentario de enganche), el formato de mensaje (fuera de alcance), ni tocar `permissions.js`
(decisión 5: **no se toca**).

## Tareas

1. **Helper de resolución del lote** en `mand.js` (junto a `resolverTurnoUnidadId`, `mand.js:27`):
   `resolverLoteVivo(reqOrTransaction, { lote_id, planta_id })` → devuelve las filas vivas del lote
   con `registro_id`, `planta_id`, `fecha_evento`, `detalle`, `tipo` (`te.notificar_dashboard_tipo`),
   `periodo`, `valor_mw`, `funcionariocnd`, `hora_llamada`, leídas de `bitacora.registro_activo`
   (`estado='borrador'`, `bitacora_id = MAND`) por `JSON_VALUE(campos_extra,'$.lote_id')`.
   - Sin filas → consultar `registro_historico` por el mismo `lote_id`: si aparece, el caller
     responde **`409 { error:…, codigo:'lote_cerrado' }`**; si no, **`404 … codigo:'lote_inexistente'`**
     (decisión 10).
   - Filas de otra planta → `403` (no revelar contenido de otra unidad).
   - Dentro del `PUT` esta lectura va **dentro de la transacción** (decisión 7: el diff se calcula
     contra el estado real de la BD, no contra el snapshot que vio el modal).

2. **Handler `PUT /lotes/:lote_id`** (colocalo después de `GET /lotes`, antes de `POST /guardar`):
   - `router.use(loadAppSession)` ya aplica. Envolver en `asyncH`.
   - Body: `{ planta_id, hora, detalle, funcionariocnd, periodos: [{periodo, valor_mw}] }`.
     **El `tipo` NO se acepta** — es inmutable (decisión 11); si el body lo trae, se ignora en
     silencio (el tipo sale de las filas del lote).
   - Gate: `plantaMatch(sesion, planta_id)` → 403; lookup de `MAND_ID` +
     `hasPermisoBitacora(sesion, MAND_ID, 'puede_crear')` → 403. **Sin** chequeo de `creado_por`
     (esta es la excepción a D-049) y **sin** allowlist de plantas (D-055).
   - **No** aplicar ningún gate de turno: MAND está exento de `turno_finalizado`/`turno_cerrado`/
     `turno_en_transicion` (D-040/D-045/D-046) — criterio 12.

3. **Validaciones** (acumulan en `errores[]` y **no escriben nada** si hay alguna; mismo contrato que
   `POST /guardar`: los errores de celda llevan `periodo`, los del lote **no**):
   - `periodos` array; cada `periodo` entero 1..24; `valor_mw` finito y **no nulo** (una celda sin
     valor simplemente no viaja).
   - `hora`: `HH:mm` Bogotá, compuesta **server-side** contra la **fecha del lote**
     (`fechaBogotaStr(fecha_evento)` de sus filas vivas, no contra "hoy"), con la misma tolerancia
     `TOLERANCIA_HORA_MS` → `hora_requerida` / `hora_invalida` / `hora_futura`.
   - `funcionariocnd`: obligatorio si el lote es `AUTH` (`funcionariocnd_requerido`); forzado a
     `NULL` en `PRUEBA`/`REDESP` (D-018).
   - **Lock REDESP solo sobre el delta** (decisión 3), con `periodoActual = floor(horaBogotaNow)+1`:
     rebota `periodo_bloqueado` si un periodo `< periodoActual` **cambia de valor**, **se agrega** o
     **se quita**. Un periodo pasado con el **mismo** valor pasa; hora/funcionario/descripción pasan
     siempre. Solo aplica a `REDESP`.
   - Resultado sin ningún periodo → **`400 { errores: [{ tipo, motivo: 'lote_sin_celdas' }] }`**
     (decisión 6). Vaciar ≠ borrar.

4. **Diff dentro de una sola transacción** (patrón de `mand.js:344-433`):
   - `UPDATE` de `campos_extra` (vía `JSON_MODIFY` o recomponiendo el JSON completo, lo que quede más
     legible) para las celdas cuyo `valor_mw` cambió, sellando `modificado_por = sesion.usuario_id`,
     `modificado_en = SYSUTCDATETIME()`.
   - `DELETE` de las filas cuyos periodos ya no vienen. **Acotado por `registro_id`** (PK) — el guard
     `guard_no_prod_historico_destruction.test.js` lo exige léxicamente junto al statement.
   - `INSERT` de los periodos nuevos: mismo `lote_id`, **`fecha_evento` heredada del lote**
     (decisión 9), `turno`/`turno_id` por `turnoFromPeriodo(periodo)` +
     `fechaOperativaDePeriodo(fechaDelLote, periodo)` + `resolverTurnoUnidadId` (D-055 (b)),
     snapshots frescos (`snapshotJDTs`/`snapshotJefes`/`snapshotIngenieros`, mismo guard
     `sin_jefe_planta` que el POST), `creado_por = sesion.usuario_id`.
   - **Metadata a nivel de LOTE, fuera del loop de periodos** (lección de D-055 (a)): un `UPDATE`
     sobre todas las celdas vivas del lote con `detalle`, `campos_extra.funcionariocnd` y
     `campos_extra.hora_llamada`, sellando `modificado_por`/`modificado_en` **solo si alguno de los
     tres cambió** (decisión 2).
   - **Recálculo por celda**: `recalcularEventoDashboard(transaction, { planta_id, fecha, periodo,
     tipo })` para **cada** celda que el diff tocó (valor cambiado, agregada o quitada). Si cambió la
     **hora**, recalcular **todas** las celdas del lote — la hora es el criterio de desempate de la
     publicación. `fecha` = día Bogotá del lote. Dedupe con un `Map` como hace el POST.
   - **Punto de enganche REQ-02**: comentario en el lugar exacto, dentro de la transacción, indicando
     que acá irá la cascada a las copias de `SALAJDT`/`SALAING` cuando REQ-02 exista. **Sin código.**

5. **Post-commit**: `broadcastConteoBitacoras(planta_id).catch(() => {})` y
   `notifyDashboard({ plantas: [planta_id], fecha }).catch(() => {})` solo si se tocó algo.

6. **Respuesta**: `200 { lote_id, resumen: { actualizados, creados, eliminados, celdas_recalculadas } }`.

7. **Prueba de humo** en `server/tests/sala_de_mando_batch.test.js` (al final, sección `D-057 · E1`):
   registrar un lote AUTH de 3 periodos con `postGuardar`, editarlo (cambiar un valor, agregar un
   periodo, quitar otro, cambiar la descripción) y verificar `200`, el conteo de filas del lote y que
   la celda quitada dejó de estar publicada. Sobre `TEST_PLANTA` y con `TEST_TAG`.

## Verificación (antes de commitear)

- `cd server && npm test` — baseline esperado: todo verde (ver la nota de borde de turno en
  "Datos descubiertos" de `ESTADO.md`). No degradar.
- Smoke manual del endpoint contra la BD: confirmar en SSMS que el lote editado conserva su
  `lote_id`, que las filas sobrevivientes conservan `registro_id`/`creado_por`/`creado_en`, y que
  `evento_dashboard` no quedó con `registro_origen_id` apuntando a una fila borrada.

## Actualizar ESTADO.md (obligatorio antes de cerrar)

- Marcá E1 ✅ con resumen de una línea.
- Bloque `### E1 — PUT /lotes/:lote_id ✅` con **Archivos tocados**, **Verificación** (salida real de
  la suite) y **Desviaciones** ("ninguna" si aplica).

## Commit

```bash
git add server/routes/mand.js server/tests/sala_de_mando_batch.test.js prompts/D-057-correccion-lote-mand/ESTADO.md
git commit -m "$(cat <<'EOF'
feat(MAND): PUT por lote — corrección con diff quirúrgico y recálculo por celda

<por qué: append-only sin corrección dejaba todo error de digitación publicado
al dashboard; el diff conserva lote_id/registro_id/autoría para no dejar huérfano
evento_dashboard.registro_origen_id, que no tiene FK posible>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

> No hagas `push`/`merge`/PR en etapas intermedias.
