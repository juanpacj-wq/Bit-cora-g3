# D-065 · Ola O3 · Lote L09 — Vista de cumplimiento (superficie C, front)

> **Un lote = un chat.** Redactado por el integrador el 2026-08-31.

## ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto

*(Lo rellena el GATE-O2.)*

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
