# CLAUDE.md — Bit-cora-g3

Sistema web de bitácoras operativas para plantas térmicas Gecelca (GEC3 y GEC32). Reemplaza el registro manual en Excel con trazabilidad, control de turnos y un contrato de eventos hacia el dashboard productivo (`dashboard-gen-gec3/`).

**Repo git independiente.** Su raíz `Bit-cora-g3/` tiene su propio `.git/`. NO es un submódulo del workspace umbrella; convive en disco con `dashboard-gen-gec3/` bajo `PORTAL GENERACIÓN/`.

## Inicio rápido — qué leer

- **Detalle de arquitectura**: `docs/architecture.md` (capas, módulos, schemas, mecánica por bitácora).
- **Decisiones**: `docs/decisions.md` (ADR-lite F1–F22).
- **Glosario**: `docs/domain-glossary.md` (MAND, CIET, DISP, AUTH/REDESP/PRUEBA, periodos, turnos, cargos).
- **Modelo de BD autoritativo**: `BIT-MODBD-2026-001.md` (en la raíz del repo).
- **Requerimientos funcionales**: `BIT-RF-2026-001.md`.
- **Contrato cross-repo**: `../docs/interfaces-cross-repo.md` (cómo Bitácora habla con dashboard-gen-gec3).

## Commands

- `cd Bit-cora-g3 && npm run dev` — frontend Vite (puerto 5174 por default).
- `cd Bit-cora-g3 && npm run build` — build a `dist/`.
- `cd Bit-cora-g3 && npm run lint` — ESLint.
- `cd Bit-cora-g3/server && node --watch --env-file=../.env server.js` — backend en modo desarrollo (puerto 3002).
- `cd Bit-cora-g3/server && node --test --env-file=../.env tests/` — tests (vitest patrones, `node:test` runner).

## Stack

| Capa | Tecnología |
|---|---|
| Frontend | React 19, Vite 5, TailwindCSS 3, lucide-react |
| Backend | Node.js ≥20 ESM, http nativo (sin Express), `node:test`, `--env-file` |
| BD | SQL Server 2019+ (`mssql` con `useUTC=true`). Esquemas `lov_bit` (catálogos) + `bitacora` (transaccional). |
| Build | Vite frontend; Node directo backend (sin bundler) |

## Estructura

```
Bit-cora-g3/
├── src/                       Frontend (React)
│   ├── BitacorasGecelca3.jsx  Layout principal + routing por bitácora.codigo
│   ├── components/
│   │   ├── SalaDeMando/SalaDeMandoGrid.jsx   UI MAND (formulario_especial=1)
│   │   ├── Disponibilidad/*                  UI DISP (mini-dashboard)
│   │   ├── GrillaRegistros.jsx               UI genérica para otras bitácoras
│   │   ├── BarraEstado.jsx                   Filtros F11 (fecha+turno)
│   │   └── historicos/HistoricoTable.jsx
│   └── hooks/
│       ├── useAuth.js, useBitacoraSesion.js, useUsuariosActivos.js
│       ├── useDisponibilidad.js, useSalaDeMando.js
│       └── useApi.js
├── server/                    Backend (Node ESM)
│   ├── server.js              Router HTTP, todos los endpoints
│   ├── db.js                  Conexión + initDB() idempotente (DDL, seeds)
│   ├── middleware/auth.js permissions.js
│   ├── routes/
│   ├── utils/
│   │   ├── turno.js           getTurnoColombia, turnoFromPeriodo, colombiaParts
│   │   ├── fecha.js           helpers TZ Bogotá
│   │   ├── snapshots.js       snapshotJDTs/Jefes/Ingenieros
│   │   ├── notificador.js     evento_dashboard + disponibilidad_dashboard helpers
│   │   ├── ciet.js            registrarEventoCierre
│   │   └── mand-sweeper.js    Cron interno c/60s, cierre automático MAND
│   └── tests/
├── sql/snippets/              Queries auxiliares para SSMS
├── BIT-MODBD-2026-001.md      Modelo BD autoritativo
├── BIT-RF-2026-001.md         RFs (RF-001..RF-065 + RN-01..RN-14)
└── docs/
    ├── architecture.md
    ├── decisions.md
    └── domain-glossary.md
```

## Bitácoras especiales

Dos bitácoras tienen UI propia (resto usa `GrillaRegistros` genérica):

