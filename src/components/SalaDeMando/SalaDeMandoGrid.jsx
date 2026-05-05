import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { LayoutGrid, AlertTriangle } from 'lucide-react';
import { useSalaDeMando } from '../../hooks/useSalaDeMando';
import { getTodayBogota, horaBogota } from '../../utils/fecha';

const TIPOS = [
  { key: 'AUTH',   label: 'Autorización', color: '#1e40af' },
  { key: 'PRUEBA', label: 'Pruebas',      color: '#9333ea' },
  { key: 'REDESP', label: 'Redespacho',   color: '#0d9488' },
];
const TIPO_KEYS = TIPOS.map((t) => t.key);

const MOTIVO_MSG = {
  fecha_no_es_hoy: 'La fecha no es hoy. Recargá la página.',
  tipo_invalido: 'Tipo de fila no reconocido',
  periodos_invalido: 'Lista de periodos inválida',
  periodo_fuera_rango: 'Periodo fuera de rango (1-24)',
  valor_mw_invalido: 'Valor numérico inválido',
  periodo_bloqueado: 'Periodo anterior al actual — solo se pueden registrar redespachos del periodo actual en adelante',
  funcionariocnd_requerido: 'Funcionario CND es requerido para Autorización',
};

// El server devuelve `valores` como Array(24) indexado 0..23 (P1=valores[0]). Lo paso a un
// objeto {1..24: number|null} para que diff y multi-select trabajen con periodos directos.
function buildBuffer(g) {
  const buf = {};
  for (const t of TIPO_KEYS) {
    const f = g?.[t] || {};
    const arr = Array.isArray(f.valores) ? f.valores : Array(24).fill(null);
    const valores = {};
    for (let p = 1; p <= 24; p++) valores[p] = arr[p - 1] ?? null;
    buf[t] = {
      valores,
      detalle: f.detalle || '',
      funcionariocnd: f.funcionariocnd || '',
    };
  }
  return buf;
}

function cloneBuffer(buf) {
  const out = {};
  for (const t of TIPO_KEYS) {
    out[t] = {
      valores: { ...buf[t].valores },
      detalle: buf[t].detalle,
      funcionariocnd: buf[t].funcionariocnd,
    };
  }
  return out;
}

function diffBuffer(snap, buf) {
  const filas = [];
  for (const tipo of TIPO_KEYS) {
    const periodosCambiados = [];
    for (let p = 1; p <= 24; p++) {
      const a = snap[tipo].valores[p];
      const b = buf[tipo].valores[p];
      if (a !== b) periodosCambiados.push({ periodo: p, valor_mw: b });
    }
    const detalleCambio = (snap[tipo].detalle || '') !== (buf[tipo].detalle || '');
    const funcCambio = (snap[tipo].funcionariocnd || '') !== (buf[tipo].funcionariocnd || '');
    if (periodosCambiados.length > 0 || detalleCambio || funcCambio) {
      filas.push({
        tipo,
        detalle: buf[tipo].detalle ? buf[tipo].detalle : null,
        funcionariocnd: tipo === 'AUTH' ? (buf[tipo].funcionariocnd || null) : null,
        periodos: periodosCambiados,
      });
    }
  }
  return filas;
}

