// @vitest-environment jsdom
/* global process */
//
// D-065 L09 (CA-21) — la vista de cumplimiento de la rotación sobre el componente REAL, con `fetch`
// stubeado con la forma exacta del contrato C6. El hook `useCumplimiento` no se prueba aparte a
// propósito: lo único que hace es traer, traducir el error por `codigo` y derivar el panel de
// ausencias, y las tres cosas se ven desde afuera. Lo que sí tiene su propio caso es la derivación
// pura (`ausenciasPorTitular`), porque la regla de qué filas alimentan el panel es una decisión del
// contrato y no una consecuencia del render.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import CumplimientoRotacion from './CumplimientoRotacion.jsx';
import { ausenciasPorTitular, rangoPorDefecto } from '../../hooks/useCumplimiento.js';
import { getTodayBogota } from '../../utils/fecha.js';

// Zona hostil (mismo criterio que `ConsumosGrid.test.jsx`): el equipo está en America/Bogota, así
// que un `timeZone` explícito que se pierda no lo delata ningún assert corrido en local. Con Tokyo
// (UTC+9), una fecha lógica formateada sin `timeZone: 'UTC'` se corre un día y el caso lo ve.
const TZ_HOST = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
beforeAll(() => { process.env.TZ = 'Asia/Tokyo'; });
afterAll(() => { process.env.TZ = TZ_HOST; });

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const DESDE = '2026-08-01';
const HASTA = '2026-08-31';

// ── Datos con la forma del contrato C6 ──────────────────────────────────────────────────────────

const PLANTAS = [
  { planta_id: 'GEC3', nombre: 'GECELCA 3', activa: true },
  { planta_id: 'GEC32', nombre: 'GECELCA 32', activa: true },
];

// Los cuatro estados, uno por fila. Ojo con la última: es `CUBIERTO_POR_RELEVO` y su titular NO
// entró — desde la ENMIENDA D4 del GATE-O3 (2026-09-02) esa ausencia SÍ cuenta: el panel mide
// asistencia ("¿quién faltó?"), no cobertura ("¿quién dejó el rol sin cubrir?"). El titular de una
// fila cubierta tampoco entró.
const FILA_PENDIENTE = {
  fecha_operativa: '2026-08-15', turno: 1, planta_id: 'GEC3',
  cargo_id: 8, cargo_nombre: 'Operador de Planta - Sala de Mando', grupo: 3,
  estado: 'PENDIENTE',
  titulares: [
    { usuario_id: 61, nombre: 'Ana Ríos', entro: false },
    { usuario_id: 77, nombre: 'Luis Peña', entro: false },
  ],
  relevo: null, congelado: true,
};
const FILA_PARCIAL = {
  fecha_operativa: '2026-08-16', turno: 2, planta_id: 'GEC3',
  cargo_id: 8, cargo_nombre: 'Operador de Planta - Sala de Mando', grupo: 4,
  estado: 'PARCIAL',
  titulares: [
    { usuario_id: 61, nombre: 'Ana Ríos', entro: true },
    { usuario_id: 77, nombre: 'Luis Peña', entro: false },
  ],
  relevo: null, congelado: true,
};
const FILA_COMPLETO = {
  fecha_operativa: '2026-08-17', turno: 1, planta_id: 'GEC3',
  cargo_id: 9, cargo_nombre: 'Ingeniero Jefe de Turno', grupo: 1,
  estado: 'COMPLETO',
  titulares: [{ usuario_id: 88, nombre: 'Carlos Mena', entro: true }],
  relevo: null, congelado: true,
};
const FILA_RELEVO = {
  fecha_operativa: '2026-08-18', turno: 2, planta_id: 'GEC3',
  cargo_id: 9, cargo_nombre: 'Ingeniero Jefe de Turno', grupo: 2,
  estado: 'CUBIERTO_POR_RELEVO',
  titulares: [{ usuario_id: 88, nombre: 'Carlos Mena', entro: false }],
  relevo: { usuario_id: 99, nombre: 'Marta Gil' },
  congelado: false,             // el turno en curso se deriva en vivo
};

function payload(extra = {}) {
  return {
    filas: [FILA_PENDIENTE, FILA_PARCIAL, FILA_COMPLETO, FILA_RELEVO],
    resumen: { PENDIENTE: 1, PARCIAL: 1, COMPLETO: 1, CUBIERTO_POR_RELEVO: 1 },
    ...extra,
  };
}

