import { useCallback, useState } from 'react';
import { api } from './useApi';
import { withBase } from '../config/paths';

// Hook de Operación 24h (MAND). D-056: la grilla dejó de ser un espejo persistente y pasó a ser un
// formulario de captura append-only, así que el pivote `GET /api/sala-de-mando` (que devolvía "un
// valor por celda") desapareció junto con `getGrilla`. Quedan el batch de captura y el listado del
// día agrupado por lote; D-057 le suma al listado la CORRECCIÓN y el BORRADO, siempre por lote
// (nunca por celda suelta: la unidad de sentido es la llamada al CND).
export function useSalaDeMando() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // `fecha` es opcional: el backend usa hoy Bogotá por defecto.
  const getLotes = useCallback(async (planta_id, fecha) => {
    const qs = new URLSearchParams({ planta_id });
    if (fecha) qs.set('fecha', fecha);
    return await api.get(`/api/sala-de-mando/lotes?${qs}`);
  }, []);

  const guardarBatch = useCallback(async ({ planta_id, fecha, filas }) => {
    setLoading(true); setError(null);
    try {
      const r = await api.post('/api/sala-de-mando/guardar', { planta_id, fecha, filas });
      // Aviso al consumidor de counts (useBitacoraCounts) que refresque inmediatamente.
      // Fallback redundante al broadcast WS — garantiza que el badge MAND se actualice
      // sin esperar al snapshot del WebSocket.
      window.dispatchEvent(new CustomEvent('bitacora:counts-refresh'));
      return r;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally { setLoading(false); }
  }, []);

  // D-057 — corrección por lote. El `tipo` NO viaja: es inmutable (decisión 11), y equivocarse de
  // tipo se arregla eliminando el lote y volviéndolo a registrar en la grilla.
  const editarLote = useCallback(async (lote_id, { planta_id, hora, detalle, funcionariocnd, periodos }) => {
    setLoading(true); setError(null);
    try {
      const r = await api.put(`/api/sala-de-mando/lotes/${encodeURIComponent(lote_id)}`, {
        planta_id, hora, detalle, funcionariocnd, periodos,
      });
      window.dispatchEvent(new CustomEvent('bitacora:counts-refresh'));
      return r;
    } catch (e) {
      // El error se propaga TAL CUAL: `e.errores` (el arreglo de validaciones del backend) y
      // `e.codigo` son lo que el modal necesita para pintar celda por celda. Envolverlo lo perdería.
      setError(e.message);
      throw e;
    } finally { setLoading(false); }
  }, []);

  // `planta_id` va por query string, no en el body: un DELETE no lleva body fiable (fetch lo permite,
  // pero proxies e intermediarios pueden descartarlo).
  const eliminarLote = useCallback(async (lote_id, planta_id) => {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams({ planta_id });
      const r = await api.del(`/api/sala-de-mando/lotes/${encodeURIComponent(lote_id)}?${qs}`);
      window.dispatchEvent(new CustomEvent('bitacora:counts-refresh'));
      return r;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally { setLoading(false); }
  }, []);

  // D-058 (REQ-06) — descarga del libro mensual F03.
  //
  // No pasa por `api.get`: ese lee la respuesta como JSON y acá vienen bytes. Lo que sí se replica es
  // su contrato de error (`codigo` estable + mensaje ya saneado por el backend, D-032) para que el
  // llamador ramifique igual que en el resto de la app, y su `credentials: 'include'` — el endpoint
  // vive tras `requireEntra`, así que abrir la URL en una pestaña nueva NO sirve: sin la cookie de
  // sesión responde 401 y el operador vería un JSON de error en vez de su archivo.
  const descargarReporteMensual = useCallback(async (mes) => {
    setLoading(true); setError(null);
    let res;
    try {
      res = await fetch(withBase(`/api/sala-de-mando/reporte-mensual?mes=${encodeURIComponent(mes)}`), {
        credentials: 'include',
      });
    } catch {
      setLoading(false);
      const err = new Error('No se pudo contactar al servidor. Verifica tu conexión a la red corporativa e intenta de nuevo.');
      err.codigo = 'sin_conexion';
      err.status = 0;
      setError(err.message);
      throw err;
    }
    try {
      if (!res.ok) {
        // El backend responde los errores en JSON aunque el camino feliz sea binario.
        const data = await res.json().catch(() => ({}));
        const err = new Error(data.error || data.mensaje || `Error ${res.status}`);
        err.status = res.status;
        err.codigo = data.codigo;
        err.body = data;
        setError(err.message);
        throw err;
      }
      const blob = await res.blob();
      // Click sintético sobre un object URL: es la única forma de que el navegador guarde un blob con
      // el nombre que queremos.
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = nombreDeContentDisposition(res.headers.get('Content-Disposition'))
        ?? `${mes.replace('-', '_')}_OPG3-F03 Estado G3 y eventos diarios de operación.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // **El `revoke` NO puede ir acá mismo.** `a.click()` solo AGENDA la descarga: el navegador lee
      // el blob después, ya fuera de este tick. Revocarlo en la misma vuelta del event loop es una
      // carrera — el archivo se guarda igual (con su nombre y un tamaño plausible) pero puede quedar
      // truncado o vacío, y el síntoma que ve el operador es "se descargó pero Excel no lo abre",
      // sin ningún error en pantalla ni en el servidor. Se difiere; el navegador libera la memoria
      // igual al cerrar la pestaña, así que el costo de esperar es cero.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return true;
    } finally {
      setLoading(false);
    }
  }, []);

  return { loading, error, getLotes, guardarBatch, editarLote, eliminarLote, descargarReporteMensual };
}

// El backend manda el nombre en las dos formas del `Content-Disposition`: `filename*` en UTF-8
// (RFC 5987, con la tilde de "operación") y un `filename` ASCII de respaldo. Se prefiere el primero;
// si no viniera, el llamador arma el nombre por su cuenta.
function nombreDeContentDisposition(cabecera) {
  if (!cabecera) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(cabecera);
  if (utf8) {
    try { return decodeURIComponent(utf8[1]); } catch { /* percent-encoding roto: cae al ASCII */ }
  }
  const ascii = /filename="([^"]+)"/i.exec(cabecera);
  return ascii ? ascii[1] : null;
}
