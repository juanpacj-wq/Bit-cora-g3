# D-057 · E3 — Cobertura: criterios de aceptación + guards transversales

## Antes de empezar (obligatorio)

1. Leé `_CONTEXTO-BASE.md` completo y `ESTADO.md`.
2. **Verificá que E1 y E2 figuren ✅.** Esta etapa prueba los dos endpoints; no corre sobre una
   implementación parcial.
3. Releé "Decisiones / desviaciones acumuladas": si E1/E2 desviaron algo, los tests prueban **lo
   ejecutado**, no lo planeado (y la desviación ya debe estar registrada).

## Alcance de esta etapa

**Entra:** la matriz completa de los criterios de aceptación de REQ-04 §6 que caen dentro de este
flujo, más los dos guards transversales. Solo tests — **si un test revela un bug, se corrige en esta
misma etapa** y el commit lo dice.

**NO entra:** front (E4), docs (E5).

**Ubicación:** todo va en `server/tests/sala_de_mando_batch.test.js` (D-055: **todos los tests de
MAND van en ese archivo**; dos archivos sobre la misma fixture se dan 401 mutuo porque
`setupSessions()` mata las otras sesiones del mismo usuario). Sección `D-057 · E3`, sobre
`TEST_PLANTA` (`'TST'`) y tagueado con `TEST_TAG`.

## Tareas

### 1. Criterios de aceptación de REQ-04 §6

| # | Criterio | Cobertura en esta etapa |
|---|---|---|
| 1, 3, 4 | Un renglón por lote · solo hoy y la planta de la sesión · sin Disponibilidad | **Ya cubiertos por D-056** (tests `D-056 E5.*` del listado). Solo verificar que siguen verdes. |
| 2 | Formato de mensaje | **Fuera de alcance** (REQ-04 §8.1 bloqueado → D-058). Anotarlo así en un comentario, no dejarlo como hueco silencioso. |
| **5** | Lote creado por el Ing. de Operación, editado por el Jefe de Turno | **NUEVO.** Dos sesiones con cargos distintos (helpers ya las arman); crear con una, `PUT` con la otra → 200. Es la excepción a D-049 en su cara positiva. |
| **6** | En otra bitácora sigue prohibido editar lo ajeno | La cara negativa ya vive en `tests/registros_solo_autor.test.js` — **verificar que sigue verde** y dejar un comentario cruzado desde el test 5 para que nadie los desacople. |
| **7** | Se puede cambiar MW, hora, funcionario, descripción y el conjunto de periodos | **NUEVO.** Un `PUT` que cambia las cinco cosas a la vez; verificar en BD el valor nuevo, la `hora_llamada` nueva, el `funcionariocnd`, el `detalle`, y el conjunto exacto de periodos (uno agregado, uno quitado). |
| 8, 9 (copias) | Cascada a SALAJDT/SALAING | **Fuera de alcance** (REQ-02 no existe). Comentario explícito. |
| **9** (parte viva) | Borrar el lote lo saca del listado | **NUEVO.** `DELETE` → `GET /lotes` ya no lo trae. |
| **10** | Borrar el publicado hace retroceder el dashboard | Ampliar la prueba de humo de E2: tres lotes solapados con horas distintas, borrar el vigente dos veces seguidas y verificar la cadena completa de retroceso hasta el `DELETE` de la fila. |
| **11** | REDESP: cambiar el valor de un periodo pasado se rechaza; cambiar solo hora/descripción se permite | **NUEVO, es el riesgo §5.4.** Tres casos: (a) cambiar valor de periodo pasado → `400 periodo_bloqueado`; (b) **agregar** un periodo pasado → `400`; (c) **quitar** un periodo pasado → `400`; (d) cambiar solo hora + descripción dejando los periodos pasados idénticos → `200`. |
| **12** | Con el turno finalizado, corregir funciona | **NUEVO.** Reusar el patrón de `D-056 E3.8` (turno finalizado + cabecera CERRADA) y hacer `PUT` y `DELETE` → 200 los dos. |
| **13** | Cargo sin `puede_crear` en MAND: el endpoint rechaza | **NUEVO** (la parte de UI es E4). Sesión con un cargo solo-lectura → `PUT` y `DELETE` → 403, y **nada cambia en BD**. |
| **14** | Una corrección que falla a mitad no queda aplicada parcialmente | **NUEVO.** Un `PUT` con un error de validación tardío (p. ej. lock REDESP en el último periodo del body) → 400 y **cero** filas modificadas/creadas/borradas. Cubre la atomicidad sin necesidad de inyectar una falla de BD. |

