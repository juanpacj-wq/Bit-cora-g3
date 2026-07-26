# D-058 — ESTADO (bitácora viva)

> **Puente de contexto entre sesiones.** A diferencia de `_CONTEXTO-BASE.md` (inmutable), este
> archivo se actualiza en CADA etapa:
> - **Al empezar** una etapa: leerlo para saber qué quedó hecho, qué se descubrió y qué
>   desviaciones acumuladas hay.
> - **Al terminar** una etapa: registrar qué se hizo, archivos tocados, resultado de tests,
>   desviaciones y datos descubiertos.
>
> Una etapa solo se ejecuta si **todas las anteriores figuran ✅** en el tablero.
>
> Branch sugerido: `feat/asientos-operacion-2026-07`.

## Tablero de avance

| Etapa | Estado | Resumen |
|---|---|---|
| E0 — Andamiaje | ✅ | `PREGUNTAS-D-058.md` (15 respuestas, 3 rondas), `_CONTEXTO-BASE.md`, `ESTADO.md`, `E1..E10`. |
| E1 — Motor de asientos (puro) | ✅ | `utils/asientos/` (puro) + 28 tests unitarios + 6 guards contra el catálogo real. Nadie lo importa todavía. |
| E2 — El asiento en el listado del día + copiar | ⬜ | — |
| E3 — `seleccionable` + los 8 tipos espejo | ⬜ | — |
| E4 — Reflejo a Sala: crear | ⬜ | — |
| E5 — Reflejo a Sala: corregir y borrar | ⬜ | — |
| E6 — El asiento reflejado es de solo lectura | ⬜ | — |
| E7 — XLSX ESM + plantilla F03 derivada | ⬜ | — |
| E8 — Consulta unificada y armado del día | ⬜ | — |
| E9 — Endpoint mensual + selector y botón | ⬜ | — |
| E10 — Docs + ADR D-058 + cleanup | ⬜ | — |

Leyenda: ⬜ pendiente · 🟡 en progreso · ✅ hecho y probado · ⛔ bloqueado.

### Dependencias entre etapas

```
E1 ──┬─> E2
     ├─> E4 (necesita también E3)
     └─> E8
E3 ──> E4 ──> E5 ──> E6
E4 ──> E8   (E8 excluye los reflejados: necesita la marca ya definida y poblada)
E7 ──> E9
E8 ──> E9
```

## Decisiones / desviaciones acumuladas

> Cambios respecto a `_CONTEXTO-BASE.md`/`PREGUNTAS` que surgieron al ejecutar. Cada uno con la
> etapa que lo originó y si tiene o no impacto funcional.

- **E1 — `carga()` resuelve la preposición del tramo de periodos.** El insumo fija solo el caso
  frecuente (rango contiguo → `del P17 al P19`). Para los otros dos, escribir `del P20` o
  `del P3, P7 y P19` queda agramatical, así que el motor emite `en el P20` y
  `en los P3, P7 y P19`. Los tres ejemplos literales del insumo salen idénticos. Sin impacto
  funcional; si el usuario prefiere otra redacción, se cambia en `formato.js:tramoPeriodos`.
- **E1 — `potenciaMW(null)` devuelve `''`, no `'0 MW'`.** `Number(null)` es `0` y un cero
  inventado es indistinguible del redespacho plano a cero, que es un caso REAL (06/01). El vacío
  se descarta antes de convertir, tanto en `potenciaMW` como en el filtro de celdas.
- **E1 — se agregó un segundo archivo de tests no previsto en el plan** (`asientos_catalogo.test.js`,
  solo lectura). Motivo: el motor **lanza** ante un tipo/estado desconocido, y eso solo es seguro
  mientras sus enums sean espejo de los `CHECK` de la BD. Habilitado porque el `.env` de la sesión
  apunta a `PortalG3_dev`; aun así **no** escribe nada, así que sigue siendo seguro contra prod.
