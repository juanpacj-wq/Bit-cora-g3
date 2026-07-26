import React from 'react';
import { ListChecks, Pencil, Trash2 } from 'lucide-react';
import { horaBogotaHHMM } from '../../utils/fecha';

// D-056 §6 — Listado del día de Operación 24h.
//
// Con la grilla convertida en formulario de captura (nace vacía y no refleja lo guardado), este
// listado es el único lugar donde el operador ve lo que ya se registró hoy. El refresco (montaje,
// post-guardado y tick de 60s) lo maneja SalaDeMandoGrid — acá no hay temporizador propio.
//
// D-057 le sumó la columna de acciones (corregir / eliminar), que aparece SOLO con `puedeCrear`
// (RN-04.f): sin permiso el listado se ve idéntico, sin controles — consultar no es escribir. La
// presentación existente no cambió: los renglones, el resumen de periodos y la marca de publicado
// por celda son los mismos de D-056.
//
// `publicado` es un indicador DERIVADO por CELDA: dos lotes pueden solaparse parcialmente y cada
// periodo compartido lo gana el de mayor hora de llamada (D-056 §3). Por eso la marca va en cada
// valor y no en la fila del lote.

const COLOR_TIPO = {
  AUTH: '#1e40af',
  PRUEBA: '#9333ea',
  REDESP: '#0d9488',
};

// "P14–P18" cuando los periodos son consecutivos, "P14, P16" cuando no. Resumen compacto: los
// valores celda por celda (con su marca de publicado) van en la columna de al lado.
function resumenPeriodos(periodos) {
  const nums = periodos.map((p) => p.periodo).filter((p) => p != null).sort((a, b) => a - b);
  if (nums.length === 0) return '—';
  const tramos = [];
  let ini = nums[0];
  let prev = nums[0];
  for (const n of nums.slice(1)) {
    if (n === prev + 1) { prev = n; continue; }
    tramos.push([ini, prev]);
    ini = n; prev = n;
  }
  tramos.push([ini, prev]);
  return tramos.map(([a, b]) => (a === b ? `P${a}` : `P${a}–P${b}`)).join(', ');
}

export default function LotesDelDia({ lotes, fecha, cargando, error, puedeCrear, onEditar, onEliminar }) {
  const total = lotes?.length ?? 0;
  const columnas = puedeCrear ? 8 : 7;

  return (
    <div className="mt-6">
      <div className="flex items-center gap-2 mb-2">
        <ListChecks size={16} className="text-gray-500" />
        <h3 className="text-sm font-semibold text-gray-700">Registrado hoy ({fecha})</h3>
        <span className="text-xs text-gray-400">
          {total === 0 ? 'sin registros' : `${total} ${total === 1 ? 'registro' : 'registros'}`}
        </span>
      </div>

      {error && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 mb-2 text-xs text-amber-800">
          No se pudo cargar el listado del día. {error}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Evento</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Hora llamada</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Funcionario CND</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider min-w-48">Descripción</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Periodos</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider min-w-56">Valores (MW)</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Registró</th>
              {puedeCrear && (
                <th className="px-3 py-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Acciones</th>
              )}
            </tr>
          </thead>
          <tbody>
            {total === 0 && (
              <tr>
                <td colSpan={columnas} className="px-3 py-6 text-center text-sm text-gray-400">
                  {cargando ? 'Cargando lo registrado hoy…' : 'Todavía no hay registros de Operación 24h para hoy.'}
                </td>
              </tr>
            )}
            {lotes?.map((lote) => {
              const color = COLOR_TIPO[lote.tipo] || '#374151';
              // `hora_llamada` viaja en ISO UTC; se presenta en Bogotá explícito (D-020). Los
              // registros migrados por F32.A1 no la tienen: la clave está AUSENTE, no vacía.
              const hora = lote.hora_llamada ? horaBogotaHHMM(lote.hora_llamada) : null;
              return (
                <tr key={lote.lote_id} className="border-b border-gray-100 align-top">
                  <td className="px-3 py-2 font-semibold whitespace-nowrap" style={{ color }}>
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                      {lote.tipo_nombre || lote.tipo}
                    </div>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700">
                    {hora ?? <span className="text-gray-400" title="Registro anterior a la hora de llamada">Sin hora</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-700">{lote.funcionariocnd || <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-2 text-gray-600">{lote.detalle || <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700">{resumenPeriodos(lote.periodos || [])}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {(lote.periodos || []).map((p) => (
                        <span
                          key={p.registro_id ?? p.periodo}
                          title={p.publicado
                            ? 'Publicado al dashboard'
                            : 'Reemplazado por un registro posterior de este mismo periodo'}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs ${
                            p.publicado
                              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                              : 'bg-gray-50 border-gray-200 text-gray-500'
                          }`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${p.publicado ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                          P{p.periodo} · {p.valor_mw}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                    {lote.creado_por?.nombre_completo || <span className="text-gray-300">—</span>}
                  </td>
                  {puedeCrear && (
                    <td className="px-3 py-2 whitespace-nowrap text-right">
                      {/* D-057: corregir y eliminar NO exigen ser el autor — el gate es `puede_crear`
                          en MAND (excepción a D-049, acotada a MAND): el turno entrante corrige lo
                          que dejó mal el saliente. */}
                      <button
                        type="button"
                        onClick={() => onEditar?.(lote)}
                        title="Corregir este registro"
                        aria-label={`Corregir el registro de ${lote.tipo_nombre || lote.tipo}`}
                        className="p-1.5 rounded text-gray-400 hover:text-emerald-700 hover:bg-emerald-50 transition-colors"
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={() => onEliminar?.(lote)}
                        title="Eliminar este registro"
                        aria-label={`Eliminar el registro de ${lote.tipo_nombre || lote.tipo}`}
                        className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex items-center gap-3 text-xs text-gray-400">
        <span className="inline-flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Publicado al dashboard
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-gray-300" /> Reemplazado por un registro posterior
        </span>
      </div>
    </div>
  );
}
