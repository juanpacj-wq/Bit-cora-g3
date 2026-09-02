// D-035: routing por hash de la app. Módulo PURO (sin React/DOM) y testeable: la URL es la
// fuente única de verdad de la sección activa + su subestado, de modo que un F5 o un deep-link
// dejen al usuario exactamente donde estaba. El hash (#) no viaja al server ni colisiona con el
// callback OIDC (?auth=…), así que no afecta el redirect de Entra (que aterriza en `/`).
//
// Forma canónica de las rutas:
//   #/op24h?mes=YYYY-MM           → MAND (Operación 24h; el mes del libro F03, D-058)
//   #/disp?planta=GEC3|GEC32      → DISP (tab de planta)
//   #/comb?fecha=YYYY-MM-DD       → COMB (fecha seleccionada)
//   #/b/<codigo>                  → bitácora genérica (ej. #/b/AUTOR)
//   #/historicos                  → vista de históricos
//   #/rotacion                    → rotación de turnos: configuración anual (D-065)
//   #/rotacion/cumplimiento?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&planta=GEC3|GEC32
//                                 → rotación de turnos: vista de cumplimiento (D-065)
//   vacío / desconocido           → fallback (vista 'bitacoras', codigo null) → el caller cae a
//                                    la primera bitácora permitida (comportamiento legacy).
import { getTodayBogota, getCurrentMonthBogota } from '../utils/fecha';

// Las 3 bitácoras con UI propia tienen slug corto; el resto usa `b/<codigo>`.
export const SLUG_BY_CODIGO = { MAND: 'op24h', DISP: 'disp', COMB: 'comb' };
export const CODIGO_BY_SLUG = { op24h: 'MAND', disp: 'DISP', comb: 'COMB' };

// D-053: códigos retirados → su sucesor. `parseHash` los traduce, `buildHash` nunca los emite (la
// URL se reescribe al canónico). Sin esto un deep-link viejo no falla ni avisa: el `.find()` del
// dashboard no matchea, cae al fallback mudo `bitacorasPermitidas[0]` y `replaceState` borra la URL
// original — el usuario aterriza en otra bitácora sin entender por qué.
// SALA se partió por rol (SALAJDT/SALAING/SALAOP); SALAJDT es la MISMA fila (bitacora_id=14
// renombrada), así que es el sucesor correcto de un `#/b/SALA` guardado en favoritos.
export const CODIGO_ALIAS = { SALA: 'SALAJDT' };

// Dominio Gecelca: solo dos plantas físicas térmicas. Hardcode deliberado para no acoplar el
// routing a un módulo de componentes (los tabs de DISP exponen ambas, independientes del login).
const PLANTAS_VALIDAS = ['GEC3', 'GEC32'];
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
// D-058: mismo patrón que valida el backend en `GET /reporte-mensual` (mes 01..12, no 00 ni 13).
const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// Validadores puros: param inválido → se descarta (no rompe la navegación, cae al default del
// componente). La fecha futura se rechaza con paridad al 400 `fecha_futura` del backend COMB.
export function plantaValida(p) {
  return typeof p === 'string' && PLANTAS_VALIDAS.includes(p);
}
export function fechaValida(f) {
  return typeof f === 'string' && FECHA_RE.test(f) && f <= getTodayBogota();
}
// D-058: el mes del libro F03. Mismo criterio que la fecha de COMB — el futuro se descarta, con
// paridad al 400 `mes_futuro` del backend. La comparación de cadenas `YYYY-MM` ordena igual que el
// calendario, así que no hace falta parsear.
export function mesValido(m) {
  return typeof m === 'string' && MES_RE.test(m) && m <= getCurrentMonthBogota();
}

