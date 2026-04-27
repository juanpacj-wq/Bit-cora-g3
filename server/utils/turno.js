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
