// @vitest-environment jsdom
//
// D-063 (RQ-02.12) — Históricos: la copia de Sala que se deshizo en Disponibilidad llega al
// histórico con `campos_extra.anulado` (string JSON, vía v_historico_busqueda) y se ve tachada,
// atenuada y con el chip "Anulado" (mismo tooltip que la grilla: quién y cuándo, Bogotá). Las filas
// sin `anulado` se ven exactamente como hoy y un `campos_extra` corrupto no explota. Además fija los
// helpers puros compartidos (`estadoReflejo`, `tituloAnulado`, `fechaHoraBogota`).
import { describe, it, expect } from 'vitest';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { HistoricoTable, estadoReflejo, tituloAnulado, fechaHoraBogota } from './HistoricoTable.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => {};

const ANULADO = {
  por: 9,
  nombre: 'Juan Pérez',
  cargo: 'Ingeniero Jefe de Turno',
  en: '2026-08-27T20:15:00.000Z',
};

function makeRow(overrides = {}) {
  return {
    registro_id: 1,
    fecha_evento: '2026-08-27T15:00:00.000Z',
    bitacora_codigo: 'SALAJDT',
    bitacora_nombre: 'Sala de Mando JdT',
    planta_id: 'TST',
    planta_nombre: 'Planta de prueba',
    turno: 1,
    tipo_evento: 'Cambio de Disponibilidad',
    detalle: 'GEC3 F/L indisponible. Falla en el sistema de enfriamiento.',
    participantes: '[]',
    jdts_snapshot: '[]',
    jefes_snapshot: '[]',
    creado_por_nombre: 'Operador Uno',
    creado_en: '2026-08-27T15:01:00.000Z',
    fecha_cierre_operativo: '2026-08-27T00:00:00.000Z',
    campos_extra: null,
    ...overrides,
  };
}

function renderTabla(rows) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(h(HistoricoTable, {
      rows,
      loading: false,
      page: 1,
      limit: 20,
      total: rows.length,
      onPageChange: noop,
      onLimitChange: noop,
    }));
  });
  const teardown = () => {
    act(() => { root.unmount(); });
    container.remove();
  };
  return { container, teardown };
}

const filas = (c) => Array.from(c.querySelectorAll('tbody tr'));
const chipAnulado = (el) => el.querySelector('span[title^="Deshecho por"]');
const tachado = (el) => el.querySelector('.line-through');

describe('HistoricoTable · copia anulada (D-063 CA-9)', () => {
  it('fila con campos_extra.anulado: detalle tachado + atenuado y chip "Anulado" con tooltip quién/cuándo Bogotá', () => {
    const { container, teardown } = renderTabla([
      makeRow({ campos_extra: JSON.stringify({ origen_bitacora: 'DISP', origen_disponibilidad_id: 123, anulado: ANULADO }) }),
    ]);
    const [tr] = filas(container);
    const chip = chipAnulado(tr);
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain('Anulado');
    expect(chip.getAttribute('title')).toBe('Deshecho por Juan Pérez (Ingeniero Jefe de Turno) el 27/08/2026 15:15');
    const det = tachado(tr);
    expect(det).toBeTruthy();
    expect(det.textContent).toContain('GEC3 F/L indisponible');
    expect(det.className).toContain('text-gray-400');
    // El detalle NO se borra ni se reemplaza por otro texto.
    expect(tr.textContent).toContain('Falla en el sistema de enfriamiento');
    teardown();
  });

  it('filas sin anulado (campos_extra null / JSON de copia viva / JSON de otro campo): sin marca, clases de hoy', () => {
    const { container, teardown } = renderTabla([
      makeRow({ registro_id: 1, campos_extra: null }),
      makeRow({ registro_id: 2, campos_extra: JSON.stringify({ origen_bitacora: 'DISP', origen_disponibilidad_id: 5 }) }),
      makeRow({ registro_id: 3, campos_extra: JSON.stringify({ origen_bitacora: 'MAND', origen_lote_id: 'abc' }) }),
      makeRow({ registro_id: 4, campos_extra: JSON.stringify({ presion: 12.5 }) }),
    ]);
    const trs = filas(container);
    expect(trs.length).toBe(4);
    for (const tr of trs) {
      expect(chipAnulado(tr)).toBeNull();
      expect(tachado(tr)).toBeNull();
      expect(tr.textContent).not.toContain('Anulado');
      // Mismo render que antes de D-063: el detalle en gris oscuro, sin atenuar.
      expect(tr.querySelector('.text-gray-700.whitespace-pre-wrap')).toBeTruthy();
    }
    teardown();
  });

  it('campos_extra que no es JSON (o es JSON pero no objeto) no explota y no marca', () => {
    const { container, teardown } = renderTabla([
      makeRow({ registro_id: 1, campos_extra: '{no es json' }),
      makeRow({ registro_id: 2, campos_extra: '"texto"' }),
      makeRow({ registro_id: 3, campos_extra: '[1,2]' }),
      makeRow({ registro_id: 4, campos_extra: JSON.stringify({ anulado: 'si' }) }),
    ]);
    const trs = filas(container);
    expect(trs.length).toBe(4);
    for (const tr of trs) {
      expect(chipAnulado(tr)).toBeNull();
      expect(tachado(tr)).toBeNull();
    }
    teardown();
  });
});

