import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Inbox, Plus, Undo2 } from 'lucide-react';
import '@fontsource/public-sans/400.css';
import '@fontsource/public-sans/500.css';
import '@fontsource/public-sans/600.css';
import '@fontsource/public-sans/700.css';
import '@fontsource/public-sans/800.css';
import './disponibilidad.css';
import EstadoTopbar from './EstadoTopbar';
import EstadoActualCard from './EstadoActualCard';
import AcumuladosPorEstado from './AcumuladosPorEstado';
import TiempoEnEstadosDonut from './TiempoEnEstadosDonut';
import HistorialList from './HistorialList';
import CambiarEstadoModal from './CambiarEstadoModal';
import DashboardSkeleton from './Skeleton';
import { useDisponibilidad } from '../../hooks/useDisponibilidad';
import { PLANTAS } from './colores';

const POLL_MS = 30_000;
const HIST_PAGE = 20;

const EMPTY_BY_PLANTA = PLANTAS.reduce((acc, p) => ({ ...acc, [p]: null }), {});

// Filtro de AÑO (D-035 vive en la URL; el año es estado local del dashboard). `ANIO_TODOS` = sin
// filtro (comportamiento histórico all-time). El año actual se calcula en Bogotá (UTC-5, sin DST).
const ANIO_TODOS = 'todos';
const ANIO_ACTUAL = Number(
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric' }).format(new Date())
);
// Construye las opciones del selector: "Todos los años" (all-time) primero y fijo arriba —
// con `sep` para dibujar un divisor debajo — seguido de la lista de años (desc). Va primero para
// que sea visible sin scrollear la lista larga de años.
function buildAniosOpts(anios) {
  const lista = Array.isArray(anios) && anios.length ? anios : [ANIO_ACTUAL];
  return [
    { value: ANIO_TODOS, label: 'Todos los años', sep: true },
    ...lista.map((y) => ({ value: String(y), label: String(y) })),
  ];
}

// Ventana [desde, hasta) en UTC ISO correspondiente al año Bogotá seleccionado. `ANIO_TODOS`
// → sin ventana (undefined) para que el backend use su default all-time.
function ventanaAnio(anio) {
  if (anio === ANIO_TODOS) return { desde: undefined, hasta: undefined };
  const y = Number(anio);
  return {
    desde: new Date(Date.UTC(y, 0, 1, 5, 0, 0)).toISOString(),      // 1-ene 00:00 Bogotá
    hasta: new Date(Date.UTC(y + 1, 0, 1, 5, 0, 0)).toISOString(),  // 1-ene (y+1) 00:00 Bogotá
  };
}

