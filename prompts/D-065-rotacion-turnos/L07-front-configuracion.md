# D-065 · Ola O3 · Lote L07 — Pantalla de configuración anual (superficie A, front)

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