describe('helpers puros del reflejo (D-063)', () => {
  it('estadoReflejo: reflejado ⇔ origen_bitacora string no vacía; anulado ⇔ objeto', () => {
    expect(estadoReflejo(null)).toEqual({ reflejado: false, anulado: null });
    expect(estadoReflejo(undefined)).toEqual({ reflejado: false, anulado: null });
    expect(estadoReflejo('')).toEqual({ reflejado: false, anulado: null });
    expect(estadoReflejo('{no es json')).toEqual({ reflejado: false, anulado: null });
    expect(estadoReflejo('[1]')).toEqual({ reflejado: false, anulado: null });
    // El puntero solo NO marca (marcador universal, C3).
    expect(estadoReflejo({ origen_lote_id: 'x' }).reflejado).toBe(false);
    expect(estadoReflejo({ origen_disponibilidad_id: 5 }).reflejado).toBe(false);
    expect(estadoReflejo({ origen_bitacora: '' }).reflejado).toBe(false);
    expect(estadoReflejo({ origen_bitacora: '   ' }).reflejado).toBe(false);
    expect(estadoReflejo({ origen_bitacora: 7 }).reflejado).toBe(false);
    // Marcador presente: string u objeto, MAND o DISP.
    expect(estadoReflejo({ origen_bitacora: 'MAND', origen_lote_id: 'x' }).reflejado).toBe(true);
    expect(estadoReflejo('{"origen_bitacora":"DISP","origen_disponibilidad_id":5}').reflejado).toBe(true);
    // Anulado solo si es objeto.
    expect(estadoReflejo({ origen_bitacora: 'DISP', anulado: ANULADO }).anulado).toEqual(ANULADO);
    expect(estadoReflejo({ origen_bitacora: 'DISP', anulado: true }).anulado).toBeNull();
    expect(estadoReflejo({ origen_bitacora: 'DISP', anulado: 'si' }).anulado).toBeNull();
    expect(estadoReflejo({ origen_bitacora: 'DISP', anulado: [1] }).anulado).toBeNull();
    expect(estadoReflejo({ origen_bitacora: 'DISP', anulado: null }).anulado).toBeNull();
  });

  it('fechaHoraBogota: dd/mm/aaaa HH:mm en Bogotá, 00 a medianoche, vacío si inválida', () => {
    expect(fechaHoraBogota('2026-08-27T20:15:00.000Z')).toBe('27/08/2026 15:15');
    expect(fechaHoraBogota('2026-08-28T05:05:00.000Z')).toBe('28/08/2026 00:05');
    expect(fechaHoraBogota('2026-08-28T04:59:00.000Z')).toBe('27/08/2026 23:59');
    expect(fechaHoraBogota(new Date('2026-01-05T12:00:00.000Z'))).toBe('05/01/2026 07:00');
    expect(fechaHoraBogota(null)).toBe('');
    expect(fechaHoraBogota('')).toBe('');
    expect(fechaHoraBogota('no-es-fecha')).toBe('');
  });

  it('tituloAnulado: nombre o "usuario <id>", cargo entre paréntesis solo si viene, fecha solo si es válida', () => {
    expect(tituloAnulado(ANULADO)).toBe('Deshecho por Juan Pérez (Ingeniero Jefe de Turno) el 27/08/2026 15:15');
    expect(tituloAnulado({ por: 9, nombre: null, cargo: null, en: ANULADO.en })).toBe('Deshecho por usuario 9 el 27/08/2026 15:15');
    expect(tituloAnulado({ por: 9, nombre: 'Ana', cargo: null, en: ANULADO.en })).toBe('Deshecho por Ana el 27/08/2026 15:15');
    expect(tituloAnulado({ por: 9, nombre: 'Ana', cargo: 'JdT', en: 'basura' })).toBe('Deshecho por Ana (JdT)');
    expect(tituloAnulado({ nombre: null, cargo: null, en: null })).toBe('Deshecho por un usuario');
    expect(tituloAnulado(null)).toBe('Deshecho por un usuario');
  });
});
