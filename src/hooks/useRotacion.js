import { useCallback, useState } from 'react';
import { api } from './useApi';
import { withBase } from '../config/paths';

// D-065 L07 · hook de la superficie A (configuración anual de la rotación). Habla con los
// endpoints de `server/routes/rotacion.js` y no decide nada: la política vive en el backend
// (el gate real es `puede_configurar_rotacion`, CA-8) y el vocabulario de errores es el `codigo`
// que llega en el cuerpo (D-032 / convención 16) — acá nunca se ramifica por el texto.
//
// Tres estados y no más:
//   · `cargando`  — hay una lectura en vuelo (catálogo, patrones o asignaciones).
//   · `guardando` — hay una escritura en vuelo (patrón, asignaciones o sincronización).
//   · `error`     — el ÚLTIMO Error que lanzó `useApi`, con su `.codigo` y su `.body` intactos.
//     Se guarda el Error, no su `message`: el componente necesita el `codigo` para elegir el
//     texto, y quedarse solo con el mensaje obligaría a adivinar por el string.
//
// Cero polling y cero `localStorage`/`sessionStorage` (CA-23): esta pantalla se abre una vez al
// año, lee cuando se lo piden y no deja nada corriendo detrás.

// Igual que en useApi: `fetch` rechaza con un TypeError crudo cuando no hay ruta al backend.
const MSG_SIN_CONEXION = 'No se pudo contactar al servidor. Verifica tu conexión a la red corporativa e intenta de nuevo.';

// PATCH no existe en `src/hooks/useApi.js` (solo GET/POST/PUT/DELETE) y ese archivo NO es
// territorio de este lote, así que la llamada de "desactivar patrón" (contrato de L12,
// GATE-O2 §6.6) se arma acá con las MISMAS reglas: `credentials:'include'` para la cookie
// httpOnly de sesión, `withBase` para el sub-path de despliegue y un Error con `.status`,
// `.codigo` y `.body` para que el consumidor ramifique por el slug.
//
// Diferencia conocida y anotada en el cierre: no dispara el `unauthorizedHandler` global de
// `useApi` (es privado del módulo), así que un 401 acá no cierra la sesión sola — se ve como un
// error normal en la pantalla. Se resuelve en cuanto `useApi` exponga `api.patch`.
async function patchJSON(url, body) {
  let res;
  try {
    res = await fetch(withBase(url), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
  } catch {
    const err = new Error(MSG_SIN_CONEXION);
    err.codigo = 'sin_conexion';
    err.status = 0;
    err.body = { error: MSG_SIN_CONEXION, codigo: 'sin_conexion', mensaje: MSG_SIN_CONEXION };
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || data.mensaje || `Error ${res.status}`);
    err.status = res.status;
    err.codigo = data.codigo;
    err.body = data;
    throw err;
  }
  return data;
}

export function useRotacion() {
  const [cargando, setCargando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState(null);

  const limpiarError = useCallback(() => setError(null), []);

  // Envoltorio único de las lecturas y de las escrituras: marca el estado, guarda el Error y lo
  // vuelve a lanzar. Quien llama decide qué mostrar; el hook no traduce nada a texto.
  const correr = useCallback(async (marcar, fn) => {
    marcar(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      marcar(false);
    }
  }, []);

  // Catálogo de cargos: la pantalla necesita la lista completa para elegir el rol del patrón y
  // el de cada persona. Data-driven desde `lov_bit.cargo` — nunca una lista de nombres en el
  // front (convención 12).
  const getCargos = useCallback(
    () => correr(setCargando, async () => (await api.get('/api/catalogos/cargos')).cargos || []),
    [correr],
  );

  const getPatrones = useCallback(
    (cargo_id = null) => correr(setCargando, async () => {
      const qs = cargo_id == null ? '' : `?cargo_id=${encodeURIComponent(cargo_id)}`;
      return (await api.get(`/api/rotacion/patrones${qs}`)).patrones || [];
    }),
    [correr],
  );

  // `patron` = { cargo_id, fecha_inicio, fecha_fin, vector_t1, vector_t2, grupo_t1, grupo_t2 }.
  // `desfase` y `ancla` NO se mandan nunca: los deriva el backend con lo que digitó el
  // administrador (requerimiento §4; el router los ignora aunque lleguen).
  const crearPatron = useCallback(
    (patron) => correr(setGuardando, async () => (await api.post('/api/rotacion/patrones', patron)).patron),
    [correr],
  );

  // Contrato que entrega L12 en esta misma ola (GATE-O2 §6.6): PATCH con { activo: false }.
  // Es el único camino para corregir un patrón cargado con error.
  const desactivarPatron = useCallback(
    (rotacion_patron_id) => correr(
      setGuardando,
      async () => (await patchJSON(`/api/rotacion/patrones/${encodeURIComponent(rotacion_patron_id)}`, { activo: false })).patron,
    ),
    [correr],
  );

  // Devuelve el cuerpo completo: `asignaciones` (las vigentes en la fecha) y `personas` (la
  // nómina asignable, GATE-O2 §6.3). La pantalla arma su buffer con `personas`.
  const getAsignaciones = useCallback(
    ({ cargo_id = null, fecha = null } = {}) => correr(setCargando, async () => {
      const qs = new URLSearchParams();
      if (cargo_id != null) qs.set('cargo_id', String(cargo_id));
      if (fecha) qs.set('fecha', fecha);
      const cola = qs.toString();
      return await api.get(`/api/rotacion/asignaciones${cola ? `?${cola}` : ''}`);
    }),
    [correr],
  );

  // Un solo POST con todo el lote: es atómico del lado del server y el 4xx trae el `indice` del
  // elemento que falló (GATE-O2 §6.4).
  const guardarAsignaciones = useCallback(
    (asignaciones) => correr(setGuardando, () => api.post('/api/rotacion/asignaciones', { asignaciones })),
    [correr],
  );

  // Sin cuerpo. Devuelve { creados, actualizados, total, por_rol }. Puede responder 200 con menos
  // gente de la esperada (GATE-O2 §6.12): la pantalla muestra lo que llegó, nunca un número
  // prometido de antemano.
  const sincronizarEntra = useCallback(
    () => correr(setGuardando, () => api.post('/api/rotacion/sincronizar-entra', {})),
    [correr],
  );

  return {
    cargando,
    guardando,
    error,
    limpiarError,
    getCargos,
    getPatrones,
    crearPatron,
    desactivarPatron,
    getAsignaciones,
    guardarAsignaciones,
    sincronizarEntra,
  };
}
