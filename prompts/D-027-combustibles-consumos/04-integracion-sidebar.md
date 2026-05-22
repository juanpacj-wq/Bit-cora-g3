# Prompt 04 — Integración sidebar (D-027)

**Working directory:** `Bit-cora-g3/`
**Plan global:** `prompts/D-027-combustibles-consumos/00-README.md`
**Pre-requisitos:** prompts 01–03 corridos. `ConsumosGrid.jsx` ya existe.

## Tu tarea

Editar `src/BitacorasGecelca3.jsx` para:

(a) Agregar entrada `Combustibles` a `CATEGORIAS`.
(b) Agregar caso `'COMB'` al switch de routing que decide qué componente montar.
(c) Header condicional (`BarraEstado`): ocultar filtros F11 y botones de turno/cierre cuando la bitácora activa es COMB.
(d) `SIN_BADGE_CODIGOS.add('COMB')` — Combustibles no muestra contador de pendientes.

NO toques backend ni componentes (ya hechos).

## (a) Entrada en `CATEGORIAS`

En `src/BitacorasGecelca3.jsx` línea ~694 hay un array `CATEGORIAS`. Agregá una entrada nueva:

```js
const CATEGORIAS = [
  {
    codigo: 'SALA_DE_MANDOS',
    nombre: 'Sala de Mando',
    nombreCorto: 'Sala',
    icono: 'MonitorCog',
    bitacora_codigos: ['DISP', 'MAND'],
  },
  // NUEVO:
  {
    codigo: 'COMBUSTIBLES',
    nombre: 'Combustibles',
    nombreCorto: 'Comb',
    icono: 'Flame',
    bitacora_codigos: ['COMB'],
  },
];
```

Verificá que el icono `Flame` esté en el `ICON_MAP` de Lucide. Si no está, agregalo:

```js
import { ..., Flame } from 'lucide-react';
const ICON_MAP = { ..., Flame };
```

## (b) Switch de routing

En `BitacorasGecelca3.jsx` línea ~1855 hay un switch que decide qué componente renderiza:

```jsx
{bitacoraActiva?.codigo === 'MAND' ? (
  <SalaDeMandoGrid ... />
) : bitacoraActiva?.codigo === 'DISP' ? (
  <DisponibilidadDashboard ... />
) : (
  <GrillaRegistros ... />
)}
```

Agregá el caso nuevo:

```jsx
{bitacoraActiva?.codigo === 'MAND' ? (
  <SalaDeMandoGrid ... />
) : bitacoraActiva?.codigo === 'DISP' ? (
  <DisponibilidadDashboard ... />
) : bitacoraActiva?.codigo === 'COMB' ? (
  <ConsumosGrid
    bitacora={bitacoraActiva}
    plantaId={sesion?.planta_id}
    puedeCrear={puedeCrear}
    showToast={showToast}
  />
) : (
  <GrillaRegistros ... />
)}
```

No olvides el import:

```js
import { ConsumosGrid } from './components/Combustibles/ConsumosGrid.jsx';
```

## (c) Header condicional (`BarraEstado`)

Buscá `BarraEstado` (componente que renderiza el header con filtros/botones) en `BitacorasGecelca3.jsx` línea ~947. Hoy tiene la línea:

```js
const isMand = bitacora?.codigo === 'MAND';
```

Agregale:

```js
const isMand = bitacora?.codigo === 'MAND';
const isComb = bitacora?.codigo === 'COMB';
const isSinHeader = isMand || isComb;  // ambos comparten "no necesita filtros/botones genéricos"
```

Y cambiá las condiciones que hoy usan `!isMand` por `!isSinHeader`:

```js
if (bitacora?.codigo !== 'MAND')        →   if (!isSinHeader)
if (!isMand)                            →   if (!isSinHeader)
if (!isMand && onFinalizarTurno)        →   if (!isSinHeader && onFinalizarTurno)
if (!isMand && esJefeTurno && ...)      →   if (!isSinHeader && esJefeTurno && ...)
if (!isMand && esJefeTurno)             →   if (!isSinHeader && esJefeTurno)
```

