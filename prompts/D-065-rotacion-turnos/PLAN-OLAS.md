# D-065 — Plan de olas

> Lo escribe el integrador en la fase 2 y lo commitea con el scaffolding. Es la fuente de
> `LOTES.json` y de los prompts `LNN-<slug>.md`. Solo el integrador lo edita (en un gate, con nota
> de por qué). Los lotes lo leen, no lo tocan.

## Grafo de dependencias

```
  L01 motor puro (patrón) ──┬──────────> L04 endpoints configuración ──┬─> L07 pantalla config
                            │                    │                     │
  L02 db.js (F37.A1/A2) ────┼──────┬─────────────┤                     │
                            │      │             │                     │
  L03 Graph (directorio) ───┴──────┘             │                     │
                                   ├─> L05 toma de control ────────────┼─> L08 popup
                                   │                                   │
                                   └─> L06 cumplimiento + congelado ───┴─> L09 vista cumplimiento
                                                                            │
                                                        L07 + L08 + L09 ────┴─> L10 cableado raíz
```

**Camino crítico:** `L02 → L04 → L07 → L10` (4 olas).
**Fuera del camino crítico:** L01 (puro, se puede empezar y terminar el primer día), L03 (riesgo
externo aislado), L09.

## Olas

> **Enmienda del GATE-O1 (2026-09-01):** la **O2 pasa de 3 a 4 lotes** con `L11`, el lote de
> corrección de los hallazgos de la O1 (decisión D5 del `GATE-O1.md`, **sujeta al visto bueno**).
> Y **L04 amplió territorio** con `server/middleware/auth.js` y `server/utils/sesion-contexto.js` (D3).

| Ola | Lotes | Por qué pueden ir juntos | Compartidos y su escritor |
|---|---|---|---|
| **O1** | L01, L02, L03 | Las tres raíces del grafo. Ninguna depende de otra: el motor es puro, el DDL no lee el motor, y el cliente de Graph no toca BD de rotación. Territorios totalmente disjuntos | `server/db.js` → **L02** |
| **O2** | L04, L05, L06 | Consumen contratos de O1 **ya verificados en el gate**. Cada uno entrega **su propio router**, así que no se pisan: el montaje en `app.js` lo hace un solo lote | `server/auth/app.js` → **L04** · `server/utils/turno-entidad.js` → **L06** |
| **O3** | L07, L08, L09 | Tres pantallas de front sobre contratos de endpoint **cerrados y probados**. Ninguna toca el componente raíz ni el routing: entregan componentes con la interfaz pactada | ninguno (por diseño) |
| **O4** | L10 | Enchufa las tres pantallas. Va **solo** porque `src/BitacorasGecelca3.jsx` (2.682 líneas) es el archivo más disputado del repo y un error ahí tumba la app entera para todos los chats | `src/BitacorasGecelca3.jsx` → **L10** · `src/routing/appRoute.js` → **L10** |
| **Cierre** | `/cerrar-implementacion D-065` | — | docs → integrador |

> **Desviación deliberada del "2–5 lotes por ola":** la O4 lleva un solo lote. Es la aplicación
> literal del criterio "riesgo asimétrico al final" del protocolo (`02-paralelismo.md` §10): el lote
> que puede dejar el árbol roto para todos va aislado. Se evaluó y descartó que el gate de la O3
> hiciera el cableado — es trabajo de construcción real (tres pantallas + dos rutas hash + el
> disparo del popup), no una edición de integración.

## Lotes

### L01 — Motor puro del patrón de rotación
- **Ola:** O1 · **Depende de:** — · **Puro (sin BD):** **sí** · **Puerto:** no levanta backend
- **Territorio:** `server/utils/rotacion/patron.js` · `server/tests/rotacion_patron.test.js` · `server/tests/fixtures/rotacion-oraculo-2026.json`
- **Produce:** contrato **C1** · **Consume:** —
- **CA:** CA-1, CA-2
- **Tests:** `tests/rotacion_patron.test.js`
- **Riesgo / nota:** es el **calibrador** del flujo y el único lote con un oráculo externo duro
  (730 pares verificados). Lo hace primero y corto para que L04 y L06 hereden un motor probado.
  No abre BD, no levanta server, no necesita test-lock: puede correr desde el minuto cero.

