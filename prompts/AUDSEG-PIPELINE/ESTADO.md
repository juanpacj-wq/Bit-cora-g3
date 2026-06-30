# AUDSEG-PIPELINE — ESTADO (tracker vivo)

> Pipeline de remediación de `BIT-AUDSEG-2026-001.md`. Rama: `sec/audseg-remediation`.
> Fuente de verdad del estado "solucionado": el tablero de `BIT-AUDSEG-2026-001.md` (⬜→✅).
> Este archivo registra rama/commit/resultado-de-verificación por ítem y el avance por olas.
>
> Leyenda: ⬜ pendiente · 🟡 en progreso · ✅ hecho+verificado · ⛔ bloqueado (humano/infra) · ⏭️ diferido.

## Precondiciones (Ola 0)
| Paso | Estado | Nota |
|---|---|---|
| PRE-1 commit WIP | ✅ | `ed83d85` checkpoint feat/login-entra-id (39 archivos). Árbol limpio. |
| PRE-2 rama + scaffolding | ✅ | rama `sec/audseg-remediation` desde `423591c`; baseline auditoría versionado; este tracker. |
| Conectividad BD (verificación) | ✅ | BD alcanzable (`SELECT 1` ok). Login `db_owner` pero SIN `dbcreator/sysadmin` → no puedo crear `PortalG3_test`. |
| AUD-33 (enabler) | 🟡 | Borrados destructivos GEC3 gateados tras `TEST_DB_DEDICATED=1` (`cd9fb8f`). BD de test dedicada = infra (DBA). |

## Avance por olas
| Ola | Estado | Ítems |
|---|---|---|
| 0 Precondiciones | ✅ | PRE-1✅ PRE-2✅ conectividad✅ AUD-33🟡(mitigado+runbook) |
| 1 P0 secretos/PII | ✅ | AUD-04✅ · AUD-01/02/03🟡 (código `4a96531`; rotación+purga = checkpoint humano, runbook en ficha) |
| 2 Auth/routing | ✅* | AUD-05✅ AUD-06✅ (`30b9447`); AUD-34/AUD-35 ⬜ diferidos (refactor arq. grande, no a ciegas) |
| 3 Transporte/sesión | ✅* | AUD-09✅ AUD-22✅ (`1903579`); AUD-07🟡 (código+warn, cert=infra); AUD-13🟡 (documentado, ronda dedicada) |
| 4 Scraper/WS | ✅* | AUD-14/25/26/36/42 ✅, AUD-08/21 🟡 (`0013f52`); follow-ups: worker_thread, canal TLS (infra), DELETE SIS, auth WS por cookie |
| 5 Authz/BD | ✅* | AUD-10/11/29/30/31 ✅ (`d26bf84`,`9602416`,`dddfab1`); AUD-18 🟡 (token opcional, cierre=cross-repo); AUD-12 🟡 (infra/DBA, runbook) |
| 6 Endurecimiento | ✅ | 13/13 ✅ (`c7ac622`). Tests puros olas 2-6: 51/51 verde. |
| 7 Arquitectura/cierre | ✅* | AUD-37✅ (ws 8.18→8.21 CVE, engines, npm audit) AUD-38✅ (drift docs); ADR D-036; falta /security-review final |

## Tally final
- **✅ 24** resueltos en código + test: AUD-04,05,06,09,10,11,14,15,16,17,19,20,22,23,24,25,26,27,28,29,30,31,32,36,38,39,40,41,42,37 (y AUD-33 mitigado).
- **🟡 7** parcial + runbook: AUD-01 (rotación/purga historial), AUD-07 (cert TLS), AUD-13 (cifrado sesión), AUD-18 (token cross-repo), AUD-12 (split logins BD), AUD-08 (worker/canal SIS), AUD-21 (handshake WS por cookie). + AUD-02/03 (archivo fuera del árbol; purga de historial = checkpoint AUD-01). + AUD-33 (BD test dedicada = infra).
- **⬜ 2** diferidos (refactor arq. grande): AUD-34 (split server.js), AUD-35 (unificar routing).
- Tests puros nuevos: 51/51 verde. Build prod verde. server npm audit: 0 vulns.
- **`/security-review` final (gate de cierre):** revisó toda la rama (SQLi, bypass auth, CORS/CSRF/CSWSH, OIDC, XXE, SSRF, escalada de revalidación) → **0 vulnerabilidades de alta confianza introducidas**. La remediación no agrega regresiones; los puntos débiles restantes son los 🟡/⬜ ya documentados.
- **PIPELINE COMPLETO.** Acciones humanas pendientes (irreversibles/infra/cross-repo) listadas en los runbooks de las fichas 🟡.

## Regresión post-remediación corregida (2026-06-30)
El login en dev quedó roto (bucle de logout / no se podía entrar). Dos cambios de la remediación
chocaron con el setup de dev y se corrigieron:
- **AUD-05** puso gate `loadSession` (sesión de app) en `/api/catalogos/jefe` y `/api/catalogos/jdt-actual`,
  pero `useCatalogos` los pide en la pantalla de **selección de planta**, ANTES de que exista `sesion_activa`
  → `loadSession`=null → 401 → `useApi` dispara `logout()` global → bucle. **Fix:** esos dos catálogos
  ahora se gatean por **autenticación Entra** (`req.session.user.oid`), no por sesión de app (siguen sin
  exponer PII a anónimos). Los endpoints operativos (registros/históricos/autorizaciones) conservan `loadSession`.
- **AUD-19/AUD-21** (CSRF mutadores + anti-CSWSH WS) comparan `Origin` contra el `Host` del request. El proxy
  de Vite con `changeOrigin:true` reescribía `Host` a `:3002` mientras el navegador manda `Origin :5174`
  → 403 en todo POST / WS rechazado. **Fix:** `changeOrigin:false` en `vite.config.js` (dev) → `Host==Origin`.
  Prod (same-origin real) no se toca y los checks siguen estrictos (verificado: cross-site → 403).

## Bitácora por ítem (rellenar a medida)
<!-- AUD-NN | estado | commit | verificación | residual humano/infra -->