- **MAND** (Operación 24h) — `SalaDeMandoGrid.jsx`. Grilla 24p × 3 tipos × 2 plantas. Batch save atómico via `POST /api/sala-de-mando/guardar`. Cierre automático fin de día via sweeper diario. Solo HOY editable. NO acepta cierre individual ni masivo.
- **DISP** (Disponibilidad) — `DisponibilidadDashboard.jsx`. Mini-dashboard con tabs GEC3/GEC32, counter live "tiempo en estado", historial paginado. Sin cierre de turno. 1 vigente por planta (filtered unique index). Cierre automático cuando llega nuevo evento.

Las demás (CIET, AUTOR, etc.) usan `GrillaRegistros.jsx` con filtros F11.

## Convenciones críticas (no obvias)

1. **TTL sesión: ninguno** (post F2). `sesion_activa.activa=1` hasta logout explícito. No usar `ultima_actividad > NOW - 5min` para validar — esa columna existe pero no rige TTL ya.
2. **Snapshots JSON inmutables**: `jdts_snapshot`, `jefes_snapshot`, `ingenieros_snapshot` en JSON. NO usar FK directo a `lov_bit.usuario` para reconstruir presencia. Solo `creado_por` y `modificado_por` son FK.
3. **2 turnos solamente** (no 3): T1 [06,17], T2 [18,23]∪[00,05]. Cualquier mención a "3 turnos" es narrativa, no datos.
4. **DISP es excepción a la inmutabilidad histórica**: PUT vigente DISP que cambia `fecha_inicio_estado` actualiza `N-1.fecha_fin_estado` en histórico. Documentado en D-011.
5. **MAND `modificado_por` se actualiza SOLO si `valor_mw` cambió** (no si solo cambió detalle/funcionariocnd). D-019.
6. **AUTH requiere `funcionariocnd`** (si hay valor en algún periodo). PRUEBA y REDESP fuerzan `funcionariocnd=NULL`. D-018.
7. **Lock REDESP**: solo `periodo >= floor(horaBogota) + 1` ("actual o posteriores") editable. AUTH y PRUEBA sin lock. D-016.
8. **Usuario SISTEMA** (`activo=0`, `password_hash='!disabled!'`) seedeado para CIETs automáticos del sweeper MAND. NUNCA loguea. D-015.
9. **TZ canónica**: BD en UTC, presentación en Bogotá explícito (`Intl.DateTimeFormat` con `timeZone`). Comparaciones de día Bogotá en SQL con `CAST(DATEADD(HOUR, -5, columna) AS DATE)`. D-020.
10. **No node_modules en búsquedas**: si necesitás grep, excluí siempre `node_modules/`.

## Contrato con dashboard-gen-gec3

Bitácora escribe `bitacora.evento_dashboard` (AUTH/REDESP/PRUEBA por periodo) y `bitacora.disponibilidad_dashboard` (DISP por planta). El dashboard productivo consume via `GET /api/eventos-dashboard?tipo=&planta_id=` expuesto por **este** backend (puerto 3002).

**Detalle completo: [`../docs/interfaces-cross-repo.md`](../docs/interfaces-cross-repo.md).** No tocar el shape de respuesta sin coordinar con el otro lado.

## Cómo evolucionar este archivo

**Agregá una entrada SOLO cuando:**
- Tomaste una decisión arquitectónica no-obvia (qué + por qué, máximo 3 líneas).
- Encontraste un gotcha que va a morder a alguien en el futuro (ej. orden de migraciones idempotentes, edge case en cierre cronológico).
- Cambió un contrato externo (endpoint cross-repo, schema BD, env var).
- Cambió un invariante del dominio (nueva bitácora, nuevo tipo de evento_dashboard, nuevo cargo).

**NO agreges:**
- Qué hace el código (eso ya lo dice el código bien nombrado).
- Cambios pequeños (refactor, rename, bugfix puntual) — `git log` es suficiente.
- Decisiones grandes — esas van a `docs/decisions.md` con formato ADR-lite (Contexto/Decisión/Consecuencias, 4-8 líneas) y acá solo el resumen + link.
- Transcripciones de discusiones (esto no es un chat log).

**Reglas de tamaño:**
- 1-3 frases por entrada acá; lo demás a `docs/`.
- Si este archivo supera ~250 líneas, hacé una pasada de consolidación.

**Para decisiones grandes**: `docs/decisions.md` con formato ADR-lite. Numerá la decisión (D-NNN siguiendo la secuencia).
