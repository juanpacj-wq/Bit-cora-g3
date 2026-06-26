/**
 * Detección de roles (MULTI-ROL) desde los claims del id_token de Entra.
 *
 * El claim `roles` agrega TODOS los App Roles del usuario, incluidos los heredados de
 * CADA grupo de seguridad donde es miembro directo. Si la persona está en N grupos con
 * N App Roles distintos, los N valores llegan en este claim.
 *
 * Entra puede entregarlo como: array de strings (lo normal con >1 rol), string único
 * (a veces con 1 rol), o ausente (sin App Roles). Esta función normaliza los 3 casos a
 * un array de strings deduplicado y sin vacíos.
 */
export function detectRoles(claims) {
  const raw = claims && claims.roles;
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return [...new Set(arr.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim()))];
}
