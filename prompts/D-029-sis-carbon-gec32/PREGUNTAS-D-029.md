# D-029 — Preguntas y respuestas (congeladas)

Sesión de planeación 2026-06-03. Estas respuestas son **autoritativas** para toda la implementación.

| # | Pregunta | Respuesta |
|---|---|---|
| 1 | ¿Qué pasa si un operador editó manualmente una celda ALIM que el scraper vuelve a procesar? | **Operador gana**: si `modificado_por`/`creado_por` es humano, el SIS no sobrescribe `cantidad`. Además: indicador visual de override (badge), tooltip con quién editó + valor SIS, y botón **Revertir** que restaura el valor SIS. |
| 2 | ¿Desde qué fecha el backfill? | Desde el **inicio de operación de GEC32**. No se conoce exacto: se **descubre sondeando el SIS** hacia atrás (`discoverEarliestDate`). |
| 3 | ¿Qué periodos re-procesa el job horario? | **Todo el día de hoy** cada hora (periodos 1..hora_actual), upsert idempotente. Auto-sana correcciones tardías del SIS. |
| 4 | ¿Dónde corre el job y hay acceso al SIS? | En el **backend** (mismo proceso, puerto 3002). Acceso al SIS no garantizado ⇒ **manejar SIS inalcanzable** (log + reintento, sin romper el server). |
| 5 | ¿Cómo se almacena el valor SIS para revertir? | **Columna `valor_sis` DECIMAL(12,3) NULL** en `consumo_combustible` (+ `sis_actualizado_en`). `cantidad`=mostrado (manual o SIS); `valor_sis`=última lectura SIS. |
| 6 | ¿Validado o crudo? | **Validado** (gated por servicio: `CT659>400 && CT651>400 && MPAFLOW>140`; si no, 0). |
| 7 | ¿Quién corre el backfill y desde dónde? | **Claude**, desde este equipo (alcanza BD `192.168.17.20` y SIS `192.168.18.201`). |
| 8 | ¿Disparo manual además del job? | **Sí**: endpoint `POST /api/combustibles/sis/scrape` gated (JdT/IngOp/Jefe Planta). |
| 9 | ¿Cómo refleja la grilla lo nuevo? | **Auto-refresco** cuando se ve GEC32 + hoy (interval ~5 min + window focus). |

## Detalles operativos confirmados
- Las **8 tolvas** mapean 1:1 a `ALIM_1..ALIM_8` de GEC32. Caliza/ACPM siguen manuales.
- Autor de toda escritura automática = **usuario SISTEMA** (`USUARIO_SISTEMA_ID`).
- Backfill **resumible** (`sis_scrape_log.completo`) y **throttled** por volumen (años × 24 periodos).
- Solo se guardan filas con carbón **> 0** (vacío ≡ 0).
