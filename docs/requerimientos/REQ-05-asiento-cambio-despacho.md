# REQ-05 — Asiento automático cuando cambia el despacho

| Campo | Valor |
|---|---|
| **Código** | REQ-05 |
| **Título** | Generar asiento en el histórico de Operación 24h ante un cambio de despacho, venga del registro o del correo del CND |
| **Estado** | 🟡 **Bloqueado** — falta la plantilla del asiento (ver §8.1) |
| **Origen** | `pendientes_Ernesto.md`: *"cuando cambia despacho (redesp<>desp por correo o registro) crear histórico en op24hr con el formato en la imagen"* |
| **Depende de** | [REQ-03](./REQ-03-operacion-24h-registros-unicos.md), [REQ-04](./REQ-04-historico-en-apartado.md), [REQ-02](./REQ-02-reflejo-bitacoras-sala.md) |
| **Cross-repo** | ⚠️ **Requiere cambios en `dashboard-gen-gec3`** y actualizar `docs/interfaces-cross-repo.md`. |

---

## 1. Contexto y problema

Cuando el CND cambia el despacho de un periodo, ese hecho debe quedar asentado en la bitácora de
Operación 24h. Hoy no queda: si el ingeniero teclea el redespacho en la grilla, el número queda pero
el **hecho** —"a tal hora el despacho de tal periodo cambió"— no se narra en ninguna parte; y si el
cambio llega por correo del CND y nadie lo transcribe, no queda absolutamente nada.

El objetivo es que el cambio de despacho produzca **siempre** un asiento legible en el histórico del
apartado, sin importar por cuál de las dos vías llegó.

### 1.1 Hallazgo clave: la ingesta del correo YA EXISTE

Durante el análisis se encontró que **el otro repositorio del workspace ya resuelve la parte más
difícil de este requerimiento**, y lo hace bien:

`dashboard-gen-gec3/server/emailDispatch.js` es un servicio maduro que:

- lee un buzón compartido por **Microsoft Graph API** (OAuth client-credentials, sin IMAP/SMTP),
- corre **cada 5 minutos**,
- filtra los correos cuyo asunto contiene `"Redespacho Periodo"` y extrae de él el **periodo** y la
  **fecha**,
- parsea la tabla HTML del cuerpo, identificando la planta por nombre (`GECELCA 3`, `GECELCA 32`,
  `GUAJIRA 1`, `GUAJIRA 2`),
- persiste en `dashboard.despacho_final` con `source='email'` y **trazabilidad completa al correo
  original** (`email_id`, `email_date`, `email_subject`),
- tiene **fallback** a la API de XM (`GeneProgRedesp`) y alerting por antigüedad de datos,
- corre en **dos instancias** (buzón GECELCA y buzón Guajiras),
- y ya expone el dato en `GET :3001/api/despacho-final/today`.

**No hay que construir la ingesta de correos.** Lo que falta es que Bitácora se entere.

## 2. Comportamiento actual

| Aspecto | Situación hoy |
|---|---|
| Registro manual de redespacho | El ingeniero lo teclea en la grilla de Operación 24h. Queda el número; no queda narración del cambio. |
| Correo de redespacho | Lo procesa el dashboard (§1.1). **Bitácora no lo ve.** |
| Comunicación entre repos | **Unidireccional: Bitácora → Dashboard.** `notifyDashboard()` hace un `POST /internal/eventos-changed` fire-and-forget al dashboard cuando cambia `evento_dashboard`; el dashboard lo reemite por WebSocket a sus clientes. Es **señal, no datos** (Contrato 3 de `docs/interfaces-cross-repo.md`). |
| Lectura del dashboard hacia Bitácora | `GET :3002/api/eventos-dashboard` — el dashboard consulta a Bitácora, no al revés. |
| Jerarquía de valores en el dashboard | `email > REDESP de Bitácora > fallback XM > archivo rDEC > simulado` (D-124 del otro repo). El correo **gana** sobre lo que registró el ingeniero. |

## 3. Comportamiento requerido

### 3.1 Dos disparadores

- **RQ-05.1** — Se genera un asiento **cuando un ingeniero registra un redespacho** en la grilla de
  Operación 24h.