// ── Stub de red ─────────────────────────────────────────────────────────────────────────────────

function respuesta(cuerpo, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => cuerpo, headers: new Headers() };
}

function diferido() {
  let resolver;
  const promesa = new Promise((res) => { resolver = res; });
  return { promesa, resolver };
}

let llamadas;       // toda petición que salió
let cuerpoGet;      // respuesta del GET de cumplimiento cuando NO es manual
let fallaGet;       // { status, cuerpo } con el que responde el GET cuando debe fallar
let rompeGet;       // cuando es true, `fetch` RECHAZA (servidor caído → sin_conexion)
let modoManual;     // cuando es true, cada GET de cumplimiento queda retenido hasta que el test lo suelte
let cola;

beforeEach(() => {
  llamadas = [];
  cuerpoGet = payload();
  fallaGet = null;
  rompeGet = false;
  modoManual = false;
  cola = [];
  globalThis.fetch = vi.fn(async (url, opciones) => {
    const u = String(url);
    llamadas.push({ url: u, opciones });
    if (u.includes('/api/catalogos/plantas')) return respuesta({ plantas: PLANTAS });
    if (u.includes('/api/rotacion/cumplimiento')) {
      if (rompeGet) throw new TypeError('Failed to fetch');
      if (fallaGet) return respuesta(fallaGet.cuerpo, fallaGet.status);
      if (modoManual) { const d = diferido(); cola.push(d); return d.promesa; }
      return respuesta(cuerpoGet);
    }
    return respuesta({});
  });
});

afterEach(() => {
  for (const desmontar of montados.splice(0)) desmontar();
  vi.restoreAllMocks();
});

// ── Render ──────────────────────────────────────────────────────────────────────────────────────

const montados = [];

async function render(props = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const eventos = { rango: [], planta: [] };
  let actuales = {
    desde: DESDE,
    hasta: HASTA,
    planta: 'GEC3',
    onRangoChange: (r) => eventos.rango.push(r),
    onPlantaChange: (p) => eventos.planta.push(p),
    ...props,
  };
  const pintar = async () => { await act(async () => { root.render(h(CumplimientoRotacion, actuales)); }); };
  await pintar();

  // La vista es CONTROLADA: "el usuario cambió el rango" desde el punto de vista del componente es
  // que el padre le reponga las props. Esto es lo que hará L10 al escribir el hash.
  const reprops = async (parche) => { actuales = { ...actuales, ...parche }; await pintar(); };

  let desmontado = false;
  const teardown = () => {
    if (desmontado) return;
    desmontado = true;
    act(() => { root.unmount(); });
    container.remove();
  };
  montados.push(teardown);
  return { container, reprops, teardown, eventos };
}

