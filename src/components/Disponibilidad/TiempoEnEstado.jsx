import React, { useEffect, useState } from 'react';

// Formato adaptativo según rango (ver F13.B3 en plan_disp.md):
// >= 7 días → "Xs Yd Zh Wm" (sin segundos — granularidad innecesaria a esa escala).
// >= 1 día → "Yd Zh Wm Vs".
// >= 1 hora → "Zh Wm Vs".
// < 1 hora → "Wm Vs".
function formatDiff(ms) {
  if (ms < 0) ms = 0;
  const totalSeg = Math.floor(ms / 1000);
  const seg = totalSeg % 60;
  const totalMin = Math.floor(totalSeg / 60);
  const min = totalMin % 60;
  const totalHor = Math.floor(totalMin / 60);
  const hor = totalHor % 24;
  const totalDia = Math.floor(totalHor / 24);
  const dia = totalDia % 7;
  const sem = Math.floor(totalDia / 7);

  if (totalDia >= 7) return `${sem}s ${dia}d ${hor}h ${min}m`;
  if (totalDia >= 1) return `${totalDia}d ${hor}h ${min}m ${seg}s`;
  if (totalHor >= 1) return `${totalHor}h ${min}m ${seg}s`;
  return `${totalMin}m ${seg}s`;
}

export function useTiempoTranscurrido(fechaInicio) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!fechaInicio) return null;
  const inicio = new Date(fechaInicio).getTime();
  if (Number.isNaN(inicio)) return null;
  return now - inicio;
}

export default function TiempoEnEstado({ fechaInicio, className, style }) {
  const diff = useTiempoTranscurrido(fechaInicio);
  if (diff == null) return <span className={className} style={style}>—</span>;
  return (
    <span className={className} style={style}>
      {formatDiff(diff)}
    </span>
  );
}
