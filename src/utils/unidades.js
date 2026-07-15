// D-054 — ¿a qué unidad puede saltar esta sesión con el botón del navbar?
//
// Módulo PURO (sin React, sin red), mismo patrón que routing/appRoute.js: la regla que decide si el
// atajo existe es lo que hay que poder probar, y probarla no debería exigir montar el dashboard
// entero con auth y API mockeadas.
//
// La decisión se toma con DOS datos, ninguno hardcodeado:
//   - `sesion.puede_cambiar_unidad`: el permiso del cargo, tal como lo sirve el backend en /api/me.
//     Es EL MISMO objeto que gatea el server, así que la UI no puede ofrecer lo que el server niega.
//   - `plantas`: el catálogo (GET /api/catalogos/plantas), que ya excluye la planta de test.
//
// "La otra unidad" solo está definida si hay exactamente UNA candidata. Con 0 (catálogo aún sin
// cargar) o con 2+ (un tercer sitio algún día) devuelve null y el botón desaparece, en vez de elegir
// una al azar: un atajo ambiguo es peor que ningún atajo.

/**
 * @param {{planta_id?: string, puede_cambiar_unidad?: boolean}|null} sesion
 * @param {Array<{planta_id: string, nombre?: string}>} plantas
 * @returns {{planta_id: string, nombre?: string}|null} la unidad destino, o null si no aplica
 */
export function resolverOtraUnidad(sesion, plantas) {
  if (!sesion || !sesion.planta_id) return null;
  // Estrictamente `true`: un `1` de la BD, un string o un undefined NO habilitan el atajo.
  if (sesion.puede_cambiar_unidad !== true) return null;
  const otras = (plantas || []).filter((p) => p && p.planta_id && p.planta_id !== sesion.planta_id);
  return otras.length === 1 ? otras[0] : null;
}
