// Fixture de test (AUD-08): worker que NUNCA responde, para verificar el timeout de parseXlsIsolated
// (el wrapper debe terminarlo y rechazar con sis_parse_timeout).
import 'node:worker_threads';
setInterval(() => {}, 1000); // mantiene vivo el worker sin postear → fuerza el timeout
