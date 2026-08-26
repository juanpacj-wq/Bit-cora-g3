# server/migrations — migraciones nuevas, un archivo por código (desde la metodología v2)

Las migraciones históricas (`F12.A` … `F34.A1`) viven inline en `server/db.js` y **no se mueven**.
Desde D-061 cada migración nueva va en su propio archivo para que el lote que la escribe no deje
`db.js` a medias mientras otros chats lo importan (punto de contacto mínimo: una línea).

## Convención

- Archivo: `server/migrations/FNN.XN.js` (p. ej. `F35.A1.js`), con el código **reservado en el plan**
  de la implementación (`_CONTEXTO-BASE.md §7`) y verificado libre en todas las ramas
  (`git grep -h "F[0-9][0-9]\.[A-Z][0-9]*" $(git branch --format='%(refname:short)') -- server/db.js server/migrations`)
  y en `bitacora.migracion_aplicada` de ambas BD.
- Exporta `export default async function F35A1(db, sql) { … }`: idempotente por
  `IF NOT EXISTS (SELECT 1 FROM bitacora.migracion_aplicada WHERE codigo='F35.A1')`, DDL con
  `IF COL_LENGTH`/`IF OBJECT_ID`, transacción `sql.Transaction` con rollback en `catch`, y al final
  `INSERT INTO bitacora.migracion_aplicada (codigo) VALUES ('F35.A1')` + un `console.log('[F35.A1] …')`
  con el conteo real de filas tocadas (ese log es la evidencia en `journalctl` al desplegar).
- Si toca `registro_historico` (excepción a RF-032): respaldo residente `*_backup_DNNN` creado ANTES,
  nunca borrado (precedente D-053/D-056).
- Se engancha en `db.js` con **una sola línea** al final de `initDB()`, antes de `[DB] Conexión OK`:
  `await (await import('./migrations/F35.A1.js')).default(db, sql);`
- Documentación: sección técnica + changelog en `BIT-MODBD-2026-001.md` (versión reservada) y ADR.

## Arranques sin migraciones

`SKIP_INITDB=1` hace que `initDB()` no ejecute DDL, seeds ni migraciones (solo abre el pool). Lo usan
los backends efímeros de los lotes que **no** son dueños de `db.js` en la ola, para que tres servers
paralelos no apliquen la misma migración a la vez contra `PortalG3_dev` (el flag de
`migracion_aplicada` no es atómico entre procesos). El server del dueño arranca sin el flag y bajo
test-lock. Nunca se usa en producción.
