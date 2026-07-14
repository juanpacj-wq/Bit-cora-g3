# D-053 — Preguntas y respuestas (congeladas)

> Sesión de planeación 2026-07-14. Estas respuestas son **autoritativas** para toda la
> implementación. Una vez cerradas no se reabren: si algo cambia durante la ejecución, es una
> **desviación** y se documenta en `ESTADO.md` + el commit de la etapa, no acá.

## Ronda 1

| # | Pregunta | Respuesta |
|---|---|---|
| 1 | **¿Qué hacemos con la bitácora `SALA` (bitacora_id=14)?** (a) Renombrar `codigo` SALA→SALAJDT conservando id=14 y orden=3, y crear solo SALAING + SALAOP — es literalmente "crear 2 bitácoras nuevas"; cero filas movidas del histórico. (b) Retirar SALA (`activa=0`) y crear las 3 nuevas — más limpio semánticamente, pero exige migrar los históricos y remapear su `tipo_evento_id`. **Recomendación: (a).** | **(a)** Renombrar SALA → SALAJDT + crear 2 nuevas. |
| 2 | **El registro 4240 lo creó un `Administrador y Debugging`**, cargo que no mapea a ninguna de las 3 bitácoras. ¿Dónde queda? (a) SALAJDT (mayor precedencia, opera como JdT; con la opción 1a queda ahí sin tocar nada). (b) SALAOP. (c) Sin migrar en SALA legacy. **Recomendación: (a).** | **(a)** Queda en SALAJDT. **Aclaración crítica del usuario:** *"los registros que estás viendo son sobre la db en dev, no en prod"* → el diseño de la migración NO puede calibrarse sobre estos 2 registros. Ver P4. |
| 3 | **¿Cómo aparecen las tres en el sidebar?** (a) Tres pestañas sueltas — cero cambios de frontend, cada una conserva badge numérico y reorden por carga. (b) Categoría agrupadora "Sala de Mando" con flyout — ahorra 2 pestañas pero colapsa los 3 badges en un dot agregado. **Recomendación: (a).** | **(a)** Tres pestañas sueltas. |
| 4 | **(Derivada de la aclaración en P2) ¿Cómo se ejecuta la migración en prod tras verificar dev?** | Patrón canónico del repo: one-shot `F30.A1` gateado por `bitacora.migracion_aplicada`, que corre solo al reiniciar el backend post-deploy. **Antes** del deploy se corre contra prod un **reporte pre-flight de solo lectura** (`sql/snippets/reporte-split-sala-D053.sql`) que expone el desglose real y, sobre todo, el conteo de registros **no atribuibles**. |

## Detalles operativos confirmados

- **Alcance del split**: solo la bitácora SALA. DISP, MAND (Op24h) y COMB **no se tocan**. No se crean
  cargos nuevos ni App Roles en Entra (`entra-roles.js` intacto). No cambia D-049 (editar/eliminar =
  solo el autor).

- **Matriz objetivo** (`V+C` = ve y crea, `V` = solo ve, `—` = sin acceso). Solo se muestran las
  columnas que cambian; el resto del catálogo queda idéntico:

  | Cargo | SALAJDT | SALAING | SALAOP |
  |---|---|---|---|
  | Administrador y Debugging | V+C | V+C | V+C |
  | Ingeniero Jefe de Turno | **V+C** | V | V |
  | Ingeniero de Operación | V | **V+C** | V |
  | Ingeniero Químico | V | V | V |
  | Gerente de Producción | V | V | V |
  | Op. de Planta - Sala de Mando | — | — | **V+C** |
  | Resto de operadores + Coordinador CyM | — | — | — |

- **Consecuencia estructural aceptada**: JdT e IngOp **dejan de tener filas idénticas** en la matriz.
  El comentario de `db.js:904-905` ("filas idénticas / mismo poder operativo") y
  `docs/domain-glossary.md` afirman lo contrario hoy → hay que corregirlos (E4).

- **El cargo NO está almacenado en el registro.** `creado_por` es un `usuario_id`; el cargo se resuelve
  desde el App Role de Entra en cada login y no se persiste (`auth/app.js:212` es un `console.log`).
  `lov_bit.usuario` no tiene `cargo_id`; no existe tabla puente ni auditoría de roles en BD.

- **Fuentes durables de atribución** (verificadas):
  | Fuente | Calidad | Cobertura |
  |---|---|---|
  | `turno_participante` / `conformacion_turno` por `turno_id` | Evidencia exacta | Registros con `turno_id` (estampado desde D-045) |
  | `sesion_activa (usuario_id, cargo_id)` | Inequívoca **solo si** el autor tiene un único `cargo_id` | Todos, pero ambigua con multi-cargo |
  - Descartadas: los snapshots JSON del registro (`jdts_snapshot`/`ingenieros_snapshot`) describen
    **a los demás presentes**, no al autor, y su shape es `[{usuario_id, nombre_completo}]` — sin cargo.

- **Política de atribución**: **move-out por atribución positiva**. Tras el rename todos los registros
  quedan en id=14 = SALAJDT; la migración solo mueve lo que puede atribuir a IngOp o a Op de Sala. Lo
  no atribuible **no se toca** (identidad) y se reporta. Nunca se adivina, y no hay `THROW` por datos
  ambiguos → cero riesgo de tumbar el arranque de prod.

- **Regla dura de la migración**: todo `UPDATE` de `bitacora_id` **debe remapear `tipo_evento_id` en el
  mismo statement**. No hay FK ni CHECK que ate `registro.bitacora_id` ↔ `tipo_evento.bitacora_id`, y
  ninguna lectura lo verifica → el drift es invisible hasta que alguien edita el registro.

- **Excepción a RF-032** (histórico append-only): se acepta el `UPDATE` sobre `registro_historico`
  como excepción deliberada, one-shot y transaccional, con `bitacora.registro_historico_backup_D053`
  como rastro de auditoría. RF-032 es organizativa, no impuesta por trigger
  (`BIT-RF-2026-001.md:352`), y `reabrirTurno` ya la viola legítimamente.

- **Datos de dev al momento de planear** (NO son la base del diseño; prod es la fuente real):
  `bitacora_id=14` → 0 en `registro_activo`, 2 en `registro_historico`, un solo autor
  (`usuario_id=98`, con 5 cargos distintos en `sesion_activa`). Ambos resueltos por `turno_id`:
  4128 (turno 393) → Ingeniero Jefe de Turno; 4240 (turno 501) → Administrador y Debugging.
