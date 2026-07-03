# D-040 · E4 — Docs + ADR + cleanup + cierre

> **Última etapa** (siempre). Vuelca la decisión a los docs permanentes, borra el scaffolding
> efímero y deja el branch mergeable. El "breve .md de cambios" se materializa acá = el ADR
> `D-040`. Depende de **E1, E2 y E3 ✅**.

## Antes de empezar (obligatorio)
1. Leé `_CONTEXTO-BASE.md` y `ESTADO.md`.
2. **Verificá que E1, E2 y E3 figuren ✅.** Si alguna no lo está, detenete: el cierre no corre
   sobre una implementación incompleta.

## 1. Smoke completo
- `npm run build` (front) verde.
- `cd server && node --test --env-file=../.env tests/` con el baseline esperado (documentá el
  resultado exacto en `ESTADO.md`; ver baseline conocido en `_CONTEXTO-BASE.md`).
- Checklist de smoke UI manual para el autor (Claude no lo automatiza sin Playwright):
  1. Login Entra → seleccionar unidad.
  2. Finalizar turno → grilla genérica bloqueada + banner + botón "Revertir".
  3. Navegar entre bitácoras (solo ver) → sigue finalizado (no reaparece como pendiente).
  4. MAND/DISP/COMB siguen editables estando finalizado.
  5. F5 → estado persiste.
  6. Revertir → grilla genérica desbloqueada.
  7. Con otro usuario JdT: Cerrar Masivo → el modal ya no lista al que finalizó; "Cerrar de
     todas formas" fuerza a los pendientes.

## 2. Documentación permanente
- **ADR `D-040` en `docs/decisions.md`** (formato fijo Contexto / Decisión / Consecuencias,
  4–8 líneas). Puntos a capturar:
  - Contexto: `sesion_bitacora.finalizada_en` sobrecargada (presencia + finalización);
    `/abrir` la reseteaba → ver una bitácora des-finalizaba el turno.
  - Decisión: finalización de turno = **`sesion_activa.turno_finalizado_en`** (fuente única,
    revertible self-service vía `POST /api/bitacora/revertir-turno`); `sesion_bitacora` vuelve
    a ser SOLO presencia; write-gate 409 `turno_finalizado` **solo en bitácoras genéricas**;
    cierre del JdT sigue "avisar y forzar"; front deriva del backend (sin `localStorage`).
  - Consecuencias: estado muere solo vía sweeper (`activa=0`) + D-035 (sesión única); revertir
    tras ser forzado es posible y NO traba el cierre del JdT (opera sobre `registro_activo`);
    MAND/DISP/COMB no se bloquean. Cross-ref `[[D-031]]`, `[[D-035]]`, `[[D-032]]`, `[[D-037]]`,
    `[[D-030]]`.
- **`Bit-cora-g3/CLAUDE.md`** — agregá a "Convenciones críticas (no obvias)" una entrada:
  finalización de turno = `sesion_activa.turno_finalizado_en`; `sesion_bitacora.finalizada_en`
  = presencia por-bitácora; **nunca reusar uno por el otro**. 1–3 frases + link al ADR D-040.
  Mantené el archivo dentro de su límite (~250 líneas).
- **`BIT-MODBD-2026-001.md`** — §3 `sesion_activa`: agregá `turno_finalizado_en` (+ `_bogota`);
  §4.6/§4.7: aclarar que `sesion_bitacora.finalizada_en` es SOLO presencia, no finalización de
  turno. Bumpeá versión + changelog del doc.
- **`BIT-RF-2026-001.md`** — RF nuevo: finalizar/revertir turno + inhibición de registro en
  bitácoras genéricas. Bumpeá versión + changelog.

## 3. Cleanup del scaffolding (git rm)
Tras volcar todo a los docs permanentes:
```bash
git rm -r "prompts/D-040-finalizar-turno-revertible"
```

## 4. Commit de cierre
```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(repo): cerrar D-040 — finalizar turno revertible + docs + cleanup de scaffolding

Vuelca el ADR D-040 a docs/decisions.md, actualiza CLAUDE.md / BIT-MODBD / BIT-RF y
elimina el scaffolding efímero prompts/D-040-*. Implementación en E1-E3.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

## 5. Push / PR — REQUIERE CONFIRMACIÓN HUMANA
No ejecutar sin OK explícito del usuario. Preguntá antes de:
- `git push -u origin feat/D-040-finalizar-turno-revertible`.
- `git merge` a `main` **o** `gh pr create` / abrir PR.

## 6. Actualizar ESTADO.md por última vez
- Marcá E4 ✅ con el resumen **antes** del `git rm` del paso 3 (el archivo se borra con el
  resto del scaffolding; el resumen final ya vive en el ADR D-040).
