import React, { useState, useEffect } from 'react';
import { ShieldCheck, Users, AlertTriangle, LogOut, Check } from 'lucide-react';

// D-065 · L08 — Popup de toma de control del rol (superficie B). Componente CONTROLADO: recibe el
// estado C5 y los verbos; no consulta nada por su cuenta y no toca el componente raíz (el disparo
// lo cablea L10 en la O4).
//
// Quién lo ve lo decide el BACKEND, no este archivo. `estado.aplica` ya excluye al observador
// (D-059), al Administrador y Debugging, al Gerente de Producción y a los roles sin patrón activo
// (decisión R12): replicar esa lógica acá es exactamente cómo el front se desincroniza del server.
// Este componente solo respeta el flag.
//
// Cero `localStorage`/`sessionStorage`: el "no volver a preguntar en este turno" es `ya_respondi`
// del backend (mismo criterio de D-040). El "No" es un `POST /descartar` real, nunca un `setState`
// local.
//
// Copy en tuteo colombiano (decisión R11). El usuario lo escribió en usted y eligió tuteo al
// confirmarlo: la aserción literal del test lo fija.

// Encabezado del aviso por `codigo` (nunca por el texto del error, D-032). El cuerpo del aviso
// siempre es el `mensaje` que ya viene saneado del backend.
const TITULOS_AVISO = {
  turno_cerrado: 'El turno se cerró',
  control_ocupado: 'Hay otra toma en curso',
  rotacion_no_aplica: 'La toma de control no aplica',
};

/**
 * Regla de visibilidad, pura y exportada para que el test la fije sin renderizar.
 *
 * - `aplica === false` → nada. El backend ya resolvió a quién le toca.
 * - `soy_titular === true` → nada: el titular es el fondo de la pila y no compite por su propio rol.
 * - `soy_principal === true` (y no titular) → **no pregunta**: ofrece devolver el control. Esta rama
 *   va ANTES de `ya_respondi` a propósito: tomar el control deja `ya_respondi = true`, así que sin
 *   este orden la otra mitad del ciclo (abandonar) sería inalcanzable desde la UI y la pila no se
 *   podría deshacer.
 * - `ya_respondi === true` → nada: ya respondió en este turno (tomó, abandonó o descartó).
 *
 * @returns {'preguntar' | 'abandonar' | null}
 */
export function modoPopup(estado) {
  if (!estado || estado.aplica !== true) return null;
  if (estado.soy_titular === true) return null;
  if (estado.soy_principal === true) return 'abandonar';
  if (estado.ya_respondi === true) return null;
  return 'preguntar';
}

// "el Operador de Planta - Sala de Mando principal es Jefferson Ceballos Sanchez" — con el cargo
// cuando el estado lo trae y sin él cuando no; nunca "el null principal". Un rol con patrón pero
// sin nadie en el grupo de guardia llega con `principal: null` (hecho §6.10 del GATE-O2) y ese
// también es un caso en el que la pregunta tiene sentido: no hay nadie a cargo.
function frasePrincipal(cargoNombre, principal) {
  if (!principal || !principal.nombre) {
    return cargoNombre
      ? `Durante este turno ningún ${cargoNombre} tiene el control del rol.`
      : 'Durante este turno nadie tiene el control del rol.';
  }
  const rol = cargoNombre ? `el ${cargoNombre} principal` : 'el principal';
  return `Durante este turno ${rol} es ${principal.nombre}.`;
}

