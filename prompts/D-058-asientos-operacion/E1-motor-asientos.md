# D-058 · E1 — Motor de asientos (módulo puro)

## Antes de empezar (obligatorio)
1. Leé `_CONTEXTO-BASE.md` completo y `ESTADO.md`.
2. Verificá que E0 figure ✅. (E1 es la primera etapa de código: no depende de ninguna otra.)
3. Releé §5 y §4 de `docs/requerimientos/FORMATO-ASIENTOS-OPERACION.md` — las plantillas y las
   convenciones canónicas son la especificación literal de esta etapa.

## Alcance de esta etapa

**Entra:** el módulo puro que convierte un evento en su texto, y sus tests unitarios.
**No entra:** ningún endpoint, ninguna consulta a BD, nada de front, nada del Excel. Nadie lo
importa todavía — es deliberado: el motor se prueba solo, sin levantar servidor ni tocar la BD.

## Tareas

1. Crear `server/utils/asientos/formato.js` con los helpers de las convenciones canónicas (§4):
   - `unidadCanonica(planta_id)` → `'GEC3'` | `'GEC32'`. Es identidad para las plantas reales; para
     cualquier otra (incluida `'TST'`) devuelve el `planta_id` tal cual — **no lanza**: el motor es
     puro y no valida catálogo.
   - `potenciaMW(valor)` → `'150 MW'`. Entero, espacio antes de la unidad. **Es potencia por
     periodo, no `MWh`** — jamás emitir `MWh`.
   - `listaPeriodos(nums)` → `'P20'` · `'P17 al P19'` (contiguos) · `'P3, P7 y P19'` (no contiguos:
     coma y la última con ` y `). Ordena ascendente y deduplica.
   - `carga(periodos)` → aplica la **regla de compactación**: si todas las celdas comparten
     `valor_mw` → `'150 MW del P17 al P19'`; si difieren → `'P17: 109 MW; P18: 134 MW; P19: 164 MW'`
     (orden ascendente por periodo, `;` como separador). Lo decide el sistema, el operador no elige.
   - `UNIDAD_YA_NOMBRADA = /^\s*(GEC3\b|GEC32\b|U?G\s?3[.,]?[02]\b)/i`.
2. Crear `server/utils/asientos/plantillas.js` con las plantillas de §5, **una constante por tipo**,
   y el mapa de los cuatro estados de DISP. Que se lean como el documento, para que el diff contra
   el insumo sea obvio.
3. Crear `server/utils/asientos/index.js` con las tres entradas públicas:
   - `asientoLote({ tipo, planta_id, periodos, funcionariocnd, detalle })` → string.
     `tipo ∈ 'AUTH' | 'REDESP' | 'PRUEBA'`. `periodos` = `[{ periodo, valor_mw }]`.
   - `asientoDisponibilidad({ planta_id, evento, detalle })` → string.
     `evento ∈ 'En Servicio' | 'En Reserva' | 'Indisponible' | 'Mantenimiento'`.
   - `asientoLiteralSala({ planta_id, texto })` → string. **Sin plantilla, sin normalización, sin
     corrección ortográfica.** Prefija `` `${unidad} — ${texto.trim()}` `` **solo** si
     `UNIDAD_YA_NOMBRADA` no matchea. **Guion largo `—` con espacios, nunca `-`.**
4. Reglas transversales que el módulo debe cumplir (van comentadas en el código, no solo probadas):
   - **La hora NO va en el texto.** El `HH:MM` es columna de la hoja y del listado. Los
     `16:38 — …` del insumo ilustran la fila completa, no la plantilla.
   - **`detalle` ausente es lo normal** (D-056): la frase **termina en el dato duro**. Ni rótulo
     huérfano, ni `undefined`, ni doble punto. `detalle` va **al final, tras punto** (decisión C).
   - **Sin verbo de sentido en AUTH** (decisión A): `a generar {carga}`, jamás "subir"/"bajar" — el
     sistema conoce el valor autorizado, no el vigente contra el cual compararlo.
   - `funcionariocnd` solo aparece en AUTH (D-018 lo fuerza a `NULL` en PRUEBA y REDESP). Si un
     AUTH llegara sin funcionario, **no** inventar texto: omitir el paréntesis. (El endpoint ya lo
     rechaza antes; el motor no es el lugar para validar.)
   - Punto final **siempre**.
5. Crear `server/tests/asientos.test.js` — **unitario puro, sin BD ni servidor**. Casos mínimos:
   - Los cinco eventos reales de enero del insumo §3(d), ya normalizados. En particular el del
     30/01: `Se recibe llamada del CND (Jair Pardo) autorizando GEC3 a generar 150 MW del P17 al P19.`
   - REDESP con valores distintos: `Se recibe del CND redespacho para GEC3: P17: 109 MW; P18: 134 MW; P19: 164 MW.`
   - REDESP plano a cero con detalle: `Se recibe del CND redespacho para GEC3: 0 MW del P1 al P24. Aplicado en RIO.`
   - PRUEBA: `Se declara prueba de GEC32 a 270 MW del P9 al P11.`
   - Los cuatro estados de DISP, con y sin `detalle`.
   - Periodo suelto (`P20`) y no contiguos (`P3, P7 y P19`).
   - Sala literal: texto que **no** nombra la unidad → se prefija; texto que arranca con `G3.0`,
     `UG32`, `GEC3` o `GEC32` → **no** se prefija (probar las cuatro variantes de la regex).
   - Que `GEC3\b` **no** matchee `GEC32` (el `\b` lo cubre; el test lo fija).
   - Que en ningún caso aparezca la subcadena `MWh`.
   - Que ninguna salida contenga `undefined`, `null` ni ` .`.

## Verificación (antes de commitear)
- `cd server && npm test` con el baseline esperado (ver `ESTADO.md`). El archivo nuevo debe correr
  en milisegundos: si tarda, es que tocó la BD y algo está mal.
- No hay front en esta etapa: no hace falta `npm run build`.

## Actualizar ESTADO.md (obligatorio antes de cerrar)
- Marcá E1 ✅ con resumen de una línea.
- Bloque `### E1 — Motor de asientos  ✅` con **Archivos tocados**, **Verificación** (resultado real
  de la suite) y **Desviaciones**.
- Registrá en "Datos descubiertos" cualquier caso borde del texto que no estuviera previsto.

## Commit
```bash
git add server/utils/asientos server/tests/asientos.test.js
git commit -m "$(cat <<'EOF'
feat(asientos): motor puro de plantillas de operación (AUTH/REDESP/PRUEBA/DISP/Sala)

Fuente única del texto normalizado que van a compartir el listado del día, el
reflejo a las bitácoras de Sala y el libro mensual F03: si el texto se armara en
cada consumidor, las tres salidas divergirían.

Módulo puro (sin BD, sin reloj): entra un evento plano, sale su asiento. Implementa
las convenciones canónicas del formato — GEC3/GEC32, potencia en MW enteros (nunca
MWh: es potencia por periodo, no energía), compactación automática del rango de
periodos — y las plantillas por tipo. AUTH va sin verbo de sentido: el sistema
conoce el valor autorizado, no el vigente contra el cual compararlo.

Las bitácoras de Sala pasan LITERALES, sin normalizar ni corregir ortografía, con
prefijo de unidad solo cuando el texto no la nombra ya.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

> No hagas `push`/`merge`/`PR` en etapas intermedias.
