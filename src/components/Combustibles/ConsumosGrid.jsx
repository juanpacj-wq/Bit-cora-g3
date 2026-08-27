import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// Fuentes locales (@fontsource, sin CDN en runtime — mismo criterio que DISP).
import '@fontsource/archivo/400.css';
import '@fontsource/archivo/600.css';
import '@fontsource/archivo/700.css';
import '@fontsource/archivo/800.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/jetbrains-mono/700.css';
import { useCombustibles } from '../../hooks/useCombustibles';
import { SelectorFecha } from './SelectorFecha';
import { HEATMAP_MAX_TON, HEATMAP_MAX_FALLBACK, temaHeatmap, tint } from './colores';
import {
  esOverride, textoOverride, politicaRefresco, restanteGavela, formatoMMSS, textoChipSis, GAVELA_MS,
  claveRefetch, esVacioCantidad, esCeroNoOp,
  reconciliarBuffer, calcularDiff, coordenadasEditadas, hayEdicion, clon, ladoPopover,
} from './override';
import { getTodayBogota } from '../../utils/fecha';
import './combustibles.css';

// D-027: grilla de Consumos de Combustibles. Patrón paralelo a SalaDeMandoGrid:
// buffer-en-memoria editable + snapshot del server + diff() al guardar.
//
// Columnas: alimentadores de la planta + columna virtual "Total Carbón" (suma vivo de
// tipo='ALIMENTADOR' en el buffer, no entra al diff) + Caliza + ACPM.
// Filas: 24 periodos (1..24, donde periodo N corresponde a la hora N-1 Bogotá).
//
// Sin badge (SIN_BADGE_CODIGOS.add('COMB') del prompt 04 → no dispara
// `bitacora:counts-refresh`).
const PERIODOS = Array.from({ length: 24 }, (_, i) => i + 1);

// D-061: cada cuánto relee la grilla cuando GEC32 está "en vivo" (viendo hoy, sin edición a
// medias). 5 min es holgado frente al sweeper del SIS —que escribe la hora cerrada— y no convierte
// una pestaña abierta todo el turno en polling agresivo contra el server.
const AUTO_REFRESCO_MS = 5 * 60 * 1000;

// D-061 L12 (H66/CA-57): "todavía no hay datos de esta coordenada". Es UN valor y no un `{}` nuevo
// cada vez para que volver a él sea un no-op de React (bail-out por identidad) en vez de un render
// de más, y está congelado porque nadie debe escribirle encima: tanto el buffer como el snapshot
// arrancan acá y vuelven acá cuando cambia la planta o la fecha.
const SIN_DATOS = Object.freeze({});

// D-061 L08 (H14/CA-32): cada `accion` que puede devolver C5 tiene su propio texto y su propio
// tono. `sin_cambios` no es un éxito operativo: no se deshizo nada, y decirlo como tal haría que
// alguien creyera que su corrección desapareció.
const TOAST_REVERTIR = {
  restaurado: ['Revertido al valor SIS', 'success'],
  eliminado: ['Celda eliminada (valor SIS = 0)', 'success'],
  sin_cambios: ['La celda ya tenía el valor del SIS', 'info'],
};

// D-034: motivos estructurados del backend → texto amigable es-CO para los toasts.
const MOTIVO_TEXTO = {
  cantidad_excede_max: 'una o más cantidades superan el máximo permitido',
  cantidad_invalida: 'cantidad inválida',
  periodo_fuera_rango: 'periodo fuera de rango',
  combustible_no_pertenece_planta: 'combustible no corresponde a la planta',
};

