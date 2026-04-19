import { useState, useEffect, useCallback } from 'react';
import { api } from './useApi';

export function useCatalogos(cargoId, ready) {
  const [plantas, setPlantas] = useState([]);
  const [cargos, setCargos] = useState([]);
  const [bitacoras, setBitacoras] = useState([]);
  const [permisos, setPermisos] = useState([]);
  const [jefe, setJefe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!ready) return;
    let cancel = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const [p, c, b, j] = await Promise.all([
          api.get('/api/catalogos/plantas'),
          api.get('/api/catalogos/cargos'),
          api.get('/api/catalogos/bitacoras'),
          api.get('/api/catalogos/jefe').catch(() => ({ jefe: null })),
        ]);
        if (cancel) return;
        setPlantas(p.plantas || []);
        setCargos(c.cargos || []);
        setBitacoras(b.bitacoras || []);
        setJefe(j.jefe || null);
      } catch (e) {
        if (!cancel) setError(e.message);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [ready]);

  useEffect(() => {
    if (!cargoId) { setPermisos([]); return; }
    let cancel = false;
    (async () => {
      try {
        const { permisos: p } = await api.get(`/api/catalogos/permisos/${cargoId}`);
        if (!cancel) setPermisos(p || []);
      } catch (e) {
        if (!cancel) setError(e.message);
      }
    })();
    return () => { cancel = true; };
  }, [cargoId]);

  const getTiposEvento = useCallback(async (bitacoraId) => {
    const { tipos_evento } = await api.get(`/api/catalogos/bitacoras/${bitacoraId}/tipos-evento`);
    return tipos_evento || [];
  }, []);

  const getJdtActual = useCallback(async (plantaId) => {
    const { jdt } = await api.get(`/api/catalogos/jdt-actual?planta_id=${encodeURIComponent(plantaId)}`);
    return jdt;
  }, []);

  return { plantas, cargos, bitacoras, permisos, jefe, loading, error, getTiposEvento, getJdtActual };
}
