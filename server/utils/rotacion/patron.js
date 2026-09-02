// D-065 · Motor del patrón de rotación de turnos. Dado el patrón anual de un rol (dos vectores de
// 8 días —uno por turno—, la fecha en que arranca el periodo y el desfase), dice QUÉ GRUPO de
// guardia le correspondía a una fecha y un turno. La app ya sabe quién estuvo; esto dice quién
// debía estar.
//
// PURO a propósito: sin BD, sin red, sin `new Date()` implícito. Todo entra por parámetro y la
// misma entrada da siempre la misma salida — por eso el oráculo del Excel (365 días × 2 mallas)
// se verifica entero en un test sin levantar nada.
//
// REGLA DE LAS FECHAS: viajan siempre como string 'YYYY-MM-DD' en DÍA BOGOTÁ. Ninguna función de
// este módulo acepta ni devuelve un `Date`, y las cuentas salen de `Date.UTC(y, m - 1, d)` sobre
// los tres enteros del string. Nunca `new Date(str)`, `getDate()` ni `getTimezoneOffset()`.

export const LARGO_CICLO = 8;

const GRUPO_MIN = 1;
const GRUPO_MAX = 4;
const MS_POR_DIA = 24 * 60 * 60 * 1000;
const RE_FECHA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_GRUPO = /^[1-4]$/;

// 'YYYY-MM-DD' → medianoche UTC de ese día, como entero de ms. UTC es acá un simple sistema de
// coordenadas para contar días de calendario: los dos extremos de una resta se desplazan igual, así
// que el offset se cancela y el resultado es el mismo que contar días Bogotá con los dedos.
//
// Se parsea a mano y se reconstruye con `Date.UTC` en vez de `new Date(fechaIso)` aunque hoy den lo
// mismo: `new Date` sólo asume medianoche UTC mientras el string sea exactamente una fecha pelada.
// El día que a alguien se le cuele un 'YYYY-MM-DDTHH:mm' o un `Date` de hora local, esa versión se
// rompe en silencio — que es justo el bug de D-055 (el registro 4722, fechado por el día de la
// grilla en vez de por el turno al que pertenecía). Acá un string que no sea una fecha pelada y
// real lanza `fecha_invalida` en vez de devolver un número equivocado.
function msDelDiaIso(fechaIso) {
  const m = RE_FECHA_ISO.exec(String(fechaIso ?? ''));
  if (!m) throw new Error('fecha_invalida');
  const anio = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  const ms = Date.UTC(anio, mes - 1, dia);
  // '2026-02-30' pasa la regex pero no existe: Date.UTC lo desborda al 2 de marzo. Si el viaje de
  // ida y vuelta no devuelve los mismos tres enteros, la fecha era inventada.
  const control = new Date(ms);
  if (
    control.getUTCFullYear() !== anio ||
    control.getUTCMonth() !== mes - 1 ||
    control.getUTCDate() !== dia
  ) {
    throw new Error('fecha_invalida');
  }
  return ms;
}

function esGrupo(valor) {
  return Number.isInteger(valor) && valor >= GRUPO_MIN && valor <= GRUPO_MAX;
}

function validarVector(vector) {
  if (!Array.isArray(vector) || vector.length !== LARGO_CICLO || !vector.every(esGrupo)) {
    throw new Error('vector_invalido');
  }
  return vector;
}

/**
 * '1,1,3,3,4,4,2,2' → [1,1,3,3,4,4,2,2].
 * Lanza Error('vector_invalido') si no son exactamente 8 enteros en 1..4.
 * Tolera espacios alrededor de cada número; no tolera ceros a la izquierda ni decimales, para que
 * el viaje de ida y vuelta con `serializarVector` sea exacto.
 */
export function parsearVector(texto) {
  if (typeof texto !== 'string') throw new Error('vector_invalido');
  const partes = texto.split(',');
  if (partes.length !== LARGO_CICLO) throw new Error('vector_invalido');
  return partes.map((parte) => {
    const limpio = parte.trim();
    if (!RE_GRUPO.test(limpio)) throw new Error('vector_invalido');
    return Number(limpio);
  });
}

/** [1,1,3,3,4,4,2,2] → '1,1,3,3,4,4,2,2'. */
export function serializarVector(vector) {
  return validarVector(vector).join(',');
}

