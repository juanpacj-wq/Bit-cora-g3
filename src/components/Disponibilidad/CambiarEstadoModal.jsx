import React, { useEffect, useMemo, useState } from 'react';
import { X, AlertTriangle, Save } from 'lucide-react';
import { ESTADOS, PLANTAS, NEUTRAL, BRAND } from './colores';

const CODIGO_POR_EVENTO = { Disponible: 1, 'En Reserva': 0, Indisponible: -1 };

// F20: input `datetime-local` interpreta el valor tipeado como hora Bogotá; el frontend
// convierte a UTC apendiendo -05:00 fijo (Colombia sin DST) antes de enviar al server.
const BOGOTA_LOCAL_FMT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Bogota',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
const FECHA_CORTA_FMT = new Intl.DateTimeFormat('es-CO', {
  timeZone: 'America/Bogota',
  day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
});

function toDatetimeLocal(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return BOGOTA_LOCAL_FMT.format(d).replace(' ', 'T').slice(0, 16);
}

function toIsoFromLocal(value) {
  if (!value) return null;
  const d = new Date(`${value}:00-05:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function formatFechaCorta(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return FECHA_CORTA_FMT.format(d);
}

// `mode='crear'`: planta editable, vigente?.fecha_inicio_estado define `min`.
// `mode='editar'`: planta deshabilitada (rechazo backend con 422), estado y fecha
//   preseleccionados al vigente; `min` lo da el N-1 (último histórico) — el plan
//   reformuló la pregunta 3 de preguntas_disp3.md y confirmó esto.
export default function CambiarEstadoModal({
  mode,
  plantaActual,
  vigente,
  ultimoHistorico,
  onClose,
  onSubmit,
}) {
  const isEdit = mode === 'editar';

  const [planta, setPlanta] = useState(plantaActual || PLANTAS[0]);
  const [evento, setEvento] = useState(isEdit ? (vigente?.evento || ESTADOS[0]) : ESTADOS[0]);
  const [fechaLocal, setFechaLocal] = useState(() =>
    isEdit ? toDatetimeLocal(vigente?.fecha_inicio_estado) : toDatetimeLocal(new Date())
  );
  const [detalle, setDetalle] = useState(isEdit ? (vigente?.detalle || '') : '');
  const [submitting, setSubmitting] = useState(false);
  const [popup, setPopup] = useState(null); // { titulo, mensaje, tipo }

  useEffect(() => {
    setPlanta(plantaActual || PLANTAS[0]);
  }, [plantaActual]);

  const minLocal = useMemo(() => {
    if (isEdit) return toDatetimeLocal(ultimoHistorico?.fecha_inicio_estado);
    if (vigente?.fecha_inicio_estado) {
      // En crear, fecha nueva debe ser > vigente. min = vigente + 1 minuto.
      const d = new Date(vigente.fecha_inicio_estado);
      d.setMinutes(d.getMinutes() + 1);
      return toDatetimeLocal(d);
    }
    return undefined;
  }, [isEdit, vigente, ultimoHistorico]);

  const maxLocal = useMemo(() => toDatetimeLocal(new Date()), [submitting]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setPopup(null);

    const isoFecha = toIsoFromLocal(fechaLocal);
    if (!isoFecha) {
      setPopup({ tipo: 'warn', titulo: 'Fecha inválida', mensaje: 'Ingresa una fecha y hora válidas.' });
      return;
    }
    if (detalle.length > 500) {
      setPopup({ tipo: 'warn', titulo: 'Detalle demasiado largo', mensaje: 'Máximo 500 caracteres.' });
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit({
        planta,
        evento,
        codigo: CODIGO_POR_EVENTO[evento],
        fecha_inicio_estado: isoFecha,
        detalle: detalle.trim() || null,
      });
    } catch (err) {
      setPopup(buildPopup(err, planta, fechaLocal));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm disp-modal-overlay">
      <div
        className="bg-white rounded-xl shadow-xl max-w-lg w-full mx-4 overflow-hidden disp-modal-card"
        style={{ borderTop: `4px solid ${BRAND.green}` }}
      >
        <div
          className="px-6 py-4 flex items-center justify-between border-b"
          style={{ borderColor: NEUTRAL.hairline }}
        >
          <h3 className="text-base font-semibold" style={{ color: NEUTRAL.fgInk }}>
            {isEdit ? 'Editar estado vigente' : 'Cambiar estado de planta'}
          </h3>
          <button
            onClick={onClose}
            disabled={submitting}
            className="p-1 rounded hover:bg-gray-100 transition-colors disabled:opacity-50"
            aria-label="Cerrar"
          >
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <Field label="Planta">
            <select
              value={planta}
              onChange={(e) => setPlanta(e.target.value)}
              disabled={isEdit}
              className="w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 disabled:bg-gray-50 disabled:text-gray-500"
              style={{ borderColor: NEUTRAL.hairline }}
            >
              {PLANTAS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </Field>

          <Field label="Estado">
            <select
              value={evento}
              onChange={(e) => setEvento(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2"
              style={{ borderColor: NEUTRAL.hairline }}
            >
              {ESTADOS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </Field>

          <Field label="Fecha y hora del evento">
            <input
              type="datetime-local"
              value={fechaLocal}
              onChange={(e) => setFechaLocal(e.target.value)}
              min={minLocal || undefined}
              max={maxLocal}
              required
              className="w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2"
              style={{ borderColor: NEUTRAL.hairline }}
            />
            {minLocal && (
              <p className="text-[11px] mt-1" style={{ color: NEUTRAL.fgTer }}>
               
              </p>
            )}
          </Field>

          <Field label="Detalle (opcional)">
            <textarea
              value={detalle}
              onChange={(e) => setDetalle(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="Mantenimiento finalizado, falla en bomba, etc."
              className="w-full px-3 py-2 rounded-xl border text-sm focus:outline-none focus:ring-2 resize-none"
              style={{ borderColor: NEUTRAL.hairline }}
            />
            <p className="text-[11px] mt-1 text-right" style={{ color: NEUTRAL.fgTer }}>
              {detalle.length}/500
            </p>
          </Field>

          {popup && (
            <div
              className="rounded-xl p-3 text-sm flex gap-2 items-start"
              style={{
                backgroundColor: popup.tipo === 'error' ? '#FEE2E2' : '#FEF3C7',
                color: popup.tipo === 'error' ? '#7F1D1D' : '#7C5400',
              }}
            >
              <AlertTriangle size={18} className="flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">{popup.titulo}</div>
                <div className="opacity-90">{popup.mensaje}</div>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 rounded-xl text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold text-white shadow-sm transition-all disabled:opacity-60"
              style={{ backgroundColor: BRAND.green }}
            >
              <Save size={16} />
              {submitting ? 'Guardando…' : (isEdit ? 'Guardar cambios' : 'Registrar')}
            </button>
          </div>
        </form>
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

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="text-[11px] font-medium mb-1" style={{ color: NEUTRAL.fgTer }}>
        {label}
      </div>
      {children}
    </label>
  );
}

function buildPopup(err, planta, fechaLocal) {
  const code = err?.body?.error;
  const vig = err?.body?.vigente;
  const nminus1 = err?.body?.n_menos_1;

  if (code === 'mismo_estado' && vig) {
    return {
      tipo: 'error',
      titulo: 'Estado igual al vigente',
      mensaje: `${planta} ya está en estado ${vig.evento} desde ${formatFechaCorta(vig.fecha_inicio_estado)}. Para registrar un cambio, elige un estado distinto.`,
    };
  }
  if (code === 'fecha_anterior_a_vigente' && vig) {
    return {
      tipo: 'error',
      titulo: 'Fecha inválida',
      mensaje: `La fecha que ingresaste (${formatFechaCorta(toIsoFromLocal(fechaLocal))}) es anterior o igual al estado actual de ${planta} (${formatFechaCorta(vig.fecha_inicio_estado)}). Elige una fecha posterior.`,
    };
  }
  if (code === 'mismo_estado_que_anterior' && nminus1) {
    return {
      tipo: 'error',
      titulo: 'Estado igual al anterior',
      mensaje: `El estado anterior ya era ${nminus1.evento}; no se permite la misma secuencia. Desház el último o selecciona otro estado.`,
    };
  }
  if (err?.status === 403) {
    return { tipo: 'error', titulo: 'Sin permiso', mensaje: 'No tienes permiso para esta operación.' };
  }
  if (err?.status === 422) {
    return { tipo: 'warn', titulo: 'No válido', mensaje: err?.body?.mensaje || err?.message || 'La operación fue rechazada.' };
  }
  return {
    tipo: 'error',
    titulo: 'Error',
    mensaje: err?.body?.mensaje || err?.message || 'No se pudo guardar el cambio.',
  };
}