(MAND mantiene su botón "Guardar" en el header; para COMB, el botón Guardar lo provee el propio `ConsumosGrid` adentro, así que el header queda completamente limpio. Si querés homogeneizar, podés exponer un `registerSaveHandler` similar al `registerMandSave` y mostrar el Guardar en el header — pero NO lo hagas en V1 para mantener el diff chico.)

## (d) `SIN_BADGE_CODIGOS`

Buscá `SIN_BADGE_CODIGOS` (línea ~706 según D-022). Agregale `'COMB'`:

```js
const SIN_BADGE_CODIGOS = new Set(['DISP', 'COMB']);
```

Consumos no tiene "pendientes" semánticamente — es un report que se ingresa, no eventos que se cierran.

## Importante (gotchas)

1. **El componente `CategoriaTab`** ya está implementado y maneja flyouts/popovers cuando una categoría tiene más de 1 bitácora. Para Combustibles, hoy solo tiene 1 ítem ("Consumos"), así que el flyout va a tener un solo botón — está OK, el patrón se mantiene listo para agregar más ítems a futuro.

2. **Filtrado de categorías visibles** (línea ~1505): la categoría aparece SOLO si tiene al menos 1 bitácora con `puede_ver=1` para el cargo logueado. Eso garantiza que cargos sin permiso a COMB no la ven en el sidebar.

3. **`activa` y `oculta`** de `lov_bit.bitacora`: la fila COMB se seedeó con `activa=1, oculta=0`, así que sí aparece en el sidebar (filtrada por permiso de cargo).

4. **Cargar el catálogo de bitácoras**: ya hay un fetch a `/api/catalogos/bitacoras` o similar que carga `lov_bit.bitacora` activas. La nueva fila `COMB` aparece automáticamente.

5. **Permisos del usuario**: `puedeCrear` se calcula así (línea ~1534):
   ```js
   const permisoActivo = catalogos.permisos.find((p) => p.bitacora_id === activeBitacora);
   const puedeCrear = !!permisoActivo?.puede_crear;
   ```
   Esto ya funciona para COMB sin cambios — pasa el flag al `ConsumosGrid`, que lo usa para deshabilitar inputs y el botón Guardar.

6. **Test de paridad**: después de tu cambio, todos los tests existentes (DISP, MAND, etc.) deben seguir pasando. La integración del sidebar no rompe nada del runtime backend.

## Verificación

```powershell
# Build sin errores
cd Bit-cora-g3
npm run lint
npm run build

# Smoke manual:
npm run dev
# Levantar backend en paralelo: cd server && node --watch --env-file=../.env server.js

# Login como Operador Carbón y Caliza GEC3:
# - Sidebar muestra "Combustibles" como categoría junto a "Sala de Mando"
# - Click → flyout muestra "Consumos"
# - Click en "Consumos" → ConsumosGrid se monta
# - Header: NO aparecen "Nuevo Registro", "Finalizar Turno", "Cerrar Turno", "Cerrar Masivo", ni filtros F11
# - Grilla operativa con selector de fecha, inputs, botón Guardar funciona

# Login como Ingeniero Químico:
# - Sidebar TAMBIÉN muestra "Combustibles" → "Consumos" (tiene puede_ver=1)
# - ConsumosGrid se monta, pero los inputs están disabled (puedeCrear=false)
# - Botón Guardar disabled

# Login como Gerente de Producción:
# - Mismo comportamiento read-only

# Tab "Sala de Mando" sigue funcionando idénticamente para DISP/MAND
# Cualquier otra bitácora genérica (CAL, AGUA, etc.) sigue funcionando con GrillaRegistros
```

## Lo que NO hagas en este prompt

- NO toques `ConsumosGrid.jsx` ni el hook (ya hechos).
- NO toques backend (ya hechos).
- NO escribas tests (prompt 05).
- NO escribas docs (prompt 06).
- NO agregues lógica de "registerSaveHandler" para mover el botón Guardar al header. Mantener simple.