### L02 — Schema de rotación (`F37.A1`) y flag de cargo (`F37.A2`)
- **Ola:** O1 · **Depende de:** — · **Puro:** no · **Puerto:** **3112**
- **Territorio:** `server/db.js` · `server/tests/rotacion_schema.test.js`
- **Produce:** contrato **C2** · **Consume:** —
- **CA:** CA-3, CA-4
- **Tests:** `tests/rotacion_schema.test.js`
- **Riesgo / nota:** **ÚNICO lote que toca `db.js` en toda la implementación.** Dos trampas
  conocidas: (i) el flag de cargo va en el **MERGE** de `db.js:864`, no en un `UPDATE` one-shot, o
  no sobrevive al restart (convención 27); (ii) un código de migración repetido **se salta en
  silencio** — `F37.A1` y `F37.A2` están reservados y verificados en las 8 ramas y en las dos BD.

### L03 — Cliente de Microsoft Graph y sincronización del directorio
- **Ola:** O1 · **Depende de:** — · **Puro:** parcialmente (el parser sí; la llamada no) · **Puerto:** **3113**
- **Territorio:** `server/utils/graph/cliente.js` · `server/utils/graph/directorio.js` · `server/tests/rotacion_sync_entra.test.js`
- **Produce:** contrato **C3** · **Consume:** —
- **CA:** CA-5, CA-6
- **Tests:** `tests/rotacion_sync_entra.test.js`
- **Riesgo / nota:** **el riesgo externo del flujo**, aislado a propósito. Depende de la red
  corporativa (el FortiGate intercepta TLS saliente; en prod hace falta `NODE_EXTRA_CA_CERTS`, ver
  DEPLOY.md §7 y D-047). El parser se prueba **contra una respuesta capturada**, sin red; la llamada
  real se prueba a mano y se reporta. **Nunca desactivar la verificación TLS.**
  El secret de `.env` es también llave de lectura del directorio: **jamás loguear la respuesta cruda
  de Graph** (trae UPNs de 89 personas).

### L04 — Endpoints de configuración anual (superficie A)
- **Ola:** O2 · **Depende de:** L01, L02, L03 · **Puro:** no · **Puerto:** **3114**
- **Territorio:** `server/routes/rotacion.js` · `server/utils/rotacion/titulares.js` · `server/auth/app.js` ·
  **`server/middleware/auth.js`** · **`server/utils/sesion-contexto.js`** (ampliado por el GATE-O1, decisión D3) ·
  `server/tests/rotacion_endpoints.test.js`
- **Produce:** contrato **C4** · **Consume:** C1, C2, C3
- **CA:** CA-7, CA-8, CA-9
- **Tests:** `tests/rotacion_endpoints.test.js`
- **Riesgo / nota:** es el lote que **monta los tres routers** en `auth/app.js` (el de L05 y el de
  L06 incluidos): una sola edición, tres líneas, para que ningún otro lote toque ese archivo. Los
  nombres de archivo de esos routers son contrato (§5.3) y existen porque L05 y L06 los crean en la
  misma ola. Si al montar uno todavía no existe, **eso es coordinación de la ola, no un bloqueo**:
  el `import` se escribe igual y el gate verifica que los tres resuelvan.
- **Ampliación del GATE-O1 (D3):** también lleva `puede_configurar_rotacion` hasta la sesión. Los
  SELECT de `middleware/auth.js` y `utils/sesion-contexto.js` son **espejos declarados** — se cambian
  juntos, y el shape se fija en `tests/rotacion_endpoints.test.js`. Sin esto el flag sale `undefined`
  en `/api/me` y la pantalla de L07 no aparecería **sin ningún error** que lo delate.

### L05 — Toma de control del rol (superficie B, backend)
- **Ola:** O2 · **Depende de:** L02 · **Puro:** no · **Puerto:** **3115**
- **Territorio:** `server/routes/rotacion-control.js` · `server/utils/rotacion/control.js` · `server/tests/rotacion_control.test.js`
- **Produce:** contrato **C5** · **Consume:** C2, C4
- **CA:** CA-10, CA-11, CA-12, CA-13, CA-14
- **Tests:** `tests/rotacion_control.test.js`
- **Riesgo / nota:** **el lote con más matiz del flujo.** La pila se **deriva** del log append-only,
  nunca se guarda materializada. La concurrencia necesita **serialización real** (`sp_getapplock`
  dentro de la transacción), no un optimismo con reintento: CA-11 exige dos `TOMAR` simultáneos con
  exactamente un ganador. **NO** toca `server/auth/app.js`: lo monta L04.

