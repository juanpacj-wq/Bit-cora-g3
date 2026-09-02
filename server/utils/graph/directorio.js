/**
 * D-065 (contrato C3): directorio de Entra y aprovisionamiento de `lov_bit.usuario`.
 *
 * `leerDirectorioEntra()` arma, desde Graph, quién está asignado a la Enterprise App y con qué App
 * Role. `sincronizarDirectorio()` baja eso a `lov_bit.usuario`. Las dos son la raíz del módulo de
 * rotación: sin ellas la superficie A no sabe a quién repartir en los grupos.
 *
 * ── Por qué el match es SOLO por `azure_oid` ─────────────────────────────────────────────────
 * En producción hay 13 personas duplicadas (una fila legacy `atafur` + una fila Entra
 * `atafur@GECELCA.COM.CO`) y los nombres del Excel traen typos. Un `MERGE ... ON nombre_completo`
 * o `ON username` fusionaría filas que no son la misma persona, o crearía una tercera. El
 * `azure_oid` es el MISMO identificador con el que `auth/provision.js` auto-aprovisiona en el
 * login (D-031): al usarlo acá, la persona que entre por primera vez calza con la fila que dejó
 * esta sincronización en vez de crear otra. Los duplicados preexistentes no se tocan: no se
 * borran, no se fusionan. Este flujo no los arregla.
 *
 * ── Qué NO escribe esta sincronización, a propósito ──────────────────────────────────────────
 *  · `activo` de una fila que ya existe. La desactivación local es pegajosa (AUD-22): el login
 *    dejó de re-activar en cada entrada y esto tampoco lo hace. En el alta sí se respeta el
 *    `accountEnabled` de Entra — nadie debería nacer activo si Entra lo tiene deshabilitado.
 *  · `es_jefe_planta` / `es_jdt_default`. Son singletons por UPN con dos escritores ya definidos
 *    (`enforceSingletonFlag` en cada arranque y `provisionEntraUser` en cada login). Un tercer
 *    escritor sobre un singleton solo agrega maneras de romperlo, y este correría sobre 81 filas
 *    de una — el radio de daño de un `.env` mal configurado no es comparable.
 *  · `email`. No está en el `$select` medido contra el tenant y tampoco en el shape del contrato;
 *    lo llena el login desde el id_token.
 *  · El cargo. `lov_bit.usuario` no tiene `cargo_id`: el cargo llega del App Role en cada login
 *    (D-031). El directorio devuelve `role`/`cargo_nombre` para que el módulo agrupe, y ahí queda.
 *  · Un `NULL` encima de `azure_upn`/`azure_tid` que ya existían (L11, CR-1). Si Graph devuelve a
 *    alguien sin `userPrincipalName` (soft-deleted, cuenta B2B, `$select` recortado por el tenant)
 *    la fila conserva el UPN que tenía: `azure_upn` es la entrada de `enforceSingletonFlag`, y con
 *    NULL ahí el siguiente arranque degradaría al Jefe de Planta hasta su próximo login.
 */

import sql from 'mssql';
import { ROLE_TO_CARGO, PRECEDENCE } from '../entra-roles.js';
import {
  ROLE_DEFAULT_ACCESS,
  errEntra,
  esGuid,
  graphGet,
  graphGetTodo,
  leerConfigEntra,
  nuevoPresupuesto429,
  obtenerToken,
} from './cliente.js';

// Topes de las columnas de lov_bit.usuario (VARCHAR(200)/VARCHAR(50)/VARCHAR(64)).
const MAX_NOMBRE = 200;
const MAX_USERNAME = 50;
const MAX_UPN = 200;

