// D-064 — Lector del HECHO que deja el otro repo: "el despacho económico del día siguiente llegó".
//
// La comunicación cross-repo es por BD COMPARTIDA, no por HTTP (_CONTEXTO-BASE §2): los dos repos
// viven en la misma base con esquemas distintos. El dashboard escribe `dashboard.despacho_recibido`
// y Bitácora la LEE — nunca la escribe. Ese reparto no se negocia: la regla de propiedad es lo que
// hace que ninguno de los dos pueda romperle el estado al otro.
//
// ── La conversión de zona horaria va ACÁ, y solo acá ────────────────────────────────────────────
// Hay dos relojes en juego y no coinciden:
//   · el MOTOR de la BD corre en hora Bogotá (medido: `SYSDATETIME()` = 14:41 mientras
//     `SYSUTCDATETIME()` = 19:41), y el esquema `dashboard` sella con `GETDATE()` → sus columnas
//     son hora BOGOTÁ;
//   · Bitácora guarda UTC en `fecha_evento`, `creado_en`, etc. (D-020).
// Por lo tanto `UTC = Bogotá + 5 h`, y el `DATEADD(HOUR, 5, …)` de abajo es la ÚNICA conversión de
// todo el flujo: el creador del asiento ya recibe UTC y no vuelve a tocarla. Repartirla entre dos
// módulos es el modo clásico de que el renglón salga cinco horas corrido — o, peor, de que se
// convierta dos veces y nadie lo note hasta que alguien compare el libro con el correo de XM.
//
// `fecha_despacho` sale de la BD ya como TEXTO (`CONVERT(..., 23)`), no como `Date`. A propósito:
// un `Date` de una columna DATE es medianoche UTC, y formatearlo en JS con `.toISOString()` es
// exactamente el patrón que en el otro repo corre el "hoy" al día siguiente pasadas las 19:00 (bug
// conocido, fuera de alcance). Si el día nunca se vuelve un `Date`, no hay corrimiento posible.

import sql from 'mssql';

// 'YYYY-MM-DD' estricto. Es la única forma en que entra o sale una fecha de este módulo.
const ISO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

// RN-05.c pide loguear UNA vez, no en cada tick: el sweeper corre cada 5 minutos, y mientras el
// dashboard no se despliegue la tabla NO existe — eso son ~288 líneas diarias de un mensaje que ya
// se leyó. La latch se REINICIA con la primera lectura exitosa, así que si la tabla vuelve a
// desaparecer (o la BD se cae) el aviso se emite de nuevo: silenciar para siempre sería peor que
// repetir.
let avisoEmitido = false;

// Solo para tests: devuelve la latch a su estado de arranque. Producción no la llama.
export function reiniciarAvisoDegradacion() {
  avisoEmitido = false;
}

/**
 * Los hechos "llegó el despacho" cuya `fecha_despacho` cae en `[desde, hasta]` (ambos inclusive).
 *
 * @param {sql.ConnectionPool} pool
 * @param {object} rango
 * @param {string} rango.desde  'YYYY-MM-DD'
 * @param {string} rango.hasta  'YYYY-MM-DD'
 * @param {(msg: string) => void} [rango.log]  inyectable SOLO para tests.
 * @returns {Promise<Array<{fecha_despacho: string, detectado_en: Date}>>}
 *   `detectado_en` ya viene convertido a UTC. Si la tabla no existe, o la consulta falla, o el
 *   rango es inválido: devuelve `[]` y loguea una vez — NUNCA lanza.
 *
 * El filtro es por `fecha_despacho` (la PK, el día que el despacho ANUNCIA) y no por
 * `detectado_en`: es la identidad del hecho y la misma con la que el relleno del mes pide "los días
 * de marzo". Filtrar por el instante de detección haría que un hecho detectado tarde —o repescado—
 * se saliera de la ventana de su propio día.
 *
 * Que la tabla NO exista es un estado válido y esperado, no una anomalía: Bitácora puede estar
 * desplegada antes que el dashboard, y en ese caso tiene que seguir operando exactamente como hoy.
 */
export async function leerDespachosRecibidos(pool, { desde, hasta, log = console.error } = {}) {
  const d = String(desde ?? '').trim();
  const h = String(hasta ?? '').trim();
  if (!ISO_FECHA.test(d) || !ISO_FECHA.test(h)) {
    avisar(log, `rango inválido (desde=${JSON.stringify(desde)}, hasta=${JSON.stringify(hasta)})`);
    return [];
  }

  try {
    const r = await pool.request()
      .input('desde', sql.Date, d)
      .input('hasta', sql.Date, h)
      .query(`
        SELECT CONVERT(char(10), fecha_despacho, 23) AS fecha_despacho,
               -- La ÚNICA conversión Bogotá → UTC del flujo (ver cabecera).
               DATEADD(HOUR, 5, detectado_en) AS detectado_en
        FROM dashboard.despacho_recibido
        WHERE fecha_despacho BETWEEN @desde AND @hasta
        ORDER BY fecha_despacho
      `);
    avisoEmitido = false;
    return r.recordset.map((row) => ({
      fecha_despacho: row.fecha_despacho,
      detectado_en: row.detectado_en,
    }));
  } catch (err) {
    // `Invalid object name 'dashboard.despacho_recibido'` cae acá y es el estado NORMAL mientras el
    // otro repo no se despliegue. Una BD caída o un timeout también: los tres degradan igual, porque
    // desde el punto de vista de Bitácora significan lo mismo — hoy no hay hecho que leer.
    avisar(log, `no se pudo leer dashboard.despacho_recibido: ${err?.message ?? err}`);
    return [];
  }
}

function avisar(log, detalle) {
  if (avisoEmitido) return;
  avisoEmitido = true;
  log(`[despacho-xm] ${detalle} — se sigue sin asentar (degradación esperada, RN-05.c)`);
}
