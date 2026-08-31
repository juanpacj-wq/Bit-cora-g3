# D-064 — Plan de olas

> Lo escribe el integrador en la fase 2 y se commitea con el scaffolding. Es la fuente de
> `LOTES.json` y de los prompts `LNN-<slug>.md`. Solo el integrador lo edita (en un gate, con
> nota de por qué). Los lotes lo leen; no lo tocan.

## Grafo de dependencias

```
  L01 (dashboard: tabla + persistencia)  ─────┐
                                              │
  L02 (motor puro: texto + marcador)  ────────┼──> L04 (lector + creador + sweeper) ──> L05 (CLI)
                                              │
  L03 (db.js: tipo_evento · libro: colapso) ──┘
```

**Camino crítico:** `L01/L02/L03 → L04 → L05`. Los tres de la O1 son **raíces del grafo**: no
dependen de nada ni entre sí, y sus territorios no comparten un solo archivo — están hasta en
repos distintos (L01 vive en `dashboard-gen-gec3`, L02 y L03 en `Bit-cora-g3`).

**Fuera del camino crítico:** ninguno. Es una implementación chica y todo confluye en L04, que es
la piedra angular: el único lote que escribe filas.

## Olas

| Ola | Lotes | Por qué pueden ir juntos | Compartidos y su escritor |
|---|---|---|---|
| **O1** | L01, L02, L03 | Raíces del grafo, territorios disjuntos y en dos repos. L02 es **puro** (no toca BD ni levanta backend) y L01 corre vitest sin BD: solo L03 necesita el test-lock, así que **no hay contención**. | `dashboard/server/db.js` → **L01** · `utils/asientos/**` → **L02** · `Bitácora/server/db.js` y `f03-datos.js` → **L03** |
| **O2** | L04, L05 | L04 consume los tres contratos de la O1, ya verificados en el gate. **L05 declara `depende_de: ["L04"]`**: el semáforo lo hace cumplir, así que su chat se abre apenas L04 cierre — sin esperar un gate intermedio. | `server.js` → **L04** · `scripts/**` → **L05** |
| **Cierre** | `/cerrar-implementacion D-064` | — | ADR, `CLAUDE.md`, `BIT-*`, REQ-05 → integrador |

**Dos gates en total.** Se descartó una tercera ola para el CLI: agregaba un gate completo
(~40 min de suite) a una pieza que la dependencia del semáforo ya serializa sola.

## Lotes

### L01 — Persistir la llegada del despacho (repo `dashboard-gen-gec3`)

- **Ola:** O1 · **Depende de:** — · **Puro (sin BD):** sí (vitest, sin BD) · **Puerto:** no levanta backend
- **Repo:** `dashboard-gen-gec3/`, rama `feat/asiento-despacho-xm-2026-08` **nacida de `main`** (`d8f8f5e`)
- **Territorio (escritura):**
  - `server/db.js`
  - `server/despachoscraper.js`
  - `server/__tests__/despachoscraper.test.js`
  - `prompts/…/cierres/L01.md` (en el repo de Bitácora — ver nota del prompt)
- **Contratos que produce:** C1 (`dashboard.despacho_recibido`) · **que consume:** —
- **Criterios de aceptación:** CA-1 (la mitad de origen), CA-7, CA-8 (la tabla puede no existir)
- **Tests que corre:** `server/__tests__/despachoscraper.test.js`
- **Riesgo / nota:** es el **único lote del otro repo**, con historial git independiente. Su
  cambio es minúsculo (una tabla y un `INSERT` idempotente donde hoy hay un `console.log`), pero
  fija el contrato C1 que los dos lotes de la O2 leen. **No arregla el bug de `getColombiaDate()`**
  (fuera de alcance) y **no abre `emailDispatch.js`**.

### L02 — Motor del asiento de sistema (puro)

- **Ola:** O1 · **Depende de:** — · **Puro:** sí · **Puerto:** no levanta backend
- **Territorio (escritura):**
  - `server/utils/asientos/sistema.js` (nuevo)
  - `server/tests/asiento_despacho_xm.test.js` (nuevo)
  - `prompts/…/cierres/L02.md`
- **Contratos que produce:** C2 (las 7 exportaciones de `sistema.js`) · **que consume:** —
- **Criterios de aceptación:** CA-2
- **Tests que corre:** `tests/asiento_despacho_xm.test.js` (puro, sin test-lock)
- **Riesgo / nota:** **el calibrador de la ola.** Fija el vocabulario que L03, L04 y L05 importan:
  el texto literal, el marcador, la clave de agrupación y los tres predicados. Es el lote más
  corto y el más barato de verificar (todo puro), y por eso va antes que quien hereda. **No toca**
  `index.js`, `formato.js` ni `plantillas.js`: el módulo nuevo es aparte, y `UNIDAD_YA_NOMBRADA`
  queda intacto.

### L03 — Catálogo del tipo de evento y colapso en el libro

- **Ola:** O1 · **Depende de:** — · **Puro:** no (BD) · **Puerto:** **3103**
- **Territorio (escritura):**
  - `server/db.js` (**único lote que lo toca en la O1**)
  - `server/utils/f03-datos.js` (**único lote que lo toca en toda la implementación**)
  - `server/tests/f03_despacho_xm.test.js` (nuevo)
  - `prompts/…/cierres/L03.md`
- **Contratos que produce:** C5 (colapso por clave), C6 (`tipo_evento 'Despacho económico'`,
  `F36.A1`) · **que consume:** C2 **por contrato literal** — importa de
  `utils/asientos/sistema.js` sin esperar a que L02 exista (ver nota)