// F17: grilla 3×24 de Sala de Mando con buffer en memoria + batch save. F10 (paginación
// entre días) eliminada — la grilla solo muestra HOY y el cierre es automático vía
// sweeper diario (F16). Multi-select estilo Excel + lock REDESP por periodo actual.
export default function SalaDeMandoGrid({
  bitacora, plantaId, puedeCrear, showToast, onError,
  onDirtyChange, onGuardandoChange, registerSaveHandler,
}) {
  const { getGrilla, guardarBatch } = useSalaDeMando();
  const [snapshot, setSnapshot] = useState(null);
  const [buffer, setBuffer] = useState(null);
  const [seleccion, setSeleccion] = useState({ tipo: null, periodos: new Set() });
  const [anchorPeriodo, setAnchorPeriodo] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [periodoActual, setPeriodoActual] = useState(() => Math.floor(horaBogota()) + 1);
  const [guardando, setGuardando] = useState(false);
  const [errores, setErrores] = useState([]);
  // Strings parciales mientras el input tiene foco — preserva "10." y otros estados intermedios
  // hasta que el blur parsea y commitea al buffer.
  const [editing, setEditing] = useState({});
  const [fechaCargada, setFechaCargada] = useState(null);
  const tableRef = useRef(null);
  const guardarRef = useRef(null);
  // F18-fix: refs latentes para callbacks externos. El padre puede pasarlos como arrows
  // inline (recreadas en cada render), y si los pusiéramos en deps de useCallback, cada
  // render del padre invalidaría refresh/guardar → el useEffect del initial-load
  // re-ejecutaría refresh() → setBuffer/setEditing limpian lo tipeado por el usuario.
  const onErrorRef = useRef(onError);
  const showToastRef = useRef(showToast);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { showToastRef.current = showToast; }, [showToast]);

  const refresh = useCallback(async () => {
    if (!plantaId) return;
    const fecha = getTodayBogota();
    try {
      const g = await getGrilla(plantaId, fecha);
      const buf = buildBuffer(g);
      setSnapshot(buf);
      setBuffer(cloneBuffer(buf));
      setFechaCargada(fecha);
      setEditing({});
      setErrores([]);
    } catch (e) {
      onErrorRef.current?.(e.message);
    }
  }, [getGrilla, plantaId]);

  // F18-fix: dep [plantaId] (no [refresh]) — el initial-load conceptualmente depende de
  // la planta, no de la identidad de la función. getGrilla es estable (useCallback []).
  useEffect(() => { refresh(); }, [plantaId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Watcher cada 60s: actualiza periodo actual (lock REDESP) + detecta cambio de día
  // Bogotá. Si cruzó medianoche, refetch (vendrá vacía porque el sweeper habrá cerrado).
  useEffect(() => {
    const i = setInterval(() => {
      setPeriodoActual(Math.floor(horaBogota()) + 1);
      const t = getTodayBogota();
      if (fechaCargada && t !== fechaCargada) refresh();
    }, 60_000);
    return () => clearInterval(i);
  }, [fechaCargada, refresh]);

  const filasDiff = useMemo(() => {
    if (!snapshot || !buffer) return [];
    return diffBuffer(snapshot, buffer);
  }, [snapshot, buffer]);
  const dirty = filasDiff.length > 0;

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
    if (!buffer || !snapshot) return;
    const filas = diffBuffer(snapshot, buffer);
    if (filas.length === 0) return;
    setGuardando(true);
    try {
      const r = await guardarBatch({ planta_id: plantaId, fecha: getTodayBogota(), filas });
      const res = r?.resumen || { creados: 0, actualizados: 0, eliminados: 0 };
      showToastRef.current?.(`Guardado: ${res.creados} nuevos, ${res.actualizados} actualizados, ${res.eliminados} eliminados`);
      setErrores([]);
      await refresh();
    } catch (e) {
      if (Array.isArray(e?.errores)) {
        setErrores(e.errores);
        onErrorRef.current?.('Hay errores en el formulario. Corregí las celdas resaltadas.');
      } else {
        onErrorRef.current?.(e.message);
      }
    } finally {
      setGuardando(false);
    }
  }, [buffer, snapshot, guardarBatch, plantaId, refresh]);

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

  if (!buffer || !snapshot) {
    return <div className="flex-1 flex items-center justify-center text-gray-400">Cargando Sala de Mando…</div>;
  }

  return (
    <div className="flex-1 overflow-auto px-6 py-4">
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
            Corregí estos errores antes de guardar
          </div>
          <ul className="text-xs text-red-700 list-disc pl-5 space-y-1">
            {errores.map((e, i) => (
              <li key={i}>
                {e?.tipo ? `[${e.tipo}${e?.periodo ? ` P${e.periodo}` : ''}] ` : ''}
                {e?.mensaje || MOTIVO_MSG[e?.motivo] || e?.motivo || 'Error desconocido'}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div ref={tableRef} className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm select-none">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="sticky left-0 bg-gray-50 px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider min-w-32">Evento</th>
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
          <span>Solo Jefe de Turno e Ingeniero de Operación pueden editar Sala de Mando.</span>
        </div>
      )}

      <div className="mt-4 text-xs text-gray-400 flex items-center gap-2">
        <LayoutGrid size={14} />
        <span>
          Fecha: {fechaCargada} (Hoy) · Periodo actual: P{periodoActual}.
          {' '}Multi-select: Shift/Ctrl/arrastre + Enter replica · Esc limpia.
        </span>
      </div>
    </div>
  );
}