- **E1 — el commit incluye dos rutas fuera de la lista del `.md` de la etapa**: `server/package.json`
  (enganchar los tests al script `test` es regla dura del contexto base — el guard de D-041 existía
  y no corría por saltarse esto) y `prompts/D-058-asientos-operacion/` (el andamiaje estaba sin
  trackear; D-057 lo llevó versionado hasta su cleanup).

## Datos descubiertos en ejecución

> Hechos que solo se conocen corriendo. Rellenar a medida.

- **Las 7 filas que migró `F32.A1` tienen un `lote_id` POR FILA**, así que no compactan: una
  autorización de `90 MW` en P1..P5 rinde **cinco renglones** (`… a generar 90 MW en el P1.`, …)
  en vez de uno solo con `del P1 al P5`. No es bug del motor —la compactación solo puede agrupar
  lo que el dato ya trae junto, y esas filas nacieron sueltas antes de que D-056 inventara el
  lote—, pero **E2 (listado) y E8 (libro F03) van a mostrarlo así** y conviene no confundirlo con
  un defecto. Los 3 lotes capturados después de D-056 compactan bien
  (`del P7 al P14`, `del P5 al P9`, `del P11 al P16`).
- **El `.env` de esta máquina apunta a `PortalG3_dev` (192.168.17.20), no a prod** — pero esa BD
  trae una **copia de los datos reales** (los mismos 26 registros / 10 lotes de MAND que reportó la
  planificación contra prod). La disciplina de `TEST_PLANTA`/`es_sintetico` NO se relaja: los
  guards estáticos la exigen a nivel de código y el próximo que corra la suite puede tener el
  `.env` apuntando a prod.
- **La suite HTTP necesita el backend levantado**: sin él, `turno_transicion_write_gate` y
  compañía fallan con `ECONNREFUSED 127.0.0.1:3002` (no es regresión). Se levanta con
  `cd server && AUTH_TEST_BYPASS=1 node --env-file=../.env server.js`; el puerto sale de
  `SERVER_PORT` del `.env` (3002), no de `PORT`.
- Volumen real hoy en la BD: MAND 26 celdas / 10 lotes · DISP 1 estado · Sala 5 registros — lo
  esperado por el contexto base.

## Baseline y riesgos conocidos al arrancar

- **La suite corre contra la BD productiva (D-030).** Ningún test escribe/borra en planta real:
  `TEST_PLANTA_ID` (`'TST'`) + `TEST_TAG` (sin `[` ni `]`).
- **Flaky conocido, no es regresión:** `finalizar_turno` (4a2/4a3/4e/4f), por borde de turno T1↔T2 y
  por fuga de estado con la cabecera TST `CERRADO`. `npm test` no respeta el orden de archivos de
  `package.json`.
- **`npm run lint` no existe** en este repo. La verificación de front es `npm run build`.
- Adopción real y baja al planificar (2026-07-26): MAND 26 filas / 10 lotes · DISP 1 evento de
  prueba · Sala 6 registros de prueba. Las hojas van a salir casi vacías y **eso es correcto**.

## Bitácora por etapa

### E0 — Andamiaje  ✅
- Creados: `PREGUNTAS-D-058.md` (15 preguntas en 3 rondas, todas respondidas y congeladas),
  `_CONTEXTO-BASE.md`, `ESTADO.md`, `E1-*.md` … `E10-*.md`.
- Verificado durante la planificación, contra código y contra el `.xlsx` real:
  el catálogo de `tipo_evento` (MAND `Autorización`/`Pruebas`/`Redespacho`; DISP
  `Cambio de Disponibilidad`; SALAJDT/SALAING `Evento General`), que
  `GET /api/catalogos/bitacoras/:id/tipos-evento` **no filtra** por visibilidad, que
  `resolverTurnoAbierto` (`turno-entidad.js:144`) acepta pool o transacción, que el F03 tiene
  **170 entradas ZIP** (todas DEFLATE salvo `media/image1.png`, STORED) y **32 `definedName`
  `_xlnm.Print_Area`** con rangos por hoja (`$A$6:$I$25` … `$A$6:$I$32`).
