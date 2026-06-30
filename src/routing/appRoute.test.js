// D-035: tests del router puro (sin React/DOM). Contrato: parse/build son inversos para cada
// sección, los params se validan estrictamente (planta ∈ {GEC3,GEC32}; fecha bien formada y no
// futura) y todo input desconocido cae al fallback (vista 'bitacoras', codigo null).
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseHash, buildHash } from './appRoute.js';

describe('routing/appRoute — parseHash', () => {
  test('vacío → fallback', () => {
    expect(parseHash('')).toEqual({ vista: 'bitacoras', codigo: null, params: {} });
    expect(parseHash('#')).toEqual({ vista: 'bitacoras', codigo: null, params: {} });
    expect(parseHash('#/')).toEqual({ vista: 'bitacoras', codigo: null, params: {} });
  });

  test('slug desconocido → fallback', () => {
    expect(parseHash('#/no-existe')).toEqual({ vista: 'bitacoras', codigo: null, params: {} });
  });

  test('#/op24h → MAND', () => {
    expect(parseHash('#/op24h')).toEqual({ vista: 'bitacoras', codigo: 'MAND', params: {} });
  });

  test('#/historicos → vista historicos', () => {
    expect(parseHash('#/historicos')).toEqual({ vista: 'historicos', codigo: null, params: {} });
  });

  test('#/b/AUTOR → genérica (codigo en mayúsculas)', () => {
    expect(parseHash('#/b/AUTOR')).toEqual({ vista: 'bitacoras', codigo: 'AUTOR', params: {} });
    expect(parseHash('#/b/autor')).toEqual({ vista: 'bitacoras', codigo: 'AUTOR', params: {} });
  });

  test('#/b sin codigo → fallback', () => {
    expect(parseHash('#/b')).toEqual({ vista: 'bitacoras', codigo: null, params: {} });
  });

  describe('DISP — validación de planta', () => {
    test('planta válida se conserva', () => {
      expect(parseHash('#/disp?planta=GEC3')).toEqual({ vista: 'bitacoras', codigo: 'DISP', params: { planta: 'GEC3' } });
      expect(parseHash('#/disp?planta=GEC32')).toEqual({ vista: 'bitacoras', codigo: 'DISP', params: { planta: 'GEC32' } });
    });
    test('planta inválida se descarta', () => {
      expect(parseHash('#/disp?planta=GEC4')).toEqual({ vista: 'bitacoras', codigo: 'DISP', params: {} });
      expect(parseHash('#/disp')).toEqual({ vista: 'bitacoras', codigo: 'DISP', params: {} });
    });
  });

  describe('COMB — validación de fecha', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-06-29T15:00:00.000Z')); });
    afterEach(() => { vi.useRealTimers(); });

    test('fecha pasada válida se conserva', () => {
      expect(parseHash('#/comb?fecha=2026-06-20')).toEqual({ vista: 'bitacoras', codigo: 'COMB', params: { fecha: '2026-06-20' } });
    });
    test('hoy (Bogotá) se conserva', () => {
      expect(parseHash('#/comb?fecha=2026-06-29')).toEqual({ vista: 'bitacoras', codigo: 'COMB', params: { fecha: '2026-06-29' } });
    });
    test('fecha futura se descarta', () => {
      expect(parseHash('#/comb?fecha=2999-01-01')).toEqual({ vista: 'bitacoras', codigo: 'COMB', params: {} });
    });
    test('fecha mal formada se descarta', () => {
      expect(parseHash('#/comb?fecha=20-06-2026')).toEqual({ vista: 'bitacoras', codigo: 'COMB', params: {} });
      expect(parseHash('#/comb?fecha=abc')).toEqual({ vista: 'bitacoras', codigo: 'COMB', params: {} });
    });
  });
});

describe('routing/appRoute — buildHash', () => {
  test('historicos', () => { expect(buildHash({ vista: 'historicos' })).toBe('#/historicos'); });
  test('sin codigo → raíz', () => { expect(buildHash({ vista: 'bitacoras', codigo: null })).toBe('#/'); });
  test('MAND', () => { expect(buildHash({ vista: 'bitacoras', codigo: 'MAND', params: {} })).toBe('#/op24h'); });
  test('genérica', () => { expect(buildHash({ vista: 'bitacoras', codigo: 'AUTOR', params: {} })).toBe('#/b/AUTOR'); });
  test('DISP con planta válida', () => { expect(buildHash({ vista: 'bitacoras', codigo: 'DISP', params: { planta: 'GEC32' } })).toBe('#/disp?planta=GEC32'); });
  test('DISP con planta inválida → sin query', () => { expect(buildHash({ vista: 'bitacoras', codigo: 'DISP', params: { planta: 'X' } })).toBe('#/disp'); });

  describe('COMB con fecha', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-06-29T15:00:00.000Z')); });
    afterEach(() => { vi.useRealTimers(); });
    test('fecha válida', () => { expect(buildHash({ vista: 'bitacoras', codigo: 'COMB', params: { fecha: '2026-06-20' } })).toBe('#/comb?fecha=2026-06-20'); });
    test('fecha futura → sin query', () => { expect(buildHash({ vista: 'bitacoras', codigo: 'COMB', params: { fecha: '2999-01-01' } })).toBe('#/comb'); });
  });
});

describe('routing/appRoute — round-trip parse∘build', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-06-29T15:00:00.000Z')); });
  afterEach(() => { vi.useRealTimers(); });

  const casos = [
    { vista: 'bitacoras', codigo: 'MAND', params: {} },
    { vista: 'bitacoras', codigo: 'DISP', params: { planta: 'GEC3' } },
    { vista: 'bitacoras', codigo: 'DISP', params: { planta: 'GEC32' } },
    { vista: 'bitacoras', codigo: 'COMB', params: { fecha: '2026-06-20' } },
    { vista: 'bitacoras', codigo: 'AUTOR', params: {} },
    { vista: 'historicos', codigo: null, params: {} },
  ];
  test('build → parse devuelve la misma ruta', () => {
    for (const r of casos) {
      expect(parseHash(buildHash(r))).toEqual(r);
    }
  });
});
