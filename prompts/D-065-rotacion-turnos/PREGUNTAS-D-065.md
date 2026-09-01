# D-065 — Preguntas y respuestas (congeladas)

> Sesión de planeación **2026-08-31**. Estas respuestas son **autoritativas** para toda la
> implementación. Una vez cerradas no se reabren: si algo cambia durante la ejecución, es una
> **desviación** y se documenta en el cierre del lote + el gate, no acá.

## Fuente del requerimiento

- Documento del usuario **"MÓDULO ROTACIÓN DE TURNOS — ARRANQUE DE IMPLEMENTACIÓN"** (12 secciones),
  entregado como insumo de la Fase 1. No hay `docs/requerimientos/REQ-NN` previo: este flujo crea
  el requisito **RF-079** en `BIT-RF` durante el cierre.
- Oráculo de datos: `Rotacion2026.xlsx` (raíz del umbrella `PORTAL GENERACIÓN/`, 8 hojas).
- Legacy analizado y **descartado como referencia** por decisión del usuario (§3 del documento).

---

## Ronda 0 — aclaración de vocabulario

| # | Pregunta | Respuesta |
|---|---|---|
| 0 | El usuario frenó la planeación: *"revisemos el tema de nómina, porque no lo veo en ningún momento en el excel. ¿Es realmente necesario?"* Se aclaró que "nómina" (término tomado del §2.A del propio documento) **no** son sueldos ni datos de RR.HH.: es **la lista de qué personas componen cada grupo**, y sí está en el Excel (hoja `OPS` filas 15–21 y hoja `ING` filas 15–18 de cada uno de los 12 bloques mensuales). Sin ella, la rejilla de 365 días solo produce etiquetas `G1..G4` y se caen las superficies **B** (popup) y **C** (cumplimiento). | **Entra en el alcance.** Se implementan las tres superficies. Desde acá el término usado es **"cuadrilla"**, no "nómina". |

---

## Ronda 1

| # | Pregunta | Respuesta |
|---|---|---|
| 1 | **Modelo de la cuadrilla.** Medido: la cuadrilla OPS **cambia todos los meses** (6 celdas por transición, 69 de 308 en el año — es una rotación encadenada de personas entre grupos); la de ING **no cambia ni una vez** en 12 meses. Eso choca con "se carga una vez al año" tal como está redactado. Opciones: (a) asignación con vigencia `(persona, rol, grupo, desde, hasta)`; (b) cuadrilla por mes (12 bloques); (c) cuadrilla anual única + 69 excepciones. **Recomendada: (a).** | **(a) Asignación con vigencia.** La carga anual crea las tandas de una sola vez; un relevo a mitad de año es una **fila nueva**, no una edición. El histórico nunca se reescribe. |
| 2 | **Fuente de la cuadrilla.** Medido: el Excel trae 90 nombres crudos con typos (`Elías/Elias Navarro`, `Sergío/Sergio Fabra`, `Carllos Martinez`); 10 no matchean con ningún usuario; prod tiene **13 personas duplicadas** (fila legacy `atafur` + fila Entra `atafur@GECELCA.COM.CO`); y solo **76 usuarios tienen `azure_oid`**. | **Ni el legacy ni el Excel.** *"La cuadrilla real son las personas en los grupos de la app registration de EntraID con permisos para hacer login, y el rol lo determina el grupo con su respectivo rol asignado que está asignado a la app empresarial."* → **Entra ID es la fuente de verdad** de persona + rol. |
| 3 | **Materialización por planta.** El Excel tiene UN Jefe de Turno por grupo y una sola cuadrilla para toda la gerencia, pero hay dos plantas (GEC3, GEC32). | **"Un jefe de turno aplica sobre ambas unidades."** El titular es **el mismo en las dos plantas**; el **cumplimiento se mide por planta**. Coherente con lo medido: `cargo.puede_cambiar_unidad = 1` solo para `Ingeniero Jefe de Turno` y `Operador de Planta - Analista` (D-054). |
| 4 | **Rama base.** La de integración vigente es `feat/integrar-asientos-D-059`; prod sirve `feat/D-059-usuario-consulta` (75 commits atrás, Fase F); D-064 está EN CURSO en `feat/asiento-despacho-xm-2026-08`. | **`feat/integrar-asientos-D-059`.** Este módulo no toca nada de D-064 (MAND, F03, despacho XM): los dos flujos avanzan en paralelo. |

