import { useEffect, useState } from 'react';
import { Search, Filter, Calendar, MapPin, RotateCcw, ChevronDown } from 'lucide-react';

export function HistoricoFilters({ filtros, onChange, onReset, bitacoras, plantas }) {
  const [textoLocal, setTextoLocal] = useState(filtros.busqueda || '');

  useEffect(() => {
    const t = setTimeout(() => {
      if ((filtros.busqueda || '') !== textoLocal) onChange({ busqueda: textoLocal, page: 1 });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textoLocal]);

  useEffect(() => {
    if ((filtros.busqueda || '') !== textoLocal) setTextoLocal(filtros.busqueda || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtros.busqueda]);

  const handle = (patch) => onChange({ ...patch, page: 1 });

  return (
    <div className="bg-white border-b border-gray-200 px-6 py-4">
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Bitácora" icon={<Filter size={14} />}>
          <select
            value={filtros.bitacora_id || ''}
            onChange={(e) => handle({ bitacora_id: e.target.value || undefined })}
            className="pl-3 pr-8 py-2 rounded-xl border border-gray-300 text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent bg-white cursor-pointer w-52"
          >
            <option value="">Todas</option>
            {bitacoras.map((b) => (
              <option key={b.bitacora_id} value={b.bitacora_id}>{b.nombre}</option>
            ))}
          </select>
          <ChevronDown size={14} className="absolute right-3 bottom-3 text-gray-400 pointer-events-none" />
        </Field>

        <Field label="Planta" icon={<MapPin size={14} />}>
          <select
            value={filtros.planta_id || ''}
            onChange={(e) => handle({ planta_id: e.target.value || undefined })}
            className="pl-3 pr-8 py-2 rounded-xl border border-gray-300 text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent bg-white cursor-pointer w-44"
          >
            <option value="">Todas</option>
            {plantas.map((p) => (
              <option key={p.planta_id} value={p.planta_id}>{p.nombre}</option>
            ))}
          </select>
          <ChevronDown size={14} className="absolute right-3 bottom-3 text-gray-400 pointer-events-none" />
        </Field>

        <Field label="Desde" icon={<Calendar size={14} />}>
          <input
            type="date"
            value={filtros.fecha_desde || ''}
            onChange={(e) => handle({ fecha_desde: e.target.value || undefined })}
            className="px-3 py-2 rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent w-44"
          />
        </Field>

        <Field label="Hasta" icon={<Calendar size={14} />}>
          <input
            type="date"
            value={filtros.fecha_hasta || ''}
            onChange={(e) => handle({ fecha_hasta: e.target.value || undefined })}
            className="px-3 py-2 rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent w-44"
          />
        </Field>

        <Field label="Descripción" icon={<Search size={14} />} grow>
          <input
            type="text"
            value={textoLocal}
            onChange={(e) => setTextoLocal(e.target.value)}
            placeholder="Buscar en el detalle…"
            className="w-full pl-3 pr-4 py-2 rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent"
          />
        </Field>

        <button
          onClick={onReset}
          className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium text-gray-600 border border-gray-300 hover:bg-gray-50 transition-colors"
          title="Limpiar filtros"
        >
          <RotateCcw size={14} />
          Limpiar
        </button>
      </div>
    </div>
  );
}

function Field({ label, icon, grow, children }) {
  return (
    <div className={`flex flex-col gap-1 relative ${grow ? 'flex-1 min-w-64' : ''}`}>
      <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">
        {icon}
        {label}
      </label>
      {children}
    </div>
  );
}
