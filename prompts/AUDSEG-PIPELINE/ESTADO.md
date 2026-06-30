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
| Conectividad BD (verificación) | ⬜ | Por sondear: ¿este entorno alcanza `192.168.17.20:1433`? Define estrategia de verificación. |
| AUD-33 (enabler) | ⬜ | Migrar cleanups MAND/AUTH `GEC3`→`TST` (corta la destrucción de prod). BD de test dedicada = infra (humano). |

## Avance por olas
| Ola | Estado | Ítems |
|---|---|---|
| 0 Precondiciones | 🟡 | PRE-1✅ PRE-2✅ conectividad⬜ AUD-33⬜ |
| 1 P0 secretos/PII | ⬜ | AUD-04, AUD-01, AUD-02, AUD-03, PURGA |
| 2 Auth/routing | ⬜ | AUD-35, AUD-34, AUD-05, AUD-06 |
| 3 Transporte/sesión | ⬜ | AUD-07, AUD-09, AUD-13, AUD-22 |
| 4 Scraper/WS | ⬜ | AUD-08, AUD-36, AUD-14, AUD-25, AUD-26, AUD-21, AUD-42 |
| 5 Authz/BD | ⬜ | AUD-11, AUD-18, AUD-10, AUD-12, AUD-29, AUD-30, AUD-31 |
| 6 Endurecimiento | ⬜ | AUD-15, AUD-16, AUD-17, AUD-19, AUD-20, AUD-23, AUD-24, AUD-27, AUD-28, AUD-32, AUD-39, AUD-40, AUD-41 |
| 7 Arquitectura/cierre | ⬜ | AUD-37, AUD-38, security-review |

## Bitácora por ítem (rellenar a medida)
<!-- AUD-NN | estado | commit | verificación | residual humano/infra -->
