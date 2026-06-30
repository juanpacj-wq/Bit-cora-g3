import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXls } from '../utils/sis/xls-parser.js';
import { buildUrl, escapeXml } from '../utils/sis/sis-client.js';

// AUD-08/14/25 (BIT-AUDSEG-2026-001) — endurecimiento del parser .xls y de buildUrl.
// LÓGICA PURA: no toca red ni BD. Alimenta al parser con buffers malformados (construidos a
// mano) y confirma que aborta con un Error ACOTADO en vez de colgarse / agotar memoria. Si el
// parser NO estuviera endurecido, el test (b) — FAT cíclica — colgaría el runner (timeout),
// que es justamente el DoS que AUD-08 describe.

// Construye un header CFB de 512 bytes válido (firma + sectorSize 512) sobre un buffer del
// tamaño pedido. Por defecto firstDifat=0xFFFFFFFE, numDifat=0 y la lista DIFAT termina enseguida.
function baseCFB(totalLen) {
  const buf = Buffer.alloc(totalLen);
  buf.writeUInt32LE(0xe011cfd0, 0);   // firma OLE2/CFB (parte baja)
  buf.writeUInt32LE(0xe11ab1a1, 4);   // firma OLE2/CFB (parte alta)
  buf.writeUInt16LE(9, 30);           // sectorSize = 1<<9 = 512
  buf.writeUInt32LE(0, 48);           // firstDirSector = 0
  buf.writeUInt32LE(0xfffffffe, 68);  // firstDifat = ENDOFCHAIN
  buf.writeUInt32LE(0, 72);           // numDifat = 0
  // Lista DIFAT inline (109 entradas desde el offset 76): por defecto todas 0xFFFFFFFF (vacías).
  for (let i = 0; i < 109; i++) buf.writeUInt32LE(0xffffffff, 76 + i * 4);
  return buf;
}

test('(a) sectorSize con exponente inválido (byte 30 = 28) → throw acotado, sin OOM', () => {
  const buf = baseCFB(512);
  buf.writeUInt16LE(28, 30); // 1<<28 = 256 MB por sector → debe rechazarse ANTES de asignar arrays
  assert.throws(() => parseXls(buf), /sectorSize/i, 'debió rechazar el sectorSize inválido');
});

test('(b) FAT cíclica (sector 0 apunta a sí mismo) → throw "ciclo", NO bucle infinito', () => {
  // 512 (header) + sector 0 [512..1024) + sector 1 [1024..1536) = 1536 bytes → numSectores = 2.
  const buf = baseCFB(1536);
  // La FAT vive en el sector 1; lo declaramos en la primera entrada DIFAT inline.
  buf.writeUInt32LE(1, 76);          // fatSectors = [1]
  buf.writeUInt32LE(0xffffffff, 80); // corta la lista DIFAT inline
  // Contenido del sector FAT (offset 1024): fat[0] = 0 → el sector de directorio 0 se apunta a
  // sí mismo (cadena cíclica). El resto, ENDOFCHAIN.
  buf.writeUInt32LE(0, 1024);        // fat[0] = 0  (¡ciclo!)
  for (let i = 1; i < 128; i++) buf.writeUInt32LE(0xfffffffe, 1024 + i * 4);
  assert.throws(() => parseXls(buf), /ciclo|fuera de rango|tope/i, 'debió detectar el ciclo FAT');
});

test('(c) buffer trivialmente corrupto (sin firma CFB) → throw acotado', () => {
  const buf = Buffer.alloc(600, 0x7a); // bytes basura, sin firma OLE2
  assert.throws(() => parseXls(buf), /OLE2|CFB|inválido/i);
});

test('(d) buffer menor que el header CFB (512 bytes) → throw acotado', () => {
  const buf = Buffer.alloc(64, 0xff);
  assert.throws(() => parseXls(buf), /header|inválido/i);
});

test('(e) firstDirSector fuera de rango → throw "fuera de rango"', () => {
  const buf = baseCFB(1536);
  buf.writeUInt32LE(9999, 48); // firstDirSector apunta a un sector inexistente
  buf.writeUInt32LE(1, 76);
  buf.writeUInt32LE(0xffffffff, 80);
  for (let i = 0; i < 128; i++) buf.writeUInt32LE(0xfffffffe, 1024 + i * 4);
  assert.throws(() => parseXls(buf), /fuera de rango/i);
});

test('(f) escapeXml escapa &, <, >, " y \'', () => {
  assert.equal(escapeXml('a<b>c&d"e\'f'), 'a&lt;b&gt;c&amp;d&quot;e&apos;f');
  // No deben quedar `<`/`>` sin escapar (el `&` restante es parte de las entidades &amp;/&lt;…).
  assert.equal(/[<>]/.test(escapeXml('<tg n="x">&')), false);
});

test('(g) buildUrl valida formato de fecha/hora (no confía en el llamador)', () => {
  // Caso válido: no lanza y escapa el contenido interpolado.
  assert.doesNotThrow(() => buildUrl('2026-06-03', '00', '2026-06-03', '01'));
  // Intento de inyección XML / formato inválido → rechazado.
  assert.throws(() => buildUrl("2026-06-03'/><x>", '00', '2026-06-03', '01'), /f1/);
  assert.throws(() => buildUrl('2026-06-03', '99', '2026-06-03', '01'), /h1/);
  assert.throws(() => buildUrl('2026-06-03', '00', 'bad', '01'), /f2/);
});
