# Runbook — Prueba manual del umbral de cierre de turno (D-046)

Verifica que, al llegar el umbral de fin de turno (06:00 / 18:00 Bogotá), **todos** los usuarios de la
unidad quedan bloqueados de verdad — no solo tapados por el modal — y que el auto-cierre por gracia
funciona. Como el umbral real solo ocurre 2 veces al día, esta prueba **adelanta `fin_nominal`** con un
script SQL para disparar el flujo real a cualquier hora.

## Qué se está probando (D-046)

- Durante la **gavela de gracia** (turno cruzó `fin_nominal`, aún ABIERTO): el backend rechaza toda
  escritura en bitácoras genéricas con **409 `turno_en_transicion`**, y la grilla queda en solo-lectura
  para todos. Antes esto solo lo tapaba el modal del front (evadible). MAND/DISP/COMB quedan exentos.
- El **auto-cierre** por incomparecencia de la decisión (`AUTO_SIN_RESPUESTA`) tras 60 min de gracia con
  personal presente, y el cierre inmediato `AUTO_SIN_PERSONAL` sin personal.

## Requisitos

- Acceso a la BD (SSMS / Azure Data Studio) para correr `sql/snippets/simular-umbral-turno-D046.sql`.
- Backend desplegado y el **turno-sweeper** corriendo (tick c/60s, scope `['GEC3','GEC32']`).
- 2+ usuarios reales logueados en la **misma unidad** (idealmente un Jefe de Turno + un operador).
- Ventana **coordinada**: el script muta el turno real de GEC3/GEC32. Avisar a la unidad.

> El script **no borra nada** (solo mueve `fin_nominal`) y es **reversible** con Extender/Reabrir.

---

## Parte A — Bloqueo durante la gracia (todos bloqueados)

1. En el script, dejar `@planta` en la unidad de prueba y `@modo = 'BLOQUEO'`. Ejecutar. Revisar el
   SELECT ANTES/DESPUÉS: `fin_nominal` queda en "ahora".
2. Esperar ≤60s (un tick del sweeper). En cada navegador logueado en esa unidad debe:
   - Aparecer el **modal de transición** (`TurnoTransicionModal`) para **todos** — con botones
     Cerrar/Extender solo para quien puede decidir (JdT), aviso pasivo para el resto.
   - La grilla por debajo queda **read-only** (chip "Bloqueado", sin Editar/Eliminar).
3. **Verificación dura (anti-evasión):** intentar escribir saltando el modal. Con la cookie de sesión,
   hacer un `POST /api/registros` (por consola del navegador / cliente HTTP) a una bitácora genérica de
   esa unidad. Debe responder **409** con `codigo: "turno_en_transicion"`. Igual `PUT`/`DELETE` sobre un
   borrador existente. **Esto es lo que antes se colaba.**
4. **Desbloqueo:** el JdT pulsa **Extender** en el modal (o `POST /api/turno/extender`). El modal
   desaparece para todos, la grilla vuelve a editable, y un `POST` vuelve a responder 201. `fin_nominal`
   quedó en el próximo umbral.

## Parte B — Auto-cierre sin respuesta

1. Con ≥1 usuario logueado (personal presente), correr el script con `@modo = 'AUTOCIERRE'`
   (`fin_nominal = ahora − 61 min`, ≥ gracia de 60).
2. Esperar ≤60s. El sweeper debe **auto-cerrar** el turno (`motivo = AUTO_SIN_RESPUESTA`): en el front el
   modal se reemplaza por el banner/badge **"Turno cerrado"**, la grilla queda read-only, y un `POST`
   ahora responde **409 `turno_cerrado`** (código distinto al de la gracia). Los registros en borrador del
   turno pasaron a histórico; se activó el sucesor si existía.
3. **Restaurar:** `POST /api/turno/reabrir` (botón "Reabrir Turno" del JdT) devuelve el turno a ABIERTO y
   restaura `fin_nominal` al fin de la ventana.

## Parte C (opcional) — Cierre sin personal

Cerrar todas las sesiones de la unidad (logout de todos) y correr `@modo = 'BLOQUEO'`. Sin personal, el
sweeper cierra de inmediato con `motivo = AUTO_SIN_PERSONAL` (sin esperar la gracia). Restaurar con
`reabrir`.

---

## Checklist de aceptación

- [ ] Modal de transición visible para **todos** los usuarios de la unidad al cruzar el umbral.
- [ ] Grilla en solo-lectura durante la gracia (no solo el overlay del modal).
- [ ] `POST/PUT/DELETE` a `/api/registros` en la gracia → **409 `turno_en_transicion`**.
- [ ] **Extender** desbloquea a todos; el `POST` vuelve a 201.
- [ ] Auto-cierre `AUTO_SIN_RESPUESTA` tras el modo AUTOCIERRE; luego `POST` → **409 `turno_cerrado`**.
- [ ] `reabrir` restaura el turno a ABIERTO.
- [ ] MAND/DISP/COMB siguen operables durante la gracia (exentos por diseño).

Ver también: D-046 en `docs/decisions.md`, `sql/snippets/simular-umbral-turno-D046.sql`, y el guardrail
`server/tests/guard_simular_umbral_no_auto_ejecutable.test.js`.
