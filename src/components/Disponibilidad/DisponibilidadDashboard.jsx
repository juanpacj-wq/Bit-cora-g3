import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, Plus, X, Undo2 } from 'lucide-react';
import EstadoActualCard from './EstadoActualCard';
import HistorialList from './HistorialList';
import CambiarEstadoModal from './CambiarEstadoModal';
import { useDisponibilidad } from '../../hooks/useDisponibilidad';
import { BRAND, NEUTRAL, PLANTAS } from './colores';

const STORAGE_KEY = 'disponibilidad.plantaSeleccionada';
const POLL_MS = 30_000;
const HIST_PAGE = 20;

function loadStoredPlanta(fallback) {
  try {
    const v = sessionStorage.getItem(STORAGE_KEY);
    if (v && PLANTAS.includes(v)) return v;
  } catch {}
  if (PLANTAS.includes(fallback)) return fallback;
  return PLANTAS[0];
}

export default function DisponibilidadDashboard({
  bitacoraId,
  plantaInicial,
  puedeEditar,
  showToast,
}) {
  const { getEstado, crear, editar, deshacer } = useDisponibilidad(bitacoraId);

  const [plantaSeleccionada, setPlantaSeleccionada] = useState(() => loadStoredPlanta(plantaInicial));
  const [data, setData] = useState({ vigente: null, historial: [], historial_total: 0 });
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [modal, setModal] = useState(null); // { mode: 'crear' | 'editar' }
  const [confirmDeshacer, setConfirmDeshacer] = useState(false);
  const [paneAnim, setPaneAnim] = useState('entered'); // 'entering' | 'entered'
  const lastPlanta = useRef(plantaSeleccionada);

  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, plantaSeleccionada); } catch {}
  }, [plantaSeleccionada]);

  const fetchEstado = useCallback(
    async (planta, { silent = false } = {}) => {
      if (!silent) setLoading(true);
      try {
        const res = await getEstado(planta, { historial_limit: HIST_PAGE, historial_offset: 0 });
        setData({
          vigente: res.vigente || null,
          historial: res.historial || [],
          historial_total: res.historial_total || 0,
        });
        setError(null);
      } catch (e) {
        if (!silent) setError(e.message || 'Error al cargar disponibilidad');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [getEstado]
  );

  // Cambio de planta: animar slide + fetch.
  useEffect(() => {
    if (lastPlanta.current !== plantaSeleccionada) {
      setPaneAnim('entering');
      const t = setTimeout(() => setPaneAnim('entered'), 30);
      lastPlanta.current = plantaSeleccionada;
      return () => clearTimeout(t);
    }
  }, [plantaSeleccionada]);

  useEffect(() => {
    fetchEstado(plantaSeleccionada);
  }, [plantaSeleccionada, fetchEstado]);

  // Polling silencioso para captar cambios de otros usuarios.
  useEffect(() => {
    const id = setInterval(() => {
      fetchEstado(plantaSeleccionada, { silent: true });
    }, POLL_MS);
    return () => clearInterval(id);
  }, [plantaSeleccionada, fetchEstado]);

  const cargarMasHistorial = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await getEstado(plantaSeleccionada, {
        historial_limit: HIST_PAGE,
        historial_offset: data.historial.length,
      });
      setData((prev) => ({
        vigente: prev.vigente,
        historial: [...prev.historial, ...(res.historial || [])],
        historial_total: res.historial_total ?? prev.historial_total,
      }));
    } catch (e) {
      showToast?.(e.message || 'Error al cargar más', 'error');
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, getEstado, plantaSeleccionada, data.historial.length, showToast]);

  const handleSubmitModal = useCallback(
    async (form) => {
      if (modal?.mode === 'editar') {
        const reg = data.vigente;
        await editar(reg.registro_id, {
          evento: form.evento,
          codigo: form.codigo,
          fecha_inicio_estado: form.fecha_inicio_estado,
          detalle: form.detalle,
        });
        showToast?.('Estado actualizado');
      } else {
        await crear({
          planta_id: form.planta,
          evento: form.evento,
          codigo: form.codigo,
          fecha_inicio_estado: form.fecha_inicio_estado,
          detalle: form.detalle,
        });
        showToast?.('Cambio de estado registrado');
        if (form.planta !== plantaSeleccionada) setPlantaSeleccionada(form.planta);
      }
      setModal(null);
      await fetchEstado(form.planta || plantaSeleccionada);
    },
    [modal, data.vigente, editar, crear, showToast, plantaSeleccionada, fetchEstado]
  );

  const handleDeshacerConfirm = useCallback(async () => {
    setConfirmDeshacer(false);
    try {
      await deshacer(plantaSeleccionada);
      showToast?.('Último registro deshecho');
      await fetchEstado(plantaSeleccionada);
    } catch (e) {
      showToast?.(e.body?.mensaje || e.message || 'Error al deshacer', 'error');
    }
  }, [deshacer, plantaSeleccionada, showToast, fetchEstado]);

  const ultimoHistorico = data.historial[0] || null;
  const tienePuedeMas = data.historial.length < (data.historial_total || 0);

  return (
    <div className="flex-1 overflow-auto" style={{ backgroundColor: NEUTRAL.canvas }}>
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-5">
        <Header
          plantaSeleccionada={plantaSeleccionada}
          onChangePlanta={setPlantaSeleccionada}
          loading={loading}
        />

        {error && (
          <div
            className="rounded-xl p-4 flex items-start gap-3 border"
            style={{ borderColor: '#FCA5A5', backgroundColor: '#FEF2F2', color: '#7F1D1D' }}
          >
            <AlertTriangle size={18} className="flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <div className="font-semibold">No se pudo cargar la disponibilidad</div>
              <div className="opacity-90">{error}</div>
            </div>
          </div>
        )}

        <div
          className={`disp-pane ${paneAnim === 'entering' ? 'disp-pane-entering' : 'disp-pane-entered'}`}
          key={plantaSeleccionada}
        >
          {data.vigente ? (
            <EstadoActualCard
              vigente={data.vigente}
              puedeEditar={puedeEditar}
              onCambiar={() => setModal({ mode: 'crear' })}
              onEditar={() => setModal({ mode: 'editar' })}
              onDeshacer={() => setConfirmDeshacer(true)}
            />
          ) : (
            <EmptyState
              planta={plantaSeleccionada}
              puedeEditar={puedeEditar}
              onRegistrar={() => setModal({ mode: 'crear' })}
              loading={loading}
            />
          )}
        </div>

        <HistorialList
          planta={plantaSeleccionada}
          historial={data.historial}
          total={data.historial_total}
          loading={loading || loadingMore}
          hasMore={tienePuedeMas}
          onLoadMore={cargarMasHistorial}
        />
      </div>

      {modal && (
        <CambiarEstadoModal
          mode={modal.mode}
          plantaActual={plantaSeleccionada}
          vigente={data.vigente}
          ultimoHistorico={ultimoHistorico}
          onClose={() => setModal(null)}
          onSubmit={handleSubmitModal}
        />
      )}

      {confirmDeshacer && (
        <ConfirmDeshacer
          planta={plantaSeleccionada}
          tieneHistorico={!!ultimoHistorico}
          vigenteEvento={data.vigente?.evento}
          historicoEvento={ultimoHistorico?.evento}
          onCancel={() => setConfirmDeshacer(false)}
          onConfirm={handleDeshacerConfirm}
        />
      )}

      <style>{`
        .disp-pane { transition: opacity 250ms ease, transform 250ms ease; }
        .disp-pane-entering { opacity: 0; transform: translateX(20px); }
        .disp-pane-entered  { opacity: 1; transform: translateX(0); }
      `}</style>
    </div>
  );
}

