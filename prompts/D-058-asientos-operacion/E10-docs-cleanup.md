# D-058 · E10 — Docs + ADR D-058 + cleanup + cierre

## Antes de empezar (obligatorio)
1. Leé `_CONTEXTO-BASE.md` y `ESTADO.md` completos.
2. **Verificá que E1..E9 figuren TODAS ✅.** Si alguna no lo está, **detenete**: el cierre no corre
   sobre una implementación incompleta.

## 1. Smoke completo

- `npm run build` (front) verde. (`npm run lint` **no existe** en este repo.)
- `cd server && npm test` — documentá el **resultado exacto**. Baseline conocido: `finalizar_turno`
  (4a2/4a3/4e/4f) es flaky por borde de turno y por fuga de estado con la cabecera TST `CERRADO`; no
  es regresión de D-058.
- Guards que deben estar verdes y son los que este flujo pone en riesgo:
  `guard_tipo_evento_coherente` · `guard_no_prod_historico_destruction` ·
  `guard_no_prod_disp_destruction` · `zzz_session_leak_guard` (último del script).
- **Checklist de smoke UI manual** para el autor (Claude no lo automatiza sin Playwright):
  1. Registrar un lote en Operación 24h → el renglón del listado muestra el asiento normalizado.
  2. Copiar renglón y copiar el día → el portapapeles trae lo esperado.
  3. Abrir `SALAJDT` y `SALAING` → el asiento está en las dos, identificado por su origen y **sin**
     lápiz ni basurero. Abrir `SALAOP` → no está.
  4. Corregir el lote → las dos copias cambian. Borrarlo → las dos desaparecen.
  5. Descargar el mes → abre en Excel **sin advertencia de corrupto**, con logo y encabezado
     GENE-F03, tres bloques por hoja y las dos unidades mezcladas en orden ascendente.
  6. Cambiar el mes en el selector → la URL muestra `#/op24h?mes=…` y sobrevive a F5.
  7. Entrar con un cargo de solo lectura en MAND → no hay botón de descarga ni acciones de
     corrección, pero **sí** se ve el listado con los asientos y los botones de copiar.

## 2. Documentación permanente (el "changelog" del flujo)

### ADR `D-058` en `docs/decisions.md`
Formato fijo (Contexto / Decisión / Consecuencias). Es **la** descripción de lo hecho; no se crea
ningún `CAMBIOS.md`. Debe dejar dicho, como mínimo:
- El motor es **fuente única** de las tres salidas, y por eso el texto se arma **server-side**.
- **`fecha_evento` y `turno_id` de la copia van por criterios distintos**: hora de llamada (narrativo)
  vs. turno **abierto** (puntero de archivado). Con la razón: apuntar a un turno cerrado deja la
  copia viva para siempre y el rescate de huérfanos de D-045 no la alcanza.
- **`rowsAffected = 0` en la cascada no es error** — es lo esperado tras el cierre de turno; el
  histórico no se reescribe y la corrección del origen procede igual.
- **`seleccionable`** y por qué existe (sin ella, cualquier tipo espejo se vuelve tecleable a mano y
  reaparece la doble digitación que REQ-02 elimina).
- El Excel clona una **plantilla real** en ZIP `stored`, con `inlineStr` y **`Print_Area` por hoja
  recalculado**; cero dependencias nuevas.
- Que el Excel lee los **originales** y **excluye** los reflejados de Sala.
- Que **el reflejo de DISP quedó fuera** (sus tipos sí están sembrados) y merece su propio ADR.
- Cross-ref: D-045, D-049, D-053, D-055, D-056, D-057, y REQ-02 / REQ-04 / REQ-06.

### `CLAUDE.md`
Agregar **una** convención nueva (numeración siguiente a la 31), de 1–3 frases + link al ADR, con
los gotchas que van a morder: la hora de MAND es `hora_llamada` y puede estar **ausente**; el T2 se
parte por medianoche en el libro; `turno_id` de la copia ≠ criterio de `fecha_evento`; `rowsAffected
= 0` no es error; `Print_Area` es por hoja. **Mantener el archivo dentro de su límite de tamaño** —
si se pasa, hacer una pasada de consolidación.