---

## Ronda 2

| # | Pregunta | Respuesta |
|---|---|---|
| 5 | **De dónde sale el grupo G1–G4.** Medido con Graph contra el tenant real: los 13 grupos de Entra asignados a la Enterprise App dan **persona + rol**, pero **ninguno codifica G1–G4**. Opciones: (a) pantalla de configuración anual en la app; (b) 4 grupos nuevos en Entra leídos por Graph; (c) prellenar desde el Excel. | *"Con grupo me refería a los grupos de entra id con los roles. En el caso de los grupos de los turnos entonces sí, **una pantalla de configuración para cada grupo**."* → **(a) Pantalla de configuración anual en la app.** |
| 6 | **Sincronización del directorio.** Hoy `lov_bit.usuario` se llena solo cuando la persona entra por primera vez (auto-aprovisionamiento por `azure_oid`, D-031): **76 usuarios con `azure_oid` en prod contra 81 personas asignadas en Entra**. Para planificar hace falta la lista completa antes de que entren. | **Sincronizar por Graph bajo demanda** (`client_credentials`; `User.Read.All` + `GroupMember.Read.All` ya concedidos desde 2026-07-15). Al abrir la configuración anual y con un botón "Actualizar desde Entra". Aprovisiona por `azure_oid` para que el primer login calce con la fila existente y no cree otra. |
| 7 | **Quién configura la malla.** Medido: `Gerente de Producción` tiene `solo_lectura = 1`; `Administrador y Debugging` tiene acceso total por matriz (D-039) pero su grupo de Entra está **vacío**. | **Administrador y Debugging + Gerente de Producción.** Se implementa con un flag nuevo `lov_bit.cargo.puede_configurar_rotacion` (data-driven, como `puede_cambiar_unidad` de D-054), **sin tocar `solo_lectura = 1` del Gerente**: sigue siendo solo-lectura en todas las bitácoras — D-039 y la matriz de permisos quedan intactas — y a la vez es dueño de la malla, que no es una bitácora. |

---

## Ronda 3

| # | Pregunta | Respuesta |
|---|---|---|
| 8 | **"Genera los 365 días completos": ¿filas o cálculo?** Con `V[((fecha − ancla) + desfase) % 8]` el titular de cualquier fecha sale de una función pura + la tabla de asignaciones. Materializar serían ~26.000 filas/año y obligaría a regenerar tramos ante cada relevo (el delete+recreate que se le criticó al legacy). | **Calcular al vuelo.** Se guardan el patrón y las asignaciones con vigencia; el titular se **deriva**. Al **cerrar el turno** se congela el cumplimiento junto al snapshot — ahí sí queda inmutable (RF-032). Cambiar una asignación no reescribe el pasado. |
| 9 | **Semántica de COMPLETO** con N titulares por rol. | **Entraron TODOS los titulares.** Con uno solo el estado es `PARCIAL`. |
| 10 | **Desfases distintos ING (2) y OPS (3)**, por los que la mitad de las parejas ingeniero-operador nunca coincide. | **Dejarlo como está, y medirlo.** El módulo refleja la operación real, no la corrige. El análisis de coincidencias del §8 queda **habilitado y no cerrado por diseño** (no es alcance de este flujo). |
| 11 | **Copia del popup: usted o tuteo.** | **Tuteo**, por la convención es-CO del workspace: *"Durante este turno el {rol} principal es {persona}. ¿Deseas tomar el control del rol en este turno?"* |

---

## Ronda 4 — corrección del eje del modelo