function Header({ plantaSeleccionada, onChangePlanta, loading }) {
  return (
    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
      <div className="flex items-center gap-3">
        <div
          className="w-12 h-12 rounded-2xl flex items-center justify-center"
          style={{ backgroundColor: BRAND.green, color: '#fff' }}
        >
          <Activity size={22} />
        </div>
        <div>
          <h1 className="text-xl font-bold" style={{ color: NEUTRAL.fgInk }}>
            Disponibilidad de Plantas
          </h1>
          <p className="text-xs" style={{ color: NEUTRAL.fgTer }}>
            Mini-dashboard interactivo · estado vigente y cambios recientes
          </p>
        </div>
      </div>

      <div
        className="inline-flex p-1 rounded-2xl border self-start md:self-auto"
        style={{ borderColor: NEUTRAL.hairline, backgroundColor: NEUTRAL.surface }}
      >
        {PLANTAS.map((p) => {
          const active = p === plantaSeleccionada;
          return (
            <button
              key={p}
              onClick={() => !loading && onChangePlanta(p)}
              className="px-5 py-2 rounded-xl text-sm font-semibold transition-colors"
              style={{
                backgroundColor: active ? BRAND.navy : 'transparent',
                color: active ? '#fff' : NEUTRAL.fgInk,
              }}
            >
              {p}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function EmptyState({ planta, puedeEditar, onRegistrar, loading }) {
  return (
    <div
      className="rounded-2xl border-2 border-dashed p-10 flex flex-col items-center text-center gap-4"
      style={{ borderColor: NEUTRAL.hairline, backgroundColor: NEUTRAL.surface }}
    >
      <div className="text-5xl" aria-hidden>🤷</div>
      <div>
        <div className="text-lg font-bold" style={{ color: NEUTRAL.fgInk }}>
          {loading ? 'Cargando…' : `Sin estado registrado para ${planta}`}
        </div>
        <p className="text-sm mt-1" style={{ color: NEUTRAL.fgTer }}>
          {puedeEditar
            ? 'Registra el primer estado de disponibilidad para esta planta.'
            : 'Aún no hay un registro vigente. Pedile a un Ingeniero JdT/Operación que registre el primer estado.'}
        </p>
      </div>
      {puedeEditar && !loading && (
        <button
          onClick={onRegistrar}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white shadow-sm hover:shadow-md transition-all"
          style={{ backgroundColor: BRAND.green }}
        >
          <Plus size={18} /> Registrar primer estado
        </button>
      )}
    </div>
  );
}

function ConfirmDeshacer({ planta, tieneHistorico, vigenteEvento, historicoEvento, onCancel, onConfirm }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm disp-modal-overlay">
      <div
        className="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden disp-modal-card"
        style={{ borderTop: '4px solid #DC3545' }}
      >
        <div className="px-6 py-5">
          <div className="flex items-start gap-3">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 bg-red-100 text-red-600">
              <Undo2 size={22} />
            </div>
            <div>
              <h3 className="text-lg font-bold text-gray-900">Deshacer último registro</h3>
              <p className="text-sm text-gray-600 mt-1">
                Vas a borrar el estado vigente de {planta} (
                <strong>{vigenteEvento || '—'}</strong>) y{' '}
                {tieneHistorico ? (
                  <>restaurar el anterior (<strong>{historicoEvento}</strong>) como vigente.</>
                ) : (
                  <>la planta volverá al empty state (no hay histórico).</>
                )}{' '}
                Se emitirá un registro de auditoría (CIET).
              </p>
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={onCancel}
              className="px-4 py-2 rounded-xl text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200"
            >
              Cancelar
            </button>
            <button
              onClick={onConfirm}
              className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold text-white bg-red-600 hover:bg-red-700"
            >
              <Undo2 size={16} /> Sí, deshacer
            </button>
          </div>
        </div>
      </div>
      <style>{`
        .disp-modal-overlay { animation: dispFade 180ms ease-out; }
        .disp-modal-card    { animation: dispRise 220ms ease-out; }
        @keyframes dispFade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes dispRise {
          from { opacity: 0; transform: translateY(12px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
