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
export const ESTADO_COLORS = {
  Disponible:   { bg: BRAND.green, text: NEUTRAL.surface, badge: BRAND.greenDeep, icon: 'CheckCircle2' },
  'En Reserva': { bg: '#FFC107',   text: NEUTRAL.fgInk,   badge: '#A37500',       icon: 'Clock' },
  Indisponible: { bg: '#DC3545',   text: NEUTRAL.surface, badge: '#A41E2A',       icon: 'XCircle' },
};

export const ESTADOS = ['Disponible', 'En Reserva', 'Indisponible'];

export const PLANTAS = ['GC3', 'GC32'];