/**
 * Personas por transacción en `sincronizarDirectorio` (L11, CR-3). Cada `MERGE … WITH (HOLDLOCK)`
 * toma un range lock sobre su clave de match que vive hasta el COMMIT: con las ~89 personas en UNA
 * transacción se acumulaban ~89 range locks y el login de cualquiera de ellas esperaba a que
 * terminara la sincronización entera — justo el bloqueo que el HOLDLOCK dice evitar. Por tramos,
 * cada lock vive los milisegundos de su tramo y la protección anti-doble-INSERT (AUD-30) es la
 * misma: sigue siendo el HOLDLOCK del MERGE, statement a statement.
 */
export const TRAMO_SYNC = 20;

/**
 * Rol efectivo de una persona que está en varios grupos.
 *
 * Es la MISMA regla que aplica el login (`resolveCargo`, D-031): gana el de mayor capacidad según
 * `PRECEDENCE`. Tiene que ser la misma o el directorio sentaría a alguien en un rol que su sesión
 * nunca va a tener — y la rotación quedaría comparando "quién debía estar" contra un cargo
 * imposible. Si ninguno de sus roles está en `PRECEDENCE` se elige uno determinista (orden
 * alfabético) para que `role` siga siendo un string y el resultado no dependa del orden en que
 * Graph devolvió las asignaciones.
 */
function rolPorPrecedencia(roles) {
  for (const role of PRECEDENCE) {
    if (roles.has(role)) return role;
  }
  return [...roles].sort()[0] || ROLE_DEFAULT_ACCESS;
}

/**
 * Mediana entera de una lista de tamaños, con piso 1. Es el peso que se le da a un grupo que NO se
 * pudo leer (CR2-4): la mediana resiste al grupo vacío y al gigante mucho mejor que el promedio, y
 * el piso 1 evita que "no se leyó ningún grupo" haga costar 0 a los omitidos. Lista vacía → 1.
 */
function medianaEntera(tamanos) {
  if (!tamanos.length) return 1;
  const orden = [...tamanos].sort((a, b) => a - b);
  const mitad = Math.floor(orden.length / 2);
  const mediana = orden.length % 2 ? orden[mitad] : Math.round((orden[mitad - 1] + orden[mitad]) / 2);
  return Math.max(1, mediana);
}

/** Acumula una persona de Graph bajo su oid, sumando el rol de esta asignación. */
function acumularPersona(porOid, usuarioGraph, role) {
  const oid = String(usuarioGraph?.id || '').trim();
  if (!oid) return;

  const previo = porOid.get(oid);
  if (previo) {
    previo.roles.add(role);
    return;
  }
  porOid.set(oid, {
    azure_oid: oid,
    nombre: String(usuarioGraph.displayName || '').trim(),
    upn: String(usuarioGraph.userPrincipalName || '').trim(),
    // accountEnabled ausente se trata como habilitado: es lo que asume Graph cuando no se pide.
    activo: usuarioGraph.accountEnabled !== false,
    roles: new Set([role]),
  });
}

/**
 * Consulta Graph y devuelve el directorio de la Enterprise App. NO escribe en BD.
 *
 * @returns {Promise<{
 *   personas: Array<{ azure_oid: string, nombre: string, upn: string, activo: boolean,
 *                     role: string, cargo_nombre: string|null }>,
 *   grupos:   Array<{ nombre: string, role: string, miembros: number }>,
 *   omitidas: { total: number, grupos: number, usuarios: number, personas_estimadas: number },
 * }>}
 * @throws {Error} con `.codigo = 'entra_no_disponible'` si falta credencial o Graph no responde.
 */
