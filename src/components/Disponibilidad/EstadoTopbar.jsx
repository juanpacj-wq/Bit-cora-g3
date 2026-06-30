import React from 'react';
import { RefreshCw, Edit3, Undo2 } from 'lucide-react';
import { PLANTAS } from './colores';

// Barra superior del rediseño (look dashboard.html): título + subtítulo a la izquierda;
// toggle de planta (.seg) + acciones (.btn) a la derecha. Reemplaza los botones que antes
// vivían dentro de EstadoActualCard. Las acciones se gatean con `puedeEditar`.
export default function EstadoTopbar({
  plantaSeleccionada,
  codigo,
  puedeEditar,
  tieneVigente = true,
  onChangePlanta,
  onCambiar,
  onEditar,
  onDeshacer,
}) {
  return (
    <div className="topbar">
      <div>
        <h1>Seguimiento de Estados</h1>
        <div className="sub">
          Equipo {plantaSeleccionada} · Código {codigo ?? '—'}
        </div>
      </div>
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Seleccionar planta">
          {PLANTAS.map((p) => (
            <button
              key={p}
              type="button"
              className={`seg-item${p === plantaSeleccionada ? ' active' : ''}`}
              onClick={() => onChangePlanta(p)}
            >
              {p}
            </button>
          ))}
        </div>
        {puedeEditar && (
          <>
            <button type="button" className="btn btn-white" onClick={onCambiar}>
              <RefreshCw /> Cambiar estado
            </button>
            {tieneVigente && (
              <>
                <button type="button" className="btn btn-green" onClick={onEditar}>
                  <Edit3 /> Editar
                </button>
                <button type="button" className="btn btn-ghost" onClick={onDeshacer}>
                  <Undo2 /> Deshacer
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
