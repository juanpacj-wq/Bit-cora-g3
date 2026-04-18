export function getTurnoColombia() {
  const nowUtc = new Date();
  const colombiaHour = (nowUtc.getUTCHours() + 24 - 5) % 24;
  return colombiaHour < 12 ? 1 : 2;
}
