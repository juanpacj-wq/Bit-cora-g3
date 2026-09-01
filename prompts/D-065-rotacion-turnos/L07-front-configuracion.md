# D-065 · Ola O3 · Lote L07 — Pantalla de configuración anual (superficie A, front)

> **Un lote = un chat.** Redactado por el integrador el 2026-08-31.

## ENMIENDAS Y HECHOS QUE CAMBIAN — léelo antes que el resto

*(Lo rellena el GATE-O2.)*

## 0. Puerta de arranque (obligatorio, primero)

```bash
node "../metodología de implementación/herramientas/lotes.mjs" --impl D-065 claim L07 --sesion L07-HHMM
```

## 1. Lee, en este orden y solo esto

1. **`GATE-O2.md` completo.**
2. `prompts/D-065-rotacion-turnos/_CONTEXTO-BASE.md` **§1, §2.2, §2.3, §5.4 (los endpoints de L04),
   §5.5, §6 (C3, C4, C8), §9**.
3. `src/components/Combustibles/ConsumosGrid.jsx` — **el modelo a copiar** para una grilla editable
   grande con buffer local, botón de guardar y estado sucio.
4. `src/hooks/useCombustibles.js` — el modelo del hook (fetch, estados de carga, error por `codigo`).
5. `src/hooks/useApi.js` — el cliente HTTP y cómo traduce el fallo de red a `codigo:'sin_conexion'`.
6. `CLAUDE.md`, convenciones **17** (navegación por hash, componentes **controlados**), **11**
   (el front deriva permisos de la matriz, no los hardcodea) y **16** (ramificar por `codigo`).

## 2. Territorio — lo único que puedes crear o editar

- `src/components/Rotacion/ConfiguracionRotacion.jsx` *(nuevo)*
- `src/components/Rotacion/configuracion-rotacion.test.jsx` *(nuevo)*
- `src/hooks/useRotacion.js` *(nuevo)*
- `prompts/D-065-rotacion-turnos/cierres/L07.md`

**NO tocas** nada más. En particular: `src/BitacorasGecelca3.jsx` y `src/routing/appRoute.js` (los
escribe **L10** en la O4 — tu pantalla todavía **no se ve** en la app y eso está bien),
`src/components/Rotacion/PopupTomaControl.jsx` y `src/hooks/useTomaControl.js` (**L08**, esta ola),
`src/components/Rotacion/CumplimientoRotacion.jsx` y `src/hooks/useCumplimiento.js` (**L09**, esta
ola), `package.json` (gate), y todo el backend.

## 3. Contrato

**Produces** — un componente **controlado** (C8): recibe su estado por props y avisa por callbacks.
**No lee ni escribe el hash**: eso lo hace L10.

```jsx
<ConfiguracionRotacion
  puedeConfigurar={bool}       // deriva de cargo.puede_configurar_rotacion
  onError={(codigo) => {}}     // para que el raíz muestre el aviso global
/>
```

**Consumes** los endpoints de L04 (`_CONTEXTO-BASE.md §5.4`), ya cerrados y probados en la O2:
`GET/POST /api/rotacion/patrones` · `GET/POST /api/rotacion/asignaciones` ·
`POST /api/rotacion/sincronizar-entra` · `GET /api/rotacion/titulares`.

## 4. Trabajo

**Qué se sabe:**

- Esta pantalla se usa **una vez al año**. La claridad pesa más que la densidad: es lo contrario de
  la grilla de COMB, que se usa a diario.
- La lista de personas viene **agrupada por rol tal como las clasifica Entra**. Conteos reales hoy:
  Jefe de Turno 7 · Ing. de Operación 14 · Ing. Químico 2 · Sala de Mando 9 · Caldera 9 ·
  Turbogrupo 9 · Carbón y Caliza 9 · Planta de Agua 9 · Maquinaria 9 · Analista 6.
  **81 personas en total** en roles de rotación. Muestra el conteo por rol: es lo que le permite al
  administrador ver de un vistazo si falta alguien.
- Por persona hay **un solo control**: `G1 / G2 / G3 / G4 / —`. El `—` es "sin grupo", que en la
  práctica es *supernumerario*: no genera titularidad, y esa persona sí verá el popup.
- El patrón se configura **por rol** (decisión R14). Hay un **"copiar patrón de otro rol"** para no
  teclear los mismos 16 números siete veces.
