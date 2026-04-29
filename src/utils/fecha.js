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
