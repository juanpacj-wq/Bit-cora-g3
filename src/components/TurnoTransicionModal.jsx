import React, { useState, useEffect } from 'react';
import { Clock, Lock, RotateCw, ShieldAlert, Building2, Timer } from 'lucide-react';

// D-045 E8 + cosmético — modal BLOQUEANTE al llegar el cambio de turno (bloqueo=true). El overlay (z-50)
// inhabilita toda interacción de la unidad hasta que un Jefe de Turno / Ingeniero de Operación decide.
// Muestra el contexto concreto: unidad + turno, hora nominal de cierre y una cuenta regresiva al
// auto-cierre (fin_nominal + 1h de gracia si nadie decide). Accionable (Extender / Cerrar, con
// confirmación en dos pasos) para quien `puede_decidir`; informativo para el resto. Copys en tuteo.

// Gracia del auto-cierre AUTO_SIN_RESPUESTA (espejo de GRACIA_CIERRE_MIN en server/utils/turno-entidad.js).
const GRACIA_CIERRE_MIN = 60;

const fmtHora = (d) =>
  new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

// Restante legible: "8 min", "1 h 05 min", "menos de 1 min".
const fmtRestante = (ms) => {
  if (ms <= 0) return 'en breve';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return 'menos de 1 min';
  if (totalMin < 60) return `${totalMin} min`;
  return `${Math.floor(totalMin / 60)} h ${String(totalMin % 60).padStart(2, '0')} min`;
};

export default function TurnoTransicionModal({
  open, puedeDecidir, accionando, plantaNombre, turno, finNominal, onExtender, onCerrar,
}) {
  const [confirm, setConfirm] = useState(null); // null | 'extender' | 'cerrar'
  const [now, setNow] = useState(() => Date.now());

  // Cuenta regresiva viva mientras el modal está abierto (tick cada segundo).
  useEffect(() => {
    if (!open) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open]);

  if (!open) return null;

  const ejecutar = async (fn) => {
    try { await fn(); } finally { setConfirm(null); }
  };

  const finNominalDate = finNominal ? new Date(finNominal) : null;
  const autoCierreDate = finNominalDate ? new Date(finNominalDate.getTime() + GRACIA_CIERRE_MIN * 60000) : null;
  const restanteMs = autoCierreDate ? autoCierreDate.getTime() - now : null;
  const urgente = restanteMs != null && restanteMs <= 10 * 60000; // ≤10 min → rojo

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden animate-scale-in">
        <div className="px-6 pt-6 pb-4 flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 bg-amber-100 text-amber-600">
            <Clock size={24} />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-bold text-gray-900">Cambio de turno</h3>
            <p className="text-sm text-gray-500 mt-1">
              {puedeDecidir
                ? 'El turno llegó a su hora de cierre. Extiéndelo si la operación continúa o ciérralo para sellar la conformación y archivar los registros.'
                : 'El turno está en transición. Espera la decisión del Jefe de Turno o el Ingeniero de Operación.'}
            </p>
          </div>
        </div>

        {/* Contexto: unidad + turno, hora de cierre y cuenta regresiva al auto-cierre. */}
        <div className="px-6 pb-2">
          <div className="rounded-xl border border-gray-200 bg-gray-50 divide-y divide-gray-100 text-sm">
            <div className="flex items-center gap-2 px-4 py-2.5 text-gray-700">
              <Building2 size={15} className="text-gray-400 shrink-0" />
              <span className="text-gray-500">Unidad</span>
              <span className="ml-auto font-semibold text-gray-900">
                {(plantaNombre || '—')}{turno ? ` · Turno T${turno}` : ''}
              </span>
            </div>
            {finNominalDate && (
              <div className="flex items-center gap-2 px-4 py-2.5 text-gray-700">
                <Clock size={15} className="text-gray-400 shrink-0" />
                <span className="text-gray-500">Hora de cierre</span>
                <span className="ml-auto font-semibold text-gray-900 font-mono">{fmtHora(finNominalDate)}</span>
              </div>
            )}
            {autoCierreDate && (
              <div className="flex items-center gap-2 px-4 py-2.5" style={{ color: urgente ? '#B91C1C' : '#B45309' }}>
                <Timer size={15} className="shrink-0" />
                <span className="opacity-90">Cierre automático</span>
                <span className="ml-auto font-semibold font-mono">
                  {fmtHora(autoCierreDate)} · {fmtRestante(restanteMs)}
                </span>
              </div>
            )}
          </div>
        </div>

        {puedeDecidir ? (
          confirm ? (
            <div className="px-6 pt-4 pb-4">
              <div className="rounded-xl border px-4 py-3 text-sm font-medium mb-4"
                style={{ backgroundColor: '#FEF3C7', borderColor: '#FDE68A', color: '#92400E' }}>
                {confirm === 'cerrar'
                  ? 'Vas a cerrar el turno: se archivan los registros y se congela la conformación. Se puede reabrir si fue un error.'
                  : 'Vas a extender el turno hasta el próximo cambio de turno.'}
              </div>
              <div className="flex gap-3 justify-end">
                <button onClick={() => setConfirm(null)} disabled={accionando}
                  className="px-5 py-2.5 rounded-xl text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-100 disabled:opacity-60 transition-colors">
                  Cancelar
                </button>
                <button
                  onClick={() => ejecutar(confirm === 'cerrar' ? onCerrar : onExtender)}
                  disabled={accionando}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-60 transition-colors"
                  style={{ backgroundColor: confirm === 'cerrar' ? '#1D4ED8' : '#047857' }}>
                  {confirm === 'cerrar' ? <Lock size={16} /> : <RotateCw size={16} />}
                  {accionando ? 'Procesando…' : (confirm === 'cerrar' ? 'Sí, cerrar turno' : 'Sí, extender')}
                </button>
              </div>
            </div>
          ) : (
            <div className="px-6 py-4 mt-2 flex gap-3 justify-end border-t border-gray-100 bg-gray-50">
              <button onClick={() => setConfirm('extender')} disabled={accionando}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-60 transition-colors"
                style={{ backgroundColor: '#047857' }}>
                <RotateCw size={16} /> Extender turno
              </button>
              <button onClick={() => setConfirm('cerrar')} disabled={accionando}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-60 transition-colors"
                style={{ backgroundColor: '#1D4ED8' }}>
                <Lock size={16} /> Cerrar turno
              </button>
            </div>
          )
        ) : (
          <div className="px-6 py-4 mt-2 flex items-center gap-2 border-t border-gray-100 bg-gray-50 text-sm text-gray-500">
            <ShieldAlert size={16} className="text-amber-500 shrink-0" />
            <span>
              La unidad queda en pausa mientras se decide.
              {autoCierreDate ? ` Si nadie responde, se cerrará solo a las ${fmtHora(autoCierreDate)}.` : ''}
              {' '}No cierres esta ventana.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