// Escribir en un <input type="date"> como una persona: setter nativo + evento `input`, que es lo que
// React 19 escucha.
async function teclearFecha(input, valor) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, valor);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// En un <select>, React escucha `change`.
async function escoger(select, valor) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, valor);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function click(el) {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

const texto = (c) => c.textContent.replace(/\s+/g, ' ').trim();
const urlCumplimiento = () => llamadas.filter((l) => l.url.includes('/api/rotacion/cumplimiento')).map((l) => l.url);
const campo = (c, etiqueta) => c.querySelector(`[aria-label="${etiqueta}"]`);

// ── CA-21 · los cuatro estados, distinguibles ───────────────────────────────────────────────────

describe('CA-21 · la tabla pinta los cuatro estados y los distingue', () => {
  it('cada fila lleva su chip con etiqueta y color propios, y ninguno se repite', async () => {
    const { container } = await render();

    const chips = [...container.querySelectorAll('tbody [data-estado]')];
    expect(chips.map((c) => c.getAttribute('data-estado'))).toEqual([
      'PENDIENTE', 'PARCIAL', 'COMPLETO', 'CUBIERTO_POR_RELEVO',
    ]);

    // Distinguibles de verdad: cuatro etiquetas distintas y cuatro colores de fondo distintos.
    const etiquetas = chips.map((c) => texto(c));
    expect(etiquetas).toEqual(['Pendiente', 'Parcial', 'Completo', 'Cubierto por relevo']);
    expect(new Set(etiquetas).size).toBe(4);
    const fondos = chips.map((c) => c.style.backgroundColor);
    expect(new Set(fondos).size).toBe(4);
  });

  it('el resumen muestra las cuatro claves, en su orden, aunque estén en 0', async () => {
    cuerpoGet = payload({ filas: [], resumen: { PENDIENTE: 0, PARCIAL: 0, COMPLETO: 0, CUBIERTO_POR_RELEVO: 0 } });
    const { container } = await render();

    const tarjetas = [...container.querySelectorAll('[data-resumen]')];
    expect(tarjetas.map((t) => t.getAttribute('data-resumen'))).toEqual([
      'PENDIENTE', 'PARCIAL', 'COMPLETO', 'CUBIERTO_POR_RELEVO',
    ]);
    for (const t of tarjetas) {
      const clave = t.getAttribute('data-resumen');
      expect(texto(t.querySelector(`[data-conteo="${clave}"]`))).toBe('0');
    }
  });

  it('el resumen refleja los conteos que manda el backend, no los que cuenta el front', async () => {
    cuerpoGet = payload({ resumen: { PENDIENTE: 4, PARCIAL: 9, COMPLETO: 51, CUBIERTO_POR_RELEVO: 2 } });
    const { container } = await render();

    const conteos = [...container.querySelectorAll('[data-conteo]')].map((c) => texto(c));
    expect(conteos).toEqual(['4', '9', '51', '2']);
  });

  it('la descripción de PENDIENTE dice que faltó el TITULAR, no que el turno estuviera vacío', async () => {
    const { container } = await render();
    const tarjeta = container.querySelector('[data-resumen="PENDIENTE"]');

    expect(texto(tarjeta)).toContain('Ningún titular registró en la bitácora');
    // La regla central del módulo (CA-15): un PENDIENTE no significa que no vino nadie.
    expect(texto(container)).not.toMatch(/sin personal|turno vac[íi]o|nadie trabaj/i);
  });

  it('el turno en curso (congelado: false) se distingue del congelado', async () => {
    const { container } = await render();

    const filas = [...container.querySelectorAll('tbody tr[data-congelado]')];
    expect(filas.map((f) => f.getAttribute('data-congelado'))).toEqual(['1', '1', '1', '0']);
    expect(texto(filas[3])).toContain('En curso');
    expect(texto(filas[0])).not.toContain('En curso');
    expect(texto(container)).toContain('El turno en curso se calcula en vivo');
  });

  it('el relevo se muestra en su propia columna: es información, no ruido', async () => {
    const { container } = await render();

    const conRelevo = [...container.querySelectorAll('tbody [data-relevo]')];
    expect(conRelevo).toHaveLength(1);
    expect(texto(conRelevo[0])).toContain('Marta Gil');
  });

  it('las fechas van en Bogotá explícito: una fecha lógica no se corre un día en TZ hostil', async () => {
    const { container } = await render();
    const primera = container.querySelector('tbody tr td');

    // 2026-08-15 se lee 15/08/2026 aunque el proceso esté en Asia/Tokyo.
    expect(texto(primera)).toBe('15/08/2026');
  });
});

// ── CA-21 · una fila PENDIENTE nombra a los titulares que faltaron ──────────────────────────────

describe('CA-21 · los titulares que no entraron se leen de un vistazo', () => {
  it('la fila PENDIENTE nombra a sus dos titulares ausentes, marcados como que no entraron', async () => {
    const { container } = await render();
    const fila = container.querySelectorAll('tbody tr[data-congelado]')[0];

    const ausentes = [...fila.querySelectorAll('[data-entro="0"]')].map((e) => texto(e));
    expect(ausentes).toEqual(['Ana Ríos', 'Luis Peña']);
    expect(fila.querySelectorAll('[data-entro="1"]')).toHaveLength(0);
  });

  it('el panel de ausencias agrupa por persona, cuenta sus turnos y los nombra', async () => {
    const { container } = await render();
    const panel = container.querySelector('[data-ausentes]');

    expect(panel).not.toBeNull();
    // Luis Peña faltó en PENDIENTE y en PARCIAL (2); Ana Ríos solo en PENDIENTE (1); Carlos Mena en
    // la fila CUBIERTA POR RELEVO (1). Ordenado por cantidad de ausencias y, a igualdad, por
    // nombre — que es lo que hace legible el panel.
    const items = [...panel.querySelectorAll('[data-ausente]')];
    expect(items.map((i) => i.getAttribute('data-ausente'))).toEqual(['77', '61', '88']);
    expect(texto(items[0])).toContain('Luis Peña');
    expect(texto(items[0])).toContain('2 turnos');
    expect(texto(items[0])).toContain('15/08/2026 T1');
    expect(texto(items[0])).toContain('16/08/2026 T2');
    expect(texto(items[1])).toContain('Ana Ríos');
    expect(texto(items[1])).toContain('1 turno');
  });

  // ── ENMIENDA D4 (GATE-O3, 2026-09-02) ────────────────────────────────────────────────────────
  //
  // El panel se alimentaba solo de `PENDIENTE` y `PARCIAL`, así que un titular que faltó en un
  // turno que alguien más cubrió no aparecía: se veía en la tabla, con su ✗, pero no en el resumen.
  // El usuario —que es quien pidió el reporte— decidió que el panel responde "¿quién faltó?", no
  // "¿quién dejó el rol sin cubrir?".
  it('D4 · el titular ausente de una fila CUBIERTO_POR_RELEVO también cuenta (mide asistencia)', async () => {
    const { container } = await render();
    const panel = container.querySelector('[data-ausentes]');

    const carlos = panel.querySelector('[data-ausente="88"]');
    expect(carlos).not.toBeNull();
    expect(texto(carlos)).toContain('Carlos Mena');
    expect(texto(carlos)).toContain('1 turno');
    expect(texto(carlos)).toContain('18/08/2026 T2');
    // Que su turno lo cubriera otra persona no se pierde: sin esa marca, el panel parecería
    // contradecir la columna "Relevo" de la tabla.
    expect(texto(carlos)).toMatch(/cubierto/i);

    // Y el encabezado dice qué mide, o el lector no entiende por qué un turno cubierto aporta
    // una ausencia.
    expect(texto(container)).toMatch(/asistencia/i);
  });

  it('D4 · `ausenciasPorTitular` cuenta cualquier titular con `entro: false`, sin mirar el estado', () => {
    const r = ausenciasPorTitular([FILA_RELEVO]);
    expect(r).toHaveLength(1);
    expect(r[0].usuario_id).toBe(88);
    expect(r[0].turnos[0].estado).toBe('CUBIERTO_POR_RELEVO');
  });

  it('sin ausencias el panel lo dice, sin inventar una lista vacía', async () => {
    cuerpoGet = payload({ filas: [FILA_COMPLETO], resumen: { PENDIENTE: 0, PARCIAL: 0, COMPLETO: 1, CUBIERTO_POR_RELEVO: 0 } });
    const { container } = await render();

    expect(container.querySelector('[data-ausentes]')).toBeNull();
    expect(texto(container)).toContain('Todos los titulares del rango registraron en la bitácora');
  });

  it('`ausenciasPorTitular` agrupa por usuario_id, no por nombre (el congelado guarda el de la época)', () => {
    const renombrada = {
      ...FILA_PARCIAL,
      titulares: [{ usuario_id: 77, nombre: 'Luis Peña Mora', entro: false }],
    };
    const r = ausenciasPorTitular([FILA_PENDIENTE, renombrada]);

    const luis = r.find((p) => p.usuario_id === 77);
    expect(luis.turnos).toHaveLength(2);
    expect(r).toHaveLength(2);        // Ana + Luis, no tres personas
  });
});

// ── CA-21 · filtros controlados ─────────────────────────────────────────────────────────────────

describe('CA-21 · el rango y la unidad son controlados y avisan por callback', () => {
  it('cambiar "Desde" dispara onRangoChange con el rango completo', async () => {
    const { container, eventos } = await render();

    await teclearFecha(campo(container, 'Desde'), '2026-08-10');

    expect(eventos.rango).toEqual([{ desde: '2026-08-10', hasta: HASTA }]);
  });

  it('cambiar "Hasta" dispara onRangoChange conservando el desde', async () => {
    const { container, eventos } = await render();

    await teclearFecha(campo(container, 'Hasta'), '2026-08-20');

    expect(eventos.rango).toEqual([{ desde: DESDE, hasta: '2026-08-20' }]);
  });

  it('no cambia nada por su cuenta: la consulta solo se rehace cuando el padre repone las props', async () => {
    const { container, reprops } = await render();
    expect(urlCumplimiento()).toHaveLength(1);
    expect(urlCumplimiento()[0]).toContain('desde=2026-08-01');

    await teclearFecha(campo(container, 'Desde'), '2026-08-10');
    expect(urlCumplimiento()).toHaveLength(1);              // el componente NO se auto-actualiza

    await reprops({ desde: '2026-08-10' });
    expect(urlCumplimiento()).toHaveLength(2);
    expect(urlCumplimiento()[1]).toContain('desde=2026-08-10');
  });

  it('cambiar la unidad dispara onPlantaChange y la nueva planta viaja en la consulta', async () => {
    const { container, reprops, eventos } = await render();
    expect(urlCumplimiento()[0]).toContain('planta_id=GEC3');

    await escoger(campo(container, 'Unidad'), 'GEC32');
    expect(eventos.planta).toEqual(['GEC32']);

    await reprops({ planta: 'GEC32' });
    expect(urlCumplimiento()[1]).toContain('planta_id=GEC32');
  });

  it('el selector de unidad se llena del catálogo, no de una lista escrita a mano', async () => {
    const { container } = await render();
    const opciones = [...campo(container, 'Unidad').querySelectorAll('option')];

    expect(opciones.map((o) => o.value)).toEqual(['GEC3', 'GEC32']);
    expect(opciones.map((o) => o.textContent)).toEqual(['GECELCA 3', 'GECELCA 32']);
  });

  it('sin unidad no gasta un viaje al servidor: pide escogerla', async () => {
    const { container } = await render({ planta: '' });

    expect(urlCumplimiento()).toHaveLength(0);
    expect(texto(container)).toContain('Escoge una unidad y un rango de fechas');
  });

  it('el botón Actualizar rehace la consulta con las mismas props', async () => {
    const { container } = await render();
    const boton = [...container.querySelectorAll('button')].find((b) => texto(b).includes('Actualizar'));

    await click(boton);

    expect(urlCumplimiento()).toHaveLength(2);
    expect(urlCumplimiento()[1]).toBe(urlCumplimiento()[0]);
  });
});

// ── CA-21 · errores y rango vacío ───────────────────────────────────────────────────────────────

describe('CA-21 · el error se ramifica por codigo y el rango vacío no es un error', () => {
  it('400 rango_excesivo muestra el mensaje con el límite de 93 días', async () => {
    fallaGet = {
      status: 400,
      cuerpo: { error: 'rango_excesivo', codigo: 'rango_excesivo', mensaje: 'El rango no puede superar 93 días.' },
    };
    const { container } = await render();

    const aviso = container.querySelector('[data-error]');
    expect(aviso.getAttribute('data-error')).toBe('rango_excesivo');
    expect(texto(aviso)).toContain('93 días');
    expect(texto(aviso)).toContain('Escoge un periodo más corto');
  });

  it('sin_conexion se muestra como aviso de red, no como un fallo de la consulta', async () => {
    rompeGet = true;
    const { container } = await render();

    const aviso = container.querySelector('[data-error]');
    expect(aviso.getAttribute('data-error')).toBe('sin_conexion');
    expect(texto(aviso)).toContain('No se pudo contactar al servidor');
  });

  it('un slug del motor del patrón sale con su propio mensaje, no con el texto crudo', async () => {
    fallaGet = {
      status: 400,
      cuerpo: { error: 'desfase_ambiguo', codigo: 'desfase_ambiguo', mensaje: 'x' },
    };
    const { container } = await render();

    expect(texto(container.querySelector('[data-error]'))).toContain('Revisa la configuración anual');
  });

  it('un rango vacío dice "Sin datos" y NO pinta un error', async () => {
    cuerpoGet = payload({ filas: [], resumen: { PENDIENTE: 0, PARCIAL: 0, COMPLETO: 0, CUBIERTO_POR_RELEVO: 0 } });
    const { container } = await render();

    expect(container.querySelector('[data-error]')).toBeNull();
    expect(texto(container)).toContain('Sin datos en este rango.');
  });

  it('un error deja de mostrarse en cuanto la consulta siguiente sale bien', async () => {
    fallaGet = { status: 400, cuerpo: { error: 'rango_excesivo', codigo: 'rango_excesivo', mensaje: 'x' } };
    const { container, reprops } = await render();
    expect(container.querySelector('[data-error]')).not.toBeNull();

    fallaGet = null;
    await reprops({ hasta: '2026-08-20' });

    expect(container.querySelector('[data-error]')).toBeNull();
    expect(container.querySelectorAll('tbody tr[data-congelado]')).toHaveLength(4);
  });
});

// ── Respuestas que llegan tarde ─────────────────────────────────────────────────────────────────

describe('la respuesta que llega tarde no pisa a la última', () => {
  it('mover el rango dos veces deja en pantalla lo último que se pidió, no lo primero que responde', async () => {
    modoManual = true;
    const { container, reprops } = await render();
    await reprops({ hasta: '2026-08-20' });
    expect(cola).toHaveLength(2);

    // La SEGUNDA responde primero (la buena), y después aterriza la primera, ya obsoleta.
    await act(async () => { cola[1].resolver(respuesta(payload())); });
    await act(async () => { cola[0].resolver(respuesta(payload({ filas: [], resumen: {} }))); });

    expect(container.querySelectorAll('tbody tr[data-congelado]')).toHaveLength(4);
    expect(texto(container)).not.toContain('Sin datos en este rango.');
  });
});

// ── El control y el validador de la ruta aceptan lo mismo (CR4-9, GATE-O4) ──────────────────────

describe('el rango que se puede elegir es el que la URL puede representar', () => {
  it('"Hasta" está topado en hoy (Bogotá), que es justo lo que `fechaValida` acepta', async () => {
    const { container } = await render();

    // Sin este tope se podía elegir una fecha futura: la pantalla consultaba con ella pero
    // `fechaValida` la descartaba al construir el hash, así que la URL quedaba sin el parámetro y
    // un F5 —o el enlace copiado a un correo— volvía al rango por defecto sin decir nada.
    const hastaInput = campo(container, 'Hasta');
    expect(hastaInput.getAttribute('max')).toBe(getTodayBogota());
    expect(hastaInput.getAttribute('max') >= HASTA).toBe(true);

    // "Desde" hereda el tope por transitividad: su max es el "hasta" vigente.
    expect(campo(container, 'Desde').getAttribute('max')).toBe(HASTA);
  });
});

// ── La pantalla se nombra a sí misma (H-L10-1, arreglado en el GATE-O4) ─────────────────────────

describe('la vista dice qué es, porque se llega a ella por deep-link', () => {
  it('tiene encabezado propio y nombra el módulo antes de la barra de filtros', async () => {
    const { container } = await render();

    // Un `h2`, no un `div` que parezca uno: quien abre el enlace pegado en un correo aterriza acá
    // sin pasar por el menú, y sin título la pantalla son cuatro tarjetas de colores y una tabla.
    const titulo = container.querySelector('h2');
    expect(titulo).not.toBeNull();
    expect(texto(titulo)).toContain('Rotación de turnos');
    expect(texto(titulo)).toContain('Cumplimiento');

    // Va ANTES de los filtros: el orden del DOM es el orden de lectura.
    const filtro = campo(container, 'Unidad');
    expect(titulo.compareDocumentPosition(filtro) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// ── Contrato con L10 (O4) ───────────────────────────────────────────────────────────────────────

describe('lo que L10 va a cablear', () => {
  it('rangoPorDefecto entrega una ventana de 14 días que cabe en el tope de 93', () => {
    const { desde, hasta } = rangoPorDefecto();

    expect(desde).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(hasta).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(desde <= hasta).toBe(true);
    const dias = Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86400000) + 1;
    expect(dias).toBe(14);
  });

  it('no toca el hash ni almacenamiento local: la fuente es el backend (CA-23)', async () => {
    const escribirHash = vi.spyOn(window.history, 'replaceState');
    const guardar = vi.spyOn(Storage.prototype, 'setItem');
    const intervalo = vi.spyOn(globalThis, 'setInterval');

    await render();

    expect(window.location.hash).toBe('');
    expect(escribirHash).not.toHaveBeenCalled();
    expect(guardar).not.toHaveBeenCalled();
    expect(intervalo).not.toHaveBeenCalled();
  });
});