// D-035: `planta`/`onPlantaChange` son controlados por el dashboard (la URL es la fuente única
// de verdad — se retiró el sessionStorage `disponibilidad.plantaSeleccionada` para evitar doble
// fuente). El padre garantiza una planta válida; el resto de la lógica (SWR por planta, polling,
// cierre cronológico) queda intacta.
export default function DisponibilidadDashboard({
  bitacoraId,
  planta,
  onPlantaChange,
  puedeEditar,
  showToast,
}) {
  const { getEstado, getMetricas, getAnios, crear, editar, deshacer } = useDisponibilidad(bitacoraId);

  const plantaSeleccionada = planta;
  const setPlantaSeleccionada = onPlantaChange;

  // F13.1 SWR cache: cada planta mantiene su data {vigente,historial,historial_total} y un
  // flag `loaded` (false hasta el primer fetch). Skeleton se muestra solo cuando
  // !dataByPlanta[planta].loaded — re-visitas son instantáneas + refresh silencioso.
  const [dataByPlanta, setDataByPlanta] = useState(EMPTY_BY_PLANTA);
  // Filtro de AÑO: acota historial + acumulados. Default = año actual (Bogotá).
  const [anio, setAnio] = useState(String(ANIO_ACTUAL));
  // Opciones del selector, data-driven: rango real desde el primer registro DISP. Fallback = año
  // actual hasta que llega la respuesta de /anios.
  const [aniosOpts, setAniosOpts] = useState(() => buildAniosOpts([ANIO_ACTUAL]));
  const [error, setError] = useState(null);
  const [modal, setModal] = useState(null); // { mode: 'crear' | 'editar' }
  const [confirmDeshacer, setConfirmDeshacer] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const fadeKey = useRef(0);

  const fetchEstado = useCallback(
    async (planta, { silent = false } = {}) => {
      try {
        // Ventana del año seleccionado — acota historial (getEstado) y acumulados (getMetricas).
        const { desde, hasta } = ventanaAnio(anio);
        // Estado vigente + acumulados en paralelo. metricas se degrada a null si falla (el
        // panel de acumulados simplemente no se muestra) — no debe tumbar la carga del estado.
        const [res, met] = await Promise.all([
          getEstado(planta, { historial_limit: HIST_PAGE, historial_offset: 0, desde, hasta }),
          getMetricas(planta, { desde, hasta }).catch(() => null),
        ]);
        setDataByPlanta((prev) => ({
          ...prev,
          [planta]: {
            vigente: res.vigente || null,
            historial: res.historial || [],
            historial_total: res.historial_total || 0,
            metricas: met,
            loaded: true,
          },
        }));
        if (!silent) setError(null);
      } catch (e) {
        if (!silent) setError(e.message || 'Error al cargar disponibilidad');
      }
    },
    [getEstado, getMetricas, anio]
  );

  // Años disponibles para el selector (una sola vez al montar). Falla en silencio → fallback.
  useEffect(() => {
    let cancelado = false;
    getAnios()
      .then((r) => { if (!cancelado) setAniosOpts(buildAniosOpts(r?.anios)); })
      .catch(() => {});
    return () => { cancelado = true; };
  }, [getAnios]);

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
      const { desde, hasta } = ventanaAnio(anio);
      const res = await getEstado(plantaSeleccionada, {
        historial_limit: HIST_PAGE,
        historial_offset: cur.historial.length,
        desde,
        hasta,
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
  }, [loadingMore, dataByPlanta, plantaSeleccionada, getEstado, showToast, anio]);

  const data = dataByPlanta[plantaSeleccionada];
  const isFirstLoad = !data?.loaded;
  // Solo el año en curso (o "Todos") crece en vivo; un año pasado muestra acumulados congelados.
  const enVivo = anio === ANIO_TODOS || anio === String(ANIO_ACTUAL);

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
    <div className="disp-root" style={{ flex: 1, minHeight: 0 }}>
      <div className="wrap">
        {error && (
          <div
            className="card disp-fade"
            style={{
              padding: 12, marginBottom: 18, display: 'flex', gap: 12, alignItems: 'flex-start',
              border: '1px solid #FCA5A5', background: '#FEF2F2', color: '#7F1D1D', boxShadow: 'none',
            }}
          >
            <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: 13 }}>
              <div style={{ fontWeight: 700 }}>No se pudo cargar la disponibilidad</div>
              <div style={{ opacity: 0.9 }}>{error}</div>
            </div>
          </div>
        )}

        <div
          key={fadeKey.current}
          className="disp-fade"
          style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
        >
          <EstadoTopbar
            plantaSeleccionada={plantaSeleccionada}
            codigo={data?.vigente?.codigo}
            puedeEditar={puedeEditar}
            tieneVigente={!!data?.vigente}
            anio={anio}
            anios={aniosOpts}
            onChangeAnio={setAnio}
            onChangePlanta={setPlantaSeleccionada}
            onCambiar={() => setModal({ mode: 'crear' })}
            onEditar={() => setModal({ mode: 'editar' })}
            onDeshacer={() => setConfirmDeshacer(true)}
          />

          {isFirstLoad ? (
            <DashboardSkeleton />
          ) : data?.vigente ? (
            <>
              <AcumuladosPorEstado metricas={data.metricas} vigente={data.vigente} enVivo={enVivo} />
              <div className="state-grid">
                <TiempoEnEstadosDonut metricas={data.metricas} vigente={data.vigente} />
                <EstadoActualCard
                  vigente={data.vigente}
                  plantaSeleccionada={plantaSeleccionada}
                  metricas={data.metricas}
                />
              </div>
              <HistorialList
                planta={plantaSeleccionada}
                historial={data.historial}
                total={data.historial_total}
                loading={loadingMore}
                hasMore={tienePuedeMas}
                onLoadMore={cargarMasHistorial}
              />
            </>
          ) : (
            <>
              <EmptyState
                planta={plantaSeleccionada}
                puedeEditar={puedeEditar}
                onRegistrar={() => setModal({ mode: 'crear' })}
              />
              <HistorialList
                planta={plantaSeleccionada}
                historial={data?.historial || []}
                total={data?.historial_total || 0}
                loading={loadingMore}
                hasMore={tienePuedeMas}
                onLoadMore={cargarMasHistorial}
              />
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
    </div>
  );
}

function EmptyState({ planta, puedeEditar, onRegistrar }) {
  return (
    <div
      className="card"
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center',
        gap: 12, padding: 32, marginBottom: 18,
      }}
    >
      <Inbox size={36} style={{ color: 'var(--muted)' }} />
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink-dark)' }}>
          Sin estado registrado para {planta}
        </div>
        {!puedeEditar && (
          <p style={{ fontSize: 13, marginTop: 4, color: 'var(--muted)' }}>
            Sin permisos de escritura.
          </p>
        )}
      </div>
      {puedeEditar && (
        <button type="button" className="btn btn-green" onClick={onRegistrar}>
          <Plus /> Registrar primer estado
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
