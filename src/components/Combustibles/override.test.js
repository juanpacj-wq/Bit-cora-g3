/* global process */
// D-061 L03 (CA-11) — helpers puros del override SIS. Sin DOM ni backend: `environment:'node'`
// del vitest.config alcanza. Todo lo que se prueba acá es aritmética de tiempo y armado de texto,
// que es justo lo que se rompe en silencio (un desfase de zona no tumba la app: solo muestra una
// hora mentirosa en el tooltip, y nadie lo nota hasta que hay que auditar quién cambió qué).
//
// Instantes de referencia (Bogotá = UTC-5 fijo, sin DST):
//   2026-08-26T20:42:00Z → 26/08/2026 15:42
//   2026-08-26T03:30:00Z → 25/08/2026 22:30  (cruza el día hacia atrás)
//   2026-08-26T05:00:00Z → 26/08/2026 00:00  (medianoche: nunca "24:00")
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  esOverride,
  textoOverride,
  politicaRefresco,
  restanteGavela,
  formatoMMSS,
  textoChipSis,
  GAVELA_MS,
  claveRefetch,
  esVacioCantidad,
  esCeroNoOp,
  claveCelda,
  reconciliarBuffer,
  calcularDiff,
  celdaEquivalente,
  ladoPopover,
} from './override.js';

// El equipo de dev del que salió esto tiene el sistema en America/Bogota: un helper al que se le
// olvide el `timeZone` explícito da EXACTAMENTE el mismo texto y ningún test lo nota (se midió:
// borrar `timeZone: 'America/Bogota'` de override.js dejaba la suite verde). Se corre el archivo
// completo bajo una zona hostil para que las horas Bogotá que se afirman abajo solo puedan salir
// de un `timeZone` explícito — acá y en un CI en UTC.
const TZ_HOST = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
beforeAll(() => { process.env.TZ = 'Asia/Tokyo'; });
afterAll(() => { process.env.TZ = TZ_HOST; });

// Celda con la forma del GET de C4 (celda de hoy + campos SIS que agrega L02).
function celda(extra = {}) {
  return {
    consumo_id: 91,
    cantidad: 18.5,
    detalle: null,
    creado_por: { usuario_id: 1, nombre_completo: 'SISTEMA' },
    creado_en: '2026-08-26T14:00:00.000Z',
    modificado_por: { usuario_id: 7, nombre_completo: 'Ana Ríos' },
    modificado_en: '2026-08-26T20:42:00.000Z',
    valor_sis: 17.25,
    sis_actualizado_en: '2026-08-26T14:00:00.000Z',
    sis_owned: false,
    es_override: true,
    ...extra,
  };
}

describe('esOverride', () => {
  it('es true solo cuando el backend marcó es_override', () => {
    expect(esOverride(celda())).toBe(true);
  });

  it('es false cuando la celda existe pero no es override', () => {
    expect(esOverride(celda({ es_override: false }))).toBe(false);
    expect(esOverride(celda({ es_override: 0 }))).toBe(false);
  });

  it('es false cuando el campo no viene (backend anterior a L02) o no hay celda', () => {
    const sinCampo = celda();
    delete sinCampo.es_override;
    expect(esOverride(sinCampo)).toBe(false);
    expect(esOverride(undefined)).toBe(false);
    expect(esOverride(null)).toBe(false);
  });
});