// D-035: `fecha`/`onFechaChange` son controlados por el dashboard (la URL es la fuente de verdad
// para deep-link/F5). El resto de la lógica (snapshot/buffer, diff, validaciones D-034,
// beforeunload) queda intacta.
export default function ConsumosGrid({ bitacora, plantaId, puedeCrear, showToast, fecha, onFechaChange }) {
  const { loading, getConsumos, guardarBatch, revertirCelda } = useCombustibles();

  const [catalogo, setCatalogo] = useState([]);
  const [snapshot, setSnapshot] = useState(SIN_DATOS);  // shape: { "<periodo>": { "<combustible_id>": { cantidad, detalle, ... } } }
  const [buffer, setBuffer] = useState(SIN_DATOS);
  const [error, setError] = useState(null);
  // D-061: estado del scrape SIS del día (`sis_scrape_log`, C4) para el chip de la topbar. Hasta
  // que L02 lo exponga llega `undefined` → el chip dice "sin lectura", que es la verdad.
  const [sis, setSis] = useState(null);
  // Celda cuyo popover de override está abierto por click ('<periodo>:<combustible_id>'). El hover
  // lo maneja el CSS; este estado es el que deja el popover fijo para poder llegar a "Revertir".
  const [tipAbierto, setTipAbierto] = useState(null);
  // D-061 L09 (H26/CA-39) + L11 (H53/H58 · CA-50): hacia dónde abre el popover. Se mide al abrir
  // (hover o click) y no en cada scroll: un `getBoundingClientRect` por banderín tocado, contra los
  // 240 por render que costaría recalcular la posición en vivo.
  //
  // Son DOS cosas distintas y por eso viven en dos lugares distintos:
  //  - `ladoFijo`: el lado del popover FIJADO por clic. Es lo único que necesita estado, porque
  //    tiene que sobrevivir a cualquier re-render. L09 lo guardaba en la MISMA entrada que el
  //    hover, así que pasar el puntero por cualquier otro banderín le cambiaba la `clave` al
  //    fijado: volvía al default abajo-derecha y se recortaba (H53, que es H13 otra vez).
  //  - `ladoHoverRef`: el lado del popover que aparece SOLO por puntero. Va en un ref y se escribe
  //    directo en el nodo (ver el `onMouseEnter` del banderín). Como estado costaba un re-render de
  //    las ~240 celdas por cada banderín que el puntero rozaba, donde L08 tenía hover de CSS puro a
  //    costo cero (H58). El render lo vuelve a leer de acá, así que un re-render que llegue con el
  //    puntero encima no le quita el lado ya medido.
  const [ladoFijo, setLadoFijo] = useState(null);
  const ladoHoverRef = useRef(null);
  // Gavela (D-061): instante en que empezó a correr la ventana de 10 min, y lo que le queda.
  const [gavelaInicio, setGavelaInicio] = useState(null);
  const [restanteMs, setRestanteMs] = useState(GAVELA_MS);

  // showToast estable a través de re-renders (mismo patrón que SalaDeMandoGrid).
  const showToastRef = useRef(showToast);
  useEffect(() => { showToastRef.current = showToast; }, [showToast]);

  // D-061 L08 (H3/CA-33) — refs de la lectura en vuelo. Una respuesta del server que llega tarde no
  // puede aplicarse a ciegas: entre que sale el GET y vuelve, el operador pudo teclear una celda o
  // cambiar de fecha. `refetchSeqRef` numera cada lectura (solo la última manda) y `claveActualRef`
  // guarda la coordenada (planta, fecha) que se está viendo AHORA.
  const refetchSeqRef = useRef(0);
  const claveActualRef = useRef(claveRefetch(plantaId, fecha));

  // D-061 L12 (H68/CA-58) — el último snapshot que la grilla ADOPTÓ, y el punto único por el que se
  // adopta uno. Escribe el estado y el ref en el mismo instante y devuelve el que había.
  //
  // Antes el ref lo escribía un efecto posterior al commit, así que quien lo leía dependía del
  // ORDEN DE LOS COMMITS y no de sus entradas: el actualizador de `setBuffer` podía correr contra un
  // `snapshotRef.current` distinto según cuándo React decidiera vaciar los efectos. Escribiéndolo
  // acá, "el snapshot vigente" es un hecho del momento en que se decide, no de cuándo se pinta, y
  // los dos lectores que quedan —la reconciliación del refetch y `descartar`— ven siempre lo mismo
  // que el render.
  const snapshotRef = useRef(snapshot);
  const adoptarSnapshot = useCallback((celdas) => {
    const previo = snapshotRef.current;
    snapshotRef.current = celdas;
    setSnapshot(celdas);
    return previo;
  }, []);

  // Lee del server y aplica la respuesta, salvo que haya quedado obsoleta.
  //
  // `preservarEdicion` distingue los dos motivos por los que se relee:
  //  - false (cambio de planta/fecha, guardar, revertir, vencimiento de la gavela): el buffer se
  //    reemplaza porque el usuario pidió explícitamente moverse o ya cerró su edición.
  //  - true (latido del auto-refresco y `focus`): lo tecleado se conserva. El latido chequea
  //    `hayCambios` ANTES de disparar, pero teclear durante el GET caía en la ventana ciega y se
  //    perdía bajo un refresco que nadie pidió.
  const refetch = useCallback(async ({ preservarEdicion = false } = {}) => {
    if (!plantaId) return;
    const seq = ++refetchSeqRef.current;
    const clave = claveRefetch(plantaId, fecha);
    try {
      const r = await getConsumos(plantaId, fecha);
      // Obsoleta por adelantamiento (llegó otra lectura después) o por cambio de coordenada.
      if (seq !== refetchSeqRef.current || clave !== claveActualRef.current) return;
      const celdas = r.celdas || {};
      setError(null);
      setCatalogo(r.catalogo || []);
      setSis(r.sis ?? null);
      // El snapshot y el chip SIS se actualizan siempre: son la verdad del server (de ahí sale el
      // badge de override) y no pisan nada de lo tecleado. `snapPrev` es el snapshot contra el que
      // el operador venía editando, y hay que leerlo ANTES de adoptar el nuevo.
      const snapPrev = adoptarSnapshot(celdas);

      // D-061 L09 (H24): con una edición en curso el buffer NO se conserva entero —eso dejaba lo
      // que el SIS acababa de escribir como "solo en el snapshot", y el Guardar siguiente lo
      // mandaba al POST con `cantidad: null` a nombre del operador—. Se reconcilia celda por
      // celda: entra lo del server, se queda lo tecleado.
      //
      // D-061 L12 (H65/CA-56): la reconciliación ya no se condiciona a `hayCambiosRef`. Sin nada
      // pendiente, `coordenadasEditadas` sale vacío y `reconciliarBuffer` degenera exactamente en
      // "el buffer pasa a ser el snapshot nuevo", que es lo que hacía la otra rama; con algo
      // pendiente hace lo suyo. Una rama menos, y de paso se cierra la ventana de microtareas en la
      // que ese ref —que lo escribe un efecto— todavía decía `false` y una tecla se perdía bajo el
      // refetch (H-2 de L09). El actualizador queda PURO: solo depende de `b` y de dos valores ya
      // capturados, así que invocarlo dos veces desde la misma base da el mismo resultado (H68).
      if (preservarEdicion) {
        setBuffer((b) => reconciliarBuffer(b, celdas, coordenadasEditadas(b, snapPrev)));
      } else {
        setBuffer(clon(celdas));
      }
    } catch (e) {
      if (seq !== refetchSeqRef.current || clave !== claveActualRef.current) return;
      setError(e);
    }
  }, [plantaId, fecha, getConsumos, adoptarSnapshot]);

  // La clave se refresca en el MISMO efecto que dispara la lectura de la nueva coordenada: así no
  // hay ventana en que `claveActualRef` apunte a la fecha vieja y se descarte la respuesta buena.
  //
  // D-061 L12 (H66/CA-57): y el buffer y el snapshot se vacían JUNTOS, acá mismo. La invariante que
  // hace derivable "qué está pendiente" es que los dos describen la MISMA coordenada; en cuanto la
  // coordenada cambia, lo que quedó en pantalla es de otro día y no significa nada. Antes se
  // limpiaba el conjunto de editadas y se dejaban los dos en pie: si el GET nuevo fallaba, la
  // pantalla se quedaba con los números de ayer, Guardar encendido y un diff vacío —"Sin cambios
  // para guardar" en bucle hasta descartar o esperar 10 minutos—. Vaciarlos no es solo cosmético:
  // impide que una edición de ayer termine en el POST de hoy.
  useEffect(() => {
    claveActualRef.current = claveRefetch(plantaId, fecha);
    adoptarSnapshot(SIN_DATOS);
    setBuffer(SIN_DATOS);
    refetch();
  }, [refetch, plantaId, fecha, adoptarSnapshot]);

  // D-061 L11 (H52/CA-49): "sucio" tiene UNA sola definición, y es la del POST. Antes esto
  // comparaba `JSON.stringify` del buffer entero contra el snapshot —metadata incluida—, mientras
  // el diff miraba solo las editadas y solo `cantidad`/`detalle`. Bastaba con que la respuesta de
  // un GET trajera `modificado_en`/`valor_sis` frescos de una celda editada para dejar Guardar
  // encendido, la gavela corriendo y el `beforeunload` armado sobre un diff VACÍO: al hacer clic
  // salía "Sin cambios para guardar" y el operador quedaba atascado hasta descartar o esperar los
  // 10 min de la gavela, que además le anunciaba que "se descartaron cambios sin guardar".
  //
  // D-061 L12 (H66/H74 · CA-57): el memo depende SOLO de sus dos entradas. La versión anterior leía
  // además el conjunto mutable de editadas y se apoyaba en una invariante que este archivo
  // declaraba y no cumplía —"toda mutación del conjunto va acompañada de un `setBuffer`"—: el
  // efecto de cambio de coordenada lo vaciaba sin tocar el buffer, y si el GET siguiente fallaba el
  // memo no se recalculaba nunca y `hayCambios` quedaba pegado en `true` sobre un conjunto vacío.
  // Ahora no hay invariante que recordar: `hayEdicion` es la misma definición que usa el diff,
  // aplicada a las mismas dos estructuras, y corta en la primera diferencia en vez de armar y
  // ordenar el diff entero en cada tecla (H74).
  const hayCambios = useMemo(() => hayEdicion(buffer, snapshot), [buffer, snapshot]);

  // D-061 — refs para lo que corre FUERA del render (intervalos y el listener de `focus`): un
  // `setInterval` montado una vez se queda con el `refetch`/`hayCambios` del render en que nació y
  // seguiría releyendo la fecha vieja, o pisaría una edición empezada después. Con refs, el timer
  // siempre ve el valor de ahora sin tener que re-montarse en cada tecla.
  //
  // D-061 L12 (H68/CA-58): `snapshotRef` ya NO se escribe desde un efecto — lo escribe
  // `adoptarSnapshot`, en el mismo instante en que se decide el snapshot. Lo que queda acá son los
  // dos refs que sí son "la foto del último render" para código que corre fuera de él.
  const refetchRef = useRef(refetch);
  const hayCambiosRef = useRef(hayCambios);
  useEffect(() => { refetchRef.current = refetch; }, [refetch]);
  useEffect(() => { hayCambiosRef.current = hayCambios; }, [hayCambios]);

  // D-061 L08 (H6/CA-33) — el día Bogotá es ESTADO, no un valor memorizado por (planta, fecha,
  // hayCambios). Antes, una pestaña abierta que cruzaba las 00:00 se quedaba con el `hoy` del
  // render anterior: seguía auto-refrescando un día que ya era ayer y —peor— mantenía viva la
  // gavela, que a los 10 min DESCARTA lo tecleado, sobre una fecha pasada donde no aplica.
  // Se repregunta cada minuto y al volver a la pestaña; sigue sin preguntarse en cada render
  // (la grilla re-renderiza con cada tecla y `getTodayBogota` arma un Intl.DateTimeFormat nuevo).
  const [hoy, setHoy] = useState(getTodayBogota);
  useEffect(() => {
    const revisar = () => setHoy(getTodayBogota());
    const id = setInterval(revisar, 60 * 1000);
    window.addEventListener('focus', revisar);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', revisar);
    };
  }, []);

  const politica = useMemo(
    () => politicaRefresco({ plantaId, fecha, hoy, hayCambios }),
    [plantaId, fecha, hoy, hayCambios]
  );

  // Auto-refresco (CA-13): solo GEC32 viendo hoy y sin cambios locales. Se desmonta solo cuando
  // aparece el primer cambio en el buffer (`politica.autoRefresco` pasa a false), que es lo que
  // garantiza que jamás se le borre a alguien lo que está escribiendo.
  useEffect(() => {
    if (!politica.autoRefresco) return;
    const tick = () => {
      if (hayCambiosRef.current) return;              // empezó a editar entre latidos
      if (fecha !== getTodayBogota()) return;         // la pestaña cruzó la medianoche: ya no es hoy
      // `preservarEdicion`: la guarda de arriba mira ANTES de salir; esta protege lo que se teclee
      // MIENTRAS el GET viaja, que es la ventana que H3 encontró abierta.
      refetchRef.current({ preservarEdicion: true });
    };
    const id = setInterval(tick, AUTO_REFRESCO_MS);
    window.addEventListener('focus', tick);           // volver a la pestaña trae el dato fresco ya
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', tick);
    };
  }, [politica.autoRefresco, fecha]);

  // Descartar el buffer y volver al último snapshot del server. Lo usan el botón "Descartar" y el
  // vencimiento de la gavela.
  const descartar = useCallback(() => {
    // D-061 L12 (H65/CA-56): no hay ningún conjunto que limpiar aparte. Dejar el buffer igual al
    // snapshot vigente ES no tener nada pendiente, por definición.
    setBuffer(clon(snapshotRef.current));
    setGavelaInicio(null);
  }, []);

  // Arranque/apagado de la gavela: nace con el primer cambio en modo "en vivo" y muere cuando ya
  // no hay cambios (guardar o descartar) o cuando se sale de GEC32/hoy.
  useEffect(() => {
    if (!politica.gavela) { setGavelaInicio(null); return; }
    setGavelaInicio((prev) => (prev == null ? Date.now() : prev));
  }, [politica.gavela]);

  // Cuenta regresiva de 1 s (CA-14). Al llegar a 0: descarta, relee y avisa — el operador se entera
  // de que perdió una edición a medias, en vez de seguir mirando una grilla congelada.
  useEffect(() => {
    if (gavelaInicio == null) { setRestanteMs(GAVELA_MS); return; }
    const tick = () => {
      const r = restanteGavela(gavelaInicio, Date.now());
      setRestanteMs(r);
      if (r === 0) {
        descartar();
        refetchRef.current();
        showToastRef.current?.('Se descartaron cambios sin guardar (10 min)', 'info');
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [gavelaInicio, descartar]);

  // Advertencia al cerrar la pestaña con cambios sin guardar (igual que SalaDeMando).
  useEffect(() => {
    if (!hayCambios) return;
    const h = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [hayCambios]);

  const setCelda = (periodo, combustibleId, cantidad) => {
    // D-061 L09 (H24/CA-37): este es el ÚNICO lugar por el que el operador toca el buffer. Todo lo
    // demás que escribe el buffer viene sembrado desde el snapshot, y esa es justamente la
    // invariante que hace derivable "qué está pendiente" (ver `coordenadasEditadas`).
    const p = String(periodo);
    const k = String(combustibleId);
    // D-061 L12 (H68/CA-58): la celda del server se lee ACÁ, del snapshot de este render, y no
    // desde un ref adentro del actualizador. React puede invocar un actualizador más de una vez y
    // desde otra base (modo estricto, camino de estado ansioso): mientras dependa solo de `b` y de
    // valores ya capturados, repetirlo no puede dar un resultado distinto. Y es lo mismo que el
    // operador tiene en pantalla, que es contra lo que está editando.
    const celdaSnap = snapshot[p]?.[k];
    setBuffer((b) => {
      const next = { ...b };
      const fila = next[p] ? { ...next[p] } : {};
      // D-061 L08 (H5/CA-34): el snapshot manda. Si el server ya tiene esta celda en 0 (override 0
      // de C6), teclear 0 o vaciarla no es un cambio: se restituye la celda del snapshot tal cual
      // en vez de borrar la clave del buffer, y con eso la celda queda equivalente a la del server
      // y no queda nada pendiente. (L09 restituía un clon por JSON para que el `JSON.stringify` de
      // `hayCambios` volviera a dar false; desde L11 esa comparación ya no existe, pero restituir
      // la celda del server sigue siendo lo correcto: es lo que el server tiene.)
      if (esCeroNoOp(cantidad, celdaSnap)) {
        fila[k] = clon(celdaSnap);
        next[p] = fila;
      } else if (esVacioCantidad(cantidad)) {
        delete fila[k];
        if (Object.keys(fila).length === 0) delete next[p];
        else next[p] = fila;
      } else {
        // D-061 L09 (H25/CA-38): si la celda no está en el buffer se siembra desde el SNAPSHOT, no
        // desde `{}`. Limpiar una celda la borra del buffer (rama de arriba), así que volver a
        // teclear un número la reconstruía desde cero y perdía `detalle`: el diff mandaba
        // `detalle: null` y el backend, en su rama de UPDATE, escribía NULL. Un 18,5 con la nota
        // "Tolva atascada" corregido a 20 se llevaba la nota por delante, con un 200 que decía
        // "1 actualizado". El comentario es de la celda; cambiar la cifra no lo borra.
        const base = fila[k] || celdaSnap;
        fila[k] = { ...(base || {}), cantidad };
        next[p] = fila;
      }
      // D-061 L11 (H50/CA-48) → L12 (H65/CA-56): acá ya no se marca ni se desmarca nada. Que la
      // celda quede pendiente o no lo dice cómo QUEDÓ frente al snapshot, y eso lo responde
      // `coordenadasEditadas` cuando alguien pregunta, sobre el estado de ese momento.
      //
      // L11 llevaba la decisión adentro de este actualizador porque dependía de cuál de las tres
      // ramas de arriba había corrido. Funcionaba, pero convertía al actualizador en un efecto
      // secundario: dos ramas distintas dejaban el conjunto distinto, así que una re-ejecución de
      // React desde otra base podía tomar la otra rama y la idempotencia de `add`/`delete` no la
      // cubría (H68). Y sobre todo, el conjunto podía quedar viejo apenas el server cambiara la
      // celda por debajo (H65): esa era la tercera aparición del mismo modo de pérdida de datos.
      return next;
    });
  };

  // D-061 L09 (H27/CA-40): qué es un alimentador se decide UNA vez. Antes lo decidían por su
  // cuenta `columnasOrdenadas`, el conteo `nAlim`, el Total Carbón y el máximo del heatmap —cuatro
  // filtros sobre el mismo catálogo, con la misma condición escrita cuatro veces—. Es el
  // discriminador del dominio (`tipo='ALIMENTADOR'`, D-027) y sostiene el Total Carbón que el
  // backend calcula igual en `v_consumo_periodo`: tiene que haber un solo lugar donde se lea.
  const alimentadores = useMemo(() => catalogo.filter((c) => c.tipo === 'ALIMENTADOR'), [catalogo]);

  // Total Carbón por periodo: suma de tipo='ALIMENTADOR' del buffer (no incluye Caliza ni ACPM).
  // Coincide con la fórmula de bitacora.v_consumo_periodo.total_carbon_ton del backend.
  const totalCarbonPeriodo = useCallback((periodo) => {
    const p = String(periodo);
    const fila = buffer[p] || {};
    let total = 0;
    for (const cb of alimentadores) {
      const v = fila[String(cb.combustible_id)]?.cantidad;
      if (typeof v === 'number' && Number.isFinite(v)) total += v;
    }
    return total;
  }, [buffer, alimentadores]);

  const onGuardar = async () => {
    try {
      // D-061 L09 (H24/CA-37): el diff recorre las celdas EDITADAS, no la unión de buffer y
      // snapshot. La diferencia entre los dos también la produce el SIS escribiendo por debajo
      // durante un refetch, y esas celdas no son del operador: mandarlas al POST las borraba (o
      // las convertía en override 0 a su nombre) y la ownership de D-029 ya no las repone.
      const celdasDiff = calcularDiff(buffer, snapshot, coordenadasEditadas(buffer, snapshot));
      if (celdasDiff.length === 0) {
        showToastRef.current?.('Sin cambios para guardar', 'info');
        return;
      }
      const resp = await guardarBatch({ planta_id: plantaId, fecha, celdas: celdasDiff });
      const { creados = 0, actualizados = 0, eliminados = 0 } = resp.resumen || {};
      showToastRef.current?.(`Guardado: ${creados} nuevos, ${actualizados} actualizados, ${eliminados} eliminados`, 'success');
      await refetch();
    } catch (e) {
      // Errores estructurados del backend (cantidad inválida, periodo OOR, etc.)
      if (Array.isArray(e.errores) && e.errores.length > 0) {
        const motivos = [...new Set(e.errores.map((x) => MOTIVO_TEXTO[x.motivo] || x.motivo))].join(', ');
        showToastRef.current?.(`Errores de validación: ${motivos}`, 'error');
      } else {
        showToastRef.current?.(`Error al guardar: ${e.message || 'desconocido'}`, 'error');
      }
    }
  };

  // D-061 (CA-12): devolver la celda al valor del SIS. El refetch posterior es el que hace
  // desaparecer el badge —el estado de override lo dicta el backend, no el front—.
  const onRevertir = async (periodo, combustibleId) => {
    try {
      const r = await revertirCelda({
        planta_id: plantaId, fecha, periodo, combustible_id: combustibleId,
      });
      cerrarTip();
      await refetch();
      // H14/CA-32: el toast dice lo que REALMENTE pasó. Antes, `sin_cambios` (la celda ya estaba en
      // el valor del SIS) se anunciaba como "Revertido al valor SIS": el operador leía que su
      // corrección se deshizo cuando no había nada que deshacer.
      const [texto, tipo] = TOAST_REVERTIR[r?.accion] ?? TOAST_REVERTIR.restaurado;
      showToastRef.current?.(texto, tipo);
    } catch (e) {
      // `e.message` ya viene saneado por el backend (D-032); `body.mensaje` es el texto largo
      // cuando el endpoint lo manda. Nunca se arma el texto a partir de un `codigo` crudo.
      showToastRef.current?.(e.body?.mensaje ?? e.message ?? 'No se pudo revertir', 'error');
    }
  };

  // D-061 L09 (H26/CA-39): mide el banderín contra el recuadro visible de `.comb-scroll` y
  // devuelve hacia dónde tiene que abrir su popover. Se llama al entrar el puntero al banderín y al
  // hacer clic en él — los dos caminos por los que el popover aparece—, nunca en el scroll ni en el
  // render.
  //
  // D-061 L11 (H54/CA-51): descuenta lo que la cabecera y la primera columna PEGAJOSAS tapan del
  // recuadro. `.comb-scroll` es el que recorta, pero sus ~34 px de arriba los ocupa el `thead`
  // (`position:sticky; top:0`) y la izquierda la columna de periodos: contarlos como espacio libre
  // hacía que un popover volteado hacia arriba se pintara ENCIMA de los nombres de columna —gana
  // por `z-index:5` contra el `2` del `thead`—, justo el recorte que voltearlo venía a evitar.
  // La decisión sigue siendo pura (`ladoPopover`); acá solo se mide.
  //
  // D-061 L11 (H58/CA-50): ya no escribe estado. Devuelve el lado y cada llamador decide qué hacer
  // con él: el clic lo guarda en `ladoFijo`, el hover lo escribe en el nodo sin re-renderizar.
  const scrollRef = useRef(null);
  const medirLado = useCallback((el) => {
    if (!el || !scrollRef.current) return null;
    const caja = scrollRef.current;
    const cabecera = caja.querySelector('thead')?.getBoundingClientRect();
    const primeraCol = caja.querySelector('.comb-th-first')?.getBoundingClientRect();
    return ladoPopover({
      banderin: el.getBoundingClientRect(),
      contenedor: caja.getBoundingClientRect(),
      margenArriba: cabecera ? cabecera.bottom - cabecera.top : 0,
      margenIzquierda: primeraCol ? primeraCol.right - primeraCol.left : 0,
    });
  }, []);

  // Cerrar el popover fijado suelta también su lado (H53): dejarlo colgado era la mitad del defecto
  // —`setTipAbierto(null)` no limpiaba nada— y con el lado del hover en su propio ref no hace falta
  // conservarlo: el próximo `onMouseEnter` vuelve a medir.
  const cerrarTip = useCallback(() => { setTipAbierto(null); setLadoFijo(null); }, []);

  // El popover no debe sobrevivir a un cambio de planta/fecha (quedaría describiendo una celda
  // que ya no está en pantalla) ni a un Escape.
  useEffect(() => {
    setTipAbierto(null);
    setLadoFijo(null);
    ladoHoverRef.current = null;   // su `clave` es de la coordenada que se acaba de dejar
  }, [plantaId, fecha]);
  useEffect(() => {
    if (!tipAbierto) return;
    const h = (e) => { if (e.key === 'Escape') cerrarTip(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [tipAbierto, cerrarTip]);

  // Reorden de columnas: alimentadores → Total Carbón (virtual) → Caliza → ACPM.
  // La columna virtual lleva `virtual: true` y un id 'TOTAL' que no se confunde con ningún
  // combustible_id real (entero positivo de la BD).
  const columnasOrdenadas = useMemo(() => [
    ...alimentadores,
    { combustible_id: 'TOTAL', nombre: 'Total Carbón', unidad: 'Ton', tipo: 'TOTAL', virtual: true },
    ...catalogo.filter((c) => c.tipo === 'CALIZA'),
    ...catalogo.filter((c) => c.tipo === 'ACPM'),
  ], [catalogo, alimentadores]);

  // D-034: límite físico por combustible (data-driven desde cantidad_max del catálogo).
  // maxPorId: clave string (igual que el buffer). null = sin tope.
  const maxPorId = useMemo(() => {
    const m = new Map();
    for (const c of catalogo) {
      m.set(String(c.combustible_id), c.cantidad_max == null ? null : Number(c.cantidad_max));
    }
    return m;
  }, [catalogo]);

  // Máximo del heatmap = mayor cantidad_max entre alimentadores (fallback a la constante).
  const maxAlim = useMemo(() => {
    let mx = 0;
    for (const c of alimentadores) {
      if (c.cantidad_max != null) mx = Math.max(mx, Number(c.cantidad_max));
    }
    return mx > 0 ? mx : HEATMAP_MAX_TON;
  }, [alimentadores]);

  // Tema por unidad: rampa del heatmap (azul GEC3 / verde GEC32) + acento del CSS.
  const { rampa, accent } = useMemo(() => temaHeatmap(plantaId), [plantaId]);

  // Celdas del buffer cuyo valor supera su cantidad_max → bloquean el guardado (front).
  const celdasInvalidas = useMemo(() => {
    let n = 0;
    for (const p of Object.keys(buffer)) {
      for (const cid of Object.keys(buffer[p])) {
        const max = maxPorId.get(cid);
        const v = buffer[p][cid]?.cantidad;
        if (max != null && typeof v === 'number' && v > max) n++;
      }
    }
    return n;
  }, [buffer, maxPorId]);
  const hayInvalidos = celdasInvalidas > 0;

  return (
    // .comb-root (flex-1 + scroll DENTRO de .comb-scroll): el parent en BitacorasGecelca3.jsx
    // es `h-screen flex flex-col`; sin esto, el grid (24 periodos × N combustibles) excede el
    // viewport y el page document hace scroll vertical, empujando BitacoraTabs fuera de vista
    // (softlock de navegación). Mismo patrón anti-softlock que SalaDeMando y DisponibilidadDashboard.
    <div className="comb-root" style={{ '--accent': accent }}>
      <div className="comb-card">
        <div className="comb-topbar">
          <div className="comb-topbar-left">
            <h2 className="comb-title">
              {bitacora?.nombre ? `${bitacora.nombre} · Mapa de carga` : 'Consumos · Mapa de carga'}
            </h2>
            <SelectorFecha fecha={fecha} onChange={onFechaChange} disabled={loading} />
          </div>
          <div className="comb-topbar-right">
            {/* Leyenda de escala: chips desde la rampa del tema → coinciden con tint() siempre.
                Leyenda cualitativa (bajo→alto): cada tipo normaliza contra su propio tope. */}
            <div className="comb-legend">
              bajo
              <span className="comb-legend-bar">
                {rampa.map((c) => (
                  <i key={c} style={{ background: c }} />
                ))}
              </span>
              alto
            </div>
            {/* D-061 (CA-15): estado de la ingesta del SIS del día que se está viendo. Solo GEC32
                tiene SIS; en GEC3 el chip no existe (no hay nada que informar). */}
            {plantaId === 'GEC32' && (
              <span className="comb-sis-chip" title="Lecturas del SIS para esta fecha">
                {textoChipSis(sis)}
              </span>
            )}
            {/* D-061 (CA-14): con GEC32 en vivo, una edición sin guardar congela el auto-refresco.
                La cuenta regresiva lo dice de frente y da salida: guardar o descartar. */}
            {politica.gavela && (
              <span className="comb-gavela">
                ⏱ Cambios sin guardar · se descartan en {formatoMMSS(restanteMs)}
                <button type="button" onClick={descartar}>Descartar</button>
              </span>
            )}
            {/* D-048: el permiso de escritura en COMB es data-driven (matriz → puede_crear). Si el
                cargo no puede crear (p. ej. Operador de Carbón y Caliza, ahora solo-lectura), se
                oculta Guardar y se muestra un chip explícito. Los inputs ya van disabled abajo, y el
                backend rechaza con 403 aunque se evada el front — este chip es solo comunicación. */}
            {puedeCrear ? (
              <button
                type="button"
                onClick={onGuardar}
                disabled={!hayCambios || loading || hayInvalidos}
                className="comb-save"
              >
                Guardar
              </button>
            ) : (
              <span className="comb-readonly" title="No tienes permiso para editar Consumos de Combustibles">
                Solo lectura
              </span>
            )}
          </div>
        </div>

        {hayInvalidos && (
          <div className="comb-alert">
            ⚠ {celdasInvalidas} {celdasInvalidas === 1 ? 'celda excede' : 'celdas exceden'} el máximo permitido
          </div>
        )}

        {loading && <div className="comb-state loading">Cargando...</div>}
        {error && <div className="comb-state error">Error: {error.message || 'desconocido'}</div>}
        {!loading && catalogo.length === 0 && (
          <div className="comb-state empty">Sin combustibles configurados para esta planta.</div>
        )}

        {catalogo.length > 0 && (
          // El ref es el recuadro contra el que se mide hacia dónde abre el popover (H26/CA-39):
          // `.comb-scroll` es `overflow:auto`, o sea el que RECORTA, y por eso es el único borde
          // que importa — no el del viewport.
          <div className="comb-scroll" ref={scrollRef}>
            <table>
              <thead>
                <tr>
                  <th className="comb-th-first">Periodo</th>
                  {columnasOrdenadas.map((c) => (
                    <th key={String(c.combustible_id)}>
                      <span>{c.nombre}</span>
                      <span className="comb-unit">{c.unidad}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PERIODOS.map((p) => (
                  <tr key={p}>
                    <td className="comb-per">
                      P{p}
                      <small>{String(p - 1).padStart(2, '0')}h</small>
                    </td>
                    {columnasOrdenadas.map((c) => {
                      if (c.virtual) {
                        const t = totalCarbonPeriodo(p);
                        return (
                          <td key="TOTAL" className="comb-total">
                            {t.toFixed(3)}
                          </td>
                        );
                      }
                      const v = buffer[String(p)]?.[String(c.combustible_id)]?.cantidad ?? '';
                      // Heatmap en TODAS las columnas de combustible. Escala por columna:
                      // los alimentadores comparten maxAlim (columnas hermanas comparables,
                      // D-034); Caliza y ACPM (1 columna c/u) usan su propio cantidad_max,
                      // con fallback por tipo si el catálogo no trae el dato.
                      const maxHeat = c.tipo === 'ALIMENTADOR'
                        ? maxAlim
                        : (maxPorId.get(String(c.combustible_id)) ?? HEATMAP_MAX_FALLBACK[c.tipo]);
                      const bg = tint(v, maxHeat, rampa);
                      // Límite físico por combustible (D-034): celda fuera de rango se marca y bloquea.
                      const max = maxPorId.get(String(c.combustible_id));
                      const invalida = max != null && v !== '' && Number(v) > max;
                      // D-061 (CA-12): el badge sale del SNAPSHOT, no del buffer. Lo que marca es
                      // "el server tiene acá un valor manual distinto al del SIS"; mientras el
                      // usuario teclea, esa verdad no cambia hasta que guarde y se relea.
                      const celdaSnap = snapshot[String(p)]?.[String(c.combustible_id)];
                      const marcada = c.tipo === 'ALIMENTADOR' && esOverride(celdaSnap);
                      // D-061 L09 (H27/CA-40): los tres armados del popover solo se hacen en las
                      // celdas que llevan banderín. Antes se calculaban para las 240 celdas de la
                      // grilla en CADA render —o sea, en cada tecla— y se tiraban en el 97%.
                      let claveTip = null;
                      let idTip = null;
                      let tipClases = null;
                      if (marcada) {
                        claveTip = `${p}:${c.combustible_id}`;
                        idTip = `comb-tip-${p}-${c.combustible_id}`;
                        // D-061 L09 (H26/CA-39): el popover abre abajo-derecha por defecto y
                        // `.comb-scroll` (overflow:auto) lo recorta contra sus bordes. El lado se
                        // decide MIDIENDO al abrir (`medirLado`), no por número de periodo ni por
                        // índice de columna: con la tabla desplazada, P19 puede estar pegado al
                        // borde de ARRIBA y el último alimentador tener lienzo de sobra a la
                        // derecha. Sin medida todavía (o en jsdom, que no hace layout) manda el
                        // default del CSS, que es el mismo abajo-derecha.
                        //
                        // D-061 L11 (H53/CA-50): si esta celda es la del popover FIJADO, manda su
                        // lado y ninguna otra cosa lo toca. Solo si no lo es se mira la medida del
                        // hover, que es de una celda a la vez (la que el puntero tiene encima) y
                        // vive en un ref: leerlo acá es lo que hace que un re-render cualquiera no
                        // le devuelva el default a un popover que el puntero está mostrando.
                        const hover = ladoHoverRef.current;
                        const lado = ladoFijo?.clave === claveTip
                          ? ladoFijo
                          : (hover?.clave === claveTip ? hover : null);
                        tipClases = `comb-tip${lado?.arriba ? ' comb-tip--arriba' : ''}`
                          + `${lado?.izq ? ' comb-tip--izq' : ''}`
                          + `${tipAbierto === claveTip ? ' open' : ''}`;
                      }
                      return (
                        <td
                          key={c.combustible_id}
                          className={`comb-cell${invalida ? ' invalid' : ''}${marcada ? ' override' : ''}`}
                          style={{ background: bg }}
                        >
                          {marcada && (
                            <span
                              className="comb-override-wrap"
                              // El popover también aparece por hover (regla CSS), así que el lado
                              // hay que medirlo al entrar el puntero y no solo al hacer clic. El
                              // wrap mide exactamente los 14×14 del banderín (su único hijo en
                              // flujo), así que su rect ES el del banderín.
                              //
                              // D-061 L11 (H58/CA-50): la medida del hover se escribe en el nodo,
                              // no en el estado. Un `setState` acá re-renderizaba las ~240 celdas
                              // por cada banderín que el puntero rozaba —y el corto-circuito por
                              // identidad de L09 no saltaba justo en el caso normal, moverse ENTRE
                              // banderines—. Queda además en `ladoHoverRef` para que el próximo
                              // render lo reponga igual.
                              onMouseEnter={(e) => {
                                // El fijado no lo mueve el puntero.
                                if (tipAbierto === claveTip) return;
                                const lado = medirLado(e.currentTarget);
                                if (!lado) return;
                                ladoHoverRef.current = { clave: claveTip, ...lado };
                                const tip = e.currentTarget.querySelector('.comb-tip');
                                if (!tip) return;
                                tip.classList.toggle('comb-tip--arriba', lado.arriba);
                                tip.classList.toggle('comb-tip--izq', lado.izq);
                              }}
                            >
                              <button
                                type="button"
                                className="comb-override"
                                aria-label="Valor editado a mano sobre la lectura del SIS"
                                aria-expanded={tipAbierto === claveTip}
                                aria-describedby={idTip}
                                // D-061 L08 (H11/CA-35): fuera del recorrido del Tab. Una fila con
                                // 8 overrides metía 16 paradas (banderín + Revertir) entre una
                                // celda y la siguiente, y el operador tabula para capturar. El
                                // texto ya le llega al lector de pantalla por `aria-describedby`.
                                tabIndex={-1}
                                onClick={(e) => {
                                  if (tipAbierto === claveTip) { cerrarTip(); return; }
                                  const lado = medirLado(e.currentTarget);
                                  setLadoFijo(lado ? { clave: claveTip, ...lado } : null);
                                  setTipAbierto(claveTip);
                                }}
                              />
                              {/* Sin `title` nativo: el popover ya dice lo mismo y el navegador lo
                                  repetiría encima un segundo después. El texto llega al lector de
                                  pantalla por `aria-describedby`. */}
                              <span className={tipClases}>
                                <span className="comb-tip-texto" id={idTip}>{textoOverride(celdaSnap)}</span>
                                {puedeCrear && (
                                  <button
                                    type="button"
                                    className="comb-tip-revertir"
                                    // D-061 L08 (H2/CA-32): con CUALQUIER celda sucia, todos los
                                    // Revertir se apagan. Revertir relee la grilla entera, así que
                                    // hacerlo con ediciones pendientes en otras celdas las borraba
                                    // en silencio bajo un toast de éxito. Con cambios encima la
                                    // salida es la misma que pide la gavela: Guardar o Descartar.
                                    disabled={hayCambios || loading}
                                    title={hayCambios ? 'Guarda o descarta primero' : 'Volver al valor del SIS'}
                                    onClick={() => onRevertir(p, c.combustible_id)}
                                  >
                                    Revertir
                                  </button>
                                )}
                              </span>
                            </span>
                          )}
                          <input
                            type="number"
                            step="0.001"
                            min="0"
                            max={max ?? undefined}
                            placeholder="·"
                            value={v}
                            disabled={!puedeCrear}
                            aria-invalid={invalida || undefined}
                            onChange={(e) => {
                              const raw = e.target.value;
                              const n = raw === '' ? null : parseFloat(raw);
                              setCelda(p, c.combustible_id, n);
                            }}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
