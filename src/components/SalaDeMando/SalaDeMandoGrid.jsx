import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { LayoutGrid, AlertTriangle, Download, FileSpreadsheet } from 'lucide-react';
import { useSalaDeMando } from '../../hooks/useSalaDeMando';
import { getTodayBogota, getCurrentMonthBogota, horaBogota, horaBogotaHHMM } from '../../utils/fecha';
import LotesDelDia from './LotesDelDia';
import LoteEditorModal from './LoteEditorModal';
import LoteBorrarModal from './LoteBorrarModal';
import { MOTIVO_MSG } from './motivos';

const TIPOS = [
  { key: 'AUTH',   label: 'Autorización', color: '#1e40af' },
  { key: 'PRUEBA', label: 'Pruebas',      color: '#9333ea' },
  { key: 'REDESP', label: 'Redespacho',   color: '#0d9488' },
];
const TIPO_KEYS = TIPOS.map((t) => t.key);

// D-057: el lote dejó de existir mientras el modal estaba abierto — lo archivó el cierre diario
// (409), lo borró otro operador (404) o es de otra unidad (403). Los tres tienen el mismo desenlace
// en la UI: cerrar el modal y refrescar el listado, porque la pantalla quedó mostrando algo que ya
// no está. Se ramifica por `codigo`, nunca por el texto (D-032).
const CODIGOS_LOTE_FUERA = new Set(['lote_cerrado', 'lote_inexistente', 'lote_de_otra_planta']);

// D-058 (REQ-06): mensajes de la descarga del libro mensual, por `codigo` y NUNCA por texto (D-032).
// El backend ya manda un mensaje apto para el usuario; estos lo reemplazan solo donde el front puede
// decir algo más útil, porque conoce la pantalla (el selector, el permiso). Lo que no esté acá cae al
// mensaje saneado que vino en la respuesta.
const MSG_DESCARGA = {
  mes_futuro: 'Ese mes todavía no empieza. Elige el mes en curso o uno anterior.',
  mes_invalido: 'El mes no es válido. Elígelo en el selector de arriba.',
  sin_permiso_descarga: 'No tienes permiso para descargar el libro mensual de Operación 24h.',
};

// D-056: la grilla es un FORMULARIO DE CAPTURA, no un espejo del servidor. Arranca vacía (RQ-03.1),
// se vacía tras cada guardado confirmado (RQ-03.2) y nunca carga lo ya guardado (RQ-03.3/4) — eso
// se consulta en el listado de abajo. Por eso desapareció el par snapshot/diffBuffer: no hay estado
// del servidor contra el que diferenciar. Con él se fue el rodeo que omitía celdas REDESP
// bloqueadas para "no rebotar", raíz del comentario perdido en D-055 (2).
function emptyBuffer() {
  const horaActual = horaBogotaHHMM() ?? '';
  const buf = {};
  for (const t of TIPO_KEYS) {
    const valores = {};
    for (let p = 1; p <= 24; p++) valores[p] = null;
    // La hora se PRECARGA con la hora Bogotá actual y es editable (RQ-03.13): la llamada suele
    // registrarse minutos después de recibida.
    buf[t] = { valores, hora: horaActual, detalle: '', funcionariocnd: '' };
  }
  return buf;
}

// Una fila viaja al servidor si tiene ≥1 celda con valor O metadata no vacía. El caso "metadata sin
// celdas" se manda a propósito para que el backend lo rechace con `lote_sin_celdas` (RN-03.a), en
// vez de tragárselo en el front. Las celdas REDESP bloqueadas NO se filtran acá: si el operador
// escribió en una, tiene que enterarse.
function filasDeBuffer(buf) {
  const filas = [];
  for (const tipo of TIPO_KEYS) {
    const fila = buf[tipo];
    const periodos = [];
    for (let p = 1; p <= 24; p++) {
      if (fila.valores[p] != null) periodos.push({ periodo: p, valor_mw: fila.valores[p] });
    }
    const detalle = (fila.detalle || '').trim();
    const funcionariocnd = (fila.funcionariocnd || '').trim();
    if (periodos.length === 0 && detalle === '' && funcionariocnd === '') continue;
    filas.push({
      tipo,
      hora: fila.hora || null,
      detalle: detalle || null,
      funcionariocnd: tipo === 'AUTH' ? (funcionariocnd || null) : null,
      periodos,
    });
  }
  return filas;
}

