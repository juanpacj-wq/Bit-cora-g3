// Verificación de la validación "La hora no coincide con el turno" (bitácoras genéricas).
//
// La misma regla se aplica en dos lugares y DEBEN concordar:
//  - Front (BitacorasGecelca3.jsx): `turnoFromFechaLocal` → `turnoFromHora(hora)`
//  - Back  (routes/registros.js):   `turnoFromPeriodo(periodoFromFechaBogota(fecha))`
// Canónico: T1 = horas [06,17] Bogotá; T2 = [18,23] ∪ [00,05].
//
// Este test importa el util REAL del backend y reproduce la regla del front, y comprueba:
//  1) ambas reglas devuelven el mismo turno para las 24 horas del día,
//  2) el caso exacto del reporte (09:37 con Turno 2) se marca como incoherente,
//  3) las combinaciones coherentes pasan.
import { describe, it, expect } from 'vitest';
import { turnoFromPeriodo, periodoFromFechaBogota } from '../../server/utils/turno.js';

// --- Regla del front (copiada 1:1 de BitacorasGecelca3.jsx para probar equivalencia) ---
const turnoFromHora = (hora) => (hora >= 6 && hora < 18 ? 1 : 2);
const turnoFromFechaLocal = (fechaLocal) => turnoFromHora(parseInt(fechaLocal.slice(11, 13), 10));

// Turno esperado del backend a partir de una fecha ISO con offset Bogotá (-05:00).
const turnoBackend = (isoBogota) => turnoFromPeriodo(periodoFromFechaBogota(new Date(isoBogota)));

// Predicado de validación tal como lo usan front y back: turno del usuario ≠ turno de la hora.
const horaNoCoincide = (turnoUsuario, hora) => Number(turnoUsuario) !== turnoFromHora(hora);

describe('validación turno vs hora', () => {
  it('front y back derivan el MISMO turno para las 24 horas Bogotá', () => {
    for (let h = 0; h < 24; h++) {
      const hh = String(h).padStart(2, '0');
      const front = turnoFromFechaLocal(`2026-07-03T${hh}:30`);
      const back = turnoBackend(`2026-07-03T${hh}:30:00-05:00`);
      expect(back, `hora ${hh}`).toBe(front);
    }
  });

  it('caso del reporte: 09:37 con Turno 2 es incoherente (se bloquea)', () => {
    const fechaLocal = '2026-07-03T09:37';
    // El registro tenía turno=2 pero la hora (09) pertenece a T1.
    expect(turnoFromFechaLocal(fechaLocal)).toBe(1);
    expect(horaNoCoincide(2, 9)).toBe(true);   // bloqueado ✓
    expect(horaNoCoincide(1, 9)).toBe(false);  // corregido a T1 ✓ pasa
  });

  it('bordes de turno: 06→T1, 17→T1, 18→T2, 05→T2', () => {
    expect(turnoFromHora(6)).toBe(1);
    expect(turnoFromHora(17)).toBe(1);
    expect(turnoFromHora(18)).toBe(2);
    expect(turnoFromHora(5)).toBe(2);
    // combinaciones coherentes no se bloquean
    expect(horaNoCoincide(1, 6)).toBe(false);
    expect(horaNoCoincide(1, 17)).toBe(false);
    expect(horaNoCoincide(2, 18)).toBe(false);
    expect(horaNoCoincide(2, 3)).toBe(false);
    // combinaciones incoherentes se bloquean
    expect(horaNoCoincide(2, 6)).toBe(true);
    expect(horaNoCoincide(1, 18)).toBe(true);
    expect(horaNoCoincide(1, 0)).toBe(true);
  });
});