describe('textoOverride', () => {
  it('usa modificado_por/modificado_en y la hora Bogotá', () => {
    expect(textoOverride(celda()))
      .toBe('Editado por Ana Ríos el 26/08/2026 15:42. Valor SIS: 17.25 Ton');
  });

  it('cae a creado_por/creado_en cuando la celda nunca se modificó', () => {
    const c = celda({
      modificado_por: null,
      modificado_en: null,
      creado_por: { usuario_id: 7, nombre_completo: 'Ana Ríos' },
      creado_en: '2026-08-26T20:42:00.000Z',
    });
    expect(textoOverride(c))
      .toBe('Editado por Ana Ríos el 26/08/2026 15:42. Valor SIS: 17.25 Ton');
  });

  it('convierte UTC a Bogotá cruzando el día hacia atrás', () => {
    const c = celda({ modificado_en: '2026-08-26T03:30:00.000Z' });
    expect(textoOverride(c)).toContain('el 25/08/2026 22:30.');
  });

  it('a medianoche Bogotá muestra 00:00, nunca 24:00', () => {
    const c = celda({ modificado_en: '2026-08-26T05:00:00.000Z' });
    expect(textoOverride(c)).toContain('el 26/08/2026 00:00.');
  });

  it('sin fecha legible omite el "el …" y sin nombres dice usuario desconocido', () => {
    const c = celda({
      modificado_por: null, modificado_en: 'no-es-fecha',
      creado_por: null, creado_en: null,
      valor_sis: null,
    });
    expect(textoOverride(c)).toBe('Editado por usuario desconocido. Valor SIS: — Ton');
  });

  it('fija Bogotá aunque el host esté en otra zona horaria', () => {
    // Guardia del propio test: si algún día `process.env.TZ` deja de mover el default de Intl,
    // esta línea falla en vez de dejar que las de abajo pasen por casualidad.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).not.toBe('America/Bogota');
    expect(textoOverride(celda())).toContain('el 26/08/2026 15:42.');
  });

  it('imprime el valor SIS decimal tal cual y tolera un segundo argumento (C11 ahora?)', () => {
    const c = celda({ valor_sis: 12.345 });
    expect(textoOverride(c)).toContain('Valor SIS: 12.345 Ton');
    expect(textoOverride(c, new Date('2026-08-26T20:42:00.000Z'))).toBe(textoOverride(c));
  });
});

describe('politicaRefresco', () => {
  const hoy = '2026-08-26';

  it('GEC32 viendo hoy y sin cambios locales: auto-refresco', () => {
    expect(politicaRefresco({ plantaId: 'GEC32', fecha: hoy, hoy, hayCambios: false }))
      .toEqual({ autoRefresco: true, gavela: false });
  });

  it('GEC32 viendo hoy con cambios locales: gavela y NUNCA auto-refresco', () => {
    expect(politicaRefresco({ plantaId: 'GEC32', fecha: hoy, hoy, hayCambios: true }))
      .toEqual({ autoRefresco: false, gavela: true });
  });

  it('una fecha pasada no se refresca sola ni corre gavela', () => {
    expect(politicaRefresco({ plantaId: 'GEC32', fecha: '2026-08-25', hoy, hayCambios: false }))
      .toEqual({ autoRefresco: false, gavela: false });
    expect(politicaRefresco({ plantaId: 'GEC32', fecha: '2026-08-25', hoy, hayCambios: true }))
      .toEqual({ autoRefresco: false, gavela: false });
  });

  it('otra planta no tiene SIS: ni auto-refresco ni gavela', () => {
    expect(politicaRefresco({ plantaId: 'GEC3', fecha: hoy, hoy, hayCambios: false }))
      .toEqual({ autoRefresco: false, gavela: false });
    expect(politicaRefresco({ plantaId: 'TST', fecha: hoy, hoy, hayCambios: true }))
      .toEqual({ autoRefresco: false, gavela: false });
  });

  it('sin fecha ni hoy (primer render) no arranca nada, aunque ambos sean undefined', () => {
    expect(politicaRefresco({ plantaId: 'GEC32', hayCambios: false }))
      .toEqual({ autoRefresco: false, gavela: false });
    expect(politicaRefresco()).toEqual({ autoRefresco: false, gavela: false });
  });
});

