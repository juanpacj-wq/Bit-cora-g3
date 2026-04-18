export function getTurnoColombia() {
  const nowUtc = new Date();
  const colombiaHour = (nowUtc.getUTCHours() + 24 - 5) % 24;
  return colombiaHour < 12 ? 1 : 2;
}

export function periodoFromFechaBogota(fecha) {
  const d = fecha instanceof Date ? fecha : new Date(fecha);
  const horaBogota = (d.getUTCHours() + 24 - 5) % 24;
  return horaBogota + 1;
}
