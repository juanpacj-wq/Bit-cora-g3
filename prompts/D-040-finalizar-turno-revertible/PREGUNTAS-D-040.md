# D-040 — Preguntas de descubrimiento (congeladas)

> Decisiones autoritativas del flujo. Cerradas en la sesión de planificación (2026-07-03).
> No re-abrir en ejecución; si algo cambia, va a `ESTADO.md` (desviaciones).

## Ronda 1 — Scope y comportamiento (cerrada)

| # | Pregunta | Opciones | Respuesta |
|---|---|---|---|
| 1 | ¿Qué escrituras se inhiben cuando un ingeniero finaliza su turno? | a) Todas las bitácoras · b) Solo genéricas (MAND/DISP/COMB operables) | **b) Solo bitácoras genéricas.** El write-gate aplica únicamente al path genérico de `registros.js` (bitácoras que usan `GrillaRegistros`). MAND, DISP y COMB quedan operables aunque el turno esté finalizado. |
| 2 | Al cerrar el turno definitivamente el JdT/IngOp, si hay ingenieros sin finalizar, ¿qué pasa? | a) Avisar y permitir forzar · b) Bloquear hasta que todos finalicen | **a) Avisar y permitir forzar.** Se conserva el flujo actual: modal `CierrePendientesModal` con la lista de pendientes + `POST /api/bitacora/finalizar-forzado`. Sin bloqueo duro del cierre. |
| 3 | ¿Quién puede revertir una finalización de turno? | a) Cada quien la suya · b) Cada quien + JdT a otros | **a) Cada quien la suya (self-service).** Un ingeniero solo revierte SU propia finalización, libremente, mientras su sesión de app siga viva. NO se crea endpoint de forzar-revertir de terceros. |

## Ronda 2 — Decisiones técnicas (cerradas por recomendación)

| # | Pregunta | Respuesta |
|---|---|---|
| 4 | Nombre del endpoint de reversión | **`POST /api/bitacora/revertir-turno`** (coincide con el verbo de UI "Revertir"). |
| 5 | ¿Dónde vive la finalización de turno? | **Columna nueva `bitacora.sesion_activa.turno_finalizado_en DATETIME2 NULL`** (fuente única de verdad). Se desacopla de `sesion_bitacora.finalizada_en`, que vuelve a ser SOLO presencia por-bitácora. |
| 6 | ¿`/finalizar` y `/finalizar-forzado` siguen tocando `sesion_bitacora`? | **No.** La presencia la gestionan únicamente `/abrir` y el `turno-sweeper`. La finalización es exclusivamente la columna nueva. |
| 7 | ¿Se conserva la paridad `*_bogota`? | **Sí** — es convención dura del subrepo (`db.js` bloque paridad TZ). Agregar `turno_finalizado_en_bogota AS DATEADD(HOUR,-5,...)`. |
| 8 | ¿El modal de pendientes necesita aún `bitacoras_abiertas` por usuario? | **Sí.** `CierrePendientesModal.jsx:74-77` pinta `u.bitacoras_abiertas`. La query corregida de `ingenieros_no_finalizados` filtra por `turno_finalizado_en IS NULL` pero SIGUE devolviendo la lista de bitácoras presentes vía `OUTER APPLY` a `sesion_bitacora` (informativa). |

## Criterio de éxito (congelado)
- Finalizar → botón deshabilitado y **botón "Revertir finalización"** disponible; **navegar/ver bitácoras NO repone al ingeniero como pendiente** (fix del bug).
- Finalizado → **no puede crear/editar en bitácoras genéricas** (409 `turno_finalizado`); MAND/DISP/COMB siguen operables.
- Revertir → desbloquea y quita al usuario de "finalizado".
- Estado sobrevive F5 (fuente = backend vía `/api/me`), sin `localStorage`.
- JdT conserva "avisar y forzar" en el cierre masivo.
- Todo con trazabilidad CIET (finalización + reapertura) y tests de regresión.