- **Los vectores por defecto que ofrece la pantalla** (los reales de 2026):
  ```
  OPS  T1 = 1,1,3,3,4,4,2,2   T2 = 4,2,2,1,1,3,3,4
  ING  T1 = 1,1,2,2,4,4,3,3   T2 = 4,3,3,1,1,2,2,4
  ```

**La sospecha (verifícala, no te la creas):** que el formulario del patrón deba pedir "el grupo que
arranca". **Con un solo grupo el desfase es ambiguo** — medido: `V1` toma 4 valores distintos en 8
índices, así que "arranca el G3" admite **dos** desfases. El formulario pide **fecha de inicio +
grupo de T1 + grupo de T2 de ese día**, y el backend deriva el desfase único. **Jamás** muestres ni
pidas las palabras "ancla" ni "desfase" (requerimiento §4): son vocabulario interno. Si el backend
responde `400 desfase_ambiguo` o `desfase_imposible`, tradúcelo a un mensaje que diga qué hacer
("Esa combinación de grupos no corresponde a este patrón. Revisa los grupos de T1 y T2 del día de
inicio."), no al slug.

1. `useRotacion.js` — patrones, asignaciones, sincronización. Estados `cargando`/`error`/`guardando`.
2. `ConfiguracionRotacion.jsx` — dos zonas: **el patrón por rol** (arriba) y **las personas por rol**
   (abajo). Botón "Actualizar desde Entra" que llama a `sincronizar-entra` y refresca.
   `503 entra_no_disponible` se muestra como aviso no bloqueante: **el resto de la pantalla sigue
   usable** (CA-6 se apoya en esto).
3. Buffer local + botón Guardar explícito, como COMB. Nada de autosave.
4. `puedeConfigurar === false` → toda la pantalla en **solo lectura**, con chip "Solo lectura"
   (mismo patrón que COMB). El gate real está en el backend (CA-8); esto es la cortesía de UI.
5. El test se escribe **junto** con el componente, no al final.

## 5. Criterios de aceptación y su verificador

| CA | Criterio | Verificador |
|---|---|---|
| **CA-19** | Lista a las personas agrupadas por rol tal como las clasifica Entra, permite asignar `G1..G4` o "sin grupo", y guarda sin recargar la página | `src/components/Rotacion/configuracion-rotacion.test.jsx` — render con un directorio simulado de 3 roles; cambiar un selector marca la pantalla como sucia; Guardar dispara **un** `POST /asignaciones` con el cuerpo correcto; `puedeConfigurar=false` deja todo deshabilitado y muestra el chip |

**Verificador bidireccional:** rompe el agrupamiento (mete a todos en un solo rol) y confirma que el
test se pone rojo; restaura. Salida literal en el cierre.

## 6. Verificación que corres (solo la tuya)

```bash
# Desde la raíz del subrepo. Lote de front: vitest, SIN test-lock y SIN backend efímero.
npm test -- src/components/Rotacion/configuracion-rotacion.test.jsx
npm run build
```

`npm run build` **verde es obligatorio antes de commitear**: un build roto bloquea a los otros dos
chats de la ola.

## 7. Cierre (obligatorio, en este orden)

1. `prompts/D-065-rotacion-turnos/cierres/L07.md` con la plantilla `CIERRE-LOTE.md`.
2. `git commit -m "feat(D-065 L07): pantalla de configuración anual de la rotación" -- src/components/Rotacion/ConfiguracionRotacion.jsx src/components/Rotacion/configuracion-rotacion.test.jsx src/hooks/useRotacion.js prompts/D-065-rotacion-turnos/cierres/L07.md`
   (cuerpo multilínea; **sin firmas de IA**). Cita los SHA.
3. `lotes.mjs --impl D-065 done L07 --sesion <tu sesión>`
4. Mensaje de cierre con la forma fija. En `Para el gate`: enganchar el test de vitest y **qué props
   exactas espera tu componente**, que es lo que L10 va a cablear en la O4.

## Reglas (no negociables)

- `git commit -- <rutas>`; nunca `git add -A`/`.`; nada de stash, reset, checkout, restore, switch,
  rebase, amend, push, merge.
- **Tu componente es controlado y no toca el hash ni el componente raíz.** Si te ves importando
  `appRoute.js`, para: es territorio de L10.
- Ramifica por `codigo`, nunca por el texto del error (D-032/convención 16).
- **Tuteo colombiano estándar en todo copy visible**; sin voseo. Nada de "creá", "generá", "elegí".
- No te asciendas solo: propones `cumple`; lo confirma el gate.
