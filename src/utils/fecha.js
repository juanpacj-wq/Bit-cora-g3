// Derivado en zona Bogotá para alinearse con `getTurnoColombia()` del backend (F1/F10).
// Sin esto, un usuario en otra TZ vería desfasado el cambio de día.
export function getTodayBogota() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

// D-058 (REQ-06): mes en curso en Bogotá, `YYYY-MM`. Se deriva del MISMO día Bogotá que usa el
// resto de la app — nunca de `new Date().getMonth()`, que el 1° a las 00:30 Bogotá (05:30 UTC)
// devolvería el mes anterior o el siguiente según dónde esté el navegador. Es el valor por defecto
// del selector del libro mensual y también su tope: el futuro no se puede pedir.
export function getCurrentMonthBogota() {
  return getTodayBogota().slice(0, 7);
}

export function shiftDate(yyyymmdd, deltaDays) {
  if (!yyyymmdd) return yyyymmdd;
  const d = new Date(`${yyyymmdd}T12:00:00`);
  d.setDate(d.getDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// F17: hora del día Bogotá como float (ej. 14.5 = 14:30). Usado por SalaDeMandoGrid para
// derivar `periodo_actual = floor(horaBogota()) + 1` y aplicar el lock visual REDESP.
export function horaBogota() {
  const { hh, mm } = partesHoraBogota(new Date());
  return hh + mm / 60;
}

// D-056: 'HH:mm' Bogotá de un instante dado. La grilla de Operación 24h precarga con esto el campo
// "hora de la llamada" (`<input type="time">`), y el listado del día muestra así la `hora_llamada`
// que viaja en ISO UTC. Siempre con `timeZone` explícito (D-020) — nunca `getHours()` a secas.
export function horaBogotaHHMM(fecha = new Date()) {
  const d = fecha instanceof Date ? fecha : new Date(fecha);
  if (Number.isNaN(d.getTime())) return null;
  const { hh, mm } = partesHoraBogota(d);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function partesHoraBogota(d) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const h = parseInt(parts.find((p) => p.type === 'hour').value, 10);
  const m = parseInt(parts.find((p) => p.type === 'minute').value, 10);
  // 'en-US' con hour12:false suele devolver '24' a medianoche en Node viejo; normalizar.
  return { hh: h === 24 ? 0 : h, mm: m };
}