export default function PopupTomaControl({ estado, onTomar, onAbandonar, onDescartar, onCerrar }) {
  // Verbo en vuelo ('tomar' | 'abandonar' | 'descartar' | null): deshabilita los botones mientras el
  // POST viaja y evita el doble envío que el `control_ocupado` del backend tendría que atajar.
  const [enVuelo, setEnVuelo] = useState(null);
  const [aviso, setAviso] = useState(null);
  // Se cierra tras una acción exitosa. NO es el "no volver a preguntar" (eso es `ya_respondi`, y
  // vive en el server): es no repreguntar dentro de este mismo montaje. Muere con un F5, que es
  // justamente lo que lo distingue del almacenamiento del navegador que D-040 prohíbe.
  const [cerrado, setCerrado] = useState(false);

  // Un turno nuevo vuelve a preguntar. El aviso NO se limpia acá a propósito: el 409 que lo produjo
  // suele ser justo el que cambia el `turno_id` (el turno se cerró bajo los pies), y limpiarlo lo
  // borraría de la pantalla antes de que nadie lo lea. Lo cierra la persona con "Entendido".
  const turnoId = estado?.turno_id ?? null;
  useEffect(() => { setCerrado(false); }, [turnoId]);

  const modo = modoPopup(estado);

  // El aviso sobrevive a un estado que ya no aplica: si el 409 vino de que el turno se cerró, el
  // refresco deja `aplica: false` y sin esto el mensaje desaparecería sin que nadie lo lea.
  if (!aviso && (!modo || cerrado)) return null;

  const ejecutar = (verbo, fn) => async () => {
    if (enVuelo) return;
    setEnVuelo(verbo);
    try {
      await fn?.();
      setCerrado(true);
      onCerrar?.();
    } catch (err) {
      // `body.mensaje` es el texto de usuario del backend; `body.error` es el slug. Ramificamos por
      // `codigo` para el encabezado y jamás parseamos el texto (D-032).
      setAviso({
        codigo: err?.codigo ?? null,
        mensaje: err?.body?.mensaje || err?.message || 'No se pudo completar la acción.',
      });
    } finally {
      setEnVuelo(null);
    }
  };

  // Descartar el aviso devuelve el control al estado real: si la pregunta sigue aplicando (un
  // `control_ocupado` no cambió nada en el server), vuelve a ofrecerse sin recargar la página.
  const cerrarAviso = () => { setAviso(null); onCerrar?.(); };

  // La pila viene de abajo (el titular) hacia arriba (el principal). "Antes lo tenía" son los que
  // quedaron debajo del tope, del más reciente al más antiguo.
  const pila = Array.isArray(estado?.pila) ? estado.pila : [];
  const anteriores = pila.length > 1 ? pila.slice(0, -1).reverse() : [];

  const btnBase = 'px-5 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60 transition-colors';
  const btnSecundario = `${btnBase} font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-100`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-labelledby="toma-control-titulo"
        className="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden animate-scale-in">
        <div className="px-6 pt-6 pb-4 flex items-start gap-4">
          <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${aviso ? 'bg-amber-100 text-amber-600' : 'bg-blue-100 text-blue-600'}`}>
            {aviso ? <AlertTriangle size={24} /> : <ShieldCheck size={24} />}
          </div>
          <div className="flex-1">
            <h3 id="toma-control-titulo" className="text-lg font-bold text-gray-900">
              {aviso ? (TITULOS_AVISO[aviso.codigo] || 'No se pudo completar la acción') : 'Toma de control del rol'}
            </h3>
            {aviso ? (
              <p className="text-sm text-gray-600 mt-1">{aviso.mensaje}</p>
            ) : (
              <p className="text-sm text-gray-600 mt-1">
                {modo === 'abandonar'
                  ? `Tienes el control del rol${estado?.cargo_nombre ? ` de ${estado.cargo_nombre}` : ''} en este turno.`
                  : frasePrincipal(estado?.cargo_nombre, estado?.principal)}
              </p>
            )}
          </div>
        </div>

        {/* La pila es la mitad del valor del log append-only: quién lo tenía antes y si era titular. */}
        {!aviso && anteriores.length > 0 && (
          <div className="px-6 pb-2">
            <div className="rounded-xl border border-gray-200 bg-gray-50 text-sm">
              <div className="flex items-center gap-2 px-4 pt-2.5 pb-1 text-gray-500">
                <Users size={15} className="text-gray-400 shrink-0" />
                <span>Antes lo tenía</span>
              </div>
              <ul className="px-4 pb-2.5 pt-0.5 space-y-1">
                {anteriores.map((p, i) => (
                  <li key={`${p.usuario_id}-${i}`} className="flex items-center gap-2 text-gray-800">
                    <span className="font-medium">{p.nombre || `Usuario ${p.usuario_id}`}</span>
                    {p.es_titular && (
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">· titular</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {!aviso && modo === 'preguntar' && (
          <p className="px-6 pt-2 text-sm font-medium text-gray-900">
            ¿Deseas tomar el control del rol en este turno?
          </p>
        )}

        <div className="px-6 py-4 mt-2 flex gap-3 justify-end border-t border-gray-100 bg-gray-50">
          {aviso ? (
            <button type="button" onClick={cerrarAviso}
              className={`${btnBase} text-white`} style={{ backgroundColor: '#1D4ED8' }}>
              Entendido
            </button>
          ) : modo === 'abandonar' ? (
            <>
              {/* "Cerrar" cierra DE VERDAD: pone `cerrado`, no solo avisa al padre. El aviso al
                  padre es una notificación, no el mecanismo — el dueño de "no repreguntar en este
                  montaje" es este componente, igual que en `ejecutar` y en `cerrarAviso`. Sin el
                  `setCerrado(true)` este era el ÚNICO camino de salida del overlay que no salía:
                  con `onCerrar` cableado a un no-op (lo correcto desde el raíz), el botón no hacía
                  nada y el `fixed inset-0 z-50` —sin clic en el fondo ni Escape— dejaba la app
                  tapada para quien acababa de tomar el control, porque `soy_principal` mantiene el
                  modo `abandonar` durante todo el turno y un F5 lo vuelve a abrir. */}
              <button type="button" onClick={() => { setCerrado(true); onCerrar?.(); }}
                disabled={!!enVuelo} className={btnSecundario}>
                Cerrar
              </button>
              <button type="button" onClick={ejecutar('abandonar', onAbandonar)} disabled={!!enVuelo}
                className={`${btnBase} flex items-center gap-2 text-white`} style={{ backgroundColor: '#B45309' }}>
                <LogOut size={16} />
                {enVuelo === 'abandonar' ? 'Procesando…' : 'Abandonar el control'}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={ejecutar('descartar', onDescartar)} disabled={!!enVuelo} className={btnSecundario}>
                {enVuelo === 'descartar' ? 'Procesando…' : 'No'}
              </button>
              <button type="button" onClick={ejecutar('tomar', onTomar)} disabled={!!enVuelo}
                className={`${btnBase} flex items-center gap-2 text-white`} style={{ backgroundColor: '#047857' }}>
                <Check size={16} />
                {enVuelo === 'tomar' ? 'Procesando…' : 'Sí, tomarlo'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
