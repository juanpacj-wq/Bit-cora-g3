// npm run test:residuos — cuenta lo que una corrida de tests NO debió dejar en la BD del .env.
// Solo lectura. Exit 0 = cero residuos · 2 = hay residuos (los lista) · 1 = error.
// Lo cita el gate de cada ola (metodología v2, GATE.md §3) y el cierre de la implementación.
import { getDB, TEST_PLANTA_ID } from '../db.js';

const db = await getDB();
const q = async (sql) => (await db.request().query(sql)).recordset[0].n;

const checks = [
  ['registro_activo en planta de test', `SELECT COUNT(*) AS n FROM bitacora.registro_activo WHERE planta_id IN ('${TEST_PLANTA_ID}','TSR')`],
  ['registro_historico en planta de test', `SELECT COUNT(*) AS n FROM bitacora.registro_historico WHERE planta_id IN ('${TEST_PLANTA_ID}','TSR')`],
  ['registro_activo con TEST_TAG en detalle (planta real)', `SELECT COUNT(*) AS n FROM bitacora.registro_activo WHERE planta_id NOT IN ('${TEST_PLANTA_ID}','TSR') AND detalle LIKE '%TEST-RUN%'`],
  ['registro_historico con TEST_TAG en detalle (planta real)', `SELECT COUNT(*) AS n FROM bitacora.registro_historico WHERE planta_id NOT IN ('${TEST_PLANTA_ID}','TSR') AND detalle LIKE '%TEST-RUN%'`],
  ['sesiones sintéticas activas', `SELECT COUNT(*) AS n FROM bitacora.sesion_activa s JOIN lov_bit.usuario u ON u.usuario_id = s.usuario_id WHERE s.activa = 1 AND u.es_sintetico = 1`],
  ['conformacion_turno de usuarios sintéticos', `SELECT COUNT(*) AS n FROM bitacora.conformacion_turno c JOIN lov_bit.usuario u ON u.usuario_id = c.usuario_id WHERE u.es_sintetico = 1`],
  // D-063 (GATE-O2, hallazgo de L07): las cabeceras de turno de las plantas-fixture también son residuo
  // (sala_de_mando_batch dejaba una PROGRAMADO por corrida y nadie la contaba). Sin registros colgando no
  // rompen nada, pero se acumulan y la de TSR hace fallar `crear ×3` de reflejo_disponibilidad.
  // D-063 (GATE-O2, /code-review): la fixture del reflejo se enciende (activa=1) solo durante
  // disponibilidad_reflejo_http y la apaga su after() + el guard final; si el proceso muere entre medio,
  // TSR queda visible en el selector de unidad de producción y nadie fuera del proceso lo repone.
  ['planta TSR encendida (activa=1)', `SELECT COUNT(*) AS n FROM lov_bit.planta WHERE planta_id = 'TSR' AND activa = 1`],
  ['turno_unidad en planta de test', `SELECT COUNT(*) AS n FROM bitacora.turno_unidad WHERE planta_id IN ('${TEST_PLANTA_ID}','TSR')`],
  ['disponibilidad_estado en planta de test', `SELECT COUNT(*) AS n FROM bitacora.disponibilidad_estado WHERE planta_id IN ('${TEST_PLANTA_ID}','TSR')`],
  ['evento_dashboard en planta de test', `SELECT COUNT(*) AS n FROM bitacora.evento_dashboard WHERE planta_id IN ('${TEST_PLANTA_ID}','TSR')`],
  // D-061 (L06 · CA-28): COMB y el SIS. El gate de la O1 tuvo que contar estas dos tablas con una
  // query a mano porque el script no las miraba, y son justo las que las suites de COMB/SIS
  // escriben ahora sobre la fixture. `lov_bit.combustible` de 'TST' NO se cuenta: es un catálogo
  // RESIDENTE (seed idempotente de db.js, igual que la fila 'TST' de lov_bit.planta), no residuo.
  ['consumo_combustible en planta de test', `SELECT COUNT(*) AS n FROM bitacora.consumo_combustible WHERE planta_id IN ('${TEST_PLANTA_ID}','TSR')`],
  ['sis_scrape_log en planta de test', `SELECT COUNT(*) AS n FROM bitacora.sis_scrape_log WHERE planta_id IN ('${TEST_PLANTA_ID}','TSR')`],
  // D-065 (GATE-O1, CR-4/CR-5 → L11): las suites de rotación siembran usuarios de Entra y tocan un
  // flag de cargo, y este script no miraba ni `lov_bit.usuario` ni `lov_bit.cargo`: el gate pudo
  // decir "cero residuos" con razón y aun así no habría visto un fixture de Entra ni un flag
  // colgado. Acotadores: el namespace de oids de fixture (`00000000-d065-…`, ningún oid real de
  // Entra empieza por ceros) y el prefijo `test_rot` de username — NUNCA `nombre_completo`, que es
  // como se alcanza a una persona real (D-055). `[_]` es el escape de `_` en LIKE de T-SQL.
  ['usuarios de fixture de Entra (oid 00000000-d065-… o username test_rot%)', `SELECT COUNT(*) AS n FROM lov_bit.usuario WHERE azure_oid LIKE '00000000-d065-%' OR username LIKE 'test[_]rot%'`],
  // El flag `puede_configurar_rotacion` vive en el MERGE de cargos de db.js y vale 1 SOLO para los
  // dos cargos del contrato (§5.1); cualquier otro cargo con el flag es la ventana de CA-4(b) que
  // quedó abierta por una corrida muerta. Este check SÍ mira cargos reales a propósito: es solo
  // lectura y el residuo que busca está, por construcción, en una fila real.
  ['cargos con puede_configurar_rotacion=1 fuera de los dos del contrato', `SELECT COUNT(*) AS n FROM lov_bit.cargo WHERE puede_configurar_rotacion = 1 AND nombre NOT IN ('Administrador y Debugging', 'Gerente de Producción')`],
  // D-065 (GATE-O2, hallazgo 2 de L06): las cuatro tablas de rotación. `rotacion_control` y
  // `rotacion_cumplimiento` cuelgan de turno_unidad por FK (F37.A1/F37.A3) y se acotan por la
  // planta-fixture; patrón y asignaciones no tienen planta, así que se acotan por el autor/usuario
  // sintético (D-044) o por SISTEMA (la fixture de L06 siembra su patrón con USUARIO_SISTEMA_ID; una
  // carga anual real la hace un administrador humano por el endpoint, nunca SISTEMA).
  ['rotacion_control en planta de test', `SELECT COUNT(*) AS n FROM bitacora.rotacion_control WHERE planta_id IN ('${TEST_PLANTA_ID}','TSR')`],
  ['rotacion_cumplimiento en planta de test', `SELECT COUNT(*) AS n FROM bitacora.rotacion_cumplimiento WHERE planta_id IN ('${TEST_PLANTA_ID}','TSR')`],
  ['rotacion_patron creado por usuario sintético o SISTEMA', `SELECT COUNT(*) AS n FROM bitacora.rotacion_patron p JOIN lov_bit.usuario u ON u.usuario_id = p.creado_por WHERE u.es_sintetico = 1 OR u.username = 'SISTEMA'`],
  // D-065 (GATE-O2, /code-review CR2-5): el turno-sweeper del backend de test cierra GEC3/GEC32 sin
  // mirar AUTH_TEST_BYPASS (deuda D4 del GATE-O1) y, desde L06, cada cierre congela titulares. Si una
  // suite deja un patrón vigente para hoy justo cuando el sweeper cierra, la fila congelada de la
  // planta REAL queda con usuario_id de fixture (y después el after() borra al usuario). Por eso este
  // check mira TODAS las plantas: titulares sintéticos o inexistentes en un congelado son residuo.
  ['rotacion_cumplimiento con titulares sintéticos o inexistentes (cualquier planta)', `SELECT COUNT(*) AS n FROM bitacora.rotacion_cumplimiento rc CROSS APPLY OPENJSON(rc.titulares_json) WITH (usuario_id INT '$.usuario_id') t LEFT JOIN lov_bit.usuario u ON u.usuario_id = t.usuario_id WHERE u.usuario_id IS NULL OR u.es_sintetico = 1`],
  ['rotacion_control de usuario sintético en planta real', `SELECT COUNT(*) AS n FROM bitacora.rotacion_control rc JOIN lov_bit.usuario u ON u.usuario_id = rc.usuario_id WHERE u.es_sintetico = 1 AND rc.planta_id NOT IN ('${TEST_PLANTA_ID}','TSR')`],
  ['rotacion_asignacion de o por usuario sintético o SISTEMA', `SELECT COUNT(*) AS n FROM bitacora.rotacion_asignacion a WHERE EXISTS (SELECT 1 FROM lov_bit.usuario u WHERE (u.es_sintetico = 1 OR u.username = 'SISTEMA') AND u.usuario_id IN (a.usuario_id, a.creado_por))`],
];

let total = 0;
console.log(`[residuos] BD ${process.env.DB_NAME} · ${new Date().toISOString()}`);
for (const [nombre, sql] of checks) {
  try {
    const n = await q(sql);
    total += n;
    console.log(`  ${n === 0 ? 'ok ' : 'RES'} ${String(n).padStart(6)}  ${nombre}`);
  } catch (err) {
    console.log(`  n/a      -  ${nombre} (${err.message.split('\n')[0]})`);
  }
}
console.log(total === 0 ? '[residuos] cero residuos' : `[residuos] ${total} filas residuales — limpia con npm run test:reset-db antes de certificar`);
process.exit(total === 0 ? 0 : 2);
