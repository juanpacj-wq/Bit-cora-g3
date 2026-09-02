// D-065 L09 — vista de cumplimiento de la rotación (superficie C, contrato C6). SOLO consulta: un
// GET por (rango, planta). Sin polling, sin `setInterval` y sin `localStorage`/`sessionStorage`
// (CA-23): el módulo desaparece de la vida diaria entre una carga anual y la siguiente.
//
// Qué mide el reporte: la app ya sabe QUIÉN ESTUVO (turno_participante / conformación, D-045); la
// rotación aporta QUIÉN DEBÍA ESTAR. Un estado `PENDIENTE` significa que ningún TITULAR del patrón
// registró en la bitácora — NO que el turno estuviera vacío (pudo haber tres personas del mismo rol
// trabajando). Esa distinción es la regla central del módulo (CA-15) y la que hace medible el
// reporte; el copy de la pantalla la respeta al pie de la letra.
import { useCallback, useRef, useState } from 'react';
import { api } from './useApi';
import { getTodayBogota, shiftDate } from '../utils/fecha';

// Espejo del backend (`utils/rotacion/cumplimiento.js`): mismos cuatro estados y el mismo ORDEN, que
// es el del resumen y el de la leyenda de la pantalla.
export const ESTADOS = Object.freeze(['PENDIENTE', 'PARCIAL', 'COMPLETO', 'CUBIERTO_POR_RELEVO']);

// Tope del rango que impone C6 (`RANGO_MAX_DIAS` del router). Se replica acá para poder DECIRLO en
// el mensaje de error y para acotar el selector antes de gastar un viaje al servidor; el que manda
// sigue siendo el backend, que responde 400 `rango_excesivo`.
export const RANGO_MAX_DIAS = 93;

// Ventana por defecto del reporte, en días Bogotá. La exporta el módulo —no la aplica el
// componente, que es CONTROLADO (C8)— para que el componente raíz (L10) la use al derivar el estado
// de una ruta `#/rotacion/cumplimiento` sin parámetros, igual que hoy deriva la fecha de COMB.
export const DIAS_POR_DEFECTO = 14;

export function rangoPorDefecto(dias = DIAS_POR_DEFECTO) {
  const hasta = getTodayBogota();
  return { desde: shiftDate(hasta, -(dias - 1)), hasta };
}

// Ramificación por `codigo` (D-032): NUNCA por el texto de la respuesta. Los slugs son los cinco del
// router más los seis del motor del patrón; lo que no está acá cae al texto ya saneado que mandó el
// backend, que es apto para el usuario final. `sin_conexion` no lleva entrada a propósito: su texto
// lo produce `useApi` en un solo lugar y duplicarlo acá es cómo se desincroniza.
const MENSAJES = {
  rango_requerido: 'Escoge una fecha inicial y una final para consultar el cumplimiento.',
  rango_invalido: 'La fecha final debe ser igual o posterior a la inicial.',
  fecha_invalida: 'La fecha no es válida. Usa el formato AAAA-MM-DD con una fecha real.',
  rango_excesivo: `El rango no puede superar ${RANGO_MAX_DIAS} días. Escoge un periodo más corto.`,
  planta_invalida: 'La unidad seleccionada no existe.',
  patron_invalido: 'El patrón de rotación configurado para un rol no es válido. Revisa la configuración anual.',
  vector_invalido: 'El vector del patrón de rotación de un rol no es válido. Revisa la configuración anual.',
  desfase_imposible: 'La combinación de grupos del patrón no existe en la malla. Revisa la configuración anual.',
  desfase_ambiguo: 'La combinación de grupos del patrón es ambigua. Revisa la configuración anual.',
  turno_invalido: 'El turno debe ser 1 o 2.',
};

function traducirError(err) {
  const codigo = err?.codigo ?? null;
  return {
    codigo,
    mensaje: MENSAJES[codigo] ?? err?.message ?? 'No se pudo consultar el cumplimiento de la rotación.',
    esRed: codigo === 'sin_conexion',
  };
}

