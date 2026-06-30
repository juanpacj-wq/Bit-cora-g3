import React, { useEffect, useRef } from 'react';
import { Chart, DoughnutController, ArcElement, Tooltip } from 'chart.js';
import { ESTADOS, ESTADO_COLORS } from './colores';

Chart.register(DoughnutController, ArcElement, Tooltip);

const MS_PER_HR = 3_600_000;
const MS_PER_D = 24 * MS_PER_HR;

// Formato compacto para centro/leyenda/tooltip del donut (igual estética que el mockup:
// "58 d", "22 d"). Bajo 1 día cae a horas o minutos para no mostrar "0 d".
function formatCompact(ms) {
  if (!ms || ms < 0) return '0 d';
  if (ms >= MS_PER_D) return `${Math.round(ms / MS_PER_D)} d`;
  if (ms >= MS_PER_HR) return `${Math.round(ms / MS_PER_HR)} hr`;
  return `${Math.round(ms / 60000)} min`;
}

// Donut "Tiempo en estados". Fuente: metricas.tiempo_ms[estado] (ms acumulados por estado,
// ya incluyen el intervalo vigente hasta metricas.ahora). El badge % muestra la participación
// del estado vigente sobre el total. Se actualiza con cada refresh de metricas (poll 30s /
// acciones), no por segundo — los stat cards de arriba ya dan el "tick" en vivo.
export default function TiempoEnEstadosDonut({ metricas, vigente }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  const tiempo = metricas?.tiempo_ms || null;
  const valores = ESTADOS.map((e) => Number(tiempo?.[e]) || 0);
  const total = valores.reduce((a, b) => a + b, 0);
  const vigenteEvento = vigente?.evento || null;
  const vigenteMs = vigenteEvento ? (Number(tiempo?.[vigenteEvento]) || 0) : 0;
  const pct = total > 0 ? Math.round((vigenteMs / total) * 100) : 0;

  // Crear el chart una sola vez; las actualizaciones de data se hacen sobre la instancia.
  useEffect(() => {
    if (!canvasRef.current) return;
    const chart = new Chart(canvasRef.current, {
      type: 'doughnut',
      data: {
        labels: ESTADOS,
        datasets: [{
          data: ESTADOS.map(() => 0),
          backgroundColor: ESTADOS.map((e) => ESTADO_COLORS[e].bg),
          borderWidth: 0,
          borderRadius: 6,
          spacing: 2,
        }],
      },
      options: {
        cutout: '72%',
        rotation: -90,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (c) => {
                const data = c.dataset.data || [];
                const sum = data.reduce((a, b) => a + (Number(b) || 0), 0);
                const p = sum > 0 ? Math.round((c.raw / sum) * 100) : 0;
                return ` ${c.label}: ${formatCompact(c.raw)} (${p}%)`;
              },
            },
          },
        },
        responsive: true,
        maintainAspectRatio: false,
      },
    });
    chartRef.current = chart;
    return () => { chart.destroy(); chartRef.current = null; };
  }, []);

  // Push de nuevos valores cuando cambian las métricas.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.data.datasets[0].data = valores;
    chart.update();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valores.join(',')]);

  if (!tiempo) return null;

  return (
    <div className="card" style={{ position: 'relative' }}>
      <div className="card-head"><h3>Tiempo en estados</h3></div>
      <div className="badge-pct">{pct}%</div>
      <div className="donut-wrap">
        <canvas ref={canvasRef} />
        <div className="donut-center">
          <div className="num">{formatCompact(total)}</div>
          <div className="sub">Tiempo total</div>
        </div>
      </div>
      <div className="legend4">
        {ESTADOS.map((estado) => {
          const v = Number(tiempo[estado]) || 0;
          const p = total > 0 ? Math.round((v / total) * 100) : 0;
          return (
            <div className="row" key={estado}>
              <div className="lname">
                <span className="dot" style={{ background: ESTADO_COLORS[estado].bg }} />
                {estado}
              </div>
              <div className="lval">{formatCompact(v)} · {p}%</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
