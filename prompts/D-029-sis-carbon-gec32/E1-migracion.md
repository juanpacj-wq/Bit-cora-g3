# E1 — Migración F27.A1 (schema)

## CONTEXTO ACUMULADO (no borrar)
- Lee primero `_CONTEXTO-BASE.md` y `ESTADO.md` de esta misma carpeta.
- Etapas previas requeridas: E0 ✅.
- Repo: `Bit-cora-g3/`. Backend ESM, MSSQL. Migraciones idempotentes gated por
  `bitacora.migracion_aplicada(codigo)`, patrón F26.B1 en `server/db.js:1637-1815`.

## Objetivo de esta etapa
Agregar el schema que soporta el valor SIS sombra y la observabilidad/resumabilidad del scraper.
**Solo schema.** No toques endpoints ni scraper todavía.

## Tareas
1. En `server/db.js`, **después** del bloque F26.B1 (cerca de `db.js:1815`, tras resolver
   `COMB_BITACORA_ID`), agregar un bloque de migración nuevo gated por flag `'F27.A1'`:
   ```js
   const f27A1Aplicada = await db.request().query(
     `SELECT 1 AS x FROM bitacora.migracion_aplicada WHERE codigo = 'F27.A1'`
   );
   if (!f27A1Aplicada.recordset[0]) {
     const tx = new sql.Transaction(db);
     await tx.begin();
     try {
       // 1. Columnas valor_sis + sis_actualizado_en (idempotentes)
       await new sql.Request(tx).batch(`
         IF NOT EXISTS (SELECT 1 FROM sys.columns
           WHERE object_id=OBJECT_ID('bitacora.consumo_combustible') AND name='valor_sis')
           ALTER TABLE bitacora.consumo_combustible ADD valor_sis DECIMAL(12,3) NULL;
       `);
       await new sql.Request(tx).batch(`
         IF NOT EXISTS (SELECT 1 FROM sys.columns
           WHERE object_id=OBJECT_ID('bitacora.consumo_combustible') AND name='sis_actualizado_en')
           ALTER TABLE bitacora.consumo_combustible ADD sis_actualizado_en DATETIME2 NULL;
       `);
       // 2. Tabla sis_scrape_log
       await new sql.Request(tx).batch(`
         IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name='sis_scrape_log' AND schema_id=SCHEMA_ID('bitacora'))
         CREATE TABLE bitacora.sis_scrape_log (
           scrape_log_id  INT IDENTITY(1,1) PRIMARY KEY,
           planta_id      VARCHAR(10) NOT NULL REFERENCES lov_bit.planta(planta_id),
           fecha          DATE        NOT NULL,
           scrape_tipo    VARCHAR(20) NOT NULL
             CONSTRAINT CK_sis_scrape_tipo CHECK (scrape_tipo IN ('horario','backfill','manual')),
           periodos_ok    TINYINT     NOT NULL DEFAULT 0,
           periodos_error TINYINT     NOT NULL DEFAULT 0,
           ultimo_periodo TINYINT     NULL,
           completo       BIT         NOT NULL DEFAULT 0,
           scraped_en     DATETIME2   NOT NULL CONSTRAINT DF_sis_scrape_en DEFAULT SYSUTCDATETIME(),
           CONSTRAINT UQ_sis_scrape_planta_fecha UNIQUE (planta_id, fecha)
         );
       `);
       // 3. Flag
       await new sql.Request(tx)
         .input('c', sql.VarChar(40), 'F27.A1')
         .query(`INSERT INTO bitacora.migracion_aplicada (codigo) VALUES (@c)`);
       await tx.commit();
       console.log('[F27.A1] valor_sis + sis_actualizado_en + sis_scrape_log creados');
     } catch (err) {
       try { await tx.rollback(); } catch {}
       throw err;
     }
   }
   ```
   - Ajusta el shape exacto del INSERT a `migracion_aplicada` según las columnas reales de esa tabla
     (revisa cómo F26.B1 inserta su flag; replica ese mismo patrón/tipos).
   - `scrape_tipo` incluye también `'manual'` (para el endpoint de disparo manual de E5).

## Prueba
- Crear `server/tests/sis_schema.test.js` (node:test) que, vía `getDB()`, verifique:
  - `sys.columns` tiene `valor_sis` y `sis_actualizado_en` en `bitacora.consumo_combustible`.
  - `sys.tables` tiene `bitacora.sis_scrape_log` con UNIQUE `(planta_id,fecha)`.
- Arrancar el server una vez (`cd server && npm run dev`) y confirmar el log `[F27.A1] ...` y que
  no hay error; segundo arranque NO debe re-aplicar (idempotencia).
- Correr `cd server && npm test` para asegurar que no se rompió nada (baseline T4/C5 flaky conocido).
- Agregar el nuevo test al script `test` de `server/package.json`.

## Al terminar
Actualiza `ESTADO.md`: marca E1 ✅, lista archivos tocados (`server/db.js`, `server/tests/sis_schema.test.js`,
`server/package.json`), resultado de tests, y cualquier desviación (p. ej. shape real de `migracion_aplicada`).
