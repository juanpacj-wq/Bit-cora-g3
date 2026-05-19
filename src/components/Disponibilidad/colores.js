// F13: paleta corporativa (Paleta_De_colores.png + NeutralesPaleta_De_colores.png).
// Referenciada también por COLORS de BitacorasGecelca3.jsx — los hex coinciden.
export const BRAND = {
  green: '#31a354',
  greenDeep: '#006f36',
  navy: '#003566',
  navyDeep: '#001d3d',
  ink: '#011027',
};

export const NEUTRAL = {
  surface: '#FFFFFF',
  canvas: '#F5F7FA',
  subtle: '#EBEFF4',
  hairline: '#D6DDE6',
  fgTer: '#5C6877',
  fgInk: '#011027',
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
  'En Servicio':  { bg: BRAND.green, text: NEUTRAL.surface, badge: BRAND.greenDeep, icon: 'CheckCircle2' },
  'En Reserva':   { bg: '#1e40af',   text: NEUTRAL.surface, badge: '#1e3a8a',       icon: 'Clock' },
  Indisponible:   { bg: '#DC3545',   text: NEUTRAL.surface, badge: '#A41E2A',       icon: 'XCircle' },
  Mantenimiento:  { bg: '#FFC107',   text: NEUTRAL.fgInk,   badge: '#A37500',       icon: 'Wrench' },
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