| # | Pregunta | Respuesta |
|---|---|---|
| 12 | **A quién se le muestra el popup.** El §7 dice "a todos los roles excepto USUARIO DE CONSULTA y quienes sí hacen parte del turno", pero 5 de los 14 cargos no tienen área en la malla del Excel. | **Excluidos: `Administrador y Debugging`, `Gerente de Producción`, `USUARIO DE CONSULTA`.** El `Ingeniero Químico` y el `Coordinador de carbón y maquinaria` **NO** se excluyen: *"tienen un funcionamiento similar a jdt, que cuando ingresan quedan como participantes en ambas unidades."* |
| 13 | Se propuso un mapeo `cargo → área de la malla` (Ing. Químico → Analistas, Coordinador → Carbón + Maquinaria). **El usuario lo corrigió.** | **"No es por area, sino por rol. La creación del patrón también debe crearse por rol."** → Se **elimina** el catálogo de "áreas". El eje del modelo es **`lov_bit.cargo`**. El Ingeniero Químico y el Coordinador dejan de ser un caso especial: tienen **su propio patrón**, como cualquier otro rol. |
| 14 | **Cómo se guarda el patrón por rol**, si hoy 7 roles comparten los vectores OPS y 2 comparten los ING. Opciones: (a) una fila de patrón por rol; (b) patrones con nombre y cada rol apunta a uno. | **(a) Una fila de patrón por rol.** Que hoy siete coincidan es un hecho de la operación, no una restricción del modelo. La pantalla ofrece "copiar patrón de otro rol". Cambiar el desfase de un rol no toca a los demás. **Un rol sin patrón simplemente no rota**: no genera titulares y su gente no ve el popup. |

---

## Ronda final — reparto en olas

| # | Pregunta | Respuesta |
|---|---|---|
| R1 | Propongo **4 olas y 10 lotes**. O1 = L01 (motor puro), L02 (`db.js`), L03 (Graph) — tres raíces independientes. O2 = L04, L05, L06 — tres routers de backend sobre los contratos de O1. O3 = L07, L08, L09 — tres pantallas de front contra contratos ya verificados. O4 = L10, el cableado del componente raíz, aislado al final por ser el archivo más disputado del repo (2.682 líneas). Escritor único de `db.js` en O1: **L02**. | **De acuerdo con las 4 olas.** |

---

## Criterios de aceptación congelados

