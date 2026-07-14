# D-053 · E4 — Docs + ADR + cleanup + cierre

> Última etapa. Vuelca la decisión a los docs permanentes, borra el scaffolding efímero y deja el
> branch mergeable. El "breve .md de cambios" se materializa = el ADR `D-053`.

## Antes de empezar (obligatorio)
1. Leé `_CONTEXTO-BASE.md` y `ESTADO.md`.
2. **Verificá que E1, E2 y E3 figuren ✅.** Si alguna no lo está, detenete: el cierre no corre sobre una
   implementación incompleta.

## 1. Smoke completo

- `npm run build` (front) verde.
- `cd server && npm test` verde. Documentá el resultado exacto.
- **Smoke UI manual** (Claude no lo automatiza; verificalo vos en el navegador):
  - [ ] Entrar como **JdT**: ve las 3 bitácoras de Sala; **solo** SALAJDT le deja crear. En SALAING y
        SALAOP no aparecen lápiz ni basurero (solo el ojo de lectura).
  - [ ] Entrar como **Ingeniero de Operación**: **solo** SALAING le deja crear.
  - [ ] Entrar como **Operador de Sala de Mando**: ve **solo** SALAOP de las tres (ni SALAJDT ni
        SALAING deben aparecer en el sidebar).
  - [ ] Los registros históricos de Sala siguen visibles en Históricos, bajo la bitácora que les
        corresponde.
  - [ ] Deep link viejo `#/b/SALA` aterriza en SALAJDT (no en otra bitácora al azar).
  - [ ] JdT e IngOp siguen pudiendo crear en **Disponibilidad** (regresión del `IN` partido).
  - [ ] "Mejorar con IA" funciona en las tres y el texto suena al rol correcto.

## 2. Documentación permanente

- **ADR `D-053` en `docs/decisions.md`** — formato fijo (Contexto / Decisión / Consecuencias). Debe
  dejar constancia de:
  - **Contexto**: SALA era la única bitácora del catálogo con `puede_crear` compartido por varios
    cargos; mezclaba tres responsabilidades e impedía leer el histórico por rol.
  - **Decisión**: split en SALAJDT/SALAING/SALAOP. SALA se **renombra** a SALAJDT conservando
    `bitacora_id=14` y `orden=3` (el rename va como `UPDATE` **previo** al `MERGE`, patrón
    `db.js:760-761`; hacerlo dentro del MERGE insertaría una fila y dejaría SALA huérfana). Todo
    data-driven por la matriz; ningún endpoint cambia.
  - **Consecuencia (a) — invariante roto a propósito**: **JdT e IngOp dejan de tener filas idénticas**
    en la matriz. Era un invariante afirmado por `db.js:904-905` y el glosario. Cross-ref `[[D-039]]`
    (el admin sigue cubriendo las tres por su `WHEN` de acceso total, sin bypass) y `[[D-049]]` (la
    edición sigue siendo exclusiva del autor).
  - **Consecuencia (b) — excepción explícita a RF-032**: `F30.A1` hace `UPDATE` sobre
    `registro_historico` (append-only por convención organizativa, sin trigger —
    `BIT-RF-2026-001.md:352`). Se acepta como one-shot transaccional con
    `bitacora.registro_historico_backup_D053` como rastro. **Esa tabla es residente: no la borres.**
  - **Consecuencia (c) — atribución por evidencia, nunca por adivinanza**: el cargo no se persiste
    (viene del App Role de Entra por login). Escalera `turno_participante`/`conformacion_turno` por
    `turno_id` → `sesion_activa` con cargo único → **lo no atribuible no se toca** y se reporta.
  - **Consecuencia (d) — gotcha permanente**: no hay FK ni CHECK que ate `registro.bitacora_id` ↔
    `tipo_evento.bitacora_id` y ninguna lectura lo verifica → **toda migración que mueva `bitacora_id`
    debe remapear `tipo_evento_id` en el mismo statement**. Fijado por
    `guard_tipo_evento_coherente.test.js`.
  - **Consecuencia (e)**: `'AUTH'` retirado del `IN` de `puede_crear` (código muerto: `activa=0` y la
    matriz filtra `activa=1`).
  - **Consecuencia (f)**: `registros_solo_autor` test 2 reescrito con ADMIN como no-autor; SALA era el
    único fixture con `puede_crear` compartido y su desaparición habría dejado un falso verde.

- **`CLAUDE.md`** — el archivo ya supera su límite de ~250 líneas, así que **sé quirúrgico**:
  - Actualizá la **convención 24 (D-049)** si hace falta y agregá una entrada corta (1–3 frases) para
    D-053 con el link al ADR. Lo que **no puede faltar** por ser gotcha que muerde:
    (i) el rename de `codigo` va **antes** del MERGE, nunca dentro;
    (ii) JdT e IngOp **ya no** tienen filas idénticas en la matriz;
    (iii) mover `bitacora_id` **exige** remapear `tipo_evento_id`.
  - **Corregí la estructura**: CLAUDE.md lista `src/components/GrillaRegistros.jsx`, que **no existe** —
    `GrillaRegistros` vive inline en `src/BitacorasGecelca3.jsx:1281`. (Hallazgo de la planeación,
    ortogonal a D-053 pero barato de arreglar acá.)

