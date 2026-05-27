import React from 'react';
import { CheckCircle2, Clock, XCircle, Wrench } from 'lucide-react';
import { formatDiff, useTiempoTranscurrido } from './TiempoEnEstado';
import { ESTADOS, ESTADO_COLORS, NEUTRAL } from './colores';

const ICONS = { CheckCircle2, Clock, XCircle, Wrench };

// Panel "Acumulado histórico por estado". Fuente: GET /api/disponibilidad/metricas
// (`tiempo_ms` por estado sobre toda la historia + `ahora` = reloj UTC del server).
//
// Regla de visualización:
//   - Estados NO vigentes: total congelado (`tiempo_ms[estado]`).
//   - Estado vigente: crece en vivo en lockstep con "Tiempo en estado". Se calcula la base
//     cerrada `tiempo_ms[actual] − (ahora − inicio)` (= suma de sus intervalos ya cerrados)
//     y se le suma el intervalo vigente vivo (mismo tick `Date.now()-inicio` que usa el
//     contador de la tarjeta). Así no hay salto en el borde ni doble conteo, y ambos
//     contadores comparten el mismo reloj/skew.
export default function AcumuladosPorEstado({ metricas, vigente }) {
  const estadoActual = vigente?.evento || null;
  const inicioMs = vigente?.fecha_inicio_estado ? Date.parse(vigente.fecha_inicio_estado) : NaN;
  const ahoraMs = metricas?.ahora ? Date.parse(metricas.ahora) : NaN;
  // Único setInterval de 1s (compartido por las 4 tarjetas). Devuelve null si no hay vigente.
  const vigenteLive = useTiempoTranscurrido(vigente?.fecha_inicio_estado);

  if (!metricas?.tiempo_ms) return null;

  return (
    <div
      className="rounded-xl shadow-sm border p-4"
      style={{ borderColor: NEUTRAL.hairline, backgroundColor: NEUTRAL.surface }}
    >
      <div className="text-[11px] font-medium mb-3" style={{ color: NEUTRAL.fgTer }}>
        Acumulado histórico por estado
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {ESTADOS.map((estado) => {
          const tokens = ESTADO_COLORS[estado];
          const Icon = ICONS[tokens.icon] || Clock;
          const totalMs = Number(metricas.tiempo_ms[estado]) || 0;
          const esActual = estado === estadoActual;

          let displayMs = totalMs;
          if (esActual && Number.isFinite(inicioMs) && Number.isFinite(ahoraMs)) {
            const baseCerrada = Math.max(0, totalMs - (ahoraMs - inicioMs));
            const intervaloVivo = vigenteLive != null ? vigenteLive : ahoraMs - inicioMs;
            displayMs = baseCerrada + intervaloVivo;
          }

          return (
            <div
              key={estado}
              className="rounded-lg px-3 py-2.5 flex flex-col gap-1.5"
              style={{
                borderStyle: 'solid',
                borderColor: esActual ? tokens.badge : NEUTRAL.hairline,
                borderWidth: esActual ? 2 : 1,
                backgroundColor: esActual ? `${tokens.badge}0D` : NEUTRAL.surface,
              }}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0"
                  style={{ backgroundColor: tokens.badge, color: '#fff' }}
                >
                  <Icon size={12} />
                </span>
                <span className="text-xs font-medium truncate" style={{ color: NEUTRAL.fgInk }}>
                  {estado}
                </span>
                {esActual && (
                  <span
                    className="ml-auto text-[10px] font-semibold whitespace-nowrap"
                    style={{ color: tokens.badge }}
                  >
                    ● en curso
                  </span>
                )}
              </div>
              <div
                className="font-mono font-semibold tabular-nums text-sm leading-tight"
                style={{ color: NEUTRAL.fgInk }}
                title={`${(displayMs / 3600000).toFixed(1)} h`}
              >
                {formatDiff(displayMs)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
