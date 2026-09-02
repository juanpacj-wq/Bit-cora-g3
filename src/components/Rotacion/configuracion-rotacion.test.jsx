// @vitest-environment jsdom
//
// D-065 L07 (CA-19) — la pantalla de configuración anual sobre el componente REAL, con `fetch`
// stubeado con la forma exacta de los endpoints de L04 (`server/routes/rotacion.js`) y del PATCH
// que entrega L12 en esta misma ola (GATE-O2 §6.6).
//
// Lo que se prueba acá es cableado, que es lo único que un test puro no vería: que las personas
// salgan agrupadas por su rol, que cambiar un selector ensucie la pantalla, que Guardar mande UN
// solo POST con el cuerpo correcto, y que sin permiso quede todo deshabilitado. El resto del
// vocabulario (los `codigo` de error) se verifica por el texto que la pantalla muestra, nunca por
// el slug.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import ConfiguracionRotacion from './ConfiguracionRotacion.jsx';

// El día Bogotá se controla desde afuera: `vigente_desde` sale de él y, sin fijarlo, la aserción
// del cuerpo del POST dependería del reloj de quien corra la suite.
const reloj = vi.hoisted(() => ({ hoy: '2026-09-01' }));
vi.mock('../../utils/fecha', async (importarOriginal) => {
  const real = await importarOriginal();
  return { ...real, getTodayBogota: () => reloj.hoy };
});

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const HOY = '2026-09-01';

// ── Datos con la forma del contrato ─────────────────────────────────────────────────────────────

// `GET /api/catalogos/cargos` (shape real del router de catálogos).
function cargos() {
  return [
    { cargo_id: 1, nombre: 'Ingeniero Jefe de Turno', solo_lectura: 0, puede_cerrar_turno: 1 },
    { cargo_id: 2, nombre: 'Ingeniero de Operación', solo_lectura: 0, puede_cerrar_turno: 1 },
    { cargo_id: 3, nombre: 'Operador de Planta - Sala de Mando', solo_lectura: 0, puede_cerrar_turno: 0 },
  ];
}

// Una fila de `personas` (GATE-O2 §6.3): la nómina asignable, con el cargo de su última sesión y
// su asignación vigente en la fecha si la tiene.
function persona(extra = {}) {
  return {
    usuario_id: 0,
    nombre: '',
    ultimo_cargo_id: null,
    ultimo_cargo_nombre: null,
    rotacion_asignacion_id: null,
    asignacion_cargo_id: null,
    asignacion_cargo_nombre: null,
    grupo: null,
    vigente_desde: null,
    vigente_hasta: null,
    ...extra,
  };
}

// Directorio simulado: tres roles reconocidos + una persona que nunca ha iniciado sesión (que es
// el caso mayoritario tras la primera sincronización real, §6.3) y por eso llega sin rol.
function personas() {
  return [
    persona({
      usuario_id: 11,
      nombre: 'Ana Ríos',
      ultimo_cargo_id: 1,
      ultimo_cargo_nombre: 'Ingeniero Jefe de Turno',
      rotacion_asignacion_id: 501,
      asignacion_cargo_id: 1,
      asignacion_cargo_nombre: 'Ingeniero Jefe de Turno',
      grupo: 1,
      vigente_desde: '2026-02-01',
      vigente_hasta: '9999-12-31',
    }),
    persona({
      usuario_id: 12,
      nombre: 'Bruno Gil',
      ultimo_cargo_id: 1,
      ultimo_cargo_nombre: 'Ingeniero Jefe de Turno',
    }),
    persona({
      usuario_id: 21,
      nombre: 'Carla Mesa',
      ultimo_cargo_id: 2,
      ultimo_cargo_nombre: 'Ingeniero de Operación',
      rotacion_asignacion_id: 502,
      asignacion_cargo_id: 2,
      asignacion_cargo_nombre: 'Ingeniero de Operación',
      grupo: 3,
      vigente_desde: '2026-02-01',
      vigente_hasta: '9999-12-31',
    }),
    persona({
      usuario_id: 31,
      nombre: 'Diego Peña',
      ultimo_cargo_id: 3,
      ultimo_cargo_nombre: 'Operador de Planta - Sala de Mando',
    }),
    persona({ usuario_id: 41, nombre: 'Elsa Ruiz' }),
  ];
}

