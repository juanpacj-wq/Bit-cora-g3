import React from 'react';
import { NEUTRAL } from './colores';

// F13.1: skeleton mostrado solo en la PRIMERA carga de cada planta. Las re-visitas
// muestran el cache (SWR) y refrescan en background sin parpadear.
export default function DashboardSkeleton({ filas = 6 }) {
  return (
    <div className="flex flex-col gap-4 animate-pulse">
      <div
        className="rounded-xl shadow-sm border bg-white overflow-hidden"
        style={{ borderColor: NEUTRAL.hairline }}
      >
        <div className="px-6 py-4 flex items-center gap-4 bg-gray-100">
          <div className="w-12 h-12 rounded-xl bg-gray-200" />
          <div className="flex-1 space-y-2">
            <div className="h-5 w-40 bg-gray-200 rounded" />
            <div className="h-3 w-24 bg-gray-200 rounded" />
          </div>
          <div className="hidden md:flex gap-2 items-center">
            <div className="h-7 w-28 bg-gray-200 rounded-lg" />
            <div className="h-9 w-32 bg-gray-200 rounded-lg" />
            <div className="h-9 w-20 bg-gray-200 rounded-lg" />
            <div className="h-9 w-24 bg-gray-200 rounded-lg" />
          </div>
        </div>
        <div className="px-6 py-4 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <div className="h-2.5 w-20 bg-gray-200 rounded" />
              <div className="h-4 w-32 bg-gray-200 rounded" />
            </div>
          ))}
        </div>
      </div>

      <div
        className="rounded-xl shadow-sm border bg-white flex flex-col flex-1 min-h-0 overflow-hidden"
        style={{ borderColor: NEUTRAL.hairline }}
      >
        <div className="px-6 py-3 flex items-center justify-between bg-gray-100">
          <div className="h-4 w-40 bg-gray-200 rounded" />
          <div className="h-3 w-24 bg-gray-200 rounded" />
        </div>
        <div className="px-6 py-3 space-y-2.5">
          {Array.from({ length: filas }).map((_, i) => (
            <div key={i} className="flex gap-4 items-center">
              <div className="h-3 w-44 bg-gray-200 rounded" />
              <div className="h-5 w-20 bg-gray-200 rounded-full" />
              <div className="h-3 w-32 bg-gray-200 rounded" />
              <div className="h-3 flex-1 bg-gray-200 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
