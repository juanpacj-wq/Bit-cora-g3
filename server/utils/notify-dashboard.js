// Webhook cross-repo: avisa al dashboard-gen-gec3 (:3001) que cambió `bitacora.evento_dashboard`
// para que refetchee al instante en vez de esperar su poll de 60s. Contrato en
// PORTAL GENERACIÓN/docs/interfaces-cross-repo.md (Contrato 3 — push eventos-changed).
//
// INVARIANTE: fire-and-forget. Este helper NUNCA lanza ni bloquea el request de guardar. Si el
// dashboard está caído, apagado o el env no está seteado, la escritura de bitácora igual
// responde 200 al operador. La señal es best-effort: el poll del dashboard es la red de seguridad.

const TIMEOUT_MS = 1500;

// Dispara el aviso. `plantas` es un array de planta_id afectadas; `fecha` es YYYY-MM-DD (Bogotá).
// Retorna una promesa que SIEMPRE resuelve (nunca rechaza) — igual conviene llamarla con
// `.catch(() => {})` por si acaso, siguiendo el patrón de broadcastConteoBitacoras.
export async function notifyDashboard({ plantas, fecha }) {
  const url = process.env.DASHBOARD_NOTIFY_URL;
  if (!url) return; // no-op: instancia sin dashboard local (p. ej. Guajira) o feature apagado.

  const headers = { 'Content-Type': 'application/json' };
  const token = process.env.DASHBOARD_NOTIFY_TOKEN;
  if (token) headers['X-Internal-Token'] = token;

  try {
    await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ plantas, fecha }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Warn, no throw: el dashboard puede estar reiniciando/caído. Su poll recupera el cambio.
    console.warn('[notify-dashboard] no se pudo avisar al dashboard:', err?.message ?? err);
  }
}
