import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Lock, RefreshCw, Users } from 'lucide-react';
import { useRotacion } from '../../hooks/useRotacion';
import { getTodayBogota } from '../../utils/fecha';

// D-065 L07 · Superficie A — configuración anual de la rotación de turnos.
//
// Se usa UNA vez al año, así que la claridad pesa más que la densidad: es lo contrario de la
// grilla de COMB, que se abre todos los días. Dos zonas y nada más:
//   1. El patrón por rol (arriba): qué grupo está de guardia cada día del ciclo.
//   2. Las personas por rol (abajo): en qué grupo va cada quien.
//
// Componente CONTROLADO en el sentido de C8: recibe `puedeConfigurar` y avisa por `onError`.
// NO lee ni escribe el hash — eso es territorio de L10 (`#/rotacion` no lleva subestado).
//
// Tres reglas que gobiernan todo el archivo:
//   · Los permisos vienen del backend. `puedeConfigurar` sale de `cargo.puede_configurar_rotacion`
//     (F37.A2), que ya viaja en la sesión; acá jamás se compara un nombre de cargo (convención 12).
//     El gate REAL es el 403 del router (CA-8): esto es la cortesía de UI.
//   · Los errores se ramifican por `codigo`, nunca por el texto (D-032 / convención 16).
//   · Al administrador jamás se le nombran "ancla" ni "desfase" (requerimiento §4): se le piden la
//     fecha de inicio y los grupos de guardia de ESE día, y el backend deriva lo demás.
//
// Buffer local + Guardar explícito, como COMB. Sin autosave, sin polling y sin storage del
// navegador (CA-23).

const GRUPOS = [1, 2, 3, 4];
const CLAVE_SIN_ROL = 'sin-rol';

// Los vectores reales de 2026 (contexto base §2.2). Son un ATAJO para no teclear 16 números por
// rol, no una verdad del sistema: quedan en los campos y el administrador los puede corregir.
const PRESETS = [
  { id: 'OPS', etiqueta: 'Operadores', t1: '1,1,3,3,4,4,2,2', t2: '4,2,2,1,1,3,3,4' },
  { id: 'ING', etiqueta: 'Ingenieros', t1: '1,1,2,2,4,4,3,3', t2: '4,3,3,1,1,2,2,4' },
];

// `codigo` estable del backend → qué hacer, en español. Nunca se muestra el slug crudo, y la
// traducción de `desfase_ambiguo`/`desfase_imposible` no menciona el vocabulario interno: le dice
// al administrador qué revisar.
const MENSAJE_ERROR = {
  rotacion_no_autorizado: 'Tu cargo no puede configurar la rotación de turnos.',
  desfase_ambiguo: 'Esa combinación de grupos no corresponde a este patrón. Revisa los grupos de T1 y T2 del día de inicio.',
  desfase_imposible: 'Esa combinación de grupos no corresponde a este patrón. Revisa los grupos de T1 y T2 del día de inicio.',
  vector_invalido: 'Cada turno necesita exactamente 8 grupos, entre 1 y 4.',
  grupo_invalido: 'El grupo debe ser un número entre 1 y 4.',
  rango_invalido: 'La fecha de fin debe ser posterior a la de inicio.',
  vigencia_invalida: 'La vigencia no puede terminar antes de empezar.',
  fecha_invalida: 'Revisa las fechas: deben existir en el calendario.',
  cargo_invalido: 'El rol indicado ya no existe. Recarga la pantalla.',
  usuario_invalido: 'Esa persona no tiene cuenta de Entra: solo se asigna a quien puede iniciar sesión.',
  patron_duplicado: 'Ya hay un patrón para ese rol que empieza ese mismo día. Desactívalo antes de cargar el corregido.',
  patron_solapado: 'Ya hay un patrón activo para ese rol que cubre parte de ese periodo.',
  patron_no_encontrado: 'Ese patrón ya no existe. Recarga la pantalla.',
  asignacion_conflicto: 'Esa persona ya tiene una asignación que empieza después de la fecha indicada. Corrige primero esa asignación.',
  lote_vacio: 'No hay cambios para guardar.',
  lote_excesivo: 'Son demasiadas personas para una sola solicitud. Guarda por partes.',
  entra_no_disponible: 'No se pudo consultar el directorio de Entra. Intenta más tarde: el resto de la pantalla sigue disponible.',
  sin_conexion: 'No se pudo contactar al servidor. Verifica tu conexión a la red corporativa.',
  db_no_disponible: 'La base de datos no está disponible en este momento. Intenta de nuevo en unos minutos.',
  db_timeout: 'La consulta tardó demasiado. Intenta de nuevo.',
};

function codigoDe(e) {
  return e?.codigo ?? e?.body?.codigo ?? null;
}

