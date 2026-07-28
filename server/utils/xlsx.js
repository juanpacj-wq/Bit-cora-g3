// D-058 — ZIP mínimo para leer y emitir paquetes OOXML (.xlsx), sin dependencias.
//
// Port ESM del escritor de `js-scraper-carbon-g32/xlsx-write.js` (CommonJS, mono-hoja, solo
// escribe), con dos cambios: se le suma un LECTOR y `escribirZip` devuelve `Buffer` en vez de
// escribir a disco. El original NO se toca: es otro proyecto y sigue como está.
//
// Por qué escrito a mano y no `exceljs`/`xlsx`: REQ-01 §5.1 ya lo decidió — el backend tiene seis
// dependencias y así se queda. Todo lo que hace falta sale de `node:zlib` (nativo).
//
// El lector soporta STORED y DEFLATE (un `.xlsx` que sale de Excel viene deflate). El escritor
// **emite DEFLATE**, igual que Excel y que cualquier otra herramienta: ver la nota de `escribirZip`
// sobre por qué se abandonó el `stored` original. Todo sale de `node:zlib`, que es nativo.
//
// Alcance deliberado: sin ZIP64, sin cifrado, sin data descriptors leídos del stream (los tamaños
// salen del central directory, que siempre los trae). Un `.xlsx` de Excel de este tamaño nunca
// necesita nada de eso; si algún día lo necesitara, `leerZip` lanza en vez de devolver basura.

import { inflateRawSync, deflateRawSync } from 'node:zlib';

const FIRMA_LOCAL = 0x04034b50;
const FIRMA_CENTRAL = 0x02014b50;
const FIRMA_EOCD = 0x06054b50;

// El EOCD puede llevar un comentario de hasta 64 KB detrás, así que se busca hacia atrás.
const MAX_COMENTARIO_EOCD = 0xffff;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Devuelve `Map<nombre, Buffer>` con el contenido YA descomprimido de cada entrada.
//
// Se recorre el CENTRAL DIRECTORY, no los local headers en secuencia: es la única lectura correcta
// (los locales pueden traer los tamaños en cero y diferirlos a un data descriptor cuando el
// productor iba en streaming) y además es la que respeta el orden declarado del paquete.
//
// El `Map` preserva el orden de inserción, y eso importa: `[Content_Types].xml` tiene que ir
// primero en el paquete que se re-emite para que Excel lo abra sin quejarse.
export function leerZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const eocd = buscarEOCD(buf);
  if (eocd < 0) throw new Error('ZIP inválido: no se encontró el End Of Central Directory');

  const totalEntradas = buf.readUInt16LE(eocd + 10);
  const inicioCentral = buf.readUInt32LE(eocd + 16);
  if (totalEntradas === 0xffff || inicioCentral === 0xffffffff) {
    throw new Error('ZIP64 no soportado: el paquete excede los límites del EOCD clásico');
  }

  const entradas = new Map();
  let p = inicioCentral;
  for (let i = 0; i < totalEntradas; i++) {
    if (buf.readUInt32LE(p) !== FIRMA_CENTRAL) {
      throw new Error(`ZIP inválido: cabecera central corrupta en la entrada ${i}`);
    }
    const metodo = buf.readUInt16LE(p + 10);
    const tamComprimido = buf.readUInt32LE(p + 20);
    const tamCrudo = buf.readUInt32LE(p + 24);
    const largoNombre = buf.readUInt16LE(p + 28);
    const largoExtra = buf.readUInt16LE(p + 30);
    const largoComentario = buf.readUInt16LE(p + 32);
    const offsetLocal = buf.readUInt32LE(p + 42);
    const nombre = buf.toString('utf8', p + 46, p + 46 + largoNombre);

    if (buf.readUInt32LE(offsetLocal) !== FIRMA_LOCAL) {
      throw new Error(`ZIP inválido: cabecera local corrupta en "${nombre}"`);
    }
    // El `extra` del local header NO tiene por qué coincidir con el del central: hay que leer el
    // suyo. Confundirlos desalinea el arranque del dato y produce basura silenciosa.
    const largoNombreLocal = buf.readUInt16LE(offsetLocal + 26);
    const largoExtraLocal = buf.readUInt16LE(offsetLocal + 28);
    const inicioDato = offsetLocal + 30 + largoNombreLocal + largoExtraLocal;
    const crudo = buf.subarray(inicioDato, inicioDato + tamComprimido);

    let datos;
    if (metodo === 0) datos = Buffer.from(crudo);
    else if (metodo === 8) datos = inflateRawSync(crudo);
    else throw new Error(`Método de compresión ${metodo} no soportado en "${nombre}"`);

    if (datos.length !== tamCrudo) {
      throw new Error(`ZIP inválido: "${nombre}" descomprimió ${datos.length} bytes, se esperaban ${tamCrudo}`);
    }
    entradas.set(nombre, datos);
    p += 46 + largoNombre + largoExtra + largoComentario;
  }
  return entradas;
}

