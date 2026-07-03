import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarRange, ChevronDown, Check } from 'lucide-react';

// Selector de AÑO custom (reemplaza el <select> nativo) con look de dashboard: trigger tipo pill
// + popover redondeado con sombra suave e ítems con highlight en el verde del tema DISP.
// Controlado: `value` (string), `options` [{value,label}], `onChange(value)`.
export default function YearDropdown({ value, options = [], onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const menuRef = useRef(null);

  const selected = options.find((o) => o.value === value);

  const cerrar = useCallback(() => setOpen(false), []);

  // Cerrar al click fuera o Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) cerrar();
    };
    const onKey = (e) => { if (e.key === 'Escape') cerrar(); };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, cerrar]);

  // Al abrir, llevar el ítem activo a la vista (útil con 15 años en la lista).
  useEffect(() => {
    if (!open || !menuRef.current) return;
    const activo = menuRef.current.querySelector('.yeardd-item.active');
    if (activo) activo.scrollIntoView({ block: 'nearest' });
  }, [open]);

  const elegir = (v) => { onChange?.(v); cerrar(); };

  return (
    <div className={`yeardd${open ? ' open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="yeardd-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Filtrar el dashboard por año"
      >
        <CalendarRange className="yeardd-cal" />
        <span className="yeardd-label">{selected?.label ?? '—'}</span>
        <ChevronDown className="yeardd-caret" />
      </button>

      {open && (
        <div className="yeardd-menu" role="listbox" ref={menuRef} aria-label="Año">
          {options.map((o) => {
            const activo = o.value === value;
            return (
              <React.Fragment key={o.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={activo}
                  className={`yeardd-item${activo ? ' active' : ''}`}
                  onClick={() => elegir(o.value)}
                >
                  <span>{o.label}</span>
                  {activo && <Check className="yeardd-check" />}
                </button>
                {o.sep && <div className="yeardd-sep" role="separator" />}
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