### L06 — Cumplimiento y congelado al cerrar (superficie C, backend)
- **Ola:** O2 · **Depende de:** L01, L02 · **Puro:** no · **Puerto:** **3116**
- **Territorio:** `server/routes/rotacion-cumplimiento.js` · `server/utils/rotacion/cumplimiento.js` · `server/utils/turno-entidad.js` · `server/tests/rotacion_cumplimiento.test.js`
- **Produce:** contratos **C6**, **C7** · **Consume:** C1, C2, C4
- **CA:** CA-15, CA-16, CA-17, CA-18
- **Tests:** `tests/rotacion_cumplimiento.test.js`
- **Riesgo / nota:** único lote que edita `utils/turno-entidad.js`, y solo para **añadir** la llamada
  a `congelarCumplimiento` dentro de la transacción de `cerrarTurno` (:257), después de la
  conformación. **No cambia nada de lo que `cerrarTurno` ya hace**: si el congelado falla, la
  transacción entera cae — que es lo correcto, pero exige que `filas = 0` **no** sea error.
  La regla central de CA-15 (resolver **por `usuario_id`**, no por conteo de cargo) es lo que hace
  medible al módulo: no la pierdas.

### L11 — Correcciones de la O1 (schema, cliente de Graph y tests)
- **Ola:** O2 · **Depende de:** — (nadie) · **Puro:** no · **Puerto:** **3117**
- **Territorio:** `server/db.js` · `server/utils/graph/cliente.js` · `server/utils/graph/directorio.js` ·
  `server/tests/rotacion_correcciones.test.js` · `server/tests/rotacion_schema.test.js` ·
  `server/tests/rotacion_sync_entra.test.js` · `server/tests/residuos.js`
- **Produce:** nada nuevo (no toca ningún contrato) · **Consume:** —
- **CA:** ninguno propio. Protege CA-3, CA-4, CA-5 y CA-6, que ya están confirmados
- **Tests:** `tests/rotacion_correcciones.test.js` + los dos existentes que amplía
- **Origen:** lo abrió el **GATE-O1**, decisión **D5**, para los 12 hallazgos confirmados del
  `/code-review` que caen sobre territorios de lotes ya cerrados (L01/L02/L03) y que por eso no tienen
  escritor en la O2. Lista completa en `GATE-O1.md §7` (CR-1…CR-15).
- **Riesgo / nota:** agrega constraints a tablas contra las que **L04, L05 y L06 escriben en la misma
  ola**. Dos reglas duras: (i) toda constraint o índice nuevo va como migración **`F37.A3` aditiva e
  idempotente** (`ALTER TABLE … ADD CONSTRAINT` gateado), **jamás** editando el `CREATE TABLE` de
  `F37.A1` — no serviría, porque su `IF OBJECT_ID` lo salta en cualquier BD donde las tablas ya
  existan, que a estas alturas son todas; (ii) **no bloquea a nadie** y nadie lo bloquea, así que si
  un índice nuevo choca con lo que inserta un test de otro lote, eso sale en el GATE-O2 y se resuelve
  ahí. El hallazgo más serio es **CR-1**: el `MERGE` pisa `azure_upn` con `NULL` y el arranque
  siguiente degrada al Jefe de Planta.

### L07 — Pantalla de configuración anual (superficie A, front)
- **Ola:** O3 · **Depende de:** L04 · **Puro:** vitest, sin BD · **Puerto:** no levanta backend
- **Territorio:** `src/components/Rotacion/ConfiguracionRotacion.jsx` · `src/components/Rotacion/configuracion-rotacion.test.jsx` · `src/hooks/useRotacion.js`
- **Produce:** componente controlado (C8) · **Consume:** C3, C4
- **CA:** CA-19
- **Tests:** `npm test -- src/components/Rotacion/configuracion-rotacion.test.jsx` + `npm run build`
- **Riesgo / nota:** es la superficie que el usuario ve **una vez al año**, así que la claridad pesa
  más que la densidad. Agrupa por rol tal como los clasifica Entra, con el conteo de miembros a la
  vista. Incluye "copiar patrón de otro rol" (decisión R14) para no teclear los mismos 16 números
  siete veces. **Jamás pide "ancla" ni "desfase"**: pide fecha de inicio y los grupos de T1 y T2.

