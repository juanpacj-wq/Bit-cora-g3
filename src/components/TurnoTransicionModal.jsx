import React, { useState } from 'react';
import { Clock, Lock, RotateCw, ShieldAlert } from 'lucide-react';

// D-045 E8 — modal BLOQUEANTE al llegar el cambio de turno (bloqueo=true). El overlay (z-50) inhabilita
// toda interacción de la unidad hasta que un Jefe de Turno / Ingeniero de Operación decide. Accionable
// (Extender / Cerrar, con confirmación en dos pasos) para quien `puede_decidir`; informativo para el
// resto. Copys en tuteo colombiano. Sin estado propio salvo el paso de confirmación.
export default function TurnoTransicionModal({ open, puedeDecidir, accionando, onExtender, onCerrar }) {
  const [confirm, setConfirm] = useState(null); // null | 'extender' | 'cerrar'
  if (!open) return null;

  const ejecutar = async (fn) => {
    try { await fn(); } finally { setConfirm(null); }
  };

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

        {puedeDecidir ? (
          confirm ? (
            <div className="px-6 pb-4">
              <div className="rounded-xl border px-4 py-3 text-sm font-medium mb-4"
                style={{ backgroundColor: '#FEF3C7', borderColor: '#FDE68A', color: '#92400E' }}>
                {confirm === 'cerrar'
                  ? 'Vas a cerrar el turno: se archivan los registros y se congela la conformación. Esta acción no se revierte.'
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
            <div className="px-6 py-4 flex gap-3 justify-end border-t border-gray-100 bg-gray-50">
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
          <div className="px-6 py-4 flex items-center gap-2 border-t border-gray-100 bg-gray-50 text-sm text-gray-500">
            <ShieldAlert size={16} className="text-amber-500 shrink-0" />
            <span>La unidad queda en pausa mientras se decide. No cierres esta ventana.</span>
          </div>
        )}
      </div>
    </div>
  );
}
