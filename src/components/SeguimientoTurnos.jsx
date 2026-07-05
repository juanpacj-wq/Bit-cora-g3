import React, { useEffect, useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle, RefreshCw, Users } from 'lucide-react';
import { api } from '../hooks/useApi';
import { useSeguimientoTurnos } from '../hooks/useSeguimientoTurnos';

// Presentación en Bogotá explícito (D-020). Las columnas de la vista vienen en UTC; formateamos con
// timeZone America/Bogota. `fecha_operativa` es una fecha lógica (sin hora) → se formatea en UTC para
// que no se corra un día al aplicar el offset.
const fmtFecha = (d) => (d ? new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(d)) : '—');
const fmtHora = (d) => (d ? new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(d)) : '—');
const fmtDur = (min) => (min == null ? '—' : `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`);

const MOTIVO_LABEL = {
  MANUAL: 'Manual',
  AUTO_SIN_PERSONAL: 'Auto · sin personal',
  AUTO_SIN_RESPUESTA: 'Auto · sin respuesta',
};
const ESTADO_STYLE = {
  PROGRAMADO: { bg: '#EEF2FF', fg: '#3730A3' },
  ABIERTO: { bg: '#DCFCE7', fg: '#166534' },
  CERRADO: { bg: '#F3F4F6', fg: '#374151' },
};

// Fecha Bogotá (UTC-5) en YYYY-MM-DD, con desplazamiento opcional en días.
const bogotaISO = (offsetDays = 0) => new Date(Date.now() - 5 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);

const esAuto = (motivo) => typeof motivo === 'string' && motivo.startsWith('AUTO_');