export async function leerDirectorioEntra({ fetchImpl = fetch } = {}) {
  const { clientId } = leerConfigEntra();
  const token = await obtenerToken({ fetchImpl });
  // UNA bolsa de espera por 429 para las ~16 peticiones de esta lectura (CR2-13): el tope por
  // llamada no acota la operación, y esta corre dentro de la petición HTTP del administrador.
  const presupuesto = nuevoPresupuesto429();

  // 1. El service principal de la Enterprise App: de ahí salen los appRoles (id -> value).
  //    `clientId` ya pasó por GUID_RE en leerConfigEntra, así que el $filter no es interpolable.
  const sps = await graphGetTodo(
    `/servicePrincipals?$filter=appId eq '${clientId}'&$select=id,displayName,appRoles`,
    { fetchImpl, token, presupuesto },
  );
  const sp = sps[0];
  if (!sp?.id) throw errEntra('el service principal de M365_CLIENT_ID no existe o no es visible');

  const valuePorRoleId = new Map(
    (Array.isArray(sp.appRoles) ? sp.appRoles : [])
      .filter((r) => r?.id && r?.value)
      .map((r) => [String(r.id), String(r.value)]),
  );

  // 2. A quién está asignada la app (grupos y usuarios directos).
  const asignaciones = await graphGetTodo(
    `/servicePrincipals/${sp.id}/appRoleAssignedTo?$top=999`,
    { fetchImpl, token, presupuesto },
  );

  const grupos = [];
  const porOid = new Map();

  // Tolerancia POR ASIGNACIÓN (L11, CR-2). Entra conserva la appRoleAssignment de una persona
  // borrada hasta 30 días: su GET /users/{id} responde 404, y un 429 puede caer en cualquier
  // grupo. Antes, UNA de esas abortaba la lectura de las 89 personas. Ahora la asignación que
  // falla se omite y se cuenta; las dos lecturas de arriba (SP y asignaciones) siguen siendo
  // globales, porque sin ellas no hay nada que tolerar. El umbral está más abajo.
  let intentadas = 0;
  let omitidas = 0;
  // Desagregado por tipo de asignación (CR2-4): una de USUARIO vale exactamente una persona y se
  // sabe cuál; una de GRUPO vale N personas y N es justo lo que no se pudo leer.
  let omitidasGrupo = 0;
  let omitidasUsuario = 0;
  const tamanoGruposLeidos = [];

  for (const asignacion of asignaciones) {
    // Un appRoleId que no está entre los appRoles del SP es el "Default Access" de Entra.
    const role = valuePorRoleId.get(String(asignacion?.appRoleId)) || ROLE_DEFAULT_ACCESS;
    const principalId = String(asignacion?.principalId || '').trim();
    // El id viene de Graph, pero se interpola en una URL: se valida igual (defensa en profundidad).
    if (!esGuid(principalId)) continue;

    if (asignacion.principalType === 'Group') {
      // `transitiveMembers/microsoft.graph.user` aplana los grupos anidados y descarta lo que no
      // sea persona. Un grupo vacío devuelve [] y eso NO es un error: COORDINADOR_CARBON_MAQUINARIA
      // y ADMINISTRADOR_DEBUGGING están vacíos hoy y así se reporta, sin ruido.
      intentadas++;
      let miembros;
      try {
        miembros = await graphGetTodo(
          `/groups/${principalId}/transitiveMembers/microsoft.graph.user`
            + `?$select=id,displayName,userPrincipalName,accountEnabled&$top=999`,
          { fetchImpl, token, presupuesto },
        );
      } catch (e) {
        if (e?.codigo !== 'entra_no_disponible') throw e;
        omitidas++;
        omitidasGrupo++;
        continue;
      }
      tamanoGruposLeidos.push(miembros.length);
      grupos.push({
        nombre: String(asignacion.principalDisplayName || '').trim(),
        role,
        miembros: miembros.length,
      });
      for (const miembro of miembros) acumularPersona(porOid, miembro, role);
      continue;
    }

    if (asignacion.principalType === 'User') {
      // La asignación directa trae principalId y principalDisplayName, pero NO el UPN ni
      // accountEnabled — y sin UPN no hay `username` que insertar. Por eso hace falta este GET,
      // que no está entre los cuatro pasos medidos: sin él la única asignación directa del tenant
      // (el Gerente de Producción) entraría al directorio a medias.
      intentadas++;
      let usuario;
      try {
        usuario = await graphGet(
          `/users/${principalId}?$select=id,displayName,userPrincipalName,accountEnabled`,
          { fetchImpl, token, presupuesto },
        );
      } catch (e) {
        if (e?.codigo !== 'entra_no_disponible') throw e;
        omitidas++;
        omitidasUsuario++;
        continue;
      }
      acumularPersona(porOid, usuario, role);
    }
    // Otro principalType (ServicePrincipal): no es una persona, se ignora.
  }

  // Umbral: si se perdió demasiada gente, no es un directorio con huecos sino Graph fallando (token
  // vencido a mitad de camino, permisos retirados, caída), y un directorio a medias que PARECE
  // válido es peor que un 503: el administrador concluiría que la gente desapareció. Por debajo del
  // umbral se tolera porque el consumidor es seguro: la sincronización solo escribe a quien SÍ vio;
  // nunca desactiva ni borra a quien faltó.
  //
  // Se mide en PERSONAS, no en asignaciones (CR2-4). Contar asignaciones trata igual al grupo de 14
  // y a la asignación directa de una sola persona, así que perder los grupos grandes podía devolver
  // 200 con 20 personas de 81 y el único rastro era una línea en el log. Cada grupo omitido se pesa
  // por la MEDIANA de los que sí se leyeron (mínimo 1): es una COTA, no una medida —el tamaño real
  // del grupo es justo lo que no se pudo leer—, y por eso el número también viaja en la respuesta,
  // para que la pantalla lo muestre en vez de prometer un total de antemano.
  // Se conserva además el umbral viejo por asignaciones: este cambio nunca es MÁS permisivo.
  const personasLeidas = porOid.size;
  const medianaGrupo = medianaEntera(tamanoGruposLeidos);
  const personasOmitidas = omitidasUsuario + omitidasGrupo * medianaGrupo;
  const omitidasResumen = {
    total: omitidas,
    grupos: omitidasGrupo,
    usuarios: omitidasUsuario,
    personas_estimadas: personasOmitidas,
  };
  if (omitidas > 0 && (personasOmitidas > personasLeidas || omitidas * 2 > intentadas)) {
    throw errEntra(
      `${omitidas} de ${intentadas} asignaciones fallaron `
      + `(≈${personasOmitidas} personas perdidas frente a ${personasLeidas} leídas)`,
    );
  }
  if (omitidas > 0) {
    // Solo conteos: ni el id del principal ni el nombre del grupo.
    console.warn(
      `[graph] directorio: ${omitidas} de ${intentadas} asignaciones omitidas por error de Graph `
      + `(${omitidasGrupo} grupos, ${omitidasUsuario} usuarios; ≈${personasOmitidas} personas)`,
    );
  }

  const personas = [...porOid.values()].map((p) => {
    const role = rolPorPrecedencia(p.roles);
    return {
      azure_oid: p.azure_oid,
      nombre: p.nombre,
      upn: p.upn,
      activo: p.activo,
      role,
      // null = el App Role no está en el mapa (Default Access incluido): esa persona aparece
      // asignada pero no puede entrar (D-031).
      cargo_nombre: ROLE_TO_CARGO[role] ?? null,
    };
  });

  // Solo conteos. Nunca nombres, UPNs ni el cuerpo de la respuesta.
  console.log(`[graph] directorio: ${grupos.length} grupos, ${personas.length} personas`);

  return { personas, grupos, omitidas: omitidasResumen };
}

