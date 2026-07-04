// Estado inicial de los filtros de la BarraEstado (bitácoras genéricas — no MAND/DISP/COMB, que
// tienen UI propia). TODOS vacíos = "mostrar TODOS los registros activos", sin pre-filtro por día,
// turno, texto ni tipo.
//
// Es la fuente ÚNICA de verdad para las tres rutas que reinician los filtros:
//   (a) el estado inicial en <App>,
//   (b) el reset al cambiar de bitácora,
//   (c) el botón "Borrar filtros".
// Que las tres usen esta constante evita que el default vuelva a divergir a "hoy": antes (a) y (b)
// sembraban getTodayBogota() mientras (c) vaciaba a '', así que la grilla arrancaba oculta a hoy y
// no cuadraba con el badge del tab (que SIEMPRE cuenta los borradores del día-agnóstico). Un default
// vacío alinea grilla y badge y deja al usuario elegir el día explícitamente.
//
// Nota sobre `fecha`: en la BarraEstado la fecha hace doble función — filtra la lista Y determina el
// día en que "Nuevo Registro" crea el borrador. Con `fecha:''` (sin día elegido) el borrador cae en
// HOY (Bogotá); ver handleAddRegistro. Elegir un día explícito reactiva ambos comportamientos.
export const FILTROS_VACIOS = Object.freeze({ texto: '', tipo: '', fecha: '', turno: '' });
