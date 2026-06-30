import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// Fuentes locales (@fontsource, sin CDN en runtime — mismo criterio que DISP).
import '@fontsource/archivo/400.css';
import '@fontsource/archivo/600.css';
import '@fontsource/archivo/700.css';
import '@fontsource/archivo/800.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/jetbrains-mono/700.css';
import { useCombustibles } from '../../hooks/useCombustibles';
import { SelectorFecha } from './SelectorFecha';
import { HEATMAP_MAX_TON, HEATMAP_RAMP, tint } from './colores';
import './combustibles.css';

// D-027: grilla de Consumos de Combustibles. Patrón paralelo a SalaDeMandoGrid:
// buffer-en-memoria editable + snapshot del server + diff() al guardar.
//
// Columnas: alimentadores de la planta + columna virtual "Total Carbón" (suma vivo de
// tipo='ALIMENTADOR' en el buffer, no entra al diff) + Caliza + ACPM.
// Filas: 24 periodos (1..24, donde periodo N corresponde a la hora N-1 Bogotá).
//
// Sin badge (SIN_BADGE_CODIGOS.add('COMB') del prompt 04 → no dispara
// `bitacora:counts-refresh`).
const PERIODOS = Array.from({ length: 24 }, (_, i) => i + 1);

// D-034: motivos estructurados del backend → texto amigable es-CO para los toasts.
const MOTIVO_TEXTO = {
  cantidad_excede_max: 'una o más cantidades superan el máximo permitido',
  cantidad_invalida: 'cantidad inválida',
  periodo_fuera_rango: 'periodo fuera de rango',
  combustible_no_pertenece_planta: 'combustible no corresponde a la planta',
};