/**
 * Resuelve el `username` de una persona nueva.
 *
 * `username` es VARCHAR(50) NOT NULL UNIQUE y el login usa el UPN (`auth/provision.js`), así que
 * acá se usa el mismo para que las dos vías coincidan. Dos casos lo vuelven imposible: que el UPN
 * recortado a 50 ya lo tenga OTRA fila (una legacy sin `azure_oid`, o dos UPNs largos que recortan
 * igual dentro del mismo lote). Ahí se cae al `azure_oid`, que es un GUID y por definición no
 * choca — es el mismo fallback que ya tiene `provisionEntraUser` cuando no hay UPN. Sin esto, una
 * sola colisión reventaría la transacción y tumbaría la sincronización de las 81 personas.
 */
function resolverUsername(upn, oid, dueñoPorUsername) {
  const preferido = (upn || oid).slice(0, MAX_USERNAME);
  const dueño = dueñoPorUsername.get(preferido.toLowerCase());
  const username = (dueño === undefined || dueño === oid) ? preferido : oid.slice(0, MAX_USERNAME);
  // Se reserva dentro del lote: si no, dos UPNs que recortan igual chocarían entre ellos.
  dueñoPorUsername.set(username.toLowerCase(), oid);
  return username;
}

/**
 * Aprovisiona/actualiza `lov_bit.usuario` por `azure_oid`. NUNCA crea una fila si ya existe una con
 * ese `azure_oid`; NUNCA hace match por nombre ni por username.
 *
 * Escribe por tramos de `TRAMO_SYNC` personas, cada tramo en su propia transacción. Si un tramo
 * falla, los anteriores quedan commiteados y se lanza: no es un problema porque la sincronización
 * es idempotente (MERGE por oid) y la siguiente corrida completa lo que faltó; los conteos solo se
 * devuelven cuando terminaron todos los tramos.
 *
 * @param {import('mssql').ConnectionPool} pool
 * @param {{ por_usuario?: number|null, directorio?: object|null, fetchImpl?: Function }} opciones
 *   `directorio` permite pasar una lectura ya hecha (o capturada, en tests) y saltarse la red.
 * `omitidas` viaja hasta la respuesta HTTP a propósito (CR2-4): un 200 con menos gente de la
 * esperada es indistinguible de un 200 completo si el único rastro es una línea en el log, y la
 * pantalla necesita poder decir "faltaron N" en vez de prometer un total de antemano.
 *
 * @returns {Promise<{ creados: number, actualizados: number, total: number,
 *                     por_rol: Record<string, number>,
 *                     omitidas: { total: number, grupos: number, usuarios: number,
 *                                 personas_estimadas: number } }>}
 */
