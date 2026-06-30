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
| 6 Endurecimiento | ⬜ | AUD-15, AUD-16, AUD-17, AUD-19, AUD-20, AUD-23, AUD-24, AUD-27, AUD-28, AUD-32, AUD-39, AUD-40, AUD-41 |
| 7 Arquitectura/cierre | ⬜ | AUD-37, AUD-38, security-review |

## Bitácora por ítem (rellenar a medida)
<!-- AUD-NN | estado | commit | verificación | residual humano/infra -->
