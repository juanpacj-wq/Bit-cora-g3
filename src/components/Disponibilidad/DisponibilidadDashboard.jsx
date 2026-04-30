import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Inbox, Plus, Undo2 } from 'lucide-react';
import EstadoActualCard from './EstadoActualCard';
import HistorialList from './HistorialList';
import CambiarEstadoModal from './CambiarEstadoModal';
import DashboardSkeleton from './Skeleton';
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

const EMPTY_BY_PLANTA = PLANTAS.reduce((acc, p) => ({ ...acc, [p]: null }), {});

export default function DisponibilidadDashboard({
  bitacoraId,
  plantaInicial,
  puedeEditar,
  showToast,
}) {
  const { getEstado, crear, editar, deshacer } = useDisponibilidad(bitacoraId);

  const [plantaSeleccionada, setPlantaSeleccionada] = useState(() => loadStoredPlanta(plantaInicial));

  // F13.1 SWR cache: cada planta mantiene su data {vigente,historial,historial_total} y un
  // flag `loaded` (false hasta el primer fetch). Skeleton se muestra solo cuando
  // !dataByPlanta[planta].loaded — re-visitas son instantáneas + refresh silencioso.
  const [dataByPlanta, setDataByPlanta] = useState(EMPTY_BY_PLANTA);
  const [error, setError] = useState(null);
  const [modal, setModal] = useState(null); // { mode: 'crear' | 'editar' }
  const [confirmDeshacer, setConfirmDeshacer] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const fadeKey = useRef(0);

  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, plantaSeleccionada); } catch {}
  }, [plantaSeleccionada]);

  const fetchEstado = useCallback(
    async (planta, { silent = false } = {}) => {
      try {
        const res = await getEstado(planta, { historial_limit: HIST_PAGE, historial_offset: 0 });
        setDataByPlanta((prev) => ({
          ...prev,
          [planta]: {
            vigente: res.vigente || null,
            historial: res.historial || [],
            historial_total: res.historial_total || 0,
            loaded: true,
          },
        }));
        if (!silent) setError(null);
      } catch (e) {
        if (!silent) setError(e.message || 'Error al cargar disponibilidad');
      }
    },
    [getEstado]
  );

  // Fetch al cambiar de planta. SWR: si ya hay cache, refrescamos en silencio.
  useEffect(() => {
    fadeKey.current += 1;
    const cached = dataByPlanta[plantaSeleccionada];
    fetchEstado(plantaSeleccionada, { silent: !!cached?.loaded });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plantaSeleccionada, fetchEstado]);

  // Polling silencioso cada 30s solo de la planta activa.
  useEffect(() => {
    const id = setInterval(() => {
      fetchEstado(plantaSeleccionada, { silent: true });
    }, POLL_MS);
    return () => clearInterval(id);
  }, [plantaSeleccionada, fetchEstado]);

  const cargarMasHistorial = useCallback(async () => {
    if (loadingMore) return;
    const cur = dataByPlanta[plantaSeleccionada];
    if (!cur) return;
    setLoadingMore(true);
    try {
      const res = await getEstado(plantaSeleccionada, {
        historial_limit: HIST_PAGE,
        historial_offset: cur.historial.length,
      });
      setDataByPlanta((prev) => {
        const prevCur = prev[plantaSeleccionada];
        if (!prevCur) return prev;
        return {
          ...prev,
          [plantaSeleccionada]: {
            ...prevCur,
            historial: [...prevCur.historial, ...(res.historial || [])],
            historial_total: res.historial_total ?? prevCur.historial_total,
          },
        };
      });
    } catch (e) {
      showToast?.(e.message || 'Error al cargar más', 'error');
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, dataByPlanta, plantaSeleccionada, getEstado, showToast]);

  const data = dataByPlanta[plantaSeleccionada];
  const isFirstLoad = !data?.loaded;

  const handleSubmitModal = useCallback(
    async (form) => {
      if (modal?.mode === 'editar') {
        const reg = data?.vigente;
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
      await fetchEstado(form.planta || plantaSeleccionada, { silent: true });
    },
    [modal, data, editar, crear, showToast, plantaSeleccionada, fetchEstado]
  );

  const handleDeshacerConfirm = useCallback(async () => {
    setConfirmDeshacer(false);
    try {
      await deshacer(plantaSeleccionada);
      showToast?.('Último registro deshecho');
      await fetchEstado(plantaSeleccionada, { silent: true });
    } catch (e) {
      showToast?.(e.body?.mensaje || e.message || 'Error al deshacer', 'error');
    }
  }, [deshacer, plantaSeleccionada, showToast, fetchEstado]);

  const ultimoHistorico = data?.historial?.[0] || null;
  const tienePuedeMas = data ? data.historial.length < (data.historial_total || 0) : false;

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden"
      style={{ backgroundColor: NEUTRAL.canvas }}
    >
      <div className="max-w-7xl mx-auto w-full px-8 pt-6 pb-4 flex flex-col flex-1 min-h-0 gap-4">
        <Header
          plantaSeleccionada={plantaSeleccionada}
          onChangePlanta={setPlantaSeleccionada}
        />

        {error && (
          <div
            className="rounded-lg p-3 flex items-start gap-3 border"
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
          key={fadeKey.current}
          className="flex flex-col flex-1 min-h-0 gap-4 disp-fade"
        >
          {isFirstLoad ? (
            <DashboardSkeleton />
          ) : data?.vigente ? (
            <>
              <EstadoActualCard
                vigente={data.vigente}
                puedeEditar={puedeEditar}
                onCambiar={() => setModal({ mode: 'crear' })}
                onEditar={() => setModal({ mode: 'editar' })}
                onDeshacer={() => setConfirmDeshacer(true)}
              />
              <div className="flex-1 min-h-0 flex flex-col">
                <HistorialList
                  planta={plantaSeleccionada}
                  historial={data.historial}
                  total={data.historial_total}
                  loading={loadingMore}
                  hasMore={tienePuedeMas}
                  onLoadMore={cargarMasHistorial}
                />
              </div>
            </>
          ) : (
            <>
              <EmptyState
                planta={plantaSeleccionada}
                puedeEditar={puedeEditar}
                onRegistrar={() => setModal({ mode: 'crear' })}
              />
              <div className="flex-1 min-h-0 flex flex-col">
                <HistorialList
                  planta={plantaSeleccionada}
                  historial={data?.historial || []}
                  total={data?.historial_total || 0}
                  loading={loadingMore}
                  hasMore={tienePuedeMas}
                  onLoadMore={cargarMasHistorial}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {modal && (
        <CambiarEstadoModal
          mode={modal.mode}
          plantaActual={plantaSeleccionada}
          vigente={data?.vigente}
          ultimoHistorico={ultimoHistorico}
          onClose={() => setModal(null)}
          onSubmit={handleSubmitModal}
        />
      )}

      {confirmDeshacer && (
        <ConfirmDeshacer
          planta={plantaSeleccionada}
          tieneHistorico={!!ultimoHistorico}
          vigenteEvento={data?.vigente?.evento}
          historicoEvento={ultimoHistorico?.evento}
          onCancel={() => setConfirmDeshacer(false)}
          onConfirm={handleDeshacerConfirm}
        />
      )}

      <style>{`
        .disp-fade { animation: dispFadeIn 150ms ease-out; }
        @keyframes dispFadeIn { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
    </div>
  );
}

function Header({ plantaSeleccionada, onChangePlanta }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h1 className="text-lg font-semibold" style={{ color: NEUTRAL.fgInk }}>
        Disponibilidad de Plantas
      </h1>

      <div
        className="inline-flex p-1 rounded-lg border"
        style={{ borderColor: NEUTRAL.hairline, backgroundColor: NEUTRAL.surface }}
      >
        {PLANTAS.map((p) => {
          const active = p === plantaSeleccionada;
          return (
            <button
              key={p}
              onClick={() => onChangePlanta(p)}
              className="px-4 py-1.5 rounded-md text-sm font-medium transition-colors"
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

function EmptyState({ planta, puedeEditar, onRegistrar }) {
  return (
    <div
      className="rounded-xl border border-dashed p-8 flex flex-col items-center text-center gap-3"
      style={{ borderColor: NEUTRAL.hairline, backgroundColor: NEUTRAL.surface }}
    >
      <Inbox size={36} style={{ color: NEUTRAL.fgTer }} />
      <div>
        <div className="text-base font-semibold" style={{ color: NEUTRAL.fgInk }}>
          Sin estado registrado para {planta}
        </div>
        {!puedeEditar && (
          <p className="text-sm mt-1" style={{ color: NEUTRAL.fgTer }}>
            Sin permisos de escritura.
          </p>
        )}
      </div>
      {puedeEditar && (
        <button
          onClick={onRegistrar}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white shadow-sm hover:shadow transition-all"
          style={{ backgroundColor: BRAND.green }}
        >
          <Plus size={16} /> Registrar primer estado
        </button>
      )}
    </div>
  );
}

function ConfirmDeshacer({ planta, tieneHistorico, vigenteEvento, historicoEvento, onCancel, onConfirm }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm disp-modal-overlay">
      <div
        className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4 overflow-hidden disp-modal-card"
        style={{ borderTop: '4px solid #DC3545' }}
      >
        <div className="px-6 py-5">
          <h3 className="text-base font-semibold text-gray-900">Deshacer último registro</h3>
          <p className="text-sm text-gray-600 mt-2">
            Borra el vigente de <strong>{planta}</strong> ({vigenteEvento || '—'}) y{' '}
            {tieneHistorico
              ? <>restaura el anterior (<strong>{historicoEvento}</strong>) como vigente.</>
              : <>deja la planta sin estado.</>
            }{' '}
            Queda registro de auditoría.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={onCancel}
              className="px-4 py-2 rounded-lg text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200"
            >
              Cancelar
            </button>
            <button
              onClick={onConfirm}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-700"
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
          from { opacity: 0; transform: translateY(8px) scale(0.99); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
