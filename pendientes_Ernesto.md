## 1. Resumen De pendientes

- [X] crear bitácoras nuevas para cada cargo. jdt, ing op y operadores sala de mando
- [X] bitácora análisis se debería llamar analista
- [ ] Boton descargar archivo en apartado de combustible → [REQ-01](./docs/requerimientos/REQ-01-descarga-combustibles.md)
- [X] facilitar el cambio de unidad para jdt y analista quimico
- [X] Sala de mando operativa debería mostrar los valores registrados en la bitácora operación 24hr y disponibilidad, para las bitácoras de jdt e ing de operación. (para jdt e ing de op, si cualquiera de los 2 crea, se envía a ambas) → [REQ-02](./docs/requerimientos/REQ-02-reflejo-bitacoras-sala.md) — **✅ Completo**: Operación 24h (D-058, 2026-07-27) + Disponibilidad (D-063, 2026-08-29, con copia anulada al deshacer)
- [X] Operación 24 hr debería tener registros únicos (dinámica registrar->Guardar->registros se envían, pero funcionario y detalle son generales para los periodos, no debería ser así) pensar cómo hacerlo bien → [REQ-03](./docs/requerimientos/REQ-03-operacion-24h-registros-unicos.md)
- [X] histórico en el mismo apartado para ver los registros de autorización, pruebas y redespachos, con formato enviado a whatsapp. → [REQ-04](./docs/requerimientos/REQ-04-historico-en-apartado.md) — D-056 + D-057 + **D-058** (el formato y los botones de copiar)
- [X] cuando cambia despacho (redesp<>desp por correo o registro) crear histórico en op24hr con el formato en la imagen → [REQ-05](./docs/requerimientos/REQ-05-asiento-cambio-despacho.md) — **reformulado 2026-08-31**: el redespacho tecleado ya funcionaba (D-058 + D-063) y el correo del CND quedó fuera. Lo que faltaba —asentar la llegada del **despacho del día siguiente** de XM— salió en **D-064** (2026-08-31): el renglón lo escribe el sistema en las bitácoras de Sala de las dos unidades y sale una sola vez en el libro GENE-F03. **Pendiente de desplegar** (dashboard primero).
- [X] crear archivo Excel con valores registrados en redespachos, autorizaciones y eventos de disponibilidad. → [REQ-06](./docs/requerimientos/REQ-06-excel-eventos-operacion.md) — **D-058**: libro mensual GENE-F03, una hoja por día, las dos unidades

## 2. Requerimientos formalizados

Los cinco pendientes abiertos están especificados en `docs/requerimientos/` (2026-07-21), uno por
viñeta, con alcance, reglas de negocio, impacto técnico y criterios de aceptación.

| Doc | Estado | Depende de |
|---|---|---|
| [REQ-01](./docs/requerimientos/REQ-01-descarga-combustibles.md) — Descarga de Combustibles | 🟡 Bloqueado (layout del **segundo** formato) | — |
| [REQ-02](./docs/requerimientos/REQ-02-reflejo-bitacoras-sala.md) — Reflejo a bitácoras de Sala | ✅ **Completo** — Operación 24h (D-058, 2026-07-27) y Disponibilidad (D-063, 2026-08-29): deshacer **anula** la copia en vez de borrarla | REQ-03 ✅ |
| [REQ-03](./docs/requerimientos/REQ-03-operacion-24h-registros-unicos.md) — Operación 24h append-only | ✅ Implementado (D-056, 2026-07-22) | — |
| [REQ-04](./docs/requerimientos/REQ-04-historico-en-apartado.md) — Histórico en el apartado | ✅ **Completo** — listado (D-056), corrección por lote (D-057), formato del mensaje y copiar (D-058) | REQ-03 ✅ |
| [REQ-05](./docs/requerimientos/REQ-05-asiento-cambio-despacho.md) — Asiento del despacho del día siguiente | ✅ **Implementado** (D-064, 2026-08-31) — asiento automático con autor `SISTEMA` en las dos Salas × las dos unidades, un solo renglón en el F03, y un CLI de puesta al día del mes. **Falta desplegar** | REQ-02 ✅, REQ-04 ✅, REQ-06 ✅ |
| [REQ-06](./docs/requerimientos/REQ-06-excel-eventos-operacion.md) — Excel de eventos de operación | ✅ **Implementado** (D-058, 2026-07-27) — libro mensual GENE-F03 | REQ-03 ✅ |

### Bloqueantes transversales

De las tres piezas de contenido que faltaban, **dos ya se resolvieron**:

1. ~~**Plantilla del mensaje de WhatsApp** — REQ-04 §8.1 (y reutilizable en REQ-02).~~
   ✅ **Resuelta 2026-07-26/27**: especificada en
   [`FORMATO-ASIENTOS-OPERACION.md`](./docs/requerimientos/FORMATO-ASIENTOS-OPERACION.md) e
   implementada en D-058 como **motor server-side único** — el mismo texto alimenta el listado, las
   bitácoras de Sala y el Excel.
2. ~~**Plantilla del asiento de cambio de despacho** ("el de la imagen") — REQ-05 §8.1.~~
   ✅ **Resuelta 2026-08-31**: el autor aportó la imagen y reformuló el alcance. El texto es literal
   del F03 —`Se recibe del XM despacho económico de G3.0 y G3.2 para el DD-MM-AAAA`— y **no necesita**
   el valor anterior, porque el asiento es la llegada del despacho del día siguiente y no un cambio
   entre dos valores. Cae con esto la exigencia de tocar el parser de correos del otro repo.
3. ~~**Layout 1 a 1 del `.xlsx` de referencia** — REQ-06 §8.1.~~ ✅ **Resuelto**: el F03 quedó
   calcado y el libro se genera clonando una plantilla derivada del archivo real.
   **Falta el segundo formato** (`Reporte diario de generación y combustible`) — REQ-01 §8.1.
