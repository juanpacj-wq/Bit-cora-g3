// @vitest-environment jsdom
//
// D-057 — gates de UI de la corrección por lote, sobre los componentes REALES:
//   1. `LotesDelDia` sin `puedeCrear` → el listado se ve completo pero SIN lápiz ni basurero
//      (RN-04.f). Es la cara front del test de backend `D-057 E3.8`: allá el `PUT`/`DELETE` dan 403,
//      acá el control ni siquiera se ofrece.
//   2. Con `puedeCrear` → ambos controles, y el click entrega el LOTE completo (no solo su id).
//   3. `LoteEditorModal` con todos los valores vacíos → Guardar deshabilitado y el copy señala
//      Eliminar (decisión 6: vaciar ≠ borrar). El backend igual lo rechaza con `lote_sin_celdas`;
//      esto es affordance, no la regla.
//   4. REDESP con un periodo pasado → se bloquea el VALOR y el quitar, nunca la hora ni la
//      descripción (decisión 3: "el lock protege el valor, jamás el comentario").
import { describe, it, expect } from 'vitest';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import LotesDelDia from './LotesDelDia.jsx';
import LoteEditorModal from './LoteEditorModal.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => {};

function makeLote(overrides = {}) {
  return {
    lote_id: 'lote-abc',
    tipo: 'AUTH',
    tipo_nombre: 'Autorización',
    hora_llamada: '2026-07-23T13:49:00.000Z', // 08:49 Bogotá
    funcionariocnd: 'Funcionario CND',
    detalle: 'Llamada de prueba',
    creado_en: '2026-07-23T13:50:00.000Z',
    creado_por: { usuario_id: 7, nombre_completo: 'Operador Uno' },
    periodos: [
      { periodo: 9, valor_mw: 120, registro_id: 101, publicado: true },
      { periodo: 10, valor_mw: 130, registro_id: 102, publicado: false },
    ],
    ...overrides,
  };
}

function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(element); });
  const click = (el) => act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  // React escucha el evento nativo 'input'; asignar `.value` a secas no dispara onChange.
  const type = (el, value) => act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const teardown = () => {
    act(() => { root.unmount(); });
    container.remove();
  };
  return { container, click, type, teardown };
}

describe('LotesDelDia · acciones por permiso (D-057, RN-04.f)', () => {
  it('sin puedeCrear: el listado se ve, pero no hay lápiz ni basurero', () => {
    const { container, teardown } = render(
      h(LotesDelDia, { lotes: [makeLote()], fecha: '2026-07-23', cargando: false, error: null, puedeCrear: false })
    );
    expect(container.textContent).toContain('Autorización');
    expect(container.textContent).toContain('Llamada de prueba');
    expect(container.querySelectorAll('button').length).toBe(0);
    expect(container.textContent).not.toContain('Acciones');
    teardown();
  });

  it('con puedeCrear: lápiz y basurero, y el click entrega el lote completo', () => {
    const lote = makeLote();
    const editados = [];
    const borrados = [];
    const { container, click, teardown } = render(
      h(LotesDelDia, {
        lotes: [lote], fecha: '2026-07-23', cargando: false, error: null, puedeCrear: true,
        onEditar: (l) => editados.push(l), onEliminar: (l) => borrados.push(l),
      })
    );
    expect(container.textContent).toContain('Acciones');
    const editar = container.querySelector('button[aria-label^="Corregir"]');
    const eliminar = container.querySelector('button[aria-label^="Eliminar"]');
    expect(editar).toBeTruthy();
    expect(eliminar).toBeTruthy();
    click(editar);
    click(eliminar);
    expect(editados).toEqual([lote]);
    expect(borrados).toEqual([lote]);
    teardown();
  });
});

describe('LoteEditorModal · affordances (D-057)', () => {
  it('vaciar todos los valores deshabilita Guardar y señala Eliminar (decisión 6)', () => {
    const { container, type, teardown } = render(
      h(LoteEditorModal, {
        lote: makeLote(), plantaId: 'GEC3', periodoActual: 12,
        onGuardar: noop, onEliminar: noop, onCerrar: noop,
      })
    );
    const guardar = container.querySelector('button[type="submit"]');
    expect(guardar.disabled).toBe(false);

    const valores = [...container.querySelectorAll('input[type="number"]')];
    expect(valores.length).toBe(2);
    for (const input of valores) type(input, '');

    expect(container.querySelector('button[type="submit"]').disabled).toBe(true);
    expect(container.textContent).toContain('usa Eliminar');
    teardown();
  });

  it('REDESP: el periodo pasado bloquea el valor y el quitar, no la hora ni la descripción', () => {
    const lote = makeLote({
      tipo: 'REDESP',
      tipo_nombre: 'Redespacho',
      funcionariocnd: null,
      periodos: [
        { periodo: 2, valor_mw: 100, registro_id: 201, publicado: true },
        { periodo: 20, valor_mw: 110, registro_id: 202, publicado: false },
      ],
    });
    const { container, teardown } = render(
      h(LoteEditorModal, {
        lote, plantaId: 'GEC3', periodoActual: 10,
        onGuardar: noop, onEliminar: noop, onCerrar: noop,
      })
    );
    const valores = [...container.querySelectorAll('input[type="number"]')];
    expect(valores.map((i) => i.disabled)).toEqual([true, false]); // P2 pasado, P20 futuro
    expect(container.querySelector('button[aria-label="Quitar periodo 2"]').disabled).toBe(true);
    expect(container.querySelector('button[aria-label="Quitar periodo 20"]').disabled).toBe(false);
    // El lock protege el VALOR, jamás el comentario ni la hora.
    expect(container.querySelector('input[type="time"]').disabled).toBe(false);
    const textos = [...container.querySelectorAll('input[type="text"]')];
    const detalle = textos.find((i) => i.value === 'Llamada de prueba');
    expect(detalle.disabled).toBe(false);
    teardown();
  });
});
