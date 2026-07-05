// D-047: hook del botón "Mejorar con IA". El backend es el único que habla con Gemini;
// acá solo viaja { texto, bitacora_codigo } autenticado por la cookie de sesión (useApi).
import { useState, useCallback } from 'react';
import { api } from './useApi';

export const MAX_TEXTO_IA = 2000; // espejo del tope del backend (fuente autoritativa: server)

export function useMejorarTexto() {
  const [mejorando, setMejorando] = useState(false);

  const mejorar = useCallback(async (texto, bitacoraCodigo) => {
    setMejorando(true);
    try {
      const r = await api.post('/api/ia/mejorar-texto', { texto, bitacora_codigo: bitacoraCodigo });
      return r.texto_corregido;
    } finally {
      setMejorando(false);
    }
  }, []);

  return { mejorar, mejorando };
}