- **RQ-05.2** — Se genera un asiento **cuando llega un correo de redespacho** del CND.
- **RQ-05.3** — **Solo la entrada en redespacho genera asiento.** La vuelta al despacho programado
  (cuando termina el redespacho) **no** genera asiento.

### 3.2 Cómo se entera Bitácora del correo

- **RQ-05.4** — **El dashboard le avisa a Bitácora.** Cuando el servicio de correo detecta un
  redespacho nuevo, notifica a Bitácora en el momento.
- **RQ-05.5** — Es el **espejo del canal que ya existe** en sentido contrario (Contrato 3). Se
  implementa con el mismo criterio: notificación post-persistencia, fire-and-forget, con timeout
  corto, que **nunca** bloquea ni hace fallar al emisor.
- **RQ-05.6** — La notificación debe permitir a Bitácora identificar el evento sin ambigüedad:
  planta, fecha, periodo, valor y referencia al correo de origen.

### 3.3 El asiento automático

- **RQ-05.7** — El autor del asiento generado por correo es el **usuario `SISTEMA`** (ya seedeado,
  `activo=0`, nunca loguea — D-015; mismo patrón que el cierre automático de fin de día).
- **RQ-05.8** — El asiento aparece en el **histórico del apartado de Operación 24h**
  ([REQ-04](./REQ-04-historico-en-apartado.md)).
- **RQ-05.9** — El asiento se **copia a `SALAJDT` y `SALAING`**, como cualquier otro evento de
  Operación 24h ([REQ-02](./REQ-02-reflejo-bitacoras-sala.md)).
- **RQ-05.10** — El asiento **NO llena la celda de la grilla** — la grilla es solo captura manual
  (RQ-03.1) y el asiento no debe confundirse con un registro tecleado por un ingeniero.
- **RQ-05.11** — El asiento **NO se publica al dashboard de generación**. El dato vino de él;
  reenviarlo sería un ciclo.
- **RQ-05.12** — El asiento se redacta con el **formato establecido** (§8.1).

### 3.4 Duplicados e idempotencia

- **RQ-05.13** — El mismo correo **no puede generar dos asientos**. La notificación puede llegar más
  de una vez (reintentos, reinicios del servicio) y el asiento debe ser **idempotente** respecto al
  correo de origen.
- **RQ-05.14** — Si el ingeniero ya registró manualmente el mismo redespacho y después llega el
  correo, **son dos hechos distintos y ambos se asientan**: uno es "el ingeniero registró", el otro
  es "llegó la notificación formal del CND". El asiento debe dejar clara la vía de origen.

## 4. Reglas de negocio y casos borde

- **RN-05.a** — Bitácora solo asienta redespachos de **sus** plantas (`GEC3`, `GEC32`). El buzón de
  Guajiras (`TGJ1`, `TGJ2`) que también procesa el dashboard **se ignora**.
- **RN-05.b** — La planta de test `TST` nunca recibe asientos automáticos (D-030).
- **RN-05.c** — Si el dashboard está caído o la notificación se pierde, **Bitácora no se rompe**: el
  asiento simplemente no se crea. La operación manual sigue funcionando. Debe haber forma de
  detectar la pérdida (ver §8.2).
- **RN-05.d** — El asiento automático **no** está sujeto al lock de Redespacho por periodo pasado
  (RQ-03.17): no es una captura del operador, es el registro de un hecho ya ocurrido y notificado.
- **RN-05.e** — El asiento automático **no** está sujeto a los bloqueos de turno finalizado/cerrado
  (Operación 24h está exenta, RQ-03.18).
- **RN-05.f** — El asiento automático se puede **borrar o corregir** desde el histórico (REQ-04) si
  resultó errado, con las mismas reglas que cualquier otro lote.

## 5. Impacto técnico

### 5.1 Brechas concretas (declaradas como riesgo, no resueltas acá)

1. **No existe canal Dashboard → Bitácora.** Hay que crearlo. El precedente (Contrato 3) da el
   patrón: endpoint interno, no expuesto por nginx, con token opcional
   (`INTERNAL_NOTIFY_TOKEN` en el otro sentido).