// `GET /api/rotacion/patrones` — los vectores salen del backend YA parseados a arreglos.
function patrones() {
  return [
    {
      rotacion_patron_id: 7,
      cargo_id: 1,
      cargo_nombre: 'Ingeniero Jefe de Turno',
      fecha_inicio: '2026-02-01',
      fecha_fin: '2026-12-31',
      vector_t1: [1, 1, 2, 2, 4, 4, 3, 3],
      vector_t2: [4, 3, 3, 1, 1, 2, 2, 4],
      desfase: 2,
      activo: true,
      creado_por: 3,
      creado_por_nombre: 'Ernesto Muñoz',
      creado_en: '2026-01-15T14:00:00.000Z',
      creado_en_bogota: '2026-01-15T09:00:00.000',
    },
  ];
}

// ── Stub de red ─────────────────────────────────────────────────────────────────────────────────

function respuesta(cuerpo, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => cuerpo, headers: new Headers() };
}

let llamadas;          // toda petición que salió, con su cuerpo ya parseado
let cuerpoPersonas;    // lo que devuelve GET /asignaciones
let cuerpoPatrones;    // lo que devuelve GET /patrones
let fallaSync;         // { cuerpo, status } con el que responde POST /sincronizar-entra
let fallaPostPatron;   // ídem para POST /patrones
let cuerpoSync;
let cuerpoGuardar;

beforeEach(() => {
  llamadas = [];
  fallaSync = null;
  fallaPostPatron = null;
  cuerpoPersonas = { fecha: HOY, cargo_id: null, asignaciones: [], personas: personas() };
  cuerpoPatrones = { patrones: patrones() };
  cuerpoSync = {
    creados: 4,
    actualizados: 17,
    total: 21,
    por_rol: { JEFE_DE_TURNO: 7, INGENIERO_OPERACION: 14 },
  };
  cuerpoGuardar = { creadas: 1, cerradas: 0, actualizadas: 0, sin_cambio: 0, total: 1 };

  globalThis.fetch = vi.fn(async (url, opciones) => {
    const u = String(url);
    const metodo = opciones?.method || 'GET';
    llamadas.push({ url: u, metodo, cuerpo: opciones?.body ? JSON.parse(opciones.body) : undefined });

    if (u.includes('/api/catalogos/cargos')) return respuesta({ cargos: cargos() });
    if (u.includes('/api/rotacion/sincronizar-entra')) {
      return fallaSync ? respuesta(fallaSync.cuerpo, fallaSync.status) : respuesta(cuerpoSync);
    }
    if (u.includes('/api/rotacion/asignaciones')) {
      return metodo === 'POST' ? respuesta(cuerpoGuardar) : respuesta(cuerpoPersonas);
    }
    if (u.includes('/api/rotacion/patrones')) {
      if (metodo === 'POST') {
        return fallaPostPatron
          ? respuesta(fallaPostPatron.cuerpo, fallaPostPatron.status)
          : respuesta({ patron: patrones()[0] });
      }
      if (metodo === 'PATCH') return respuesta({ patron: { ...patrones()[0], activo: false } });
      return respuesta(cuerpoPatrones);
    }
    return respuesta({});
  });
});

afterEach(() => {
  // Desmontar SIEMPRE, no solo en el camino feliz: un test que falla dejaría el árbol montado y
  // sus peticiones pendientes le contarían al siguiente (el mismo tropiezo que documentó COMB).
  for (const desmontar of montados.splice(0)) desmontar();
  vi.restoreAllMocks();
});

// ── Render ──────────────────────────────────────────────────────────────────────────────────────

const montados = [];
let codigosReportados;

async function render(props = {}) {
  codigosReportados = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const actuales = {
    puedeConfigurar: true,
    // Lambda inline a propósito: es como lo va a pasar el raíz (L10). Si el componente metiera
    // `onError` en las deps de su efecto de carga, esto lo dejaría releyendo en bucle.
    onError: (codigo) => codigosReportados.push(codigo),
    ...props,
  };
  await act(async () => { root.render(h(ConfiguracionRotacion, actuales)); });
  let desmontado = false;
  const teardown = () => {
    if (desmontado) return;
    desmontado = true;
    act(() => { root.unmount(); });
    container.remove();
  };
  montados.push(teardown);
  return { container, teardown };
}