| CA | Criterio (falsable) | Verificador previsto |
|---|---|---|
| CA-1 | `grupoDeTurno()` reproduce el Excel con **0 discrepancias** en los 730 pares `(fecha, turno)` del año 2026-02-01 … 2027-01-31, para las dos mallas. | `tests/rotacion_patron.test.js` contra `tests/fixtures/rotacion-oraculo-2026.json` |
| CA-2 | El desfase se **deriva** de `(fecha_inicio, grupo_t1, grupo_t2)` sin pedirle al usuario "ancla" ni "desfase"; con `grupo_t1` solo, la derivación **falla** con `desfase_ambiguo` en vez de adivinar. | `tests/rotacion_patron.test.js` |
| CA-3 | Las tablas `rotacion_patron`, `rotacion_asignacion`, `rotacion_control` y `rotacion_cumplimiento` existen con sus constraints, y la migración es **idempotente** (un segundo arranque no falla ni duplica). | `tests/rotacion_schema.test.js` |
| CA-4 | `lov_bit.cargo.puede_configurar_rotacion = 1` para `Administrador y Debugging` y `Gerente de Producción`, y **sobrevive a un restart** (va en el MERGE de cargos, no en un UPDATE one-shot). El `solo_lectura` del Gerente **sigue en 1**. | `tests/rotacion_schema.test.js` |
| CA-5 | La sincronización con Graph aprovisiona por `azure_oid`: una persona ya existente **no** genera una fila nueva, y una persona nueva entra con su `azure_oid` para que su primer login calce. | `tests/rotacion_sync_entra.test.js` |
| CA-6 | Sin `M365_CLIENT_SECRET` o con Graph caído, el módulo degrada a **503 `entra_no_disponible`** y **el server no se cae**; el resto de la configuración anual sigue usable. | `tests/rotacion_sync_entra.test.js` |
| CA-7 | `GET /api/rotacion/titulares?fecha&turno&planta_id` resuelve el titular de cada rol **sin consultar el Excel**, y devuelve los mismos grupos que el oráculo. | `tests/rotacion_endpoints.test.js` |
| CA-8 | Los endpoints de configuración rechazan con **403 `rotacion_no_autorizado`** a todo cargo con `puede_configurar_rotacion = 0`, incluido un `Ingeniero Jefe de Turno`. | `tests/rotacion_endpoints.test.js` |
| CA-9 | Un relevo a mitad de vigencia **no reescribe** la asignación anterior: cierra su `vigente_hasta` e **inserta** una fila nueva; el titular de una fecha pasada no cambia. | `tests/rotacion_endpoints.test.js` |
| CA-10 | `TOMAR` es una **pila LIFO** por `(turno_id, planta_id, cargo_id)`: el principal es siempre el último `TOMAR` sin su `ABANDONAR`, y `ABANDONAR` devuelve el control al tenedor inmediatamente anterior. | `tests/rotacion_control.test.js` |
| CA-11 | **Dos `TOMAR` concurrentes** sobre el mismo `(turno, planta, rol)` se serializan: queda **exactamente un** principal y el log conserva los dos eventos en orden. | `tests/rotacion_control.test.js` |
| CA-12 | El **titular del fondo de la pila no puede abandonar** (`409 titular_no_abandona`): la pila nunca queda vacía. | `tests/rotacion_control.test.js` |
| CA-13 | El popup se ofrece **una sola vez por turno por usuario**: un `DESCARTAR` hace que `GET /control/estado` devuelva `ya_respondi: true` hasta que cambie el turno. | `tests/rotacion_control.test.js` |
| CA-14 | Con el turno **CERRADO**, `TOMAR` y `ABANDONAR` responden **409 `turno_cerrado`** y el estado congelado no se altera. | `tests/rotacion_control.test.js` |
| CA-15 | El estado se resuelve **por persona (`usuario_id`)**, no por conteo de cargo: con 3 participantes del rol y **ninguno** titular, el estado es `PENDIENTE`. | `tests/rotacion_cumplimiento.test.js` |
| CA-16 | Escalones correctos: ningún titular → `PENDIENTE`; alguno pero no todos → `PARCIAL`; todos → `COMPLETO`; un no-titular con el control → `CUBIERTO_POR_RELEVO`. | `tests/rotacion_cumplimiento.test.js` |
| CA-17 | `cerrarTurno` **congela** una fila de `rotacion_cumplimiento` por `(fecha_operativa, planta_id, turno, cargo_id)` dentro de la MISMA transacción que sella la cabecera, y es **idempotente**. | `tests/rotacion_cumplimiento.test.js` |
| CA-18 | `GET /api/rotacion/cumplimiento?desde&hasta&planta_id` responde, para un rango, **qué titulares no entraron y en qué turnos**. Ese listado es un entregable, no un subproducto. | `tests/rotacion_cumplimiento.test.js` |
| CA-19 | La pantalla de configuración anual lista a las personas **agrupadas por rol tal como las clasifica Entra** y permite asignar `G1..G4` o "sin grupo"; guarda sin recargar la página. | `src/components/Rotacion/configuracion-rotacion.test.jsx` |
| CA-20 | El popup aparece **solo** a los cargos con patrón y que no son titulares del turno en curso; **nunca** a `Administrador y Debugging`, `Gerente de Producción` ni `USUARIO DE CONSULTA`. | `src/components/Rotacion/popup-toma-control.test.jsx` |
| CA-21 | La vista de cumplimiento pinta los cuatro estados y permite filtrar por rango de fechas y planta; una fila `PENDIENTE` nombra a los titulares que faltaron. | `src/components/Rotacion/cumplimiento-rotacion.test.jsx` |
| CA-22 | Las rutas `#/rotacion` y `#/rotacion/cumplimiento` sobreviven a F5 y son deep-linkables (D-035); la sección se esconde a quien no tiene permiso y cae a la primera permitida. | `src/routing/appRoute.test.js` + `npm run build` |
| CA-23 | **Cero tareas recurrentes**: entre una carga anual y la siguiente, ninguna superficie del módulo pide intervención del usuario. Verificable por ausencia de sweepers, crons y avisos nuevos. | Revisión del gate: `grep` de `setInterval`/sweeper en el territorio del flujo |

