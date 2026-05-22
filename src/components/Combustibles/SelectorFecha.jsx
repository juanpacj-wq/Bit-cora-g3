import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';
import { getTodayBogota, shiftDate } from '../../utils/fecha';

// D-027: navegador de fecha para ConsumosGrid. Ventana = hoy o pasado en TZ Bogotá
// (el backend rechaza fecha futura con 400 `fecha_futura`). UI bloquea avanzar al
// futuro tanto en el flechero como en el input nativo (max=today).
export function SelectorFecha({ fecha, onChange, disabled }) {
  const today = getTodayBogota();

  const irDia = (delta) => {
    const nueva = shiftDate(fecha, delta);
    if (nueva > today) return; // bloquea futuro
    onChange(nueva);
  };

  const onInputChange = (e) => {
    const v = e.target.value;
    if (v && v <= today) onChange(v);
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => irDia(-1)}
        disabled={disabled}
        aria-label="Día anterior"
        className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-50"
      >
        <ChevronLeft size={18} />
      </button>
      <div className="flex items-center gap-1.5 px-3 py-1.5 border rounded-md bg-white">
        <CalendarDays size={16} className="text-gray-500" />
        <input
          type="date"
          value={fecha}
          max={today}
          onChange={onInputChange}
          disabled={disabled}
          className="outline-none text-sm bg-transparent"
        />
      </div>
      <button
        type="button"
        onClick={() => irDia(1)}
        disabled={disabled || fecha >= today}
        aria-label="Día siguiente"
        className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-50"
      >
        <ChevronRight size={18} />
      </button>
      {fecha !== today && (
        <button
          type="button"
          onClick={() => onChange(today)}
          disabled={disabled}
          className="text-sm text-blue-600 hover:underline ml-2"
        >
          Hoy
        </button>
      )}
    </div>
  );
}
