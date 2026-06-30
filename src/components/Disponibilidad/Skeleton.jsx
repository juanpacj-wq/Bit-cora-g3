import React from 'react';

// F13.1: skeleton mostrado solo en la PRIMERA carga de cada planta. Las re-visitas
// muestran el cache (SWR) y refrescan en background sin parpadear.
// Refleja el layout del rediseño (look dashboard.html): 4 stat cards + state-grid
// (donut + estado actual) + tabla de historial. Se renderiza dentro de .disp-root,
// debajo del topbar (que sí se muestra durante la carga).
const box = (w, h, r = 6) => ({
  width: w, height: h, borderRadius: r, background: '#e6eef0',
});

export default function DashboardSkeleton({ filas = 6 }) {
  return (
    <div className="animate-pulse">
      {/* stat cards */}
      <div className="stats">
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="stat" key={i}>
            <div style={box(46, 46, 50)} />
            <div style={{ flex: 1 }}>
              <div style={{ ...box(90, 16), marginBottom: 8 }} />
              <div style={box(60, 10)} />
            </div>
          </div>
        ))}
      </div>

      {/* state grid: donut + estado actual */}
      <div className="state-grid">
        <div className="card">
          <div style={{ ...box(120, 14), marginBottom: 16 }} />
          <div style={{ ...box('100%', 170, 999), margin: '0 auto', maxWidth: 170 }} />
          <div style={{ ...box('100%', 80), marginTop: 16 }} />
        </div>
        <div className="card">
          <div style={{ ...box(110, 14), marginBottom: 16 }} />
          <div style={{ ...box(140, 34, 9), marginBottom: 18 }} />
          <div className="fields">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i}>
                <div style={{ ...box(70, 10), marginBottom: 8 }} />
                <div style={box(130, 14)} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* historial */}
      <div className="card">
        <div className="card-head">
          <div style={box(140, 16)} />
          <div style={box(90, 12)} />
        </div>
        <div style={{ marginTop: 8 }}>
          {Array.from({ length: filas }).map((_, i) => (
            <div key={i} style={{ display: 'flex', gap: 16, alignItems: 'center', padding: '12px 0' }}>
              <div style={box(180, 12)} />
              <div style={box(90, 22, 999)} />
              <div style={box(140, 12)} />
              <div style={{ ...box(0, 12), flex: 1 }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
