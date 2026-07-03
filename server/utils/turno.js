const COLOMBIA_OFFSET_HOURS = 5;

function colombiaParts(fecha) {
  const ref = fecha instanceof Date ? fecha : new Date(fecha);
  const shifted = new Date(ref.getTime() - COLOMBIA_OFFSET_HOURS * 3600 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
  };
}

function colombiaHourToUtcDate(year, month, day, hour) {
  return new Date(Date.UTC(year, month, day, hour + COLOMBIA_OFFSET_HOURS));
}

export function getTurnoColombia() {
  const { hour } = colombiaParts(new Date());
  return hour >= 6 && hour < 18 ? 1 : 2;
}

export function periodoFromFechaBogota(fecha) {
  const d = fecha instanceof Date ? fecha : new Date(fecha);
  const horaBogota = (d.getUTCHours() + 24 - COLOMBIA_OFFSET_HOURS) % 24;
  return horaBogota + 1;
}

export function turnoFromPeriodo(periodo) {
  return periodo >= 7 && periodo <= 18 ? 1 : 2;
}

export function ventanaTurno(turno, fechaRef) {
  const { year, month, day, hour } = colombiaParts(fechaRef);

  if (turno === 1) {
    return {
      inicio: colombiaHourToUtcDate(year, month, day, 6),
      fin: colombiaHourToUtcDate(year, month, day, 18),
    };
  }

  // turno=2 (nocturno) cruza medianoche: [18:00 Col día N, 06:00 Col día N+1).
  // Si fechaRef cae antes de las 06:00 Colombia, la ventana arrancó AYER 18:00.
  if (hour < 6) {
    return {
      inicio: colombiaHourToUtcDate(year, month, day - 1, 18),
      fin: colombiaHourToUtcDate(year, month, day, 6),
    };
  }
  return {
    inicio: colombiaHourToUtcDate(year, month, day, 18),
    fin: colombiaHourToUtcDate(year, month, day + 1, 6),
  };
}

// D-040 (persistencia por ventana de turno): turno (1/2) de la ventana que CONTIENE fechaRef,
// derivado de la hora Bogotá. Igual criterio que getTurnoColombia() pero para un instante dado.
function turnoDe(fechaRef) {
  const { hour } = colombiaParts(fechaRef);
  return hour >= 6 && hour < 18 ? 1 : 2;
}

// Ventana [inicio, fin) del turno que contiene fechaRef (default: ahora). Compone turnoDe +
// ventanaTurno, así el llamador no reimplementa el cruce de medianoche de T2.
export function ventanaActual(fechaRef = new Date()) {
  return ventanaTurno(turnoDe(fechaRef), fechaRef);
}

// ¿Una finalización de turno (instante UTC `finalizadoEn`) sigue VIGENTE respecto a `ahora`?
// Vigente = cae dentro de la ventana [inicio, fin) del turno actual. Fuente única de verdad de la
// persistencia D-040: una finalización se mantiene mientras dure su turno y expira sola cuando
// arranca el siguiente. Pura y testeable con inputs fijos. NULL/vacío → false (turno vivo).
export function finalizacionVigente(finalizadoEn, ahora = new Date()) {
  if (!finalizadoEn) return false;
  const t = new Date(finalizadoEn).getTime();
  if (Number.isNaN(t)) return false;
  const { inicio, fin } = ventanaActual(ahora);
  return t >= inicio.getTime() && t < fin.getTime();
}

// F19: serializadores de fecha en wallclock Bogotá. Usan el offset puro -5h (Colombia sin
// DST) y leen con getUTC*() después del shift — mismo patrón canónico que colombiaParts.
// Centralizados acá para que ciet.js, mand-sweeper.js y futuros callers no reinventen el
// shift al persistir campos JSON con semántica de fecha operativa.
export function fechaBogotaStr(input) {
  const d = input instanceof Date ? input : new Date(input);
  const col = new Date(d.getTime() - COLOMBIA_OFFSET_HOURS * 3600 * 1000);
  const Y = col.getUTCFullYear();
  const M = String(col.getUTCMonth() + 1).padStart(2, '0');
  const D = String(col.getUTCDate()).padStart(2, '0');
  return `${Y}-${M}-${D}`;
}

export function fechaBogotaIso(input) {
  const d = input instanceof Date ? input : new Date(input);
  const col = new Date(d.getTime() - COLOMBIA_OFFSET_HOURS * 3600 * 1000);
  const Y = col.getUTCFullYear();
  const M = String(col.getUTCMonth() + 1).padStart(2, '0');
  const D = String(col.getUTCDate()).padStart(2, '0');
  const h = String(col.getUTCHours()).padStart(2, '0');
  const m = String(col.getUTCMinutes()).padStart(2, '0');
  const s = String(col.getUTCSeconds()).padStart(2, '0');
  return `${Y}-${M}-${D}T${h}:${m}:${s}-05:00`;
}
