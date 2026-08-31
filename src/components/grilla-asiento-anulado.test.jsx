// @vitest-environment jsdom
//
// D-063 (RQ-02.10 / RQ-02.12) — la grilla de Sala (GrillaRegistros REAL, no una réplica):
//   (a) reconoce el asiento reflejado por el marcador UNIVERSAL `campos_extra.origen_bitacora`
//       ('MAND' | 'DISP') y lo rotula con el nombre que manda el backend (`origen_bitacora_nombre`);
//   (b) la copia ANULADA (deshecha en Disponibilidad) sigue visible, con el detalle tachado y un
//       chip "Anulado" cuyo tooltip dice quién (nombre + cargo) y cuándo, en hora Bogotá;
//   (c) un registro propio normal no se ve afectado;
//   (d) un `origen_lote_id` SIN `origen_bitacora` NO es reflejado — el puntero al origen es dato,
//       nunca criterio (fija el marcador universal del lado del front).
// La editabilidad (lápiz/basurero) sigue viniendo SOLO de `puede_editar` (D-049); acá se verifica
// que el rotulado y el estado visual no la contradicen.
import { describe, it, expect } from 'vitest';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { GrillaRegistros } from '../BitacorasGecelca3.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => {};

// 2026-08-27T20:15Z = 27/08/2026 15:15 en Bogotá (UTC-5, sin DST).
const ANULADO = {
  por: 9,
  nombre: 'Juan Pérez',
  cargo: 'Ingeniero Jefe de Turno',
  en: '2026-08-27T20:15:00.000Z',
};

