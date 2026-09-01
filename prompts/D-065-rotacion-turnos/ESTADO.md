# D-065 — ESTADO (tablero por olas)

> Lo escribe **solo el integrador** (fase 2 y cada gate). Los lotes NO lo tocan: su estado vive en
> `cierres/LNN.md` y en `LOTES.json`. Este archivo es corto a propósito: el detalle está en los
> cierres y en los `GATE-On.md`.

## Tablero

| Ola | Lote | Título | Estado | Cierre | Gate |
|---|---|---|---|---|---|
| O1 | L01 | Motor puro del patrón de rotación | ✅ | `cierres/L01.md` | — |
| O1 | L02 | Schema `F37.A1` + flag de cargo `F37.A2` | ✅ | `cierres/L02.md` | — |
| O1 | L03 | Cliente de Graph y sincronización del directorio | ✅ | `cierres/L03.md` | — |
| — | **GATE-O1** | 3 lotes · 781/781 backend · 324/324 front · 0 violaciones | ✅ | | `GATE-O1.md` |
| O2 | L04 | Endpoints de configuración anual | ⬜ | — | — |
| O2 | L05 | Toma de control del rol (backend) | ⬜ | — | — |
| O2 | L06 | Cumplimiento y congelado al cerrar | ⬜ | — | — |
| O2 | L11 | Correcciones de la O1 (abierto por el GATE-O1, D5) | ⬜ | — | — |
| — | **GATE-O2** | | ⬜ | | `GATE-O2.md` |
| O3 | L07 | Pantalla de configuración anual | ⬜ | — | — |
| O3 | L08 | Popup de toma de control | ⬜ | — | — |
| O3 | L09 | Vista de cumplimiento | ⬜ | — | — |
| — | **GATE-O3** | | ⬜ | | `GATE-O3.md` |
| O4 | L10 | Cableado en el componente raíz y rutas hash | ⬜ | — | — |
| — | **GATE-O4** | | ⬜ | | `GATE-O4.md` |
| Cierre | — | ADR D-065 + `CLAUDE.md` 38 + BIT-MODBD v2.8 + BIT-RF v2.4/RF-079 + `git rm` | ⬜ | | |

Leyenda: ⬜ pendiente · 🟡 en curso · ✅ done (lote) / cerrada con visto bueno (ola) · ⛔ bloqueado.
La verdad operativa es `lotes.mjs status`; esta tabla es la foto que deja cada gate.

## Baseline de la suite

| Momento | Resultado | Duración |
|---|---|---|
| Rama base `feat/integrar-asientos-D-059` (heredado de GATE-O2 de D-063, `9dfbbe3`, 2026-08-29) | backend **681/681** · front **324/324** · 0 violaciones | ~40 min backend |
| Antes de O1 (medición propia) | no se corrió — el GATE-O1 la sustituye (ver nota abajo) | |
| **GATE-O1** (2026-09-01, server efímero `:3199`, `PortalG3_dev`) | backend **781/781** · front **324/324** · build ok · 0 violaciones · 0 residuos | ~44 min backend (12 bloques) · 50 s front |
| GATE-O2 | | |
| GATE-O3 | | |
| GATE-O4 | | |

> **Por qué el baseline propio quedó pendiente y no es una omisión:** al cerrar la fase 2 (2026-08-31
> 21:30 Bogotá) había una sesión de `/cerrar-implementacion D-064` corriendo la suite completa en el
> árbol principal, con el **test-lock tomado** (`CIERRE-D064`, TTL 45 min). Correr la suite en
> paralelo la habría contaminado. El baseline heredado de D-063 es el punto de comparación válido
> —la rama base no ha cambiado desde ese gate salvo dos commits de `docs/`— y el GATE-O1 establece
> la medición propia bajo el lock.

## Hechos descubiertos (acumulado, breve)

- **Fase 2:** la cuadrilla OPS del Excel **cambia todos los meses** (69 de 308 celdas al año);
  la de ING no cambia ni una vez en 12. De ahí sale el modelo de asignación con vigencia.
- **Fase 2:** Entra ID ya aporta **persona + rol** para 81 personas en roles de rotación; lo único
  que falta es el grupo G1–G4. La cuadrilla del Excel calza en 71 de 81.
- **Fase 2:** el desfase **no se puede derivar de `grupo_t1` solo** — `V1` toma 4 valores distintos
  en 8 índices. Hacen falta los grupos de T1 **y** T2 del día de inicio.
- **Fase 2:** el grupo de Entra `ADMINISTRADOR Y DEBUGGING` está **vacío**, y es uno de los dos
  cargos que podrán configurar la malla. Hoy el único que puede usar la superficie A es el
  Gerente de Producción. Va al runbook del cierre.
- **O1 (L01):** el oráculo del Excel **no distingue** la aritmética de fechas correcta de la frágil —
  con `new Date(str)` los 1.460 pares pasan igual, porque el offset se cancela en los dos extremos.
  Lo que protege es el **parsing estricto**, no el oráculo.
- **O1 (L02):** un flag de cargo se agrega en DOS sitios y en ESE orden — el `ALTER` idempotente en la
  sección de catálogos (antes del MERGE) y el valor DENTRO del MERGE. Invertirlo no rompe la migración:
  rompe el arranque. Y el `ALTER` de un flag **no puede** registrarse en `migracion_aplicada` (esa tabla
  la crea `F16.A0` ~1.100 líneas más abajo).
