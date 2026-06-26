// Lector mínimo de .xls (OLE2/CFB + BIFF8), sin dependencias.
// Port ESM de js-scraper-carbon-g32/xls.js (D-029 / E2). Algoritmo idéntico al original;
// solo cambia `module.exports` → `export`.
//
// El SIS exporta los valores como TEXTO en la Shared String Table (SST),
// así que hay que reconstruir la SST (incl. strings que cruzan CONTINUE) y
// resolver las celdas LABELSST de la primera hoja.

function readCFBStream(buf, wantName) {
  if (buf.readUInt32LE(0) !== 0xe011cfd0 || buf.readUInt32LE(4) !== 0xe11ab1a1) {
    throw new Error("No es un archivo OLE2/CFB válido");
  }
  const sectorSize = 1 << buf.readUInt16LE(30);
  const firstDirSector = buf.readUInt32LE(48);
  const numDifat = buf.readUInt32LE(72);
  const firstDifat = buf.readUInt32LE(68);
  const sectorOffset = (s) => 512 + s * sectorSize;

  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const v = buf.readUInt32LE(76 + i * 4);
    if (v === 0xffffffff) break;
    fatSectors.push(v);
  }
  let difatSec = firstDifat;
  for (let n = 0; n < numDifat && difatSec !== 0xffffffff && difatSec !== 0xfffffffe; n++) {
    const base = sectorOffset(difatSec);
    const cnt = sectorSize / 4 - 1;
    for (let i = 0; i < cnt; i++) {
      const v = buf.readUInt32LE(base + i * 4);
      if (v !== 0xffffffff) fatSectors.push(v);
    }
    difatSec = buf.readUInt32LE(base + cnt * 4);
  }

  const eps = sectorSize / 4;
  const fat = new Uint32Array(fatSectors.length * eps);
  let fi = 0;
  for (const fs of fatSectors) {
    const base = sectorOffset(fs);
    for (let i = 0; i < eps; i++) fat[fi++] = buf.readUInt32LE(base + i * 4);
  }

  const readChain = (start, size) => {
    const chunks = [];
    let s = start, total = 0;
    const lim = size == null ? Infinity : size;
    while (s !== 0xfffffffe && s !== 0xffffffff && total < lim) {
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
    if (nameLen <= 0) continue;
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

  u32(); // cstTotal
  const cstUnique = u32();
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
    strings[s] = String.fromCharCode(...codes);
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
