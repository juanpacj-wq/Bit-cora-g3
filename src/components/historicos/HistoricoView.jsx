import { useEffect, useState } from 'react';
import { History, Clock } from 'lucide-react';
import { useHistoricos } from '../../hooks/useHistoricos';
import { api } from '../../hooks/useApi';
import { HistoricoFilters } from './HistoricoFilters';
import { HistoricoTable } from './HistoricoTable';
import SeguimientoTurnos from '../SeguimientoTurnos';

function defaultFiltros(plantaSesion) {
  return {
    planta_id: plantaSesion || undefined,
    bitacora_id: undefined,
    fecha_desde: undefined,
    fecha_hasta: undefined,
    busqueda: undefined,
    page: 1,
    limit: 50,
  };
}

export function HistoricoView({ plantaSesion }) {
  const { data, total, page, limit, loading, error, buscar } = useHistoricos();
  const [filtros, setFiltros] = useState(() => defaultFiltros(plantaSesion));
  const [bitacoras, setBitacoras] = useState([]);
  const [plantas, setPlantas] = useState([]);
  // D-045 E9: sub-pestaña dentro de Históricos — registros archivados vs seguimiento de turnos.
  const [subvista, setSubvista] = useState('registros'); // 'registros' | 'turnos'

  useEffect(() => {
    let cancel = false;
    Promise.all([
      api.get('/api/catalogos/bitacoras').catch(() => ({ bitacoras: [] })),
      api.get('/api/catalogos/plantas').catch(() => ({ plantas: [] })),
    ]).then(([b, p]) => {
      if (cancel) return;
      setBitacoras(b.bitacoras || b || []);
      setPlantas(p.plantas || p || []);
    });
    return () => { cancel = true; };
  }, []);

  useEffect(() => {
    buscar(filtros);
  }, [filtros, buscar]);

  const handleFiltroChange = (patch) => setFiltros((prev) => ({ ...prev, ...patch }));
  const handleReset = () => setFiltros(defaultFiltros(plantaSesion));

  const tabBtn = (id, label) => (
    <button onClick={() => setSubvista(id)}
      className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${subvista === id ? 'text-white bg-blue-700' : 'text-gray-600 bg-white border border-gray-200 hover:bg-gray-100'}`}>
      {label}
    </button>
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white shrink-0"
          style={{ background: 'linear-gradient(135deg, #003566 0%, #001d3d 100%)' }}>
          {subvista === 'turnos' ? <Clock size={20} /> : <History size={20} />}
        </div>
        <div>
          <h2 className="text-lg font-bold text-gray-900">{subvista === 'turnos' ? 'Seguimiento de turnos' : 'Históricos'}</h2>
          <p className="text-xs text-gray-500">
            {subvista === 'turnos'
              ? 'Ciclo de cada turno por día y unidad: estado, extensión, cierre y participantes.'
              : (loading ? 'Cargando…' : `${total} registro${total === 1 ? '' : 's'} encontrado${total === 1 ? '' : 's'}`)}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {tabBtn('registros', 'Registros')}
          {tabBtn('turnos', 'Seguimiento de turnos')}
        </div>
      </div>

      {subvista === 'turnos' ? (
        <SeguimientoTurnos plantaSesion={plantaSesion} />
      ) : (
        <>
          <HistoricoFilters
            filtros={filtros}
            onChange={handleFiltroChange}
            onReset={handleReset}
            bitacoras={bitacoras}
            plantas={plantas}
          />

          {error && (
            <div className="px-6 py-2 text-sm text-red-600 bg-red-50 border-b border-red-200">
              Error al cargar históricos: {error}
            </div>
          )}

          <HistoricoTable
            rows={data}
            loading={loading}
            page={page}
            limit={limit}
            total={total}
            onPageChange={(p) => handleFiltroChange({ page: p })}
            onLimitChange={(l) => handleFiltroChange({ limit: l, page: 1 })}
          />
        </>
      )}
    </div>
  );
}
