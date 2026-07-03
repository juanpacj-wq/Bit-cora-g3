# D-040 · E3 — Frontend: fuente de verdad backend + revertir + gate de UI (solo genéricas)

> Etapa self-contained. Depende de **E2 ✅**. Objetivo: eliminar el estado `localStorage`,
> derivar del backend, añadir la acción revertir y gatear la creación **solo en bitácoras
> genéricas**.

## Antes de empezar (obligatorio)
1. Leé `_CONTEXTO-BASE.md` y `ESTADO.md`.
2. **Verificá que E1 y E2 figuren ✅.** Si no, detenete.
3. Releé "Decisiones/desviaciones" y "Datos descubiertos" (el shape real que devuelven
   `/finalizar` y `/revertir-turno`, y `/api/me`).

## Alcance de esta etapa
Solo front. El estado de finalización se lee del backend (`sesion.turno_finalizado_en`), el
botón togglea a "Revertir" y se gatea la creación **únicamente en la grilla genérica**.
MAND/DISP/COMB siguen editables (alineado con el backend de E2).

## Tareas

1. **`src/hooks/useAuth.js` — mutador `patchSesion`:** exponer
   ```js
   const patchSesion = useCallback((patch) => {
     setSesion((prev) => {
       const next = prev ? { ...prev, ...patch } : prev;
       sesionRef.current = next; persistAuth(userRef.current, next);
       return next;
     });
   }, []);
   ```
   Agregalo al `return` del hook. Reusa el patrón `sesionRef`/`persistAuth` existente.

2. **`src/hooks/useBitacoraSesion.js`:** junto a `useFinalizarTurno` (`~:16-27`), agregá
   `useRevertirTurno` simétrico (`api.post('/api/bitacora/revertir-turno')`). Podés hacerlo un
   solo hook con `{ finalizar, revertir, loading }`. **`useBitacoraSesion` (el `/abrir` en cada
   bitácora, `~:7-12`) queda IGUAL** — ya es inofensivo para la finalización tras E2.

3. **`src/BitacorasGecelca3.jsx`:**
   - **BORRAR** `shiftInstanceId` (`~:130-135`) y toda la lógica `finKey`/`finShift`/`useEffect`
     de re-lectura/tick de 1 min ligada a la finalización (`~:1694-1704`). Si el tick sólo
     servía a esto, eliminalo; si otra cosa lo usa, dejá el tick pero quitá la parte de
     finalización.
   - **Derivar:** `const turnoFinalizado = sesion?.turno_finalizado_en != null;`
   - **`handleFinalizarTurno` (`~:2035-2053`):** tras `finalizarTurno()`,
     `patchSesion({ turno_finalizado_en: r.turno_finalizado_en })` en vez de
     `localStorage.setItem`.
   - **Nuevo `handleRevertirTurno`:** modal de confirmación → `revertirTurno()` →
     `patchSesion({ turno_finalizado_en: null })` → toast.
   - **Botón header (`~:1205-1216`):** cuando `turnoFinalizado`, renderizá un botón
     **"Revertir finalización"** (llama `handleRevertirTurno`) en lugar del deshabilitado
     "Turno finalizado". Añadí un **banner** cuando `turnoFinalizado`: "Finalizaste tu turno;
     el registro en bitácoras está bloqueado. Revierte para volver a registrar." (tuteo
     colombiano, sin voseo).
   - **GATE DE UI acotado a genéricas (decisión del usuario):** **NO** cambies el `puedeCrear`
     global (`~:1748`) — eso pegaría a MAND/DISP/COMB. En su lugar, aplicá `&& !turnoFinalizado`
     **solo** en:
     - el botón "Nuevo Registro" del header genérico (`~:1192`), y
     - el prop `puedeCrear` que recibe `GrillaRegistros`.
     MAND (`SalaDeMandoGrid`), DISP y COMB (`ConsumosGrid`) siguen recibiendo el `puedeCrear`
     crudo (sin restar `turnoFinalizado`).
   - **`handleLogoutConfirm` (`~:2079`) y `handleCambiarUnidad`:** siguen llamando
     `finalizarTurno()` best-effort; sin cambios funcionales (el estado se descarta al salir).

## Verificación (antes de commitear)
- `npm run build` sin errores (un build roto bloquea el commit).
- Smoke manual (o skill `verify`):
  - Finalizar → grilla **genérica** bloqueada + botón "Revertir" + banner, **mientras MAND /
    DISP / COMB siguen editables**.
  - **F5** → el estado se mantiene (rehidrata vía `/api/me`), no depende de `localStorage`.
  - Revertir → desbloquea la grilla genérica.
  - Abrir/cambiar de bitácora (solo ver) **no** altera el estado de finalización.

## Actualizar ESTADO.md (obligatorio antes de cerrar)
- Marcá E3 ✅ + bloque `### E3 ...  ✅` con Archivos tocados / Verificación (build + smoke) /
  Desviaciones. Anotá en "Datos descubiertos" si el tick de 1 min se conservó o se eliminó.

## Commit (1 por etapa)
```bash
git add src/hooks/useAuth.js src/hooks/useBitacoraSesion.js src/BitacorasGecelca3.jsx \
        "prompts/D-040-finalizar-turno-revertible/ESTADO.md"
git commit -m "$(cat <<'EOF'
feat(front): D-040 E3 — turno finalizado desde backend + revertir + gate genérico

Elimina el estado localStorage/shiftInstanceId (divergía del backend); turnoFinalizado
se deriva de sesion.turno_finalizado_en y sobrevive F5 vía /api/me. Botón header togglea
a "Revertir finalización" + banner. El bloqueo de creación se acota a la grilla genérica
(Nuevo Registro + GrillaRegistros); MAND/DISP/COMB quedan operables, alineado con el
write-gate del backend.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

> No hagas `push`/`merge`/`PR` en etapas intermedias.
