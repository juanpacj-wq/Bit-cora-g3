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
    <div className="comb-fecha">
      <button
        type="button"
        onClick={() => irDia(-1)}
        disabled={disabled}
        aria-label="Día anterior"
        className="comb-fecha-nav"
      >
        <ChevronLeft size={16} />
      </button>
      <div className="comb-fecha-box">
        <CalendarDays size={15} />
        <input
          type="date"
          value={fecha}
          max={today}
          onChange={onInputChange}
          disabled={disabled}
        />
      </div>
      <button
        type="button"
        onClick={() => irDia(1)}
        disabled={disabled || fecha >= today}
        aria-label="Día siguiente"
        className="comb-fecha-nav"
      >
        <ChevronRight size={16} />
      </button>
      {fecha !== today && (
        <button
          type="button"
          onClick={() => onChange(today)}
          disabled={disabled}
          className="comb-fecha-hoy"
        >
          Hoy
        </button>
      )}
    </div>
  );
}
