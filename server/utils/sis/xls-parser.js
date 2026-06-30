// Lector mínimo de .xls (OLE2/CFB + BIFF8), sin dependencias.
// Port ESM de js-scraper-carbon-g32/xls.js (D-029 / E2).
//
// AUD-08 (BIT-AUDSEG-2026-001): este parser corre SÍNCRONO en el event loop sobre bytes de un
// SIS HTTP plano NO autenticado. Un .xls malicioso (vía MITM) podía colgar el proceso (FAT
// cíclica → bucle infinito), reventar memoria (sectorSize/cstUnique gigantes → arrays enormes) o
// lanzar RangeError (spread de String.fromCharCode). Endurecido: detección de ciclos, validación
// de sectorSize y de todo índice de sector, topes derivados del tamaño real del buffer y
// construcción incremental de strings. Todo input inválido aborta con un Error ACOTADO en vez de
// colgar/OOM. AUD-36: este archivo es la implementación canónica; `js-scraper-carbon-g32/xls.js`
// es un MIRROR CommonJS que debe mantenerse en sync (el split ESM/CJS impide reuso síncrono).
//
// El SIS exporta los valores como TEXTO en la Shared String Table (SST),
// así que hay que reconstruir la SST (incl. strings que cruzan CONTINUE) y
// resolver las celdas LABELSST de la primera hoja.

function readCFBStream(buf, wantName) {
  // AUD-08: el header CFB ocupa 512 bytes; sin ellos no hay nada que parsear.
  if (buf.length < 512) throw new Error("xls inválido: buffer menor que el header CFB");
  if (buf.readUInt32LE(0) !== 0xe011cfd0 || buf.readUInt32LE(4) !== 0xe11ab1a1) {
    throw new Error("No es un archivo OLE2/CFB válido");
  }
  // AUD-08: validar sectorSize ANTES de dimensionar cualquier array. El exponente solo puede
  // valer 9 (512) o 12 (4096); cualquier otro (p.ej. 28 → 256 MB por sector) es malicioso.
  const ssExp = buf.readUInt16LE(30);
  if (ssExp !== 9 && ssExp !== 12) {
    throw new Error(`xls inválido: sectorSize exponente fuera de {9,12}: ${ssExp}`);
  }
  const sectorSize = 1 << ssExp; // 512 o 4096
  const firstDirSector = buf.readUInt32LE(48);
  const numDifat = buf.readUInt32LE(72);
  const firstDifat = buf.readUInt32LE(68);
  const sectorOffset = (s) => 512 + s * sectorSize;

  // AUD-08: nº real de sectores que caben en el buffer. Todo índice de sector debe caer en
  // [0, numSectores) antes de usarse para leer (evita lecturas fuera de rango / OOM).
  const numSectores = Math.floor((buf.length - 512) / sectorSize);
  const sectorValido = (s) => s >= 0 && s < numSectores;
  // AUD-08: numDifat dimensiona el recorrido DIFAT; no puede exceder los sectores existentes.
  if (numDifat > numSectores) {
    throw new Error(`xls inválido: numDifat excede el nº de sectores: ${numDifat}`);
  }

  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const v = buf.readUInt32LE(76 + i * 4);
    if (v === 0xffffffff) break;
    if (!sectorValido(v)) throw new Error(`xls inválido: FAT sector fuera de rango: ${v}`);
    fatSectors.push(v);
  }
  // AUD-08: cadena DIFAT con detección de ciclos + validación de cada índice de sector.
  let difatSec = firstDifat;
  const difatVistos = new Set();
  for (let n = 0; n < numDifat && difatSec !== 0xffffffff && difatSec !== 0xfffffffe; n++) {
    if (!sectorValido(difatSec)) {
      throw new Error(`xls inválido: DIFAT sector fuera de rango: ${difatSec}`);
    }
    if (difatVistos.has(difatSec)) throw new Error("xls inválido: ciclo en la cadena DIFAT");
    difatVistos.add(difatSec);
    const base = sectorOffset(difatSec);
    const cnt = sectorSize / 4 - 1;
    for (let i = 0; i < cnt; i++) {
      const v = buf.readUInt32LE(base + i * 4);
      if (v !== 0xffffffff) {
        if (!sectorValido(v)) throw new Error(`xls inválido: FAT sector fuera de rango: ${v}`);
        fatSectors.push(v);
      }
    }
    difatSec = buf.readUInt32LE(base + cnt * 4);
  }

  // fatSectors.length ya está acotado (≤109 + numDifat·(eps-1), todos validados < numSectores).
  const eps = sectorSize / 4;
  const fat = new Uint32Array(fatSectors.length * eps);
  let fi = 0;
  for (const fs of fatSectors) {
    const base = sectorOffset(fs);
    for (let i = 0; i < eps; i++) fat[fi++] = buf.readUInt32LE(base + i * 4);
  }

  // AUD-08: recorre la cadena FAT con (a) validación de índice, (b) Set de visitados (aborta
  // ante ciclo), (c) tope duro de sectores derivado del buffer — clave para la llamada
  // size==null/lim=Infinity (cadena de directorio), que sin tope podría no terminar.
  const maxSectores = numSectores + 1;
  const readChain = (start, size) => {
    const chunks = [];
    let s = start, total = 0, pasos = 0;
    const lim = size == null ? Infinity : size;
    const vistos = new Set();
    while (s !== 0xfffffffe && s !== 0xffffffff && total < lim) {
      if (!sectorValido(s)) throw new Error(`xls inválido: índice de sector fuera de rango: ${s}`);
      if (vistos.has(s)) throw new Error("xls inválido: ciclo en la cadena FAT");
      vistos.add(s);
      if (++pasos > maxSectores) throw new Error("xls inválido: cadena FAT excede el tope de sectores");
      const off = sectorOffset(s);
      chunks.push(buf.subarray(off, off + sectorSize));
      total += sectorSize;
      s = fat[s];
    }
    const out = Buffer.concat(chunks);
    return size == null ? out : out.subarray(0, size);
  };

  const dir = readChain(firstDirSector, null);
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = dir.readUInt16LE(off + 64);
    if (nameLen <= 0 || nameLen > 64) continue; // el nombre del directorio cabe en 64 bytes
    if (dir.readUInt8(off + 66) !== 2) continue;
    const name = dir.toString("utf16le", off, off + nameLen - 2);
    if (name === wantName) {
      return readChain(dir.readUInt32LE(off + 116), dir.readUInt32LE(off + 120));
    }
  }
  throw new Error(`Stream '${wantName}' no encontrado`);
}

