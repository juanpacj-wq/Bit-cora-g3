// D-064 — Barrido que asienta la llegada del despacho. Cada 5 minutos lee el hecho que el dashboard
// dejó en su propio esquema y, si falta el renglón, lo escribe.
//
// ── Por qué 5 minutos y no menos ────────────────────────────────────────────────────────────────
// Es la MISMA cadencia con la que el scraper del otro repo reintenta bajar el archivo de XM
// (`despachoscraper.js`, `RETRY_MS`), y RQ-05.16 la fija así a propósito: leer más seguido no
// adelanta nada, porque el hecho no existe antes de que el scraper lo escriba. El renglón aparece,
// como mucho, cinco minutos después de la publicación.
//
// ── Por qué el sweeper NO arranca en un backend de test ─────────────────────────────────────────
// Este es el único sweeper del repo que escribe FILAS en las bitácoras de Sala de GEC3 y GEC32, y
// los backends efímeros de la suite arrancan los sweepers igual que producción (`server.js`). El día
// que el dashboard se despliegue contra la misma base, cada corrida de `npm test` dejaría asientos
// de verdad en unidades de verdad — con autor SISTEMA, indistinguibles de los buenos y, si el cierre
// de turno los archiva, imborrables (RF-032).
//
// La lección de D-061 es que un flag de apagado NO alcanza: `SIS_SWEEPER_ENABLED` existía y nadie lo
// ponía en los backends de lote, así que el daño ocurrió igual. Por eso acá el apagado en tests es
// el DEFAULT y se deriva de `bypassHabilitado()` —el mismo predicado con el que el resto del backend
// reconoce a un proceso de test (AUD-06)—, en vez de depender de que alguien recuerde exportar una
// variable. `DESPACHO_XM_SWEEPER_ENABLED` queda para las dos decisiones explícitas: `'0'` apaga
// siempre (incluido producción, para un runbook), `'1'` enciende incluso bajo el backdoor de test.
// Cualquiera de los tres caminos se ANUNCIA en el log de arranque: un sweeper mudo es
// indistinguible de uno roto.

import { bypassHabilitado } from '../../middleware/auth.js';
import { fechaBogotaStr } from '../turno.js';
import { leerDespachosRecibidos } from './lector.js';
import { crearAsientoDespacho } from './asiento.js';

const INTERVAL_MS = 5 * 60_000;   // RQ-05.16 — la cadencia del scraper del otro repo.
const ARRANQUE_MS = 15_000;       // primer tick poco después de levantar, para no competir con initDB.

// Ventana que se revisa en cada tick, en días alrededor de HOY (Bogotá) y sobre `fecha_despacho`.
// Hacia adelante 1 día porque el hecho de hoy anuncia MAÑANA; hacia atrás 2 porque un reinicio de
// hasta dos días no puede costar un renglón (el hecho de ayer anuncia hoy, el de anteayer anunciaba
// ayer). Más atrás no sale gratis —cada día es una consulta de idempotencia cada cinco minutos— y
// para eso está el relleno del mes, que corre a mano.
const DIAS_ATRAS = 2;
const DIAS_ADELANTE = 1;

let timer = null;

/**
 * ¿Puede este proceso escribir asientos? Pura y exportada para poder fijarla en un test sin arrancar
 * nada. Devuelve también el motivo, que es lo que se anuncia en el log.
 * @returns {{habilitado: boolean, motivo: string}}
 */
export function sweeperHabilitado(env = process.env) {
  if (env.DESPACHO_XM_SWEEPER_ENABLED === '0') {
    return { habilitado: false, motivo: 'DESPACHO_XM_SWEEPER_ENABLED=0' };
  }
  if (env.DESPACHO_XM_SWEEPER_ENABLED === '1') {
    return { habilitado: true, motivo: 'DESPACHO_XM_SWEEPER_ENABLED=1 (forzado)' };
  }
  if (bypassHabilitado(env)) {
    return { habilitado: false, motivo: 'AUTH_TEST_BYPASS=1 (backend de test: no escribe en plantas reales)' };
  }
  return { habilitado: true, motivo: 'por defecto' };
}

// 'YYYY-MM-DD' desplazado `dias` días (UTC-safe: la aritmética va sobre un `Date.UTC`, que no tiene
// horario de verano ni depende del reloj local de la máquina).
export function correrDias(fechaStr, dias) {
  const [y, m, d] = fechaStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dias);
  const Y = dt.getUTCFullYear();
  const M = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const D = String(dt.getUTCDate()).padStart(2, '0');
  return `${Y}-${M}-${D}`;
}

/**
 * El cuerpo de UN tick, extraído de `startDespachoXMSweeper` para poder probarlo sin timers y sin
 * red: todo lo que toca el mundo (el lector, el creador, el reloj y el logger) entra por parámetro.
 * NUNCA lanza — un throw acá se volvería un `unhandledRejection` que tumba el server.
 *
 * @returns {Promise<{revisados:number, creados:number, existentes:number, fallidos:number}>}
 */
export async function ejecutarTick({
  pool,
  leerFn = leerDespachosRecibidos,
  crearFn = crearAsientoDespacho,
  hoy = fechaBogotaStr(new Date()),
  log = (msg) => console.log(msg),
  logError = (msg) => console.error(msg),
} = {}) {
  const resumen = { revisados: 0, creados: 0, existentes: 0, fallidos: 0 };
  try {
    const desde = correrDias(hoy, -DIAS_ATRAS);
    const hasta = correrDias(hoy, DIAS_ADELANTE);
    const hechos = await leerFn(pool, { desde, hasta });
    resumen.revisados = hechos.length;

    for (const hecho of hechos) {
      try {
        const r = await crearFn(pool, {
          fecha_despacho: hecho.fecha_despacho,
          detectado_en: hecho.detectado_en,
        });
        if (r?.creado) {
          resumen.creados += 1;
          log(`[despacho-xm] asiento creado para ${hecho.fecha_despacho} (${r.filas} filas)`);
        } else {
          resumen.existentes += 1;
        }
      } catch (err) {
        // Un día malo NO puede llevarse los otros por delante. Los productores del asiento LANZAN
        // ante una fecha que no existe (hecho 2 del gate de la O1) y la BD puede fallar en medio de
        // la transacción: en los dos casos se salta ESE día, se loguea y se sigue. El próximo tick
        // lo vuelve a intentar, que es gratis gracias a la idempotencia.
        resumen.fallidos += 1;
        logError(`[despacho-xm] no se pudo asentar ${hecho?.fecha_despacho}: ${err?.message ?? err}`);
      }
    }
  } catch (err) {
    logError(`[despacho-xm] tick abortado: ${err?.message ?? err}`);
  }
  return resumen;
}

export function startDespachoXMSweeper(pool) {
  if (timer) return;
  console.log(`[despacho-xm] sweeper iniciado (cada ${INTERVAL_MS / 60_000} min)`);

  const tick = async () => {
    try {
      await ejecutarTick({ pool });
    } finally {
      timer = setTimeout(tick, INTERVAL_MS);
    }
  };

  timer = setTimeout(tick, ARRANQUE_MS);
}

export function stopDespachoXMSweeper() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
