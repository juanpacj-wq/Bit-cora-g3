import React from 'react';
import { CheckCircle2, Clock, XCircle, Edit3, RefreshCw, Undo2, User } from 'lucide-react';
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
      className="rounded-2xl shadow-sm overflow-hidden border"
      style={{ borderColor: NEUTRAL.hairline, backgroundColor: NEUTRAL.surface }}
    >
      <div
        className="px-6 py-5 flex flex-col md:flex-row md:items-center gap-4 transition-colors duration-300"
        style={{ backgroundColor: tokens.bg, color: tokens.text }}
      >
        <div className="flex items-center gap-4 flex-1 min-w-0">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: tokens.badge, color: '#fff' }}
          >
            <Icon size={30} />
          </div>
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wider opacity-80">Estado actual</div>
            <div className="text-2xl font-bold truncate">{evento || 'Sin estado'}</div>
            <div className="text-sm opacity-90">
              Código: <span className="font-semibold">{vigente?.codigo ?? '—'}</span>
            </div>
          </div>
        </div>

        {puedeEditar && (
          <div className="flex flex-wrap gap-2 md:justify-end">
            <button
              onClick={onCambiar}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/95 text-gray-900 text-sm font-semibold shadow hover:bg-white transition-colors"
              title="Registrar nuevo cambio de estado"
            >
              <RefreshCw size={16} /> Cambiar estado
            </button>
            <button
              onClick={onEditar}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/15 hover:bg-white/25 text-white text-sm font-semibold border border-white/40 transition-colors"
              title="Editar estado vigente"
            >
              <Edit3 size={16} /> Editar
            </button>
            <button
              onClick={onDeshacer}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/15 hover:bg-white/25 text-white text-sm font-semibold border border-white/40 transition-colors"
              title="Deshacer último registro"
            >
              <Undo2 size={16} /> Deshacer
            </button>
          </div>
        )}
      </div>

      <div className="px-6 py-5 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
        <Field label="Desde">
          <span style={{ color: NEUTRAL.fgInk }} className="font-medium">
            {formatFechaCorta(vigente?.fecha_inicio_estado)}
          </span>
        </Field>

        <Field label="Tiempo en este estado">
          <TiempoEnEstado
            fechaInicio={vigente?.fecha_inicio_estado}
            className="font-mono font-semibold tabular-nums"
            style={{ color: NEUTRAL.fgInk }}
          />
        </Field>

        <Field label="Registrado por" icon={<User size={14} />}>
          <span style={{ color: NEUTRAL.fgInk }}>{autorNombre}</span>
          {modificador && (
            <span className="ml-2 text-xs italic" style={{ color: NEUTRAL.fgTer }}>
              · editado por {modificador} el {formatFechaCorta(vigente?.modificado_en)}
            </span>
          )}
        </Field>

        <Field label="Detalle">
          {detalle ? (
            <span style={{ color: NEUTRAL.fgInk }}>{detalle}</span>
          ) : (
            <span className="italic" style={{ color: NEUTRAL.fgTer }}>—</span>
          )}
        </Field>
      </div>
    </div>
  );
}

function Field({ label, icon, children }) {
  return (
    <div>
      <div
        className="text-xs uppercase tracking-wider mb-1 flex items-center gap-1"
        style={{ color: NEUTRAL.fgTer }}
      >
        {icon}
        {label}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}