describe('restanteGavela', () => {
  it('al arrancar quedan los 10 minutos completos', () => {
    expect(restanteGavela(1000, 1000)).toBe(GAVELA_MS);
  });

  it('descuenta el tiempo transcurrido', () => {
    expect(restanteGavela(1000, 1000 + 65000)).toBe(GAVELA_MS - 65000);
  });

  it('al vencer da 0 y nunca baja de 0', () => {
    expect(restanteGavela(1000, 1000 + GAVELA_MS)).toBe(0);
    expect(restanteGavela(1000, 1000 + GAVELA_MS + 999999)).toBe(0);
  });

  it('sin inicio válido (gavela apagada) da 0', () => {
    expect(restanteGavela(null, 5000)).toBe(0);
    expect(restanteGavela(undefined, 5000)).toBe(0);
    expect(restanteGavela(1000, NaN)).toBe(0);
  });
});

describe('formatoMMSS', () => {
  it('formatea los extremos de la cuenta regresiva', () => {
    expect(formatoMMSS(GAVELA_MS)).toBe('10:00');
    expect(formatoMMSS(65000)).toBe('1:05');
    expect(formatoMMSS(0)).toBe('0:00');
  });

  it('redondea hacia arriba: la cuenta arranca en 10:00, no en 9:59', () => {
    // El caso que rompía: la gavela nace en T y el primer latido llega unos ms después, así que
    // `restanteGavela` ya devuelve 599 997 ms. Truncando se mostraba 9:59 desde el primer frame.
    expect(formatoMMSS(599997)).toBe('10:00');
    expect(formatoMMSS(599001)).toBe('10:00');
    expect(formatoMMSS(599000)).toBe('9:59');   // el segundo exacto ya es 9:59
  });

  it('rellena los segundos a dos dígitos y solo muestra 0:00 al vencer', () => {
    expect(formatoMMSS(9000)).toBe('0:09');
    expect(formatoMMSS(8001)).toBe('0:09');
    expect(formatoMMSS(1)).toBe('0:01');
    expect(formatoMMSS(0)).toBe('0:00');
  });

  it('nunca muestra negativos ni NaN', () => {
    expect(formatoMMSS(-5000)).toBe('0:00');
    expect(formatoMMSS(NaN)).toBe('0:00');
    expect(formatoMMSS(undefined)).toBe('0:00');
  });
});

describe('textoChipSis', () => {
  it('sin fila de scrape (o backend anterior a L02) dice "sin lectura"', () => {
    expect(textoChipSis(null)).toBe('SIS · sin lectura');
    expect(textoChipSis(undefined)).toBe('SIS · sin lectura');
  });

  it('día completo: 24/24 con visto', () => {
    expect(textoChipSis({
      scrape_tipo: 'sweeper', periodos_ok: 24, periodos_error: 0,
      ultimo_periodo: 24, completo: true, scraped_en: '2026-08-26T20:42:00.000Z',
    })).toBe('SIS 24/24 ✓');
  });

  it('día parcial: periodos leídos y hora Bogotá del último scrape', () => {
    expect(textoChipSis({
      scrape_tipo: 'sweeper', periodos_ok: 18, periodos_error: 0,
      ultimo_periodo: 18, completo: false, scraped_en: '2026-08-26T20:42:00.000Z',
    })).toBe('SIS 18/24 · 15:42');
  });

  it('día parcial sin scraped_en legible: solo el conteo', () => {
    expect(textoChipSis({ periodos_ok: 18, completo: false, scraped_en: null }))
      .toBe('SIS 18/24');
    expect(textoChipSis({ completo: false })).toBe('SIS 0/24');
  });
});

describe('GAVELA_MS', () => {
  it('son 10 minutos exactos', () => {
    expect(GAVELA_MS).toBe(10 * 60 * 1000);
  });
});

// ── D-061 L08 ────────────────────────────────────────────────────────────────────────────────────

describe('claveRefetch (L08, CA-33)', () => {
  it('distingue dos fechas de la misma planta', () => {
    expect(claveRefetch('GEC32', '2026-08-26')).not.toBe(claveRefetch('GEC32', '2026-08-25'));
  });

  it('distingue dos plantas en la misma fecha', () => {
    expect(claveRefetch('GEC32', '2026-08-26')).not.toBe(claveRefetch('GEC3', '2026-08-26'));
  });

  it('la misma coordenada da siempre la misma clave', () => {
    expect(claveRefetch('GEC32', '2026-08-26')).toBe(claveRefetch('GEC32', '2026-08-26'));
  });

  it('no confunde ausencias: (null, X) no es (X, null)', () => {
    // Concatenar sin separador haría que ('GEC3','2') y ('GEC','32') colisionaran.
    expect(claveRefetch(null, 'GEC32')).not.toBe(claveRefetch('GEC32', null));
    expect(claveRefetch(undefined, undefined)).toBe(claveRefetch(null, null));
  });
});

