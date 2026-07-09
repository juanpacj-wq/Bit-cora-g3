// @vitest-environment jsdom
//
// D-050 — celda "Detalle" de históricos: el contenido completo se ve por expansión inline
// ("Ver más"/"Ver menos"), no por hover. Umbral fijo: >160 caracteres muestra el control;
// por debajo, el texto sale completo sin control.
import { describe, it, expect } from 'vitest';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { DetalleCell } from './HistoricoTable.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TEXTO_CORTO = 'Disparo de unidad por alta temperatura.';
const TEXTO_LARGO = 'Se presenta disparo de la unidad por alta temperatura en cojinete #3. '.repeat(4); // 280 chars

function renderCell(texto) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(h(DetalleCell, { texto })); });
  const click = (el) => act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  const teardown = () => {
    act(() => { root.unmount(); });
    container.remove();
  };
  return { container, click, teardown };
}

describe('DetalleCell (D-050)', () => {
  it('sin texto: muestra — y ningún botón', () => {
    const { container, teardown } = renderCell(null);
    expect(container.textContent).toContain('—');
    expect(container.querySelector('button')).toBeNull();
    teardown();
  });

  it('texto ≤160: se muestra completo, sin control', () => {
    const { container, teardown } = renderCell(TEXTO_CORTO);
    expect(container.textContent).toContain(TEXTO_CORTO);
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('.line-clamp-2')).toBeNull();
    teardown();
  });

  it('texto >160: colapsado con "Ver más"; expande al contenido completo y colapsa de vuelta', () => {
    const { container, click, teardown } = renderCell(TEXTO_LARGO);
    // Colapsado: line-clamp + botón "Ver más".
    expect(container.querySelector('.line-clamp-2')).toBeTruthy();
    const btn = container.querySelector('button');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain('Ver más');
    expect(btn.getAttribute('aria-expanded')).toBe('false');

    // Expandir: texto completo sin clamp, botón pasa a "Ver menos".
    click(btn);
    expect(container.querySelector('.line-clamp-2')).toBeNull();
    expect(container.textContent).toContain(TEXTO_LARGO.trim());
    const btnExp = container.querySelector('button');
    expect(btnExp.textContent).toContain('Ver menos');
    expect(btnExp.getAttribute('aria-expanded')).toBe('true');

    // Colapsar de vuelta.
    click(btnExp);
    expect(container.querySelector('.line-clamp-2')).toBeTruthy();
    expect(container.querySelector('button').textContent).toContain('Ver más');
    teardown();
  });
});