// El texto sale del `codigo`; si el backend manda uno que esta pantalla no conoce todavía, se usa
// el mensaje YA saneado que viene en el cuerpo (D-032) y nunca el slug pelado.
function textoError(e) {
  const codigo = codigoDe(e);
  if (codigo && MENSAJE_ERROR[codigo]) return MENSAJE_ERROR[codigo];
  return e?.body?.mensaje || e?.message || 'Ocurrió un error inesperado.';
}

// '1,1,3,3,4,4,2,2' → [1,1,3,3,4,4,2,2]; cualquier otra cosa → null. Es la MISMA regla del motor
// (8 enteros en 1..4), replicada acá solo para no mandar al server un formulario obviamente malo.
// La validación que manda sigue siendo la suya.
export function parsearVectorTexto(texto) {
  const partes = String(texto ?? '').split(',').map((s) => s.trim());
  if (partes.length !== 8) return null;
  const nums = partes.map((s) => (/^[1-4]$/.test(s) ? Number(s) : NaN));
  return nums.some((n) => Number.isNaN(n)) ? null : nums;
}

// Un patrón cuyo vector no parsea llega con `vector_invalido: true` y los DOS vectores en su forma
// CRUDA (string): el `catch` de `mapPatron` no reasigna ninguno, así que el sano también llega como
// texto. Esa fila la manda el backend A PROPÓSITO (CR2-8) para que el administrador pueda ENCONTRAR
// la mala; asumir que siempre es un arreglo cambiaba un 500 —que al menos queda en el log— por una
// pantalla en blanco (CR3-1).
function textoVector(v, sep = ', ') {
  if (Array.isArray(v)) return v.join(sep);
  const crudo = String(v ?? '').trim();
  return crudo || '—';
}

const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

// Estado "efectivo" de una persona a efectos del diff. Sin grupo NO hay asignación: el rol solo
// se persiste acompañado de un grupo, así que "sin grupo" colapsa a (null, null) de los dos lados
// y elegir un rol sin elegir grupo no ensucia la pantalla.
function normalizar(cargo_id, grupo) {
  return grupo == null
    ? { cargo_id: null, grupo: null }
    : { cargo_id: cargo_id == null ? null : Number(cargo_id), grupo: Number(grupo) };
}

function estadoServidor(persona) {
  return normalizar(persona.asignacion_cargo_id ?? null, persona.grupo ?? null);
}

// El cuerpo exacto del POST /asignaciones. Solo entra quien cambió, y cada elemento lleva SIEMPRE
// un `cargo_id` válido: el router lo valida aunque el grupo sea null (la salida de la rotación
// cierra vigencias sin insertar nada, pero igual pide el rol).
export function calcularCambios(personas, buffer) {
  const cambios = [];
  for (const p of personas) {
    const b = buffer[String(p.usuario_id)] || { cargo_id: null, grupo: null };
    const antes = estadoServidor(p);
    const ahora = normalizar(b.cargo_id, b.grupo);
    if (antes.cargo_id === ahora.cargo_id && antes.grupo === ahora.grupo) continue;
    // Salida de la rotación: el rol que se manda es el de la asignación que se va a cerrar.
    const cargo_id = ahora.grupo == null
      ? (p.asignacion_cargo_id ?? b.cargo_id ?? p.ultimo_cargo_id ?? null)
      : ahora.cargo_id;
    if (cargo_id == null) continue; // sin rol no hay nada que mandar; la pantalla ya lo señala
    cambios.push({ usuario_id: p.usuario_id, cargo_id: Number(cargo_id), grupo: ahora.grupo });
  }
  return cambios;
}

// Buffer inicial: lo que el server tiene, y para quien todavía no tiene asignación, el cargo con
// el que entró la última vez. Tras la primera sincronización real ese cargo es `null` para casi
// todo el mundo (GATE-O2 §6.3), y por eso cada persona lleva su propio selector de rol.
function bufferDesde(personas) {
  const b = {};
  for (const p of personas) {
    b[String(p.usuario_id)] = {
      cargo_id: p.asignacion_cargo_id ?? p.ultimo_cargo_id ?? null,
      grupo: p.grupo ?? null,
    };
  }
  return b;
}

// Presentación en Bogotá explícita (D-020). `fecha_inicio`/`fecha_fin` son fechas lógicas sin
// hora: se formatean en UTC para que el offset no las corra un día.
const fmtFecha = (iso) => (iso
  ? new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' })
    .format(new Date(`${iso}T00:00:00Z`))
  : '—');

