// Rediseño visual DISP (look dashboard.html): paleta teal/celeste del mockup.
// Estos tokens SOLO se usan dentro de components/Disponibilidad/ (verificado), por lo que
// el cambio de paleta no afecta otras bitácoras. Los mismos hex viven como variables CSS en
// disponibilidad.css (scopeadas a .disp-root); acá se exponen para los estilos dinámicos
// por estado (style={{...}}).
export const BRAND = {
  green: '#16b486',
  greenDeep: '#0f9e74',
  navy: '#244651',
  navyDeep: '#0f3d4a',
  ink: '#244651',
};

export const NEUTRAL = {
  surface: '#FFFFFF',
  canvas: '#eef4f5',
  subtle: '#e6eef0',
  hairline: '#e6eef0',
  fgTer: '#9bb3ba',   // muted
  fgInk: '#244651',   // ink-dark
  fgBody: '#4a6670',  // ink (texto de cuerpo)
};

// Mapa estado → tokens. `icon` es el nombre del componente lucide-react que el
// consumidor debe resolver (no se importa acá para no acoplar el módulo a JSX).
//
// D-024 (2026-05-15): rebrand de 3 → 4 estados:
//   En Servicio  (verde)   — disponible y generando (codigo=1)
//   En Reserva   (azul)    — disponible, fuera de servicio (codigo=0)
//   Indisponible (rojo)    — salida forzada (codigo=-1)
//   Mantenimiento(amarillo)— consignación / salida planeada (codigo=-1)
// Indisponible y Mantenimiento comparten codigo=-1; el discriminador visual y semántico
// es el string `evento`.
export const ESTADO_COLORS = {
  'En Servicio':  { bg: BRAND.green,   text: NEUTRAL.surface, badge: BRAND.greenDeep, icon: 'CheckCircle2', cls: 'serv' },
  'En Reserva':   { bg: '#2f9fe0',     text: NEUTRAL.surface, badge: '#1f7fb8',       icon: 'Clock',        cls: 'res'  },
  Indisponible:   { bg: '#d9627a',     text: NEUTRAL.surface, badge: '#c44862',       icon: 'XCircle',      cls: 'ind'  },
  Mantenimiento:  { bg: '#e0a83c',     text: NEUTRAL.surface, badge: '#bd8a26',       icon: 'Wrench',       cls: 'mant' },
};

export const ESTADOS = ['En Servicio', 'En Reserva', 'Indisponible', 'Mantenimiento'];

// Hints operativos que se muestran junto a cada opción en el dropdown del modal.
// Pueden cambiar sin afectar el contrato — son texto UI.
export const ESTADO_HINTS = {
  'En Servicio':  'máquina operando',
  'En Reserva':   'lista para operar, no operando',
  Indisponible:   'Salida forzada',
  Mantenimiento:  'Salida planeada / consignación',
};

// `planta_id` reales en `lov_bit.planta` (seed en Bit-cora-g3/server/db.js).
// El plan_disp.md usa "GC3"/"GC32" como nombre coloquial pero los IDs son GEC3/GEC32.
export const PLANTAS = ['GEC3', 'GEC32'];
