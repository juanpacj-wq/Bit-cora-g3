# D-061 · Ola O3 · Lote L07 — Docs + cleanup: BIT-MODBD 2.5, BIT-RF 1.9, architecture, glosario, DEPLOY, `git rm` del scraper standalone y de `prompts/D-029`

> **Un lote = un chat.** Este archivo tiene que bastar, junto con las secciones de
> `_CONTEXTO-BASE.md` que cita y los `GATE-O1.md`/`GATE-O2.md`, para ejecutarlo completo.
> Fecha de redacción: 2026-08-26. Escrito por el integrador en la fase 2; enmendado (solo en
> cabecera) por el gate de la O2 si hizo falta.

## ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto
- {{El gate O2 rellena esto. Si está vacío, lee `GATE-O1.md` §6 y `GATE-O2.md` §6.}}

## 0. Puerta de arranque (obligatorio, primero)
```bash
node "../metodología de implementación/herramientas/lotes.mjs" --impl D-061 claim L07 --sesion L07-HHMM
export LOTE_SESION=L07-HHMM
```
Si falla, **detente y reporta**.

## 1. Lee, en este orden y solo esto
1. `_CONTEXTO-BASE.md` §1, §5 completo, §6 completo, §7 (versiones y RF reservados), §9.
2. `GATE-O1.md` y `GATE-O2.md` completos (§5 decisiones, §6 hechos, §7 hallazgos) y los seis
   `cierres/L01..L06.md` (sobre todo `### Aporte al ADR`, `Desviaciones`, la fecha de inicio de
   GEC32 y los conteos del backfill en L05, y el registro de la corrida prod en `GATE-O2.md`/`ESTADO.md`).
3. Tu territorio: `BIT-MODBD-2026-001.md` §4.9 y §4.9.1 (`:1046-1140`) y su changelog final;
   `BIT-RF-2026-001.md` §4.9 (COMB) y §10 (historial); `docs/architecture.md` (busca dónde van
   sweepers/utils; hoy **no menciona el SIS**); `docs/domain-glossary.md`; `deploy/DEPLOY.md`.
4. Solo lectura, para documentar lo real (no el plan): `server/routes/combustibles.js`,
   `server/utils/sis/*.js`, `server/scripts/backfill-carbon-gec32.js`, `src/components/Combustibles/override.js`.
5. `CLAUDE.md` del subrepo (solo para NO duplicar: la convención 35 y el ADR los escribe el cierre).

## 2. Territorio — lo único que puedes crear o editar
- `BIT-MODBD-2026-001.md`
- `BIT-RF-2026-001.md`
- `docs/architecture.md`
- `docs/domain-glossary.md`
- `deploy/DEPLOY.md`
- `js-scraper-carbon-g32/**` (solo `git rm -r` + borrar los 3 archivos no versionados: `xlsx-write.js`, `echo-worker.mjs`, `hang-worker.mjs`)
- `prompts/D-029-sis-carbon-gec32/**` (solo `git rm -r`)
- `prompts/D-061-sis-carbon-cierre/cierres/L07.md`

**NO tocas** `docs/decisions.md` ni `CLAUDE.md` (cierre), ningún código, `package.json`,
`ESTADO.md`, `prompts/D-061-*` salvo tu cierre. Si documentar revela un bug o una incoherencia
código↔docs, es un **hallazgo** para el gate, no una corrección tuya.

## 3. Contrato
- **Consumes** todos los contratos de `_CONTEXTO-BASE.md §6` tal como quedaron **verificados en
  los gates** (si un gate los enmendó, documenta la versión enmendada).
- **Produces**: versiones **BIT-MODBD 2.5** y **BIT-RF 1.9** (reservadas en §7), **RF-071**.

## 4. Trabajo
**Qué se sabe:** BIT-MODBD §4.9.1 (D-060) ya describe `valor_sis`, `sis_scrape_log`, ownership y
la semántica `completo`; falta: override (incluido el 0), revertir, scrape manual/job/lock,
concurrencia, backfill histórico (fecha de inicio real, conteos por año en dev y prod), catálogo
`'TST'`, `es_override`/`sis_owned` del GET. BIT-RF va por RF-070 (D-056) y 1.8. `architecture.md`
no menciona el SIS. `deploy/DEPLOY.md` tiene secciones numeradas (§7 = CA corporativa); el runbook
de backfill en prod va como sección nueva. El scraper standalone está parcialmente versionado
(`package.json`, `scrape.js`, `xls.js`) y tiene 3 sueltos.

