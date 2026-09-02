# D-065 · Ola O3 · Lote L09 — Vista de cumplimiento (superficie C, front)

> **Un lote = un chat.** Redactado por el integrador el 2026-08-31.

## ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto

> Copiado **tal cual** del `GATE-O2.md §6` (2026-09-01). Si algo acá contradice al
> `_CONTEXTO-BASE.md` o a tu §4, **manda esto**: el contexto base no se edita, se enmienda desde
> el gate. Lee además el §8 del gate para saber con quién compartes la ola.

1. **Las tres superficies existen y están probadas por HTTP.** Los routers se montan en
   `auth/app.js` en el orden `/api/rotacion/control` → `/api/rotacion/cumplimiento` →
   `/api/rotacion`, y **ese orden es invariante**: si alguien lo cambia, `loadAppSession` correría
   dos veces por request y un 404 de `/control/*` saldría del router equivocado. No lo toques: el
   front no necesita saber más que las rutas.
2. **`puede_configurar_rotacion` YA viaja en la sesión** como booleano, en `/api/me` y en lo que
   devuelven `select-context` y `cambiar-unidad` (los dos SELECT espejo de `middleware/auth.js` y
   `utils/sesion-contexto.js`). L07 lo lee de la sesión, igual que los otros flags de cargo, y
   **nunca** compara nombres de cargo.
3. **`GET /asignaciones` devuelve además `personas`**, la nómina asignable: filas con `azure_oid` y
   `activo = 1`, con `ultimo_cargo_id`/`ultimo_cargo_nombre` (el cargo de su última sesión) y su
   asignación vigente en la fecha. **`ultimo_cargo_id` es `null` para quien nunca ha iniciado
   sesión**, y tras la primera sincronización real eso son ~78 de 81 personas: la pantalla de L07
   **necesita un selector de cargo por persona**, no puede asumir que vienen pre-agrupadas por rol.
4. **`POST /asignaciones`** recibe `{ asignaciones: [{ usuario_id, cargo_id, grupo, vigente_desde?,
   vigente_hasta? }] }` y responde `{ creadas, cerradas, actualizadas, sin_cambio, total }`.
   `vigente_desde` ausente = hoy Bogotá; `vigente_hasta` ausente = vigencia abierta (`9999-12-31`);
   **`grupo: null` = la persona sale de la rotación** (queda supernumeraria). Recargar el mismo lote
   es idempotente (`sin_cambio`). El lote es **atómico** y el 4xx trae el `indice` del elemento malo.
   Tope: 500 asignaciones por solicitud.
5. **`POST /patrones`** acepta los vectores como arreglo o como texto, **ignora** `desfase` y `ancla`
   si el cliente los manda, y responde el patrón con `grupo_t1`/`grupo_t2` derivados (lo que digitó
   el administrador). Los 409 son `patron_duplicado` (misma `fecha_inicio`) y `patron_solapado` (otro
   patrón activo del cargo cubre parte del periodo), y traen `patron_id`.
6. **Hoy NO existe forma de corregir un patrón cargado con error, y eso lo arregla L12 en esta misma
   ola** (decisión D5, hallazgo CR2-10). El router solo tiene `GET` y `POST` de `/patrones`, `activo`
   siempre se escribe en 1, y `UQ_rotacion_patron_natural (cargo_id, fecha_inicio)` **no filtra por
   `activo`**: ni siquiera poner `activo = 0` a mano libera esa fecha de inicio. **Contrato que L12
   entrega y L07 consume:** `PATCH /api/rotacion/patrones/:id` con `{ activo: false }`, gated por
   `puede_configurar_rotacion`, `200 { patron }` · `404 patron_no_encontrado` · `403
   rotacion_no_autorizado`; y la UQ pasa a filtrada por `activo = 1` para que reponer el patrón
   corregido con la misma fecha de inicio sea posible. **L07: escribe la pantalla contra ese
   contrato.** Si al probar todavía no está montado, es coordinación de la ola, no un bloqueo.
