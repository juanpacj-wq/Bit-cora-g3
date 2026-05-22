# Prompt 03 — Frontend grilla de Consumos (D-027)

**Working directory:** `Bit-cora-g3/`
**Plan global:** `prompts/D-027-combustibles-consumos/00-README.md`
**Pre-requisitos:** prompts 01 (schema) y 02 (endpoints) ya corridos.

## Tu tarea

Crear los archivos frontend para la pantalla de Consumos:

1. `src/hooks/useCombustibles.js` (nuevo) — hook con `getCatalogo`, `getConsumos`, `guardarBatch`.
2. `src/components/Combustibles/SelectorFecha.jsx` (nuevo) — input de fecha con default hoy, max=hoy, navegación día anterior/siguiente.
3. `src/components/Combustibles/ConsumosGrid.jsx` (nuevo) — grilla 24 periodos × N combustibles + Total Carbón calculado live.

NO modificar `BitacorasGecelca3.jsx` ni rutas — esa integración va en el prompt 04.

## Referencia

`src/components/SalaDeMando/SalaDeMandoGrid.jsx` es el patrón más cercano. Léelo entero (≈476 LoC) para entender:
- Buffer vs snapshot, diff
- Reuso del `useEffect` para refresh
- `beforeunload` confirm cuando hay cambios pendientes
- Cómo dispara `bitacora:counts-refresh`
- Manejo de inputs numéricos con parsing

**No refactorices `SalaDeMandoGrid` en un componente compartido.** Copialo conceptualmente, no abstraigás aún (premature abstraction). Si las dos pantallas necesitan algo común después, sale el refactor.

## (1) `src/hooks/useCombustibles.js`

```js
import { useState, useCallback } from 'react';
import { apiFetch } from './useApi.js';   // ya existe en el repo

export function useCombustibles({ plantaId }) {
  const [catalogo, setCatalogo] = useState([]);
  const [celdas, setCeldas] = useState({});   // { "<periodo>": { "<combustible_id>": { consumo_id, cantidad, detalle, ... } } }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fecha, setFecha] = useState(getTodayBogota()); // YYYY-MM-DD

  const cargar = useCallback(async (fechaArg = fecha) => {
    if (!plantaId) return;
    setLoading(true); setError(null);
    try {
      const res = await apiFetch(`/api/combustibles/consumos?planta_id=${plantaId}&fecha=${fechaArg}`);
      setCatalogo(res.catalogo || []);
      setCeldas(res.celdas || {});
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [plantaId, fecha]);

  const guardarBatch = useCallback(async (celdasArray) => {
    const res = await apiFetch(`/api/combustibles/consumos`, {
      method: 'POST',
      body: JSON.stringify({
        planta_id: plantaId,
        fecha,
        celdas: celdasArray,
      }),
    });
    // Refetch tras guardar
    await cargar(fecha);
    return res;
  }, [plantaId, fecha, cargar]);

  return { catalogo, celdas, loading, error, fecha, setFecha, cargar, guardarBatch };
}

// Helper local (o importar de src/utils/fecha.js si ya está)
function getTodayBogota() {
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Bogota' });
  return fmt.format(new Date()); // 'YYYY-MM-DD'
}
```

(Mirá `src/hooks/useSalaDeMando.js` y `src/utils/fecha.js` — reusá los helpers existentes y `apiFetch` en lugar de inventar.)

## (2) `src/components/Combustibles/SelectorFecha.jsx`

```jsx
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';

const TODAY = () => {
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Bogota' });
  return fmt.format(new Date());
};

export function SelectorFecha({ fecha, onChange, disabled }) {
  const today = TODAY();
  const irDia = (delta) => {
    const d = new Date(fecha + 'T12:00:00'); // mediodía evita DST/timezone edge cases (Colombia no tiene DST igual)
    d.setDate(d.getDate() + delta);
    const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Bogota' });
    const nueva = fmt.format(d);
    if (nueva > today) return; // no permitir futuro
    onChange(nueva);
  };

  return (
    <div className="flex items-center gap-2">
      <button onClick={() => irDia(-1)} disabled={disabled} aria-label="Día anterior"
        className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-50">
        <ChevronLeft size={18} />
      </button>
      <div className="flex items-center gap-1.5 px-3 py-1.5 border rounded-md bg-white">
        <CalendarDays size={16} className="text-gray-500" />
        <input
          type="date"
          value={fecha}
          max={today}
          onChange={(e) => { if (e.target.value <= today) onChange(e.target.value); }}
          disabled={disabled}
          className="outline-none text-sm bg-transparent"
        />
      </div>
      <button onClick={() => irDia(1)} disabled={disabled || fecha >= today} aria-label="Día siguiente"
        className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-50">
        <ChevronRight size={18} />
      </button>
      {fecha !== today && (
        <button onClick={() => onChange(today)} disabled={disabled}
          className="text-sm text-blue-600 hover:underline ml-2">
          Hoy
        </button>
      )}
    </div>
  );
}
```

