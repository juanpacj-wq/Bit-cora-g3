/**
 * Auto-aprovisionamiento de identidad desde Entra ID.
 *
 * En el primer login (y en cada login posterior, idempotente) sincronizamos el row de
 * lov_bit.usuario del usuario autenticado, keyed por su `azure_oid` (estable e inmutable en
 * Entra). Reemplaza al seed por personal-2026.json: la fuente de verdad de identidad es Entra.
 *
 * - Clave de match: azure_oid (UNIQUE filtrado UQ_usuario_oid).
 * - username = UPN (la columna username sigue siendo NOT NULL UNIQUE; el UPN cumple ambas).
 * - password_hash = NULL (no hay login local; SISTEMA es el único con centinela).
 * - Los flags singleton es_jefe_planta / es_jdt_default se fijan por UPN (no son App Roles).
 *
 * Devuelve { usuario_id, nombre_completo } para que /auth/redirect lo guarde en la sesión.
 */
import sql from 'mssql';
import { isJefePlantaUpn, isJdtDefaultUpn } from './entra-config.js';

export async function provisionEntraUser(db, { oid, upn, name, email, tid }) {
  if (!oid) throw new Error('[provisionEntraUser] falta oid (claim del id_token)');
  const nombre = (name || upn || '').trim() || upn;
  const username = (upn || oid).trim();
  const esJefe = isJefePlantaUpn(upn);
  const esJdtDefault = isJdtDefaultUpn(upn);

  const r = await db.request()
    .input('oid', sql.VarChar(64), oid)
    .input('upn', sql.VarChar(200), upn || null)
    .input('tid', sql.VarChar(64), tid || null)
    .input('nombre', sql.VarChar(200), nombre)
    .input('username', sql.VarChar(50), username.slice(0, 50))
    .input('email', sql.VarChar(200), email || null)
    .input('es_jefe', sql.Bit, esJefe)
    .input('es_jdt', sql.Bit, esJdtDefault)
    .query(`
      -- AUD-22: la rama MATCHED ya NO fuerza activo=1. Antes, cada login re-activaba a un usuario
      -- desactivado localmente (lov_bit.usuario.activo=0), anulando esa desactivación administrativa.
      -- Ahora la desactivación local es "pegajosa". activo=1 solo se fija en el alta (NOT MATCHED).
      MERGE lov_bit.usuario AS t
      USING (VALUES (@oid)) AS s (azure_oid) ON t.azure_oid = s.azure_oid
      WHEN MATCHED THEN UPDATE SET
        nombre_completo = @nombre,
        azure_upn       = @upn,
        azure_tid       = @tid,
        email           = @email,
        es_jefe_planta  = @es_jefe,
        es_jdt_default  = @es_jdt
      WHEN NOT MATCHED THEN INSERT
        (nombre_completo, username, email, password_hash, azure_oid, azure_upn, azure_tid,
         es_jefe_planta, es_jdt_default, activo)
        VALUES (@nombre, @username, @email, NULL, @oid, @upn, @tid, @es_jefe, @es_jdt, 1);

      SELECT usuario_id, nombre_completo FROM lov_bit.usuario WHERE azure_oid = @oid;
    `);
  return r.recordset[0];
}