7. **`GET /api/rotacion/control/estado` devuelve exactamente las 9 claves de C5, en ese orden**, y
   `principal` es **siempre** `pila[pila.length - 1]` (o `null` si el rol no tiene titulares ni
   tomas). Con el turno cerrado responde **`200 { aplica: false, turno_id: null }`, no 409** — entrar
   en la gavela entre turnos es un caso normal, no un error. Los tres POST van **sin cuerpo** y
   devuelven el mismo shape; `/descartar` agrega además `ok: true`.
8. **Los slugs de 409 del control** son `ya_es_principal`, `no_es_principal`, `titular_no_abandona`,
   `turno_cerrado`, `control_ocupado` y uno que C5 no enumeraba: **`rotacion_no_aplica`** (el cargo
   no rota o está excluido por R12). Todos llegan como `{ error, codigo, mensaje }`: **ramifica por
   `codigo`**, nunca por el texto (D-032).
9. **Cumplimiento (C6):** los 400 son `rango_requerido`, `fecha_invalida`, `rango_invalido`,
   `rango_excesivo` (> 93 días) y `planta_invalida`, más los seis del motor. `resumen` trae
   **siempre** las cuatro claves aunque estén en 0. `congelado: false` marca el turno en curso
   (derivado en vivo); las filas congeladas traen el `cargo_nombre` **de la época**, no el actual, y
   **nunca** incluyen usuarios sintéticos.
10. **Un rol con patrón activo pero sin nadie asignado al grupo de guardia NO produce fila de
    cumplimiento** (decisión D2): 0 de 0 no es un estado, nadie debía venir. Para el popup de L08 ese
    mismo caso llega como `principal: null`. Un rango vacío es un resultado normal, no un error.
11. **Reabrir un turno ahora borra su cumplimiento congelado** (decisión D1), así que el re-cierre lo
    recongela con la verdad nueva. Para L09: una fila que desaparece del reporte porque el turno se
    reabrió es correcto, y vuelve al cerrar.
12. **La sincronización con Entra puede responder `200` con menos gente de la esperada.** Tolera
    fallos **por asignación** y solo lanza `entra_no_disponible` si falla más de la mitad, pero el
    conteo cuenta **asignaciones (14: 13 grupos + 1 usuario directo), no personas** (CR2-4): si se
    caen los grupos grandes, el 200 puede traer 20 personas en vez de 81 y el único rastro es una
    línea en el log. **L07: muestra el `total` y el `por_rol` que devuelve la respuesta, nunca un
    número prometido de antemano**, y deja el conteo por rol a la vista — es lo que le permite al
    administrador notar que falta gente. `503 entra_no_disponible` ya sale saneado por HTTP y debe
    mostrarse como aviso **no bloqueante**: el resto de la pantalla sigue usable.
13. **Un id fuera del rango de `INT` en la query responde 500, no 400** (CR2-2, lo arregla L12):
    `validarEnteroPositivo` no tiene tope de 32 bits, así que `cargo_id=2147483648` pasa la
    validación y revienta en el driver. No construyas la UI apoyándote en un 400 ahí.
14. **`GET /titulares` sin `fecha` ni `turno` resuelve el "turno en curso" por reloj de pared**, no
    por el turno ABIERTO de la unidad (CR2-15), así que durante una extensión (D-046) puede nombrar
    un turno distinto del que dicen `/control/estado` y `/cumplimiento`. **Pásale siempre `fecha` y
    `turno` explícitos** si necesitas que las tres superficies coincidan.
15. **Cero polling, cero `localStorage`/`sessionStorage`, cero tareas recurrentes** (CA-23). El
    "no volver a preguntar" del popup sale de `ya_respondi` del backend, y la ola O2 no agregó ni un
    `setInterval`: no lo estrenes tú.

## 0. Puerta de arranque (obligatorio, primero)

```bash
node "../metodología de implementación/herramientas/lotes.mjs" --impl D-065 claim L09 --sesion L09-HHMM
```

## 1. Lee, en este orden y solo esto

1. **`GATE-O2.md` completo.**
2. `prompts/D-065-rotacion-turnos/_CONTEXTO-BASE.md` **§1, §5.2 (los cuatro estados), §5.4 (el
   endpoint de L06), §5.5, §6 (C6, C8), §9**.
