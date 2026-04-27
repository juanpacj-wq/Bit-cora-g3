import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { LayoutGrid, Save, AlertTriangle } from 'lucide-react';
import { useSalaDeMando } from '../../hooks/useSalaDeMando';

const TIPOS = [
  { key: 'AUTH',   label: 'Autorización', tipoEventoNombre: 'Autorización', color: '#1e40af', cancelMsg: 'Autorización cancelada' },
  { key: 'PRUEBA', label: 'Pruebas',      tipoEventoNombre: 'Pruebas',      color: '#9333ea', cancelMsg: 'Prueba cancelada' },
  { key: 'REDESP', label: 'Redespacho',   tipoEventoNombre: 'Redespacho',   color: '#0d9488', cancelMsg: 'Redespacho cancelado' },
];

// F6: grilla 3×24 de Sala de Mando. Cada celda numérica es editable; al perder foco
// (onBlur) se decide POST/PUT/DELETE según el delta. Detalle y FuncionarioCND son por fila
// y, al cambiar, se propagan a todos los registros existentes de esa fila para mantener
// consistencia (preguntas.md punto 3 dice que aplican por fila).
export default function SalaDeMandoGrid({ bitacora, tiposEvento, plantaId, fecha, puedeCrear, showToast, onError }) {
  const { getGrilla, crearCelda, actualizarCelda, eliminarCelda, loading } = useSalaDeMando();
  const [grilla, setGrilla] = useState(null);
  const [editFila, setEditFila] = useState({}); // { AUTH: { detalle, funcionariocnd }, ... }

  const tipoEventoIdByNombre = useMemo(() => {
    const m = new Map();
    for (const t of (tiposEvento || [])) m.set(t.nombre, t.tipo_evento_id);
    return m;
  }, [tiposEvento]);

  const refresh = useCallback(async () => {
    if (!plantaId || !fecha) return;
    try {
      const g = await getGrilla(plantaId, fecha);
      setGrilla(g);
      // sincronizar el form de fila con lo que vino del server
      const next = {};
      for (const t of TIPOS) {
        const f = g[t.key] || {};
        next[t.key] = { detalle: f.detalle || '', funcionariocnd: f.funcionariocnd || '' };
      }
      setEditFila(next);
    } catch (e) {
      onError?.(e.message);
    }
  }, [getGrilla, plantaId, fecha, onError]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleCellBlur = async (tipoKey, periodo, oldValor, ev) => {
    if (!puedeCrear) return;
    const raw = ev.target.value.trim();
    const newValor = raw === '' ? null : parseFloat(raw);
    if (raw !== '' && Number.isNaN(newValor)) { onError?.('Valor inválido'); return; }
    if (newValor === oldValor) return;

    const tipoMeta = TIPOS.find((t) => t.key === tipoKey);
    const tipoEventoId = tipoEventoIdByNombre.get(tipoMeta.tipoEventoNombre);
    if (!tipoEventoId) { onError?.(`No se encontró tipo de evento ${tipoMeta.tipoEventoNombre}`); return; }

    const filaForm = editFila[tipoKey] || {};
    const detalle = filaForm.detalle || null;
    const funcionariocnd = filaForm.funcionariocnd || null;

    // F6: validación funcionariocnd para Autorización (también lo valida el server, pero
    // adelantamos para UX).
    if (tipoKey === 'AUTH' && newValor != null && (!funcionariocnd || funcionariocnd.trim() === '')) {
      onError?.('Funcionario CND es requerido para Autorización');
      ev.target.value = oldValor ?? '';
      return;
    }

    const fila = grilla?.[tipoKey] || {};
    const registroId = fila.registros?.[periodo];

    try {
      if (registroId && newValor != null) {
        // PUT
        await actualizarCelda(registroId, { valor_mw: newValor, detalle, funcionariocnd, periodo });
      } else if (registroId && newValor == null) {
        // F7: vaciar celda → DELETE. Backend hace hard-delete de registro_activo y soft-delete
        // (`activa=0`) sobre la fila correspondiente de evento_dashboard. Volver a llenar la
        // celda hace POST → upsertEventoDashboard reactiva la fila preservando evento_id.
        await eliminarCelda(registroId);
        showToast?.(`${tipoMeta.cancelMsg} (P${periodo})`);
      } else if (!registroId && newValor != null) {
        // POST
        const r = await crearCelda({
          bitacora_id: bitacora.bitacora_id,
          planta_id: plantaId,
          tipo_evento_id: tipoEventoId,
          periodo,
          valor_mw: newValor,
          detalle,
          funcionariocnd,
          fecha,
        });
        if (r?.registro?.registro_id) showToast?.(`${tipoMeta.label} P${periodo}: registro ${r.registro.registro_id}`);
      }
      await refresh();
    } catch (e) {
      onError?.(e.message);
      ev.target.value = oldValor ?? '';
    }
  };

  // F6: al cambiar detalle/funcionariocnd de una fila, propagar a todos los registros
  // existentes (PUT). Esto mantiene los valores compartidos por fila consistentes.
  const handleFilaSave = async (tipoKey) => {
    const fila = grilla?.[tipoKey] || {};
    const ids = Object.values(fila.registros || {});
    if (ids.length === 0) {
      showToast?.('Sin celdas para propagar');
      return;
    }
    const filaForm = editFila[tipoKey] || {};
    const detalle = filaForm.detalle || null;
    const funcionariocnd = filaForm.funcionariocnd || null;
    if (tipoKey === 'AUTH' && (!funcionariocnd || funcionariocnd.trim() === '')) {
      onError?.('Funcionario CND es requerido para Autorización');
      return;
    }
    try {
      // Actualizamos todos los registros en serie (volumen bajo: máx 24 por fila).
      for (const [periodoStr, rid] of Object.entries(fila.registros)) {
        await actualizarCelda(rid, {
          detalle,
          funcionariocnd,
          periodo: parseInt(periodoStr, 10),
        });
      }
      showToast?.(`${tipoKey}: detalle/funcionario propagado a ${ids.length} celdas`);
      await refresh();
    } catch (e) {
      onError?.(e.message);
    }
  };

  if (!grilla) {
    return <div className="flex-1 flex items-center justify-center text-gray-400">Cargando Sala de Mando…</div>;
  }

  return (
    <div className="flex-1 overflow-auto px-6 py-4">
      <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="sticky left-0 bg-gray-50 px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider min-w-32">Evento</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider min-w-48">Detalle / Comentario</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider min-w-40">Funcionario CND</th>
              {Array.from({ length: 24 }, (_, i) => (
                <th key={i} className="px-2 py-2 text-center text-xs font-semibold text-gray-500 min-w-16">P{i + 1}</th>
              ))}
              <th className="px-3 py-2 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {TIPOS.map((t) => {
              const fila = grilla[t.key] || {};
              const filaForm = editFila[t.key] || {};
              const requireFuncionario = t.key === 'AUTH';
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
                      value={filaForm.detalle ?? ''}
                      onChange={(e) => setEditFila((s) => ({ ...s, [t.key]: { ...s[t.key], detalle: e.target.value } }))}
                      placeholder="Comentario de la fila…"
                      disabled={!puedeCrear}
                      className="w-full px-2 py-1 rounded border border-gray-200 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:bg-gray-50"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      value={filaForm.funcionariocnd ?? ''}
                      onChange={(e) => setEditFila((s) => ({ ...s, [t.key]: { ...s[t.key], funcionariocnd: e.target.value } }))}
                      placeholder={requireFuncionario ? 'Requerido…' : 'Opcional…'}
                      disabled={!puedeCrear}
                      className={`w-full px-2 py-1 rounded border text-sm focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:bg-gray-50 ${
                        requireFuncionario && !filaForm.funcionariocnd ? 'border-amber-300' : 'border-gray-200'
                      }`}
                    />
                  </td>
                  {Array.from({ length: 24 }, (_, i) => {
                    const periodo = i + 1;
                    const valor = fila.valores?.[i];
                    return (
                      <td key={i} className="px-1 py-1">
                        <input
                          type="number"
                          step="0.01"
                          defaultValue={valor ?? ''}
                          onBlur={(e) => handleCellBlur(t.key, periodo, valor, e)}
                          disabled={!puedeCrear || loading}
                          className="w-16 px-1 py-1 rounded border border-gray-200 text-sm text-center focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:bg-gray-50"
                        />
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-center">
                    {puedeCrear && (
                      <button
                        onClick={() => handleFilaSave(t.key)}
                        disabled={loading}
                        title="Propagar detalle y funcionario a las celdas existentes"
                        className="p-1.5 rounded text-white text-xs disabled:opacity-50"
                        style={{ backgroundColor: t.color }}
                      >
                        <Save size={14} />
                      </button>
                    )}
                  </td>
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
        <span>Fecha: {fecha} — vaciar una celda elimina ese registro y su evento de dashboard.</span>
      </div>
    </div>
  );
}
