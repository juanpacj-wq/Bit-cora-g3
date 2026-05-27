import React, { useEffect, useState } from 'react';

// D-024 (2026-05-15): nuevo formato. Unidades: años, meses, d, hr, min, s.
//   - Plural correcto en español para "año/años" y "mes/meses"; las abreviaturas d/hr/min/s
//     son invariantes.
//   - Omite unidades con valor 0 EXCEPTO segundos (siempre presentes).
//   - Sin semanas (decisión explícita — el operador piensa en d/hr/min/s).
//   - Aproximaciones: 1 año = 365.25 d, 1 mes = 30.44 d. Calendario exacto introduce
//     edge cases sin valor operativo para "duración desde X".
const MS_PER_S   = 1000;
const MS_PER_MIN = 60 * MS_PER_S;
const MS_PER_HR  = 60 * MS_PER_MIN;
const MS_PER_D   = 24 * MS_PER_HR;
const MS_PER_MES = 30.44 * MS_PER_D;
const MS_PER_ANO = 365.25 * MS_PER_D;

export function formatDiff(ms) {
  if (ms < 0) ms = 0;
  let rest = ms;
  const anos  = Math.floor(rest / MS_PER_ANO);  rest -= anos  * MS_PER_ANO;
  const meses = Math.floor(rest / MS_PER_MES);  rest -= meses * MS_PER_MES;
  const dias  = Math.floor(rest / MS_PER_D);    rest -= dias  * MS_PER_D;
  const horas = Math.floor(rest / MS_PER_HR);   rest -= horas * MS_PER_HR;
  const mins  = Math.floor(rest / MS_PER_MIN);  rest -= mins  * MS_PER_MIN;
  const segs  = Math.floor(rest / MS_PER_S);

  const parts = [];
  if (anos  > 0) parts.push(`${anos} ${anos === 1 ? 'año' : 'años'}`);
  if (meses > 0) parts.push(`${meses} ${meses === 1 ? 'mes' : 'meses'}`);
  if (dias  > 0) parts.push(`${dias} d`);
  if (horas > 0) parts.push(`${horas} hr`);
  if (mins  > 0) parts.push(`${mins} min`);
  parts.push(`${segs} s`); // siempre
  return parts.join(' ');
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
