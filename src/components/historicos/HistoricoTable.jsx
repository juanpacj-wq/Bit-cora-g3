import { FileText, ChevronLeft, ChevronRight } from 'lucide-react';
import { JsonPopover } from './JsonPopover';

const fmtFecha = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('es-CO', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};

const fmtFechaCorta = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

export function HistoricoTable({ rows, loading, page, limit, total, onPageChange, onLimitChange }) {
  const totalPaginas = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-auto">
        {loading && rows.length === 0 ? (
          <LoadingState />
        ) : rows.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="px-6 py-4">
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    <Th>Fecha evento</Th>
                    <Th>Bitácora</Th>
                    <Th>Planta</Th>
                    <Th>Turno</Th>
                    <Th>Tipo</Th>
                    <Th>Detalle</Th>
                    <Th>Campos</Th>
                    <Th>Ingenieros</Th>
                    <Th>JdTs</Th>
                    <Th>Jefes</Th>
                    <Th>Creado por</Th>
                    <Th>Cerrado</Th>
                    <Th>Estado</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((r) => (
                    <tr key={r.registro_id} className="odd:bg-white even:bg-gray-50/40 hover:bg-emerald-50/40 transition-colors">
                      <Td mono>{fmtFecha(r.fecha_evento)}</Td>
                      <Td>
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 text-xs font-semibold">
                          {r.bitacora_codigo}
                        </span>
                        <div className="text-xs text-gray-500 mt-0.5">{r.bitacora_nombre}</div>
                      </Td>
                      <Td>{r.planta_nombre || r.planta_id}</Td>
                      <Td>
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs font-semibold">
                          T{r.turno}
                        </span>
                      </Td>
                      <Td>{r.tipo_evento}</Td>
                      <Td className="max-w-xs">
                        <div className="line-clamp-2 text-gray-700" title={r.detalle || ''}>
                          {r.detalle || <span className="text-gray-300">—</span>}
                        </div>
                      </Td>
                      <Td><JsonPopover json={r.campos_extra} variant="campos" /></Td>
                      <Td><JsonPopover json={r.ingenieros_snapshot} variant="usuarios" /></Td>
                      <Td><JsonPopover json={r.jdts_snapshot} variant="usuarios" /></Td>
                      <Td><JsonPopover json={r.jefes_snapshot} variant="usuarios" /></Td>
                      <Td>
                        <div className="text-gray-800">{r.creado_por_nombre || '—'}</div>
                        <div className="text-xs text-gray-400">{fmtFecha(r.creado_en)}</div>
                      </Td>
                      <Td mono>{fmtFechaCorta(r.fecha_cierre_operativo)}</Td>
                      <Td>
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 text-xs font-semibold">
                          Cerrado
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <Pagination
        page={page}
        limit={limit}
        total={total}
        totalPaginas={totalPaginas}
        loading={loading}
        onPageChange={onPageChange}
        onLimitChange={onLimitChange}
      />
    </div>
  );
}

function Th({ children }) {
  return <th scope="col" className="px-3 py-2.5 whitespace-nowrap">{children}</th>;
}

function Td({ children, className = '', mono = false }) {
  return (
    <td className={`px-3 py-2.5 align-top ${mono ? 'font-mono text-xs' : ''} ${className}`}>
      {children}
    </td>
  );
}

function Pagination({ page, limit, total, totalPaginas, loading, onPageChange, onLimitChange }) {
  const desde = total === 0 ? 0 : (page - 1) * limit + 1;
  const hasta = Math.min(page * limit, total);
  return (
    <div className="bg-white border-t border-gray-200 px-6 py-3 flex flex-wrap items-center justify-between gap-4 text-sm">
      <div className="text-gray-500">
        {total > 0
          ? <>Mostrando <span className="font-semibold text-gray-800">{desde}</span>–<span className="font-semibold text-gray-800">{hasta}</span> de <span className="font-semibold text-gray-800">{total}</span></>
          : 'Sin resultados'}
      </div>
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-gray-500">
          Por página
          <select
            value={limit}
            onChange={(e) => onLimitChange(Number(e.target.value))}
            className="px-2 py-1 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 bg-white"
          >
            <option value={20}>20</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </label>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={loading || page <= 1}
            className="p-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Página anterior"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="px-3 text-gray-700">
            Página <span className="font-semibold">{page}</span> de {totalPaginas}
          </span>
          <button
            onClick={() => onPageChange(page + 1)}
            disabled={loading || page >= totalPaginas}
            className="p-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Página siguiente"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-64 text-gray-400">
      <FileText size={48} className="mb-4 opacity-50" />
      <p className="text-lg font-medium">Sin registros históricos</p>
      <p className="text-sm mt-1">Ajusta los filtros para ver resultados</p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="px-6 py-4 space-y-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-12 rounded-lg bg-gray-100 animate-pulse" />
      ))}
    </div>
  );
}
