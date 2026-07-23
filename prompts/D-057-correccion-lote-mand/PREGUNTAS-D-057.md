# D-057 — Preguntas y respuestas (congeladas)

> Sesión de planeación 2026-07-23. Estas respuestas son **autoritativas** para toda la
> implementación. Una vez cerradas no se reabren: si algo cambia durante la ejecución, es una
> **desviación** y se documenta en `ESTADO.md` + el commit de la etapa, no acá.
>
> **Alcance del flujo (fijado por el usuario al abrirlo):** solo la parte de **CORRECCIÓN** de
> `docs/requerimientos/REQ-04-historico-en-apartado.md` — edición y borrado **por lote**. El listado
> solo-lectura ya lo entregó D-056 y NO se rehace. **Fuera:** el formato de mensaje de WhatsApp
> (REQ-04 §8.1, bloqueado → futuro D-058) y la cascada a SALAJDT/SALAING (REQ-02 no existe todavía;
> se deja el punto de enganche anotado, sin implementar). Las respuestas de negocio ya congeladas en
> REQ-04 (§3.3 granularidad por lote, §3.4 quién corrige, RN-04.b/c/d/f) **no se repreguntan**.

## Ronda 1

| # | Pregunta | Respuesta |
|---|---|---|
| 1 | **Mecánica del `PUT` por lote.** El lote no tiene tabla propia: son N filas de `registro_activo` que comparten `campos_extra.lote_id`. (a) **Diff quirúrgico** conservando `lote_id`/`registro_id`/autoría. (b) Borrar las N filas y reinsertar el lote completo. | **(a) Diff quirúrgico.** El diff reusa el mismo `lote_id`; `UPDATE` en sitio de las celdas que cambian, `DELETE` de las que se quitan, `INSERT` de las que se agregan — **nunca DELETE+INSERT del lote entero** (dejaría huérfano `evento_dashboard.registro_origen_id`, que no tiene FK — D-055 (c) — y perdería `creado_por`/`creado_en`). Cada celda que el diff toque (UPDATE de valor, DELETE, INSERT) dispara `recalcularEventoDashboard` de su `(planta, fecha, periodo, tipo)`: **este es el caller que D-056/E2 dejó diferido**. Todo en una transacción. |
| 2 | **Auditoría (REQ-04 §8.2).** D-019: en MAND `modificado_por` solo se actualiza si cambió `valor_mw`. ¿Sigue rigiendo en la corrección por lote? | **Cualquier cambio marca.** D-019 sigue vigente **solo en la captura append-only** de la grilla; en la corrección deliberada no aplica, porque **la hora decide qué lote se publica** al dashboard y ese cambio debe quedar atribuido. Marca `modificado_por`/`modificado_en` **solo en las celdas afectadas por el diff**, no en todo el lote. |
| 3 | **Lock de REDESP al editar (RQ-04.17).** Lote de Redespacho de las 08:00 sobre P9–P12, corregido a las 14:00: ¿sobre qué actúa el lock? | **Solo sobre el delta.** Aplica **solo a REDESP** (AUTH y PRUEBA no tienen lock, D-016). Rebota si **cambia el valor** de un periodo pasado, si se **agrega** uno pasado o si se **quita** uno pasado (quitar retira el publicado = cambio de valor). Deja pasar hora, funcionario, descripción y los periodos pasados **idénticos** — "el lock protege el valor, nunca el comentario". |
| 4 | **Dónde se edita el lote en la UI:** (a) modal sobre el listado, (b) fila expandible inline, (c) cargar el lote en la grilla. | **(a) Modal sobre el listado.** Descartar (c) explícitamente: rompe el invariante de D-056 "la grilla solo registra, nunca edita" (se vacía al guardar, INSERT-only). El modal **mantiene separada la captura** (grilla append-only) **de la corrección** (histórico del día). |

## Ronda 2

| # | Pregunta | Respuesta |
|---|---|---|
| 5 | **Excepción a D-049: ¿se toca `permissions.js`?** REQ-04 §5.3 lo pide, pero MAND nunca pasa por `canEditarRegistro`. | **No tocar `permissions.js`.** La letra de §5.3 **está imprecisa y hay que corregirla en el ADR D-057**: la excepción no vive en `canEditarRegistro` (MAND nunca pasa por ese helper, D-049 lo excluye) — vive en que **el gate del `PUT`/`DELETE` en `mand.js` es `puede_crear`** (colaborativo por diseño, data-driven), **no `creado_por`**. El test de regresión debe probar **las dos caras**: un no-autor **sí** corrige en MAND, pero **no** en una bitácora genérica (ahí sigue rigiendo "solo el autor"). |
| 6 | **RN-04.b — lote vaciado en el modal al guardar.** | **Rechazar con `400 lote_sin_celdas`.** Heredero de `detalle_sin_celdas`/`lote_sin_celdas` (D-055/D-056), coherente con "nunca un 200 mentiroso". **Vaciar ≠ borrar**: son caminos distintos — el `PUT` rechaza y el front **deshabilita Guardar señalando Eliminar**; borrar es el `DELETE` explícito y confirmado. |
| 7 | **Dos personas corrigiendo el mismo lote a la vez.** | **Última escritura gana**, con una condición para que sea seguro con el modelo de diff: el `PUT` **re-lee las celdas actuales del lote DENTRO de la transacción** y diffea contra el **estado real de la BD**, no contra el snapshot que vio el modal — así una edición concurrente no revive una celda borrada. Si el lote ya no existe, `404 lote_inexistente`. Sin control optimista con 409. |
| 8 | **Partición en etapas** (una por commit). | **5 etapas** (E1 PUT · E2 DELETE · E3 tests · E4 front · E5 docs+cleanup), **con la salvedad** de que E1 y E2 **no aterricen sin al menos su prueba de humo happy-path** — ninguna etapa deja la suite sin cubrir (principio D-029 "cada etapa verde"). La matriz completa (14 criterios) + los guards transversales (regresión D-049, coherencia de lote) se consolidan en E3 porque **cruzan PUT y DELETE por igual**. |

