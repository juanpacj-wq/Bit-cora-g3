# REQ-02 — Reflejo de Operación 24h y Disponibilidad en las bitácoras de Sala

| Campo | Valor |
|---|---|
| **Código** | REQ-02 |
| **Título** | Los eventos de Operación 24h y Disponibilidad se copian a las bitácoras de Sala de JdT e Ing. de Operación |
| **Estado** | 🟢 **Implementado para Operación 24h por D-058** (2026-07-27) — el reflejo de **Disponibilidad** queda pendiente y tiene **ADR propio** (ver el aviso de §3.4). El bloqueante de plantilla (§8.1) está **resuelto**. |
| **Origen** | `pendientes_Ernesto.md`: *"Sala de mando operativa debería mostrar los valores registrados en la bitácora operación 24hr y disponibilidad, para las bitácoras de jdt e ing de operación. (para jdt e ing de op, si cualquiera de los 2 crea, se envía a ambas)"* |
| **Depende de** | [REQ-03](./REQ-03-operacion-24h-registros-unicos.md) — define qué es un "evento" en el nuevo modelo de Operación 24h y cuándo se edita/borra. |
| **Relacionado** | [REQ-04](./REQ-04-historico-en-apartado.md) (la corrección que cascadea), [REQ-05](./REQ-05-asiento-cambio-despacho.md) (el asiento automático también se refleja). |

---

## 1. Contexto y problema

El Ingeniero Jefe de Turno y el Ingeniero de Operación registran su actividad del turno en sus
bitácoras de Sala de Mando. Pero los dos eventos operativos más relevantes de su turno — lo que se
autorizó, probó o redespachó (Operación 24h) y los cambios de estado de la unidad (Disponibilidad) —
**se capturan en otras dos pestañas y no dejan rastro en su bitácora**.

El resultado es que la bitácora del turno queda incompleta: al leerla no se reconstruye lo que
realmente pasó. Quien revisa un turno tiene que abrir tres pestañas y cruzarlas mentalmente.

Se busca que **el evento se registre una sola vez, donde corresponde, y aparezca automáticamente
asentado en la bitácora de Sala de los dos ingenieros** — sin doble digitación y sin que puedan
desincronizarse.

### 1.1 Relación con D-053 (importante)

Hace pocos días la bitácora `SALA` se partió en tres por rol — `SALAJDT`, `SALAING` y `SALAOP` —
precisamente para **separar** responsabilidades que estaban mezcladas (D-053).

Este requerimiento **no revierte esa decisión**. La separación sigue rigiendo **lo que cada rol
escribe directamente**: el JdT escribe en `SALAJDT`, el Ing. de Operación en `SALAING`, y ninguno en
la del otro. Lo que se comparte es únicamente **el reflejo de eventos que ocurrieron en otra
bitácora** (Operación 24h y Disponibilidad), donde ambos cargos son co-responsables y el evento es
del turno, no de la persona.

## 2. Comportamiento actual

| Aspecto | Situación hoy |
|---|---|
| `SALAJDT` / `SALAING` | Bitácoras genéricas, renderizadas con `GrillaRegistros` (`src/BitacorasGecelca3.jsx:1302`). Solo contienen lo que el ingeniero teclea a mano. |
| Operación 24h (MAND) | UI propia (`SalaDeMandoGrid.jsx`). Sus registros viven solo en MAND. |
| Disponibilidad (DISP) | UI propia + tabla dedicada `bitacora.disponibilidad_estado` (D-026). Sus eventos viven solo en DISP. |
| Vínculo entre ellas | **Ninguno.** No hay copia, ni referencia, ni vista cruzada. |

## 3. Comportamiento requerido

### 3.1 Qué se refleja y dónde

- **RQ-02.1** — Cada evento registrado en **Operación 24h** (Autorización, Prueba o Redespacho) y
  cada evento de **Disponibilidad** genera un **registro real** en las bitácoras de Sala.