// Elegir una opción como lo haría una persona (setter nativo + `change`, que es lo que React
// escucha en un <select>).
async function elegir(select, valor) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, valor);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function escribir(input, valor) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, valor);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(el) {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

// ── Lectores del DOM ────────────────────────────────────────────────────────────────────────────

const tarjetas = (c) => [...c.querySelectorAll('.rot-rol')];
const nombresDeRol = (c) => tarjetas(c).map((t) => t.querySelector('.rot-rol-nombre').textContent);
const personasDeRol = (t) => [...t.querySelectorAll('.rot-persona')]
  .map((f) => f.querySelector('.rot-persona-nombre').textContent);
const fila = (c, usuario_id) => c.querySelector(`.rot-persona[data-usuario="${usuario_id}"]`);
const selGrupo = (c, usuario_id) => fila(c, usuario_id).querySelector('.rot-select-grupo');
const selCargo = (c, usuario_id) => fila(c, usuario_id).querySelector('.rot-select-cargo');
const guardar = (c) => c.querySelector('.rot-guardar');
const conteos = (t) => [...t.querySelectorAll('.rot-rol-conteo span')].map((s) => s.textContent);

// El cuerpo del POST de asignaciones que salió de verdad. Es lo único que prueba que la pantalla
// manda lo que el operador cambió y NADA más.
function postsDeAsignaciones() {
  return llamadas.filter((l) => l.metodo === 'POST' && l.url.includes('/api/rotacion/asignaciones'));
}

// ── CA-19 · agrupamiento por rol ────────────────────────────────────────────────────────────────

describe('ConfiguracionRotacion · personas agrupadas por rol (CA-19)', () => {
  it('arma una tarjeta por rol, con su gente adentro y el conteo por grupo', async () => {
    const { container } = await render();

    // Tres roles del directorio + la tarjeta de quien todavía no tiene rol (que va de última).
    expect(nombresDeRol(container)).toEqual([
      'Ingeniero de Operación',
      'Ingeniero Jefe de Turno',
      'Operador de Planta - Sala de Mando',
      'Sin rol asignado',
    ]);

    const [ingOp, jdt, sdm, sinRol] = tarjetas(container);
    expect(personasDeRol(ingOp)).toEqual(['Carla Mesa']);
    expect(personasDeRol(jdt)).toEqual(['Ana Ríos', 'Bruno Gil']);
    expect(personasDeRol(sdm)).toEqual(['Diego Peña']);
    expect(personasDeRol(sinRol)).toEqual(['Elsa Ruiz']);

    // El conteo por grupo es lo que le deja ver al administrador si falta alguien.
    expect(conteos(jdt)).toEqual(['G1: 1', 'G2: 0', 'G3: 0', 'G4: 0', 'Sin grupo: 1']);
    expect(conteos(ingOp)).toEqual(['G1: 0', 'G2: 0', 'G3: 1', 'G4: 0', 'Sin grupo: 0']);

    // Quien nunca inició sesión se dice de frente: es por qué necesita selector de rol propio.
    expect(fila(container, 41).textContent).toContain('Nunca ha iniciado sesión');
    expect(fila(container, 11).textContent).toContain('Último ingreso como Ingeniero Jefe de Turno');
  });

  it('cambiarle el rol a una persona la mueve de tarjeta, y por sí solo no ensucia la pantalla', async () => {
    const { container } = await render();

    await elegir(selCargo(container, 41), '2');

    expect(nombresDeRol(container)).toEqual([
      'Ingeniero de Operación',
      'Ingeniero Jefe de Turno',
      'Operador de Planta - Sala de Mando',
    ]);
    expect(personasDeRol(tarjetas(container)[0])).toEqual(['Carla Mesa', 'Elsa Ruiz']);

    // Sin grupo no hay asignación que guardar: elegir el rol solo no prende el botón.
    expect(guardar(container).disabled).toBe(true);
    expect(container.querySelector('.rot-sucio')).toBeNull();
    expect(container.querySelector('.rot-descartar')).toBeNull();
  });
});

// ── CA-19 · edición, estado sucio y el POST ─────────────────────────────────────────────────────

describe('ConfiguracionRotacion · guardar (CA-19)', () => {
  it('cambiar un grupo marca la pantalla como sucia y Guardar dispara UN POST con el cuerpo correcto', async () => {
    const { container } = await render();

    expect(guardar(container).disabled).toBe(true);

    await elegir(selGrupo(container, 12), '2');

    expect(container.querySelector('.rot-sucio').textContent).toBe('(1)');
    expect(container.querySelector('.rot-descartar')).not.toBeNull();
    expect(guardar(container).disabled).toBe(false);
    // El conteo del rol se mueve en vivo con el buffer, no con lo que el server tiene.
    expect(conteos(tarjetas(container)[1])).toEqual(['G1: 1', 'G2: 1', 'G3: 0', 'G4: 0', 'Sin grupo: 0']);

    await click(guardar(container));

    const posts = postsDeAsignaciones();
    expect(posts).toHaveLength(1);
    expect(posts[0].cuerpo).toEqual({
      asignaciones: [{ usuario_id: 12, cargo_id: 1, grupo: 2, vigente_desde: HOY }],
    });
    // Tras guardar se relee y el buffer vuelve a nacer del server: no queda nada pendiente.
    expect(container.querySelector('.rot-sucio')).toBeNull();
    expect(container.querySelector('.rot-aviso').textContent).toContain('1 nuevas');
  });

  it('quitarle el grupo a alguien manda grupo null con el rol de la asignación que se cierra', async () => {
    const { container } = await render();

    await elegir(selGrupo(container, 11), '');
    expect(guardar(container).disabled).toBe(false);

    await click(guardar(container));

    const posts = postsDeAsignaciones();
    expect(posts).toHaveLength(1);
    expect(posts[0].cuerpo.asignaciones).toEqual([
      { usuario_id: 11, cargo_id: 1, grupo: null, vigente_desde: HOY },
    ]);
  });

  it('una persona con grupo pero sin rol bloquea Guardar y lo dice', async () => {
    const { container } = await render();

    await elegir(selGrupo(container, 41), '2');

    expect(container.querySelector('.rot-aviso-sinrol').textContent)
      .toContain('Hay 1 persona con grupo pero sin rol');
    expect(guardar(container).disabled).toBe(true);

    await click(guardar(container));
    expect(postsDeAsignaciones()).toHaveLength(0);
  });

  it('Descartar devuelve el buffer al último estado del server', async () => {
    const { container } = await render();

    await elegir(selGrupo(container, 12), '4');
    expect(container.querySelector('.rot-sucio').textContent).toBe('(1)');

    await click(container.querySelector('.rot-descartar'));

    expect(container.querySelector('.rot-sucio')).toBeNull();
    expect(selGrupo(container, 12).value).toBe('');
    expect(postsDeAsignaciones()).toHaveLength(0);
  });
});

// ── CA-19 · sin permiso ─────────────────────────────────────────────────────────────────────────

describe('ConfiguracionRotacion · puedeConfigurar = false (CA-19)', () => {
  it('deja todo deshabilitado, muestra el chip Solo lectura y esconde los botones de escritura', async () => {
    const { container } = await render({ puedeConfigurar: false });

    expect(container.querySelector('.rot-readonly').textContent).toContain('Solo lectura');
    expect(guardar(container)).toBeNull();
    expect(container.querySelector('.rot-sync')).toBeNull();
    expect(container.querySelector('.rot-patron-desactivar')).toBeNull();

    const selects = [...container.querySelectorAll('.rot-select-grupo, .rot-select-cargo')];
    expect(selects.length).toBeGreaterThan(0);
    expect(selects.every((s) => s.disabled)).toBe(true);

    expect(container.querySelector('.rot-patron-cargo').disabled).toBe(true);
    expect(container.querySelector('.rot-patron-v1').disabled).toBe(true);
    expect(container.querySelector('.rot-patron-crear').disabled).toBe(true);

    // Sigue siendo una pantalla de consulta: las personas se ven, agrupadas igual.
    expect(nombresDeRol(container)).toHaveLength(4);
  });
});

// ── Sincronización con Entra ────────────────────────────────────────────────────────────────────

describe('ConfiguracionRotacion · Actualizar desde Entra', () => {
  it('muestra el total y el conteo por rol que DEVOLVIÓ la respuesta, no un número prometido', async () => {
    const { container } = await render();

    await click(container.querySelector('.rot-sync'));

    const chips = [...container.querySelectorAll('.rot-sync-rol')].map((c) => c.textContent);
    expect(chips).toEqual(['JEFE_DE_TURNO: 7', 'INGENIERO_OPERACION: 14']);
    expect(container.querySelector('.rot-resumen-sync').textContent).toContain('21');
    // Nada de "81 personas": el número que se muestra es el que llegó (GATE-O2 §6.12).
    expect(container.querySelector('.rot-resumen-sync').textContent).not.toContain('81');
  });

  it('un 503 entra_no_disponible es un aviso NO bloqueante: el resto de la pantalla sigue usable', async () => {
    fallaSync = {
      status: 503,
      cuerpo: {
        error: 'El directorio de Microsoft Entra no está disponible en este momento.',
        codigo: 'entra_no_disponible',
        mensaje: 'El directorio de Microsoft Entra no está disponible en este momento.',
      },
    };
    const { container } = await render();

    await click(container.querySelector('.rot-sync'));

    expect(container.querySelector('.rot-aviso-entra').textContent)
      .toContain('No se pudo consultar el directorio de Entra');
    expect(codigosReportados).toContain('entra_no_disponible');

    // Lo que hace que sea "no bloqueante": las personas siguen ahí y se pueden seguir editando.
    expect(nombresDeRol(container)).toHaveLength(4);
    expect(selGrupo(container, 12).disabled).toBe(false);
    await elegir(selGrupo(container, 12), '3');
    expect(guardar(container).disabled).toBe(false);
  });
});

// ── Patrón por rol ──────────────────────────────────────────────────────────────────────────────

describe('ConfiguracionRotacion · patrón por rol', () => {
  async function llenarPatron(container) {
    await click(container.querySelectorAll('.rot-preset')[1]);   // vectores de Ingenieros
    await elegir(container.querySelector('.rot-patron-cargo'), '1');
    await escribir(container.querySelector('.rot-patron-inicio'), '2027-02-01');
    await escribir(container.querySelector('.rot-patron-fin'), '2027-12-31');
    await elegir(container.querySelector('.rot-patron-g1'), '2');
    await elegir(container.querySelector('.rot-patron-g2'), '3');
  }

  it('pide fecha de inicio y los grupos de guardia de ese día; jamás nombra "ancla" ni "desfase"', async () => {
    const { container } = await render();

    const texto = container.textContent.toLowerCase();
    expect(texto).not.toContain('ancla');
    expect(texto).not.toContain('desfase');

    await llenarPatron(container);
    await click(container.querySelector('.rot-patron-crear'));

    const post = llamadas.find((l) => l.metodo === 'POST' && l.url.includes('/api/rotacion/patrones'));
    expect(post.cuerpo).toEqual({
      cargo_id: 1,
      fecha_inicio: '2027-02-01',
      fecha_fin: '2027-12-31',
      vector_t1: [1, 1, 2, 2, 4, 4, 3, 3],
      vector_t2: [4, 3, 3, 1, 1, 2, 2, 4],
      grupo_t1: 2,
      grupo_t2: 3,
    });
    // Requerimiento §4: el desfase lo deriva el backend y el cliente ni lo menciona.
    expect(Object.keys(post.cuerpo)).not.toContain('desfase');
    expect(Object.keys(post.cuerpo)).not.toContain('ancla');
  });

  it('traduce el 409 del backend por su codigo, sin mostrar el slug', async () => {
    fallaPostPatron = {
      status: 409,
      cuerpo: {
        error: 'patron_duplicado',
        codigo: 'patron_duplicado',
        mensaje: 'Ya existe un patrón para ese cargo con esa misma fecha de inicio.',
        patron_id: 7,
      },
    };
    const { container } = await render();

    await llenarPatron(container);
    await click(container.querySelector('.rot-patron-crear'));

    const aviso = container.querySelector('.rot-aviso').textContent;
    expect(aviso).toContain('Desactívalo antes de cargar el corregido');
    expect(aviso).not.toContain('patron_duplicado');
    expect(codigosReportados).toContain('patron_duplicado');
  });

  it('Desactivar manda el PATCH del contrato de L12 con { activo: false }', async () => {
    const { container } = await render();

    await click(container.querySelector('.rot-patron-desactivar'));

    const patch = llamadas.find((l) => l.metodo === 'PATCH');
    expect(patch.url).toContain('/api/rotacion/patrones/7');
    expect(patch.cuerpo).toEqual({ activo: false });
    expect(container.querySelector('.rot-aviso').textContent).toContain('Patrón desactivado');
  });
});