describe('esVacioCantidad (L08, CA-34)', () => {
  it('null, undefined, cadena vacía, 0 y NaN cuentan como vacío', () => {
    for (const v of [null, undefined, '', 0, NaN]) expect(esVacioCantidad(v)).toBe(true);
  });

  it('cualquier cantidad real no es vacío', () => {
    for (const v of [0.001, 5, 25, -3]) expect(esVacioCantidad(v)).toBe(false);
  });
});

describe('esCeroNoOp (L08, CA-34)', () => {
  // El caso que motiva todo: el override 0 de C6. El server conserva la celda viva en 0, así que
  // volver a teclear 0 (o vaciarla) no cambia nada y no puede encender "Guardar".
  it('teclear 0 sobre una celda que el server ya tiene en 0 es un no-op', () => {
    expect(esCeroNoOp(0, { cantidad: 0, valor_sis: 17.25, es_override: true })).toBe(true);
  });

  it('vaciar (null) o dejar el campo en blanco sobre esa misma celda también es no-op', () => {
    expect(esCeroNoOp(null, { cantidad: 0 })).toBe(true);
    expect(esCeroNoOp('', { cantidad: 0 })).toBe(true);
    expect(esCeroNoOp(NaN, { cantidad: 0 })).toBe(true);
  });

  it('vaciar una celda con cantidad real SÍ es un cambio (es el "vaciar" de C6)', () => {
    expect(esCeroNoOp(null, { cantidad: 18.5, valor_sis: 17.25 })).toBe(false);
    expect(esCeroNoOp(0, { cantidad: 18.5 })).toBe(false);
  });

  it('teclear 0 donde el server no tiene celda sigue siendo "no escribir nada"', () => {
    // Sin fila previa el 0 no crea celda: el buffer debe quedar sin la clave, no con un 0 falso.
    expect(esCeroNoOp(0, undefined)).toBe(false);
    expect(esCeroNoOp(0, {})).toBe(false);
    expect(esCeroNoOp(0, { cantidad: null })).toBe(false);
  });

  it('escribir una cantidad real nunca es no-op, ni sobre una celda en 0', () => {
    expect(esCeroNoOp(5, { cantidad: 0 })).toBe(false);
  });

  it('tolera un 0 que llegue como string del server', () => {
    // `calcularDiff` ya compara con Number(); esta guarda no puede ser más estricta que aquella,
    // o una celda en "0" quedaría marcada como cambio para siempre.
    expect(esCeroNoOp(0, { cantidad: '0' })).toBe(true);
  });
});

// ── D-061 L09 ───────────────────────────────────────────────────────────────────────────────────

describe('claveCelda (L09, CA-37)', () => {
  it('distingue coordenadas que se verían iguales concatenadas sin separador', () => {
    // (periodo 1, combustible 23) y (periodo 12, combustible 3) darían '123' las dos.
    expect(claveCelda(1, 23)).not.toBe(claveCelda(12, 3));
  });

  it('no distingue el número del string: el buffer usa claves string y el render pasa números', () => {
    expect(claveCelda(3, 1)).toBe(claveCelda('3', '1'));
  });
});

