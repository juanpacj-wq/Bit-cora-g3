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

// D-058 E6 (RQ-02.5) — el asiento REFLEJADO desde Operación 24h se identifica por su ORIGEN y no
// ofrece edición en su destino. El backend ya manda `puede_editar=false` (espejo de
// canEditarRegistro con la condición nueva), así que la fila queda sin controles por el mismo camino
// de D-049: acá se fija que además se ROTULA, y que el rótulo sale del payload
// (`origen_bitacora_nombre`, resuelto del catálogo) y no de un literal del front (D-052).
// D-063: el marcador es UNIVERSAL — `campos_extra.origen_bitacora` ('MAND' | 'DISP'); el puntero
// (`origen_lote_id` / `origen_disponibilidad_id`) es solo dato. Las copias MAND reales traen ambas
// claves; las de Disponibilidad traen `origen_disponibilidad_id` (número).
function makeReflejado(overrides = {}) {
  return makeRegistro({
    registro_id: 42,
    detalle: 'Se recibe llamada del CND (juanpa) autorizando GEC3 a generar 20 MW del P7 al P14.',
    campos_extra: JSON.stringify({ origen_bitacora: 'MAND', origen_lote_id: 'abc-123' }),
    origen_bitacora_nombre: 'Operación 24h',
    puede_editar: false,
    ...overrides,
  });
}

describe('GrillaRegistros · asiento reflejado de solo lectura (D-058 E6)', () => {
  it('muestra el chip con el nombre del origen y no ofrece Editar/Eliminar', () => {
    const { container, teardown } = renderGrilla({ registros: [makeReflejado()] });
    expect(container.querySelector('button[title="Editar"]')).toBeNull();
    expect(container.querySelector('button[title="Eliminar"]')).toBeNull();
    expect(container.textContent).toContain('Operación 24h');
    expect(container.querySelector('span[title*="Corrígelo allá"]')).toBeTruthy();
    teardown();
  });

  it('D-063: la copia de Disponibilidad se rotula igual, por el mismo marcador origen_bitacora', () => {
    const { container, teardown } = renderGrilla({
      registros: [makeReflejado({
        registro_id: 43,
        detalle: 'GEC3 F/L indisponible. Falla en el sistema de enfriamiento.',
        campos_extra: JSON.stringify({ origen_bitacora: 'DISP', origen_disponibilidad_id: 5 }),
        origen_bitacora_nombre: 'Disponibilidad',
      })],
    });
    expect(container.querySelector('button[title="Editar"]')).toBeNull();
    expect(container.querySelector('button[title="Eliminar"]')).toBeNull();
    expect(container.querySelector('button[title="Ver detalle completo"]')).toBeTruthy();
    const chip = container.querySelector('span[title*="Corrígelo allá"]');
    expect(chip).toBeTruthy();
    expect(chip.getAttribute('title')).toContain('Disponibilidad');
    expect(container.textContent).toContain('Disponibilidad');
    teardown();
  });

  it('el ojo sigue expandiendo la descripción en lectura, como en cualquier fila ajena', () => {
    const { container, click, teardown } = renderGrilla({ registros: [makeReflejado()] });
    const ojo = container.querySelector('button[title="Ver detalle completo"]');
    expect(ojo).toBeTruthy();
    click(ojo);
    expect(container.querySelector('p.line-clamp-2')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    teardown();
  });

  it('un registro normal NO trae el chip de origen', () => {
    const { container, teardown } = renderGrilla({
      registros: [makeRegistro({ puede_editar: true })],
    });
    expect(container.querySelector('span[title*="Corrígelo allá"]')).toBeNull();
    teardown();
  });
});