### 2. Casos borde que no son criterios pero muerden

- **`lote_sin_celdas`**: `PUT` con `periodos: []` → `400 lote_sin_celdas`, el lote sigue intacto
  (decisión 6: vaciar ≠ borrar).
- **`409 lote_cerrado`**: correr `cerrarDiaMand` sobre la fixture y luego `PUT`/`DELETE` del lote
  archivado → 409 con `codigo:'lote_cerrado'`; y `404 lote_inexistente` con un GUID que no existe.
- **`fecha_evento` heredada** (decisión 9): tras agregar un periodo a un lote, **todas** sus filas
  comparten el mismo `fecha_evento` → el lote no se parte entre dos días Bogotá.
- **`turno_id` de la celda insertada** (D-055 (b)): un periodo de madrugada (1..6) agregado a un lote
  del día F queda atado al **T2 iniciado en F-1**, no al turno del instante de la corrección.
  Reusar el patrón de `D-056 E3.7`.
- **Auditoría (decisión 2)**: cambiar **solo la descripción** sella `modificado_por`/`modificado_en`
  en las celdas del lote; una celda cuyo valor **no** cambió y que no recibió metadata nueva no se
  toca.

### 3. Guards transversales

- **Guard de coherencia de lote, extendido a la corrección.** El guard `D-056 E3.9` verifica que todo
  `lote_id` escrito tenga UNA sola hora, funcionario y descripción. **Extenderlo para que corra
  también después de un `PUT`** — es exactamente el escenario que D-056 anticipó ("la red que va a
  hacer falta cuando D-057 introduzca la edición por lote"). **No lo borres ni lo reemplaces.**
- **Guard anti-destrucción**: `guard_no_prod_historico_destruction.test.js` ya corre en el script
  `test`; verificar que los `DELETE`/`UPDATE` nuevos de `mand.js` **pasan** su análisis estático (el
  acotador de fixture o la PK debe estar léxicamente junto al statement). Si falla, el problema está
  en el código de E1/E2, no en el guard.

## Verificación (antes de commitear)

- `cd server && npm test` — **todo verde** salvo lo ya documentado en `ESTADO.md`. Pegá la salida
  real (conteo de tests pass/fail) en el bloque de `ESTADO.md`.
- Confirmá que `zzz_session_leak_guard.test.js` (último del script) sigue verde: si esta etapa creó
  sesiones nuevas, cada `after()` debe llamar `deactivateSyntheticSessions()`.

## Actualizar ESTADO.md (obligatorio antes de cerrar)

- Marcá E3 ✅ + bloque con Archivos tocados / Verificación (salida real) / Desviaciones.
- En "Datos descubiertos": cualquier bug que los tests hayan revelado y cómo se corrigió.

## Commit

```bash
git add server/tests/ server/routes/mand.js prompts/D-057-correccion-lote-mand/ESTADO.md
git commit -m "$(cat <<'EOF'
test(MAND): cobertura de la corrección por lote — criterios REQ-04 y guards

<por qué: los dos riesgos de REQ-04 §5.4 (la excepción a D-049 y la edición del
conjunto de periodos) necesitan prueba explícita en las dos caras; el guard de
coherencia de lote de D-056 se extiende a la edición, que es para lo que existía>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```