/**
 * Único i en 0..7 con vectorT1[i] === grupoT1 && vectorT2[i] === grupoT2.
 * 0 soluciones → Error('desfase_imposible'); más de una → Error('desfase_ambiguo').
 *
 * Por qué hacen falta LOS DOS grupos: en las mallas reales los 8 pares (V1[i], V2[i]) son todos
 * distintos, pero V1 por sí solo toma apenas 4 valores en 8 índices. Preguntarle al administrador
 * únicamente "qué grupo arranca en el turno de día" deja siempre dos desfases posibles, así que el
 * motor prefiere gritar `desfase_ambiguo` antes que elegir uno de los dos a la suerte.
 */
export function derivarDesfase({ vectorT1, vectorT2, grupoT1, grupoT2 } = {}) {
  validarVector(vectorT1);
  validarVector(vectorT2);

  const soluciones = [];
  for (let i = 0; i < LARGO_CICLO; i += 1) {
    if (vectorT1[i] === grupoT1 && vectorT2[i] === grupoT2) soluciones.push(i);
  }

  if (soluciones.length === 0) throw new Error('desfase_imposible');
  if (soluciones.length > 1) throw new Error('desfase_ambiguo');
  return soluciones[0];
}

/**
 * Días calendario Bogotá entre dos 'YYYY-MM-DD'. Negativo si la segunda es anterior a la primera.
 * Sin `Date` local en ningún punto.
 */
export function diasEntre(fechaIsoA, fechaIsoB) {
  const a = msDelDiaIso(fechaIsoA);
  const b = msDelDiaIso(fechaIsoB);
  // La diferencia entre dos medianoches UTC es un múltiplo exacto de un día (UTC no tiene DST); el
  // redondeo sólo deja explícito que el resultado es un entero de días.
  return Math.round((b - a) / MS_POR_DIA);
}

function validarPatron(patron) {
  if (!patron || typeof patron !== 'object') throw new Error('patron_invalido');
  if (!Number.isInteger(patron.desfase)) throw new Error('patron_invalido');
  return patron;
}

/**
 * Índice 0..7 dentro del ciclo de 8 días que le corresponde a `fechaOperativaIso`.
 * El módulo se normaliza a positivo, así que una fecha ANTERIOR a `patron.fecha_inicio` devuelve un
 * índice válido (p.ej. 5) y no un -3: consultar el patrón hacia atrás es legítimo y el ciclo no
 * tiene principio.
 */
export function diaDelCiclo(patron, fechaOperativaIso) {
  validarPatron(patron);
  const corridos = diasEntre(patron.fecha_inicio, fechaOperativaIso) + patron.desfase;
  return ((corridos % LARGO_CICLO) + LARGO_CICLO) % LARGO_CICLO;
}

/**
 * Grupo de guardia (1..4) de una fecha y un turno.
 * `turno` es 1 (06:00–18:00) o 2 (18:00–06:00); cualquier otro valor lanza Error('turno_invalido').
 * `patron` = { fecha_inicio, vector_t1, vector_t2, desfase }, con los vectores ya como arreglos.
 */
export function grupoDeTurno(patron, fechaOperativaIso, turno) {
  if (turno !== 1 && turno !== 2) throw new Error('turno_invalido');
  validarPatron(patron);
  const vector = validarVector(turno === 1 ? patron.vector_t1 : patron.vector_t2);
  return vector[diaDelCiclo(patron, fechaOperativaIso)];
}

/**
 * Desfase con el que hay que arrancar el periodo que empieza en `fechaInicioSiguienteIso` para que
 * la rotación siga de largo — "el año que entra arranca donde terminó el anterior".
 *
 * Es exactamente el día del ciclo que le tocaba a esa fecha bajo el patrón viejo: el periodo nuevo
 * cuenta sus días desde cero, así que su desfase tiene que traer puesto el punto del ciclo en el
 * que quedó el anterior. Encadenar dos periodos así reproduce la misma secuencia que uno solo, sin
 * salto ni día repetido en la costura.
 */
export function desfaseDeContinuidad(patron, fechaInicioSiguienteIso) {
  return diaDelCiclo(patron, fechaInicioSiguienteIso);
}
