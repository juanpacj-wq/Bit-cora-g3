import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { asset } from "../config/paths";

// Modal de cierre de sesión rediseñado (reemplaza al ConfirmModal genérico SOLO para el logout).
// Más ancho/alto que el genérico, con ilustración hero y los botones en una sola fila. Dos
// acciones:
//   · "Cancelar" / X / clic en backdrop / Esc  → onCancel
//   · "Sí, finalizar y salir" (botón primario)  → onConfirm (finaliza turno + logout backend)
// "Cambiar de unidad" ya NO vive acá: se movió al menú (hamburguesa) del header; por eso el texto
// solo la menciona como sugerencia, sin enlace interactivo.
// onConfirm puede ser async (finalizarTurno + auth.logout); mostramos estado "Saliendo…".

export default function LogoutModal({ open, userName, onCancel, onConfirm }) {
  const [busy, setBusy] = useState(false);

  // Esc cierra (paridad con clic en backdrop / botón Cancelar). Solo mientras está abierto.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const handleConfirm = async () => {
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={() => { if (!busy) onCancel(); }}
      role="dialog" aria-modal="true" aria-labelledby="logout-title"
    >
      {/* Tarjetas apiladas decorativas (efecto de profundidad como en la referencia) */}
      <div className="relative w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="absolute inset-0 rounded-3xl border border-gray-200 bg-white/40 rotate-[3deg] translate-x-2 translate-y-2" aria-hidden="true" />
        <div className="absolute inset-0 rounded-3xl border border-gray-200 bg-white/60 -rotate-[2deg] -translate-x-1 translate-y-1" aria-hidden="true" />

        {/* Tarjeta principal */}
        <div className="relative bg-white rounded-3xl shadow-2xl ring-1 ring-black/5 overflow-hidden animate-scale-in">
          <button
            onClick={() => { if (!busy) onCancel(); }}
            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full p-1.5 transition-colors"
            aria-label="Cancelar"
            disabled={busy}
          >
            <X size={20} />
          </button>

          <div className="px-8 pt-9 pb-8 flex flex-col items-center text-center">
            <img
              src={asset("/logout-ilustracion.png")}
              alt="Una persona abre la puerta mientras su gato sale"
              className="w-48 h-48 object-contain mb-1 select-none pointer-events-none"
              draggable="false"
            />

            <h3 id="logout-title" className="text-2xl font-bold text-gray-900">
              ¿Cierras tu sesión?
            </h3>

            <p className="text-sm text-gray-500 mt-2 max-w-sm leading-relaxed">
              {userName ? <>Hasta pronto, <span className="font-semibold text-gray-700">{userName}</span>. </> : null}
              Puedes volver a iniciar sesión cuando quieras.
            </p>

            <div className="mt-7 flex flex-nowrap items-center justify-center gap-3 w-full">
              <button
                onClick={() => { if (!busy) onCancel(); }}
                disabled={busy}
                className="px-6 py-2.5 rounded-full text-sm font-semibold text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 transition-colors whitespace-nowrap disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleConfirm}
                disabled={busy}
                className="px-6 py-2.5 rounded-full text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 transition-colors whitespace-nowrap shadow-sm disabled:opacity-70 flex items-center gap-2"
              >
                {busy && (
                  <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" aria-hidden="true" />
                )}
                {busy ? "Saliendo…" : "Sí, finalizar y salir"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
