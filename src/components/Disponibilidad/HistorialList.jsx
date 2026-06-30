import React from 'react';
import { History, ChevronDown } from 'lucide-react';
import { ESTADO_COLORS } from './colores';

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
  if (!t) return <span className="empty">—</span>;
  return <span className={`bdg bdg-${t.cls}`}>{evento}</span>;
}

// Card "Historial" (look dashboard.html). El head y el footer "Ver más" quedan fijos; la
// tabla scrollea dentro de su contenedor con el <thead> sticky (CSS en disponibilidad.css).
// El padre le pasa altura disponible vía flex (flex-1 min-h-0).
export default function HistorialList({
  planta,
  historial,
  total,
  loading,
  onLoadMore,
  hasMore,
}) {
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div className="card-head" style={{ flexShrink: 0 }}>
        <h3>
          <History />
          Historial — {planta}
        </h3>
        <span className="meta">Mostrando {historial.length} de {total}</span>
      </div>

      {historial.length === 0 ? (
        <div className="empty" style={{ padding: '40px 0', textAlign: 'center', fontSize: 13, flex: 1 }}>
          {loading ? 'Cargando' : 'Sin registros históricos.'}
        </div>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>RANGO</th>
                  <th>ESTADO</th>
                  <th>AUTOR</th>
                  <th>DETALLE</th>
                </tr>
              </thead>
              <tbody>
                {historial.map((h) => (
                  <tr key={h.registro_id}>
                    <td className="rango">
                      {formatFecha(h.fecha_inicio_estado)}
                      <span className="arrow">→</span>
                      {formatFecha(h.fecha_fin_estado)}
                    </td>
                    <td><EstadoBadge evento={h.evento} /></td>
                    <td className="autor">{h.creado_por?.nombre_completo || '—'}</td>
                    <td className="detalle" title={h.detalle || ''}>
                      {h.detalle?.trim?.() ? h.detalle : <span className="empty">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasMore && (
            <div style={{ paddingTop: 12, marginTop: 4, borderTop: '1px solid var(--line)', flexShrink: 0 }}>
              <button className="vermas" onClick={onLoadMore} disabled={loading}>
                <ChevronDown />
                {loading ? 'Cargando' : 'Ver más'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