- **RQ-02.2** — El registro se crea en **`SALAJDT` y `SALAING`, en las dos**, sin importar cuál de
  los dos cargos originó el evento. *(Esto es literalmente la nota original: "si cualquiera de los 2
  crea, se envía a ambas".)*
- **RQ-02.3** — **`SALAOP` (Sala de Mando - Operador) queda fuera.** No recibe copia.
- **RQ-02.4** — El registro reflejado es un registro **real** de la bitácora, no un adorno visual:
  cuenta en el contador de la pestaña, aparece en la grilla, entra al cierre de turno de esa
  bitácora y viaja al histórico como cualquier otro.

### 3.2 El asiento es de solo lectura en su destino

- **RQ-02.5** — En `SALAJDT` y `SALAING` el registro reflejado **no se puede editar ni borrar**. No
  muestra los controles de edición; en su lugar se identifica visiblemente como asiento reflejado,
  con indicación de su origen.
- **RQ-02.6** — **La única fuente de verdad es el origen** (Operación 24h / Disponibilidad). Las dos
  copias son derivadas y jamás divergen.

### 3.3 Cascada

- **RQ-02.7** — **Editar** el evento en su origen actualiza **las dos copias**.
- **RQ-02.8** — **Borrar** el evento en su origen borra **las dos copias**.
- **RQ-02.9** — La cascada es **atómica** con la operación de origen: o se aplica en los tres lados o
  no se aplica en ninguno. Nunca queda una copia huérfana ni un origen sin copias.

### 3.4 Disponibilidad: qué acciones propagan

> ⚠️ **PENDIENTE — fuera de D-058, con ADR propio.** D-058 cableó el reflejo **solo desde Operación
> 24h**. Los 4 tipos espejo de `Cambio de Disponibilidad` **ya están sembrados** en `SALAJDT` y
> `SALAING` (con `seleccionable = 0`), y el módulo `server/utils/reflejo-sala.js` es el único lugar
> donde vive la mecánica — así que lo que falta es acotado y está localizado:
>
> 1. Enganchar `crearReflejoLote`/`actualizarReflejoLote` en `POST`/`PUT` de disponibilidad
>    (`routes/registros.js` rama DISP y `routes/disponibilidad.js`), dentro de sus transacciones.
> 2. Implementar **RQ-02.12** — `POST /api/disponibilidad/deshacer` **marca la copia como anulada,
>    no la borra**. Eso es lo que de verdad justifica un ADR aparte: agrega un **estado visual nuevo**
>    a la grilla de Sala (hoy solo existen "editable" y "reflejado de solo lectura") y una constancia
>    de quién deshizo.
> 3. Decidir el borde de medianoche del estado que cruza el día (ver [REQ-06](./REQ-06-excel-eventos-operacion.md) §8.3, hoy resuelta **solo** para el libro).
>
> Mientras tanto, RQ-02.10, RQ-02.11 y RQ-02.12 **no están implementadas**.

- **RQ-02.10** — **Crear** un estado nuevo (la unidad cambia de estado) genera el asiento.
- **RQ-02.11** — **Editar** el estado vigente (p. ej. corregir la hora de inicio) actualiza el asiento.
- **RQ-02.12** — **Deshacer** un evento de disponibilidad (`POST /api/disponibilidad/deshacer`)
  **marca la copia como anulada — no la borra.** El asiento sigue visible, señalado como anulado y
  con constancia de quién lo deshizo.
  > *Razón:* el evento sí ocurrió en el turno y quedó publicado; borrarlo dejaría un hueco en la
  > narrativa del turno. La disponibilidad se corrige, pero el turno se cuenta completo.

### 3.5 Retroactividad

- **RQ-02.13** — **No hay reconstrucción histórica.** Solo se refleja lo que ocurra **a partir del
  despliegue**. Los eventos de Operación 24h y Disponibilidad anteriores no se copian.

## 4. Reglas de negocio y casos borde

- **RN-02.a** — El asiento reflejado **no** dispara notificación al dashboard de generación: el
  contrato cross-repo se alimenta del origen, no de las copias.
- **RN-02.b** — El asiento reflejado **no** cuenta como "el ingeniero registró algo" para efectos de
  presencia o conformación de turno. La presencia se sigue derivando de `turno_participante` (D-045).
- **RN-02.c** — El autor del asiento reflejado es **el mismo autor del evento de origen**, para que
  el histórico sea coherente. En el caso del asiento automático por correo (REQ-05) el autor es el
  usuario `SISTEMA`.
- **RN-02.d** — Si el turno de la unidad está cerrado o el ingeniero finalizó su turno, **el reflejo
  se crea igual**: Operación 24h y Disponibilidad están exentas de esos bloqueos (D-040, D-045), y
  su reflejo hereda esa exención. El bloqueo aplica a lo que el ingeniero **teclea** en Sala, no a
  lo que el sistema asienta.
- **RN-02.e** — El reflejo **no** aplica a la planta de test `TST` (D-030).
- **RN-02.f** — Si un evento se registra y se borra dentro del mismo turno, sus copias desaparecen
  con él (RQ-02.8). El caso "anulado visible" es exclusivo de Disponibilidad (RQ-02.12).

## 5. Impacto técnico

### 5.1 Decisiones de diseño que el implementador debe cerrar

Estas no son preguntas de negocio (ya están resueltas arriba) sino de modelado; el documento las
señala para que no se resuelvan por omisión:

1. **`tipo_evento` del asiento.** Cada bitácora tiene su propio catálogo `lov_bit.tipo_evento`.
   Hay que decidir qué tipos se siembran en `SALAJDT`/`SALAING` para los asientos reflejados
   (p. ej. Autorización / Prueba / Redespacho / Disponibilidad) y sembrarlos en el seed de
   `server/db.js`, no a mano en la BD.
   > ⚠️ Gotcha de D-053: mover o crear registros con `bitacora_id` **exige** que el
   > `tipo_evento_id` sea coherente con esa bitácora. No hay FK ni CHECK que lo garantice y el
   > drift es invisible hasta que alguien edita el registro. Existe el guard
   > `server/tests/guard_tipo_evento_coherente.test.js` — debe seguir pasando.

2. **Vínculo origen ↔ copia.** Hace falta poder ir del evento de origen a sus dos copias para
   cascadear. Igual que `evento_dashboard.registro_origen_id`, **no puede haber FK**: el origen vive
   en `registro_activo` y migra a `registro_historico` (dos padres posibles, ver D-055 hallazgo 4).
   La integridad se sostiene en código + test.

3. **Bloqueo de edición en destino.** El gate por fila de `GrillaRegistros` ya existe: el `GET
   /activos` expone el flag advisory `puede_editar` y la grilla pinta lápiz/basurero solo desde él
   (D-049). Basta con que el asiento reflejado venga con `puede_editar = false`. **El backend debe
   rechazar igual** (`PUT`/`DELETE /api/registros/:id`), no confiar en el front.

### 5.2 Archivos a tocar

| Archivo | Cambio |
|---|---|
| `server/db.js` | Seed de `tipo_evento` para los asientos reflejados en SALAJDT/SALAING. |
| `server/utils/` | Módulo nuevo con la lógica de reflejo (crear / actualizar / borrar / anular las dos copias), invocable desde MAND y DISP. **Debe existir una sola vez**, no duplicado por endpoint. |
| `server/routes/mand.js` | Invocar el reflejo dentro de la transacción de guardado / corrección. |
| `server/routes/registros.js` (rama DISP) y `server/routes/disponibilidad.js` | Invocar el reflejo en crear / editar / deshacer. |
| `server/middleware/permissions.js` | `canEditarRegistro` debe rechazar los asientos reflejados. **Sin reintroducir bypass por cargo** (D-049). |
| `src/BitacorasGecelca3.jsx` (`GrillaRegistros` / `RegistroRow`) | Presentación diferenciada del asiento reflejado y de su estado anulado. |

### 5.3 Riesgos

- **Volumen.** Cada evento pasa a generar tres filas. Un día de operación intensa multiplica por tres
  el crecimiento de `registro_activo`. Es aceptable, pero conviene medirlo antes de asumirlo.
- **Cierre de turno.** Los asientos reflejados entran al cierre de turno de las bitácoras de Sala
  (RQ-02.4) y por tanto migran a `registro_historico`. Verificar que el cierre masivo por
  `turno_id` (D-045) los archive correctamente y que la cascada de borrado **no** intente tocar algo
  ya archivado.
- **Conflicto de cascada.** Si el evento de origen se corrige después de que sus copias ya se
  archivaron por cierre de turno, la cascada chocaría con la inmutabilidad del histórico. Ver §8.2.

## 6. Criterios de aceptación

1. **Dado** que el JdT registra una autorización en Operación 24h, **cuando** abro `SALAJDT`,
   **entonces** veo el asiento; **y cuando** abro `SALAING`, **entonces** también lo veo.
2. **Dado** que el Ing. de Operación registra un redespacho, **entonces** ocurre lo mismo en las dos
   bitácoras (el reflejo no depende de quién lo creó).
3. **Dado** cualquiera de esos asientos, **cuando** intento editarlo o borrarlo desde la bitácora de
   Sala, **entonces** la interfaz no ofrece la acción **y** el endpoint responde con error.
4. **Dado** que abro `SALAOP`, **entonces** no aparece ningún asiento reflejado.
5. **Dado** un evento reflejado, **cuando** lo corrijo desde el histórico de Operación 24h,
   **entonces** las dos copias quedan actualizadas con el mismo contenido.
6. **Dado** un evento reflejado, **cuando** lo borro desde el histórico de Operación 24h,
   **entonces** las dos copias desaparecen.
7. **Dado** un cambio de estado de disponibilidad, **cuando** lo deshago, **entonces** las dos copias
   **siguen visibles marcadas como anuladas**, no desaparecen.
8. **Dado** que la operación de origen falla a mitad de camino, **entonces** no queda ninguna copia
   creada (atomicidad).
9. **Dado** un evento registrado **antes** del despliegue, **entonces** no aparece reflejado
   (sin retroactividad).
10. **Dado** el guard `guard_tipo_evento_coherente.test.js`, **cuando** corro la suite,
    **entonces** pasa.

## 7. Fuera de alcance

- Reflejar hacia `SALAOP` o hacia cualquier otra bitácora.
- Reconstruir asientos de eventos anteriores al despliegue.
- Permitir editar el asiento desde la bitácora de Sala (en ningún grado, ni siquiera el texto).
- Cambiar quién puede escribir directamente en `SALAJDT` / `SALAING` (sigue rigiendo D-053).
- Reflejar los consumos de Combustibles (COMB no es una bitácora, es un reporte numérico).

## 8. Preguntas abiertas

### 8.1 ✅ RESUELTA por D-058 — plantilla del asiento

Existía un **formato preestablecido** con el que estos eventos se venían escribiendo a mano en la
bitácora de Sala. El asiento reflejado debe usar exactamente ese texto.

> **Respuesta: el texto lo genera un motor server-side único** (`server/utils/asientos/`), con las
> plantillas y convenciones especificadas en
> [`FORMATO-ASIENTOS-OPERACION.md`](./FORMATO-ASIENTOS-OPERACION.md) §4 y §5, derivadas del análisis
> de 342 eventos reales del formato controlado GENE-F03. El mismo motor alimenta el listado del día
> (REQ-04) y el libro mensual (REQ-06): **el texto se redacta una sola vez y no puede divergir**.
> Lo que se escribe a mano en las bitácoras de Sala pasa **literal**, sin normalizar. Ver **D-058**.

### 8.2 ✅ RESUELTA por D-058 — corrección después del cierre de turno

Si el evento de origen se corrige cuando sus copias ya fueron archivadas por el cierre de turno de
las bitácoras de Sala, ¿qué debe pasar?

> **Respuesta: la cascada alcanza SOLO las copias vivas** (`registro_activo`). Si ya se archivaron,
> el histórico **no se toca** (RF-032 intacto) y la corrección del origen **procede igual**: la copia
> archivada queda con el valor que tenía al cerrarse, que es lo que el libro inmutable debe decir.
>
> **Por qué no se rechaza el origen:** un `409` volvería un lote **incorregible a las 18:01** por el
> estado de su *reflejo* — el derivado pasaría a gobernar a la fuente. Y contradice el criterio 12 de
> [REQ-04](./REQ-04-historico-en-apartado.md), ya implementado en D-057: MAND está **exenta** de los
> gates de turno, así que un rechazo "por turno cerrado" reintroduciría por la puerta de atrás justo
> lo que se excluyó por diseño. En consecuencia, **`rowsAffected = 0` en la cascada no es un error**
> — es el caso esperado — y está comentado en el código para que nadie lo "arregle" con un `throw`.
>
> Tampoco se agrega un renglón de corrección: la bitácora de Sala muestra el **estado actual** del
> evento (decisión H del documento de formato) y el rastro vive en `modificado_por`/`modificado_en`.

### 8.3 Menores

- ¿El asiento reflejado debe distinguirse visualmente por icono, color, o basta un rótulo de origen?
  > **Resuelto en D-058: un chip con el nombre de la bitácora de origen**, en el lugar donde una fila
  > propia muestra lápiz y basurero, más el ojo de lectura. El rótulo **no se hardcodea en el front**:
  > el `GET /activos` lo resuelve del catálogo (`origen_bitacora_nombre`), porque el nombre visible de
  > una bitácora vive solo en el seed (D-052). Del `campos_extra` el front lee el **dato**, nunca la
  > etiqueta.
- ¿Los asientos reflejados deben poder filtrarse/ocultarse en la grilla de Sala?
  > **Sin implementar y sin decidir.** Hoy se listan mezclados con lo tecleado a mano. Con la adopción
  > actual (pocos eventos por turno) no hace falta; revisarlo si el volumen lo pide.