3. `src/components/SeguimientoTurnos.jsx` — **el modelo a copiar**: tabla de seguimiento con filtros
   de rango y planta.
4. `src/hooks/useSeguimientoTurnos.js` — el modelo del hook.
5. `src/utils/fecha.js` — los formateadores con `timeZone: 'America/Bogota'` explícito. **Úsalos:
   no escribas formateo de fechas nuevo.**
6. `CLAUDE.md`, convenciones **17** (componentes **controlados**, el subestado vive en la URL) y
   **9** (TZ: presentación en Bogotá explícita).

## 2. Territorio — lo único que puedes crear o editar

- `src/components/Rotacion/CumplimientoRotacion.jsx` *(nuevo)*
- `src/components/Rotacion/cumplimiento-rotacion.test.jsx` *(nuevo)*
- `src/hooks/useCumplimiento.js` *(nuevo)*
- `prompts/D-065-rotacion-turnos/cierres/L09.md`

**NO tocas** nada más. En particular: `src/BitacorasGecelca3.jsx` y `src/routing/appRoute.js`
(**L10**, O4), `src/components/Rotacion/ConfiguracionRotacion.jsx` y `src/hooks/useRotacion.js`
(**L07**, esta ola), `src/components/Rotacion/PopupTomaControl.jsx` y `src/hooks/useTomaControl.js`
(**L08**, esta ola), `src/components/SeguimientoTurnos.jsx` (lo lees, no lo editas),
`src/utils/fecha.js`, `package.json` (gate), y todo el backend.

## 3. Contrato

**Produces** — un componente **controlado** (C8): el rango y la planta llegan por props, y los
cambios se avisan por callback. **No lee ni escribe el hash**: eso lo hace L10.

```jsx
<CumplimientoRotacion
  desde={'2026-08-01'} hasta={'2026-08-31'} planta={'GEC3'}
  onRangoChange={({desde, hasta}) => {}}
  onPlantaChange={(planta) => {}}
/>
```

**Consumes C6** (`GET /api/rotacion/cumplimiento?desde=&hasta=&planta_id=`), producido por L06:

```jsonc
{ "filas": [ { "fecha_operativa": "2026-08-15", "turno": 1, "planta_id": "GEC3",
               "cargo_id": 8, "cargo_nombre": "Operador de Planta - Sala de Mando",
               "grupo": 3, "estado": "PARCIAL",
               "titulares": [ {"usuario_id":61,"nombre":"…","entro":true},
                              {"usuario_id":77,"nombre":"…","entro":false} ],
               "relevo": null, "congelado": true } ],
  "resumen": { "PENDIENTE": 4, "PARCIAL": 9, "COMPLETO": 51, "CUBIERTO_POR_RELEVO": 2 } }
```

Rango máximo **93 días**; más → `400 rango_excesivo`.

## 4. Trabajo

**Qué se sabe:**

- Los cuatro estados y qué significan (`_CONTEXTO-BASE.md §5.2`):

  | Estado | Significado |
  |---|---|
  | `PENDIENTE` | Ningún titular asignado entró |
  | `PARCIAL` | Entró al menos uno, faltan otros |
  | `COMPLETO` | Entraron **todos** los titulares |
  | `CUBIERTO_POR_RELEVO` | Un no-titular tomó el control del rol |

- **El entregable que el usuario pidió por nombre** (§8 y criterios de aceptación del
  requerimiento): *"qué titulares no entraron y en qué turnos"*. Eso **no es** un subproducto de la
  tabla de estados: tiene que poder leerse de un vistazo. Dale su propio lugar — una lista o un
  panel de "Titulares que no entraron" junto a la tabla, alimentado por los `titulares[].entro ===
  false` de las filas `PENDIENTE` y `PARCIAL`.
- El histórico arranca casi de cero: la purga de D-045 (2026-07-05) vació `conformacion_turno`,
  `turno_unidad` y `turno_participante`. Hoy prod tiene ~230 turnos y ~1.050 filas de conformación.
  **Un rango vacío es un resultado normal, no un error**: muéstralo como "Sin datos en este rango",
  no como una falla.
