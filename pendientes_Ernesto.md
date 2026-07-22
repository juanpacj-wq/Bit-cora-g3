## 1. Resumen De pendientes

- [X] crear bitácoras nuevas para cada cargo. jdt, ing op y operadores sala de mando
- [X] bitácora análisis se debería llamar analista
- [ ] Boton descargar archivo en apartado de combustible → [REQ-01](./docs/requerimientos/REQ-01-descarga-combustibles.md)
- [X] facilitar el cambio de unidad para jdt y analista quimico
- [ ] Sala de mando operativa debería mostrar los valores registrados en la bitácora operación 24hr y disponibilidad, para las bitácoras de jdt e ing de operación. (para jdt e ing de op, si cualquiera de los 2 crea, se envía a ambas) → [REQ-02](./docs/requerimientos/REQ-02-reflejo-bitacoras-sala.md)
- [X] Operación 24 hr debería tener registros únicos (dinámica registrar->Guardar->registros se envían, pero funcionario y detalle son generales para los periodos, no debería ser así) pensar cómo hacerlo bien → [REQ-03](./docs/requerimientos/REQ-03-operacion-24h-registros-unicos.md)
- [ ] histórico en el mismo apartado para ver los registros de autorización, pruebas y redespachos, con formato enviado a whatsapp. → [REQ-04](./docs/requerimientos/REQ-04-historico-en-apartado.md)
- [ ] cuando cambia despacho (redesp<>desp por correo o registro) crear histórico en op24hr con el formato en la imagen → [REQ-05](./docs/requerimientos/REQ-05-asiento-cambio-despacho.md)
- [ ] crear archivo Excel con valores registrados en redespachos, autorizaciones y eventos de disponibilidad. → [REQ-06](./docs/requerimientos/REQ-06-excel-eventos-operacion.md)

## 2. Requerimientos formalizados

Los cinco pendientes abiertos están especificados en `docs/requerimientos/` (2026-07-21), uno por
viñeta, con alcance, reglas de negocio, impacto técnico y criterios de aceptación.

| Doc | Estado | Depende de |
|---|---|---|
| [REQ-01](./docs/requerimientos/REQ-01-descarga-combustibles.md) — Descarga de Combustibles | 🟡 Bloqueado (layout) | — |
| [REQ-02](./docs/requerimientos/REQ-02-reflejo-bitacoras-sala.md) — Reflejo a bitácoras de Sala | 🟡 Bloqueado (plantilla) | REQ-03 |
| [REQ-03](./docs/requerimientos/REQ-03-operacion-24h-registros-unicos.md) — Operación 24h append-only | ✅ Implementado (D-056, 2026-07-22) | — |
| [REQ-04](./docs/requerimientos/REQ-04-historico-en-apartado.md) — Histórico en el apartado | 🟡 Bloqueado (plantilla) · listado mínimo ya entregado por D-056 | REQ-03 ✅ |
| [REQ-05](./docs/requerimientos/REQ-05-asiento-cambio-despacho.md) — Asiento de cambio de despacho | 🟡 Bloqueado (plantilla) | REQ-03, REQ-04 |
| [REQ-06](./docs/requerimientos/REQ-06-excel-eventos-operacion.md) — Excel de eventos de operación | 🟡 Bloqueado (layout) | REQ-01, REQ-03 |

### Bloqueantes transversales

Tres piezas de contenido pendientes de definir, cada una marcada dentro de su documento:

1. **Plantilla del mensaje de WhatsApp** — REQ-04 §8.1 (y reutilizable en REQ-02).
2. **Plantilla del asiento de cambio de despacho** ("el de la imagen") — REQ-05 §8.1.
   La imagen no está en el repo.
3. **Layout 1 a 1 de los dos `.xlsx` de referencia** de la raíz — REQ-01 §8.1 y REQ-06 §8.1.
