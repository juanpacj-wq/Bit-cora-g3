import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from './useApi';

// D-065 · L08 — Estado de la toma de control del rol (superficie B) para la unidad activa.
//
// Fuente de verdad: el BACKEND (contrato C5, `GET /api/rotacion/control/estado`). Cero
// `localStorage`/`sessionStorage`: el "no volver a preguntar en este turno" sale de `ya_respondi`,
// que el server deriva del log append-only `rotacion_control`. Guardarlo en el navegador es la
// clase de bug más cara del repo (D-040): el turno se ve de una forma en una pestaña y de otra en
// la BD, y además la persona puede entrar desde otro equipo.
//
// Cero polling y cero tareas recurrentes (CA-23): UNA consulta al montar. Lo único que vuelve a
// pedir el estado es un cambio de IDENTIDAD (la unidad) o una acción del usuario, y las tres
// acciones ya devuelven el mismo shape que `/estado`, así que ni siquiera necesitan un GET extra.
//
// Los tres POST van SIN cuerpo (el turno, la planta y el cargo salen de `req.sesion`). Un 409 se
// relanza tal cual —con su `codigo` estable, nunca su texto (D-032)— después de refrescar el
// estado: quien lo muestra es el popup, y la UI queda diciendo la verdad del server aunque el
// intento haya fallado.
export function useTomaControl(ready, plantaId) {
  const [estado, setEstado] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [accionando, setAccionando] = useState(false);
  const desmontadoRef = useRef(false);
  // D-054: unidad cuyo estado tenemos cargado. El cambio de unidad en caliente NO desmonta el
  // componente, así que la invalidación es por identidad, igual que en `useTurno`.
  const plantaCargadaRef = useRef(null);
  // CR3-2 · cada lectura o acción lleva su número y SOLO la última manda. `desmontadoRef` no
  // alcanzaba: el efecto lo resetea a `false` para la unidad nueva, así que el GET de la unidad
  // vieja aterrizaba después y pisaba el estado — el popup quedaba con el `turno_id` y el
  // `principal` de la otra planta y su `useEffect([turnoId])` lo volvía a abrir. Es el mismo
  // `secuenciaRef` de `useCumplimiento`: dos hooks del mismo módulo, una sola respuesta.
  const secuenciaRef = useRef(0);

  // El catch NO limpia el estado a propósito (mismo criterio que `useTurno`): un blip de red no es
  // motivo para borrar un estado válido de ESTA unidad. La invalidación correcta es por identidad.
  const refrescar = useCallback(async () => {
    const mio = ++secuenciaRef.current;
    try {
      const e = await api.get('/api/rotacion/control/estado');
      if (mio !== secuenciaRef.current || desmontadoRef.current) return null;
      setEstado(e);
      return e;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!ready || !plantaId) return undefined;
    desmontadoRef.current = false;
    // `vigente` es de ESTE efecto y muere con su cleanup: el `.finally` de la lectura vieja no
    // puede apagar el `cargando` de la nueva, que sigue en vuelo (la pantalla se veía cargada con
    // `estado` en null). El de la nueva lo apaga cuando le toque.
    let vigente = true;
    // Mientras viaja el GET de la unidad nueva, `null` ("sin dato") es la única respuesta honesta:
    // ofrecer la toma de control del rol de la unidad anterior se vería consistente y sería falso.
    if (plantaCargadaRef.current !== null && plantaCargadaRef.current !== plantaId) setEstado(null);
    plantaCargadaRef.current = plantaId;
    setCargando(true);
    refrescar().finally(() => { if (vigente && !desmontadoRef.current) setCargando(false); });
    return () => { vigente = false; desmontadoRef.current = true; };
  }, [ready, plantaId, refrescar]);

  const ejecutar = useCallback(async (verbo) => {
    // La acción también toma número: su respuesta es más nueva que cualquier GET en vuelo, y a su
    // vez queda obsoleta si entretanto se cambió de unidad.
    const mio = ++secuenciaRef.current;
    setAccionando(true);
    try {
      const e = await api.post(`/api/rotacion/control/${verbo}`);
      if (mio === secuenciaRef.current && !desmontadoRef.current) setEstado(e);
      return e;
    } catch (err) {
      // El server cambió bajo nuestros pies (otra toma en curso, el turno cerró): que la pantalla
      // se entere antes de que la persona lea el aviso.
      await refrescar();
      throw err;
    } finally {
      if (!desmontadoRef.current) setAccionando(false);
    }
  }, [refrescar]);

  const tomar = useCallback(() => ejecutar('tomar'), [ejecutar]);
  const abandonar = useCallback(() => ejecutar('abandonar'), [ejecutar]);
  const descartar = useCallback(() => ejecutar('descartar'), [ejecutar]);

  return { estado, cargando, accionando, tomar, abandonar, descartar, refrescar };
}