export async function sincronizarDirectorio(pool, { por_usuario = null, directorio = null, fetchImpl = fetch } = {}) {
  const dir = directorio || await leerDirectorioEntra({ fetchImpl });
  const personas = (Array.isArray(dir?.personas) ? dir.personas : [])
    .filter((p) => String(p?.azure_oid || '').trim());
  // Un `directorio` inyectado (tests) puede no traerlo: sin omisiones que reportar, cero.
  const omitidas = dir?.omitidas ?? { total: 0, grupos: 0, usuarios: 0, personas_estimadas: 0 };

  const por_rol = {};
  for (const p of personas) {
    const role = p.role || ROLE_DEFAULT_ACCESS;
    por_rol[role] = (por_rol[role] || 0) + 1;
  }

  // El tenant es el mismo para todos (es el de la app), no viene por persona desde Graph.
  const tenantId = String(process.env.M365_TENANT_ID || '').trim() || null;

  let creados = 0;
  let actualizados = 0;

  // Una sola lectura de los usernames ya tomados (la tabla tiene ~120 filas). Sirve para resolver
  // colisiones sin ir a la BD por persona. Sin hints de lock: un UPDLOCK sobre toda la tabla
  // bloquearía los logins mientras dura la sincronización.
  const tomados = await pool.request().query('SELECT username, azure_oid FROM lov_bit.usuario');
  const dueñoPorUsername = new Map(
    tomados.recordset.map((r) => [String(r.username).toLowerCase(), r.azure_oid]),
  );

  for (let desde = 0; desde < personas.length; desde += TRAMO_SYNC) {
    const tramo = personas.slice(desde, desde + TRAMO_SYNC);

    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      for (const persona of tramo) {
        const oid = String(persona.azure_oid).trim();
        const upn = String(persona.upn || '').trim().slice(0, MAX_UPN);
        // Dos nombres, no uno (CR2-9). `nombre` es lo que Graph dijo: `null` si no dijo nada, para
        // que el UPDATE lo respete con COALESCE en vez de pisar el nombre bueno que la BD ya tiene
        // con el UPN —o peor, con el GUID crudo— cada vez que `displayName` llegue vacío (cuenta
        // B2B, soft-deleted, $select recortado por el tenant). Es la misma forma de fallo que L11
        // blindó para azure_upn/azure_tid, dos líneas más abajo.
        // `nombre_alta` es la cadena de respaldo y solo se usa en el INSERT, donde la columna es
        // NOT NULL y no hay nada previo que conservar.
        const nombre = String(persona.nombre || '').trim().slice(0, MAX_NOMBRE) || null;
        const nombreAlta = (nombre || upn || oid).slice(0, MAX_NOMBRE);
        const username = resolverUsername(upn, oid, dueñoPorUsername);

        const r = await new sql.Request(tx)
          .input('oid', sql.VarChar(64), oid)
          .input('upn', sql.VarChar(200), upn || null)
          .input('tid', sql.VarChar(64), tenantId)
          .input('nombre', sql.VarChar(200), nombre)
          .input('nombre_alta', sql.VarChar(200), nombreAlta)
          .input('username', sql.VarChar(50), username)
          .input('activo', sql.Bit, persona.activo === false ? 0 : 1)
          .query(`
            -- HOLDLOCK como en provisionEntraUser (AUD-30): toma un range lock sobre la clave de
            -- match para que esta sincronización y el primer login de la misma persona no vean los
            -- dos "no existe" e intenten INSERT a la vez (violación de UQ_usuario_oid).
            MERGE lov_bit.usuario WITH (HOLDLOCK) AS t
            USING (VALUES (@oid)) AS s (azure_oid) ON t.azure_oid = s.azure_oid
            WHEN MATCHED THEN UPDATE SET
              -- L12 (CR2-9): un displayName vacío en Graph NO borra el nombre que la BD ya tiene.
              -- Sin el COALESCE, la fila quedaba con el UPN —o con el GUID— como nombre completo,
              -- que es lo que se ve en el panel de conectados y en todo el histórico.
              nombre_completo = COALESCE(@nombre, t.nombre_completo),
              -- L11 (CR-1): un UPN o tenant ausente en Graph NO borra el que la BD ya tiene.
              -- azure_upn es la entrada de enforceSingletonFlag: con NULL acá, el siguiente
              -- arranque degradaría al Jefe de Planta hasta su próximo login.
              azure_upn       = COALESCE(@upn, t.azure_upn),
              azure_tid       = COALESCE(@tid, t.azure_tid)
            WHEN NOT MATCHED THEN INSERT
              (nombre_completo, username, email, password_hash, azure_oid, azure_upn, azure_tid,
               es_jefe_planta, es_jdt_default, activo)
              VALUES (@nombre_alta, @username, NULL, NULL, @oid, @upn, @tid, 0, 0, @activo)
            OUTPUT $action AS accion;
          `);

        // $action es la fuente autoritativa: un conteo derivado de la lectura previa mentiría si
        // un login aprovisionó a la misma persona entre esa lectura y este MERGE.
        const accion = r.recordset[0]?.accion;
        if (accion === 'INSERT') creados++;
        else if (accion === 'UPDATE') actualizados++;
      }

      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch { /* rollback best-effort */ }
      throw err;
    }
  }

  // Solo conteos y el id de quien la disparó. Nunca nombres ni UPNs.
  console.log(
    `[graph] sync: ${personas.length} personas, ${creados} creados, ${actualizados} actualizados`
    + `${omitidas.total > 0 ? `, ${omitidas.total} asignaciones omitidas` : ''}`
    + `${por_usuario != null ? ` (por usuario_id=${por_usuario})` : ''}`,
  );

  return { creados, actualizados, total: personas.length, por_rol, omitidas };
}