export default function ConfiguracionRotacion({ puedeConfigurar = false, onError }) {
  const {
    cargando, guardando, error,
    getCargos, getPatrones, crearPatron, desactivarPatron,
    getAsignaciones, guardarAsignaciones, sincronizarEntra,
  } = useRotacion();

  const [cargos, setCargos] = useState([]);
  const [patrones, setPatrones] = useState([]);
  const [personas, setPersonas] = useState([]);
  const [buffer, setBuffer] = useState({});
  // La MISMA fecha gobierna la lectura (`?fecha=`) y la escritura (`vigente_desde`): una pantalla
  // que muestre el estado del 1 de enero y escriba con fecha de hoy le miente al administrador.
  const [fecha, setFecha] = useState(getTodayBogota);
  const [aviso, setAviso] = useState(null);           // { tono, texto }
  const [avisoEntra, setAvisoEntra] = useState(null); // no bloqueante: la pantalla sigue usable
  const [resumenSync, setResumenSync] = useState(null);

  const [form, setForm] = useState({
    cargo_id: '', fecha_inicio: '', fecha_fin: '',
    vector_t1: '', vector_t2: '', grupo_t1: '', grupo_t2: '',
  });

  // `onError` va por un ref, no por la lista de dependencias: el raíz (L10) lo va a pasar como
  // una lambda inline, así que meterlo en las deps de `reportar` haría que `reportar` cambiara en
  // cada render del padre, y con él el efecto de carga → GET en bucle. Mismo criterio que
  // `showToastRef` en ConsumosGrid.
  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  const reportar = useCallback((e) => {
    setAviso({ tono: 'error', texto: textoError(e) });
    onErrorRef.current?.(codigoDe(e));
  }, []);

  const cargarPersonas = useCallback(async (dia) => {
    const r = await getAsignaciones({ fecha: dia });
    const lista = r.personas || [];
    setPersonas(lista);
    setBuffer(bufferDesde(lista));
  }, [getAsignaciones]);

  const cargarPatrones = useCallback(async () => {
    setPatrones(await getPatrones());
  }, [getPatrones]);

  // Catálogo de cargos y patrones: no dependen de la fecha de vigencia, así que se leen una vez.
  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const [cs, ps] = await Promise.all([getCargos(), getPatrones()]);
        if (cancelado) return;
        setCargos(cs);
        setPatrones(ps);
      } catch (e) {
        if (!cancelado) reportar(e);
      }
    })();
    return () => { cancelado = true; };
  }, [getCargos, getPatrones, reportar]);

  // Las personas SÍ dependen de la fecha: el buffer se rehace desde el server con cada cambio, así
  // que lo que se ve y lo que se edita describen siempre la misma fecha. La respuesta de una
  // lectura que quedó atrás (se movió la fecha mientras viajaba) se descarta en vez de pisar la
  // nueva — la trampa es la misma que COMB documentó en su refetch.
  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const r = await getAsignaciones({ fecha });
        if (cancelado) return;
        const lista = r.personas || [];
        setPersonas(lista);
        setBuffer(bufferDesde(lista));
      } catch (e) {
        if (!cancelado) reportar(e);
      }
    })();
    return () => { cancelado = true; };
  }, [fecha, getAsignaciones, reportar]);

  const nombrePorCargo = useMemo(() => {
    const m = new Map();
    for (const c of cargos) m.set(Number(c.cargo_id), c.nombre);
    return m;
  }, [cargos]);

  const cambios = useMemo(() => calcularCambios(personas, buffer), [personas, buffer]);
  const hayCambios = cambios.length > 0;

  // De una fila dañada NO se puede copiar: su vector no parsea, y copiarlo propagaría el daño al
  // patrón nuevo. Listarla sí (es justamente para lo que el backend la manda); ofrecerla como
  // origen, no.
  const patronesCopiables = useMemo(() => patrones.filter((p) => !p.vector_invalido), [patrones]);
  const patronesDanados = useMemo(() => patrones.filter((p) => p.vector_invalido), [patrones]);

  // `omitidas` normalizada: números, nunca `undefined`. Un backend anterior a L12 no la manda, y
  // ausente significa "no hubo omisiones que reportar", igual que en `sincronizarDirectorio`.
  // `personas_estimadas` es una COTA (se estima por la mediana de los grupos que sí se leyeron):
  // por eso el copy dice "aproximadamente" y nunca promete un número exacto.
  const omitidasSync = useMemo(() => {
    const o = resumenSync?.omitidas ?? {};
    const grupos = Number(o.grupos) || 0;
    const usuarios = Number(o.usuarios) || 0;
    const partes = [];
    if (grupos > 0) partes.push(plural(grupos, 'grupo', 'grupos'));
    if (usuarios > 0) partes.push(plural(usuarios, 'usuario', 'usuarios'));
    return {
      total: Number(o.total) || 0,
      personas: Number(o.personas_estimadas) || 0,
      detalle: partes.join(' y '),
    };
  }, [resumenSync]);

  // Una persona con grupo pero sin rol no se puede guardar (el router pide `cargo_id`): se cuenta
  // acá y se bloquea Guardar, en vez de mandar el lote y recibir un 400 con un índice.
  const sinRol = useMemo(
    () => personas.filter((p) => {
      const b = buffer[String(p.usuario_id)];
      return b && b.grupo != null && b.cargo_id == null;
    }),
    [personas, buffer],
  );

  // El agrupamiento por rol es lo que hace legible la pantalla (CA-19): el rol de cada quien es el
  // que está en el buffer, así que cambiarle el rol a alguien lo mueve de tarjeta en el acto.
  const rolesConPersonas = useMemo(() => {
    const porRol = new Map();
    for (const p of personas) {
      const b = buffer[String(p.usuario_id)] || { cargo_id: null, grupo: null };
      const clave = b.cargo_id == null ? CLAVE_SIN_ROL : String(b.cargo_id);
      if (!porRol.has(clave)) {
        porRol.set(clave, {
          clave,
          cargo_id: b.cargo_id ?? null,
          nombre: b.cargo_id == null
            ? 'Sin rol asignado'
            : (nombrePorCargo.get(Number(b.cargo_id)) || `Rol ${b.cargo_id}`),
          personas: [],
          conteo: { 1: 0, 2: 0, 3: 0, 4: 0, sin: 0 },
        });
      }
      const rol = porRol.get(clave);
      rol.personas.push(p);
      if (b.grupo == null) rol.conteo.sin += 1;
      else rol.conteo[b.grupo] += 1;
    }
    const lista = [...porRol.values()];
    lista.sort((a, z) => {
      if (a.clave === CLAVE_SIN_ROL) return 1;
      if (z.clave === CLAVE_SIN_ROL) return -1;
      return a.nombre.localeCompare(z.nombre, 'es-CO');
    });
    for (const rol of lista) {
      rol.personas.sort((a, z) => String(a.nombre).localeCompare(String(z.nombre), 'es-CO'));
    }
    return lista;
  }, [personas, buffer, nombrePorCargo]);

  const setCampo = (usuario_id, parche) => {
    setBuffer((b) => {
      const k = String(usuario_id);
      return { ...b, [k]: { ...(b[k] || { cargo_id: null, grupo: null }), ...parche } };
    });
  };

  const descartar = () => {
    setBuffer(bufferDesde(personas));
    setAviso(null);
  };

  const onGuardar = async () => {
    if (!hayCambios || sinRol.length > 0) return;
    try {
      // Un solo POST con todo el lote: es atómico del lado del server.
      const r = await guardarAsignaciones(cambios.map((c) => ({ ...c, vigente_desde: fecha })));
      await cargarPersonas(fecha);
      setAviso({
        tono: 'ok',
        texto: `Guardado: ${r.creadas ?? 0} nuevas, ${r.actualizadas ?? 0} corregidas, `
          + `${r.cerradas ?? 0} cerradas, ${r.sin_cambio ?? 0} sin cambio.`,
      });
    } catch (e) {
      // El 409 de conflicto trae el `usuario_id`: nombrar a la persona ahorra buscarla a mano.
      const quien = personas.find((p) => p.usuario_id === e?.body?.usuario_id);
      setAviso({
        tono: 'error',
        texto: quien ? `${quien.nombre}: ${textoError(e)}` : textoError(e),
      });
      onErrorRef.current?.(codigoDe(e));
    }
  };

  const onSincronizar = async () => {
    setAvisoEntra(null);
    try {
      const r = await sincronizarEntra();
      // Se muestra lo que DEVOLVIÓ la respuesta, nunca un número prometido de antemano: la
      // sincronización tolera fallos por grupo y puede responder 200 con menos gente
      // (GATE-O2 §6.12). El conteo por rol a la vista es lo que deja notar que falta alguien.
      setResumenSync(r);
      await cargarPersonas(fecha);
      setAviso({ tono: 'ok', texto: `Directorio actualizado: ${r.total ?? 0} personas.` });
    } catch (e) {
      // 503 `entra_no_disponible` es un aviso NO bloqueante: el resto de la pantalla sigue usable.
      if (codigoDe(e) === 'entra_no_disponible') setAvisoEntra(textoError(e));
      else setAviso({ tono: 'error', texto: textoError(e) });
      onErrorRef.current?.(codigoDe(e));
    }
  };

  const vectorT1 = parsearVectorTexto(form.vector_t1);
  const vectorT2 = parsearVectorTexto(form.vector_t2);
  const patronCompleto = Boolean(
    form.cargo_id && form.fecha_inicio && form.fecha_fin
    && vectorT1 && vectorT2 && form.grupo_t1 && form.grupo_t2,
  );

  const onCrearPatron = async (ev) => {
    ev.preventDefault();
    if (!patronCompleto) return;
    try {
      await crearPatron({
        cargo_id: Number(form.cargo_id),
        fecha_inicio: form.fecha_inicio,
        fecha_fin: form.fecha_fin,
        vector_t1: vectorT1,
        vector_t2: vectorT2,
        grupo_t1: Number(form.grupo_t1),
        grupo_t2: Number(form.grupo_t2),
      });
      await cargarPatrones();
      setAviso({ tono: 'ok', texto: 'Patrón cargado.' });
    } catch (e) {
      reportar(e);
    }
  };

  const onDesactivar = async (rotacion_patron_id) => {
    try {
      await desactivarPatron(rotacion_patron_id);
      await cargarPatrones();
      setAviso({ tono: 'ok', texto: 'Patrón desactivado. Ya puedes cargar el corregido con la misma fecha de inicio.' });
    } catch (e) {
      reportar(e);
    }
  };

  const bloqueado = !puedeConfigurar;
  const ocupado = cargando || guardando;

  return (
    <div className="rot-root flex-1 flex flex-col overflow-hidden bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex flex-wrap items-end gap-4">
        <div className="mr-auto">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <Users size={18} className="text-blue-700" />
            Rotación de turnos · Configuración anual
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Carga el patrón de cada rol y reparte a las personas en los grupos G1 a G4.
          </p>
        </div>

        <label className="flex flex-col gap-1 text-xs font-medium text-gray-500">
          Vigente desde
          <input
            type="date" value={fecha} disabled={ocupado}
            onChange={(ev) => setFecha(ev.target.value || getTodayBogota())}
            className="rot-fecha px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-900"
          />
        </label>

        {puedeConfigurar ? (
          <>
            <button
              type="button" onClick={onSincronizar}
              disabled={ocupado || hayCambios}
              title={hayCambios
                ? 'Guarda o descarta los cambios antes de actualizar desde Entra.'
                : 'Vuelve a leer el directorio de Entra'}
              className="rot-sync flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-blue-700 border border-blue-200 bg-blue-50 hover:bg-blue-100 disabled:opacity-60 transition-colors"
            >
              <RefreshCw size={15} className={guardando ? 'animate-spin' : ''} />
              Actualizar desde Entra
            </button>
            {hayCambios && (
              <button
                type="button" onClick={descartar} disabled={guardando}
                className="rot-descartar px-4 py-2 rounded-lg text-sm font-semibold text-gray-600 border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-60"
              >
                Descartar
              </button>
            )}
            <button
              type="button" onClick={onGuardar}
              disabled={!hayCambios || ocupado || sinRol.length > 0}
              className="rot-guardar flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 transition-colors"
            >
              <Check size={15} />
              Guardar
              {hayCambios && <span className="rot-sucio">({cambios.length})</span>}
            </button>
          </>
        ) : (
          <span
            className="rot-readonly flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold text-gray-500 bg-gray-100 border border-gray-200"
            title="Tu cargo no puede configurar la rotación de turnos"
          >
            <Lock size={14} />
            Solo lectura
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
        {aviso && (
          <div className={`rot-aviso rounded-lg px-4 py-3 text-sm border ${
            aviso.tono === 'ok'
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-red-50 border-red-200 text-red-800'}`}
          >
            {aviso.texto}
          </div>
        )}
        {avisoEntra && (
          <div className="rot-aviso-entra rounded-lg px-4 py-3 text-sm border bg-amber-50 border-amber-200 text-amber-900 flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>{avisoEntra}</span>
          </div>
        )}
        {sinRol.length > 0 && (
          <div className="rot-aviso-sinrol rounded-lg px-4 py-3 text-sm border bg-amber-50 border-amber-200 text-amber-900">
            {sinRol.length === 1
              ? 'Hay 1 persona con grupo pero sin rol. Asígnale un rol para poder guardar.'
              : `Hay ${sinRol.length} personas con grupo pero sin rol. Asígnales un rol para poder guardar.`}
          </div>
        )}
        {error && !aviso && !avisoEntra && (
          <div className="rot-aviso rounded-lg px-4 py-3 text-sm border bg-red-50 border-red-200 text-red-800">
            {textoError(error)}
          </div>
        )}

        {/* ── Zona 1 · el patrón de cada rol ───────────────────────────────────────────────── */}
        <section className="rot-patrones bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900">Patrón de guardia por rol</h3>
          <p className="text-xs text-gray-500 mt-1 mb-4">
            El ciclo dura 8 días y se repite. Indica qué grupo estuvo de guardia en el turno 1 y en
            el turno 2 del día de inicio: con eso el sistema calcula el resto del año.
          </p>

          <form className="rot-patron-form grid gap-4 md:grid-cols-4" onSubmit={onCrearPatron}>
            <label className="flex flex-col gap-1 text-xs font-medium text-gray-500 md:col-span-2">
              Rol
              <select
                value={form.cargo_id} disabled={bloqueado || ocupado}
                onChange={(ev) => setForm((f) => ({ ...f, cargo_id: ev.target.value }))}
                className="rot-patron-cargo px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-900 bg-white"
              >
                <option value="">Elige un rol…</option>
                {cargos.map((c) => (
                  <option key={c.cargo_id} value={c.cargo_id}>{c.nombre}</option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs font-medium text-gray-500">
              Empieza el
              <input
                type="date" value={form.fecha_inicio} disabled={bloqueado || ocupado}
                onChange={(ev) => setForm((f) => ({ ...f, fecha_inicio: ev.target.value }))}
                className="rot-patron-inicio px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-900"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-gray-500">
              Termina el
              <input
                type="date" value={form.fecha_fin} disabled={bloqueado || ocupado}
                min={form.fecha_inicio || undefined}
                onChange={(ev) => setForm((f) => ({ ...f, fecha_fin: ev.target.value }))}
                className="rot-patron-fin px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-900"
              />
            </label>

            <label className="flex flex-col gap-1 text-xs font-medium text-gray-500 md:col-span-2">
              Grupos del turno 1 (06:00–18:00), día por día del ciclo
              <input
                type="text" value={form.vector_t1} disabled={bloqueado || ocupado}
                placeholder="1,1,3,3,4,4,2,2" inputMode="numeric"
                onChange={(ev) => setForm((f) => ({ ...f, vector_t1: ev.target.value }))}
                className={`rot-patron-v1 px-3 py-2 rounded-lg border text-sm text-gray-900 font-mono ${
                  form.vector_t1 && !vectorT1 ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-gray-500 md:col-span-2">
              Grupos del turno 2 (18:00–06:00), día por día del ciclo
              <input
                type="text" value={form.vector_t2} disabled={bloqueado || ocupado}
                placeholder="4,2,2,1,1,3,3,4" inputMode="numeric"
                onChange={(ev) => setForm((f) => ({ ...f, vector_t2: ev.target.value }))}
                className={`rot-patron-v2 px-3 py-2 rounded-lg border text-sm text-gray-900 font-mono ${
                  form.vector_t2 && !vectorT2 ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}
              />
            </label>

            <label className="flex flex-col gap-1 text-xs font-medium text-gray-500">
              Grupo de guardia en T1 el día de inicio
              <select
                value={form.grupo_t1} disabled={bloqueado || ocupado}
                onChange={(ev) => setForm((f) => ({ ...f, grupo_t1: ev.target.value }))}
                className="rot-patron-g1 px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-900 bg-white"
              >
                <option value="">Elige…</option>
                {GRUPOS.map((g) => <option key={g} value={g}>{`G${g}`}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-gray-500">
              Grupo de guardia en T2 el día de inicio
              <select
                value={form.grupo_t2} disabled={bloqueado || ocupado}
                onChange={(ev) => setForm((f) => ({ ...f, grupo_t2: ev.target.value }))}
                className="rot-patron-g2 px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-900 bg-white"
              >
                <option value="">Elige…</option>
                {GRUPOS.map((g) => <option key={g} value={g}>{`G${g}`}</option>)}
              </select>
            </label>

            <div className="md:col-span-2 flex flex-wrap items-end gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.id} type="button" disabled={bloqueado || ocupado}
                  onClick={() => setForm((f) => ({ ...f, vector_t1: p.t1, vector_t2: p.t2 }))}
                  className="rot-preset px-3 py-2 rounded-lg text-xs font-semibold text-gray-600 border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-60"
                >
                  Usar el patrón de {p.etiqueta}
                </button>
              ))}
              {patronesCopiables.length > 0 && (
                <label className="flex flex-col gap-1 text-xs font-medium text-gray-500">
                  Copiar de otro rol
                  <select
                    value="" disabled={bloqueado || ocupado}
                    onChange={(ev) => {
                      const origen = patronesCopiables.find((p) => String(p.rotacion_patron_id) === ev.target.value);
                      if (!origen || origen.vector_invalido) return;
                      // Solo los vectores: los grupos de guardia son del día de inicio de ESTE
                      // patrón, no del de origen, y copiarlos sería un error silencioso.
                      setForm((f) => ({
                        ...f,
                        vector_t1: textoVector(origen.vector_t1, ','),
                        vector_t2: textoVector(origen.vector_t2, ','),
                      }));
                    }}
                    className="rot-copiar px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-900 bg-white"
                  >
                    <option value="">Elige un patrón…</option>
                    {patronesCopiables.map((p) => (
                      <option key={p.rotacion_patron_id} value={p.rotacion_patron_id}>
                        {`${p.cargo_nombre} · desde ${fmtFecha(p.fecha_inicio)}`}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            <div className="md:col-span-2 flex items-end justify-end">
              <button
                type="submit" disabled={bloqueado || ocupado || !patronCompleto}
                className="rot-patron-crear px-4 py-2 rounded-lg text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 transition-colors"
              >
                Cargar patrón
              </button>
            </div>
          </form>

          {patrones.length === 0 ? (
            <p className="rot-patrones-vacio text-sm text-gray-500 mt-5">
              Todavía no hay patrones cargados.
            </p>
          ) : (
            <div className="mt-5 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-semibold text-gray-500 border-b border-gray-200">
                    <th className="py-2 pr-3">Rol</th>
                    <th className="py-2 pr-3">Vigencia</th>
                    <th className="py-2 pr-3">Turno 1</th>
                    <th className="py-2 pr-3">Turno 2</th>
                    <th className="py-2 pr-3">Estado</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {patrones.map((p) => (
                    <tr
                      key={p.rotacion_patron_id}
                      className={`rot-patron border-b border-gray-100 ${p.vector_invalido ? 'bg-amber-50' : ''}`}
                      data-patron={p.rotacion_patron_id}
                      data-invalido={p.vector_invalido ? '1' : undefined}
                    >
                      <td className="py-2 pr-3 text-gray-900">{p.cargo_nombre}</td>
                      <td className="py-2 pr-3 text-gray-600">{`${fmtFecha(p.fecha_inicio)} → ${fmtFecha(p.fecha_fin)}`}</td>
                      <td className="py-2 pr-3 font-mono text-xs text-gray-700">{textoVector(p.vector_t1)}</td>
                      <td className="py-2 pr-3 font-mono text-xs text-gray-700">{textoVector(p.vector_t2)}</td>
                      <td className="py-2 pr-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                          p.activo ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}
                        >
                          {p.activo ? 'Activo' : 'Desactivado'}
                        </span>
                        {p.vector_invalido && (
                          <span
                            className="rot-patron-danado ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-900"
                            title="El vector guardado no tiene la forma de ocho grupos 1..4 separados por coma"
                          >
                            <AlertTriangle size={11} />
                            Vector dañado
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-right">
                        {p.activo && puedeConfigurar && (
                          <button
                            type="button" disabled={ocupado}
                            onClick={() => onDesactivar(p.rotacion_patron_id)}
                            className="rot-patron-desactivar px-3 py-1 rounded-lg text-xs font-semibold text-gray-600 border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-60"
                          >
                            Desactivar
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Qué hacer con una fila dañada. Sin esto, "Vector dañado" nombra el problema y deja al
              administrador sin salida: el vector no se puede editar, así que el camino es
              desactivar y volver a cargar el patrón con la misma fecha de inicio (CR2-10). */}
          {patronesDanados.length > 0 && (
            <p className="rot-patrones-danados mt-4 rounded-lg px-4 py-3 text-sm border bg-amber-50 border-amber-200 text-amber-900 flex items-start gap-2">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>
                {patronesDanados.length === 1
                  ? 'Hay 1 patrón con el vector dañado (se muestra tal como está guardado). '
                  : `Hay ${patronesDanados.length} patrones con el vector dañado (se muestran tal como están guardados). `}
                Desactívalo y vuelve a cargar el patrón con la misma fecha de inicio; mientras esté
                activo, el sistema no puede calcular quién estaba de guardia para ese rol.
              </span>
            </p>
          )}
        </section>

        {/* ── Zona 2 · las personas de cada rol ────────────────────────────────────────────── */}
        <section className="rot-personas space-y-4">
          <div className="flex flex-wrap items-baseline gap-3">
            <h3 className="text-sm font-semibold text-gray-900">Personas por rol</h3>
            <span className="rot-total text-xs text-gray-500">
              {personas.length} {personas.length === 1 ? 'persona' : 'personas'} con cuenta de Entra
            </span>
          </div>

          {resumenSync && (
            <div className="rot-resumen-sync bg-white rounded-xl border border-gray-200 p-4 text-sm">
              <p className="text-gray-700">
                Última lectura del directorio: <strong>{resumenSync.total ?? 0}</strong> personas
                {' · '}{resumenSync.creados ?? 0} nuevas{' · '}{resumenSync.actualizados ?? 0} actualizadas.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {Object.entries(resumenSync.por_rol || {}).map(([rol, n]) => (
                  <span
                    key={rol}
                    className="rot-sync-rol px-2 py-0.5 rounded-full bg-gray-100 text-xs text-gray-700 font-mono"
                  >
                    {`${rol}: ${n}`}
                  </span>
                ))}
              </div>
              {/* CR3-4 · lo que el conteo por rol NO puede mostrar. Un grupo que no respondió
                  aporta CERO al `por_rol`, así que una sincronización a la que le faltan 14
                  personas se ve idéntica a una completa: no hay contra qué comparar. El backend
                  devuelve `omitidas` justo para poder decirlo (GATE-O3 §6.12). */}
              {omitidasSync.total > 0 ? (
                <p className="rot-sync-omitidas mt-3 rounded-lg px-3 py-2 text-sm border bg-amber-50 border-amber-200 text-amber-900 flex items-start gap-2">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  <span>
                    {`El directorio no respondió ${plural(omitidasSync.total, 'consulta', 'consultas')}`}
                    {omitidasSync.detalle ? ` (${omitidasSync.detalle})` : ''}
                    {`: faltan aproximadamente ${plural(omitidasSync.personas, 'persona', 'personas')}. `}
                    Vuelve a actualizar antes de repartir los grupos.
                  </span>
                </p>
              ) : (
                <p className="text-xs text-gray-500 mt-2">
                  El directorio respondió completo: ningún grupo ni usuario quedó sin leer.
                </p>
              )}
            </div>
          )}

          {rolesConPersonas.length === 0 && !cargando && (
            <p className="rot-personas-vacio text-sm text-gray-500">
              No hay personas con cuenta de Entra todavía. Usa “Actualizar desde Entra”.
            </p>
          )}

          {rolesConPersonas.map((rol) => (
            <div
              key={rol.clave}
              className="rot-rol bg-white rounded-xl border border-gray-200 overflow-hidden"
              data-rol={rol.clave}
            >
              <div className="px-5 py-3 border-b border-gray-100 flex flex-wrap items-center gap-3">
                <span className="rot-rol-nombre text-sm font-semibold text-gray-900">{rol.nombre}</span>
                <span className="rot-rol-total text-xs text-gray-500">
                  {rol.personas.length} {rol.personas.length === 1 ? 'persona' : 'personas'}
                </span>
                <span className="rot-rol-conteo ml-auto flex flex-wrap gap-1.5 text-xs">
                  {GRUPOS.map((g) => (
                    <span key={g} className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-800 font-semibold">
                      {`G${g}: ${rol.conteo[g]}`}
                    </span>
                  ))}
                  <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 font-semibold">
                    {`Sin grupo: ${rol.conteo.sin}`}
                  </span>
                </span>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {rol.personas.map((p) => {
                    const b = buffer[String(p.usuario_id)] || { cargo_id: null, grupo: null };
                    return (
                      <tr
                        key={p.usuario_id}
                        className="rot-persona border-b border-gray-50 last:border-0"
                        data-usuario={p.usuario_id}
                      >
                        <td className="px-5 py-2">
                          <div className="rot-persona-nombre text-gray-900">{p.nombre}</div>
                          <div className="text-xs text-gray-400">
                            {p.ultimo_cargo_nombre
                              ? `Último ingreso como ${p.ultimo_cargo_nombre}`
                              : 'Nunca ha iniciado sesión'}
                          </div>
                        </td>
                        <td className="px-3 py-2 w-72">
                          <select
                            value={b.cargo_id == null ? '' : String(b.cargo_id)}
                            disabled={bloqueado || ocupado}
                            onChange={(ev) => setCampo(p.usuario_id, {
                              cargo_id: ev.target.value === '' ? null : Number(ev.target.value),
                            })}
                            className="rot-select-cargo w-full px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-900 bg-white disabled:bg-gray-50"
                          >
                            <option value="">Sin rol</option>
                            {cargos.map((c) => (
                              <option key={c.cargo_id} value={c.cargo_id}>{c.nombre}</option>
                            ))}
                          </select>
                        </td>
                        <td className="px-5 py-2 w-36">
                          <select
                            value={b.grupo == null ? '' : String(b.grupo)}
                            disabled={bloqueado || ocupado}
                            onChange={(ev) => setCampo(p.usuario_id, {
                              grupo: ev.target.value === '' ? null : Number(ev.target.value),
                            })}
                            className="rot-select-grupo w-full px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-900 bg-white disabled:bg-gray-50"
                          >
                            <option value="">— Sin grupo</option>
                            {GRUPOS.map((g) => <option key={g} value={g}>{`G${g}`}</option>)}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
