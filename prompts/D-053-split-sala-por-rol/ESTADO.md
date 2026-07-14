# D-053 — ESTADO (bitácora viva)

> **Puente de contexto entre sesiones.** A diferencia de `_CONTEXTO-BASE.md` (inmutable), este archivo
> se actualiza en CADA etapa:
> - **Al empezar**: leerlo para saber qué quedó hecho, qué se descubrió y qué desviaciones hay.
> - **Al terminar**: registrar qué se hizo, archivos tocados, resultado de tests, desviaciones y datos
>   descubiertos.
> Una etapa solo se ejecuta si **todas las anteriores figuran ✅** en el tablero.

Branch del flujo: `feat/split-sala-por-rol-2026-07`

## ⛔ Prerrequisito antes de E1 — D-052 sin commitear

Al cerrar E0 (2026-07-14) el árbol de trabajo **no estaba limpio**: **D-052** (rename de la bitácora
`ANAL` a "Analista") está **implementado pero sin commitear**, y toca **exactamente los mismos
archivos** que E1:

```
 M CLAUDE.md            M docs/decisions.md      M server/db.js
 M server/package.json  M server/utils/ia/prompts.js
?? server/tests/catalogo_bitacoras.test.js
```

**Antes de arrancar E1: commitear D-052 en `main`** (está completo, con su ADR y su guard). Si no, los
cambios de las dos features se entrelazan en los mismos archivos y E1 obliga al baile de *selective
staging* (`01-convenciones.md`), con riesgo de commits mezclados.

Además, **D-052 es contexto vivo de E1**: fijó el espejo `prompts.js` ↔ catálogo y el guard
`catalogo_bitacoras.test.js` que valida ese espejo en ambas direcciones — justo lo que E1 tiene que
extender a las tres SALA*.

## Tablero de avance

| Etapa | Estado | Resumen |
|---|---|---|
| E0 — Andamiaje | ✅ | Carpeta `prompts/D-053-split-sala-por-rol/` creada: `_CONTEXTO-BASE.md`, `PREGUNTAS-D-053.md`, `ESTADO.md`, `E1..E4`. |
| E1 — Catálogo + matriz + espejo IA | ✅ | `bda18d1`. SALA→SALAJDT (id=14, orden=3, tipo 17 intactos) + SALAING(18)/SALAOP(19) nuevas; matriz idéntica a la objetivo; `prompts.js` a 3 entradas; alias `#/b/SALA`. |
| E2 — Migración `F30.A1` + reporte pre-flight | ✅ | `e74c543`. Move-out por atribución positiva + respaldo RF-032 + validación con THROW; snippet pre-flight solo-lectura + guardrail. |
| E3 — Tests + guardrails | ✅ | `31392ab`. Falso verde cerrado (ADMIN como no-autor + assert de precondición), fixtures `test_opsala`/`test_admin`, `split_sala_permisos` (6/6), `guard_tipo_evento_coherente` (verificado en negativo), `ia_cliente` a 10 códigos. **Suite: 350 tests, 349 pass, 0 fail.** |
| E4 — Docs + ADR D-053 + cleanup | ✅ | ADR D-053; CLAUDE.md (conv. 26 + ruta real de `GrillaRegistros`); glosario; BIT-MODBD v2.0 (§2.6 + §4.11 nueva + changelog); BIT-RF (excepciones de RF-032). |

Leyenda: ⬜ pendiente · 🟡 en progreso · ✅ hecho y probado · ⛔ bloqueado.

## Decisiones / desviaciones acumuladas

> Cambios respecto a `_CONTEXTO-BASE.md`/`PREGUNTAS` que surgieron al ejecutar. Cada uno con la etapa
> que lo originó y si tiene o no impacto funcional.

- **(E0, sin impacto funcional)** D-052 estaba sin commitear y tocaba los mismos archivos que E1. Se
  commiteó **aparte** (`a86085e`) al inicio del branch para preservar la atomicidad de ambas features,
  en vez de hacer el baile de *selective staging*. `main` quedó intacto.
- **(E1, sin impacto funcional)** Se renumeró el `orden` de las bitácoras del MERGE (AGUA 4→6 … MAND
  12→14) para dejar las tres SALA* contiguas en 3/4/5. El **orden relativo se preserva** (solo se
  insertan 2), así que el sidebar no cambia de forma perceptible. Se evitó `orden=11`, que ya colisiona
  entre CIET (oculta) y COMB.
- **(E2, hallazgo con impacto)** El `stripComments` heredado de los guards D-045/D-046 **no funciona con
  CRLF**: en regex `.` no matchea `\r`, así que `/\/\/.*$/` nunca alcanza el `$` y los comentarios
  sobreviven al strip → falsos positivos. El guard nuevo normaliza `CRLF→LF` primero. **Queda latente en
  los dos guards hermanos** (no lo notan porque `db.js` nunca nombra sus scripts). Candidato a fix aparte.
- **(E3, sin impacto funcional)** El fixture del "no-autor CON `puede_crear`" pasó de JdT a **ADMIN**, y
  se le agregó un `assert` de **precondición** que verifica que el ADMIN realmente tenga `puede_crear` en
  la bitácora — sin eso, el test podría volver a degradarse a un falso verde en silencio.

## Datos descubiertos en ejecución

> Hechos que solo se conocen corriendo. Rellenar a medida.

- **(Planeación, dev)** `bitacora_id=14` en **dev**: 0 filas en `registro_activo`, 2 en
  `registro_historico`, un único autor `usuario_id=98` (cuenta del desarrollador) con **5 cargos
  distintos** en `sesion_activa`. Ambos registros resueltos por `turno_id` vía `turno_participante` /
  `conformacion_turno`: `4128` (turno 393) → *Ingeniero Jefe de Turno*; `4240` (turno 501) →
  *Administrador y Debugging*. `tipo_evento_id=17` es el `'Evento General'` de la bitácora 14.
  **Estos números son de dev y NO representan prod** — el reporte pre-flight de E2 es la fuente real.
- **(Planeación)** `registro_activo` en dev: 129 filas, **todas con `turno_id` NULL** (son MAND, exenta
  por diseño). `registro_historico`: 6 filas, todas con `turno_id` NOT NULL.
- **(Planeación)** Pendiente de llenar en E2: conteo real de prod y **cuántos registros quedan sin
  atribuir**.

## Bitácora por etapa

### E0 — Andamiaje  ✅
- Creados: `_CONTEXTO-BASE.md`, `PREGUNTAS-D-053.md`, `ESTADO.md`, `E1-catalogo-matriz.md`,
  `E2-migracion-datos.md`, `E3-tests-guardrails.md`, `E4-docs-cleanup.md`.
- Sin código de producto todavía.

<!-- Cada etapa agrega su bloque: ### EX — <título>  ✅ con Archivos tocados / Verificación / Desviaciones. -->
