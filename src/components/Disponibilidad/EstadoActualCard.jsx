import React from 'react';
import { CheckCircle2, Clock, XCircle, Wrench } from 'lucide-react';
import TiempoEnEstado from './TiempoEnEstado';
import FactorDisponibilidad from './FactorDisponibilidad';
import { ESTADO_COLORS, NEUTRAL } from './colores';

const ICONS = { CheckCircle2, Clock, XCircle, Wrench };

// F20: render Bogotá explícito — `fecha_inicio_estado` es un instante UTC en BD.
const FECHA_CORTA_FMT = new Intl.DateTimeFormat('es-CO', {
  timeZone: 'America/Bogota',
  day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
});

function formatFechaCorta(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return FECHA_CORTA_FMT.format(d);
}

// Tarjeta "Estado actual" (look dashboard.html). Las acciones (Cambiar/Editar/Deshacer) y el
// toggle de planta viven ahora en EstadoTopbar; esta tarjeta es solo presentación del vigente.
export default function EstadoActualCard({ vigente, plantaSeleccionada, metricas }) {
  const evento = vigente?.evento;
  const tokens = ESTADO_COLORS[evento] || {
    bg: NEUTRAL.fgTer, text: NEUTRAL.surface, badge: NEUTRAL.fgTer, icon: 'Clock',
  };
  const Icon = ICONS[tokens.icon] || Clock;

  const autorNombre = vigente?.creado_por?.nombre_completo || '—';
  const modificador = vigente?.modificado_por?.nombre_completo;
  const detalle = vigente?.detalle?.trim?.() || '';

  return (
    <div className="card">
      <div className="card-head"><h3>Estado actual</h3></div>

      <div className="cur-head">
        <span className="cur-badge" style={{ background: tokens.bg }}>
          <Icon /> {evento || 'Sin estado'}
        </span>
        <span className="cur-code">
          Código <b>{vigente?.codigo ?? '—'}</b> · Equipo <b>{plantaSeleccionada}</b>
        </span>
      </div>

      <div className="fields">
        <div className="field">
          <div className="flbl">Desde</div>
          <div className="fval mono">{formatFechaCorta(vigente?.fecha_inicio_estado)}</div>
        </div>

        <div className="field">
          <div className="flbl">Tiempo en estado</div>
          <div className="fval mono">
            <TiempoEnEstado fechaInicio={vigente?.fecha_inicio_estado} />
          </div>
        </div>

        <div className="field">
          <div className="flbl">Registrado por</div>
          <div className="fval">
            {autorNombre}
            {modificador && (
              <div className="fmeta">
                · editado por {modificador} el {formatFechaCorta(vigente?.modificado_en)}
              </div>
            )}
          </div>
        </div>

        <div className="field">
          <div className="flbl">Detalle</div>
          <div className={`fval${detalle ? '' : ' empty'}`}>{detalle || '—'}</div>
        </div>
      </div>

      <FactorDisponibilidad metricas={metricas} />
    </div>
  );
}