## (3) `src/components/Combustibles/ConsumosGrid.jsx`

```jsx
import { useEffect, useMemo, useState, useRef } from 'react';
import { useCombustibles } from '../../hooks/useCombustibles.js';
import { SelectorFecha } from './SelectorFecha.jsx';

const PERIODOS = Array.from({ length: 24 }, (_, i) => i + 1);

export function ConsumosGrid({ bitacora, plantaId, puedeCrear, showToast }) {
  const { catalogo, celdas, loading, error, fecha, setFecha, cargar, guardarBatch } =
    useCombustibles({ plantaId });

  // buffer = matriz pivot editable; snapshot = última versión del server
  const [buffer, setBuffer] = useState({});
  const [snapshot, setSnapshot] = useState({});

  // Refetch al cambiar fecha o plantaId
  useEffect(() => { if (plantaId) cargar(fecha); }, [plantaId, fecha]);

  // Cuando el server responde, reset buffer
  useEffect(() => {
    setSnapshot(celdas);
    setBuffer(deepClone(celdas));
  }, [celdas]);

  const hayCambios = useMemo(() => !equalCeldas(buffer, snapshot), [buffer, snapshot]);

  // beforeunload guard
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
      if (!next[p]) next[p] = {};
      else next[p] = { ...next[p] };
      if (cantidad === null || cantidad === 0 || Number.isNaN(cantidad)) {
        delete next[p][k];
        if (Object.keys(next[p]).length === 0) delete next[p];
      } else {
        next[p][k] = { ...(next[p][k] || {}), cantidad };
      }
      return next;
    });
  };

  // Total Carbón por periodo (suma de tipo='ALIMENTADOR')
  const totalCarbonPeriodo = (periodo) => {
    const p = String(periodo);
    const fila = buffer[p] || {};
    let total = 0;
    for (const cb of catalogo) {
      if (cb.tipo !== 'ALIMENTADOR') continue;
      const v = fila[String(cb.combustible_id)]?.cantidad;
      if (typeof v === 'number') total += v;
    }
    return total;
  };

  const diff = () => {
    // Calcula array { periodo, combustible_id, cantidad, detalle } por celda que difiere snapshot vs buffer
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
          out.push({ periodo: Number(p), combustible_id: Number(cid), cantidad: b.cantidad, detalle: b.detalle });
        } else if (b && s && (b.cantidad !== s.cantidad || (b.detalle ?? null) !== (s.detalle ?? null))) {
          out.push({ periodo: Number(p), combustible_id: Number(cid), cantidad: b.cantidad, detalle: b.detalle });
        }
      }
    }
    return out;
  };

  const onGuardar = async () => {
    try {
      const celdasDiff = diff();
      if (celdasDiff.length === 0) { showToast?.('Sin cambios', 'info'); return; }
      const resp = await guardarBatch(celdasDiff);
      showToast?.(`Guardado: ${resp.resumen.creados} nuevos, ${resp.resumen.actualizados} actualizados, ${resp.resumen.eliminados} eliminados`, 'success');
    } catch (e) {
      if (e.body?.errores) {
        showToast?.(`Errores: ${e.body.errores.map(x => x.motivo).join(', ')}`, 'error');
      } else {
        showToast?.('Error al guardar: ' + (e.message || 'desconocido'), 'error');
      }
    }
  };

  // Reordenar catálogo: alimentadores primero, luego Total Carbón (virtual), luego Caliza, luego ACPM
  const columnasOrdenadas = useMemo(() => {
    const alim = catalogo.filter(c => c.tipo === 'ALIMENTADOR');
    const caliza = catalogo.filter(c => c.tipo === 'CALIZA');
    const acpm = catalogo.filter(c => c.tipo === 'ACPM');
    return [...alim, { combustible_id: 'TOTAL', nombre: 'Total Carbón', unidad: 'Ton', tipo: 'TOTAL', virtual: true }, ...caliza, ...acpm];
  }, [catalogo]);

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <SelectorFecha fecha={fecha} onChange={setFecha} disabled={loading} />
        <button
          onClick={onGuardar}
          disabled={!hayCambios || !puedeCrear || loading}
          className="px-4 py-2 rounded-md bg-emerald-600 text-white disabled:opacity-40 disabled:cursor-not-allowed">
          Guardar
        </button>
      </div>

      {loading && <div className="text-sm text-gray-500">Cargando...</div>}
      {error && <div className="text-sm text-red-600">Error: {error.message || 'desconocido'}</div>}

      <div className="overflow-auto border rounded-md">
        <table className="text-sm">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              <th className="px-3 py-2 text-left">Periodo</th>
              {columnasOrdenadas.map(c => (
                <th key={String(c.combustible_id)} className={`px-3 py-2 text-center ${c.virtual ? 'bg-yellow-50' : ''}`}>
                  <div>{c.nombre}</div>
                  <div className="text-xs text-gray-500">[{c.unidad}]</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERIODOS.map(p => (
              <tr key={p} className="border-t hover:bg-gray-50">
                <td className="px-3 py-1.5 font-medium">{`P${p}`} <span className="text-xs text-gray-500">({String(p - 1).padStart(2, '0')}h)</span></td>
                {columnasOrdenadas.map(c => {
                  if (c.virtual) {
                    const t = totalCarbonPeriodo(p);
                    return (
                      <td key="TOTAL" className="px-2 py-1 text-right bg-yellow-50 font-mono">
                        {t.toFixed(3)}
                      </td>
                    );
                  }
                  const v = buffer[String(p)]?.[String(c.combustible_id)]?.cantidad ?? '';
                  return (
                    <td key={c.combustible_id} className="px-1 py-1">
                      <input
                        type="number" step="0.001" min="0"
                        value={v}
                        disabled={!puedeCrear}
                        onChange={(e) => {
                          const n = e.target.value === '' ? null : parseFloat(e.target.value);
                          setCelda(p, c.combustible_id, n);
                        }}
                        className="w-20 px-1 py-0.5 text-right border rounded text-sm focus:ring-1 focus:ring-blue-400 disabled:bg-gray-100 disabled:text-gray-500"
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Helpers locales
function deepClone(x) { return JSON.parse(JSON.stringify(x)); }
function equalCeldas(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
```

