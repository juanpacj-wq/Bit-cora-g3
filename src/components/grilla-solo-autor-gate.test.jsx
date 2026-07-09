// @vitest-environment jsdom
//
// D-049 — gate de UI "solo el autor" en GrillaRegistros (el componente REAL, no una réplica):
// la editabilidad de fila se deriva EXCLUSIVAMENTE de `registro.puede_editar` (espejo que computa
// el backend en GET /api/registros/activos). Verifica:
//   1. Registro propio (puede_editar=true, borrador) → botones Editar y Eliminar.
//   2. Registro ajeno (puede_editar=false) → SIN Editar/Eliminar; el ojo "Ver detalle completo"
//      expande la descripción en LECTURA (no entra en modo edición: no aparece Guardar).
//   3. Grilla bloqueada (turno finalizado/cerrado/transición) → chip "Bloqueado", sin acciones,
//      incluso sobre un registro propio.
import { describe, it, expect } from 'vitest';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { GrillaRegistros } from '../BitacorasGecelca3.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => {};

function makeRegistro(overrides = {}) {
  return {
    registro_id: 1,
    bitacora_id: 10,
    planta_id: 'GEC3',
    bitacora_nombre: 'Caldera',
    estado: 'borrador',
    detalle: 'Registro de prueba con una descripción suficientemente larga.',
    fecha_evento: '2026-07-08T15:00:00.000Z',
    turno: 1,
    tipo_evento_id: 1,
    tipo_evento_nombre: 'Evento General',
    campos_extra: null,
    ingenieros_snapshot: '[]',
    jdts_snapshot: '[]',
    jefes_snapshot: '[]',
    creado_por: 7,
    creado_por_nombre: 'Operador Uno',
    puede_editar: false,
    ...overrides,
  };
}

function renderGrilla({ registros, bloqueado = false }) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(h(GrillaRegistros, {
      registros,
      bitacora: { bitacora_id: 10, codigo: 'CALDERA', definicion_campos: null },
      tiposEvento: [{ tipo_evento_id: 1, nombre: 'Evento General' }],
      jefeNombre: null,
      jdtNombre: null,
      puedeCrear: false,
      bloqueado,
      onUpdateLocal: noop,
      onSaveRegistro: async () => true,
      onDeleteRegistro: noop,
      filtroTexto: '',
      filtroTipo: '',
      filtroFecha: '',
      filtroTurno: '',
      onLimpiarFiltros: noop,
      showToast: noop,
    }));
  });
  const click = (el) => act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  const teardown = () => {
    act(() => { root.unmount(); });
    container.remove();
  };
  return { container, click, teardown };
}

describe('GrillaRegistros · gate solo-autor por fila (D-049)', () => {
  it('registro propio (puede_editar=true): muestra Editar y Eliminar', () => {
    const { container, teardown } = renderGrilla({
      registros: [makeRegistro({ puede_editar: true })],
    });
    expect(container.querySelector('button[title="Editar"]')).toBeTruthy();
    expect(container.querySelector('button[title="Eliminar"]')).toBeTruthy();
    expect(container.querySelector('button[title="Ver detalle completo"]')).toBeNull();
    teardown();
  });

  it('registro ajeno (puede_editar=false): sin Editar/Eliminar, solo lectura', () => {
    const { container, teardown } = renderGrilla({
      registros: [makeRegistro({ puede_editar: false })],
    });
    expect(container.querySelector('button[title="Editar"]')).toBeNull();
    expect(container.querySelector('button[title="Eliminar"]')).toBeNull();
    expect(container.querySelector('button[title="Ver detalle completo"]')).toBeTruthy();
    teardown();
  });

  it('el ojo del registro ajeno expande la descripción en LECTURA y no entra en edición', () => {
    const { container, click, teardown } = renderGrilla({
      registros: [makeRegistro({ puede_editar: false })],
    });
    const ojo = container.querySelector('button[title="Ver detalle completo"]');
    click(ojo);
    // Expandido: el <p> del detalle pierde el line-clamp y el botón cambia a "Contraer".
    expect(container.querySelector('button[title="Contraer detalle"]')).toBeTruthy();
    expect(container.querySelector('p.line-clamp-2')).toBeNull();
    // NUNCA entra en modo edición: no hay botón Guardar ni textarea editable.
    expect(container.querySelector('button[title="Guardar"]')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    // Toggle de vuelta.
    click(container.querySelector('button[title="Contraer detalle"]'));
    expect(container.querySelector('p.line-clamp-2')).toBeTruthy();
    teardown();
  });

  it('grilla bloqueada: chip Bloqueado y cero acciones incluso en registro propio', () => {
    const { container, teardown } = renderGrilla({
      registros: [makeRegistro({ puede_editar: true })],
      bloqueado: true,
    });
    expect(container.querySelector('button[title="Editar"]')).toBeNull();
    expect(container.querySelector('button[title="Eliminar"]')).toBeNull();
    expect(container.textContent).toContain('Bloqueado');
    teardown();
  });

  it('registro cerrado propio: sin Editar/Eliminar aunque puede_editar venga en true', () => {
    const { container, teardown } = renderGrilla({
      registros: [makeRegistro({ puede_editar: true, estado: 'cerrado' })],
    });
    expect(container.querySelector('button[title="Editar"]')).toBeNull();
    expect(container.querySelector('button[title="Eliminar"]')).toBeNull();
    teardown();
  });
});
