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
