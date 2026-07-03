import React, { useMemo, useState } from 'react';
import { History, ChevronDown, Search } from 'lucide-react';
import { ESTADO_COLORS } from './colores';

// Marcas diacríticas combinantes (U+0300–U+036F). RegExp desde string ASCII para no depender
// de bytes literales en el fuente.
const DIACRITICOS = new RegExp('[\\u0300-\\u036f]', 'g');

// Normaliza para búsqueda insensible a mayúsculas y tildes (es-CO).
function normaliza(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(DIACRITICOS, '');
}

// F20: render Bogotá explícito — `fecha_inicio_estado` es un instante UTC en BD.
// Formato dd/mm/yyyy, hh:mm a. m./p. m. (12h) para que el año sea visible en el rango.
const FECHA_FMT = new Intl.DateTimeFormat('es-CO', {
  timeZone: 'America/Bogota',
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: true,
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
  const [query, setQuery] = useState('');

  // Filtro por detalle sobre los registros ya cargados (client-side). "Ver más" trae más
  // filas del servidor para ampliar el universo de búsqueda.
  const filtrados = useMemo(() => {
    const needle = normaliza(query).trim();
    if (!needle) return historial;
    return historial.filter((h) => normaliza(h.detalle).includes(needle));
  }, [historial, query]);

  const buscando = query.trim().length > 0;

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div className="card-head" style={{ flexShrink: 0, gap: 12 }}>
        <h3>
          <History />
          Historial — {planta}
        </h3>
        <div className="hist-head-right">
          <div className="hist-search">
            <Search />
            <input
              type="search"
              placeholder="Buscar por detalle"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Buscar en el historial por detalle"
            />
          </div>
          <span className="meta">
            {buscando
              ? `${filtrados.length} coincidencia${filtrados.length === 1 ? '' : 's'}`
              : `Mostrando ${historial.length} de ${total}`}
          </span>
        </div>
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
                {filtrados.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="empty" style={{ textAlign: 'center', padding: '28px 0' }}>
                      Sin coincidencias para «{query.trim()}».
                      {hasMore ? ' Carga más para ampliar la búsqueda.' : ''}
                    </td>
                  </tr>
                ) : (
                  filtrados.map((h) => (
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
                  ))
                )}
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
