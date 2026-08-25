import React, { useState } from 'react';
import { X, AlertTriangle, Trash2 } from 'lucide-react';
import { horaBogotaHHMM } from '../../utils/fecha';

// D-057 — Confirmación de borrado de un lote de Operación 24h.
//
// El borrado es REAL y no hay deshacer (RN-04.c): en MAND no existe el "registro anulado visible"
// que sí tiene DISP — un renglón tachado en la lista de llamadas al CND no informa, confunde. Por
// eso la confirmación muestra el lote COMPLETO (tipo, hora, periodos y valores): quien confirma
// tiene que poder ver exactamente qué desaparece, sin volver al listado.
//
// Si alguno de esos periodos era el publicado al dashboard, al borrarlo el publicado RETROCEDE al
// registro anterior de ese mismo periodo, o deja de existir si no queda ninguno. Se dice explícito
// porque es la consecuencia menos obvia del borrado.
export default function LoteBorrarModal({ lote, onConfirmar, onCerrar }) {
  const [borrando, setBorrando] = useState(false);
  const [error, setError] = useState(null);
  const hora = lote.hora_llamada ? horaBogotaHHMM(lote.hora_llamada) : null;
  const periodos = (lote.periodos || []).slice().sort((a, b) => a.periodo - b.periodo);
  const habiaPublicado = periodos.some((p) => p.publicado);

  const handleConfirmar = async () => {
    if (borrando) return;
    setError(null);
    setBorrando(true);
    try {
      await onConfirmar();
    } catch (e) {
      setError(e?.message || 'No se pudo eliminar el registro.');
    } finally {
      setBorrando(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm px-4">
      <div className="bg-white rounded-xl shadow-xl max-w-lg w-full" style={{ borderTop: '4px solid #dc2626' }}>
        <div className="px-6 py-4 flex items-center justify-between border-b border-gray-200">
          <h3 className="text-base font-semibold text-gray-800">Eliminar registro</h3>
          <button
            type="button"
            onClick={onCerrar}
            disabled={borrando}
            className="p-1 rounded hover:bg-gray-100 transition-colors disabled:opacity-50"
            aria-label="Cerrar"
          >
            <X size={20} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <p className="text-sm text-gray-700">
            Vas a eliminar este registro de Operación 24h. La acción no se puede deshacer.
          </p>

          <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 space-y-2">
            <div className="text-sm font-semibold text-gray-800">{lote.tipo_nombre || lote.tipo}</div>
            <div className="text-xs text-gray-600">
              Hora de la llamada: {hora ?? <span className="text-gray-400">sin hora</span>}
            </div>
            {lote.funcionariocnd && (
              <div className="text-xs text-gray-600">Funcionario CND: {lote.funcionariocnd}</div>
            )}
            {lote.detalle && <div className="text-xs text-gray-600">Descripción: {lote.detalle}</div>}
            <div className="flex flex-wrap gap-1 pt-1">
              {periodos.map((p) => (
                <span
                  key={p.registro_id ?? p.periodo}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-gray-200 bg-white text-xs text-gray-700"
                >
                  {p.publicado && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />}
                  P{p.periodo} · {p.valor_mw}
                </span>
              ))}
              {periodos.length === 0 && <span className="text-xs text-gray-400">Sin periodos</span>}
            </div>
          </div>

          {habiaPublicado && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 text-xs text-amber-800 flex gap-2 items-start">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
              <span>
                Hay periodos publicados al dashboard. Al eliminar, cada uno vuelve al registro anterior de
                ese mismo periodo; si no hay ninguno, deja de publicarse.
              </span>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 flex gap-2 items-start text-sm text-red-800">
              <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onCerrar}
              disabled={borrando}
              className="px-4 py-2 rounded-xl text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleConfirmar}
              disabled={borrando}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold text-white bg-red-600 hover:bg-red-700 shadow-sm transition-all disabled:opacity-60"
            >
              <Trash2 size={16} />
              {borrando ? 'Eliminando…' : 'Eliminar registro'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