- Sin código de producto todavía.

### E1 — Motor de asientos (puro)  ✅

**Archivos tocados**
- `server/utils/asientos/formato.js` (nuevo) — convenciones canónicas §4: `unidadCanonica`,
  `potenciaMW`, `listaPeriodos`, `carga` (regla de compactación) y `UNIDAD_YA_NOMBRADA`.
- `server/utils/asientos/plantillas.js` (nuevo) — las plantillas de §5, una constante por tipo +
  el mapa de los 4 estados de DISP. Devuelven la frase SIN punto y SIN `detalle`.
- `server/utils/asientos/index.js` (nuevo) — `asientoLote` · `asientoDisponibilidad` ·
  `asientoLiteralSala`, y el único lugar donde se cierra la frase y se engancha el `detalle`.
- `server/tests/asientos.test.js` (nuevo) — 28 tests unitarios PUROS (sin BD, 275 ms).
- `server/tests/asientos_catalogo.test.js` (nuevo) — 6 guards de SOLO LECTURA contra el catálogo.
- `server/package.json` — los dos archivos enganchados al script `test`.

**Decisiones de implementación que no estaban en el plan**
- Un tipo/estado desconocido **LANZA** en vez de devolver `''`: viene de una columna con `CHECK`,
  así que es bug del llamador, y un renglón en blanco en el histórico o en el F03 es peor que un
  error. Es justo lo que fija el guard anti-drift de `asientos_catalogo.test.js`.
- El `detalle` se aplana a un renglón (`\s+` → espacio) porque el asiento **es** una línea (celda
  del F03, fila del listado). No se corrige ni se reescribe su contenido. El texto de Sala, en
  cambio, no se toca ni con eso: pasa literal, y **no** se le agrega punto final (agregarlo sería
  normalizar).

**Verificación real**
- `node --test tests/asientos.test.js tests/asientos_catalogo.test.js` → **34/34 pass, 0 fail.**
  El archivo puro corre en 275 ms (si tardara, habría tocado la BD).
- Los 6 guards contra el catálogo real pasaron: los 4 estados de `PLANTILLA_DISP` son exactamente
  `CK_disp_estado_evento`; los 3 tipos de `PLANTILLA_LOTE` son exactamente
  `CK_te_notificar_dashboard_tipo`; MAND cablea `AUTH→Autorización`, `PRUEBA→Pruebas`,
  `REDESP→Redespacho` (los nombres literales que E3 tiene que copiar).
- **Smoke contra datos reales**: se renderizaron los 10 lotes de MAND (26 celdas, sobre
  `registro_activo` + `registro_historico`), el estado de DISP y los 5 registros de Sala. Ninguno
  lanzó, ninguno salió vacío, ninguno dijo `MWh`/`undefined`, ninguno perdió texto del operador ni
  duplicó el prefijo de unidad. Muestra generada:
  `Se recibe llamada del CND (juanpa) autorizando GEC3 a generar 20 MW del P7 al P14.` ·
  `GEC3 E/L en servicio.` · `GEC3 — Evento: Salida de mando`
- `cd server && npm test` (suite completa, con el backend levantado, contra `PortalG3_dev`):
  **tests 462 · suites 26 · pass 461 · fail 0 · cancelled 0 · skipped 1** (`parseXls`, skip
  declarado ajeno) en 34,9 min. Es el baseline de D-057 (428/427) **+ los 34 nuevos**, sin un solo
  rojo: ni siquiera el flaky conocido de `finalizar_turno`, y `zzz_session_leak_guard` corrió y
  pasó dentro de la corrida.
- Sin front en esta etapa → no aplica `npm run build`.

**Desviaciones** — las cuatro registradas arriba en "Decisiones / desviaciones acumuladas".
Ninguna cambia el contrato del motor ni las plantillas del insumo.

<!-- Cada etapa agrega su bloque: ### EX — <título>  ✅ con Archivos tocados / Verificación / Desviaciones. -->