1. **BIT-MODBD 2.5**: amplía §4.9.1 (tabla de ownership completa con la fila "override 0", tabla
   de decisión de revertir, `sis-lock`, job manual, `concurrencia`, `discover` v2 y la fecha de
   inicio real, catálogo `'TST'` como fixture) + fila **2.5** en el changelog (orden de versión,
   fecha del gate O2). No reescribas el histórico.
2. **BIT-RF 1.9**: en §4.9 (COMB) agrega **RF-071** (ingesta SIS: ownership "operador gana",
   override visible y revertir, vaciar = override 0, scrape manual asíncrono gated por
   `puede_crear`, backfill resumible; GEC3 fuera) + fila **1.9** en §10. Cross-ref a BIT-MODBD
   §4.9.1 y a D-061.
3. **`docs/architecture.md`**: sección "Ingesta SIS de carbón GEC32" (módulos de
   `server/utils/sis/`, sweeper HH:02, job manual, CLI, front `override.js`) en el lugar donde
   viven los sweepers/utils.
4. **`docs/domain-glossary.md`**: entradas `SIS`, `SIS-owned / humano-owned`, `override (COMB)`,
   `valor_sis`, `sis_scrape_log`.
5. **`deploy/DEPLOY.md`**: sección "Backfill del carbón GEC32 en prod" con el comando exacto que
   corrió el integrador (de `GATE-O2.md`), el guardrail `--confirm-db`, `--to ≤ hoy-2`, cómo
   reanudar y cómo verificar (conteos por año, `sis_scrape_log` incompletos).
6. **Cleanup**: `git rm -r js-scraper-carbon-g32 prompts/D-029-sis-carbon-gec32`; borra los 3
   sueltos; `git grep -n "js-scraper-carbon-g32"` debe quedar vacío fuera de `docs/decisions.md`
   (si aparece en código o tests, es un hallazgo: no lo edites).
7. Tuteo colombiano en todo texto nuevo.

## 5. Criterios de aceptación y sus verificadores
| CA | Criterio | Verificador (tuyo) |
|---|---|---|
| CA-29 | BIT-MODBD 2.5 (§4.9.1 ampliada + changelog) y BIT-RF 1.9 (RF-071 + changelog). | `grep -n "^| 2.5\|^| \*\*1.9\|RF-071" BIT-*.md` + lectura del gate |
| CA-30 | `architecture.md`, `domain-glossary.md` con SIS; `DEPLOY.md` con el runbook del backfill prod. | `grep -n -i "sis" docs/architecture.md docs/domain-glossary.md deploy/DEPLOY.md` |
| CA-31 | `git rm` del scraper standalone y de `prompts/D-029-*` + sueltos borrados; sin referencias fuera de `decisions.md`. | `git status --short js-scraper-carbon-g32 prompts/D-029-sis-carbon-gec32` (todo `D`) + `git grep js-scraper-carbon-g32` |

## 6. Verificación que corres (solo la tuya)
```bash
git grep -n "js-scraper-carbon-g32" -- . ':!docs/decisions.md' ':!prompts/D-061-sis-carbon-cierre'
ls js-scraper-carbon-g32 2>/dev/null || echo "carpeta retirada"
```
Sin tests ni backend. **No corras `npm test`**.

## 7. Cierre (obligatorio, en este orden)
1. `prompts/D-061-sis-carbon-cierre/cierres/L07.md` (plantilla `CIERRE-LOTE.md`, con
   `### Aporte al ADR`: qué quedó documentado y dónde).
2. Commit solo tus rutas (el `git rm` ya deja el índice listo para esas rutas):
   ```bash
   git commit -m "$(cat <<'EOF'
   docs(D-061 L07): ingesta SIS de carbón GEC32 en BIT-MODBD 2.5, BIT-RF 1.9, architecture y glosario; retiro del scraper standalone y del scaffolding D-029

   <por qué>
   EOF
   )" -- BIT-MODBD-2026-001.md BIT-RF-2026-001.md docs/architecture.md docs/domain-glossary.md deploy/DEPLOY.md js-scraper-carbon-g32 prompts/D-029-sis-carbon-gec32 prompts/D-061-sis-carbon-cierre/cierres/L07.md
   ```
3. `lotes.mjs --impl D-061 done L07 --sesion <tu sesión>`
4. Mensaje final con la forma fija (`L07 cerrado.` …).

## Reglas (no negociables)
- `git commit -- <rutas>` siempre; nunca `git add -A`/`.`; nada de stash, reset, checkout,
  restore, switch, rebase, amend, push, merge.
- Documenta lo real (código + gates), no el plan; una discrepancia es un hallazgo.
- No inventes cifras: conteos, fechas y SHA salen de los cierres y gates.
- No te asciendas solo.
- Tuteo colombiano estándar; sin voseo.
