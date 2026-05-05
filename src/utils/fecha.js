// Derivado en zona Bogotá para alinearse con `getTurnoColombia()` del backend (F1/F10).
// Sin esto, un usuario en otra TZ vería desfasado el cambio de día.
export function getTodayBogota() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
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
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const h = parseInt(parts.find((p) => p.type === 'hour').value, 10);
  const m = parseInt(parts.find((p) => p.type === 'minute').value, 10);
  // 'en-US' con hour12:false suele devolver '24' a medianoche en Node viejo; normalizar.
  const hh = h === 24 ? 0 : h;
  return hh + m / 60;
}
