// D-051: lógica pura del filtro de AÑO del dashboard DISP, extraída de DisponibilidadDashboard
// para poder testearla sin montar el componente. La lista de años llega data-driven en la
// respuesta de GET /api/disponibilidad (`anios`), la misma que refresca el resto del dashboard.

// `ANIO_TODOS` = sin filtro (comportamiento histórico all-time).
export const ANIO_TODOS = 'todos';

// El año actual se calcula en Bogotá (UTC-5, sin DST).
export const ANIO_ACTUAL = Number(
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric' }).format(new Date())
);

// Construye las opciones del selector: "Todos los años" (all-time) primero y fijo arriba —
// con `sep` para dibujar un divisor debajo — seguido de la lista de años (desc). Va primero para
// que sea visible sin scrollear la lista larga de años.
export function buildAniosOpts(anios) {
  const lista = Array.isArray(anios) && anios.length ? anios : [ANIO_ACTUAL];
  return [
    { value: ANIO_TODOS, label: 'Todos los años', sep: true },
    ...lista.map((y) => ({ value: String(y), label: String(y) })),
  ];
}

// Ventana [desde, hasta) en UTC ISO correspondiente al año Bogotá seleccionado. `ANIO_TODOS`
// → sin ventana (undefined) para que el backend use su default all-time.
export function ventanaAnio(anio) {
  if (anio === ANIO_TODOS) return { desde: undefined, hasta: undefined };
  const y = Number(anio);
  return {
    desde: new Date(Date.UTC(y, 0, 1, 5, 0, 0)).toISOString(),      // 1-ene 00:00 Bogotá
    hasta: new Date(Date.UTC(y + 1, 0, 1, 5, 0, 0)).toISOString(),  // 1-ene (y+1) 00:00 Bogotá
  };
}

// Clamp del año seleccionado contra la lista vigente: si el año desapareció (p. ej. "Deshacer"
// eliminó el único registro del año más viejo y el rango se encogió), vuelve a "Todos" para no
// dejar el dashboard filtrando por un año fantasma que ya no está en el selector.
export function anioVigente(anio, anios) {
  if (anio === ANIO_TODOS) return anio;
  return Array.isArray(anios) && anios.some((y) => String(y) === anio) ? anio : ANIO_TODOS;
}