// F17: grilla 3×24 de Operación 24h (MAND). F10 (paginación entre días) eliminada — la grilla solo
// captura para HOY y el cierre es automático vía sweeper diario (F16). Multi-select estilo Excel +
// lock REDESP por periodo actual. D-056: captura append-only por lotes + listado del día debajo.
// D-058: `mes`/`onMesChange` son CONTROLADOS por el dashboard, igual que la planta de DISP y la
// fecha de COMB (D-035): el subestado vive en la URL (`#/op24h?mes=YYYY-MM`) y sobrevive a un F5.
// Es el mes del LIBRO, no el día de la grilla — la grilla sigue siendo siempre hoy (D-017/D-056).
export default function SalaDeMandoGrid({
  bitacora, plantaId, puedeCrear, showToast, onError,
  onDirtyChange, onGuardandoChange, registerSaveHandler,
  mes, onMesChange,
}) {
  const { getLotes, guardarBatch, editarLote, eliminarLote, descargarReporteMensual } = useSalaDeMando();
  const [buffer, setBuffer] = useState(() => emptyBuffer());
  const [seleccion, setSeleccion] = useState({ tipo: null, periodos: new Set() });
  const [anchorPeriodo, setAnchorPeriodo] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [periodoActual, setPeriodoActual] = useState(() => Math.floor(horaBogota()) + 1);
  const [guardando, setGuardando] = useState(false);
  const [errores, setErrores] = useState([]);
  // Strings parciales mientras el input tiene foco — preserva "10." y otros estados intermedios
  // hasta que el blur parsea y commitea al buffer.
  const [editing, setEditing] = useState({});
  const [fechaCargada, setFechaCargada] = useState(() => getTodayBogota());
  // Listado del día (solo lectura). Se refresca al montar, tras cada guardado exitoso y en el mismo
  // tick de 60s de la grilla — sin un segundo temporizador.
  const [lotes, setLotes] = useState([]);
  const [cargandoLotes, setCargandoLotes] = useState(true);
  const [errorLotes, setErrorLotes] = useState(null);
  // D-057: corrección por lote. `loteEditando`/`loteBorrando` son SNAPSHOTS del listado, solo para
  // pintar el modal — el diff real lo calcula el backend releyendo el lote dentro de la transacción
  // (decisión 7), así que una edición concurrente no revive una celda que el otro ya borró.
  const [loteEditando, setLoteEditando] = useState(null);
  const [loteBorrando, setLoteBorrando] = useState(null);
  // D-058: la generación del libro tarda (consulta las cuatro fuentes del mes y arma 28..31 hojas),
  // así que el botón necesita su propio estado de carga. NO se mezcla con `guardando`: el header
  // deriva de ese el botón "Guardar", y una descarga no puede deshabilitarlo.
  const [descargando, setDescargando] = useState(false);
  const tableRef = useRef(null);
  const guardarRef = useRef(null);
  // F18-fix: refs latentes para callbacks externos. El padre puede pasarlos como arrows
  // inline (recreadas en cada render), y si los pusiéramos en deps de useCallback, cada
  // render del padre invalidaría los callbacks del child → los efectos re-ejecutarían y
  // limpiarían lo tipeado por el usuario.
  const onErrorRef = useRef(onError);
  const showToastRef = useRef(showToast);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { showToastRef.current = showToast; }, [showToast]);

  // Único fetch de la pantalla: el listado del día. La grilla NO se puebla desde el servidor.
  const refrescarLotes = useCallback(async (fecha) => {
    if (!plantaId) return;
    setCargandoLotes(true);
    try {
      const r = await getLotes(plantaId, fecha || getTodayBogota());
      setLotes(Array.isArray(r?.lotes) ? r.lotes : []);
      setErrorLotes(null);
    } catch (e) {
      setErrorLotes(e.message);
    } finally {
      setCargandoLotes(false);
    }
  }, [getLotes, plantaId]);

  // Cambio de planta (D-054, cambio de unidad en caliente): la captura pendiente es de la unidad
  // vieja y no puede arrastrarse. Se vacía el buffer y se trae el listado de la unidad nueva.
  useEffect(() => {
    const hoy = getTodayBogota();
    setBuffer(emptyBuffer());
    setEditing({});
    setErrores([]);
    setFechaCargada(hoy);
    // Un modal abierto apunta a un lote de la unidad VIEJA: se cierra, no se arrastra.
    setLoteEditando(null);
    setLoteBorrando(null);
    refrescarLotes(hoy);
  }, [plantaId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Watcher cada 60s: actualiza el periodo actual (lock REDESP), detecta el cambio de día Bogotá y
  // refresca el listado. El polling importa porque en append-only ya no hay unicidad por periodo:
  // si el JdT no ve lo que acaba de registrar el Ing. de Operación desde otro equipo, nada impide
  // el duplicado.
  useEffect(() => {
    const i = setInterval(() => {
      setPeriodoActual(Math.floor(horaBogota()) + 1);
      const t = getTodayBogota();
      if (t !== fechaCargada) setFechaCargada(t); // al cruzar medianoche el listado se vacía solo
      refrescarLotes(t);
    }, 60_000);
    return () => clearInterval(i);
  }, [fechaCargada, refrescarLotes]);

  // `dirty` = hay captura que se puede perder. La hora precargada por sí sola NO ensucia.
  const dirty = useMemo(() => {
    for (const tipo of TIPO_KEYS) {
      const fila = buffer[tipo];
      if ((fila.detalle || '').trim() !== '') return true;
      if ((fila.funcionariocnd || '').trim() !== '') return true;
      for (let p = 1; p <= 24; p++) if (fila.valores[p] != null) return true;
    }
    return false;
  }, [buffer]);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onGuardandoChange?.(guardando); }, [guardando, onGuardandoChange]);

  useEffect(() => {
    if (bitacora?.codigo !== 'MAND') return;
    const handler = (e) => {
      if (dirty) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty, bitacora]);

  const guardar = useCallback(async () => {
    if (!buffer) return;
    const filas = filasDeBuffer(buffer);
    if (filas.length === 0) return;
    setGuardando(true);
    try {
      const fecha = getTodayBogota();
      const r = await guardarBatch({ planta_id: plantaId, fecha, filas });
      const res = r?.resumen || { lotes: 0, registros: 0 };
      showToastRef.current?.(
        `Registrado: ${res.registros} ${res.registros === 1 ? 'periodo' : 'periodos'} en ${res.lotes} ${res.lotes === 1 ? 'evento' : 'eventos'}`
      );
      // RQ-03.2: tras un guardado CONFIRMADO la grilla se vacía completa y la hora se re-precarga.
      setBuffer(emptyBuffer());
      setEditing({});
      setErrores([]);
      setSeleccion({ tipo: null, periodos: new Set() });
      setFechaCargada(fecha);
      await refrescarLotes(fecha);
    } catch (e) {
      // RN-03.b: tras un guardado FALLIDO no se vacía nada ni se refetchea. El operador no puede
      // perder lo que escribió por un error de validación.
      if (Array.isArray(e?.errores)) {
        setErrores(e.errores);
        onErrorRef.current?.('Hay errores en el formulario. Corrige lo resaltado.');
      } else {
        onErrorRef.current?.(e.message);
      }
    } finally {
      setGuardando(false);
    }
  }, [buffer, guardarBatch, plantaId, refrescarLotes]);

  // ── D-057 · Corrección y borrado por lote ────────────────────────────────────────────────────
  // Ninguno de los dos toca el buffer de captura: `dirty` sigue derivando SOLO de lo tecleado en la
  // grilla. Corregir el histórico del día y capturar una llamada nueva son planos distintos; si se
  // mezclaran, corregir "ensuciaría" la grilla y bloquearía la finalización de turno (D-040).
  const handleGuardarLote = useCallback(async (payload) => {
    const lote_id = loteEditando?.lote_id;
    if (!lote_id) return;
    try {
      const r = await editarLote(lote_id, payload);
      const res = r?.resumen || {};
      const partes = [];
      if (res.actualizados) partes.push(`${res.actualizados} ${res.actualizados === 1 ? 'valor corregido' : 'valores corregidos'}`);
      if (res.creados) partes.push(`${res.creados} ${res.creados === 1 ? 'periodo agregado' : 'periodos agregados'}`);
      if (res.eliminados) partes.push(`${res.eliminados} ${res.eliminados === 1 ? 'periodo quitado' : 'periodos quitados'}`);
      // Sin ninguno de los tres, lo que cambió fue la metadata (hora / funcionario / descripción).
      showToastRef.current?.(partes.length ? `Registro corregido: ${partes.join(' · ')}` : 'Registro actualizado');
      setLoteEditando(null);
      await refrescarLotes(fechaCargada);
    } catch (e) {
      if (CODIGOS_LOTE_FUERA.has(e?.codigo)) {
        setLoteEditando(null);
        onErrorRef.current?.(e.message);
        await refrescarLotes(fechaCargada);
        return; // se consume acá: el modal ya no está montado
      }
      throw e; // el modal pinta `errores[]` (celda por celda) o el mensaje saneado
    }
  }, [editarLote, loteEditando, refrescarLotes, fechaCargada]);

  const handleEliminarLote = useCallback(async () => {
    const lote = loteBorrando;
    if (!lote?.lote_id) return;
    try {
      const r = await eliminarLote(lote.lote_id, plantaId);
      const n = r?.resumen?.eliminados ?? 0;
      showToastRef.current?.(`Registro eliminado${n ? `: ${n} ${n === 1 ? 'periodo' : 'periodos'}` : ''}`);
      setLoteBorrando(null);
      setLoteEditando(null); // si se llegó acá desde el modal de corrección, ese también se va
      await refrescarLotes(fechaCargada);
    } catch (e) {
      if (CODIGOS_LOTE_FUERA.has(e?.codigo)) {
        setLoteBorrando(null);
        setLoteEditando(null);
        onErrorRef.current?.(e.message);
        await refrescarLotes(fechaCargada);
        return;
      }
      throw e; // lo pinta el modal de confirmación
    }
  }, [eliminarLote, loteBorrando, plantaId, refrescarLotes, fechaCargada]);

  // ── D-058 · Libro mensual F03 (REQ-06) ───────────────────────────────────────────────────────
  // El mes por defecto es el EN CURSO en Bogotá, y también es el tope: pedir un mes que no empezó no
  // tiene sentido y el backend lo rechaza con `mes_futuro` aunque el front se evada.
  const mesActual = getCurrentMonthBogota();
  const mesSeleccionado = mes || mesActual;

  const descargarLibro = useCallback(async () => {
    setDescargando(true);
    try {
      await descargarReporteMensual(mesSeleccionado);
      showToastRef.current?.(`Libro de ${mesSeleccionado} descargado`);
    } catch (e) {
      // Se ramifica por `codigo`, jamás por el texto (D-032). `mes_futuro` además se auto-sana:
      // el selector vuelve al mes en curso para que el siguiente clic funcione.
      if (e?.codigo === 'mes_futuro') onMesChange?.(mesActual);
      onErrorRef.current?.(MSG_DESCARGA[e?.codigo] ?? e.message);
    } finally {
      setDescargando(false);
    }
  }, [descargarReporteMensual, mesSeleccionado, mesActual, onMesChange]);

  useEffect(() => { guardarRef.current = guardar; }, [guardar]);
  useEffect(() => {
    registerSaveHandler?.(() => guardarRef.current?.());
    return () => registerSaveHandler?.(null);
  }, [registerSaveHandler]);

  const isLocked = useCallback(
    (tipo, periodo) => tipo === 'REDESP' && periodo < periodoActual,
    [periodoActual]
  );

  // Multi-select: shift expande desde anchor, ctrl/meta togglea, click solo arranca drag.
  // Cross-tipo: clickear otra fila descarta la selección y arranca una nueva en esa fila.
  const handleMouseDown = (tipo, periodo, e) => {
    if (!puedeCrear) return;
    if (isLocked(tipo, periodo)) return;
    if (e.shiftKey && seleccion.tipo === tipo && anchorPeriodo != null) {
      const lo = Math.min(anchorPeriodo, periodo);
      const hi = Math.max(anchorPeriodo, periodo);
      const periodos = new Set();
      for (let p = lo; p <= hi; p++) periodos.add(p);
      setSeleccion({ tipo, periodos });
    } else if ((e.ctrlKey || e.metaKey) && seleccion.tipo === tipo) {
      const next = new Set(seleccion.periodos);
      if (next.has(periodo)) next.delete(periodo); else next.add(periodo);
      setSeleccion({ tipo, periodos: next });
      setAnchorPeriodo(periodo);
    } else {
      setSeleccion({ tipo, periodos: new Set([periodo]) });
      setAnchorPeriodo(periodo);
      setDragging(true);
    }
  };

  const handleMouseEnter = (tipo, periodo) => {
    if (!dragging || seleccion.tipo !== tipo || anchorPeriodo == null) return;
    const lo = Math.min(anchorPeriodo, periodo);
    const hi = Math.max(anchorPeriodo, periodo);
    const periodos = new Set();
    for (let p = lo; p <= hi; p++) periodos.add(p);
    setSeleccion({ tipo, periodos });
  };

  useEffect(() => {
    const onUp = () => setDragging(false);
    const onKey = (e) => {
      if (e.key === 'Escape' && seleccion.periodos.size > 0) {
        setSeleccion({ tipo: null, periodos: new Set() });
        setAnchorPeriodo(null);
      }
    };
    const onDocMouseDown = (e) => {
      if (!tableRef.current) return;
      if (!tableRef.current.contains(e.target) && seleccion.periodos.size > 0) {
        setSeleccion({ tipo: null, periodos: new Set() });
        setAnchorPeriodo(null);
      }
    };
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDocMouseDown);
    return () => {
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDocMouseDown);
    };
  }, [seleccion]);

  const setCellValor = (tipo, periodo, valor) => {
    setBuffer((b) => ({
      ...b,
      [tipo]: { ...b[tipo], valores: { ...b[tipo].valores, [periodo]: valor } },
    }));
  };

  const handleInputChange = (tipo, periodo, raw) => {
    setEditing((s) => ({ ...s, [tipo]: { ...(s[tipo] || {}), [periodo]: raw } }));
  };

  const commitInput = (tipo, periodo, raw) => {
    setEditing((s) => {
      if (!s[tipo]) return s;
      const tNext = { ...s[tipo] };
      delete tNext[periodo];
      return { ...s, [tipo]: tNext };
    });
    if (raw === '' || raw == null) {
      setCellValor(tipo, periodo, null);
      return;
    }
    const n = parseFloat(raw);
    if (Number.isNaN(n)) { onError?.('Valor inválido'); return; }
    setCellValor(tipo, periodo, n);
  };

  const handleInputKeyDown = (tipo, periodo, e) => {
    if (e.key === 'Enter' && seleccion.tipo === tipo && seleccion.periodos.size > 1 && seleccion.periodos.has(periodo)) {
      const raw = e.target.value.trim();
      const valor = raw === '' ? null : parseFloat(raw);
      if (raw !== '' && Number.isNaN(valor)) {
        onError?.('Valor inválido'); e.preventDefault(); return;
      }
      setBuffer((b) => {
        const next = { ...b, [tipo]: { ...b[tipo], valores: { ...b[tipo].valores } } };
        for (const p of seleccion.periodos) {
          if (isLocked(tipo, p)) continue;
          next[tipo].valores[p] = valor;
        }
        return next;
      });
      setEditing((s) => {
        if (!s[tipo]) return s;
        const tNext = { ...s[tipo] };
        for (const p of seleccion.periodos) delete tNext[p];
        return { ...s, [tipo]: tNext };
      });
      e.preventDefault();
    }
  };

  const errorPorCelda = useMemo(() => {
    const m = new Map();
    for (const err of errores) {
      if (err?.periodo != null && err?.tipo) m.set(`${err.tipo}-${err.periodo}`, err);
    }
    return m;
  }, [errores]);
  const erroresFila = useMemo(() => {
    const m = new Map();
    for (const err of errores) {
      if (err?.periodo == null && err?.tipo) m.set(err.tipo, err);
    }
    return m;
  }, [errores]);
  const errorGlobal = useMemo(
    () => errores.find((e) => !e?.tipo && e?.motivo) || null,
    [errores]
  );

  return (
    <div className="flex-1 overflow-auto px-6 py-4">
      {/* D-058 (REQ-06 / RQ-06.1): barra del libro mensual. Gateada por `puedeCrear` — el mismo flag
          data-driven que gobierna registrar y corregir (RQ-06.11/12). Sin permiso NO se pinta, y si
          alguien invoca el endpoint igual, el backend responde 403: el front comunica, no protege. */}
      {puedeCrear && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5">
          <FileSpreadsheet size={16} className="text-gray-500" />
          <span className="text-sm font-semibold text-gray-700">Libro mensual de eventos</span>
          <span className="hidden text-xs text-gray-400 sm:inline">
            Formato GENE-F03 · una hoja por día, con GEC3 y GEC32
          </span>

          <label htmlFor="f03-mes" className="ml-auto text-xs font-medium text-gray-500">Mes</label>
          <input
            id="f03-mes"
            type="month"
            value={mesSeleccionado}
            max={mesActual}
            disabled={descargando}
            onChange={(e) => {
              // Un `<input type="month">` vacío (el usuario borra el campo) no cambia nada: sin mes
              // no hay libro que pedir, y dejarlo vacío deshabilitaría el botón sin explicar por qué.
              const v = e.target.value;
              if (v && v <= mesActual) onMesChange?.(v);
            }}
            className="rounded border border-gray-200 px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:bg-gray-50"
          />
          <button
            type="button"
            onClick={descargarLibro}
            disabled={descargando}
            title="Descargar el libro del mes seleccionado en formato Excel"
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 transition-colors hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download size={15} />
            {descargando ? 'Generando…' : 'Descargar'}
          </button>
        </div>
      )}

      {errorGlobal?.motivo === 'fecha_no_es_hoy' && (
        <div className="bg-red-100 border border-red-300 rounded-xl px-4 py-3 mb-3 flex items-center gap-2 text-sm text-red-900">
          <AlertTriangle size={16} />
          <span className="font-semibold">{MOTIVO_MSG.fecha_no_es_hoy}</span>
        </div>
      )}
      {errores.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-red-800 mb-2">
            <AlertTriangle size={16} />
            Corrige estos errores antes de guardar
          </div>
          <ul className="text-xs text-red-700 list-disc pl-5 space-y-1">
            {errores.map((e, i) => (
              <li key={i}>
                {e?.tipo ? `[${e.tipo}${e?.periodo ? ` P${e.periodo}` : ''}] ` : ''}
                {e?.mensaje || MOTIVO_MSG[e?.motivo] || e?.motivo || 'Error desconocido'}
              </li>
            ))}
          </ul>
          <div className="mt-2 text-xs text-red-700">
            No se registró nada: lo que escribiste sigue acá para que lo corrijas.
          </div>
        </div>
      )}

      <div ref={tableRef} className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm select-none">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="sticky left-0 bg-gray-50 px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider min-w-32">Evento</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider min-w-32">Hora llamada</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider min-w-48">Detalle / Comentario</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider min-w-40">Funcionario CND</th>
              {Array.from({ length: 24 }, (_, i) => {
                const p = i + 1;
                const isCur = p === periodoActual;
                return (
                  <th key={i} className={`px-2 py-2 text-center text-xs font-semibold min-w-16 ${isCur ? 'bg-emerald-100 text-emerald-700' : 'text-gray-500'}`}>
                    P{p}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {TIPOS.map((t) => {
              const fila = buffer[t.key];
              const requireFuncionario = t.key === 'AUTH';
              const errFila = erroresFila.get(t.key);
              const funcMissing = errFila?.motivo === 'funcionariocnd_requerido';
              const horaMala = errFila?.motivo === 'hora_requerida'
                || errFila?.motivo === 'hora_invalida'
                || errFila?.motivo === 'hora_futura';
              return (
                <tr key={t.key} className="border-b border-gray-100">
                  <td className="sticky left-0 bg-white px-3 py-2 font-semibold" style={{ color: t.color }}>
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: t.color }} />
                      {t.label}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="time"
                      value={fila.hora ?? ''}
                      onChange={(e) => setBuffer((b) => ({ ...b, [t.key]: { ...b[t.key], hora: e.target.value } }))}
                      disabled={!puedeCrear}
                      title={horaMala ? (errFila.mensaje || MOTIVO_MSG[errFila.motivo]) : 'Hora en que el CND hizo la llamada (Bogotá)'}
                      className={`w-32 px-2 py-1 rounded border text-sm focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:bg-gray-50 ${
                        horaMala ? 'border-red-500' : 'border-gray-200'
                      }`}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      value={fila.detalle ?? ''}
                      onChange={(e) => setBuffer((b) => ({ ...b, [t.key]: { ...b[t.key], detalle: e.target.value } }))}
                      placeholder="Comentario"
                      disabled={!puedeCrear}
                      className="w-full px-2 py-1 rounded border border-gray-200 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:bg-gray-50"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      value={t.key === 'AUTH' ? (fila.funcionariocnd ?? '') : ''}
                      onChange={(e) => {
                        if (t.key === 'AUTH') {
                          setBuffer((b) => ({ ...b, [t.key]: { ...b[t.key], funcionariocnd: e.target.value } }));
                        }
                      }}
                      placeholder={t.key === 'AUTH' ? 'Requerido…' : 'No aplica'}
                      disabled={!puedeCrear || t.key !== 'AUTH'}
                      title={funcMissing ? MOTIVO_MSG.funcionariocnd_requerido : undefined}
                      className={`w-full px-2 py-1 rounded border text-sm focus:outline-none focus:ring-1 focus:ring-emerald-400 ${
                        funcMissing
                          ? 'border-red-500'
                          : (requireFuncionario && !fila.funcionariocnd ? 'border-amber-300' : 'border-gray-200')
                      } ${t.key !== 'AUTH' ? 'bg-gray-100 cursor-not-allowed text-gray-400' : ''}`}
                    />
                  </td>
                  {Array.from({ length: 24 }, (_, i) => {
                    const periodo = i + 1;
                    const valorBuf = fila.valores[periodo];
                    const editStr = editing[t.key]?.[periodo];
                    const display = editStr !== undefined ? editStr : (valorBuf == null ? '' : String(valorBuf));
                    const locked = isLocked(t.key, periodo);
                    const selected = seleccion.tipo === t.key && seleccion.periodos.has(periodo);
                    const errCelda = errorPorCelda.get(`${t.key}-${periodo}`);
                    return (
                      <td
                        key={i}
                        className={`px-1 py-1 ${selected ? 'bg-emerald-50' : ''}`}
                        onMouseDown={(e) => handleMouseDown(t.key, periodo, e)}
                        onMouseEnter={() => handleMouseEnter(t.key, periodo)}
                      >
                        <input
                          type="number"
                          step="0.01"
                          value={display}
                          onChange={(e) => handleInputChange(t.key, periodo, e.target.value)}
                          onBlur={(e) => commitInput(t.key, periodo, e.target.value)}
                          onKeyDown={(e) => handleInputKeyDown(t.key, periodo, e)}
                          disabled={!puedeCrear || locked}
                          title={
                            locked ? 'Solo se pueden registrar redespachos para el periodo actual o posteriores'
                            : errCelda ? (errCelda.mensaje || MOTIVO_MSG[errCelda.motivo] || errCelda.motivo)
                            : undefined
                          }
                          style={selected ? { outline: `2px solid ${t.color}`, outlineOffset: '-2px' } : undefined}
                          className={`w-16 px-1 py-1 rounded border text-sm text-center focus:outline-none focus:ring-1 focus:ring-emerald-400 ${
                            errCelda ? 'border-red-500' : 'border-gray-200'
                          } ${locked ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'disabled:bg-gray-50'}`}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!puedeCrear && (
        <div className="mt-3 flex items-center gap-2 text-xs text-gray-500">
          <AlertTriangle size={14} />
          <span>Solo Jefe de Turno e Ingeniero de Operación pueden registrar en Operación 24h.</span>
        </div>
      )}

      <div className="mt-4 text-xs text-gray-400 flex items-center gap-2">
        <LayoutGrid size={14} />
        <span>
          Fecha: {fechaCargada} (Hoy) · Periodo actual: P{periodoActual}.
          {' '}Esta grilla solo registra: lo guardado se consulta en el listado de abajo.
          {' '}Multi-select: Shift/Ctrl/arrastre + Enter replica · Esc limpia.
        </span>
      </div>

      <LotesDelDia
        lotes={lotes}
        fecha={fechaCargada}
        cargando={cargandoLotes}
        error={errorLotes}
        puedeCrear={puedeCrear}
        onEditar={setLoteEditando}
        onEliminar={setLoteBorrando}
      />

      {/* `key` por lote: cambiar de registro remonta el modal con su estado limpio, sin arrastrar lo
          tecleado en el anterior. */}
      {loteEditando && (
        <LoteEditorModal
          key={loteEditando.lote_id}
          lote={loteEditando}
          plantaId={plantaId}
          periodoActual={periodoActual}
          onGuardar={handleGuardarLote}
          onEliminar={() => setLoteBorrando(loteEditando)}
          onCerrar={() => setLoteEditando(null)}
        />
      )}

      {loteBorrando && (
        <LoteBorrarModal
          key={`del-${loteBorrando.lote_id}`}
          lote={loteBorrando}
          onConfirmar={handleEliminarLote}
          onCerrar={() => setLoteBorrando(null)}
        />
      )}
    </div>
  );
}