### L08 — Popup de toma de control (superficie B, front)
- **Ola:** O3 · **Depende de:** L05 · **Puro:** vitest · **Puerto:** no levanta backend
- **Territorio:** `src/components/Rotacion/PopupTomaControl.jsx` · `src/components/Rotacion/popup-toma-control.test.jsx` · `src/hooks/useTomaControl.js`
- **Produce:** componente controlado · **Consume:** C5
- **CA:** CA-20
- **Tests:** `npm test -- src/components/Rotacion/popup-toma-control.test.jsx` + `npm run build`
- **Riesgo / nota:** copia la forma de `src/components/TurnoTransicionModal.jsx` (147 líneas).
  **Tuteo** en la copia (decisión R11). El "no volver a preguntar" **no** vive en `localStorage`:
  sale de `ya_respondi` del backend (mismo criterio que D-040 con `turno_finalizado_en`).
  **No** monta nada en el raíz: eso es L10.

### L09 — Vista de cumplimiento (superficie C, front)
- **Ola:** O3 · **Depende de:** L06 · **Puro:** vitest · **Puerto:** no levanta backend
- **Territorio:** `src/components/Rotacion/CumplimientoRotacion.jsx` · `src/components/Rotacion/cumplimiento-rotacion.test.jsx` · `src/hooks/useCumplimiento.js`
- **Produce:** componente controlado (C8) · **Consume:** C6
- **CA:** CA-21
- **Tests:** `npm test -- src/components/Rotacion/cumplimiento-rotacion.test.jsx` + `npm run build`
- **Riesgo / nota:** copia la forma de `src/components/SeguimientoTurnos.jsx`. El entregable que el
  usuario pidió por nombre es **"qué titulares no entraron y en qué turnos"**: esa lista tiene que
  ser legible de un vistazo, no un subproducto de una tabla de estados.

### L10 — Cableado en el componente raíz y rutas hash
- **Ola:** O4 · **Depende de:** L07, L08, L09 · **Puro:** vitest + build · **Puerto:** no levanta backend
- **Territorio:** `src/BitacorasGecelca3.jsx` · `src/routing/appRoute.js` · `src/routing/appRoute.test.js`
- **Produce:** contrato **C8** · **Consume:** los tres componentes de O3
- **CA:** CA-22, y la confirmación end-to-end de CA-19/20/21
- **Tests:** `npm test -- src/routing/appRoute.test.js` + `npm run build` + smoke manual
- **Riesgo / nota:** el archivo más disputado del repo. Dos gotchas de D-035 que muerden: (i) la
  sincronización ruta↔estado usa **refs de igualdad** para no entrar en loop ni revertir un clic —
  no metas la sección nueva en las deps del efecto "derive"; (ii) el hash **no** colisiona con el
  callback OIDC (`?auth=…` es search, no hash). El popup se dispara al montar el dashboard con
  sesión de app viva, **una sola consulta**, sin polling.

## Criterios de tamaño y reparto aplicados

- **Partición por dependencias, no por volumen.** Tres raíces del grafo → tres lotes en la O1.
- **≤ 6 archivos de territorio y ≤ 8 CA por lote.** El máximo es L05 con 3 archivos y 5 CA;
  L06 con 4 archivos y 4 CA.
- **Un solo escritor por compartido y por ola:** `db.js` → L02 (O1) · `auth/app.js` → L04 (O2) ·
  `turno-entidad.js` → L06 (O2) · `BitacorasGecelca3.jsx` y `appRoute.js` → L10 (O4).
- **Riesgo asimétrico aislado:** L03 (dependencia externa de red) va en su propia esquina de la O1;
  L10 (componente raíz) va solo en la O4.
- **Calibrador antes que quien hereda:** L01 fija el motor y su forma de fechas (`'YYYY-MM-DD'`
  Bogotá, nunca `Date`) que L04 y L06 replican; L04 fija el patrón de router + gate por flag de
  cargo que L05 y L06 copian en la misma ola.
- **Tests puros y en paralelo con el código:** L01 es puro y arranca sin depender de nada; los tres
  lotes de front son vitest sin BD, o sea sin contención de test-lock.
- **La última ola es el cierre:** ADR `D-065`, convención 38 de `CLAUDE.md`, `BIT-MODBD v2.8`,
  `BIT-RF v2.4 / RF-079`, y `git rm` del scaffolding.