// parseHash('#/comb?fecha=2026-06-20') → { vista, codigo, params }
// - vista:  'bitacoras' | 'historicos' | 'rotacion' | 'rotacion-cumplimiento'
// - codigo: código de bitácora (MAND/DISP/COMB/AUTOR/…) o null si no aplica/desconocido
// - params: { planta? } para DISP, { fecha? } para COMB, { mes? } para MAND,
//           { desde?, hasta?, planta? } para 'rotacion-cumplimiento' (solo si pasan el validador)
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

  // D-065 (contrato C8): el módulo de rotación NO es una bitácora — son secciones propias del
  // dashboard, como #/historicos, así que viajan en `vista` y `codigo` queda en null. La
  // configuración anual (#/rotacion) no tiene subestado; el cumplimiento sí, y sus tres params se
  // validan con los MISMOS helpers de siempre: un param inválido se descarta y el caller cae a su
  // default (últimos 14 días + unidad de la sesión), nunca rompe la navegación.
  if (head === 'rotacion') {
    const sub = segments[1] ? segments[1].toLowerCase() : null;
    if (!sub) return { vista: 'rotacion', codigo: null, params: {} };
    if (sub !== 'cumplimiento') return fallback;
    const paramsRot = {};
    const desde = query.get('desde');
    const hasta = query.get('hasta');
    const plantaRot = query.get('planta');
    if (fechaValida(desde)) paramsRot.desde = desde;
    if (fechaValida(hasta)) paramsRot.hasta = hasta;
    if (plantaValida(plantaRot)) paramsRot.planta = plantaRot;
    return { vista: 'rotacion-cumplimiento', codigo: null, params: paramsRot };
  }

  // Genérica: #/b/<codigo>. El código se normaliza a mayúsculas (los códigos de bitácora lo son) y
  // se traduce si es un código retirado (D-053).
  if (head === 'b') {
    const crudo = segments[1] ? segments[1].toUpperCase() : null;
    if (!crudo) return fallback;
    return { vista: 'bitacoras', codigo: CODIGO_ALIAS[crudo] || crudo, params: {} };
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
  } else if (codigo === 'MAND') {
    // D-058: el mes del libro F03 es subestado deep-linkeable. NO es el día de la grilla: esa sigue
    // siendo siempre HOY (D-017/D-056) y no tiene selector de fecha — son cosas distintas.
    const mes = query.get('mes');
    if (mesValido(mes)) params.mes = mes;
  }
  return { vista: 'bitacoras', codigo, params };
}

// buildHash({ vista, codigo, params }) → '#/...' canónico (inverso de parseHash).
// Solo serializa params válidos; un param inválido/ausente se omite (la URL queda limpia).
export function buildHash({ vista, codigo, params } = {}) {
  if (vista === 'historicos') return '#/historicos';
  // D-065: las dos secciones de rotación se identifican por `vista` (no tienen `codigo`), así que
  // van ANTES del corte por `!codigo`. El orden de la query es fijo (desde, hasta, planta) para que
  // buildHash sea determinista: el dashboard compara `buildHash(desired) === location.hash` antes de
  // navegar, y un orden variable lo haría reescribir la URL en cada render.
  if (vista === 'rotacion') return '#/rotacion';
  if (vista === 'rotacion-cumplimiento') {
    const partes = [];
    if (fechaValida(params?.desde)) partes.push(`desde=${params.desde}`);
    if (fechaValida(params?.hasta)) partes.push(`hasta=${params.hasta}`);
    if (plantaValida(params?.planta)) partes.push(`planta=${params.planta}`);
    return `#/rotacion/cumplimiento${partes.length ? `?${partes.join('&')}` : ''}`;
  }
  if (!codigo) return '#/';

  const slug = SLUG_BY_CODIGO[codigo];
  if (!slug) return `#/b/${codigo}`;

  let query = '';
  if (codigo === 'DISP' && plantaValida(params?.planta)) {
    query = `?planta=${params.planta}`;
  } else if (codigo === 'COMB' && fechaValida(params?.fecha)) {
    query = `?fecha=${params.fecha}`;
  } else if (codigo === 'MAND' && mesValido(params?.mes)) {
    query = `?mes=${params.mes}`;
  }
  return `#/${slug}${query}`;
}
