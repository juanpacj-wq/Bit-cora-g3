// D-058 — Plantillas de los asientos de operación.
// Especificación literal: §5 de `docs/requerimientos/FORMATO-ASIENTOS-OPERACION.md`. Cada
// constante lleva encima la plantilla tal como está escrita en el documento, para que el diff
// contra el insumo sea obvio cuando alguien cambie una palabra.
//
// Devuelven la frase SIN punto final y SIN `detalle`: el cierre (punto siempre) y el `detalle`
// (al final, tras punto — decisión C) los aplica `index.js` en un solo lugar. Así ninguna
// plantilla puede olvidarse el punto ni duplicarlo.
//
// La HORA no va en ninguna plantilla: el `HH:MM` es la columna A de la hoja del F03 y una columna
// propia del listado del día. Los `16:38 — …` del insumo ilustran la FILA completa, no el texto.

// Se recibe llamada del CND ({funcionariocnd}) autorizando {unidad} a generar {carga}[. {detalle}]
//
// Sin verbo de sentido (decisión A): el original dice "a subir/bajar carga", pero el sistema NO
// sabe cuál de los dos es — conoce el valor autorizado, no el vigente contra el cual compararlo.
// Se escribe "a generar {X} MW", que es lo único cierto; el matiz va en el `detalle`.
//
// `funcionariocnd` es obligatorio en AUTH (D-018) y solo aparece acá (D-018 lo fuerza a NULL en
// PRUEBA y REDESP). Si llegara vacío NO se inventa texto: se omite el paréntesis. Validar es
// tarea del endpoint, que ya lo rechaza antes; el motor no es el lugar.
export const PLANTILLA_AUTH = ({ unidad, funcionariocnd, carga }) =>
  `Se recibe llamada del CND${funcionariocnd ? ` (${funcionariocnd})` : ''}`
  + ` autorizando ${unidad}${carga ? ` a generar ${carga}` : ''}`;

// Se recibe del CND redespacho para {unidad}: {carga}[. {detalle}]
export const PLANTILLA_REDESP = ({ unidad, carga }) =>
  `Se recibe del CND redespacho para ${unidad}${carga ? `: ${carga}` : ''}`;

// Se declara prueba de {unidad} a {carga}[. {detalle}]
//
// Redacción neutra, sin suponer que la origina el CND (decisión G): es coherente con D-018, que
// fuerza `funcionariocnd = NULL` en PRUEBA — si la autorizara el CND habría que registrar quién.
// Sin evidencia en las 342 filas del F03 de enero: es propuesta validada, no observación.
export const PLANTILLA_PRUEBA = ({ unidad, carga }) =>
  `Se declara prueba de ${unidad}${carga ? ` a ${carga}` : ''}`;

// Disponibilidad — los cuatro estados de `bitacora.disponibilidad_estado` (D-026). No hay MW.
// Se conserva la jerga real del formato: E/L (en línea) y F/L (fuera de línea), que aparecen en
// casi todas las filas de estado del F03.
//
// Las claves son los valores EXACTOS del CHECK de la columna `estado`: si alguna se renombrara en
// la BD, el motor tiene que enterarse acá y no en silencio.
export const PLANTILLA_DISP = {
  'En Servicio': (unidad) => `${unidad} E/L en servicio`,
  'En Reserva': (unidad) => `${unidad} disponible en reserva, sin generar`,
  'Indisponible': (unidad) => `${unidad} F/L indisponible`,
  'Mantenimiento': (unidad) => `${unidad} F/L en mantenimiento programado`,
};

// Operación 24h — el discriminador es `tipo_evento.notificar_dashboard_tipo`, acotado por CHECK a
// estos tres valores.
export const PLANTILLA_LOTE = {
  AUTH: PLANTILLA_AUTH,
  REDESP: PLANTILLA_REDESP,
  PRUEBA: PLANTILLA_PRUEBA,
};

// Bitácoras de Sala (SALAJDT / SALAING): NO hay plantilla. El texto pasa literal — ver
// `asientoLiteralSala` en `index.js`.