describe('reconciliarBuffer (L09, CA-37)', () => {
  const snap = () => ({
    3: { 1: { cantidad: 20, detalle: null }, 2: { cantidad: 15, detalle: null } },
    5: { 1: { cantidad: 7, detalle: null } },
  });

  it('sin nada editado el buffer queda igual al snapshot nuevo', () => {
    expect(reconciliarBuffer({ 3: { 1: { cantidad: 20 } } }, snap(), new Set())).toEqual(snap());
  });

  it('la celda tecleada sobrevive y el resto entra desde el server', () => {
    // El escenario de H24: el operador teclea P3/1 mientras vuela el GET, que trae P5/1 nueva.
    const buffer = { 3: { 1: { cantidad: 22, detalle: null }, 2: { cantidad: 15, detalle: null } } };
    const out = reconciliarBuffer(buffer, snap(), new Set(['3|1']));
    expect(out[3][1].cantidad).toBe(22);          // manda lo tecleado
    expect(out[5][1].cantidad).toBe(7);           // entra la celda nueva del SIS
    expect(out[3][2].cantidad).toBe(15);
  });

  it('una celda que el SIS cambió por debajo se adopta si el operador no la tocó', () => {
    const buffer = { 3: { 1: { cantidad: 20 }, 2: { cantidad: 15 } } };
    const nuevo = { 3: { 1: { cantidad: 20 }, 2: { cantidad: 99 } } };
    expect(reconciliarBuffer(buffer, nuevo, new Set(['3|1']))[3][2].cantidad).toBe(99);
  });

  it('vaciar es tocar: la celda no vuelve aunque el server siga trayéndola', () => {
    // Sin esto, el vaciado a medias se perdería solo con el primer latido del auto-refresco.
    const out = reconciliarBuffer({}, snap(), new Set(['3|1']));
    expect(out[3][1]).toBeUndefined();
    expect(out[3][2].cantidad).toBe(15);          // la vecina de la misma fila queda intacta
  });

  it('si se vació la única celda de la fila, la fila desaparece (no queda un objeto vacío)', () => {
    const out = reconciliarBuffer({}, snap(), new Set(['5|1']));
    expect(out[5]).toBeUndefined();
  });

  it('una celda tecleada en una fila que el server no tiene se conserva', () => {
    const buffer = { 9: { 4: { cantidad: 3 } } };
    expect(reconciliarBuffer(buffer, snap(), new Set(['9|4']))[9][4].cantidad).toBe(3);
  });

  it('no comparte referencias con el snapshot ni con el buffer previo', () => {
    // El buffer se muta por copia en `setCelda`; compartir un objeto con el snapshot haría que
    // `hayCambios` (que compara JSON) dejara de ver cambios reales.
    const s = snap();
    const buffer = { 3: { 1: { cantidad: 22 } } };
    const out = reconciliarBuffer(buffer, s, new Set(['3|1']));
    expect(out[5][1]).not.toBe(s[5][1]);
    expect(out[3][1]).not.toBe(buffer[3][1]);
  });

  it('tolera claves basura en el conjunto sin romper la reconciliación', () => {
    expect(reconciliarBuffer({}, snap(), new Set(['', '|1', 'basura', null]))).toEqual(snap());
  });
});

