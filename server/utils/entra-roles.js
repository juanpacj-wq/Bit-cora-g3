/**
 * Mapeo App Role de Entra ID → cargo local (lov_bit.cargo.nombre) + resolución por precedencia.
 *
 * Los 14 App Roles (claim `roles`, por su `value`) calzan 1:1 con los 14 cargos sembrados en
 * db.js. Como la selección manual de cargo se ELIMINÓ, cuando el token trae varios roles (un
 * usuario en varios grupos) elegimos UNO por jerarquía fija (PRECEDENCE): gana la mayor
 * capacidad. El set completo de roles se registra aparte para auditoría.
 *
 * ADMINISTRADOR_DEBUGGING (D-039): rol de administrador/debugging para pruebas funcionales. NO es
 * un superusuario por código — se modela como un cargo real más ('Administrador y Debugging') que
 * tiene todos los permisos por la MISMA matriz data-driven que el resto (blindado ante auditoría:
 * cero bypass, toda acción atribuida). Gana por precedencia sobre cualquier otro rol.
 */

// value de App Role → nombre EXACTO del cargo en lov_bit.cargo (MERGE en db.js).
export const ROLE_TO_CARGO = {
  ADMINISTRADOR_DEBUGGING:       'Administrador y Debugging',
  GERENTE_PRODUCCION:            'Gerente de Producción',
  JEFE_DE_TURNO:                 'Ingeniero Jefe de Turno',
  INGENIERO_OPERACION:           'Ingeniero de Operación',
  INGENIERO_QUIMICO:             'Ingeniero Químico',
  OPERADOR_PLANTA_CALDERA:       'Operador de Planta - Caldera',
  OPERADOR_PLANTA_ANALISTA:      'Operador de Planta - Analista',
  OPERADOR_PLANTA_SDM:           'Operador de Planta - Sala de Mando',
  OPERADOR_PLANTA_PDA:           'Operador de Planta - Planta de Agua',
  OPERADOR_PLANTA_TURBOGRUPO:    'Operador de Planta - Turbogrupo',
  OPERADOR_PLANTA_MAQUINARIA:    'Operador Maquinaria Pesada',
  OPERADOR_PLANTA_CYC:           'Operador de Planta - Carbón y Caliza',
  COORDINADOR_CARBON_MAQUINARIA: 'Coordinador de carbón y maquinaria',
  USUARIO_CONSULTA:              'USUARIO DE CONSULTA',
};

// Jerarquía: a mayor capacidad, mayor precedencia. Admin (acceso total) va PRIMERO para que gane
// si coexiste con cualquier otro rol. Gerente (solo lectura) queda al final para que cualquier rol
// operativo gane si coexisten. Entre operadores el orden es indistinto (un usuario rara vez tiene
// dos roles de operador), pero se fija para que la elección sea determinista.
// D-059: USUARIO_CONSULTA (observador invisible, aún menos capacidad que Gerente) va ÚLTIMO —
// cualquier otro rol gana si coexisten.
export const PRECEDENCE = [
  'ADMINISTRADOR_DEBUGGING',
  'JEFE_DE_TURNO',
  'INGENIERO_OPERACION',
  'INGENIERO_QUIMICO',
  'COORDINADOR_CARBON_MAQUINARIA',
  'OPERADOR_PLANTA_CYC',
  'OPERADOR_PLANTA_CALDERA',
  'OPERADOR_PLANTA_ANALISTA',
  'OPERADOR_PLANTA_SDM',
  'OPERADOR_PLANTA_PDA',
  'OPERADOR_PLANTA_TURBOGRUPO',
  'OPERADOR_PLANTA_MAQUINARIA',
  'GERENTE_PRODUCCION',
  'USUARIO_CONSULTA',
];

/**
 * Resuelve el cargo de la sesión a partir de los App Roles del usuario.
 * @param {string[]} roles  claim `roles` ya normalizado (detectRoles()).
 * @returns {{ role: string, cargoNombre: string } | null}  el rol/cargo elegido, o null si
 *          ninguno de los roles del usuario está en el mapa (→ el caller responde 403).
 */
export function resolveCargo(roles) {
  const set = new Set(Array.isArray(roles) ? roles : []);
  for (const role of PRECEDENCE) {
    if (set.has(role)) return { role, cargoNombre: ROLE_TO_CARGO[role] };
  }
  return null;
}
