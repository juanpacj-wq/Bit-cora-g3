// D-057 — Mapa de motivos de error de Operación 24h, compartido por la CAPTURA (la grilla) y la
// CORRECCIÓN (el modal de lote). Vivía inline en `SalaDeMandoGrid.jsx`; se sacó acá cuando el modal
// pasó a necesitar los mismos motivos, para que una redacción no se arregle en un lado y quede vieja
// en el otro.
//
// El front ramifica SIEMPRE por `motivo`/`codigo` (slug estable del backend), nunca por el texto
// (D-032). Estos textos son solo presentación.

export const MOTIVO_MSG = {
  fecha_no_es_hoy: 'La fecha no es hoy. Recarga la página.',
  tipo_invalido: 'Tipo de fila no reconocido',
  periodos_invalido: 'Lista de periodos inválida',
  periodo_fuera_rango: 'Periodo fuera de rango (1-24)',
  valor_mw_invalido: 'Valor numérico inválido',
  periodo_bloqueado: 'Periodo anterior al actual — solo se pueden registrar redespachos del periodo actual en adelante',
  funcionariocnd_requerido: 'Funcionario CND es requerido para Autorización',
  // D-056: la hora de la llamada al CND es atributo del LOTE (la fila entera), así que su error
  // viaja sin `periodo` y se pinta en la fila, no sobre una celda.
  hora_requerida: 'Indica la hora de la llamada al CND',
  hora_invalida: 'Hora inválida — usa el formato HH:mm dentro del día de hoy',
  hora_futura: 'La hora de la llamada no puede ser futura',
  // Reemplaza a `detalle_sin_celdas` (D-055): la metadata (hora, funcionario, comentario) nace
  // pegada a las celdas con valor de su lote. Sin ninguna celda no hay lote que registrar.
  lote_sin_celdas: 'Escribe al menos un valor en la fila para poder registrarla',
};

// El MISMO motivo del backend significa otra cosa al corregir: en la captura `periodo_bloqueado` es
// "no puedes registrar un redespacho pasado"; en la corrección es "no puedes tocar el valor de un
// periodo que ya pasó" (el lock actúa sobre el DELTA — cambiar, agregar o quitar; la hora y la
// descripción pasan siempre, D-057 decisión 3). Por eso hay dos redacciones y no una sola ambigua.
export const MOTIVO_MSG_CORRECCION = {
  ...MOTIVO_MSG,
  periodo_bloqueado: 'Periodo ya despachado: en un redespacho no puedes cambiar, agregar ni quitar el valor de un periodo anterior al actual. La hora y la descripción sí se pueden corregir.',
  periodo_duplicado: 'Ese periodo está repetido en el registro',
  hora_invalida: 'Hora inválida — usa el formato HH:mm dentro del día del registro',
  // Vaciar ≠ borrar (D-057 decisión 6): son dos caminos distintos y el copy tiene que decirlo.
  lote_sin_celdas: 'El registro quedó sin ningún periodo con valor. Si lo que quieres es darlo de baja, usa Eliminar.',
  // Estos tres llegan como `codigo` de un 409/404/403, no dentro de `errores[]`: el backend ya manda
  // su texto saneado. Quedan acá como respaldo por si alguna respuesta llega sin él.
  lote_cerrado: 'El día ya se cerró: este registro pasó al histórico y no se puede corregir.',
  lote_inexistente: 'El registro ya no existe. Actualiza el listado.',
  lote_de_otra_planta: 'El registro pertenece a otra unidad.',
};

// Un error del backend (`{ tipo, periodo?, motivo, mensaje? }`) llevado a texto. `mensaje` gana si
// viene: es el que el backend redactó para ESE caso puntual.
export function mensajeDeMotivo(err, mapa = MOTIVO_MSG) {
  return err?.mensaje || mapa[err?.motivo] || err?.motivo || 'Error desconocido';
}