// D-035: `fecha`/`onFechaChange` son controlados por el dashboard (la URL es la fuente de verdad
// para deep-link/F5). El resto de la lógica (snapshot/buffer, diff, validaciones D-034,
// beforeunload) queda intacta.
export default function ConsumosGrid({ bitacora, plantaId, puedeCrear, showToast, fecha, onFechaChange }) {
  const { loading, getConsumos, guardarBatch } = useCombustibles();

  const [catalogo, setCatalogo] = useState([]);
  const [snapshot, setSnapshot] = useState({});  // shape: { "<periodo>": { "<combustible_id>": { cantidad, detalle, ... } } }
  const [buffer, setBuffer] = useState({});
  const [error, setError] = useState(null);

  // showToast estable a través de re-renders (mismo patrón que SalaDeMandoGrid).
  const showToastRef = useRef(showToast);
  useEffect(() => { showToastRef.current = showToast; }, [showToast]);

  // Refetch al cambiar planta o fecha. Descartar el buffer es OK porque el `beforeunload`
  // y la confirmación al cambiar de fecha (si se agrega más adelante) cubren el caso.
  const refetch = useCallback(async () => {
    if (!plantaId) return;
    try {
      setError(null);
      const r = await getConsumos(plantaId, fecha);
      setCatalogo(r.catalogo || []);
      setSnapshot(r.celdas || {});
      setBuffer(deepClone(r.celdas || {}));
    } catch (e) {
      setError(e);
    }
  }, [plantaId, fecha, getConsumos]);

  useEffect(() => { refetch(); }, [refetch]);

  const hayCambios = useMemo(
    () => JSON.stringify(buffer) !== JSON.stringify(snapshot),
    [buffer, snapshot]
  );

  // Advertencia al cerrar la pestaña con cambios sin guardar (igual que SalaDeMando).
  useEffect(() => {
    if (!hayCambios) return;
    const h = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [hayCambios]);

  const setCelda = (periodo, combustibleId, cantidad) => {
    setBuffer((b) => {
      const next = { ...b };
      const p = String(periodo);
      const k = String(combustibleId);
      const fila = next[p] ? { ...next[p] } : {};
      const esVacio = cantidad === null || cantidad === 0 || Number.isNaN(cantidad);
      if (esVacio) {
        delete fila[k];
        if (Object.keys(fila).length === 0) delete next[p];
        else next[p] = fila;
      } else {
        fila[k] = { ...(fila[k] || {}), cantidad };
        next[p] = fila;
      }
      return next;
    });
  };

  // Total Carbón por periodo: suma de tipo='ALIMENTADOR' del buffer (no incluye Caliza ni ACPM).
  // Coincide con la fórmula de bitacora.v_consumo_periodo.total_carbon_ton del backend.
  const totalCarbonPeriodo = useCallback((periodo) => {
    const p = String(periodo);
    const fila = buffer[p] || {};
    let total = 0;
    for (const cb of catalogo) {
      if (cb.tipo !== 'ALIMENTADOR') continue;
      const v = fila[String(cb.combustible_id)]?.cantidad;
      if (typeof v === 'number' && Number.isFinite(v)) total += v;
    }
    return total;
  }, [buffer, catalogo]);

  // diff: { periodo, combustible_id, cantidad, detalle } por celda que difiere snapshot vs buffer.
  // - solo en snapshot ⇒ cantidad=null (backend DELETE)
  // - solo en buffer   ⇒ INSERT con cantidad
  // - en ambos con cantidad/detalle distintos ⇒ UPDATE
  const calcularDiff = () => {
    const out = [];
    const keys = new Set([...Object.keys(buffer), ...Object.keys(snapshot)]);
    for (const p of keys) {
      const bFila = buffer[p] || {};
      const sFila = snapshot[p] || {};
      const cKeys = new Set([...Object.keys(bFila), ...Object.keys(sFila)]);
      for (const cid of cKeys) {
        const b = bFila[cid];
        const s = sFila[cid];
        if (!b && s) {
          out.push({ periodo: Number(p), combustible_id: Number(cid), cantidad: null });
        } else if (b && !s) {
          out.push({ periodo: Number(p), combustible_id: Number(cid), cantidad: b.cantidad, detalle: b.detalle ?? null });
        } else if (b && s && (Number(b.cantidad) !== Number(s.cantidad) || (b.detalle ?? null) !== (s.detalle ?? null))) {
          out.push({ periodo: Number(p), combustible_id: Number(cid), cantidad: b.cantidad, detalle: b.detalle ?? null });
        }
      }
    }
    return out;
  };

  const onGuardar = async () => {
    try {
      const celdasDiff = calcularDiff();
      if (celdasDiff.length === 0) {
        showToastRef.current?.('Sin cambios para guardar', 'info');
        return;
      }
      const resp = await guardarBatch({ planta_id: plantaId, fecha, celdas: celdasDiff });
      const { creados = 0, actualizados = 0, eliminados = 0 } = resp.resumen || {};
      showToastRef.current?.(`Guardado: ${creados} nuevos, ${actualizados} actualizados, ${eliminados} eliminados`, 'success');
      await refetch();
    } catch (e) {
      // Errores estructurados del backend (cantidad inválida, periodo OOR, etc.)
      if (Array.isArray(e.errores) && e.errores.length > 0) {
        const motivos = [...new Set(e.errores.map((x) => MOTIVO_TEXTO[x.motivo] || x.motivo))].join(', ');
        showToastRef.current?.(`Errores de validación: ${motivos}`, 'error');
      } else {
        showToastRef.current?.(`Error al guardar: ${e.message || 'desconocido'}`, 'error');
      }
    }
  };

  // Reorden de columnas: alimentadores → Total Carbón (virtual) → Caliza → ACPM.
  // La columna virtual lleva `virtual: true` y un id 'TOTAL' que no se confunde con ningún
  // combustible_id real (entero positivo de la BD).
  const columnasOrdenadas = useMemo(() => {
    const alim = catalogo.filter((c) => c.tipo === 'ALIMENTADOR');
    const caliza = catalogo.filter((c) => c.tipo === 'CALIZA');
    const acpm = catalogo.filter((c) => c.tipo === 'ACPM');
    return [
      ...alim,
      { combustible_id: 'TOTAL', nombre: 'Total Carbón', unidad: 'Ton', tipo: 'TOTAL', virtual: true },
      ...caliza,
      ...acpm,
    ];
  }, [catalogo]);

  // D-034: límite físico por combustible (data-driven desde cantidad_max del catálogo).
  // maxPorId: clave string (igual que el buffer). null = sin tope.
  const maxPorId = useMemo(() => {
    const m = new Map();
    for (const c of catalogo) {
      m.set(String(c.combustible_id), c.cantidad_max == null ? null : Number(c.cantidad_max));
    }
    return m;
  }, [catalogo]);

  // Máximo del heatmap = mayor cantidad_max entre alimentadores (fallback a la constante).
  const maxAlim = useMemo(() => {
    let mx = 0;
    for (const c of catalogo) {
      if (c.tipo === 'ALIMENTADOR' && c.cantidad_max != null) mx = Math.max(mx, Number(c.cantidad_max));
    }
    return mx > 0 ? mx : HEATMAP_MAX_TON;
  }, [catalogo]);

  // Celdas del buffer cuyo valor supera su cantidad_max → bloquean el guardado (front).
  const celdasInvalidas = useMemo(() => {
    let n = 0;
    for (const p of Object.keys(buffer)) {
      for (const cid of Object.keys(buffer[p])) {
        const max = maxPorId.get(cid);
        const v = buffer[p][cid]?.cantidad;
        if (max != null && typeof v === 'number' && v > max) n++;
      }
    }
    return n;
  }, [buffer, maxPorId]);
  const hayInvalidos = celdasInvalidas > 0;

  return (
    // .comb-root (flex-1 + scroll DENTRO de .comb-scroll): el parent en BitacorasGecelca3.jsx
    // es `h-screen flex flex-col`; sin esto, el grid (24 periodos × N combustibles) excede el
    // viewport y el page document hace scroll vertical, empujando BitacoraTabs fuera de vista
    // (softlock de navegación). Mismo patrón anti-softlock que SalaDeMando y DisponibilidadDashboard.
    <div className="comb-root">
      <div className="comb-card">
        <div className="comb-topbar">
          <div className="comb-topbar-left">
            <h2 className="comb-title">
              {bitacora?.nombre ? `${bitacora.nombre} · Mapa de carga` : 'Consumos · Mapa de carga'}
            </h2>
            <SelectorFecha fecha={fecha} onChange={onFechaChange} disabled={loading} />
          </div>
          <div className="comb-topbar-right">
            {/* Leyenda de escala: chips desde HEATMAP_RAMP → coinciden con tint() siempre. */}
            <div className="comb-legend">
              bajo
              <span className="comb-legend-bar">
                {HEATMAP_RAMP.map((c) => (
                  <i key={c} style={{ background: c }} />
                ))}
              </span>
              alto
            </div>
            <button
              type="button"
              onClick={onGuardar}
              disabled={!hayCambios || !puedeCrear || loading || hayInvalidos}
              className="comb-save"
            >
              Guardar
            </button>
          </div>
        </div>

        {hayInvalidos && (
          <div className="comb-alert">
            ⚠ {celdasInvalidas} {celdasInvalidas === 1 ? 'celda excede' : 'celdas exceden'} el máximo permitido
          </div>
        )}

        {loading && <div className="comb-state loading">Cargando...</div>}
        {error && <div className="comb-state error">Error: {error.message || 'desconocido'}</div>}
        {!loading && catalogo.length === 0 && (
          <div className="comb-state empty">Sin combustibles configurados para esta planta.</div>
        )}

        {catalogo.length > 0 && (
          <div className="comb-scroll">
            <table>
              <thead>
                <tr>
                  <th className="comb-th-first">Periodo</th>
                  {columnasOrdenadas.map((c) => (
                    <th key={String(c.combustible_id)}>
                      <span>{c.nombre}</span>
                      <span className="comb-unit">{c.unidad}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PERIODOS.map((p) => (
                  <tr key={p}>
                    <td className="comb-per">
                      P{p}
                      <small>{String(p - 1).padStart(2, '0')}h</small>
                    </td>
                    {columnasOrdenadas.map((c) => {
                      if (c.virtual) {
                        const t = totalCarbonPeriodo(p);
                        return (
                          <td key="TOTAL" className="comb-total">
                            {t.toFixed(3)}
                          </td>
                        );
                      }
                      const v = buffer[String(p)]?.[String(c.combustible_id)]?.cantidad ?? '';
                      // Heatmap SOLO en columnas de alimentador (tint() es el único estilo inline);
                      // escala desde cantidad_max del alimentador (D-034).
                      const bg = c.tipo === 'ALIMENTADOR' ? tint(v, maxAlim) : 'transparent';
                      // Límite físico por combustible (D-034): celda fuera de rango se marca y bloquea.
                      const max = maxPorId.get(String(c.combustible_id));
                      const invalida = max != null && v !== '' && Number(v) > max;
                      return (
                        <td
                          key={c.combustible_id}
                          className={`comb-cell${invalida ? ' invalid' : ''}`}
                          style={{ background: bg }}
                        >
                          <input
                            type="number"
                            step="0.001"
                            min="0"
                            max={max ?? undefined}
                            placeholder="·"
                            value={v}
                            disabled={!puedeCrear}
                            aria-invalid={invalida || undefined}
                            onChange={(e) => {
                              const raw = e.target.value;
                              const n = raw === '' ? null : parseFloat(raw);
                              setCelda(p, c.combustible_id, n);
                            }}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function deepClone(x) {
  return JSON.parse(JSON.stringify(x));
}