---

## Detalles operativos confirmados

- **El eje es `lov_bit.cargo`.** No se crea catálogo de "áreas". El nombre visible del rol sale de
  `lov_bit.cargo.nombre` (D-052: la etiqueta vive en el seed; la identidad estable es el `cargo_id`).
- **Turnos.** Coinciden exactamente entre el Excel y la app, sin conversión: `T1 = [06:00, 18:00)`,
  `T2 = [18:00, 06:00)` cruzando medianoche; `fecha_operativa` = el día en que **arrancó** el turno.
  En el Excel, la fila `06:00-18:00` es T1 de esa fecha y la fila `18:00-00:00` es T2 de esa fecha;
  la fila `00:00-06:00` es la **cola del T2 del día anterior** y por eso no se lee como turno propio.
- **Oráculo verificado en la planeación** (2026-08-31), sobre `Rotacion2026.xlsx`:
  365 días × 2 mallas; **0 discrepancias** fórmula-vs-Excel, **0 rupturas** de continuidad nocturna,
  **0 violaciones** de periodicidad de 8 días. Volcado a `oraculo-rotacion-2026.json` (insumo de L01).
- **El desfase se deriva de `(grupo_t1, grupo_t2)`, no de `grupo_t1` solo.** Medido: en ambos
  patrones los 8 pares `(V1[i], V2[i])` son distintos, pero `V1` solo toma 4 valores distintos en 8
  índices. Pedir únicamente "qué grupo arranca" dejaría **dos** desfases posibles. La UI pide la
  fecha de inicio y los grupos de T1 y T2 de ese día; jamás pide "ancla" ni "desfase".
- **Continuidad entre años.** "Un año arranca donde terminó el anterior": para el periodo siguiente
  el desfase se **calcula** por continuidad con el patrón vigente; la captura manual es solo para el
  primer periodo de un rol.
- **Entra ID (medido el 2026-08-31 contra el tenant real).** SP `LOGIN_PORTAL_GENERACIÓN`,
  `appRoleAssignmentRequired = true`, 14 App Roles, **13 grupos + 1 usuario directo**. Miembros por
  grupo: JEFE_DE_TURNO 7 · INGENIERO_OPERACION 14 · INGENIERO_QUIMICO 2 · SDM 9 · CALDERA 9 ·
  TURBOGRUPO 9 · CYC 9 · PDA 9 · MAQUINARIA 9 · ANALISTA 6 · USUARIO_CONSULTA 6 ·
  COORDINADOR_CARBON_MAQUINARIA **0** · ADMINISTRADOR_DEBUGGING **0**.
  De las **81** personas en roles de rotación, **71 calzan** con el Excel; de las 10 restantes,
  6 son typos del Excel y 4 son diferencias reales.
- **Los dos grupos vacíos son un hecho operativo, no un bug del módulo:** hoy nadie tiene el rol
  `Administrador y Debugging`, que es uno de los dos que pueden configurar la malla. El cierre lo
  deja escrito en el runbook.
- **Vacaciones y supernumerarios**: fuera de alcance como entrada obligatoria (§6.c del documento).
  Una persona sin grupo asignado es, de hecho, supernumeraria: no genera titularidad y ve el popup
  para tomar el control. No hay pantalla ni tabla de vacaciones en este flujo.
- **Sin cambios en el contrato cross-repo.** `evento_dashboard` y `disponibilidad_dashboard` no se
  tocan; `../docs/interfaces-cross-repo.md` no cambia.