export default function SeguimientoTurnos({ plantaSesion }) {
  const { turnos, loading, error, cargar, cargarParticipantes } = useSeguimientoTurnos();
  const [plantas, setPlantas] = useState([]);
  const [planta, setPlanta] = useState(plantaSesion || '');
  const [desde, setDesde] = useState(() => bogotaISO(-14));
  const [hasta, setHasta] = useState(() => bogotaISO(0));
  const [expandido, setExpandido] = useState(null);
  const [participantes, setParticipantes] = useState({}); // turno_id → 'loading' | { cerrado, participantes }

  useEffect(() => {
    api.get('/api/catalogos/plantas').then((p) => setPlantas(p.plantas || p || [])).catch(() => {});
  }, []);

  const recargar = useCallback(() => cargar({ planta: planta || undefined, desde, hasta }), [cargar, planta, desde, hasta]);
  useEffect(() => { recargar(); }, [recargar]);

  const toggle = async (id) => {
    if (expandido === id) { setExpandido(null); return; }
    setExpandido(id);
    if (!participantes[id]) {
      setParticipantes((p) => ({ ...p, [id]: 'loading' }));
      try {
        const r = await cargarParticipantes(id);
        setParticipantes((p) => ({ ...p, [id]: r }));
      } catch {
        setParticipantes((p) => ({ ...p, [id]: { cerrado: false, participantes: [] } }));
      }
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Filtros */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-500">
          Unidad
          <select value={planta} onChange={(e) => setPlanta(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-900 bg-white">
            <option value="">(La de mi sesión)</option>
            {plantas.map((p) => (
              <option key={p.planta_id} value={p.planta_id}>{p.nombre || p.planta_id}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-500">
          Desde
          <input type="date" value={desde} max={hasta} onChange={(e) => setDesde(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-900" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-500">
          Hasta
          <input type="date" value={hasta} min={desde} onChange={(e) => setHasta(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-900" />
        </label>
        <button onClick={recargar} disabled={loading}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 transition-colors">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          {loading ? 'Cargando…' : 'Actualizar'}
        </button>
        <div className="ml-auto text-xs text-gray-500 self-center">
          {turnos.length} turno{turnos.length === 1 ? '' : 's'}
        </div>
      </div>

      {error && (
        <div className="px-6 py-2 text-sm text-red-600 bg-red-50 border-b border-red-200">
          Error al cargar el seguimiento: {error}
        </div>
      )}

      {/* Tabla */}
      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
              <tr>
                <th className="px-3 py-2 text-left w-8"></th>
                <th className="px-3 py-2 text-left">Fecha op.</th>
                <th className="px-3 py-2 text-left">Turno</th>
                <th className="px-3 py-2 text-left">Estado</th>
                <th className="px-3 py-2 text-left">Inicio real</th>
                <th className="px-3 py-2 text-left">Fin real</th>
                <th className="px-3 py-2 text-left">Extensión</th>
                <th className="px-3 py-2 text-left">Cierre</th>
                <th className="px-3 py-2 text-left">Cerró</th>
                <th className="px-3 py-2 text-right">Duración</th>
                <th className="px-3 py-2 text-right">Particip.</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {turnos.length === 0 && !loading && (
                <tr><td colSpan={11} className="px-3 py-8 text-center text-gray-400 italic">No hay turnos en el rango seleccionado.</td></tr>
              )}
              {turnos.map((t) => {
                const auto = esAuto(t.motivo_cierre);
                const est = ESTADO_STYLE[t.estado] || ESTADO_STYLE.CERRADO;
                const abierto = expandido === t.turno_unidad_id;
                const det = participantes[t.turno_unidad_id];
                return (
                  <React.Fragment key={t.turno_unidad_id}>
                    <tr onClick={() => toggle(t.turno_unidad_id)}
                      className="cursor-pointer hover:bg-gray-50"
                      style={auto ? { backgroundColor: '#FFFBEB' } : undefined}>
                      <td className="px-3 py-2 text-gray-400">{abierto ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</td>
                      <td className="px-3 py-2 font-medium text-gray-900">{fmtFecha(t.fecha_operativa)}</td>
                      <td className="px-3 py-2">T{t.turno}</td>
                      <td className="px-3 py-2">
                        <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ backgroundColor: est.bg, color: est.fg }}>
                          {t.estado}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-700">{fmtHora(t.inicio_real)}</td>
                      <td className="px-3 py-2 text-gray-700">{fmtHora(t.fin_real)}</td>
                      <td className="px-3 py-2 text-gray-700">{t.extendido ? `Sí (${t.veces_extendido})` : '—'}</td>
                      <td className="px-3 py-2">
                        {t.motivo_cierre ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: auto ? '#B45309' : '#374151' }}>
                            {auto && <AlertTriangle size={13} />}
                            {MOTIVO_LABEL[t.motivo_cierre] || t.motivo_cierre}
                          </span>
                        ) : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-3 py-2 text-gray-700">{t.cerrado_por_nombre || '—'}</td>
                      <td className="px-3 py-2 text-right text-gray-700">{fmtDur(t.duracion_real_min)}</td>
                      <td className="px-3 py-2 text-right text-gray-700">{t.n_participantes}</td>
                    </tr>
                    {abierto && (
                      <tr>
                        <td colSpan={11} className="px-6 py-3 bg-gray-50">
                          {det === 'loading' || det === undefined ? (
                            <div className="text-sm text-gray-400 italic">Cargando participantes…</div>
                          ) : det.participantes.length === 0 ? (
                            <div className="text-sm text-gray-400 italic">Sin participantes registrados en este turno.</div>
                          ) : (
                            <div>
                              <div className="flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                                <Users size={14} /> Participantes {det.cerrado ? '(conformación congelada)' : '(presencia en curso)'}
                              </div>
                              <div className="overflow-x-auto">
                                <table className="min-w-full text-sm">
                                  <thead className="text-gray-400 text-xs">
                                    <tr>
                                      <th className="px-3 py-1 text-left">Usuario</th>
                                      <th className="px-3 py-1 text-left">Cargo</th>
                                      <th className="px-3 py-1 text-left">Ingreso</th>
                                      <th className="px-3 py-1 text-left">Fin</th>
                                      <th className="px-3 py-1 text-right">Presencia</th>
                                      <th className="px-3 py-1 text-left">Finalizó</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {det.participantes.map((u) => (
                                      <tr key={u.usuario_id} className="border-t border-gray-100">
                                        <td className="px-3 py-1.5 font-medium text-gray-900">{u.usuario_nombre}</td>
                                        <td className="px-3 py-1.5 text-gray-600">{u.cargo_nombre}</td>
                                        <td className="px-3 py-1.5 text-gray-600">{fmtHora(u.inicio_sesion)}</td>
                                        <td className="px-3 py-1.5 text-gray-600">{fmtHora(u.fin_sesion)}</td>
                                        <td className="px-3 py-1.5 text-right text-gray-600">{fmtDur(u.duracion_min)}</td>
                                        <td className="px-3 py-1.5 text-gray-600">{u.finalizado_individual_en ? fmtHora(u.finalizado_individual_en) : '—'}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
