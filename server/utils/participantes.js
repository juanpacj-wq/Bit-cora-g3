// D-050: derivación de "participantes" para la vista de históricos.
// Los snapshots (ingenieros/jdts/jefes) son INMUTABLES (BIT-RF §6.5): esta regla vive en
// presentación — nunca reescribe el histórico — y por eso corrige también registros viejos.
// `ingenieros_snapshot` captura en realidad a todos los presentes salvo JdT/Gerente; acá se
// resta además a quien ya aparece en jdts_snapshot o jefes_snapshot (tienen columna propia),
// dejando: operadores + Ingeniero de Operación + Ingeniero Químico.

const parseSnapshot = (raw) => {
  if (!raw) return [];
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return []; }
  }
  return Array.isArray(parsed) ? parsed : [];
};

export function participantesVisibles({ ingenieros_snapshot, jdts_snapshot, jefes_snapshot } = {}) {
  // Comparación por String(usuario_id): snapshots históricos escritos por versiones viejas
  // podrían traer el id como string ("5") y otros como número — un Set.has estricto dejaría
  // la exclusión silenciosamente inerte para esas filas.
  const excluidos = new Set(
    [...parseSnapshot(jdts_snapshot), ...parseSnapshot(jefes_snapshot)]
      .filter((u) => u && u.usuario_id != null)
      .map((u) => String(u.usuario_id))
  );
  return parseSnapshot(ingenieros_snapshot).filter(
    (u) => u && u.usuario_id != null && !excluidos.has(String(u.usuario_id))
  );
}
