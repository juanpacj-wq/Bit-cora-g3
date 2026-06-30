import React from 'react';
import { formatDiff } from './TiempoEnEstado';
import { ESTADOS, ESTADO_COLORS } from './colores';

// "Factor de disponibilidad" — KPI headline de una planta térmica que hasta ahora NO se
// mostraba en la UI (el backend ya lo devolvía en metricas.acumulados_ms). Llena el espacio
// plano de la tarjeta "Estado actual" sin duplicar el donut: el donut muestra la composición
// de los 4 estados; esto muestra la frontera operativa Disponible | No disponible.
//
//   Disponible    = En Servicio + En Reserva   (verde + azul)
//   No disponible = Indisponible + Mantenimiento (rojo + amarillo)
//
// La barra es una sola pieza de 4 segmentos proporcionales agrupados en dos zonas (un gap
// separa disponible de no disponible), así se lee a la vez el split del KPI y su composición.
const PCT_FMT = new Intl.NumberFormat('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const MS_PER_HR = 3_600_000;
const MS_PER_D = 24 * MS_PER_HR;

// Compacto para la leyenda (paridad con la leyenda del donut: "2348 d"). El detalle fino
// (años/meses/min/s) queda en el tooltip vía formatDiff.
function formatCompact(ms) {
  if (!ms || ms < 0) return '0 d';
  if (ms >= MS_PER_D) return `${Math.round(ms / MS_PER_D)} d`;
  if (ms >= MS_PER_HR) return `${Math.round(ms / MS_PER_HR)} hr`;
  return `${Math.round(ms / 60000)} min`;
}

const GRUPOS = [
  { key: 'disponible', label: 'Disponible', estados: ['En Servicio', 'En Reserva'] },
  { key: 'no_disponible', label: 'No disponible', estados: ['Indisponible', 'Mantenimiento'] },
];

export default function FactorDisponibilidad({ metricas }) {
  const tiempo = metricas?.tiempo_ms;
  if (!tiempo) return null;

  const total = ESTADOS.reduce((a, e) => a + (Number(tiempo[e]) || 0), 0);
  if (total <= 0) return null;

  const dispMs = (Number(tiempo['En Servicio']) || 0) + (Number(tiempo['En Reserva']) || 0);
  const noDispMs = (Number(tiempo.Indisponible) || 0) + (Number(tiempo.Mantenimiento) || 0);
  const factor = (dispMs / total) * 100;

  const segByGrupo = (estados) =>
    estados
      .map((e) => ({ estado: e, ms: Number(tiempo[e]) || 0 }))
      .filter((s) => s.ms > 0);

  return (
    <div className="avail">
      <div className="avail-head">
        <span className="avail-title">Factor de disponibilidad</span>
        <span className="avail-kpi">{PCT_FMT.format(factor)}%</span>
      </div>

      <div className="avail-bar">
        {GRUPOS.map((g, gi) => {
          const segs = segByGrupo(g.estados);
          const grupoMs = segs.reduce((a, s) => a + s.ms, 0);
          if (grupoMs <= 0) return null;
          return (
            <div
              key={g.key}
              className="avail-zone"
              style={{ width: `${(grupoMs / total) * 100}%`, marginLeft: gi === 0 ? 0 : 3 }}
            >
              {segs.map((s) => (
                <span
                  key={s.estado}
                  className="avail-seg"
                  style={{ width: `${(s.ms / grupoMs) * 100}%`, background: ESTADO_COLORS[s.estado].bg }}
                  title={`${s.estado}: ${formatDiff(s.ms)}`}
                />
              ))}
            </div>
          );
        })}
      </div>

      <div className="avail-legend">
        {GRUPOS.map((g) => {
          const ms = g.key === 'disponible' ? dispMs : noDispMs;
          const pct = Math.round((ms / total) * 100);
          const dotBg = g.key === 'disponible'
            ? ESTADO_COLORS['En Servicio'].bg
            : ESTADO_COLORS.Indisponible.bg;
          return (
            <div className="avail-row" key={g.key}>
              <span className="avail-name">
                <span className="avail-dot" style={{ background: dotBg }} />
                {g.label}
              </span>
              <span className="avail-val" title={formatDiff(ms)}>{formatCompact(ms)} · {pct}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
