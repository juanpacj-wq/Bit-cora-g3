// @vitest-environment jsdom
//
// Regresión del parpadeo del botón "Guardar" en el navegador de día de BarraEstado.
//
// Bug (antes): `pendingFecha` (la fecha tecleada aún sin commitear) se resincronizaba con la prop
// `filtroFecha` en un `useEffect`. Los efectos corren DESPUÉS del commit/paint, así que al navegar
// con las flechas/"Hoy" —que cambian `filtroFecha` de inmediato— quedaba un frame committeado con
// `pendingFecha` viejo ≠ `filtroFecha` nuevo, y ese es justo el predicado que muestra el botón
// "Guardar" (`pendingFecha && pendingFecha !== filtroFecha`) → parpadeo verde de una fracción de segundo.
//
// Fix: resincronizar `pendingFecha` DURANTE el render (patrón "adjusting state on prop change"): React
// reinicia el render antes de committear, así el DOM nunca llega a tener el botón intermedio.
//
// Detector: un ref callback en el botón "Guardar" cuenta cada vez que llega a MONTARSE en el DOM.
// - patrón 'effect' (bug) → el botón se monta y desmonta durante la navegación (cuenta ≥ 1).
// - patrón 'render' (fix) → el botón nunca se monta (cuenta 0).
// Reproducimos aquí ambos patrones con la misma lógica de BarraEstado para probar que el detector es
// válido (captura el bug) y que el fix lo elimina.
import { describe, it, expect } from 'vitest';
import { createElement as h, useState, useEffect, act } from 'react';
import { createRoot } from 'react-dom/client';
import { shiftDate } from '../utils/fecha.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const FECHA_INICIAL = '2026-03-24';

// Réplica de la lógica del selector de día de BarraEstado, parametrizada por estrategia de sync.
function Selector({ pattern, filtroFecha, onCommit, onGuardarMount }) {
  const [pendingFecha, setPendingFecha] = useState(filtroFecha);
  const [prevFiltroFecha, setPrevFiltroFecha] = useState(filtroFecha);

  // FIX: ajuste en render.
  if (pattern === 'render' && filtroFecha !== prevFiltroFecha) {
    setPrevFiltroFecha(filtroFecha);
    setPendingFecha(filtroFecha);
  }
  // BUG: sync tardío en efecto post-paint.
  useEffect(() => {
    if (pattern === 'effect') setPendingFecha(filtroFecha);
  }, [filtroFecha, pattern]);

  const showGuardar = pendingFecha && pendingFecha !== filtroFecha;
  return h(
    'div',
    null,
    // Flecha "día anterior": commit inmediato (igual que onCommitFecha en el componente real).
    h('button', { className: 'prev', onClick: () => onCommit(shiftDate(filtroFecha, -1)) }, '<'),
    showGuardar
      ? h('button', { className: 'guardar', ref: (n) => { if (n) onGuardarMount(); }, onClick: () => onCommit(pendingFecha) }, 'Guardar')
      : null,
  );
}

// Padre: mantiene filtroFecha y lo cambia de inmediato al commitear (como el dashboard real).
function Harness({ pattern, onGuardarMount }) {
  const [filtroFecha, setFiltroFecha] = useState(FECHA_INICIAL);
  return h(Selector, { pattern, filtroFecha, onCommit: setFiltroFecha, onGuardarMount });
}

// Monta el harness, hace clic en la flecha "día anterior" y cuenta cuántas veces el botón
// "Guardar" llegó a montarse (en reposo inicial y durante la navegación).
function correrNavegacion(pattern) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let montajes = 0;
  const root = createRoot(container);

  act(() => {
    root.render(h(Harness, { pattern, onGuardarMount: () => { montajes += 1; } }));
  });
  const montajesEnReposo = montajes;

  const flecha = container.querySelector('button.prev');
  act(() => {
    flecha.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  const montajesTrasNavegar = montajes - montajesEnReposo;

  // Estado final estable: no debe quedar el botón "Guardar" (equivale a la imagen 2 del reporte).
  const guardarFinal = container.querySelector('button.guardar');

  act(() => { root.unmount(); });
  container.remove();

  return { montajesEnReposo, montajesTrasNavegar, guardarFinalPresente: !!guardarFinal };
}

describe('BarraEstado · navegador de día · botón "Guardar" no parpadea', () => {
  it('el detector es válido: el patrón buggy (useEffect) SÍ monta el botón al navegar', () => {
    const r = correrNavegacion('effect');
    expect(r.montajesEnReposo).toBe(0);        // en reposo no hay botón
    expect(r.montajesTrasNavegar).toBeGreaterThanOrEqual(1); // parpadeo: el botón llegó al DOM
    expect(r.guardarFinalPresente).toBe(false); // pero el estado final es correcto
  });

  it('el fix (ajuste en render) NO monta el botón en ningún frame al navegar', () => {
    const r = correrNavegacion('render');
    expect(r.montajesEnReposo).toBe(0);        // en reposo no hay botón
    expect(r.montajesTrasNavegar).toBe(0);     // sin parpadeo: nunca se montó
    expect(r.guardarFinalPresente).toBe(false); // estado final correcto (imagen 2)
  });
});
