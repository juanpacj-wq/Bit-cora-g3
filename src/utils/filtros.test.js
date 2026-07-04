// Regresión del default de filtros de la BarraEstado (bitácoras genéricas).
//
// Contrato bajo prueba: los filtros arrancan VACÍOS (mostrar todos los registros), no sembrados en
// "hoy". Antes el default era getTodayBogota(), que ocultaba los registros de otros días y no cuadraba
// con el badge del tab (que cuenta todos los borradores, día-agnóstico). Si alguien vuelve a poner un
// default no-vacío, `todosVacios` falla acá.
//
// El predicado de filtrado de GrillaRegistros vive inline en BitacorasGecelca3.jsx (componente no
// exportado). Igual que fecha.test.js con los helpers F20, lo re-construimos como CONTRATO y probamos
// que con FILTROS_VACIOS todos los registros pasan, y que al elegir un día solo pasa ese día. Si el
// predicado real cambia, este contrato debe alinearse.
import { describe, test, expect } from 'vitest';
import { FILTROS_VACIOS } from './filtros.js';

// Réplica fiel del predicado de fecha de GrillaRegistros: sin fecha → pasa todo; con fecha → solo el día.
// (El día del registro se compara ya normalizado a "YYYY-MM-DD" Bogotá, como hace toBogotaDate.)
const pasaFiltroFecha = (diaRegistro, filtroFecha) => (!filtroFecha ? true : diaRegistro === filtroFecha);
const pasaFiltroTurno = (turnoRegistro, filtroTurno) =>
  (filtroTurno ? String(turnoRegistro) === String(filtroTurno) : true);

const REGISTROS = [
  { dia: '2026-07-01', turno: 1 },
  { dia: '2026-07-02', turno: 2 },
  { dia: '2026-07-03', turno: 1 }, // "hoy" hipotético
];

describe('utils/filtros.js — default de filtros de la BarraEstado', () => {
  test('el default no tiene ningún filtro activo (todos los campos vacíos)', () => {
    expect(FILTROS_VACIOS).toEqual({ texto: '', tipo: '', fecha: '', turno: '' });
    // Ningún campo del default debe ser "verdadero" (todos short-circuitan a "mostrar todo").
    expect(Object.values(FILTROS_VACIOS).some(Boolean)).toBe(false);
  });

  test('el default es inmutable (Object.freeze) para que no se mute in situ', () => {
    expect(Object.isFrozen(FILTROS_VACIOS)).toBe(true);
  });

  test('con el default vacío, TODOS los registros pasan el filtro de fecha (no se oculta ningún día)', () => {
    const visibles = REGISTROS.filter((r) => pasaFiltroFecha(r.dia, FILTROS_VACIOS.fecha));
    expect(visibles).toHaveLength(REGISTROS.length);
  });

  test('con el default vacío, TODOS los registros pasan el filtro de turno', () => {
    const visibles = REGISTROS.filter((r) => pasaFiltroTurno(r.turno, FILTROS_VACIOS.turno));
    expect(visibles).toHaveLength(REGISTROS.length);
  });

  test('al elegir un día explícito, solo pasa ese día (el filtro sigue funcionando)', () => {
    const visibles = REGISTROS.filter((r) => pasaFiltroFecha(r.dia, '2026-07-01'));
    expect(visibles).toEqual([{ dia: '2026-07-01', turno: 1 }]);
  });
});