2. **`GET :3001/api/despacho-final/today` sirve solo HOY y desde memoria** del servicio
   (`getMergedDespachoFinal()` combina el estado en RAM de las dos instancias), no desde la base de
   datos. No hay endpoint por fecha arbitraria ni histórico de cambios del correo (el `MERGE` sobre
   `dashboard.despacho_final` sobrescribe). Si Bitácora necesitara reconstruir asientos perdidos,
   ese camino **no existe hoy**.

3. **🔴 El despacho original se descarta en el parseo.** La fila del correo trae tres números —
   código de unidad, **despacho original** y **redespacho** — y el parser guarda solo el tercero
   (`emailDispatch.js:237`, `const valorMw = parseFloat(numbers[2])`). **Por lo tanto el "de X MW a
   Y MW" hoy NO existe como dato.** Si la plantilla del asiento lo necesita —y probablemente lo
   necesita, porque un asiento de *cambio* de despacho sin el valor anterior narra a medias— hay que
   modificar el parser y agregar una columna en el otro repo. Es un cambio pequeño, pero es un
   cambio real y hay que planearlo.

4. **Red y despliegue.** El endpoint del dashboard no está proxeado por nginx para Bitácora. Hay
   que revisar `deploy/` y CORS en el despliegue unificado.

5. **🔴 `docs/interfaces-cross-repo.md` está desactualizado respecto al código.** Antes de agregarle
   un contrato nuevo hay que corregir lo que ya miente:
   - documenta la respuesta como `{ items: [...] }` cuando el código devuelve `{ eventos: [...] }`;
   - lista columnas `detalle` y `funcionariocnd` que el `SELECT` real **no** devuelve
     (`server/routes/eventos-dashboard.js:71-72`);
   - documenta `?tipo=&planta_id=` pero el endpoint **exige `fecha`** (400 si falta);
   - no menciona el gate opcional `DASHBOARD_API_TOKEN` ni la exclusión de la planta `TST`.

### 5.2 Archivos a tocar

**En `Bit-cora-g3`:**

| Archivo | Cambio |
|---|---|
| `server/routes/` | Endpoint interno receptor de la notificación del dashboard. |
| `server/auth/app.js` | Montaje + allowlist (nace cerrado por `requireEntra`, D-037; este endpoint es servicio-a-servicio y necesita su propio gate por token). |
| `server/utils/` | Generación del asiento automático (reutiliza el módulo de reflejo de REQ-02). |
| `server/routes/mand.js` | Disparador del asiento cuando el registro es manual (RQ-05.1). |
| `../docs/interfaces-cross-repo.md` | Corregir el Contrato 1 y documentar el contrato nuevo. |

**En `dashboard-gen-gec3`:**

| Archivo | Cambio |
|---|---|
| `server/emailDispatch.js` | Emitir la notificación al detectar redespacho nuevo; y —si la plantilla lo requiere— conservar el despacho original (`numbers[1]`). |
| `server/db.js` | Columna para el despacho original, si aplica. |
| `deploy/` | Conectividad hacia Bitácora. |

### 5.3 Riesgo de acoplamiento

Este es el único de los seis requerimientos que **acopla los dos repositorios en un sentido nuevo**.
Conviene que el asiento automático sea una **mejora degradable**: si el canal no está configurado o
el dashboard no responde, Bitácora funciona exactamente como hoy y solo se pierde el asiento
automático — nunca la operación. Mismo criterio que se usó con la mejora de texto por IA (D-047),
que degrada a 503 cuando no hay configuración.

## 6. Criterios de aceptación

1. **Dado** que un ingeniero registra un redespacho en la grilla, **cuando** miro el histórico del
   apartado, **entonces** aparece el asiento del cambio de despacho.
2. **Dado** que llega un correo de redespacho para GEC3, **cuando** miro el histórico, **entonces**
   aparece el asiento, con autor `SISTEMA`, sin que nadie haya tecleado nada.
3. **Dado** ese asiento automático, **cuando** miro `SALAJDT` y `SALAING`, **entonces** aparece
   copiado en las dos.
