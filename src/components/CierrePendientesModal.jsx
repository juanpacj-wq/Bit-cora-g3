import React from 'react';
import { Lock, X, AlertTriangle, FileText, Users } from 'lucide-react';

// D-045: modal de pendientes antes de cerrar el turno de la unidad. Muestra:
//   - bitácoras con borradores (de /api/cierre/preview-masivo).
//   - ingenieros con sesión activa que no han hecho "Finalizar turno".
// "Cerrar de todas formas" → finaliza forzado a los ingenieros pendientes (POST finalizar-forzado)
// y luego cierra el turno por cabecera (POST /api/turno/cerrar). Copys en tuteo colombiano.
export default function CierrePendientesModal({
  open,
  preview,                  // { bitacoras_pendientes, ingenieros_no_finalizados }
  bitacorasMap,             // Map(bitacora_id → nombre) para resolver IDs en bitacoras_abiertas
  loading,
  onConfirm,
  onCancel,
}) {
  if (!open) return null;
  const cargando = preview === 'loading' || preview == null;
  const { bitacoras_pendientes = [], ingenieros_no_finalizados = [] } = cargando ? {} : preview;
  const total = bitacoras_pendientes.length + ingenieros_no_finalizados.length;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full mx-4 overflow-hidden animate-scale-in">
        <div className="px-6 pt-6 pb-4 flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 bg-amber-100 text-amber-600">
            <AlertTriangle size={24} />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-bold text-gray-900">Cerrar turno de la unidad</h3>
            <p className="text-sm text-gray-500 mt-1">
              {cargando
                ? 'Revisando pendientes del turno…'
                : total === 0
                  ? 'No hay pendientes. Al cerrar, se archivan los registros y se congela la conformación. Esta acción no se revierte (se puede reabrir).'
                  : 'Hay pendientes. Si cierras, los ingenieros listados quedan finalizados de forma forzada y sus borradores se archivan.'}
            </p>
          </div>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600" aria-label="Cerrar">
            <X size={20} />
          </button>
        </div>

        <div className="px-6 pb-2 max-h-96 overflow-auto space-y-4">
          <section>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-2">
              <FileText size={14} /> Bitácoras con borradores
            </h4>
            {cargando ? (
              <div className="text-sm text-gray-400 italic px-3 py-2">Cargando…</div>
            ) : bitacoras_pendientes.length === 0 ? (
              <div className="text-sm text-gray-400 italic px-3 py-2">Ninguna.</div>
            ) : (
              <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
                {bitacoras_pendientes.map((b) => (
                  <li key={b.bitacora_id} className="px-4 py-2.5 flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-900">{b.nombre}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
                      {b.registros_borrador} borrador{b.registros_borrador === 1 ? '' : 'es'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-2">
              <Users size={14} /> Ingenieros sin finalizar turno
            </h4>
            {cargando ? (
              <div className="text-sm text-gray-400 italic px-3 py-2">Cargando…</div>
            ) : ingenieros_no_finalizados.length === 0 ? (
              <div className="text-sm text-gray-400 italic px-3 py-2">Ninguno.</div>
            ) : (
              <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
                {ingenieros_no_finalizados.map((u) => (
                  <li key={u.usuario_id} className="px-4 py-2.5">
                    <div className="text-sm font-medium text-gray-900">{u.nombre_completo}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      Bitácoras abiertas:{' '}
                      {u.bitacoras_abiertas
                        .map((id) => bitacorasMap?.get?.(id) || `#${id}`)
                        .join(', ') || '—'}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="px-6 py-4 flex gap-3 justify-end border-t border-gray-100 bg-gray-50">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-5 py-2.5 rounded-xl text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-100 disabled:opacity-60 transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            disabled={loading || cargando}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 transition-colors"
          >
            <Lock size={16} />
            {loading ? 'Cerrando…' : (total === 0 ? 'Cerrar turno' : 'Cerrar de todas formas')}
          </button>
        </div>
      </div>
    </div>
  );
}