// Lee la SST a partir de los bloques [sstPayload, ...continuePayloads].
// Maneja el byte grbit de reanudación al cruzar un límite de CONTINUE.
function parseSST(blocks) {
  let bi = 0, pos = 0;
  const ensure = () => { while (bi < blocks.length && pos >= blocks[bi].length) { bi++; pos = 0; } };
  const u8 = () => { ensure(); return blocks[bi][pos++]; };
  const u16 = () => u8() | (u8() << 8);
  const u32 = () => (u8() | (u8() << 8) | (u8() << 16) | (u8() << 24)) >>> 0;
  const skip = (n) => {
    let rem = n;
    while (rem > 0) { ensure(); const avail = blocks[bi].length - pos; const take = Math.min(avail, rem); pos += take; rem -= take; }
  };

  // AUD-08: cada string ocupa ≥3 bytes (cch u16 + grbit u8), así que cstUnique no puede superar
  // el total de bytes de la SST. Tope ANTES de `new Array(cstUnique)` y del bucle: un cstUnique
  // gigante (u32 hasta 4e9) dimensionaría un array enorme y un bucle interminable.
  const totalBytes = blocks.reduce((a, b) => a + b.length, 0);

  u32(); // cstTotal
  const cstUnique = u32();
  if (cstUnique > totalBytes) {
    throw new Error(`xls inválido: cstUnique (${cstUnique}) excede el tamaño de la SST (${totalBytes})`);
  }
  const strings = new Array(cstUnique);

  for (let s = 0; s < cstUnique; s++) {
    const cch = u16();
    let grbit = u8();
    let high = grbit & 0x01;
    const rich = grbit & 0x08 ? u16() : 0;
    const ext = grbit & 0x04 ? u32() : 0;

    const codes = [];
    let rem = cch;
    while (rem > 0) {
      ensure();
      const avail = blocks[bi].length - pos;
      const charSize = high ? 2 : 1;
      const canChars = Math.floor(avail / charSize);
      const take = Math.min(canChars, rem);
      for (let i = 0; i < take; i++) codes.push(high ? u16() : u8());
      rem -= take;
      if (rem > 0) {
        // cruce de CONTINUE: el siguiente bloque arranca con un grbit de reanudación
        bi++; pos = 0;
        high = u8() & 0x01;
      }
    }
    skip(rich * 4); // runs de rich text (ich+ifnt)
    skip(ext);      // datos fonéticos/extendidos
    // AUD-08: construcción incremental por chunks en vez de `String.fromCharCode(...codes)`.
    // El spread podía lanzar RangeError (demasiados argumentos) con arrays grandes; chunkear es
    // equivalente carácter a carácter (cada code es una code unit UTF-16) y acotado.
    let str = "";
    for (let i = 0; i < codes.length; i += 8192) {
      str += String.fromCharCode.apply(null, codes.slice(i, i + 8192));
    }
    strings[s] = str;
  }
  return strings;
}

