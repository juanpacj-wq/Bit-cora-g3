# D-065 · Ola O2 · Lote L06 — Cumplimiento y congelado al cerrar (superficie C, backend)

> **Un lote = un chat.** Redactado por el integrador el 2026-08-31.

## ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto

> Rellenado por el **GATE-O1** el 2026-09-01. La O1 cerró con los tres lotes `done`, cero
> violaciones de territorio, **781/781** backend y **324/324** front. Expediente completo en
> [`GATE-O1.md`](./GATE-O1.md).

**ENMIENDA G1 — sin cambios de territorio ni de contrato para este lote.** El reparto, el puerto
(3116), C6 y C7 quedan tal cual. Lo que sí te toca de los hechos de abajo: el punto 1 (el motor
lanza **seis** códigos, no cuatro — los mapeás a 400 igual que los otros) y sobre todo el punto 7:
**`rotacion_cumplimiento.grupo` no lleva CHECK a propósito**, porque `NULL` ("el rol no tenía
patrón") es el caso legítimo que este lote necesita escribir.

### Hechos que cambian lo que dicen los documentos anteriores

1. **El motor del patrón lanza SEIS códigos, no cuatro** (D1). A los cuatro de C1 —
   `vector_invalido`, `desfase_imposible`, `desfase_ambiguo`, `turno_invalido`— se suman
   **`fecha_invalida`** (el string no es un `'YYYY-MM-DD'` real: trae hora, es un `Date`, o es un 30
   de febrero) y **`patron_invalido`** (el objeto `patron` no trae un `desfase` entero). Salen de
   `diasEntre`/`diaDelCiclo`, así que **`grupoDeTurno` también los propaga**. Mapéalos a un `400` con
   su slug, igual que a los otros cuatro, y **nunca** los dejes llegar crudos a la respuesta (D-032).
2. **`utils/errores.js` YA clasifica `entra_no_disponible` → 503** (D2, hecho en este gate, con su
   caso en `tests/errores.test.js`). No lo vuelvas a agregar y no lo toques.
3. **`puede_configurar_rotacion` NO llega hoy a la sesión ni a `/api/me`**, y **L04 es quien lo
   lleva** (D3): su territorio se amplió con `server/middleware/auth.js` y
   `server/utils/sesion-contexto.js`. Agrega
   `CAST(c.puede_configurar_rotacion AS BIT) AS puede_configurar_rotacion` a **los dos** SELECT —son
   espejos declarados, con el comentario que lo dice— y fija el shape en tu propio test. Sin esto,
   CA-19 (la pantalla de L07) es infalsable: el flag sale `undefined`, la pantalla no aparece y **no
   hay ningún error** que lo delate.
4. **El directorio que devuelve L03 viene deduplicado por `azure_oid`** con el rol resuelto por
   `PRECEDENCE`: `personas.length` **no** es la suma de `grupos[].miembros` (hoy 89 vs 90 en el
   tenant real, porque el Gerente de Producción está también en `USUARIO_CONSULTA`). Si necesitas el
   conjunto completo de roles por persona, eso es **cambio de contrato**: pídelo, no lo derives.
5. **`sincronizarDirectorio` acepta un parámetro `directorio` que salta Graph por completo, y ese
   parámetro JAMÁS puede venir del cliente.** Existe para inyectar el directorio en los tests. Si el
   endpoint de L04 dejara que algo derivado de `req.body` llegue a esa opción, un usuario autenticado
   podría fabricar `personas` y reescribir `nombre_completo`/`azure_upn` de filas **arbitrarias** —
   y `azure_upn` es entrada de `enforceSingletonFlag`, que en cada arranque pone `es_jefe_planta = 1`
   a quien calce con `M365_JEFE_PLANTA_UPNS`: sería una escalada real de privilegio. Llámala
   **exactamente** como `sincronizarDirectorio(pool, { por_usuario })`, y que `directorio` y
   `fetchImpl` no aparezcan en el handler. (Lo levantó la revisión de seguridad de este gate como
   riesgo hacia adelante; hoy no es explotable porque no hay endpoint.)
6. **`sincronizarDirectorio` NO escribe** `activo` de una fila existente, ni `es_jefe_planta`, ni
   `es_jdt_default`, ni `email`, ni el cargo — a propósito. No asumas que la sincronización "arregla"
   ninguno de esos. Y **`por_usuario` no se persiste**: `lov_bit.usuario` no tiene columnas de
   auditoría, así que solo va al log del server. Trazabilidad de quién sincronizó = tabla nueva =
   schema, y el schema fue L02: eso sería una desviación, no una licencia.
7. **`rotacion_cumplimiento.grupo` no lleva CHECK, y la razón que dio L02 resultó ser FALSA.** El
   cierre de L02 lo dejó sin constraint creyendo que un `BETWEEN 1 AND 4` "rechazaría el caso
   legítimo `NULL`" que L06 necesita escribir. **No es así**, y este gate lo midió contra la BD: un
   `CHECK` solo rechaza cuando evalúa a `FALSE`, y con `NULL` evalúa a `UNKNOWN`.

   ```
   CHECK (grupo BETWEEN 1 AND 4) sobre columna NULLABLE:
     ACEPTA   grupo = 3     ACEPTA   grupo = NULL
     RECHAZA  grupo = 5     RECHAZA  grupo = 0
   ```

   O sea que se podía tener las dos cosas. Consecuencia para **L06**: hoy esa columna acepta `0`,
   `5` y `200` en un registro congelado y append-only, y **nada te va a rechazar un grupo malo** —
   no confíes en la BD para ese rango, valídalo tú. El CHECK se agrega en el lote de corrección
   **L11** (ver `GATE-O1.md`, decisión D5); si L11 ya corrió cuando leas esto, la columna sí lo
   tiene y `NULL` sigue siendo legítimo.
8. **Nombres de constraint que el contrato no fijaba y ahora existen** (por si capturas una
   violación por nombre): `CK_rotacion_patron_desfase`, `DF_rotacion_patron_activo`,
   `DF_rotacion_patron_creado_en`, `CK_rotacion_asig_grupo`, `DF_rotacion_asig_creado_en`,
   `CK_rotacion_control_accion`, `DF_rotacion_control_ocurrido_en`, `CK_rotacion_cumpl_turno`,
   `CK_rotacion_cumpl_estado`, `DF_rotacion_cumpl_snapshot_en`. Los que C2 sí fijaba quedaron **tal
   cual**. **Las FK van sin nombre** (inline con `REFERENCES`, como `turno_unidad`): captúralas por
   número de error (547), no por nombre.
9. **`rotacion_patron` y `rotacion_asignacion` tienen `creado_en_bogota`** además de `creado_en`. Un
   `SELECT *` sobre ellas trae esa columna de más.
10. **Las cuatro tablas están vacías en `PortalG3_dev` y `F37.A1` está aplicada** (una sola fila en
    `migracion_aplicada`). En `PortalG3` (prod) nada de esto existe: llega con el despliegue. El flag
    está en 1 exactamente para **`Administrador y Debugging`** y **`Gerente de Producción`**.
11. **Corrección al `_CONTEXTO-BASE.md §7`** (el documento no se edita; vale este renglón): dice que
    `server/tests/fixtures/` "no existe todavía". **Sí existe** y ya tenía tres archivos antes de
    L01. No hubo colisión de nombres, pero no vayas a crear la carpeta creyendo que la estrenas.
12. **`parsearVector` es estricto a propósito** (para L07 y para cualquiera que arme un vector):
    tolera espacios (`' 4, 2 ,2,…'`) pero rechaza ceros a la izquierda (`'01'`), decimales y
    negativos, para que `serializarVector(parsearVector(t)) === t` sea exacto. Si la pantalla arma el
    vector desde ocho selectores de 1..4 esto no se nota nunca; si lo arma a mano, que no rellene con
    ceros.
13. **El oráculo del Excel NO protege de la aritmética de fechas frágil** (medido en L01): con
    `new Date(str)` los 1.460 pares pasan igual, porque el offset se cancela en los dos extremos. Lo
    que protege es el **parsing estricto**. Si alguien "simplifica" `msDelDiaIso`, el test que se
    pone rojo es el de parsing, no el del oráculo — no lo toques.

## 0. Puerta de arranque (obligatorio, primero)

```bash
node "../metodología de implementación/herramientas/lotes.mjs" --impl D-065 claim L06 --sesion L06-HHMM
```

## 1. Lee, en este orden y solo esto

1. **`GATE-O1.md` completo.**
2. `prompts/D-065-rotacion-turnos/_CONTEXTO-BASE.md` **§1, §5.1, §5.2 (los estados), §5.4, §6 (C1,
   C2, C4, C6, C7), §7, §8, §9**.
3. `server/utils/turno-entidad.js` — **`cerrarTurno` completo (:257-427)**. Es tu territorio, y el
   único punto donde lo vas a tocar. Fíjate en cómo la transacción congela la conformación: tu
   congelado va **justo después**, en la misma transacción.
4. `server/utils/conformacion-snapshot.js` — **el modelo a copiar** para un congelado idempotente
   por `NOT EXISTS`, con el filtro `es_sintetico = 0` (D-044) y `es_observador = 0` (D-059).
5. `server/utils/rotacion/patron.js` (C1) y `server/utils/rotacion/titulares.js` (C4) — solo lectura.
6. `server/tests/helpers.js` y `server/tests/conformacion_turno.test.js` — el modelo de test.
7. `CLAUDE.md`, convenciones **21** (entidad turno; `cerrarTurno` es el único camino de cierre),
   **33** (`es_observador`) y la nota de D-044 sobre `es_sintetico`.

## 2. Territorio — lo único que puedes crear o editar

- `server/routes/rotacion-cumplimiento.js` *(nuevo)*
- `server/utils/rotacion/cumplimiento.js` *(nuevo)*
- `server/utils/turno-entidad.js` — **solo para añadir la llamada al congelado**
- `server/tests/rotacion_cumplimiento.test.js` *(nuevo)*
- `prompts/D-065-rotacion-turnos/cierres/L06.md`

**Eres el único lote que toca `server/utils/turno-entidad.js` en esta ola.** Es un archivo
load-bearing: por ahí pasa **todo** cierre de turno de la app.

**NO tocas** nada más. En particular: `server/auth/app.js` — **L04 monta tu router**, tú no; ni
`server/routes/rotacion.js` / `utils/rotacion/titulares.js` (L04, esta ola); ni
`server/routes/rotacion-control.js` / `utils/rotacion/control.js` (L05, esta ola); ni
`server/db.js`, `server/package.json`, `ESTADO.md`, `docs/decisions.md`, `CLAUDE.md`, `BIT-*`, ni el
front.

Tu router **tiene que llamarse exactamente** `server/routes/rotacion-cumplimiento.js` y exportar el
router por `default`: L04 lo monta por ese nombre.

## 3. Contrato

**Produces C6** (`GET /api/rotacion/cumplimiento?desde=&hasta=&planta_id=`):

```jsonc
{
  "filas": [
    { "fecha_operativa": "2026-08-15", "turno": 1, "planta_id": "GEC3",
      "cargo_id": 8, "cargo_nombre": "Operador de Planta - Sala de Mando",
      "grupo": 3, "estado": "PARCIAL",
      "titulares": [ { "usuario_id": 61, "nombre": "…", "entro": true },
                     { "usuario_id": 77, "nombre": "…", "entro": false } ],
      "relevo": null,
      "congelado": true }
  ],
  "resumen": { "PENDIENTE": 4, "PARCIAL": 9, "COMPLETO": 51, "CUBIERTO_POR_RELEVO": 2 }
}
```

Rango máximo **93 días**; más → `400 rango_excesivo`. Turnos cerrados salen de
`rotacion_cumplimiento` (`congelado: true`); el turno en curso se deriva en vivo (`congelado: false`).

**Produces C7:**

```js
/** Se invoca DENTRO de la transacción de cerrarTurno, después de congelar la conformación.
 *  Idempotente por la PK de rotacion_cumplimiento (NOT EXISTS). `filas = 0` NO es error. */
export async function congelarCumplimiento(tx, { turno_id, fecha_operativa, planta_id, turno })
 : Promise<{ filas: number }>
```

**Consumes:** C1 (`patron.js`), C2 (las tablas), C4 (`titularesDeTurno`, de L04).

## 4. Trabajo

**Qué se sabe:**

- **La regla central, y es lo que hace medible al módulo (CA-15):** el estado se resuelve **por
  `usuario_id`**, no por conteo de cargo. Si entran tres operadores de Planta de Agua y **ninguno**
  es titular, el estado sigue `PENDIENTE`. Los demás se siguen registrando como participantes, pero
  **no satisfacen el slot**. Es lo contrario de lo que haría un scheduler comercial, y es deliberado.
- Escalones (CA-16): ningún titular en `turno_participante` → `PENDIENTE`; alguno pero no todos →
  `PARCIAL`; **todos** → `COMPLETO` (decisión R9); un no-titular con el control → `CUBIERTO_POR_RELEVO`,
  que **gana sobre los otros tres**.
- "Entró" = existe fila en `bitacora.turno_participante` para `(turno_id, usuario_id)`.
- `cerrarTurno` está en `turno-entidad.js:257` y ya es atómico: sella la cabecera, acumula presencia,
  congela la conformación, archiva registros, escribe el CIET y activa el sucesor. Tu llamada va
  **dentro de esa misma transacción**, después de la conformación.
- El titular es **el mismo en GEC3 y GEC32** (decisión R3), pero el **cumplimiento se mide por
  planta**: hay una fila de `rotacion_cumplimiento` por cada `(fecha, planta, turno, cargo)`.

**La sospecha (verifícala, no te la creas):** que `filas = 0` en el congelado sea un error que deba
abortar el cierre. **No lo es**, y confundirlo tiene una consecuencia fea: si ningún rol tiene
patrón activo para esa fecha — que es **exactamente el estado del sistema antes de la primera carga
anual** — un `THROW` ahí volvería **incerrable todo turno de la planta**. `filas = 0` es el caso
normal de un sistema recién desplegado. Lo mismo vale si el rol existe pero nadie tiene grupo
asignado. Regístralo en el log con un conteo y sigue. (Precedente literal en D-063: `copias = 0`
nunca es error.)

1. `utils/rotacion/cumplimiento.js` — `evaluarEstado(...)` como **función pura** sobre
   `{titulares, participantes, principal}` (así los cuatro escalones se prueban sin BD), más
   `congelarCumplimiento(tx, ...)` y la query del rango.
2. `routes/rotacion-cumplimiento.js` — un handler en `asyncH`, con `router.use(loadAppSession)`.
   Sin gate por flag: la vista es de **consulta y la ve cualquier rol** (incluido el observador).
3. `turno-entidad.js` — **una sola llamada añadida**, dentro de la transacción, envuelta en su
   `try/catch` propio solo si decides que un fallo del congelado no debe tumbar el cierre.
   **Recomendación: NO lo envuelvas.** Si el congelado falla, que caiga la transacción entera: un
   turno sellado sin su cumplimiento es peor que un cierre que hay que reintentar. Documenta la
   decisión en el commit.
4. `titulares_json` se guarda con `NVARCHAR(MAX)`; el nombre del cargo se **congela** en
   `cargo_nombre` porque la etiqueta puede cambiar (D-052) y el histórico no se reescribe.
5. **Filtros que hay que heredar:** al contar participantes, excluye `es_sintetico = 1` (D-044) y
   `es_observador = 1` (D-059), igual que hace `buildConformacionSnapshot`. Un observador que entra
   **no** satisface un slot ni cuenta como relevo.

## 5. Criterios de aceptación y sus verificadores

| CA | Criterio | Verificador |
|---|---|---|
| **CA-15** | El estado se resuelve **por `usuario_id`**: 3 participantes del rol y ninguno titular → `PENDIENTE` | `tests/rotacion_cumplimiento.test.js › "por persona, no por conteo"` |
| **CA-16** | Los cuatro escalones son correctos, y `CUBIERTO_POR_RELEVO` gana sobre los otros | `tests/rotacion_cumplimiento.test.js › "escalones"` — cuatro casos sobre `evaluarEstado` puro + uno end-to-end |
| **CA-17** | `cerrarTurno` congela una fila por `(fecha_operativa, planta_id, turno, cargo_id)` en la MISMA transacción, y es **idempotente** | `tests/rotacion_cumplimiento.test.js › "congelado"` — cerrar un turno de `'TST'` dos veces deja **una** fila por clave; y un cierre con **cero** patrones activos **no falla** (`filas = 0`) |
| **CA-18** | `GET /cumplimiento` responde, para un rango, qué titulares no entraron y en qué turnos | `tests/rotacion_cumplimiento.test.js › "reporte de rango"` — incluye `400 rango_excesivo` con 94 días |

**Verificador bidireccional** en cada uno. Para CA-17, el caso negativo más valioso: haz que
`congelarCumplimiento` lance con `filas = 0` y confirma que el test de "cierre sin patrones" se pone
**rojo**; restaura y míralo verde. Ese es justo el bug que este prompt te pide no cometer.

## 6. Verificación que corres (solo la tuya)

```bash
cd server
node --check routes/rotacion-cumplimiento.js && node --check utils/rotacion/cumplimiento.js && node --check utils/turno-entidad.js
node "../../metodología de implementación/herramientas/lotes.mjs" --impl D-065 test-lock --sesion <tu sesión>
SERVER_PORT=3116 AUTH_TEST_BYPASS=1 node --env-file=../.env server.js &
TEST_BASE_URL=http://localhost:3116 node --env-file=../.env --test tests/rotacion_cumplimiento.test.js
# Regresión obligatoria: tocaste turno-entidad.js, así que corré también su suite:
TEST_BASE_URL=http://localhost:3116 node --env-file=../.env --test tests/turno-entidad.test.js tests/conformacion_turno.test.js
node "../../metodología de implementación/herramientas/lotes.mjs" --impl D-065 test-unlock --sesion <tu sesión>
```

**Esos dos archivos de regresión son parte de tu verificación aunque no sean tu territorio**: los
corres, no los editas. Si alguno se pone rojo por tu cambio, es tuyo arreglarlo (en tu archivo, no
en el suyo).

**No corras `npm test` completo.** Cierras turnos **solo en planta `'TST'`** (D-055): un
`cerrarTurno` sobre `'GEC3'` cierra el turno REAL de producción. Es el riesgo más caro de este lote.
Cero residuos: deja la query en tu cierre.

## 7. Cierre (obligatorio, en este orden)

1. `prompts/D-065-rotacion-turnos/cierres/L06.md` con la plantilla `CIERRE-LOTE.md`.
2. `git commit -m "feat(D-065 L06): cumplimiento plan-vs-real y congelado al cerrar el turno" -- server/routes/rotacion-cumplimiento.js server/utils/rotacion/cumplimiento.js server/utils/turno-entidad.js server/tests/rotacion_cumplimiento.test.js prompts/D-065-rotacion-turnos/cierres/L06.md`
   (cuerpo multilínea con el porqué; **sin firmas de IA**). Cita los SHA.
3. `lotes.mjs --impl D-065 done L06 --sesion <tu sesión>`
4. Mensaje de cierre con la forma fija. En `Para el gate`, dilo explícito: **tocaste
   `turno-entidad.js`**, así que el gate debe mirar con lupa el diff de `cerrarTurno` y correr la
   suite completa de turnos.

## Reglas (no negociables)

- `git commit -- <rutas>`; nunca `git add -A`/`.`; nada de stash, reset, checkout, restore, switch,
  rebase, amend, push, merge.
- **No cambies nada de lo que `cerrarTurno` ya hace.** Solo añades una llamada. Cualquier
  reordenamiento de lo existente es un bloqueo, no una mejora de paso.
- **Nunca cierres un turno de `'GEC3'` o `'GEC32'` en un test.** Solo `TEST_PLANTA`.
- No te asciendas solo: propones `cumple`; lo confirma el gate.
- Tuteo colombiano estándar; sin voseo.
