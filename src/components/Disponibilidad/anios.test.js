// D-051 — lógica pura del filtro de AÑO del dashboard DISP (opciones, ventana Bogotá y clamp
// del año seleccionado cuando el rango cambia en vivo).
import { describe, it, expect } from 'vitest';
import { ANIO_TODOS, ANIO_ACTUAL, buildAniosOpts, ventanaAnio, anioVigente } from './anios';

describe('buildAniosOpts', () => {
  it('pone "Todos los años" primero (con separador) y los años como strings en el orden recibido', () => {
    const opts = buildAniosOpts([2026, 2025, 2024]);
    expect(opts[0]).toEqual({ value: ANIO_TODOS, label: 'Todos los años', sep: true });
    expect(opts.slice(1)).toEqual([
      { value: '2026', label: '2026' },
      { value: '2025', label: '2025' },
      { value: '2024', label: '2024' },
    ]);
  });

  it('sin lista (undefined, [] o no-array) cae al año actual', () => {
    for (const input of [undefined, [], null, 'x']) {
      const opts = buildAniosOpts(input);
      expect(opts).toHaveLength(2);
      expect(opts[1].value).toBe(String(ANIO_ACTUAL));
    }
  });
});

describe('ventanaAnio', () => {
  it('ANIO_TODOS → sin ventana (all-time)', () => {
    expect(ventanaAnio(ANIO_TODOS)).toEqual({ desde: undefined, hasta: undefined });
  });

  it('un año → [1-ene 00:00 Bogotá, 1-ene siguiente 00:00 Bogotá) en UTC (+5h)', () => {
    const { desde, hasta } = ventanaAnio('2025');
    expect(desde).toBe('2025-01-01T05:00:00.000Z');
    expect(hasta).toBe('2026-01-01T05:00:00.000Z');
  });
});

describe('anioVigente (clamp cuando el rango cambia en vivo)', () => {
  it('ANIO_TODOS siempre se conserva', () => {
    expect(anioVigente(ANIO_TODOS, [2026])).toBe(ANIO_TODOS);
    expect(anioVigente(ANIO_TODOS, [])).toBe(ANIO_TODOS);
  });

  it('un año presente en la lista se conserva (números del backend vs string del selector)', () => {
    expect(anioVigente('2025', [2026, 2025, 2024])).toBe('2025');
  });

  it('un año que desapareció de la lista (deshacer encogió el rango) vuelve a "Todos"', () => {
    expect(anioVigente('2024', [2026, 2025])).toBe(ANIO_TODOS);
    expect(anioVigente('2024', [])).toBe(ANIO_TODOS);
    expect(anioVigente('2024', undefined)).toBe(ANIO_TODOS);
  });
});
