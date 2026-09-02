import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Clock, RefreshCw, Shuffle, UserX, WifiOff, X } from 'lucide-react';
import { api } from '../../hooks/useApi';
import { ausenciasPorTitular, ESTADOS, RANGO_MAX_DIAS, useCumplimiento } from '../../hooks/useCumplimiento';

// D-065 L09 — superficie C: plan-vs-real de la rotación, SOLO lectura. Consume el contrato C6
// (`GET /api/rotacion/cumplimiento`) que produce L06.
//
// Componente CONTROLADO (C8, D-035 convención 17): el rango y la unidad llegan por props y los
// cambios se avisan por callback. NO lee ni escribe el hash — eso es territorio de L10 (O4), que al
// derivar el estado de una ruta `#/rotacion/cumplimiento` sin parámetros puede usar
// `rangoPorDefecto()` de `useCumplimiento`.
//
// La regla que gobierna todo el copy de esta pantalla: `PENDIENTE` NO significa "turno vacío" ni
// "sin personal". Significa que ninguno de los titulares que designó el patrón registró en la
// bitácora — pudo haber tres personas del mismo rol trabajando. Decirlo de otra forma sería mentir
// sobre el único dato que este módulo aporta (CA-15).

// Presentación en Bogotá explícita (D-020 / convención 9). `fecha_operativa` es una fecha LÓGICA sin
// hora ('YYYY-MM-DD', ya normalizada por el backend): se ancla a medianoche UTC y se formatea en UTC
// para que el offset no la corra un día — mismo criterio que `SeguimientoTurnos.jsx`. Prohibido
// `toLocaleDateString()` a pelo y `new Date(f).getDate()`.
const FMT_FECHA = new Intl.DateTimeFormat('es-CO', {
  timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric',
});
const fmtFecha = (f) => (f ? FMT_FECHA.format(new Date(`${String(f).slice(0, 10)}T00:00:00Z`)) : '—');

// Etiqueta, color y —sobre todo— qué significa cada estado. La descripción no es decorativa: es lo
// que impide que alguien lea `PENDIENTE` como "no vino nadie".
const ESTADO_META = {
  PENDIENTE: {
    etiqueta: 'Pendiente',
    descripcion: 'Ningún titular registró en la bitácora',
    bg: '#FEE2E2', fg: '#991B1B', borde: '#FCA5A5',
  },
  PARCIAL: {
    etiqueta: 'Parcial',
    descripcion: 'Entró al menos un titular; faltaron otros',
    bg: '#FEF3C7', fg: '#92400E', borde: '#FCD34D',
  },
  COMPLETO: {
    etiqueta: 'Completo',
    descripcion: 'Entraron todos los titulares',
    bg: '#DCFCE7', fg: '#166534', borde: '#86EFAC',
  },
  CUBIERTO_POR_RELEVO: {
    etiqueta: 'Cubierto por relevo',
    descripcion: 'Alguien que no era titular tomó el control del rol',
    bg: '#DBEAFE', fg: '#1E40AF', borde: '#93C5FD',
  },
};

const nombreDe = (p) => p?.nombre || (p?.usuario_id != null ? `Usuario #${p.usuario_id}` : 'Sin nombre');

function ChipEstado({ estado }) {
  const meta = ESTADO_META[estado];
  if (!meta) return <span className="text-gray-400">{estado || '—'}</span>;
  return (
    <span
      data-estado={estado}
      title={meta.descripcion}
      className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap"
      style={{ backgroundColor: meta.bg, color: meta.fg }}
    >
      {meta.etiqueta}
    </span>
  );
}