- **O1 (L03):** el tenant tiene una **asignación directa de usuario** (Gerente de Producción) además de
  los 13 grupos; `appRoleAssignedTo` no da de ella el UPN, hace falta un `GET /users/{id}`. Y
  `personas.length` (89) **no** es la suma de `grupos[].miembros` (90): el Gerente está también en
  `USUARIO_CONSULTA` y `PRECEDENCE` lo deduplica.
- **O1 (GATE, `/code-review`):** el `MERGE` de la sincronización pisa `azure_upn` con `NULL` cuando
  Graph no devuelve UPN, y en el **siguiente arranque** `enforceSingletonFlag` degrada al Jefe de
  Planta a `0`. Es el hallazgo más serio de la ola (CR-1) y no lo veía nadie: los dos extremos están
  a 3.000 líneas de distancia en archivos distintos.
- **O1 (GATE, medido contra la BD):** un `CHECK (grupo BETWEEN 1 AND 4)` sobre una columna NULLABLE
  **acepta `NULL`** (evalúa a `UNKNOWN`, y un CHECK solo rechaza el `FALSE`). La razón por la que L02
  dejó `rotacion_cumplimiento.grupo` sin constraint era falsa: se podían tener las dos cosas.
- **O1 (GATE, `/security-review`):** cero hallazgos. El `MERGE` matchea **solo** por `azure_oid`, y su
  rama `WHEN MATCHED` es estrictamente más estrecha que la de `provisionEntraUser`. El bearer de
  Graph está anclado por host con la barra final (`'https://graph.microsoft.com/'`), lo que corta el
  `@odata.nextLink` hostil.
- **O1 (GATE):** `utils/errores.js` no clasificaba `entra_no_disponible` → habría salido **500**, no el
  503 que promete CA-6. Arreglado en el gate.
- **O1 (GATE):** el `turno-sweeper` y el `mand-sweeper` arrancan **incondicionalmente**, también bajo
  `AUTH_TEST_BYPASS=1`: la convención 37(b) de D-064 solo la aplica el sweeper de despacho. Deuda
  heredada, **fuera de alcance de D-065**.
- **Fase 2:** prod tiene **13 personas duplicadas** en `lov_bit.usuario` (fila legacy + fila Entra).
  Preexistente, **fuera de alcance**; el módulo se defiende trabajando solo sobre filas con
  `azure_oid`.

## Desviaciones acumuladas respecto a `_CONTEXTO-BASE.md`

Todas **aceptadas** en el GATE-O1 (detalle y razón en `GATE-O1.md §5`). Ninguna cambia una ruta
especificada por un contrato: son aditivas o cubren caminos que el contrato dejó sin decir.

- **C1 (L01):** el motor lanza dos códigos de error que C1 no enumera — `fecha_invalida` y
  `patron_invalido`. Cubren la fecha malformada y el patrón sin desfase entero, que el contrato no
  especificaba; el camino feliz y los cuatro errores de C1 no cambian.
- **C2 (L02):** `F37.A1` usa el patrón de `F29.A1` (DDL con `IF OBJECT_ID` por statement, auto-reparable)
  y no el gateo del bloque entero por `migracion_aplicada`. `F37.A2` **no deja fila** en
  `migracion_aplicada` (esa tabla aún no existe en ese punto del arranque). Se nombraron los CHECK y
  DEFAULT que el contrato dejaba anónimos, y `rotacion_patron`/`rotacion_asignacion` ganaron
  `creado_en_bogota` (la prosa del §5.1 lo pedía para todas).
- **C3 (L03):** `leerDirectorioEntra` hace un quinto llamado a Graph (`GET /users/{id}`) para la
  asignación **directa** de usuario, devuelve **una** fila por persona con el rol resuelto por
  `PRECEDENCE`, y `sincronizarDirectorio` acepta dos parámetros opcionales de inyección
  (`directorio`, `fetchImpl`) que no cambian lo que L04 le pasa.

## Bitácora

- **2026-08-31** · Fase 1 cerrada: 5 rondas de preguntas (incluida una ronda 0 de vocabulario y una
  ronda 4 de corrección del eje del modelo, de "área" a **rol**). 23 criterios de aceptación
  congelados en `PREGUNTAS-D-065.md`.
- **2026-08-31** · Fase 2 cerrada: scaffolding + reservas commiteados. Rama
  `feat/rotacion-turnos-2026-08` creada desde `feat/integrar-asientos-D-059` (`5cc84a2`) **en un
  worktree temporal**, porque el árbol principal tenía una sesión de cierre de D-064 corriendo la
  suite. El usuario hace `git checkout feat/rotacion-turnos-2026-08` en el árbol principal cuando esa
  sesión termine, antes de abrir los chats de la O1.
- **2026-09-01** · **O1 cerrada** por `GATE-O1.md`: L01/L02/L03 `done`, cero violaciones de territorio,
  suite **781/781** backend (los tres archivos nuevos suman 57 casos; los 724 preexistentes calzan
  exactamente con el baseline de D-064) y **324/324** front. Cinco decisiones: un arreglo hecho en el
  gate (`utils/errores.js`), el territorio de L04 ampliado, el `turno-sweeper` declarado fuera de
  alcance y —**pendiente del visto bueno**— un lote de corrección **L11** en la O2 para los 12
  hallazgos confirmados del `/code-review`. `/security-review` sin hallazgos.
