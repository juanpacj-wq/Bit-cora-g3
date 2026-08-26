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
  // Gavela (D-061): instante en que empezó a correr la ventana de 10 min, y lo que le queda.
  const [gavelaInicio, setGavelaInicio] = useState(null);
  const [restanteMs, setRestanteMs] = useState(GAVELA_MS);

  // showToast estable a través de re-renders (mismo patrón que SalaDeMandoGrid).
  const showToastRef = useRef(showToast);
  useEffect(() => { showToastRef.current = showToast; }, [showToast]);

  // Refetch al cambiar planta o fecha. Descartar el buffer es OK porque el `beforeunload`
  // y la confirmación al cambiar de fecha (si se agrega más adelante) cubren el caso.
  const refetch = useCallback(async () => {
    if (!plantaId) return;
    try {
      setError(null);
      const r = await getConsumos(plantaId, fecha);
      setCatalogo(r.catalogo || []);
      setSnapshot(r.celdas || {});
      setBuffer(deepClone(r.celdas || {}));
      setSis(r.sis ?? null);
    } catch (e) {
      setError(e);
    }
  }, [plantaId, fecha, getConsumos]);

  useEffect(() => { refetch(); }, [refetch]);

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

  // El día Bogotá se pregunta acá y NO en cada render (la grilla re-renderiza con cada tecla y
  // `getTodayBogota` arma un Intl.DateTimeFormat nuevo cada vez). El cruce de medianoche con la
  // pestaña quieta lo cubre el guardia de `tick` más abajo, que vuelve a preguntar el día.
  const politica = useMemo(
    () => politicaRefresco({ plantaId, fecha, hoy: getTodayBogota(), hayCambios }),
    [plantaId, fecha, hayCambios]
  );

  // Auto-refresco (CA-13): solo GEC32 viendo hoy y sin cambios locales. Se desmonta solo cuando
  // aparece el primer cambio en el buffer (`politica.autoRefresco` pasa a false), que es lo que
  // garantiza que jamás se le borre a alguien lo que está escribiendo.
  useEffect(() => {
    if (!politica.autoRefresco) return;
    const tick = () => {
      if (hayCambiosRef.current) return;              // empezó a editar entre latidos
      if (fecha !== getTodayBogota()) return;         // la pestaña cruzó la medianoche: ya no es hoy
      refetchRef.current();
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
    setBuffer((b) => {
      const next = { ...b };
      const p = String(periodo);
      const k = String(combustibleId);
      const fila = next[p] ? { ...next[p] } : {};
      const esVacio = cantidad === null || cantidad === 0 || Number.isNaN(cantidad);
      if (esVacio) {
        delete fila[k];
        if (Object.keys(fila).length === 0) delete next[p];
        else next[p] = fila;
      } else {
        fila[k] = { ...(fila[k] || {}), cantidad };
        next[p] = fila;
      }
      return next;
    });
  };

  // Total Carbón por periodo: suma de tipo='ALIMENTADOR' del buffer (no incluye Caliza ni ACPM).
  // Coincide con la fórmula de bitacora.v_consumo_periodo.total_carbon_ton del backend.
  const totalCarbonPeriodo = useCallback((periodo) => {
    const p = String(periodo);
    const fila = buffer[p] || {};
    let total = 0;
    for (const cb of catalogo) {
      if (cb.tipo !== 'ALIMENTADOR') continue;
      const v = fila[String(cb.combustible_id)]?.cantidad;
      if (typeof v === 'number' && Number.isFinite(v)) total += v;
    }
    return total;
  }, [buffer, catalogo]);

  // diff: { periodo, combustible_id, cantidad, detalle } por celda que difiere snapshot vs buffer.
  // - solo en snapshot ⇒ cantidad=null (backend DELETE)
  // - solo en buffer   ⇒ INSERT con cantidad
  // - en ambos con cantidad/detalle distintos ⇒ UPDATE
  const calcularDiff = () => {
    const out = [];
    const keys = new Set([...Object.keys(buffer), ...Object.keys(snapshot)]);
    for (const p of keys) {
      const bFila = buffer[p] || {};
      const sFila = snapshot[p] || {};
      const cKeys = new Set([...Object.keys(bFila), ...Object.keys(sFila)]);
      for (const cid of cKeys) {
        const b = bFila[cid];
        const s = sFila[cid];
        if (!b && s) {
          out.push({ periodo: Number(p), combustible_id: Number(cid), cantidad: null });
        } else if (b && !s) {
          out.push({ periodo: Number(p), combustible_id: Number(cid), cantidad: b.cantidad, detalle: b.detalle ?? null });
        } else if (b && s && (Number(b.cantidad) !== Number(s.cantidad) || (b.detalle ?? null) !== (s.detalle ?? null))) {
          out.push({ periodo: Number(p), combustible_id: Number(cid), cantidad: b.cantidad, detalle: b.detalle ?? null });
        }
      }
    }
    return out;
  };

  const onGuardar = async () => {
    try {
      const celdasDiff = calcularDiff();
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

  // ¿Esta celda tiene una edición sin guardar encima? Se pregunta solo de celdas que en el
  // SNAPSHOT son override, así que `s` siempre existe; la ausencia de `b` significa "la vaciaron".
  const celdaConCambios = useCallback((periodo, combustibleId) => {
    const b = buffer[String(periodo)]?.[String(combustibleId)];
    const s = snapshot[String(periodo)]?.[String(combustibleId)];
    if (!b && !s) return false;
    if (!b || !s) return true;
    return Number(b.cantidad) !== Number(s.cantidad) || (b.detalle ?? null) !== (s.detalle ?? null);
  }, [buffer, snapshot]);

  // D-061 (CA-12): devolver la celda al valor del SIS. El refetch posterior es el que hace
  // desaparecer el badge —el estado de override lo dicta el backend, no el front—.
  const onRevertir = async (periodo, combustibleId) => {
    try {
      const r = await revertirCelda({
        planta_id: plantaId, fecha, periodo, combustible_id: combustibleId,
      });
      setTipAbierto(null);
      await refetch();
      showToastRef.current?.(
        r?.accion === 'eliminado' ? 'Celda eliminada (valor SIS = 0)' : 'Revertido al valor SIS',
        'success'
      );
    } catch (e) {
      // `e.message` ya viene saneado por el backend (D-032); `body.mensaje` es el texto largo
      // cuando el endpoint lo manda. Nunca se arma el texto a partir de un `codigo` crudo.
      showToastRef.current?.(e.body?.mensaje ?? e.message ?? 'No se pudo revertir', 'error');
    }
  };

  // El popover no debe sobrevivir a un cambio de planta/fecha (quedaría describiendo una celda
  // que ya no está en pantalla) ni a un Escape.
  useEffect(() => { setTipAbierto(null); }, [plantaId, fecha]);
  useEffect(() => {
    if (!tipAbierto) return;
    const h = (e) => { if (e.key === 'Escape') setTipAbierto(null); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [tipAbierto]);

  // Reorden de columnas: alimentadores → Total Carbón (virtual) → Caliza → ACPM.
  // La columna virtual lleva `virtual: true` y un id 'TOTAL' que no se confunde con ningún
  // combustible_id real (entero positivo de la BD).
  const columnasOrdenadas = useMemo(() => {
    const alim = catalogo.filter((c) => c.tipo === 'ALIMENTADOR');
    const caliza = catalogo.filter((c) => c.tipo === 'CALIZA');
    const acpm = catalogo.filter((c) => c.tipo === 'ACPM');
    return [
      ...alim,
      { combustible_id: 'TOTAL', nombre: 'Total Carbón', unidad: 'Ton', tipo: 'TOTAL', virtual: true },
      ...caliza,
      ...acpm,
    ];
  }, [catalogo]);

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
    for (const c of catalogo) {
      if (c.tipo === 'ALIMENTADOR' && c.cantidad_max != null) mx = Math.max(mx, Number(c.cantidad_max));
    }
    return mx > 0 ? mx : HEATMAP_MAX_TON;
  }, [catalogo]);

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
          <div className="comb-scroll">
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
                      const claveTip = `${p}:${c.combustible_id}`;
                      const idTip = `comb-tip-${p}-${c.combustible_id}`;
                      const sucia = marcada && celdaConCambios(p, c.combustible_id);
                      return (
                        <td
                          key={c.combustible_id}
                          className={`comb-cell${invalida ? ' invalid' : ''}${marcada ? ' override' : ''}`}
                          style={{ background: bg }}
                        >
                          {marcada && (
                            <span className="comb-override-wrap">
                              <button
                                type="button"
                                className="comb-override"
                                aria-label="Valor editado a mano sobre la lectura del SIS"
                                aria-expanded={tipAbierto === claveTip}
                                aria-describedby={idTip}
                                onClick={() => setTipAbierto((k) => (k === claveTip ? null : claveTip))}
                              />
                              {/* Sin `title` nativo: el popover ya dice lo mismo y el navegador lo
                                  repetiría encima un segundo después. El texto llega al lector de
                                  pantalla por `aria-describedby`. */}
                              <span className={`comb-tip${tipAbierto === claveTip ? ' open' : ''}`}>
                                <span className="comb-tip-texto" id={idTip}>{textoOverride(celdaSnap)}</span>
                                {puedeCrear && (
                                  <button
                                    type="button"
                                    className="comb-tip-revertir"
                                    disabled={sucia || loading}
                                    title={sucia ? 'Guarda o descarta primero' : 'Volver al valor del SIS'}
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
