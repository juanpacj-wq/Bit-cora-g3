import React, { useMemo, useState } from 'react';
import { X, AlertTriangle, Save, Trash2, Plus, Lock } from 'lucide-react';
import { horaBogotaHHMM } from '../../utils/fecha';
import { MOTIVO_MSG_CORRECCION, mensajeDeMotivo } from './motivos';

// D-057 — Corrección de un lote ya registrado, en un MODAL sobre el listado del día (decisión 4).
//
// Por qué un modal y no cargar el lote en la grilla: la grilla es un formulario de captura
// append-only que nace vacía y se vacía al guardar (D-056). Cargarle un lote la volvería otra vez un
// espejo editable del servidor — justo el modelo que D-056 eliminó a propósito. El modal mantiene
// separada la CAPTURA (grilla) de la CORRECCIÓN (histórico del día).
//
// El TIPO se muestra pero no se puede cambiar (decisión 11): moverlo tocaría dos claves del
// dashboard y el guard de coherencia tipo_evento↔bitácora (D-053). Se corrige eliminando y
// volviendo a registrar.
//
// Este modal es AFFORDANCE, no la regla: la autoridad es el backend. Todo lo que acá se deshabilita
// (valor de un periodo pasado en REDESP, Guardar sin ningún valor) el `PUT` lo rechaza igual, y sus
// `errores[]` se pintan celda por celda.
const COLOR_TIPO = {
  AUTH: '#1e40af',
  PRUEBA: '#9333ea',
  REDESP: '#0d9488',
};