## Importante (gotchas)

1. **No reuses `SalaDeMandoGrid` directamente** — la lógica de multi-select Excel-like, lock por periodo, manejo de detalle/funcionariocnd no aplica acá. Patrón paralelo, no compartido.
2. **Total Carbón es solo Display** — nunca entra al `buffer` ni al `diff()`. Se calcula al render.
3. **Inputs vacíos** = `null` en el buffer; cuando se hace `diff()`, eso se traduce a `cantidad: null` que el backend interpreta como DELETE.
4. **`parseFloat` en español puede devolver NaN** si el operador escribe coma decimal. El `<input type=number>` ya valida pero comprobar con `Number.isNaN`.
5. **El componente no maneja paginación entre días** — solo cambia `fecha` y refetchea. Cualquier cambio sin guardar se preservaría en buffer, pero al cambiar fecha, el `useEffect` lo descarta. Eso es OK porque el `beforeunload` ya advierte; aún así, podés agregar un confirm extra antes de cambiar fecha si hay `hayCambios`.
6. **Permisos**: `puedeCrear` deshabilita inputs Y el botón. El handler backend ya devolverá 403 si se intenta saltar el guard.

## Verificación

```powershell
# Build check
cd Bit-cora-g3
npm run build   # debe compilar sin errores TypeScript/eslint relevantes

# Smoke manual (después del prompt 04 que integra el sidebar)
npm run dev
# Login como Operador Carbón y Caliza GEC3
# Navegar a la pestaña Combustibles → Consumos (cuando esté integrada)
# Verificar: grilla 24 filas × 9 columnas (6 alim + TOTAL + caliza + ACPM)
# Llenar periodo 1 con 12.5, 8.3, 5.0 en los primeros 3 alimentadores
# Verificar Total Carbón = 25.800 actualizado en vivo
# Guardar → toast de éxito
# Cambiar fecha al día anterior → grilla muestra datos previos (si los hay) o vacía
# Cambiar a fecha futura: el input no permite (max=today)
```

## Lo que NO hagas en este prompt

- NO toques `src/BitacorasGecelca3.jsx` (prompt 04).
- NO toques backend (ya hechos en prompts 01–02).
- NO escribas tests (prompt 05; los tests son backend solamente).
- NO escribas docs (prompt 06).
- NO agregues multi-select Excel-like, drag-to-fill, Enter-replica, ni lock por periodo. Eso es deuda futura si llega.