- **Criterios de aceptación:** CA-3
- **Tests que corre:** `tests/f03_despacho_xm.test.js` (con test-lock, puerto 3103)
- **Riesgo / nota:** **la dependencia con L02 es de import, no de orden.** Los dos corren a la vez
  y las firmas de C2 están congeladas en `_CONTEXTO-BASE §6`, así que L03 escribe el `import` y
  sus tests contra la firma acordada. Si al correr sus tests el módulo de L02 todavía no está en
  el árbol, L03 **espera a que L02 cierre** (son minutos: es puro) o corre sus tests con un doble
  local — **nunca escribe `sistema.js` él mismo**: es territorio de L02. El gate verifica que las
  dos mitades encajen.
  El otro riesgo, real: **el seed del tipo va en las DOS listas** de `db.js` (el `NOT EXISTS` y el
  `UPDATE` complementario) o el `seleccionable = 0` se pierde en el siguiente restart.

### L04 — Lector del hecho, creador del asiento y barrido

- **Ola:** O2 · **Depende de:** L01, L02, L03 · **Puro:** no (BD) · **Puerto:** **3104**
- **Territorio (escritura):**
  - `server/utils/despacho-xm/lector.js` (nuevo)
  - `server/utils/despacho-xm/asiento.js` (nuevo)
  - `server/utils/despacho-xm/sweeper.js` (nuevo)
  - `server/server.js` (**solo el cableado del sweeper**: 3 líneas, junto a los otros tres)
  - `server/tests/despacho_xm.test.js` (nuevo)
  - `prompts/…/cierres/L04.md`
- **Contratos que produce:** C3 (`crearAsientoDespacho`), C4 (`leerDespachosRecibidos`) ·
  **que consume:** C1, C2, C6
- **Criterios de aceptación:** CA-1, CA-4, CA-6, CA-7, CA-8, CA-9, CA-10, CA-11 (**8** — está en
  el tope; por eso el CLI se sacó a L05)
- **Tests que corre:** `tests/despacho_xm.test.js` (con test-lock, puerto 3104)
- **Riesgo / nota:** **es el lote de riesgo del flujo** — el único que escribe filas, y escribe en
  las bitácoras de Sala de plantas **reales**. Tres cosas que muerden, todas en
  `_CONTEXTO-BASE §4` y §5.2:
  1. **La lista de plantas es inyectable** (C3) para que los tests corran sobre `'TST'`/`'TSR'` y
     no sobre GEC3/GEC32. Es la contramedida estructural de D-061, no un adorno.
  2. **La idempotencia mira `registro_activo` Y `registro_historico`**: un asiento de hace tres
     días ya fue archivado.
  3. **CA-11 se verifica, no se implementa.** `permissions.js` **no se toca**.

### L05 — CLI del relleno del mes

- **Ola:** O2 · **Depende de:** **L04** (el semáforo lo hace cumplir) · **Puro:** no (BD) · **Puerto:** **3105**
- **Territorio (escritura):**
  - `server/scripts/relleno-asiento-despacho.js` (nuevo)
  - `server/tests/relleno_despacho_xm.test.js` (nuevo)
  - `prompts/…/cierres/L05.md`
- **Contratos que produce:** — · **que consume:** C3, C4, C2
- **Criterios de aceptación:** CA-5
- **Tests que corre:** `tests/relleno_despacho_xm.test.js` (con test-lock, puerto 3105)
- **Riesgo / nota:** **no reimplementa nada**: llama a `crearAsientoDespacho` de L04 (C3), que ya
  es idempotente. Su trabajo propio es el recorrido del mes, los guardrails del CLI
  (`--confirm-db`, `--dry-run`) y marcar `hora_estimada: true`. El patrón a copiar es
  `scripts/backfill-carbon-gec32.js`, **incluida su lección**: "terminado" se verifica con una
  query, no con que el proceso haya salido con 0.

## Criterios de tamaño y reparto aplicados

- **Partición por dependencias, no por volumen.** Las tres raíces del grafo son los tres lotes de
  la O1; todo lo que escribe filas confluye en L04.
- **≤ 6 archivos de territorio y ≤ 8 CA por lote.** El más grande es L04 con 5 archivos de código
  y **8 CA exactos** — está en el tope, y es exactamente por eso que el CLI salió a L05 en vez de
  quedar adentro (fue la opción (c) descartada en la ronda 2).
- **2–5 lotes por ola:** 3 y 2.
- **Un solo escritor por compartido y por ola** (`_CONTEXTO-BASE §8`): `db.js` de Bitácora → L03;
  `db.js` del dashboard → L01; `f03-datos.js` → L03; `server.js` → L04. Nadie comparte un archivo
  con nadie dentro de su ola.
- **Riesgo asimétrico aislado:** L04 va **solo con su dependiente** en la O2, después de que el
  gate de la O1 verificó los tres contratos que consume. No necesita worktree: no rompe el árbol
  para nadie (agrega módulos nuevos y 3 líneas a `server.js`).
- **Calibrador antes que quien hereda:** **L02** fija en la O1 el vocabulario (texto, marcador,
  clave, predicados) que L03, L04 y L05 replican. Es el lote más corto y es puro, así que se
  verifica en segundos.
- **Tests puros y en paralelo con el código, no al final:** L01 y L02 no necesitan test-lock, así
  que de los tres chats de la O1 solo uno (L03) toca la BD. Contención cero.
- **El front no entra:** este flujo no toca `src/`. La bandera `hora_estimada` no se pinta
  (respuesta 4 de la ronda 1), así que no hay lote de front ni de cableado en
  `BitacorasGecelca3.jsx`.
