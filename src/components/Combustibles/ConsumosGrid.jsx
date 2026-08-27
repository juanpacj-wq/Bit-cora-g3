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
  claveCelda, reconciliarBuffer, calcularDiff, ladoPopover,
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
  const [snapshot, setSnapshot] = useState({});  // shape: { "<periodo>": { "<combustible_id>": { cantidad, detalle, ... } } }
  const [buffer, setBuffer] = useState({});
  const [error, setError] = useState(null);
  // D-061: estado del scrape SIS del día (`sis_scrape_log`, C4) para el chip de la topbar. Hasta
  // que L02 lo exponga llega `undefined` → el chip dice "sin lectura", que es la verdad.
  const [sis, setSis] = useState(null);
  // Celda cuyo popover de override está abierto por click ('<periodo>:<combustible_id>'). El hover
  // lo maneja el CSS; este estado es el que deja el popover fijo para poder llegar a "Revertir".
  const [tipAbierto, setTipAbierto] = useState(null);
  // D-061 L09 (H26/CA-39): hacia dónde abre el popover de la última celda apuntada,
  // `{ clave, arriba, izq }`. Se mide al abrir (hover o click) y no en cada scroll: un
  // `getBoundingClientRect` por banderín tocado, contra los 240 por render que costaría recalcular
  // la posición en vivo. Solo hay un popover visible a la vez, así que una sola entrada alcanza.
  const [ladoTip, setLadoTip] = useState(null);
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

  // D-061 L09 (H24/CA-37) — las coordenadas que el operador tocó desde la última lectura limpia.
  // Es la única fuente de "qué es un cambio del operador": el buffer solo dice en qué difiere de
  // lo que el server tiene AHORA, y esa diferencia también la puede producir el SIS escribiendo
  // por debajo. Se vacía cuando la edición se cierra (guardar, descartar, vencer la gavela) o
  // cuando se cambia de coordenada. Es un ref y no estado porque nada del render depende de él:
  // solo lo leen `calcularDiff` (al guardar) y la reconciliación (al volver un refetch).
  const editadasRef = useRef(new Set());

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
      setError(null);
      setCatalogo(r.catalogo || []);
      setSnapshot(r.celdas || {});
      setSis(r.sis ?? null);
      // El snapshot y el chip SIS se actualizan siempre: son la verdad del server (de ahí sale el
      // badge de override) y no pisan nada de lo tecleado.
      //
      // D-061 L09 (H24): con una edición en curso el buffer NO se conserva entero —eso dejaba lo
      // que el SIS acababa de escribir como "solo en el snapshot", y el Guardar siguiente lo
      // mandaba al POST con `cantidad: null` a nombre del operador—. Se reconcilia celda por
      // celda: entra lo del server, se queda lo tecleado.
      if (preservarEdicion && hayCambiosRef.current) {
        setBuffer((b) => reconciliarBuffer(b, r.celdas || {}, editadasRef.current));
      } else {
        setBuffer(deepClone(r.celdas || {}));
        editadasRef.current.clear();
      }
    } catch (e) {
      if (seq !== refetchSeqRef.current || clave !== claveActualRef.current) return;
      setError(e);
    }
  }, [plantaId, fecha, getConsumos]);

  // La clave se refresca en el MISMO efecto que dispara la lectura de la nueva coordenada: así no
  // hay ventana en que `claveActualRef` apunte a la fecha vieja y se descarte la respuesta buena.
  // Las celdas editadas se olvidan acá y no solo cuando vuelva el GET: son coordenadas de la
  // planta/fecha que se acaba de dejar y no significan nada en la nueva.
  useEffect(() => {
    claveActualRef.current = claveRefetch(plantaId, fecha);
    editadasRef.current.clear();
    refetch();
  }, [refetch, plantaId, fecha]);

  const hayCambios = useMemo(
    () => JSON.stringify(buffer) !== JSON.stringify(snapshot),
    [buffer, snapshot]
  );

  // D-061 — refs para lo que corre FUERA del render (intervalos y el listener de `focus`): un
  // `setInterval` montado una vez se queda con el `refetch`/`hayCambios` del render en que nació y
  // seguiría releyendo la fecha vieja, o pisaría una edición empezada después. Con refs, el timer
  // siempre ve el valor de ahora sin tener que re-montarse en cada tecla.
  const refetchRef = useRef(refetch);
  const hayCambiosRef = useRef(hayCambios);
  const snapshotRef = useRef(snapshot);
  useEffect(() => { refetchRef.current = refetch; }, [refetch]);
  useEffect(() => { hayCambiosRef.current = hayCambios; }, [hayCambios]);
  useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);

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
    setBuffer(deepClone(snapshotRef.current));
    editadasRef.current.clear();
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
    // D-061 L09 (H24/CA-37): este es el ÚNICO lugar por el que el operador toca el buffer, así que
    // es el único que da de alta una coordenada como "editada". Se marca aunque el valor termine
    // siendo igual al del server (`calcularDiff` ya no la emite si no difiere): lo que importa es
    // que la celda quede protegida de la reconciliación mientras la edición esté viva.
    editadasRef.current.add(claveCelda(periodo, combustibleId));
    setBuffer((b) => {
      const next = { ...b };
      const p = String(periodo);
      const k = String(combustibleId);
      const fila = next[p] ? { ...next[p] } : {};
      // D-061 L08 (H5/CA-34): el snapshot manda. Si el server ya tiene esta celda en 0 (override 0
      // de C6), teclear 0 o vaciarla no es un cambio: se restituye la celda del snapshot tal cual
      // —clon por JSON, que conserva el orden de claves y por eso `hayCambios` (que compara
      // `JSON.stringify`) vuelve a dar false— en vez de borrar la clave del buffer.
      const celdaSnap = snapshotRef.current[p]?.[k];
      if (esCeroNoOp(cantidad, celdaSnap)) {
        fila[k] = deepClone(celdaSnap);
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
        const base = fila[k] || snapshotRef.current[p]?.[k];
        fila[k] = { ...(base || {}), cantidad };
        next[p] = fila;
      }
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
      const celdasDiff = calcularDiff(buffer, snapshot, editadasRef.current);
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
      setTipAbierto(null);
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

  // D-061 L09 (H26/CA-39): mide el banderín contra el recuadro visible de `.comb-scroll` y guarda
  // hacia dónde tiene que abrir su popover. Se llama al entrar el puntero al banderín y al hacer
  // clic en él — los dos caminos por los que el popover aparece—, nunca en el scroll ni en el
  // render. Si el lado no cambió se devuelve el mismo objeto para no re-renderizar la grilla
  // entera cada vez que el puntero cruza un banderín.
  const scrollRef = useRef(null);
  const medirLado = useCallback((clave, el) => {
    if (!el || !scrollRef.current) return;
    const lado = ladoPopover({
      banderin: el.getBoundingClientRect(),
      contenedor: scrollRef.current.getBoundingClientRect(),
    });
    setLadoTip((prev) => (
      prev && prev.clave === clave && prev.arriba === lado.arriba && prev.izq === lado.izq
        ? prev
        : { clave, ...lado }
    ));
  }, []);

  // El popover no debe sobrevivir a un cambio de planta/fecha (quedaría describiendo una celda
  // que ya no está en pantalla) ni a un Escape.
  useEffect(() => { setTipAbierto(null); setLadoTip(null); }, [plantaId, fecha]);
  useEffect(() => {
    if (!tipAbierto) return;
    const h = (e) => { if (e.key === 'Escape') setTipAbierto(null); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [tipAbierto]);

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
                        const lado = ladoTip?.clave === claveTip ? ladoTip : null;
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
                              onMouseEnter={(e) => medirLado(claveTip, e.currentTarget)}
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
                                  medirLado(claveTip, e.currentTarget);
                                  setTipAbierto((k) => (k === claveTip ? null : claveTip));
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

function deepClone(x) {
  return JSON.parse(JSON.stringify(x));
}