describe('calcularDiff (L09, CA-37)', () => {
  const snap = () => ({
    3: { 1: { cantidad: 20, detalle: null } },
    5: { 1: { cantidad: 7, detalle: null } },
  });

  it('solo emite celdas del conjunto de editadas', () => {
    // El corazón de CA-37: P5 la creó el SIS durante el refetch y difiere del buffer, pero el
    // operador nunca la tocó. Emitirla la borraría (o la volvería override 0 a su nombre).
    const buffer = { 3: { 1: { cantidad: 22, detalle: null } } };
    expect(calcularDiff(buffer, snap(), new Set(['3|1']))).toEqual([
      { periodo: 3, combustible_id: 1, cantidad: 22, detalle: null },
    ]);
  });

  it('sin celdas editadas no hay nada que mandar, por mucho que difieran buffer y snapshot', () => {
    expect(calcularDiff({}, snap(), new Set())).toEqual([]);
    expect(calcularDiff({}, snap(), undefined)).toEqual([]);
  });

  it('una celda editada que quedó igual al snapshot no viaja', () => {
    const buffer = { 3: { 1: { cantidad: 20, detalle: null } } };
    expect(calcularDiff(buffer, snap(), new Set(['3|1']))).toEqual([]);
  });

  it('vaciar una celda editada manda cantidad null (el "vaciar" de C6)', () => {
    expect(calcularDiff({}, snap(), new Set(['3|1']))).toEqual([
      { periodo: 3, combustible_id: 1, cantidad: null },
    ]);
  });

  it('una celda nueva viaja como INSERT con su detalle', () => {
    const buffer = { 9: { 4: { cantidad: 3, detalle: 'Arranque' } } };
    expect(calcularDiff(buffer, snap(), new Set(['9|4']))).toEqual([
      { periodo: 9, combustible_id: 4, cantidad: 3, detalle: 'Arranque' },
    ]);
  });

  it('cambiar solo el detalle también es un cambio', () => {
    const buffer = { 3: { 1: { cantidad: 20, detalle: 'Tolva atascada' } } };
    expect(calcularDiff(buffer, snap(), new Set(['3|1']))).toEqual([
      { periodo: 3, combustible_id: 1, cantidad: 20, detalle: 'Tolva atascada' },
    ]);
  });

  it('el detalle de la celda viaja aunque solo haya cambiado la cantidad (H25)', () => {
    // La otra mitad de CA-38: si el diff mandara `detalle: null` acá, el backend borraría la nota
    // en su rama de UPDATE.
    const snapConNota = { 3: { 1: { cantidad: 18.5, detalle: 'Tolva atascada' } } };
    const buffer = { 3: { 1: { cantidad: 20, detalle: 'Tolva atascada' } } };
    expect(calcularDiff(buffer, snapConNota, new Set(['3|1']))).toEqual([
      { periodo: 3, combustible_id: 1, cantidad: 20, detalle: 'Tolva atascada' },
    ]);
  });

  it('una celda tecleada y deshecha sin dejar rastro no viaja', () => {
    expect(calcularDiff({}, {}, new Set(['9|4']))).toEqual([]);
  });

  it('la metadata refrescada de una celda editada no viaja (L11, H52)', () => {
    // El escenario de H52: el operador tecleó 22 en 3/1, el GET volvió con esa MISMA cantidad y
    // metadata nueva (`modificado_en`, `valor_sis`, `es_override`), y `reconciliarBuffer` conservó
    // la celda del operador —con la metadata vieja—. El diff tiene que salir vacío: lo único que
    // el operador escribe es `cantidad` y `detalle`.
    const snapFresco = {
      3: { 1: { cantidad: 22, detalle: null, modificado_en: '2026-08-27T12:00:00.000Z', valor_sis: 19, es_override: true } },
    };
    const buffer = {
      3: { 1: { cantidad: 22, detalle: null, modificado_en: null, valor_sis: null, es_override: false } },
    };
    expect(calcularDiff(buffer, snapFresco, new Set(['3|1']))).toEqual([]);
  });

  it('sale ordenado por periodo y combustible, no por el orden en que se tecleó', () => {
    const buffer = { 3: { 1: { cantidad: 22 }, 2: { cantidad: 1 } }, 1: { 5: { cantidad: 4 } } };
    const claves = new Set(['3|2', '1|5', '3|1']);
    expect(calcularDiff(buffer, {}, claves).map((c) => [c.periodo, c.combustible_id]))
      .toEqual([[1, 5], [3, 1], [3, 2]]);
  });
});

