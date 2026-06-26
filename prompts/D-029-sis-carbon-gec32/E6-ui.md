# E6 — UI grilla: badge override + tooltip + revertir + auto-refresco

## CONTEXTO ACUMULADO (no borrar)
- Lee `_CONTEXTO-BASE.md` y `ESTADO.md`. Etapas previas requeridas: E0–E5 ✅.
- Front: `src/components/Combustibles/ConsumosGrid.jsx` + `src/hooks/useCombustibles.js`.
- El GET ahora trae por celda: `cantidad`, `valor_sis`, `sis_actualizado_en`, `creado_por`,
  `modificado_por`, `modificado_en`. Periodos se muestran `P{p} ({p-1}h)`.
- Endpoint nuevo: `POST /api/combustibles/consumos/revertir`.

## Objetivo
Mostrar cuándo una celda ALIM de GEC32 tiene override manual frente al SIS, explicar quién editó,
y permitir revertir al valor SIS. Mantener celdas editables. Auto-refrescar viendo hoy.

## Tareas
1. `src/hooks/useCombustibles.js`: agregar `revertirCelda({ planta_id, fecha, periodo, combustible_id })`
   → `POST /api/combustibles/consumos/revertir`.
2. `src/components/Combustibles/ConsumosGrid.jsx`:
   - Propagar `valor_sis`/`sis_actualizado_en`/`modificado_por`/`creado_por` desde el snapshot a las celdas.
   - **Indicador de override**: una celda ALIM se considera "override manual" si tiene `valor_sis != null`
     y `cantidad !== valor_sis` y es humano-owned (modificado_por es un humano, o creado_por != SISTEMA).
     Mostrar un badge/borde/punto de color (usar paleta existente; algo discreto, p. ej. ámbar).
   - **Tooltip/popover** al hover/click del badge: "Editado por `<modificado_por?.nombre_completo ||
     creado_por?.nombre_completo>` el `<fecha Bogotá de modificado_en/creado_en>`. Valor SIS:
     `<valor_sis>` Ton." + botón **Revertir**.
   - **Revertir**: llama `revertirCelda(...)`, luego `refetch()`, y `showToast('Revertido al valor SIS')`.
     Manejar error con toast.
   - Mantener las celdas **editables** (no read-only). El cálculo "Total Carbón" sigue igual.
   - Solo aplica el indicador a combustibles tipo `ALIMENTADOR` de **GEC32** (los que el SIS alimenta).
3. **Auto-refresco**: si `plantaId === 'GEC32'` y `fecha === getTodayBogota()`, montar un
   `setInterval(refetch, 5*60*1000)` y un listener `window.addEventListener('focus', refetch)`;
   limpiarlos en el cleanup del `useEffect` y cuando cambien planta/fecha. **No** auto-refrescar si
   hay cambios sin guardar en el `buffer` (evitar pisar edición en curso) — o avisar/mergear con cuidado.

## Prueba
- `npm run lint` y `npm run build` sin errores.
- Verificación visual (skill `/run` o `/verify`, o `npm run dev` frontend + backend):
  - Abrir COMB → GEC32 → hoy: celdas ALIM pobladas por el SIS, sin badge.
  - Editar una celda ALIM a un valor distinto, guardar: aparece el badge; tooltip muestra el editor
    y el valor SIS; **Revertir** la regresa al valor SIS y el badge desaparece.
  - Dejar la pestaña en hoy y comprobar que un nuevo scrape se refleja tras el intervalo/focus.

## Al terminar
Actualiza `ESTADO.md`: E6 ✅, archivos (`ConsumosGrid.jsx`, `useCombustibles.js`), capturas/notas de
la verificación visual, y la decisión tomada sobre auto-refresco vs. buffer con cambios sin guardar.