// El resumen del backend trae SIEMPRE las cuatro claves aunque estén en 0 (hecho §6.9 del GATE-O2),
// pero la pantalla las pinta las cuatro siempre: normalizamos acá para que una respuesta recortada
// no deje huecos en la fila de totales.
function normalizarResumen(resumen) {
  return Object.fromEntries(ESTADOS.map((e) => [e, Number(resumen?.[e]) || 0]));
}

/**
 * Titulares que no entraron, agrupados por persona — el entregable que el usuario pidió por nombre:
 * "qué titulares no entraron y en qué turnos". No es un subproducto de la tabla de estados, así que
 * se deriva aparte y la pantalla le da su propio panel.
 *
 * ENMIENDA D4 (GATE-O3, 2026-09-02, decisión del usuario): el panel mide **asistencia**, no
 * cobertura. Cuenta a CUALQUIER titular con `entro === false`, incluidos los de las filas
 * `CUBIERTO_POR_RELEVO` — que alguien más haya cubierto el turno no cambia el hecho de que el
 * titular no entró. Antes se filtraba por `PENDIENTE`/`PARCIAL` y el panel respondía "¿quién dejó
 * el rol sin cubrir?"; ahora responde "¿quién faltó?", que es lo que se pidió.
 *
 * Por eso NO hay lista de estados acá: la pregunta la responde `entro`, no el estado de la fila.
 * `COMPLETO` no puede traer un ausente por contrato (si lo trajera sería una contradicción del
 * backend, y esconderla sería peor), así que un filtro sería inerte además de frágil frente a un
 * quinto estado (H-L09-3). El estado de cada turno viaja en el resultado para que la pantalla pueda
 * decir cuál de esas ausencias quedó cubierta.
 */
export function ausenciasPorTitular(filas = []) {
  const porPersona = new Map();
  for (const f of filas) {
    for (const t of f?.titulares ?? []) {
      if (t?.entro !== false) continue;
      // `usuario_id` es la identidad; el nombre es solo la etiqueta. Una fila congelada guarda el
      // nombre de la época (D-052) y puede diferir del actual: agrupar por nombre partiría a la
      // misma persona en dos.
      const clave = t.usuario_id ?? `nombre:${t.nombre}`;
      if (!porPersona.has(clave)) {
        porPersona.set(clave, { usuario_id: t.usuario_id ?? null, nombre: t.nombre || 'Sin nombre', turnos: [] });
      }
      porPersona.get(clave).turnos.push({
        fecha_operativa: f.fecha_operativa,
        turno: f.turno,
        cargo_nombre: f.cargo_nombre,
        estado: f.estado,
        congelado: f.congelado !== false,
      });
    }
  }
  return [...porPersona.values()].sort(
    (a, b) => b.turnos.length - a.turnos.length || String(a.nombre).localeCompare(String(b.nombre), 'es-CO')
  );
}

export function useCumplimiento() {
  const [filas, setFilas] = useState([]);
  const [resumen, setResumen] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);   // { codigo, mensaje, esRed } | null
  // Cada lectura lleva su número y solo la última manda. Sin esto, mover el rango dos veces seguidas
  // deja en pantalla lo que responda primero, que no tiene por qué ser lo último que se pidió (mismo
  // problema que resolvió D-061 en la grilla de COMB).
  const secuenciaRef = useRef(0);

  const cargar = useCallback(async ({ desde, hasta, planta } = {}) => {
    const mio = ++secuenciaRef.current;
    setCargando(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ desde, hasta, planta_id: planta });
      const r = await api.get(`/api/rotacion/cumplimiento?${qs.toString()}`);
      if (mio !== secuenciaRef.current) return;
      setFilas(Array.isArray(r?.filas) ? r.filas : []);
      setResumen(normalizarResumen(r?.resumen));
    } catch (e) {
      if (mio !== secuenciaRef.current) return;
      setError(traducirError(e));
      setFilas([]);
      setResumen(null);
    } finally {
      if (mio === secuenciaRef.current) setCargando(false);
    }
  }, []);

  return { filas, resumen, cargando, error, cargar };
}