function decodeRK(rk) {
  const mult100 = rk & 1, isInt = rk & 2;
  let v;
  if (isInt) v = rk >> 2;
  else { const b = Buffer.alloc(8); b.writeUInt32LE(0, 0); b.writeUInt32LE(rk & 0xfffffffc, 4); v = b.readDoubleLE(0); }
  return mult100 ? v / 100 : v;
}

export function parseXls(inputBuf) {
  let wb;
  try { wb = readCFBStream(inputBuf, "Workbook"); }
  catch (e) { wb = readCFBStream(inputBuf, "Book"); }

  // Índice de todos los registros para asociar CONTINUE con su registro previo.
  let pos = 0;
  let sst = [];
  let worksheetSeen = 0, inTarget = false;
  const cells = {};
  let maxRow = -1, maxCol = -1;
  const put = (r, c, v) => { cells[r + "," + c] = v; if (r > maxRow) maxRow = r; if (c > maxCol) maxCol = c; };
  const num = (s) => { const f = parseFloat(s); return Number.isNaN(f) ? s : f; };

  while (pos + 4 <= wb.length) {
    const type = wb.readUInt16LE(pos);
    const len = wb.readUInt16LE(pos + 2);
    let dataStart = pos + 4;
    pos = dataStart + len;

    if (type === 0x00fc) {
      // SST: juntar este payload + los CONTINUE (0x3C) que siguen.
      const blocks = [wb.subarray(dataStart, dataStart + len)];
      while (pos + 4 <= wb.length && wb.readUInt16LE(pos) === 0x003c) {
        const clen = wb.readUInt16LE(pos + 2);
        blocks.push(wb.subarray(pos + 4, pos + 4 + clen));
        pos += 4 + clen;
      }
      sst = parseSST(blocks);
      continue;
    }

    const data = wb.subarray(dataStart, dataStart + len);
    if (type === 0x0809) {
      const dt = data.length >= 4 ? data.readUInt16LE(2) : 0;
      if (dt === 0x0010) { worksheetSeen++; inTarget = worksheetSeen === 1; }
      else inTarget = false;
      continue;
    }
    if (type === 0x000a) { if (inTarget) break; inTarget = false; continue; }
    if (!inTarget) continue;

    switch (type) {
      case 0x00fd: { // LABELSST
        const r = data.readUInt16LE(0), c = data.readUInt16LE(2), isst = data.readUInt32LE(6);
        put(r, c, num(sst[isst]));
        break;
      }
      case 0x0203: { put(data.readUInt16LE(0), data.readUInt16LE(2), data.readDoubleLE(6)); break; }
      case 0x027e: { put(data.readUInt16LE(0), data.readUInt16LE(2), decodeRK(data.readUInt32LE(6))); break; }
      case 0x00bd: {
        const r = data.readUInt16LE(0), c0 = data.readUInt16LE(2), n = (data.length - 6) / 6;
        for (let i = 0; i < n; i++) put(r, c0 + i, decodeRK(data.readUInt32LE(4 + i * 6 + 2)));
        break;
      }
      case 0x0006: { if (data.readUInt16LE(12) !== 0xffff) put(data.readUInt16LE(0), data.readUInt16LE(2), data.readDoubleLE(6)); break; }
      default: break;
    }
  }

  const lastRow = [];
  for (let c = 0; c <= maxCol; c++) { const k = maxRow + "," + c; lastRow.push(k in cells ? cells[k] : null); }
  return { maxRow: maxRow + 1, ncols: maxCol + 1, lastRow };
}