4. **Dado** ese asiento automático, **cuando** miro la grilla de captura, **entonces** las celdas
   siguen vacías (el asiento no las llena).
5. **Dado** ese asiento automático, **cuando** consulto lo publicado al dashboard, **entonces** no
   se republicó nada por causa del asiento.
6. **Dado** que la misma notificación llega dos veces, **entonces** existe **un solo** asiento.
7. **Dado** que el ingeniero ya registró el redespacho manualmente y después llega el correo,
   **entonces** existen **dos** asientos y cada uno indica su vía de origen.
8. **Dado** un correo de redespacho de `TGJ1` o `TGJ2`, **entonces** Bitácora lo ignora.
9. **Dado** que termina un redespacho y la unidad vuelve al despacho programado, **entonces** **no**
   se genera asiento.
10. **Dado** que el canal con el dashboard no está configurado o el dashboard está caído,
    **entonces** Bitácora opera normalmente y solo deja de recibir asientos automáticos.
11. **Dado** un asiento automático errado, **cuando** lo borro desde el histórico, **entonces** se
    borra junto con sus dos copias.
12. **Dado** `docs/interfaces-cross-repo.md`, **entonces** describe correctamente el shape real de
    `GET /api/eventos-dashboard` y el contrato nuevo.

## 7. Fuera de alcance

- Construir la ingesta de correos: **ya existe** en `dashboard-gen-gec3`.
- Asentar el retorno al despacho programado.
- Asentar redespachos de las plantas Guajira.
- Reconstruir asientos de correos anteriores al despliegue.
- Cambiar la jerarquía de valores del dashboard (D-124 del otro repo).
- Que Bitácora lea el buzón directamente.

## 8. Preguntas abiertas

### 8.1 🔴 BLOQUEANTE — plantilla del asiento

Falta el formato con que debe redactarse el asiento de cambio de despacho. En la nota original se
menciona "el formato en la imagen", **pero esa imagen no está en el repositorio** (el `image.png` de
la raíz es el mockup del botón de IA, sin relación).

Falta definir: la redacción literal, y si distingue explícitamente la vía de origen (registro del
ingeniero vs. correo del CND).

**De la respuesta a esto depende la brecha 3 de §5.1**: si el formato incluye el valor anterior, hay
que modificar el parser del otro repo.

**Se trata en una sesión aparte.** Era el mismo bloqueo que [REQ-02](./REQ-02-reflejo-bitacoras-sala.md)
y [REQ-04](./REQ-04-historico-en-apartado.md) — **los dos ya se resolvieron en D-058**, este no.

> **Qué cambió con D-058 (2026-07-27) y qué no.** Ya existen el **motor de asientos**
> (`server/utils/asientos/`, server-side y puro) y las **convenciones canónicas** —unidad
> `GEC3`/`GEC32`, potencia entera en `MW`, compactación de periodos, `detalle` al final—
> especificadas en [`FORMATO-ASIENTOS-OPERACION.md`](./FORMATO-ASIENTOS-OPERACION.md). Agregar un
> tipo de asiento es hoy **una plantilla más en `plantillas.js`**, no una arquitectura.
>
> **Lo que sigue faltando es propio de este REQ:** la redacción del cambio de despacho, que es la
> única que necesita **dos** valores (el anterior y el nuevo) — ninguna plantilla de D-058 los tiene,
> y de ahí depende la brecha 3 de §5.1 (si hay que tocar el parser del otro repo). Sigue **bloqueado**.

### 8.2 Pérdida de notificaciones

El canal es fire-and-forget: si Bitácora está caída cuando llega el correo, el asiento se pierde y
no hay forma de recuperarlo (§5.1 brecha 2). ¿Es aceptable, o hace falta un mecanismo de
reconciliación (que Bitácora consulte al arrancar qué se perdió)?

### 8.3 Granularidad de la notificación

Un correo del CND puede traer varias plantas en la misma tabla. ¿Se notifica una vez por planta o
una vez por correo con todas? Afecta la idempotencia (RQ-05.13).

### 8.4 Visibilidad de la vía de origen

¿El asiento debe distinguirse visualmente (icono/rótulo) según si vino del registro manual o del
correo, o basta con que lo diga el texto?