## Ronda 3

| # | Pregunta | Respuesta |
|---|---|---|
| 9 | **`fecha_evento` de una fila insertada por el diff** (el día del registro se acota por `CAST(DATEADD(HOUR,-5, fecha_evento) AS DATE)`). | **Hereda la del lote.** Todas las celdas de un lote comparten `fecha_evento` → así el lote **no se parte entre dos días Bogotá** (cierre diario y listado coherentes). La fila insertada puede quedar con un `fecha_evento` **anterior** al instante real del `INSERT` y **es correcto**: `fecha_evento` identifica el **DÍA del lote**, no el timestamp de escritura (esa atribución vive en `modificado_por`/`modificado_en`). El `turno_id` de la celda nueva se resuelve igual que el resto, por `fechaOperativaDePeriodo` del **periodo** (D-055 (b)), **nunca** por el instante de la corrección. |
| 10 | **Corregir un lote recién archivado por el sweeper** (medianoche → `registro_historico`). | **`409 lote_cerrado`** si el `lote_id` aparece en `registro_historico`; `404 lote_inexistente` si no está en ningún lado. Coherente con la familia de 409 (`turno_cerrado`/`turno_en_transicion`, D-046) y con RF-032: una vez en histórico es inmutable, y la corrección se corta en el borde del día (RQ-04.4). Ante el `409 lote_cerrado` el **front refresca el listado** para que la fila archivada desaparezca de la pantalla que quedó abierta. |
| 11 | **¿Se puede cambiar el TIPO del lote (AUTH↔PRUEBA↔REDESP)?** RQ-04.10 no lo enumera. | **El tipo es INMUTABLE.** RQ-04.10 lo omite a propósito. Si se equivocaron de tipo, el camino es **Eliminar** el lote (`DELETE` con retroceso del publicado) y **volver a registrarlo** en la grilla con el tipo correcto — el modelo append-only ya lo soporta, sin una rama "mover tipo" que tocaría **dos claves** del dashboard y el guard de coherencia `tipo_evento`↔`bitacora` (D-053, `guard_tipo_evento_coherente.test.js`). |

## Detalles operativos confirmados

- **Identidad del lote:** `campos_extra.lote_id` (GUID del servidor, D-056). No hay tabla de lotes ni
  DDL nuevo en este flujo: `PUT`/`DELETE` operan sobre las N filas de `registro_activo` que lo comparten.
- **Gate de escritura:** `puede_crear` en MAND vía `hasPermisoBitacora` (matriz data-driven) +
  `plantaMatch`. Sin allowlist de plantas (D-055) y **sin** chequeo de `creado_por` — esa es la
  excepción a D-049, y es **acotada a MAND por construcción**.
- **Exención de turno intacta:** MAND no pasa por `bloquearSiTurnoFinalizado` ni por los 409
  `turno_cerrado`/`turno_en_transicion` (D-040/D-045/D-046). Corregir funciona con el turno
  finalizado o cerrado (RQ-04.18 / criterio 12).
- **Publicación:** `recalcularEventoDashboard(t, {planta_id, fecha, periodo, tipo})` **por celda**,
  desde cero, dentro de la misma transacción, para **toda** celda que el diff toque — incluidas las
  que se **quitan** (ahí es donde el publicado retrocede al lote anterior, criterio 10).
- **Metadata replicada por celda:** hora, funcionario y descripción viven duplicados en cada fila del
  lote y ningún constraint los mantiene coherentes. El `UPDATE` de metadata va **a nivel de lote**
  (todas sus celdas vivas en un solo statement), nunca dentro del loop de periodos.
- **Reglas heredadas del POST que se revalidan en el PUT:** `hora` `HH:mm` Bogotá compuesta
  server-side contra la fecha del lote, con tolerancia de 5 min hacia el futuro
  (`hora_requerida`/`hora_invalida`/`hora_futura`); `funcionariocnd` obligatorio en AUTH y forzado a
  `NULL` en PRUEBA/REDESP (D-018); periodos 1..24; `valor_mw` finito.
- **Notificación cross-repo:** `notifyDashboard({plantas, fecha})` fire-and-forget **post-commit**, y
  `broadcastConteoBitacoras(planta_id)` — igual que el POST. Nunca dentro de la transacción.
- **Punto de enganche REQ-02 (NO se implementa):** la cascada a SALAJDT/SALAING (RQ-04.14) se deja
  **anotada con un comentario** en el lugar exacto de `mand.js` donde tendría que ocurrir, dentro de
  la misma transacción. No se crea código muerto ni feature flag.
- **Tests:** todos los de MAND van en `server/tests/sala_de_mando_batch.test.js` (D-055), sobre
  `TEST_PLANTA` (`'TST'`) y tagueados con `TEST_TAG`. La contra-cara de la regresión D-049 (un
  no-autor **no** edita en una bitácora genérica) ya vive en `tests/registros_solo_autor.test.js` y
  solo se verifica que siga verde.