- `congelado: false` marca el turno en curso (derivado en vivo). Distínguelo visualmente: su estado
  todavía puede cambiar.

**La sospecha (verifícala, no te la creas):** que `PENDIENTE` signifique "faltó gente en el turno".
**No.** Significa que **ninguno de los titulares del patrón entró** — puede haber habido tres
personas del mismo rol trabajando. Esa distinción es la regla central del módulo (CA-15) y la que lo
hace medible. Si tu UI dice "sin personal" o "turno vacío", está mintiendo. Di **"ningún titular
registró en la bitácora"**, y cuando haya participantes no titulares, muéstralos aparte: son
información, no ruido.

1. `useCumplimiento.js` — fetch por rango + planta, con `cargando`/`error`. Ramifica por `codigo`
   (`rango_excesivo` → mensaje que diga el límite de 93 días; `sin_conexion` → aviso de red).
2. `CumplimientoRotacion.jsx` — filtros (rango, planta) + tabla + el panel de titulares ausentes +
   el resumen por estado.
3. Fechas siempre con los formateadores de `src/utils/fecha.js` (`timeZone: 'America/Bogota'`).
   **Prohibido** `toLocaleDateString()` a pelo y `new Date(f).getDate()`.
4. **Tabla ancha:** que scrollee dentro de su propio contenedor `overflow-x: auto`; la página no
   debe scrollear horizontalmente.
5. El test se escribe **junto** con el componente.

## 5. Criterios de aceptación y su verificador

| CA | Criterio | Verificador |
|---|---|---|
| **CA-21** | Pinta los cuatro estados y permite filtrar por rango y planta; una fila `PENDIENTE` **nombra a los titulares que faltaron** | `src/components/Rotacion/cumplimiento-rotacion.test.jsx` — render con una respuesta simulada que cubre los 4 estados; verifica que los 4 aparecen distinguibles; que una fila `PENDIENTE` muestra los nombres de sus titulares ausentes; que cambiar el rango dispara `onRangoChange`; que `400 rango_excesivo` muestra el mensaje del límite; y que un rango vacío dice "Sin datos" y **no** un error |

**Verificador bidireccional:** quita el render de los titulares ausentes y confirma que el test se
pone rojo; restaura. Salida literal en el cierre.

## 6. Verificación que corres (solo la tuya)

```bash
npm test -- src/components/Rotacion/cumplimiento-rotacion.test.jsx
npm run build
```

`npm run build` verde **antes de commitear**: un build roto bloquea a los otros dos chats de la ola.

## 7. Cierre (obligatorio, en este orden)

1. `prompts/D-065-rotacion-turnos/cierres/L09.md` con la plantilla `CIERRE-LOTE.md`.
2. `git commit -m "feat(D-065 L09): vista de cumplimiento de la rotación" -- src/components/Rotacion/CumplimientoRotacion.jsx src/components/Rotacion/cumplimiento-rotacion.test.jsx src/hooks/useCumplimiento.js prompts/D-065-rotacion-turnos/cierres/L09.md`
   (cuerpo multilínea; **sin firmas de IA**). Cita los SHA.
3. `lotes.mjs --impl D-065 done L09 --sesion <tu sesión>`
4. Mensaje de cierre con la forma fija. En `Para el gate`: enganchar el test de vitest y **qué props
   exactas espera tu componente**, que es lo que L10 va a cablear en la O4.

## Reglas (no negociables)

- `git commit -- <rutas>`; nunca `git add -A`/`.`; nada de stash, reset, checkout, restore, switch,
  rebase, amend, push, merge.
- **Tu componente es controlado y no toca el hash ni el componente raíz.** Si te ves importando
  `appRoute.js`, para: es territorio de L10.
- Fechas con `timeZone: 'America/Bogota'` explícito, vía `src/utils/fecha.js`.
- **Tuteo colombiano estándar en todo copy visible**; sin voseo.
- No te asciendas solo: propones `cumple`; lo confirma el gate.