export default function CumplimientoRotacion({ desde, hasta, planta, onRangoChange, onPlantaChange }) {
  const { filas, resumen, cargando, error, cargar } = useCumplimiento();
  const [plantas, setPlantas] = useState([]);

  // Catálogo de unidades, data-driven (convención 12): nunca una lista de plantas escrita a mano. El
  // endpoint ya excluye la planta de test 'TST' (D-030). Si falla, el selector se queda con la unidad
  // que venga por props y la consulta sigue funcionando: no es un error de esta pantalla.
  useEffect(() => {
    let vivo = true;
    api.get('/api/catalogos/plantas')
      .then((r) => { if (vivo) setPlantas(r?.plantas || []); })
      .catch(() => {});
    return () => { vivo = false; };
  }, []);

  // Controlado: el rango y la unidad son las props, no estado local. Sin los tres no hay consulta que
  // hacer — pedirla igual solo gastaría un viaje para recibir un 400 `rango_requerido`.
  const listo = Boolean(desde && hasta && planta);
  const recargar = useCallback(() => {
    if (listo) cargar({ desde, hasta, planta });
  }, [listo, cargar, desde, hasta, planta]);
  useEffect(() => { recargar(); }, [recargar]);

  const ausentes = useMemo(() => ausenciasPorTitular(filas), [filas]);
  const totalAusencias = useMemo(() => ausentes.reduce((n, p) => n + p.turnos.length, 0), [ausentes]);
  const hayEnCurso = useMemo(() => filas.some((f) => f?.congelado === false), [filas]);

  const cambiarDesde = (v) => onRangoChange?.({ desde: v, hasta });
  const cambiarHasta = (v) => onRangoChange?.({ desde, hasta: v });

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Filtros */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-500">
          Unidad
          <select
            aria-label="Unidad"
            value={planta || ''}
            onChange={(e) => onPlantaChange?.(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-900 bg-white"
          >
            {!planta && <option value="">Escoge una unidad</option>}
            {plantas.length === 0 && planta && <option value={planta}>{planta}</option>}
            {plantas.map((p) => (
              <option key={p.planta_id} value={p.planta_id}>{p.nombre || p.planta_id}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-500">
          Desde
          <input
            type="date" aria-label="Desde" value={desde || ''} max={hasta || undefined}
            onChange={(e) => cambiarDesde(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-500">
          Hasta
          <input
            type="date" aria-label="Hasta" value={hasta || ''} min={desde || undefined}
            onChange={(e) => cambiarHasta(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-900"
          />
        </label>
        <button
          type="button" onClick={recargar} disabled={cargando || !listo}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 transition-colors"
        >
          <RefreshCw size={15} className={cargando ? 'animate-spin' : ''} />
          {cargando ? 'Cargando…' : 'Actualizar'}
        </button>
        <div className="ml-auto text-xs text-gray-500 self-center">
          Máximo {RANGO_MAX_DIAS} días por consulta · {filas.length} turno{filas.length === 1 ? '' : 's'} × rol
        </div>
      </div>

      {error && (
        <div
          data-error={error.codigo || 'desconocido'}
          className="px-6 py-2 flex items-center gap-2 text-sm text-red-700 bg-red-50 border-b border-red-200"
        >
          {error.esRed ? <WifiOff size={15} /> : <AlertTriangle size={15} />}
          <span>{error.mensaje}</span>
        </div>
      )}

      <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
        {/* Resumen por estado — las cuatro claves SIEMPRE, aunque estén en 0 */}
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
          {ESTADOS.map((e) => {
            const meta = ESTADO_META[e];
            return (
              <div
                key={e} data-resumen={e}
                className="rounded-xl border px-4 py-3"
                style={{ backgroundColor: meta.bg, borderColor: meta.borde }}
              >
                <div data-conteo={e} className="text-2xl font-bold leading-none" style={{ color: meta.fg }}>
                  {resumen?.[e] ?? 0}
                </div>
                <div className="mt-1 text-sm font-semibold" style={{ color: meta.fg }}>{meta.etiqueta}</div>
                <div className="mt-0.5 text-xs" style={{ color: meta.fg, opacity: 0.85 }}>{meta.descripcion}</div>
              </div>
            );
          })}
        </div>

        {hayEnCurso && (
          <div className="flex items-center gap-2 text-xs text-gray-600">
            <Clock size={14} />
            El turno en curso se calcula en vivo: su estado todavía puede cambiar.
          </div>
        )}

        {/* Titulares que no entraron — el entregable que se pidió por nombre, con su propio lugar */}
        <div className="rounded-xl border border-gray-200 bg-white">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
            <UserX size={16} className="text-red-600" />
            <h3 className="text-sm font-semibold text-gray-900">Titulares que no entraron</h3>
            <span className="text-xs text-gray-500">
              {totalAusencias === 0
                ? 'ninguna ausencia en el rango'
                : `${ausentes.length} persona${ausentes.length === 1 ? '' : 's'} · ${totalAusencias} turno${totalAusencias === 1 ? '' : 's'}`}
            </span>
          </div>
          <div className="px-4 py-3">
            {ausentes.length === 0 ? (
              <p className="text-sm text-gray-400 italic">
                {filas.length === 0
                  ? 'Sin datos en este rango.'
                  : 'Todos los titulares del rango registraron en la bitácora.'}
              </p>
            ) : (
              <ul className="divide-y divide-gray-100" data-ausentes={ausentes.length}>
                {ausentes.map((p) => (
                  <li
                    key={p.usuario_id ?? p.nombre}
                    data-ausente={p.usuario_id ?? p.nombre}
                    className="py-2 flex flex-wrap items-baseline gap-x-3 gap-y-1"
                  >
                    <span className="text-sm font-semibold text-gray-900">{p.nombre}</span>
                    <span className="text-xs font-semibold text-red-700">
                      {p.turnos.length} turno{p.turnos.length === 1 ? '' : 's'}
                    </span>
                    <span className="text-xs text-gray-600">
                      {p.turnos.map((t) => `${fmtFecha(t.fecha_operativa)} T${t.turno} · ${t.cargo_nombre}`).join(' — ')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Tabla: ancha, scrollea dentro de su contenedor; la página no scrollea en horizontal */}
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
              <tr>
                <th className="px-3 py-2 text-left">Fecha op.</th>
                <th className="px-3 py-2 text-left">Turno</th>
                <th className="px-3 py-2 text-left">Rol</th>
                <th className="px-3 py-2 text-right">Grupo</th>
                <th className="px-3 py-2 text-left">Estado</th>
                <th className="px-3 py-2 text-left">Titulares del patrón</th>
                <th className="px-3 py-2 text-left">Relevo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filas.length === 0 && !cargando && !error && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-gray-400 italic">
                    {listo
                      ? 'Sin datos en este rango.'
                      : 'Escoge una unidad y un rango de fechas para consultar el cumplimiento.'}
                  </td>
                </tr>
              )}
              {filas.map((f) => (
                <tr
                  key={`${f.fecha_operativa}|${f.turno}|${f.cargo_id}`}
                  data-congelado={f.congelado === false ? '0' : '1'}
                  className={f.congelado === false ? 'bg-indigo-50' : undefined}
                >
                  <td className="px-3 py-2 font-medium text-gray-900 whitespace-nowrap">{fmtFecha(f.fecha_operativa)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    T{f.turno}
                    {f.congelado === false && (
                      <span
                        className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-100 text-indigo-800"
                        title="Turno en curso: el estado todavía puede cambiar."
                      >
                        <Clock size={11} /> En curso
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-700">{f.cargo_nombre}</td>
                  <td className="px-3 py-2 text-right text-gray-700">{f.grupo ?? '—'}</td>
                  <td className="px-3 py-2"><ChipEstado estado={f.estado} /></td>
                  <td className="px-3 py-2">
                    {(f.titulares ?? []).length === 0 ? (
                      <span className="text-gray-400 italic">Sin titulares asignados</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {f.titulares.map((t) => (
                          <span
                            key={t.usuario_id ?? t.nombre}
                            data-entro={t.entro ? '1' : '0'}
                            title={t.entro ? 'Registró en la bitácora' : 'No registró en la bitácora'}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs whitespace-nowrap ${
                              t.entro ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800 font-semibold'
                            }`}
                          >
                            {t.entro ? <Check size={12} /> : <X size={12} />}
                            {nombreDe(t)}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-700">
                    {f.relevo ? (
                      <span className="inline-flex items-center gap-1 whitespace-nowrap" data-relevo="1">
                        <Shuffle size={13} className="text-blue-700" />
                        {nombreDe(f.relevo)}
                      </span>
                    ) : <span className="text-gray-400">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