describe('ladoPopover (L09, CA-39)', () => {
  // Recuadro visible de `.comb-scroll`: 1000 de ancho × 400 de alto.
  const CONT = { top: 100, bottom: 500, left: 0, right: 1000 };
  const banderin = (top, left) => ({ top, bottom: top + 14, left, right: left + 14 });

  it('con lienzo de sobra abre abajo y a la derecha (el default del CSS)', () => {
    expect(ladoPopover({ banderin: banderin(120, 40), contenedor: CONT }))
      .toEqual({ arriba: false, izq: false });
  });

  it('pegado al borde INFERIOR abre hacia arriba', () => {
    expect(ladoPopover({ banderin: banderin(460, 40), contenedor: CONT }))
      .toEqual({ arriba: true, izq: false });
  });

  it('pegado al borde DERECHO abre hacia la izquierda', () => {
    expect(ladoPopover({ banderin: banderin(120, 900), contenedor: CONT }))
      .toEqual({ arriba: false, izq: true });
  });

  it('en la esquina inferior derecha abre arriba y a la izquierda', () => {
    expect(ladoPopover({ banderin: banderin(460, 900), contenedor: CONT }))
      .toEqual({ arriba: true, izq: true });
  });

  it('el mismo periodo cambia de lado según dónde esté en el viewport (H26)', () => {
    // Esta es la razón de ser del cambio: L08 decidía por número de periodo, así que P19 abría
    // SIEMPRE hacia arriba — también cuando el scroll lo dejaba pegado a la cabecera.
    const desplazadoArriba = banderin(104, 40);   // P19 apenas debajo del borde superior
    const desplazadoAbajo = banderin(470, 40);    // el MISMO P19, con la tabla sin desplazar
    expect(ladoPopover({ banderin: desplazadoArriba, contenedor: CONT }).arriba).toBe(false);
    expect(ladoPopover({ banderin: desplazadoAbajo, contenedor: CONT }).arriba).toBe(true);
  });

  it('en una pantalla ancha el último alimentador NO se voltea', () => {
    // La sospecha que L08 dejó abierta: con tres columnas a la derecha el popover cabe de sobra.
    expect(ladoPopover({ banderin: banderin(120, 620), contenedor: CONT }).izq).toBe(false);
  });

  it('un contenedor más chico que el popover deja el lado por defecto', () => {
    // No hay lado bueno: voltear sería igual de malo y menos predecible.
    const chico = { top: 0, bottom: 60, left: 0, right: 200 };
    expect(ladoPopover({ banderin: banderin(20, 90), contenedor: chico }))
      .toEqual({ arriba: false, izq: false });
  });

  it('sin rects (jsdom no hace layout) no inventa una decisión', () => {
    const cero = { top: 0, bottom: 0, left: 0, right: 0 };
    expect(ladoPopover({ banderin: cero, contenedor: cero })).toEqual({ arriba: false, izq: false });
    expect(ladoPopover({ banderin: banderin(10, 10), contenedor: null }))
      .toEqual({ arriba: false, izq: false });
    expect(ladoPopover()).toEqual({ arriba: false, izq: false });
  });

  it('respeta el tamaño del popover que le pasen', () => {
    const b = banderin(120, 700);
    expect(ladoPopover({ banderin: b, contenedor: CONT, ancho: 280 }).izq).toBe(false);
    expect(ladoPopover({ banderin: b, contenedor: CONT, ancho: 400 }).izq).toBe(true);
  });
});

describe('celdaEquivalente (L11, CA-48/CA-49)', () => {
  // La única definición de "cambió" de la pantalla. Que sea una sola es lo que hace que el conjunto
  // de editadas (`setCelda`), el body del POST (`calcularDiff`) y el "hay cambios sin guardar" no
  // puedan discrepar — que es de donde salieron H50 y H52.

  it('dos celdas ausentes son equivalentes: teclear y deshacer no deja nada que mandar', () => {
    expect(celdaEquivalente(undefined, undefined)).toBe(true);
    expect(celdaEquivalente(null, undefined)).toBe(true);
  });

  it('una celda que existe de un solo lado NO es equivalente', () => {
    expect(celdaEquivalente({ cantidad: 20 }, undefined)).toBe(false);  // INSERT
    expect(celdaEquivalente(undefined, { cantidad: 20 })).toBe(false);  // vaciar (C6)
  });

  it('solo mira cantidad y detalle: la metadata refrescada del server no es un cambio (H52)', () => {
    const delOperador = celda({ cantidad: 22, detalle: 'Tolva atascada' });
    const delServer = celda({
      cantidad: 22,
      detalle: 'Tolva atascada',
      modificado_en: '2026-08-27T12:00:00.000Z',
      valor_sis: 19,
      sis_actualizado_en: '2026-08-27T12:00:00.000Z',
      es_override: true,
      consumo_id: 777,
    });
    expect(celdaEquivalente(delOperador, delServer)).toBe(true);
  });

  it('cambiar la cantidad o el detalle sí rompe la equivalencia', () => {
    const base = { cantidad: 20, detalle: null };
    expect(celdaEquivalente({ cantidad: 21, detalle: null }, base)).toBe(false);
    expect(celdaEquivalente({ cantidad: 20, detalle: 'Nota' }, base)).toBe(false);
  });

  it('`detalle` ausente y `detalle: null` son lo mismo (el buffer no siempre trae la clave)', () => {
    expect(celdaEquivalente({ cantidad: 20 }, { cantidad: 20, detalle: null })).toBe(true);
  });

  it('no distingue el número del string: el server puede mandar la cantidad como texto', () => {
    expect(celdaEquivalente({ cantidad: 20 }, { cantidad: '20', detalle: null })).toBe(true);
  });
});

