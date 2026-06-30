// D-035: routing por hash de la app. Módulo PURO (sin React/DOM) y testeable: la URL es la
// fuente única de verdad de la sección activa + su subestado, de modo que un F5 o un deep-link
// dejen al usuario exactamente donde estaba. El hash (#) no viaja al server ni colisiona con el
// callback OIDC (?auth=…), así que no afecta el redirect de Entra (que aterriza en `/`).
//
// Forma canónica de las rutas:
//   #/op24h                       → MAND (Operación 24h)
//   #/disp?planta=GEC3|GEC32      → DISP (tab de planta)
//   #/comb?fecha=YYYY-MM-DD       → COMB (fecha seleccionada)
//   #/b/<codigo>                  → bitácora genérica (ej. #/b/AUTOR)
//   #/historicos                  → vista de históricos
//   vacío / desconocido           → fallback (vista 'bitacoras', codigo null) → el caller cae a
//                                    la primera bitácora permitida (comportamiento legacy).
import { getTodayBogota } from '../utils/fecha';

// Las 3 bitácoras con UI propia tienen slug corto; el resto usa `b/<codigo>`.
export const SLUG_BY_CODIGO = { MAND: 'op24h', DISP: 'disp', COMB: 'comb' };
export const CODIGO_BY_SLUG = { op24h: 'MAND', disp: 'DISP', comb: 'COMB' };

// Dominio Gecelca: solo dos plantas físicas térmicas. Hardcode deliberado para no acoplar el
// routing a un módulo de componentes (los tabs de DISP exponen ambas, independientes del login).
const PLANTAS_VALIDAS = ['GEC3', 'GEC32'];
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validadores puros: param inválido → se descarta (no rompe la navegación, cae al default del
// componente). La fecha futura se rechaza con paridad al 400 `fecha_futura` del backend COMB.
export function plantaValida(p) {
  return typeof p === 'string' && PLANTAS_VALIDAS.includes(p);
}
export function fechaValida(f) {
  return typeof f === 'string' && FECHA_RE.test(f) && f <= getTodayBogota();
}

// parseHash('#/comb?fecha=2026-06-20') → { vista, codigo, params }
// - vista:  'bitacoras' | 'historicos'
// - codigo: código de bitácora (MAND/DISP/COMB/AUTOR/…) o null si no aplica/desconocido
// - params: { planta? } para DISP, { fecha? } para COMB (solo si pasan el validador)
export function parseHash(hashString) {
  const fallback = { vista: 'bitacoras', codigo: null, params: {} };
  const raw = String(hashString || '').replace(/^#/, '').replace(/^\/+/, '');
  if (!raw) return fallback;

  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  if (segments.length === 0) return fallback;

  const head = segments[0].toLowerCase();
  const query = new URLSearchParams(queryPart || '');

  if (head === 'historicos') return { vista: 'historicos', codigo: null, params: {} };

  // Genérica: #/b/<codigo>. El código se normaliza a mayúsculas (los códigos de bitácora lo son).
  if (head === 'b') {
    const codigo = segments[1] ? segments[1].toUpperCase() : null;
    if (!codigo) return fallback;
    return { vista: 'bitacoras', codigo, params: {} };
  }

  const codigo = CODIGO_BY_SLUG[head];
  if (!codigo) return fallback;

  const params = {};
  if (codigo === 'DISP') {
    const planta = query.get('planta');
    if (plantaValida(planta)) params.planta = planta;
  } else if (codigo === 'COMB') {
    const fecha = query.get('fecha');
    if (fechaValida(fecha)) params.fecha = fecha;
  }
  return { vista: 'bitacoras', codigo, params };
}

// buildHash({ vista, codigo, params }) → '#/...' canónico (inverso de parseHash).
// Solo serializa params válidos; un param inválido/ausente se omite (la URL queda limpia).
export function buildHash({ vista, codigo, params } = {}) {
  if (vista === 'historicos') return '#/historicos';
  if (!codigo) return '#/';

  const slug = SLUG_BY_CODIGO[codigo];
  if (!slug) return `#/b/${codigo}`;

  let query = '';
  if (codigo === 'DISP' && plantaValida(params?.planta)) {
    query = `?planta=${params.planta}`;
  } else if (codigo === 'COMB' && fechaValida(params?.fecha)) {
    query = `?fecha=${params.fecha}`;
  }
  return `#/${slug}${query}`;
}
