# D-057 · E5 — Docs + ADR D-057 + cleanup + cierre

> Última etapa. Vuelca la decisión a los docs permanentes, borra el scaffolding efímero y deja el
> branch mergeable.

## Antes de empezar (obligatorio)

1. Leé `_CONTEXTO-BASE.md` y `ESTADO.md` completos.
2. **Verificá que E1..E4 figuren ✅.** El cierre no corre sobre una implementación incompleta.

## 1. Smoke completo

- `npm run build` (raíz) verde.
- `cd server && npm test` con el baseline esperado — **documentá la salida exacta** en `ESTADO.md`.
- Checklist de smoke UI manual del E4, ejecutado por el autor de punta a punta.

## 2. Documentación permanente

### 2.1 ADR `D-057` en `docs/decisions.md`

Formato fijo (Contexto / Decisión / Consecuencias). Debe dejar dicho, sin rodeos:

- **Contexto:** D-056 dejó la grilla append-only **sin forma de corregir** — un error de digitación
  solo se podía tapar registrando encima con hora posterior, y seguía publicado al dashboard. Es la
  consecuencia (b) de D-056, ahora cerrada.
- **Decisión (1) — el diff quirúrgico.** `PUT` conserva `lote_id`, `registro_id`, `creado_por` y
  `creado_en` de las celdas que sobreviven; `UPDATE` las que cambian, `DELETE` las que se quitan,
  `INSERT` las que se agregan. **Por qué no DELETE+INSERT del lote entero:** dejaría huérfano
  `evento_dashboard.registro_origen_id`, que **no tiene FK posible** (el origen migra entre
  `registro_activo` y `registro_historico`, [[D-055]] (c)) — las mismas 35 filas reales de prod.
- **Decisión (2) — corrige el enunciado de REQ-04 §5.3.** La excepción a [[D-049]] **no vive en
  `canEditarRegistro`**: MAND nunca pasa por ese helper (D-049 lo excluye explícitamente). Vive en
  que el gate del `PUT`/`DELETE` es **`puede_crear` en MAND** (matriz data-driven, colaborativo por
  diseño), no `creado_por`. `permissions.js` **no se tocó**, y el test de regresión prueba las dos
  caras: un no-autor **sí** corrige en MAND, **no** en una bitácora genérica.
- **Decisión (3) — auditoría: se levanta [[D-019]] en la corrección.** Cualquier cambio (valor, hora,
  funcionario o descripción) sella `modificado_por`/`modificado_en` en las celdas afectadas. D-019
  sigue vigente **solo en la captura**: acá corregir es deliberado, y **la hora decide qué se publica**.
- **Decisión (4) — el lock de REDESP actúa sobre el DELTA.** Rebota si un periodo pasado cambia de
  valor, se agrega o se quita (quitarlo retira el publicado = cambio de valor); deja pasar hora,
  funcionario, descripción y los periodos pasados idénticos. **Y no aplica al `DELETE` del lote
  completo**: borrar es corregir un registro errado, no reescribir un valor pasado — si aplicara, un
  redespacho mal digitado quedaría publicado para siempre.
- **Decisión (5) — `fecha_evento` se HEREDA en las celdas insertadas.** Todas las celdas de un lote
  comparten `fecha_evento` para que el lote **no se parta entre dos días Bogotá** (un lote de las
  23:58 corregido a las 00:02). La fila insertada queda con un `fecha_evento` anterior a su `INSERT`
  y **es correcto**: `fecha_evento` identifica el **día del lote**, no el instante de escritura — esa
  atribución vive en `modificado_por`/`modificado_en`. El `turno_id` sigue saliendo de
  `fechaOperativaDePeriodo` ([[D-055]] (b)), **nunca** del instante de la corrección.
- **Decisión (6) — el TIPO es inmutable.** Cambiarlo es `DELETE` + volver a registrar: mover el tipo
  tocaría **dos** claves del dashboard y el guard `guard_tipo_evento_coherente.test.js` ([[D-053]]).
- **Decisión (7) — vaciar ≠ borrar.** `PUT` sin periodos → `400 lote_sin_celdas` (heredero de
  `detalle_sin_celdas`, [[D-055]]); borrar es el `DELETE` explícito y confirmado. Nunca un 200
  mentiroso.
- **Decisión (8) — última escritura gana, pero el diff se calcula DENTRO de la transacción** contra
  el estado real de la BD, no contra el snapshot que vio el modal: así una edición concurrente no
  revive una celda borrada. Lote ausente → `404 lote_inexistente`; ya archivado → `409 lote_cerrado`
  (familia de [[D-046]]), y el front refresca el listado.
- **Consecuencias:** contrato cross-repo sin cambios de shape (`UQ_evento_planta_fecha_periodo_tipo`
  intacto); **sin DDL ni migración**; qué quedó fuera y por qué: el **formato de mensaje** de
  WhatsApp (REQ-04 §8.1, sin plantilla literal → D-058) y la **cascada a SALAJDT/SALAING** (REQ-02
  no existe; el punto de enganche quedó **anotado** en la transacción de `mand.js`, sin código).
  Cross-ref: [[D-056]], [[D-055]], [[D-049]], [[D-019]], [[D-046]], [[D-020]], [[D-030]].

### 2.2 `CLAUDE.md` del subrepo

Actualizar la **convención 30** (MAND append-only): dejar dicho que la corrección por lote ya existe
y **cuáles son los tres gotchas nuevos** — (a) el diff conserva `registro_id` porque
`registro_origen_id` no tiene FK; (b) `fecha_evento` se hereda para no partir el lote entre dos días;
(c) la excepción a D-049 vive en el gate del endpoint, no en `canEditarRegistro`. Agregar la
convención **31** solo si hace falta espacio; **el archivo debe seguir bajo ~250 líneas** — si se
pasa, hacé una pasada de consolidación.

### 2.3 `BIT-RF-2026-001.md`

Marcar los RFs de corrección de MAND como implementados si existen; si no, agregar la referencia a
REQ-04 §3.5/§3.6. Bumpear la versión del doc y **agregar** (nunca reescribir) su changelog.
`BIT-MODBD-2026-001.md` **no cambia**: no hubo DDL.

### 2.4 `docs/requerimientos/REQ-04-historico-en-apartado.md`

Actualizar el encabezado de estado: la **corrección quedó entregada por D-057**; lo que sigue
pendiente es el **formato de mensaje** (§8.1, único bloqueante vivo) y la **cascada a REQ-02**.
Corregir la imprecisión de §5.3 sobre `canEditarRegistro` con un puntero al ADR. Resolver §8.2
(auditoría) y §8.4 (rango de periodos: se muestra como lista cuando no son contiguos, y se permiten
lotes no contiguos) apuntando a D-057.

## 3. Cleanup del scaffolding

```bash
git rm -r "prompts/D-057-correccion-lote-mand"
```

## 4. Commit de cierre

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(repo): cerrar D-057 — corrección por lote en Operación 24h + docs + cleanup

<body: resumen de lo implementado (PUT/DELETE por lote, diff quirúrgico, recálculo
por celda, modal de corrección); ADR D-057 agregado; REQ-04 actualizado; scaffolding
eliminado>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

## 5. Push / PR — REQUIERE CONFIRMACIÓN HUMANA

Preguntá al usuario antes de `git push -u origin feat/mand-correccion-lote-2026-07`, de mergear a
`main` o de abrir PR. No lo ejecutes por tu cuenta.

## 6. Actualizar ESTADO.md por última vez

Marcá E5 ✅ con el resumen final. (El archivo se borra en el paso 3; el resumen definitivo ya vive en
el ADR D-057.)