describe('ladoPopover · lo pegajoso no es espacio libre (L11, CA-51)', () => {
  // `.comb-scroll` recorta, pero sus ~34 px de arriba los ocupa el `thead` (`position:sticky`) y su
  // izquierda la columna de periodos. Contarlos como aire hacía que el popover volteado se pintara
  // ENCIMA de la cabecera (gana por `z-index:5` contra el `2` del `thead`), que es exactamente el
  // recorte que voltearlo venía a evitar.
  const banderin = (top, left) => ({ top, bottom: top + 14, left, right: left + 14 });

  it('con la cabecera descontada el popover ya no voltea contra ella', () => {
    // Recuadro bajo (160 px) con 34 px de cabecera pegajosa. Debajo del banderín quedan 66 px
    // (menos que los 120 del popover) y arriba 80 — pero 34 de esos 80 son el `thead`: libres solo
    // 46, o sea MENOS que abajo. Voltear sería pintar sobre los nombres de columna.
    const CONT_BAJO = { top: 100, bottom: 260, left: 0, right: 1000 };
    const b = banderin(180, 40);
    expect(ladoPopover({ banderin: b, contenedor: CONT_BAJO }).arriba).toBe(true);
    expect(ladoPopover({ banderin: b, contenedor: CONT_BAJO, margenArriba: 34 }).arriba).toBe(false);
  });

  it('con la primera columna descontada tampoco voltea hacia ella', () => {
    // Contenedor angosto (300 px) con 150 px de columna de periodos pegada a la izquierda.
    const CONT_ANGOSTO = { top: 100, bottom: 500, left: 0, right: 300 };
    const b = banderin(120, 200);
    expect(ladoPopover({ banderin: b, contenedor: CONT_ANGOSTO }).izq).toBe(true);
    expect(ladoPopover({ banderin: b, contenedor: CONT_ANGOSTO, margenIzquierda: 150 }).izq).toBe(false);
  });

  it('los márgenes son 0 por defecto: sin medida no cambia ninguna decisión previa', () => {
    const CONT = { top: 100, bottom: 500, left: 0, right: 1000 };
    const b = banderin(460, 900);
    expect(ladoPopover({ banderin: b, contenedor: CONT }))
      .toEqual(ladoPopover({ banderin: b, contenedor: CONT, margenArriba: 0, margenIzquierda: 0 }));
    expect(ladoPopover({ banderin: b, contenedor: CONT })).toEqual({ arriba: true, izq: true });
  });

  it('un margen que se come el recuadro entero deja el lado por defecto, no uno peor', () => {
    // No hay lado bueno: con la cabecera tapando todo el aire de arriba, quedarse abajo es al menos
    // predecible (misma regla que el contenedor más chico que el popover).
    const CONT_BAJO = { top: 100, bottom: 260, left: 0, right: 1000 };
    expect(ladoPopover({ banderin: banderin(180, 40), contenedor: CONT_BAJO, margenArriba: 160 }))
      .toEqual({ arriba: false, izq: false });
  });
});
