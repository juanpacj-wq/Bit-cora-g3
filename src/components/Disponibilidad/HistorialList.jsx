import React from 'react';
import { History, ChevronDown } from 'lucide-react';
import { ESTADO_COLORS, NEUTRAL } from './colores';

function formatFecha(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-CO', {
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

function EstadoBadge({ evento }) {
  const t = ESTADO_COLORS[evento];
  if (!t) return <span className="text-xs">—</span>;
  return (
    <span
      className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold"
      style={{ backgroundColor: t.bg, color: t.text }}
    >
      {evento}
    </span>
  );
}

export default function HistorialList({
  planta,
  historial,
  total,
  loading,
  onLoadMore,
  hasMore,
}) {
  const detalleTitleId = (id) => `disp-hist-detalle-${id}`;

  return (
    <div
      className="rounded-2xl shadow-sm overflow-hidden border bg-white"
      style={{ borderColor: NEUTRAL.hairline }}
    >
      <div
        className="px-6 py-4 flex items-center justify-between border-b"
        style={{ borderColor: NEUTRAL.hairline, backgroundColor: NEUTRAL.canvas }}
      >
        <div className="flex items-center gap-2" style={{ color: NEUTRAL.fgInk }}>
          <History size={18} />
          <h3 className="text-base font-bold">Historial — {planta}</h3>
        </div>
        <div className="text-xs" style={{ color: NEUTRAL.fgTer }}>
          Mostrando {historial.length} de {total}
        </div>
      </div>

      {historial.length === 0 ? (
        <div
          className="px-6 py-10 text-center text-sm italic"
          style={{ color: NEUTRAL.fgTer }}
        >
          {loading ? 'Cargando…' : 'No hay registros históricos para esta planta.'}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left text-xs uppercase tracking-wider"
                  style={{ color: NEUTRAL.fgTer, backgroundColor: NEUTRAL.canvas }}
                >
                  <th className="px-6 py-2 font-semibold">Rango</th>
                  <th className="px-3 py-2 font-semibold">Estado</th>
                  <th className="px-3 py-2 font-semibold">Autor</th>
                  <th className="px-6 py-2 font-semibold">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {historial.map((h) => (
                  <tr
                    key={h.registro_id}
                    className="border-t hover:bg-gray-50"
                    style={{ borderColor: NEUTRAL.hairline }}
                  >
                    <td className="px-6 py-3 whitespace-nowrap" style={{ color: NEUTRAL.fgInk }}>
                      <span className="font-mono text-xs">
                        {formatFecha(h.fecha_inicio_estado)} → {formatFecha(h.fecha_fin_estado)}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <EstadoBadge evento={h.evento} />
                    </td>
                    <td className="px-3 py-3" style={{ color: NEUTRAL.fgInk }}>
                      {h.creado_por?.nombre_completo || '—'}
                    </td>
                    <td
                      className="px-6 py-3 max-w-md truncate"
                      style={{ color: NEUTRAL.fgInk }}
                      title={h.detalle || ''}
                      id={detalleTitleId(h.registro_id)}
                    >
                      {h.detalle?.trim?.() ? h.detalle : (
                        <span className="italic" style={{ color: NEUTRAL.fgTer }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasMore && (
            <div className="px-6 py-3 border-t" style={{ borderColor: NEUTRAL.hairline }}>
              <button
                onClick={onLoadMore}
                disabled={loading}
                className="flex items-center gap-2 text-sm font-medium transition-colors disabled:opacity-50"
                style={{ color: NEUTRAL.fgInk }}
              >
                <ChevronDown size={16} />
                {loading ? 'Cargando…' : 'Ver más'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