export default function LoteEditorModal({ lote, plantaId, periodoActual, onGuardar, onEliminar, onCerrar }) {
  const esAuth = lote.tipo === 'AUTH';
  const esRedesp = lote.tipo === 'REDESP';
  const color = COLOR_TIPO[lote.tipo] || '#374151';

  // `hora_llamada` viaja en ISO UTC y se edita en 'HH:mm' Bogotá (D-020). Los lotes que migró
  // F32.A1 NO tienen la clave: arrancan vacíos y el backend exige llenarla (`hora_requerida`).
  const [hora, setHora] = useState(() => (lote.hora_llamada ? (horaBogotaHHMM(lote.hora_llamada) ?? '') : ''));
  const [funcionariocnd, setFuncionariocnd] = useState(lote.funcionariocnd || '');
  const [detalle, setDetalle] = useState(lote.detalle || '');
  // Los valores se guardan como STRING mientras se editan (preserva "10." y otros estados
  // intermedios); el parseo lo hace el backend, que es quien decide qué es un número válido.
  const [filas, setFilas] = useState(() =>
    (lote.periodos || [])
      .slice()
      .sort((a, b) => a.periodo - b.periodo)
      .map((p) => ({ periodo: p.periodo, valor: p.valor_mw == null ? '' : String(p.valor_mw) }))
  );
  const [nuevoPeriodo, setNuevoPeriodo] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [errores, setErrores] = useState([]);
  const [errorGeneral, setErrorGeneral] = useState(null);

  // Lock REDESP: mismo criterio visual que la grilla (`isLocked`). Solo REDESP tiene lock; AUTH y
  // PRUEBA no (D-016). Bloquea el VALOR y el quitar — nunca la hora ni la descripción.
  const bloqueado = (periodo) => esRedesp && periodo < periodoActual;

  const periodosUsados = useMemo(() => new Set(filas.map((f) => f.periodo)), [filas]);
  // Agregar un periodo pasado en REDESP también rebota (el lock actúa sobre el delta), así que ni
  // siquiera se ofrece.
  const periodosLibres = useMemo(() => {
    const libres = [];
    for (let p = 1; p <= 24; p++) {
      if (periodosUsados.has(p)) continue;
      if (esRedesp && p < periodoActual) continue;
      libres.push(p);
    }
    return libres;
  }, [periodosUsados, esRedesp, periodoActual]);

  const hayValores = filas.some((f) => String(f.valor).trim() !== '');

  const errorPorPeriodo = useMemo(() => {
    const m = new Map();
    for (const e of errores) if (e?.periodo != null) m.set(e.periodo, e);
    return m;
  }, [errores]);
  const erroresDeLote = useMemo(() => errores.filter((e) => e?.periodo == null), [errores]);
  const motivosDeLote = useMemo(() => new Set(erroresDeLote.map((e) => e?.motivo)), [erroresDeLote]);
  const horaMala = motivosDeLote.has('hora_requerida') || motivosDeLote.has('hora_invalida') || motivosDeLote.has('hora_futura');
  const funcMala = motivosDeLote.has('funcionariocnd_requerido');

  const setValor = (periodo, valor) =>
    setFilas((fs) => fs.map((f) => (f.periodo === periodo ? { ...f, valor } : f)));

  const quitarPeriodo = (periodo) =>
    setFilas((fs) => fs.filter((f) => f.periodo !== periodo));

  const agregarPeriodo = () => {
    const p = parseInt(nuevoPeriodo, 10);
    if (!Number.isInteger(p) || periodosUsados.has(p)) return;
    setFilas((fs) => [...fs, { periodo: p, valor: '' }].sort((a, b) => a.periodo - b.periodo));
    setNuevoPeriodo('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (guardando || !hayValores) return;
    setErrores([]);
    setErrorGeneral(null);
    setGuardando(true);
    try {
      // Una celda vaciada NO viaja: el backend la borra por ausencia (mismo criterio que el POST de
      // captura). Vaciarlas todas no es borrar el lote — para eso está Eliminar (decisión 6).
      await onGuardar({
        planta_id: plantaId,
        hora: hora || null,
        detalle: detalle.trim() || null,
        funcionariocnd: esAuth ? (funcionariocnd.trim() || null) : null,
        periodos: filas
          .filter((f) => String(f.valor).trim() !== '')
          .map((f) => ({ periodo: f.periodo, valor_mw: String(f.valor).trim() })),
      });
    } catch (err) {
      if (Array.isArray(err?.errores)) setErrores(err.errores);
      else setErrorGeneral(err?.message || 'No se pudo guardar la corrección.');
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4 py-6 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full my-auto" style={{ borderTop: `4px solid ${color}` }}>
        <div className="px-6 py-4 flex items-center justify-between border-b border-gray-200">
          <div>
            <h3 className="text-base font-semibold text-gray-800">Corregir registro</h3>
            <div className="mt-1 flex items-center gap-2 text-sm font-semibold" style={{ color }}>
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
              {lote.tipo_nombre || lote.tipo}
              <span
                className="inline-flex items-center gap-1 text-[11px] font-normal text-gray-400"
                title="El tipo no se puede cambiar: si te equivocaste de tipo, elimina el registro y vuelve a registrarlo con el correcto."
              >
                <Lock size={11} /> tipo fijo
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onCerrar}
            disabled={guardando}
            className="p-1 rounded hover:bg-gray-100 transition-colors disabled:opacity-50"
            aria-label="Cerrar"
          >
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block">
              <div className="text-[11px] font-medium text-gray-500 mb-1">Hora de la llamada al CND</div>
              <input
                type="time"
                value={hora}
                onChange={(e) => setHora(e.target.value)}
                disabled={guardando}
                className={`w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:bg-gray-50 ${
                  horaMala ? 'border-red-500' : 'border-gray-200'
                }`}
              />
              <p className="text-[11px] mt-1 text-gray-400">
                Decide cuál registro se publica al dashboard cuando dos comparten periodo.
              </p>
            </label>

            <label className="block">
              <div className="text-[11px] font-medium text-gray-500 mb-1">
                Funcionario CND {esAuth ? '(requerido)' : ''}
              </div>
              <input
                type="text"
                value={esAuth ? funcionariocnd : ''}
                onChange={(e) => setFuncionariocnd(e.target.value)}
                disabled={guardando || !esAuth}
                placeholder={esAuth ? 'Nombre del funcionario…' : 'No aplica'}
                className={`w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-1 focus:ring-emerald-400 ${
                  funcMala ? 'border-red-500' : 'border-gray-200'
                } ${!esAuth ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'disabled:bg-gray-50'}`}
              />
            </label>
          </div>

          <label className="block">
            <div className="text-[11px] font-medium text-gray-500 mb-1">Descripción / comentario</div>
            <input
              type="text"
              value={detalle}
              onChange={(e) => setDetalle(e.target.value)}
              disabled={guardando}
              placeholder="Comentario"
              className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:bg-gray-50"
            />
          </label>

          <div>
            <div className="text-[11px] font-medium text-gray-500 mb-2">Periodos y valores (MW)</div>
            {filas.length === 0 && (
              <div className="text-xs text-gray-400 border border-dashed border-gray-200 rounded-lg px-3 py-4 text-center">
                Este registro se quedó sin periodos. Agrega al menos uno, o usa Eliminar si lo que quieres es darlo de baja.
              </div>
            )}
            <div className="space-y-1">
              {filas.map((f) => {
                const locked = bloqueado(f.periodo);
                const err = errorPorPeriodo.get(f.periodo);
                return (
                  <div key={f.periodo} className="flex items-center gap-2">
                    <span className="w-12 text-xs font-semibold text-gray-600 text-right">P{f.periodo}</span>
                    <input
                      type="number"
                      step="0.01"
                      value={f.valor}
                      onChange={(e) => setValor(f.periodo, e.target.value)}
                      disabled={guardando || locked}
                      placeholder="Vacío = se quita"
                      title={locked ? MOTIVO_MSG_CORRECCION.periodo_bloqueado : undefined}
                      className={`w-32 px-2 py-1 rounded border text-sm text-center focus:outline-none focus:ring-1 focus:ring-emerald-400 ${
                        err ? 'border-red-500' : 'border-gray-200'
                      } ${locked ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'disabled:bg-gray-50'}`}
                    />
                    <button
                      type="button"
                      onClick={() => quitarPeriodo(f.periodo)}
                      disabled={guardando || locked}
                      title={locked ? MOTIVO_MSG_CORRECCION.periodo_bloqueado : `Quitar P${f.periodo} del registro`}
                      aria-label={`Quitar periodo ${f.periodo}`}
                      className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-400"
                    >
                      <Trash2 size={15} />
                    </button>
                    {locked && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-gray-400">
                        <Lock size={11} /> ya despachado
                      </span>
                    )}
                    {err && (
                      <span className="text-[11px] text-red-600">
                        {mensajeDeMotivo(err, MOTIVO_MSG_CORRECCION)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {periodosLibres.length > 0 && (
              <div className="mt-3 flex items-center gap-2">
                <select
                  value={nuevoPeriodo}
                  onChange={(e) => setNuevoPeriodo(e.target.value)}
                  disabled={guardando}
                  className="px-2 py-1 rounded border border-gray-200 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:bg-gray-50"
                >
                  <option value="">Agregar periodo…</option>
                  {periodosLibres.map((p) => (
                    <option key={p} value={p}>P{p}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={agregarPeriodo}
                  disabled={guardando || nuevoPeriodo === ''}
                  className="inline-flex items-center gap-1 px-3 py-1 rounded-lg border border-gray-200 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  <Plus size={14} /> Agregar
                </button>
                {esRedesp && (
                  <span className="text-[11px] text-gray-400">
                    En redespacho solo puedes agregar del periodo actual (P{periodoActual}) en adelante.
                  </span>
                )}
              </div>
            )}
          </div>

          {erroresDeLote.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-red-800 mb-1">
                <AlertTriangle size={16} />
                Corrige esto antes de guardar
              </div>
              <ul className="text-xs text-red-700 list-disc pl-5 space-y-1">
                {erroresDeLote.map((e, i) => (
                  <li key={i}>{mensajeDeMotivo(e, MOTIVO_MSG_CORRECCION)}</li>
                ))}
              </ul>
              <div className="mt-2 text-xs text-red-700">
                No se cambió nada: el registro quedó tal como estaba.
              </div>
            </div>
          )}

          {errorGeneral && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 flex gap-2 items-start text-sm text-red-800">
              <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
              <span>{errorGeneral}</span>
            </div>
          )}

          {!hayValores && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 text-xs text-amber-800">
              {MOTIVO_MSG_CORRECCION.lote_sin_celdas}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 pt-2 border-t border-gray-100">
            <button
              type="button"
              onClick={onEliminar}
              disabled={guardando}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-red-700 bg-red-50 hover:bg-red-100 disabled:opacity-50"
            >
              <Trash2 size={16} /> Eliminar registro
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onCerrar}
                disabled={guardando}
                className="px-4 py-2 rounded-xl text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={guardando || !hayValores}
                className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 shadow-sm transition-all disabled:opacity-60"
              >
                <Save size={16} />
                {guardando ? 'Guardando…' : 'Guardar cambios'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