### `BIT-MODBD-2026-001.md` y `BIT-RF-2026-001.md`
- **BIT-MODBD**: la columna `lov_bit.tipo_evento.seleccionable`, los 8 tipos espejo y la convención
  `campos_extra.origen_bitacora` / `origen_lote_id` en los registros de Sala. Bumpear la versión del
  doc y agregar entrada a **su** changelog.
- **BIT-RF**: si el reporte mensual o el reflejo tocan un RF existente, actualizarlo; si no, dejarlo.
- El changelog histórico **no se reescribe** — solo se agrega.

### Documentos de requerimientos
- `REQ-02`: pasar §8.1 a ✅ RESUELTA por D-058. Marcar §8.2 resuelta ("solo copias vivas", con la
  razón). Dejar explícito que **DISP quedó fuera** y qué falta para cerrarlo. Actualizar el estado
  de la cabecera.
- `REQ-04`: §8.1 y §8.3 ✅ RESUELTAS por D-058; RQ-04.14 cumplido. Actualizar la cabecera: ya no
  queda bloqueante vivo.
- `REQ-06`: estado a implementado. §8.2, §8.3 y §8.4 quedaron resueltas por construcción — dejar
  dicho **por qué**: el estado DISP se asienta una vez en su instante de inicio; un evento deshecho
  no existe en la tabla; y el libro refleja el estado final del lote (decisión H).
- `FORMATO-ASIENTOS-OPERACION.md`: cambiar el estado de 🟡 Propuesta a implementado por D-058, y
  anotar en §6.4 lo que sigue abierto para la sesión del segundo formato.

## 3. Cleanup del scaffolding (`git rm`)

> `prompts/D-058-asientos-operacion/` es **efímero**. Volcada la decisión a los docs permanentes, se
> borra. El historial de git lo conserva recuperable (`git show <commit>:<path>`); no se archivan
> copias ni zips.

```bash
git rm -r "prompts/D-058-asientos-operacion"
```

**Lo que NO se borra:** `scripts/derivar-plantilla-f03.mjs` y `server/assets/f03-plantilla.xlsx` son
**producto**, no andamiaje — el script queda para regenerar la plantilla si el formato controlado
cambia de versión.

## 4. Commit de cierre

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(repo): cerrar D-058 — asientos normalizados de operación + docs + cleanup

Motor único de plantillas, reflejo de Operación 24h a las bitácoras de Sala y libro
mensual F03 clonado de la plantilla real. Cierra el bloqueante de formato que
arrastraban REQ-02 §8.1, REQ-04 §8.1/§8.3 y REQ-06 §8.1.

ADR D-058 agregado a docs/decisions.md; convención nueva en CLAUDE.md; BIT-MODBD
actualizado con seleccionable, los tipos espejo y la marca de origen; REQ-02/04/06 y el
documento de formato puestos al día. Scaffolding eliminado.

Queda fuera y con su propio ADR pendiente: el reflejo de Disponibilidad a Sala
(crear/editar/deshacer con copia anulada). Sus tipos espejo ya están sembrados.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

## 5. Push / PR — REQUIERE CONFIRMACIÓN HUMANA

> No se ejecutan sin OK explícito del usuario (`01-convenciones.md`). Preguntá antes de:
> - `git push -u origin feat/asientos-operacion-2026-07`
> - Camino A: `git merge` a `main` · Camino B: `gh pr create`

**Recordatorio operativo:** D-056 y D-057 están en `origin/main` pero **todavía no desplegados a
producción**. D-058 se apoya en los dos; coordinar el despliegue de los tres juntos.

## 6. Actualizar ESTADO.md por última vez
- Marcá E10 ✅ con el resumen. El archivo se borra en el paso 3 junto con el resto del scaffolding;
  el resumen definitivo ya vive en el ADR `D-058`.
