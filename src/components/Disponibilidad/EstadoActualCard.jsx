import React from 'react';
import { CheckCircle2, Clock, XCircle, Edit3, RefreshCw, Undo2 } from 'lucide-react';
import TiempoEnEstado from './TiempoEnEstado';
import { ESTADO_COLORS, NEUTRAL } from './colores';

const ICONS = { CheckCircle2, Clock, XCircle };

function formatFechaCorta(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-CO', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function EstadoActualCard({
  vigente,
  puedeEditar,
  onCambiar,
  onEditar,
  onDeshacer,
}) {
  const evento = vigente?.evento;
  const tokens = ESTADO_COLORS[evento] || {
    bg: NEUTRAL.subtle, text: NEUTRAL.fgInk, badge: NEUTRAL.fgTer, icon: 'Clock',
  };
  const Icon = ICONS[tokens.icon] || Clock;

  const autorNombre = vigente?.creado_por?.nombre_completo || '—';
  const modificador = vigente?.modificado_por?.nombre_completo;
  const detalle = vigente?.detalle?.trim?.() || '';

  return (
    <div
      className="rounded-xl shadow-sm overflow-hidden border"
      style={{ borderColor: NEUTRAL.hairline, backgroundColor: NEUTRAL.surface }}
    >
      <div
        className="px-6 py-4 flex flex-col md:flex-row md:items-center gap-4"
        style={{ backgroundColor: tokens.bg, color: tokens.text }}
      >
        <div className="flex items-center gap-4 flex-1 min-w-0">
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: tokens.badge, color: '#fff' }}
          >
            <Icon size={26} />
          </div>
          <div className="min-w-0">
            <div className="text-xl font-semibold truncate">{evento || 'Sin estado'}</div>
            <div className="text-xs opacity-90">
              Código <span className="font-semibold">{vigente?.codigo ?? '—'}</span>
            </div>
          </div>
        </div>

        {puedeEditar && (
          <div className="flex flex-wrap gap-2 md:justify-end">
            <button
              onClick={onCambiar}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white text-gray-900 text-sm font-medium hover:bg-gray-50 transition-colors"
            >
              <RefreshCw size={16} /> Cambiar estado
            </button>
            <button
              onClick={onEditar}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/15 hover:bg-white/25 text-white text-sm font-medium border border-white/40 transition-colors"
            >
              <Edit3 size={16} /> Editar
            </button>
            <button
              onClick={onDeshacer}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/15 hover:bg-white/25 text-white text-sm font-medium border border-white/40 transition-colors"
            >
              <Undo2 size={16} /> Deshacer
            </button>
          </div>
        )}
      </div>

      <div className="px-6 py-4 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
        <Field label="Desde">
          <span style={{ color: NEUTRAL.fgInk }} className="font-medium">
            {formatFechaCorta(vigente?.fecha_inicio_estado)}
          </span>
        </Field>

        <Field label="En estado">
          <TiempoEnEstado
            fechaInicio={vigente?.fecha_inicio_estado}
            className="font-mono font-semibold tabular-nums"
            style={{ color: NEUTRAL.fgInk }}
          />
        </Field>

        <Field label="Registrado por">
          <span style={{ color: NEUTRAL.fgInk }}>{autorNombre}</span>
          {modificador && (
            <span className="ml-2 text-xs" style={{ color: NEUTRAL.fgTer }}>
              · editado por {modificador} el {formatFechaCorta(vigente?.modificado_en)}
            </span>
          )}
        </Field>

        <Field label="Detalle">
          {detalle ? (
            <span style={{ color: NEUTRAL.fgInk }}>{detalle}</span>
          ) : (
            <span style={{ color: NEUTRAL.fgTer }}>—</span>
          )}
        </Field>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div
        className="text-[11px] font-medium mb-1"
        style={{ color: NEUTRAL.fgTer }}
      >
        {label}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}