function makeRegistro(overrides = {}) {
  return {
    registro_id: 1,
    bitacora_id: 10,
    planta_id: 'TST',
    bitacora_nombre: 'Sala de Mando JdT',
    estado: 'borrador',
    detalle: 'Registro propio con una descripción suficientemente larga para la fila.',
    fecha_evento: '2026-08-27T15:00:00.000Z',
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

// Copia viva de Disponibilidad tal como la entrega GET /activos (C2 + C7): marcador universal +
// puntero numérico, nombre del origen resuelto del catálogo, `puede_editar=false`.
function makeCopiaDisp(overrides = {}) {
  return makeRegistro({
    registro_id: 77,
    detalle: 'GEC3 F/L indisponible. Falla en el sistema de enfriamiento.',
    tipo_evento_id: 2,
    tipo_evento_nombre: 'Cambio de Disponibilidad',
    campos_extra: JSON.stringify({ origen_bitacora: 'DISP', origen_disponibilidad_id: 123 }),
    origen_bitacora_nombre: 'Disponibilidad',
    puede_editar: false,
    ...overrides,
  });
}

function makeCopiaAnulada(anulado = ANULADO, overrides = {}) {
  return makeCopiaDisp({
    registro_id: 78,
    campos_extra: JSON.stringify({ origen_bitacora: 'DISP', origen_disponibilidad_id: 123, anulado }),
    ...overrides,
  });
}

function renderGrilla({ registros, bloqueado = false }) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(h(GrillaRegistros, {
      registros,
      bitacora: { bitacora_id: 10, codigo: 'SALAJDT', definicion_campos: null },
      tiposEvento: [
        { tipo_evento_id: 1, nombre: 'Evento General' },
        { tipo_evento_id: 2, nombre: 'Cambio de Disponibilidad' },
      ],
      jefeNombre: null,
      jdtNombre: null,
      puedeCrear: true,
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
  const teardown = () => {
    act(() => { root.unmount(); });
    container.remove();
  };
  return { container, teardown };
}

// El chip de origen se reconoce por el PREFIJO del tooltip, que es común a la copia viva y a la
// anulada; el resto del texto es justo lo que L06 ramifica, así que no puede ser el selector.
const chipOrigen = (c) => c.querySelector('span[title^="Asiento generado en"]');
const chipsOrigenVivos = (c) => c.querySelectorAll('span[title*="Corrígelo allá"]');
const chipAnulado = (c) => c.querySelector('span[title^="Deshecho por"]');
const detalleTachado = (c) => c.querySelector('p.line-through');

describe('GrillaRegistros · copia de Disponibilidad viva (D-063 CA-8)', () => {
  it('(a) chip con el nombre del origen, sin Editar/Eliminar, ojo presente y texto SIN tachar', () => {
    const { container, teardown } = renderGrilla({ registros: [makeCopiaDisp()] });
    const origen = chipOrigen(container);
    expect(origen).toBeTruthy();
    expect(origen.getAttribute('title')).toContain('Disponibilidad');
    expect(origen.textContent).toContain('Disponibilidad');
    expect(container.querySelector('button[title="Editar"]')).toBeNull();
    expect(container.querySelector('button[title="Eliminar"]')).toBeNull();
    expect(container.querySelector('button[title="Ver detalle completo"]')).toBeTruthy();
    expect(detalleTachado(container)).toBeNull();
    expect(chipAnulado(container)).toBeNull();
    expect(container.textContent).not.toContain('Anulado');
    teardown();
  });
});

describe('GrillaRegistros · copia de Disponibilidad ANULADA (D-063 CA-8)', () => {
  it('(b) chip "Anulado" con quién (nombre + cargo) y cuándo en Bogotá; detalle tachado; sin acciones', () => {
    const { container, teardown } = renderGrilla({ registros: [makeCopiaAnulada()] });
    const chip = chipAnulado(container);
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain('Anulado');
    const title = chip.getAttribute('title');
    expect(title).toContain('Juan Pérez');
    expect(title).toContain('(Ingeniero Jefe de Turno)');
    expect(title).toContain('27/08/2026 15:15');
    expect(title).toBe('Deshecho por Juan Pérez (Ingeniero Jefe de Turno) el 27/08/2026 15:15');
    // El detalle sigue visible (no se borra), tachado y atenuado.
    const p = detalleTachado(container);
    expect(p).toBeTruthy();
    expect(p.textContent).toContain('GEC3 F/L indisponible');
    expect(p.className).toContain('text-gray-400');
    // Sigue siendo un asiento reflejado: chip de origen y ojo conservados, sin lápiz ni basurero.
    expect(chipOrigen(container)).toBeTruthy();
    expect(chipsOrigenVivos(container).length).toBe(0);   // pero ya no promete "se actualiza sola" (e)
    expect(container.querySelector('button[title="Ver detalle completo"]')).toBeTruthy();
    expect(container.querySelector('button[title="Editar"]')).toBeNull();
    expect(container.querySelector('button[title="Eliminar"]')).toBeNull();
    teardown();
  });

  it('(b\') sin nombre ni cargo en el snapshot: "usuario <id>" y sin paréntesis', () => {
    const { container, teardown } = renderGrilla({
      registros: [makeCopiaAnulada({ por: 9, nombre: null, cargo: null, en: '2026-08-28T05:05:00.000Z' })],
    });
    // Medianoche Bogotá (05:05Z) → 00:05, no 24:05.
    expect(chipAnulado(container).getAttribute('title')).toBe('Deshecho por usuario 9 el 28/08/2026 00:05');
    teardown();
  });

  it('(b\'\') `anulado` que no es objeto (true / "si") NO marca la fila', () => {
    const { container, teardown } = renderGrilla({
      registros: [
        makeCopiaAnulada(true, { registro_id: 80 }),
        makeCopiaAnulada('si', { registro_id: 81 }),
      ],
    });
    expect(chipAnulado(container)).toBeNull();
    expect(detalleTachado(container)).toBeNull();
    // Ambas siguen siendo reflejadas (dos chips de origen).
    expect(chipsOrigenVivos(container).length).toBe(2);
    teardown();
  });

  it('(b\'\'\') con la grilla bloqueada (turno finalizado) el chip "Anulado" sigue visible junto a "Bloqueado"', () => {
    const { container, teardown } = renderGrilla({ registros: [makeCopiaAnulada()], bloqueado: true });
    expect(container.textContent).toContain('Bloqueado');
    expect(chipAnulado(container)).toBeTruthy();
    expect(detalleTachado(container)).toBeTruthy();
    expect(container.querySelector('button[title="Editar"]')).toBeNull();
    teardown();
  });
});

describe('GrillaRegistros · tooltip del chip de origen, honesto en los dos estados (D-063 CA-17)', () => {
  it('(e) copia ANULADA: el chip de origen no promete actualización; dice que el evento se deshizo', () => {
    const { container, teardown } = renderGrilla({ registros: [makeCopiaAnulada()] });
    const title = chipOrigen(container).getAttribute('title');
    // La promesa vieja es FALSA acá: el evento de origen ya no existe, no hay nada que corregir allá.
    expect(title).not.toContain('se actualiza sola');
    expect(title).not.toContain('Corrígelo');
    expect(title).toContain('se deshizo');
    expect(title).toBe(
      'Asiento generado en Disponibilidad. Su evento se deshizo allá; esta copia se conserva como constancia del turno.',
    );
    // El rótulo visible del chip no cambia: sigue siendo el nombre del origen (catálogo, D-052).
    expect(chipOrigen(container).textContent).toContain('Disponibilidad');
    teardown();
  });

  it('(e\') copia VIVA: el tooltip de siempre, intacto', () => {
    const { container, teardown } = renderGrilla({ registros: [makeCopiaDisp()] });
    expect(chipOrigen(container).getAttribute('title')).toBe(
      'Asiento generado en Disponibilidad. Corrígelo allá y esta copia se actualiza sola.',
    );
    teardown();
  });

  it('(e\'\') ramifica por `anulado`, no por el origen: una copia MAND anulada dice lo mismo', () => {
    const { container, teardown } = renderGrilla({
      registros: [makeRegistro({
        registro_id: 95,
        campos_extra: JSON.stringify({ origen_bitacora: 'MAND', origen_lote_id: 'x', anulado: ANULADO }),
        origen_bitacora_nombre: 'Operación 24h',
        puede_editar: false,
      })],
    });
    expect(chipOrigen(container).getAttribute('title')).toBe(
      'Asiento generado en Operación 24h. Su evento se deshizo allá; esta copia se conserva como constancia del turno.',
    );
    teardown();
  });
});

describe('GrillaRegistros · el marcador es origen_bitacora, no el puntero (D-063 CA-8)', () => {
  it('(c) registro propio sin origen_bitacora: Editar/Eliminar como siempre, sin chips ni tachado', () => {
    const { container, teardown } = renderGrilla({
      registros: [makeRegistro({ puede_editar: true })],
    });
    expect(container.querySelector('button[title="Editar"]')).toBeTruthy();
    expect(container.querySelector('button[title="Eliminar"]')).toBeTruthy();
    expect(chipOrigen(container)).toBeNull();
    expect(chipAnulado(container)).toBeNull();
    expect(detalleTachado(container)).toBeNull();
    teardown();
  });

  it('(d) campos_extra con origen_lote_id pero SIN origen_bitacora NO es reflejado', () => {
    const { container, teardown } = renderGrilla({
      registros: [makeRegistro({
        puede_editar: true,
        campos_extra: JSON.stringify({ origen_lote_id: 'abc-123' }),
        origen_bitacora_nombre: null,
      })],
    });
    expect(chipOrigen(container)).toBeNull();
    expect(container.querySelector('button[title="Editar"]')).toBeTruthy();
    expect(container.querySelector('button[title="Eliminar"]')).toBeTruthy();
    teardown();
  });

  it('(d\') origen_bitacora vacío ("") tampoco marca; MAND con ambas claves sí', () => {
    const { container, teardown } = renderGrilla({
      registros: [
        makeRegistro({ registro_id: 90, puede_editar: true, campos_extra: JSON.stringify({ origen_bitacora: '', origen_lote_id: 'x' }) }),
        makeRegistro({ registro_id: 91, puede_editar: false, campos_extra: JSON.stringify({ origen_bitacora: 'MAND', origen_lote_id: 'x' }), origen_bitacora_nombre: 'Operación 24h' }),
      ],
    });
    expect(chipsOrigenVivos(container).length).toBe(1);
    expect(container.querySelectorAll('button[title="Editar"]').length).toBe(1);
    teardown();
  });
});
