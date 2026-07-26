// D-058 — Motor de asientos de operación. FUENTE ÚNICA del texto normalizado.
//
// Módulo PURO: sin BD, sin reloj, sin red. Entra un evento plano, sale su asiento en texto.
// Tres consumidores comparten esta salida y por eso no puede vivir en ninguno de ellos:
//   1. el renglón del listado del día de Operación 24h (REQ-04 §8.1, con su acción de copiar),
//   2. la copia que se refleja a las bitácoras de Sala al registrar/corregir/borrar (REQ-02),
//   3. la columna DESCRIPCIÓN del libro mensual F03 (REQ-06).
// Si el texto se armara en cada uno, las tres salidas divergirían — y divergir es justo el
// problema que el F03 real documenta (§3 del insumo).
//
// Reglas transversales que este módulo garantiza:
// - **La hora NO va en el texto.** El `HH:MM` es columna de la hoja y del listado, nunca parte de
//   la frase. Los `16:38 — …` del insumo ilustran la fila completa, no la plantilla.
// - **`detalle` ausente es lo NORMAL** (D-056): la frase termina en el dato duro. Ni rótulo
//   huérfano, ni `undefined`, ni doble punto. Cuando está, va al final tras punto (decisión C).
// - **Punto final siempre** en lo generado. La excepción es el texto literal de Sala: agregarle un
//   punto sería normalizarlo, y Sala pasa tal cual.
import { unidadCanonica, carga, UNIDAD_YA_NOMBRADA } from './formato.js';
import { PLANTILLA_LOTE, PLANTILLA_DISP } from './plantillas.js';

export { unidadCanonica, potenciaMW, listaPeriodos, carga, UNIDAD_YA_NOMBRADA } from './formato.js';

// Operación 24h (MAND). `tipo ∈ 'AUTH' | 'REDESP' | 'PRUEBA'` — el valor de
// `tipo_evento.notificar_dashboard_tipo`. `periodos = [{ periodo, valor_mw }]`, la forma en que
// `GET /api/sala-de-mando/lotes` ya agrupa el lote (D-056).
//
// El asiento es del LOTE entero, no de la celda: un lote es una sola llamada del CND y se narra
// una sola vez, con sus periodos compactados.
export function asientoLote({ tipo, planta_id, periodos, funcionariocnd, detalle } = {}) {
  const plantilla = PLANTILLA_LOTE[String(tipo ?? '').trim().toUpperCase()];
  // Lanza en vez de devolver vacío: `tipo` viene de una columna con CHECK, así que un valor
  // desconocido es un bug del llamador, no un dato del operador. Fallar acá es barato; publicar
  // un renglón en blanco en el histórico o en el F03 no lo es.
  if (!plantilla) throw new TypeError(`asientoLote: tipo de evento desconocido (${tipo})`);
  return frase(plantilla({
    unidad: unidadCanonica(planta_id),
    funcionariocnd: String(funcionariocnd ?? '').trim(),
    carga: carga(periodos),
  }), detalle);
}

// Disponibilidad (DISP). `evento` es el valor de `disponibilidad_estado.estado`, acotado por CHECK
// a los cuatro estados. No hay MW ni periodos: el estado se asienta una vez, en su instante de
// inicio.
export function asientoDisponibilidad({ planta_id, evento, detalle } = {}) {
  const plantilla = PLANTILLA_DISP[String(evento ?? '').trim()];
  if (!plantilla) throw new TypeError(`asientoDisponibilidad: estado desconocido (${evento})`);
  return frase(plantilla(unidadCanonica(planta_id)), detalle);
}

// Bitácoras de Sala (SALAJDT / SALAING): SIN plantilla, SIN normalización, SIN corrección
// ortográfica. Son los eventos propios del turno y su valor está en el detalle que solo esa
// persona puede describir (decisión D). Lo único que se agrega es el prefijo de unidad — y solo
// si el texto no la nombra ya (decisión I).
//
// La unidad sale de `registro_activo.planta_id`, la de la sesión que escribió: dice de qué unidad
// ES el asiento, no de qué habla el texto. Por eso no puede ser una columna del F03 — hay
// renglones que hablan de las dos unidades a la vez.
//
// Guion largo `—` con espacios a ambos lados, NUNCA `-`: el corto ya separa nombres de ingenieros
// (`Jose Saavedra - Luis Zapata`) en el encabezado de cada bloque de turno.
export function asientoLiteralSala({ planta_id, texto } = {}) {
  const cuerpo = String(texto ?? '').trim();
  if (!cuerpo) return '';
  if (UNIDAD_YA_NOMBRADA.test(cuerpo)) return cuerpo;
  const unidad = unidadCanonica(planta_id);
  return unidad ? `${unidad} — ${cuerpo}` : cuerpo;
}

const TERMINA_EN_PUNTUACION = /[.!?…]$/;

// Cierra la frase generada y le engancha el `detalle` del operador. Único lugar donde se decide la
// puntuación, para que ninguna plantilla la olvide ni la duplique.
//
// El `detalle` se aplana a una línea (`\s+` → espacio) porque el asiento ES un renglón: una celda
// del F03, una fila del listado, una línea del mensaje. No se corrige ni se reescribe su
// contenido; solo se colapsa el espacio en blanco.
function frase(base, detalle) {
  const cuerpo = String(base ?? '').trim();
  if (!cuerpo) return '';
  const principal = TERMINA_EN_PUNTUACION.test(cuerpo) ? cuerpo : `${cuerpo}.`;
  const extra = String(detalle ?? '').replace(/\s+/g, ' ').trim();
  if (!extra) return principal;
  return `${principal} ${TERMINA_EN_PUNTUACION.test(extra) ? extra : `${extra}.`}`;
}
