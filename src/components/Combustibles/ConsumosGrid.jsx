import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCombustibles } from '../../hooks/useCombustibles';
import { getTodayBogota } from '../../utils/fecha';
import { SelectorFecha } from './SelectorFecha';

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

export default function ConsumosGrid({ bitacora, plantaId, puedeCrear, showToast }) {
  const { loading, getConsumos, guardarBatch } = useCombustibles();

  const [fecha, setFecha] = useState(() => getTodayBogota());
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
        const motivos = [...new Set(e.errores.map((x) => x.motivo))].join(', ');
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

  return (
    // flex-1 overflow-auto: el parent en BitacorasGecelca3.jsx es `h-screen flex flex-col`;
    // sin esto, el grid (24 periodos × N combustibles) excede el viewport y el page document
    // hace scroll vertical, empujando BitacoraTabs fuera de vista (softlock de navegación).
    // Mismo patrón que SalaDeMandoGrid (l.332) y DisponibilidadDashboard (l.163).
    <div className="flex-1 overflow-auto p-4">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          {bitacora?.nombre && <h2 className="text-lg font-semibold">{bitacora.nombre}</h2>}
          <SelectorFecha fecha={fecha} onChange={setFecha} disabled={loading} />
        </div>
        <button
          type="button"
          onClick={onGuardar}
          disabled={!hayCambios || !puedeCrear || loading}
          className="px-4 py-2 rounded-md bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Guardar
        </button>
      </div>

      {loading && <div className="text-sm text-gray-500 mb-2">Cargando...</div>}
      {error && <div className="text-sm text-red-600 mb-2">Error: {error.message || 'desconocido'}</div>}
      {!loading && catalogo.length === 0 && (
        <div className="text-sm text-gray-500">Sin combustibles configurados para esta planta.</div>
      )}

      {catalogo.length > 0 && (
        <div className="overflow-auto border rounded-md">
          <table className="text-sm">
            <thead className="bg-gray-50 sticky top-0 z-10">
              <tr>
                <th className="px-3 py-2 text-left whitespace-nowrap">Periodo</th>
                {columnasOrdenadas.map((c) => (
                  <th
                    key={String(c.combustible_id)}
                    className={`px-3 py-2 text-center whitespace-nowrap ${c.virtual ? 'bg-yellow-50' : ''}`}
                  >
                    <div>{c.nombre}</div>
                    <div className="text-xs text-gray-500 font-normal">[{c.unidad}]</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERIODOS.map((p) => (
                <tr key={p} className="border-t hover:bg-gray-50">
                  <td className="px-3 py-1.5 font-medium whitespace-nowrap">
                    P{p}{' '}
                    <span className="text-xs text-gray-500">
                      ({String(p - 1).padStart(2, '0')}h)
                    </span>
                  </td>
                  {columnasOrdenadas.map((c) => {
                    if (c.virtual) {
                      const t = totalCarbonPeriodo(p);
                      return (
                        <td key="TOTAL" className="px-2 py-1 text-right bg-yellow-50 font-mono">
                          {t.toFixed(3)}
                        </td>
                      );
                    }
                    const v = buffer[String(p)]?.[String(c.combustible_id)]?.cantidad ?? '';
                    return (
                      <td key={c.combustible_id} className="px-1 py-1">
                        <input
                          type="number"
                          step="0.001"
                          min="0"
                          value={v}
                          disabled={!puedeCrear}
                          onChange={(e) => {
                            const raw = e.target.value;
                            const n = raw === '' ? null : parseFloat(raw);
                            setCelda(p, c.combustible_id, n);
                          }}
                          className="w-24 px-1.5 py-0.5 text-right border rounded text-sm focus:ring-1 focus:ring-blue-400 focus:outline-none disabled:bg-gray-100 disabled:text-gray-500"
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
  );
}

function deepClone(x) {
  return JSON.parse(JSON.stringify(x));
}