- **`BIT-MODBD-2026-001.md`** — tocó BD:
  - §2.6 (matriz de permisos): reflejar el split y la ruptura de la simetría JdT/IngOp.
  - §2.4 (`lov_bit.bitacora`): el catálogo real.
  - Documentar `bitacora.registro_historico_backup_D053` y la migración `F30.A1`.
  - **Bumpear la versión del doc** y agregar entrada en su changelog. El changelog histórico no se
    reescribe, solo se agrega.
  - Nota: los seeds de §2.2/§2.6 están **desactualizados desde antes** (describen 4 cargos y un catálogo
    v1 muerto `SINC/CAL/TURB/ELEC/IC/MA`). Si lo arreglás, decilo en el changelog; si no, no lo empeores.

- **`BIT-RF-2026-001.md`** — RF-022/RF-023 (permisos por bitácora) y **RF-032** (inmutabilidad del
  histórico: dejar registrada la excepción D-053). Bumpear versión + changelog.

- **`docs/domain-glossary.md`** — hoy afirma que JdT e IngOp tienen "mismos permisos que el JdT (filas
  idénticas en la matriz)". Corregir.

## 3. Cleanup del scaffolding

```bash
git rm -r "prompts/D-053-split-sala-por-rol"
```

> El historial lo conserva recuperable (`git show <commit>:<path>`). No archives copias ni zips.
> **No borres** `sql/snippets/reporte-split-sala-D053.sql` ni la tabla de respaldo: son permanentes.

## 4. Commit de cierre

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(repo): cerrar D-053 — split de SALA por rol + docs + cleanup

ADR D-053 en docs/decisions.md. SALA queda partida en SALAJDT/SALAING/SALAOP, con
cada rol escribiendo solo en la suya y los registros existentes repartidos por el
cargo del autor mediante la migración F30.A1.

Docs: BIT-MODBD (§2.4/§2.6 + F30.A1 + tabla de respaldo), BIT-RF (RF-022/023 y la
excepción explícita a RF-032), CLAUDE.md y el glosario — estos dos últimos afirmaban
que JdT e IngOp tienen filas idénticas en la matriz, lo que este ADR deja de ser
cierto. Corregida también la ruta de GrillaRegistros en CLAUDE.md: vive inline en
BitacorasGecelca3.jsx, no en components/.

Scaffolding efímero eliminado; recuperable por git show.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

## 5. Despliegue a prod — REQUIERE CONFIRMACIÓN HUMANA

> Ninguna de estas acciones se ejecuta sin OK explícito del usuario (`01-convenciones.md`).

Preguntá antes de: `git push -u origin feat/split-sala-por-rol-2026-07`, `git merge` a `main` o
`gh pr create`.

**Orden obligatorio del despliegue** (el reporte va ANTES del deploy, no después):

1. **Reporte pre-flight contra prod**, en SSMS: `sql/snippets/reporte-split-sala-D053.sql`. Es solo
   lectura. Leé el conteo de **registros no atribuibles**:
   - Si es **0** → la migración es 100% automática, seguí.
   - Si es **> 0** → esos registros se quedarían en SALAJDT. Decidí con el usuario si es aceptable o si
     hay que triagearlos a mano **antes** de desplegar. No improvises en el momento.
2. **Desplegar** y reiniciar el backend. `initDB` aplica en un solo arranque y una sola vez: el rename,
   el catálogo, la matriz y `F30.A1`.
3. **Verificación post-migración contra prod** (las mismas queries de E2):
   - `SELECT codigo FROM bitacora.migracion_aplicada WHERE codigo='F30.A1'` → 1 fila.
   - Drift `tipo_evento_id` ↔ `bitacora_id` → **0 filas** en ambas tablas.
   - Reparto por bitácora destino → coincide con lo que predijo el reporte del paso 1.
   - `registro_historico_backup_D053` poblado con las filas esperadas.
   - Log del arranque: `[F30.A1]` con los conteos movidos y no atribuidos (guardalo, es evidencia de
     auditoría).
4. Si algo sale mal: la tabla de respaldo permite reconstruir el estado previo. `F30.A1` es
   transaccional — un fallo hace rollback y reintenta en el próximo arranque; **no deja estado a medias**.

## 6. Actualizar ESTADO.md por última vez
- Marcá E4 ✅ con el resumen. (El archivo se borra en el paso 3; el resumen final ya vive en el ADR.)
