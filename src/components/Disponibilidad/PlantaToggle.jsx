import React from 'react';
import { BRAND, NEUTRAL, PLANTAS } from './colores';

// F13.2: el toggle vive dentro del card del estado actual o del empty state
// (no en el chrome del dashboard). variant 'overlay' = chip translúcido sobre
// header colored; 'light' = chip neutro sobre fondo blanco.
export default function PlantaToggle({ plantaSeleccionada, onChangePlanta, variant = 'light' }) {
  const isOverlay = variant === 'overlay';
  return (
    <div
      className="inline-flex p-1 rounded-lg border"
      style={{
        borderColor: isOverlay ? 'rgba(255,255,255,0.4)' : NEUTRAL.hairline,
        backgroundColor: isOverlay ? 'rgba(255,255,255,0.15)' : NEUTRAL.surface,
      }}
    >
      {PLANTAS.map((p) => {
        const active = p === plantaSeleccionada;
        return (
          <button
            key={p}
            onClick={() => onChangePlanta(p)}
            className="px-3 py-1 rounded-md text-xs font-semibold transition-colors"
            style={{
              backgroundColor: active
                ? (isOverlay ? '#fff' : BRAND.navy)
                : 'transparent',
              color: active
                ? (isOverlay ? NEUTRAL.fgInk : '#fff')
                : (isOverlay ? '#fff' : NEUTRAL.fgInk),
            }}
          >
            {p}
          </button>
        );
      })}
    </div>
  );
}
