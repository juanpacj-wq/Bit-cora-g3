import React from 'react';
import { CheckCircle2, Clock, XCircle, Wrench } from 'lucide-react';
import { formatDiff, useTiempoTranscurrido } from './TiempoEnEstado';
import { ESTADOS, ESTADO_COLORS } from './colores';

const ICONS = { CheckCircle2, Clock, XCircle, Wrench };

// "Acumulado histórico por estado" como 4 stat cards (look dashboard.html). Fuente:
// GET /api/disponibilidad/metricas (`tiempo_ms` por estado + `ahora` = reloj UTC del server).
//
// Regla de visualización (sin cambios respecto al diseño previo):
//   - Estados NO vigentes: total congelado (`tiempo_ms[estado]`).
//   - Estado vigente: crece en vivo en lockstep con "Tiempo en estado". Base cerrada
//     `tiempo_ms[actual] − (ahora − inicio)` + intervalo vigente vivo (tick Date.now()-inicio).
//     Así no hay salto en el borde ni doble conteo, y comparten reloj con el contador de la tarjeta.
export default function AcumuladosPorEstado({ metricas, vigente }) {
  const estadoActual = vigente?.evento || null;
  const inicioMs = vigente?.fecha_inicio_estado ? Date.parse(vigente.fecha_inicio_estado) : NaN;
  const ahoraMs = metricas?.ahora ? Date.parse(metricas.ahora) : NaN;
  // Único setInterval de 1s (compartido por las 4 tarjetas). Devuelve null si no hay vigente.
  const vigenteLive = useTiempoTranscurrido(vigente?.fecha_inicio_estado);

  if (!metricas?.tiempo_ms) return null;

  return (
    <div className="stats">
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
          <div className="stat" key={estado}>
            <div className="stat-ico" style={{ background: tokens.bg }}>
              <Icon color="#fff" />
            </div>
            <div>
              <div className="stat-val" title={`${(displayMs / 3600000).toFixed(1)} h`}>
                {formatDiff(displayMs)}
              </div>
              <div className="stat-lbl">
                {estado}
                {esActual && (
                  <span className="live"><span className="pulse" />en curso</span>
                )}
              </div>
            </div>
            <div className="accent" style={{ background: tokens.bg }} />
          </div>
        );
      })}
    </div>
  );
}