// `entradas`: `[{ name, data: Buffer }]` **o** un `Map<nombre, Buffer>` (lo que devuelve `leerZip`,
// para poder re-emitir un paquete leído sin traducirlo).
//
// **Emite DEFLATE** (con `stored` como respaldo por entrada cuando comprimir no achica: PNG, ya
// comprimido). El escritor original —heredado de `js-scraper-carbon-g32`— emitía TODO `stored`, que
// es ZIP válido y que Excel abre; se cambió igual, por dos razones que pesan más que la simetría con
// el original:
//   1. **Ningún `.xlsx` del mundo real viene sin comprimir.** Un paquete OOXML `stored` es una forma
//      legal pero exótica, y en el camino de una descarga corporativa hay antivirus, DLP y proxies
//      que inspeccionan el archivo: cuanto más se parezca a lo que produce Excel, menos superficie
//      hay para que algo en ese camino lo rechace o lo reescriba.
//   2. **Pesa 2,5× menos** (el libro de un mes pasa de ~550 KB a ~215 KB). Es tráfico que viaja por
//      la red de planta en cada descarga.
// El costo es nulo: `deflateRawSync` es de `node:zlib`, nativo — **sigue sin dependencias nuevas**,
// que es lo que REQ-01 §5.1 protege. El CRC32 se calcula SIEMPRE sobre el dato crudo (lo que exige
// el formato), y `leerZip` ya soportaba el método 8 desde el primer día.
//
// A diferencia del original, NO escribe a disco — devuelve el `Buffer`. Por eso tampoco lleva el
// `assertWithinDir` de AUD-28: acá no hay ruta que validar. El script offline sí escribe, y ahí sí
// valida la suya.
export function escribirZip(entradas) {
  const lista = entradas instanceof Map
    ? [...entradas].map(([name, data]) => ({ name, data }))
    : entradas;

  const locales = [];
  const central = [];
  let offset = 0;
  for (const e of lista) {
    const nombreBuf = Buffer.from(e.name, 'utf8');
    const datos = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const crc = crc32(datos);
    const size = datos.length;

    // Nivel 6 (el default de zlib): el punto de equilibrio habitual. El 9 gana un ~1 % a costa de
    // bastante CPU por libro, y esto se sirve dentro de un request HTTP.
    const comprimido = size > 0 ? deflateRawSync(datos, { level: 6 }) : Buffer.alloc(0);
    // Respaldo por entrada: si comprimir no achica (PNG del logo, partes diminutas), se guarda
    // crudo. Emitir un "comprimido" más grande que el original sería peor que no comprimir.
    const usaDeflate = comprimido.length < size;
    const cuerpo = usaDeflate ? comprimido : datos;
    const metodo = usaDeflate ? 8 : 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(FIRMA_LOCAL, 0);
    lh.writeUInt16LE(20, 4); // versión necesaria (2.0 cubre deflate)
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(metodo, 8); // 8 = deflate · 0 = stored
    lh.writeUInt16LE(0, 10); // hora
    lh.writeUInt16LE(0x21, 12); // fecha (1980-01-01: fija, para que el artefacto sea reproducible)
    lh.writeUInt32LE(crc, 14); // CRC32 del dato CRUDO, siempre
    lh.writeUInt32LE(cuerpo.length, 18); // tamaño comprimido
    lh.writeUInt32LE(size, 22); // tamaño crudo
    lh.writeUInt16LE(nombreBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locales.push(lh, nombreBuf, cuerpo);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(FIRMA_CENTRAL, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(metodo, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(cuerpo.length, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(nombreBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nombreBuf);

    offset += lh.length + nombreBuf.length + cuerpo.length;
  }
  const localBuf = Buffer.concat(locales);
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(FIRMA_EOCD, 0);
  eocd.writeUInt16LE(lista.length, 8);
  eocd.writeUInt16LE(lista.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

// Escape de texto para XML. El `'` NO se escapa porque los atributos que emitimos van con comillas
// dobles; `&`, `<` y `>` sí, siempre — un asiento del operador puede traer cualquiera de los tres
// ("F/L > 30 min", "GEC3 & GEC32") y sin escapar corrompen la hoja entera.
export const xmlEsc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Índice de columna 0-based → letra de Excel (`0 → A`, `25 → Z`, `26 → AA`).
export const colRef = (n) => {
  let s = '';
  n++;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

function buscarEOCD(buf) {
  const minimo = Math.max(0, buf.length - MAX_COMENTARIO_EOCD - 22);
  for (let i = buf.length - 22; i >= minimo; i--) {
    if (buf.readUInt32LE(i) === FIRMA_EOCD) return i;
  }
  return -1;
}
