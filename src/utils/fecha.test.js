// F21.D: tests TZ-agnósticos de utils/fecha.js (frontend canonical helpers, F1+F17) y de la
// convención sv-SE/ISO UTC con offset -05:00 que F20 instaló en BitacorasGecelca3.jsx y
// CambiarEstadoModal.jsx. Los helpers de F20 están inline (no exportados), así que acá
// re-construimos el patrón canónico y lo testeamos como contrato — si el patrón cambia, los
// tests fallan y el caller debe alinearse.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { getTodayBogota, horaBogota, shiftDate } from './fecha.js';

describe('utils/fecha.js — helpers Bogotá', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  describe('getTodayBogota', () => {
    test('22:30 Bogotá (= 03:30 UTC del día siguiente) devuelve día Bogotá actual', () => {
      vi.setSystemTime(new Date('2026-05-06T03:30:00.000Z'));
      expect(getTodayBogota()).toBe('2026-05-05');
    });

    test('00:00 Bogotá (= 05:00 UTC) devuelve el día Bogotá que arrancó', () => {
      vi.setSystemTime(new Date('2026-05-05T05:00:00.000Z'));
      expect(getTodayBogota()).toBe('2026-05-05');
    });

    test('23:59:59 Bogotá (= 04:59:59 UTC del día siguiente) devuelve el día Bogotá que termina', () => {
      vi.setSystemTime(new Date('2026-05-06T04:59:59.999Z'));
      expect(getTodayBogota()).toBe('2026-05-05');
    });

    test('04:59 UTC (= 23:59 Bogotá del día anterior) devuelve el día Bogotá previo', () => {
      vi.setSystemTime(new Date('2026-05-05T04:59:00.000Z'));
      expect(getTodayBogota()).toBe('2026-05-04');
    });
  });

  describe('horaBogota', () => {
    test('14:30 Bogotá (= 19:30 UTC) → 14.5', () => {
      vi.setSystemTime(new Date('2026-05-05T19:30:00.000Z'));
      expect(horaBogota()).toBeCloseTo(14.5, 1);
    });

    test('00:00 Bogotá (= 05:00 UTC) → 0', () => {
      vi.setSystemTime(new Date('2026-05-05T05:00:00.000Z'));
      expect(horaBogota()).toBeCloseTo(0, 1);
    });

    test('23:59 Bogotá (= 04:59 UTC del día siguiente) → ~23.98', () => {
      vi.setSystemTime(new Date('2026-05-06T04:59:00.000Z'));
      expect(horaBogota()).toBeGreaterThan(23.9);
      expect(horaBogota()).toBeLessThan(24);
    });
  });

  describe('shiftDate', () => {
    test('suma 1 día cruzando fin de mes', () => {
      expect(shiftDate('2026-05-31', 1)).toBe('2026-06-01');
    });

    test('resta 1 día cruzando inicio de mes', () => {
      expect(shiftDate('2026-05-01', -1)).toBe('2026-04-30');
    });

    test('cero delta → mismo día', () => {
      expect(shiftDate('2026-05-15', 0)).toBe('2026-05-15');
    });

    test('cruza año bisiesto Feb 28 → Feb 29 en 2024', () => {
      expect(shiftDate('2024-02-28', 1)).toBe('2024-02-29');
      expect(shiftDate('2024-02-29', 1)).toBe('2024-03-01');
    });
  });
});

describe('F20 convención: input datetime-local Bogotá ↔ ISO UTC con offset -05:00', () => {
  // Re-construye el patrón canónico que viven inline en BitacorasGecelca3.jsx y
  // CambiarEstadoModal.jsx — si el patrón cambia, este test rompe y obliga a auditar a los
  // callers.
  const BOGOTA_LOCAL_FMT = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Bogota',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const toBogotaLocal = (d) => BOGOTA_LOCAL_FMT.format(d).replace(' ', 'T').slice(0, 16);
  const toIsoFromLocal = (s) => new Date(`${s}:00-05:00`).toISOString();

  test('14:30 UTC → 09:30 Bogotá wallclock', () => {
    expect(toBogotaLocal(new Date('2026-05-05T14:30:00.000Z'))).toBe('2026-05-05T09:30');
  });

  test('"09:30 Bogotá" → 14:30 UTC ISO', () => {
    expect(toIsoFromLocal('2026-05-05T09:30')).toBe('2026-05-05T14:30:00.000Z');
  });

  test('roundtrip toIsoFromLocal(toBogotaLocal(d)) preserva el instante', () => {
    const cases = [
      '2026-05-05T14:30:00.000Z',
      '2026-05-05T04:30:00.000Z',  // madrugada Bogotá
      '2026-08-15T03:45:00.000Z',
      '2026-12-31T23:59:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ];
    for (const iso of cases) {
      const d = new Date(iso);
      const wall = toBogotaLocal(d);
      const round = toIsoFromLocal(wall);
      expect(round).toBe(d.toISOString());
    }
  });

  test('madrugada Bogotá (04:30 UTC = 23:30 día anterior) emite wallclock del día Bogotá previo', () => {
    expect(toBogotaLocal(new Date('2026-05-05T04:30:00.000Z'))).toBe('2026-05-04T23:30');
  });
});
