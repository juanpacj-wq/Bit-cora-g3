import React from 'react';
import { History, ChevronDown } from 'lucide-react';
import { ESTADO_COLORS, NEUTRAL } from './colores';

// F20: render Bogotá explícito — `fecha_inicio_estado` es un instante UTC en BD.
const FECHA_FMT = new Intl.DateTimeFormat('es-CO', {
  timeZone: 'America/Bogota',
  day: '2-digit', month: 'short',
  hour: '2-digit', minute: '2-digit',
});

function formatFecha(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return FECHA_FMT.format(d);
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

// F13.1: card flex column con scroll interno. La tabla scrollea dentro de su contenedor;
// el `<thead>` permanece sticky. El header de la card y el footer "Ver más" no se mueven.
// Padre debe pasarle altura disponible vía flex (e.g. flex-1 min-h-0 en el wrapper).
export default function HistorialList({
  planta,
  historial,
  total,
  loading,
  onLoadMore,
  hasMore,
}) {
  return (
    <div
      className="rounded-xl shadow-sm border bg-white flex flex-col min-h-0"
      style={{ borderColor: NEUTRAL.hairline }}
    >
      <div
        className="px-6 py-3 flex items-center justify-between border-b flex-shrink-0"
        style={{ borderColor: NEUTRAL.hairline, backgroundColor: NEUTRAL.canvas }}
      >
        <div className="flex items-center gap-2" style={{ color: NEUTRAL.fgInk }}>
          <History size={16} />
          <h3 className="text-sm font-semibold">Historial — {planta}</h3>
        </div>
        <div className="text-xs" style={{ color: NEUTRAL.fgTer }}>
          Mostrando {historial.length} de {total}
        </div>
      </div>

      {historial.length === 0 ? (
        <div
          className="px-6 py-10 text-center text-sm flex-1"
          style={{ color: NEUTRAL.fgTer }}
        >
          {loading ? 'Cargando' : 'Sin registros históricos.'}
        </div>
      ) : (
        <>
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-auto">
            <table className="w-full text-sm">
              <thead
                className="sticky top-0 z-10"
                style={{ backgroundColor: NEUTRAL.canvas }}
              >
                <tr
                  className="text-left text-[11px] uppercase tracking-wider"
                  style={{ color: NEUTRAL.fgTer }}
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
                    <td className="px-6 py-2.5 whitespace-nowrap" style={{ color: NEUTRAL.fgInk }}>
                      <span className="font-mono text-xs">
                        {formatFecha(h.fecha_inicio_estado)} → {formatFecha(h.fecha_fin_estado)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <EstadoBadge evento={h.evento} />
                    </td>
                    <td className="px-3 py-2.5" style={{ color: NEUTRAL.fgInk }}>
                      {h.creado_por?.nombre_completo || '—'}
                    </td>
                    <td
                      className="px-6 py-2.5 max-w-md truncate"
                      style={{ color: NEUTRAL.fgInk }}
                      title={h.detalle || ''}
                    >
                      {h.detalle?.trim?.() ? h.detalle : (
                        <span style={{ color: NEUTRAL.fgTer }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasMore && (
            <div
              className="px-6 py-2.5 border-t flex-shrink-0"
              style={{ borderColor: NEUTRAL.hairline, backgroundColor: NEUTRAL.surface }}
            >
              <button
                onClick={onLoadMore}
                disabled={loading}
                className="flex items-center gap-2 text-sm font-medium transition-colors disabled:opacity-50 hover:opacity-80"
                style={{ color: NEUTRAL.fgInk }}
              >
                <ChevronDown size={16} />
                {loading ? 'Cargando' : 'Ver más'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
