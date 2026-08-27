// @vitest-environment jsdom
/* global process */
//
// D-061 L08 (CA-32..CA-35) — la grilla COMB sobre el componente REAL, con `fetch` stubeado con la
// forma exacta de C4 (GET de consumos) y C5 (revertir). Reconstruye además el humo de render que
// L03 corrió y borró, para que deje de ser un archivo temporal y pase a correr con `npm test`.
//
// Todo lo que se prueba acá son defectos que el code-review de la O1 encontró y que ningún test
// puro podía ver: son de cableado (qué pasa cuando una respuesta llega tarde, cuándo se deshabilita
// un botón, qué clase lleva un popover). El módulo puro `override.js` ya está probado aparte.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import ConsumosGrid from './ConsumosGrid.jsx';

// El día Bogotá se controla desde afuera: sin esto, "hoy" se movería con el reloj de quien corre la
// suite y los casos de auto-refresco/gavela/medianoche serían verdes u opacos según la hora.
// `vi.hoisted` es obligatorio: la fábrica de vi.mock se iza por encima de las declaraciones.
const reloj = vi.hoisted(() => ({ hoy: '2026-08-26' }));
vi.mock('../../utils/fecha', async (importarOriginal) => {
  const real = await importarOriginal();
  return { ...real, getTodayBogota: () => reloj.hoy };
});

// Misma zona hostil que `override.test.js` (H-1 de L03): el equipo de dev está en America/Bogota,
// así que un timeZone explícito que se pierda no lo delata ningún assert de hora local.
const TZ_HOST = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
beforeAll(() => { process.env.TZ = 'Asia/Tokyo'; });
afterAll(() => { process.env.TZ = TZ_HOST; });

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const HOY = '2026-08-26';
const AYER = '2026-08-25';

// ── Datos con la forma del contrato ─────────────────────────────────────────────────────────────

// Catálogo real de GEC32: 8 alimentadores + Caliza + ACPM (topes de D-034).
function catalogo() {
  const alim = Array.from({ length: 8 }, (_, i) => ({
    combustible_id: i + 1,
    codigo: `ALIM_${i + 1}`,
    nombre: `Alimentador ${i + 1}`,
    unidad: 'Ton',
    tipo: 'ALIMENTADOR',
    cantidad_max: 25,
    orden: i + 1,
  }));
  return [
    ...alim,
    { combustible_id: 9, codigo: 'CALIZA', nombre: 'Caliza', unidad: 'Ton', tipo: 'CALIZA', cantidad_max: 40, orden: 9 },
    { combustible_id: 10, codigo: 'ACPM', nombre: 'ACPM', unidad: 'Gal', tipo: 'ACPM', cantidad_max: 25000, orden: 10 },
  ];
}

// Celda con el shape completo de C4 (los 4 campos SIS incluidos).
function celda(extra = {}) {
  return {
    consumo_id: 100,
    cantidad: 18.5,
    detalle: null,
    creado_por: { usuario_id: 1, nombre_completo: 'SISTEMA' },
    creado_en: '2026-08-26T14:00:00.000Z',
    modificado_por: null,
    modificado_en: null,
    valor_sis: null,
    sis_actualizado_en: null,
    sis_owned: true,
    es_override: false,
    ...extra,
  };
}

// Celda corregida a mano encima de una lectura del SIS (`es_override` lo calcula el backend).
function celdaOverride(extra = {}) {
  return celda({
    modificado_por: { usuario_id: 7, nombre_completo: 'Ana Ríos' },
    modificado_en: '2026-08-26T20:42:00.000Z',
    valor_sis: 17.25,
    sis_actualizado_en: '2026-08-26T14:00:00.000Z',
    sis_owned: false,
    es_override: true,
    ...extra,
  });
}

function bloqueSis(extra = {}) {
  return {
    scrape_tipo: 'sweeper',
    periodos_ok: 18,
    periodos_error: 0,
    ultimo_periodo: 18,
    completo: false,
    scraped_en: '2026-08-26T20:42:00.000Z',
    ...extra,
  };
}

// Payload por defecto: P1/ALIM_1 y P1/ALIM_8 son override (para las clases de posición del
// popover), P24/ALIM_1 también, y P1/CALIZA es una celda normal sin lectura SIS (no lleva
// banderín). P3/ALIM_1 es una celda del SIS sin corregir: sirve de "celda vecina" en los casos
// de edición.
function payload(extra = {}) {
  return {
    catalogo: catalogo(),
    celdas: {
      1: {
        1: celdaOverride(),
        8: celdaOverride({ consumo_id: 108 }),
        9: celda({ consumo_id: 109, cantidad: 12 }),
      },
      3: { 1: celda({ consumo_id: 301, cantidad: 20 }) },
      24: { 1: celdaOverride({ consumo_id: 241 }) },
    },
    sis: bloqueSis(),
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

let llamadas;        // toda petición que salió, con su cuerpo ya parseado
let cola;            // GETs de /consumos retenidos a mano (modo manual)
let modoManual;      // cuando es true, cada GET queda en la cola hasta que el test lo resuelva
let cuerpoGet;       // payload del GET cuando NO es manual
let cuerpoRevertir;  // respuesta de C5
let cuerpoGuardar;   // resumen del POST batch

beforeEach(() => {
  llamadas = [];
  cola = [];
  modoManual = false;
  cuerpoGet = payload();
  cuerpoRevertir = { accion: 'restaurado', celda: celda({ cantidad: 17.25 }) };
  cuerpoGuardar = { resumen: { creados: 0, actualizados: 1, eliminados: 0 } };
  globalThis.fetch = vi.fn(async (url, opciones) => {
    const u = String(url);
    llamadas.push({
      url: u,
      opciones,
      cuerpo: opciones?.body ? JSON.parse(opciones.body) : undefined,
    });
    if (u.includes('/consumos/revertir')) return respuesta(cuerpoRevertir);
    // El POST del batch va a la MISMA ruta que el GET (C6), así que el método es lo único que los
    // separa. Sin esta rama, un Guardar en modo manual quedaría retenido en la cola de los GET.
    if (u.includes('/consumos') && opciones?.method === 'POST') return respuesta(cuerpoGuardar);
    if (u.includes('/consumos')) {
      if (modoManual) {
        const d = diferido();
        cola.push(d);
        return d.promesa;            // queda EN VUELO hasta que el test la resuelva
      }
      return respuesta(cuerpoGet);
    }
    return respuesta({});
  });
});

afterEach(() => {
  // Desmontar SIEMPRE, no solo en el camino feliz. Un `teardown()` al final del cuerpo del test no
  // corre cuando el test falla, y el componente que queda montado se lleva vivos su intervalo de
  // 1 min, el de 5 min y su listener de `focus`: el `latido()` del test siguiente le llegaría
  // también a ese zombi y le consumiría un GET de la cola. Se midió con el arnés de mutaciones —
  // una regresión en CA-33 hacía "fallar" de rebote a casos de CA-34 que estaban sanos.
  for (const desmontar of montados.splice(0)) desmontar();
  reloj.hoy = HOY;              // el caso de medianoche lo mueve; si falla, no lo dejaría restaurado
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Render ──────────────────────────────────────────────────────────────────────────────────────

let toasts;
const montados = [];      // desmontadores pendientes, vaciados por el afterEach

async function render(props = {}) {
  toasts = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let actuales = {
    bitacora: { codigo: 'COMB', bitacora_id: 5, nombre: 'Consumos de Combustibles' },
    plantaId: 'GEC32',
    puedeCrear: true,
    fecha: HOY,
    onFechaChange: () => {},
    showToast: (texto, tipo) => toasts.push({ texto, tipo }),
    ...props,
  };
  await act(async () => { root.render(h(ConsumosGrid, actuales)); });

  // Re-render con props nuevas: la grilla es controlada (D-035), así que "cambiar de fecha" desde
  // afuera es exactamente esto y no un clic en el selector.
  const reprops = async (parche) => {
    actuales = { ...actuales, ...parche };
    await act(async () => { root.render(h(ConsumosGrid, actuales)); });
  };
  let desmontado = false;
  const teardown = () => {
    if (desmontado) return;
    desmontado = true;
    act(() => { root.unmount(); });
    container.remove();
  };
  montados.push(teardown);
  return { container, reprops, teardown };
}

// Escribe en un <input type=number> como lo haría una persona (setter nativo + evento `input`,
// que es lo que React 19 escucha).
async function teclear(input, valor) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, valor);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(el) {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

// Entrar con el puntero (React sintetiza `onMouseEnter` a partir de `mouseover`).
async function entrar(el) {
  await act(async () => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
}

// jsdom no hace layout: `getBoundingClientRect` devuelve ceros para todo. Para probar el CABLEADO
// de la medición (CA-39) se le pone a mano el rect a los dos elementos que el componente mide —el
// banderín y `.comb-scroll`—; la aritmética de la decisión ya está probada aparte, sobre rects
// sintéticos, en `override.test.js › ladoPopover`.
function conRect(el, rect) {
  el.getBoundingClientRect = () => ({
    top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
    width: rect.right - rect.left, height: rect.bottom - rect.top, x: rect.left, y: rect.top,
  });
  return el;
}

// Latido del auto-refresco por `focus` (el otro camino es el intervalo de 5 min).
async function latido() {
  await act(async () => { window.dispatchEvent(new Event('focus')); });
}

// Celdas reales de un periodo, en orden: ALIM_1..ALIM_8, CALIZA, ACPM (la columna virtual
// "Total Carbón" es `td.comb-total` y queda fuera a propósito).
function celdasDe(container, periodo) {
  const fila = container.querySelectorAll('tbody tr')[periodo - 1];
  return [...fila.querySelectorAll('td.comb-cell')];
}
function inputDe(container, periodo, iCol) {
  return celdasDe(container, periodo)[iCol].querySelector('input');
}
function chip(container) {
  return container.querySelector('.comb-sis-chip')?.textContent ?? null;
}
function guardar(container) {
  return container.querySelector('.comb-save');
}
function revertires(container) {
  return [...container.querySelectorAll('.comb-tip-revertir')];
}
// El cuerpo del POST batch que salió de verdad (C6). Es lo único que prueba CA-37: lo que se ve en
// pantalla puede estar bien y el body llevar celdas que el operador nunca tocó.
function celdasDelPost() {
  const post = llamadas.find((l) => l.opciones?.method === 'POST' && !l.url.includes('/revertir'));
  return post?.cuerpo?.celdas ?? null;
}

// ── Humo de render (reconstruido de L03) ────────────────────────────────────────────────────────

describe('ConsumosGrid · humo de render (L03, versionado por L08)', () => {
  it('pinta chip SIS, banderines solo donde hay override y el tooltip con autoría y valor SIS', async () => {
    const { container, teardown } = await render();

    expect(chip(container)).toBe('SIS 18/24 · 15:42');

    // P1: ALIM_1 y ALIM_8 son override; CALIZA (misma fila, con cantidad) no tiene valor_sis.
    const p1 = celdasDe(container, 1);
    expect(p1[0].querySelector('.comb-override')).toBeTruthy();
    expect(p1[7].querySelector('.comb-override')).toBeTruthy();
    expect(p1[8].querySelector('.comb-override')).toBeNull();
    // P3/ALIM_1 es una celda del SIS sin corregir: tampoco lleva banderín.
    expect(celdasDe(container, 3)[0].querySelector('.comb-override')).toBeNull();

    expect(p1[0].querySelector('.comb-tip-texto').textContent)
      .toBe('Editado por Ana Ríos el 26/08/2026 15:42. Valor SIS: 17.25 Ton');
    teardown();
  });

  it('el override 0 se muestra como 0, no como celda vacía', async () => {
    cuerpoGet = payload({ celdas: { 1: { 1: celdaOverride({ cantidad: 0 }) } } });
    const { container, teardown } = await render();
    expect(inputDe(container, 1, 0).value).toBe('0');
    teardown();
  });

  it('Revertir manda el POST de C5 con la coordenada exacta de la celda', async () => {
    const { container, teardown } = await render();
    await click(revertires(container)[0]);

    const post = llamadas.find((l) => l.url.includes('/consumos/revertir'));
    expect(post).toBeTruthy();
    expect(post.opciones.method).toBe('POST');
    expect(post.opciones.credentials).toBe('include');
    expect(post.cuerpo).toEqual({
      planta_id: 'GEC32', fecha: HOY, periodo: 1, combustible_id: 1,
    });
    teardown();
  });

  it('sin puedeCrear no se ofrece Revertir, pero el banderín y su texto siguen ahí', async () => {
    const { container, teardown } = await render({ puedeCrear: false });
    expect(revertires(container)).toHaveLength(0);
    expect(container.querySelector('.comb-override')).toBeTruthy();
    expect(guardar(container)).toBeNull();
    expect(container.textContent).toContain('Solo lectura');
    teardown();
  });

  it('en GEC3 no hay chip SIS ni banderines (no tiene SIS)', async () => {
    cuerpoGet = payload({ sis: null, celdas: { 1: { 1: celda({ cantidad: 12 }) } } });
    const { container, teardown } = await render({ plantaId: 'GEC3' });
    expect(container.querySelector('.comb-sis-chip')).toBeNull();
    expect(container.querySelector('.comb-override')).toBeNull();
    teardown();
  });

  it('editar arranca la gavela en 10:00 y Descartar la apaga devolviendo el valor del server', async () => {
    const { container, teardown } = await render();
    expect(container.querySelector('.comb-gavela')).toBeNull();

    await teclear(inputDe(container, 3, 0), '22');
    const gavela = container.querySelector('.comb-gavela');
    expect(gavela).toBeTruthy();
    expect(gavela.textContent).toContain('10:00');

    await click(gavela.querySelector('button'));
    expect(container.querySelector('.comb-gavela')).toBeNull();
    expect(inputDe(container, 3, 0).value).toBe('20');   // el valor del snapshot, intacto
    teardown();
  });
});

// ── CA-32 · Revertir no pisa ediciones ajenas y el toast dice la verdad ─────────────────────────

describe('CA-32 · Revertir', () => {
  it('con OTRA celda sucia, TODOS los Revertir quedan deshabilitados con el título de la gavela', async () => {
    const { container, teardown } = await render();
    // Antes: solo se deshabilitaba el Revertir de la celda sucia, así que revertir P1 relanzaba el
    // refetch y borraba en silencio lo tecleado en P3, bajo un toast de éxito.
    expect(revertires(container).every((b) => !b.disabled)).toBe(true);

    await teclear(inputDe(container, 3, 0), '22');

    const botones = revertires(container);
    expect(botones.length).toBeGreaterThan(1);
    expect(botones.every((b) => b.disabled)).toBe(true);
    expect(botones.every((b) => b.title === 'Guarda o descarta primero')).toBe(true);
    teardown();
  });

  it('con el buffer limpio Revertir funciona y trae el valor del SIS sin perder nada', async () => {
    const { container, teardown } = await render();
    const botones = revertires(container);
    expect(botones.every((b) => b.title === 'Volver al valor del SIS')).toBe(true);

    // El refetch que sigue al POST devuelve la celda ya restaurada por el backend.
    cuerpoGet = payload({
      celdas: {
        1: {
          1: celda({ cantidad: 17.25 }),
          8: celdaOverride({ consumo_id: 108 }),
          9: celda({ consumo_id: 109, cantidad: 12 }),
        },
        3: { 1: celda({ consumo_id: 301, cantidad: 20 }) },
        24: { 1: celdaOverride({ consumo_id: 241 }) },
      },
    });
    await click(botones[0]);

    expect(inputDe(container, 1, 0).value).toBe('17.25');
    expect(celdasDe(container, 1)[0].querySelector('.comb-override')).toBeNull();
    expect(inputDe(container, 3, 0).value).toBe('20');   // la celda vecina no se movió
    teardown();
  });

  it('toast por accion · restaurado', async () => {
    cuerpoRevertir = { accion: 'restaurado', celda: celda({ cantidad: 17.25 }) };
    const { container, teardown } = await render();
    await click(revertires(container)[0]);
    expect(toasts).toEqual([{ texto: 'Revertido al valor SIS', tipo: 'success' }]);
    teardown();
  });

  it('toast por accion · eliminado', async () => {
    cuerpoRevertir = { accion: 'eliminado', celda: null };
    const { container, teardown } = await render();
    await click(revertires(container)[0]);
    expect(toasts).toEqual([{ texto: 'Celda eliminada (valor SIS = 0)', tipo: 'success' }]);
    teardown();
  });

  it('toast por accion · sin_cambios NO se anuncia como una reversión', async () => {
    // H14: decir "Revertido al valor SIS" cuando no se revirtió nada le hace creer al operador que
    // su corrección desapareció.
    cuerpoRevertir = { accion: 'sin_cambios', celda: celda({ cantidad: 17.25 }) };
    const { container, teardown } = await render();
    await click(revertires(container)[0]);
    expect(toasts).toEqual([{ texto: 'La celda ya tenía el valor del SIS', tipo: 'info' }]);
    teardown();
  });
});

// ── CA-33 · Refetch seguro ──────────────────────────────────────────────────────────────────────

describe('CA-33 · refetch seguro', () => {
  it('teclear durante el GET no se pierde: el buffer sobrevive y el snapshot sí se actualiza', async () => {
    const { container, teardown } = await render();

    modoManual = true;
    await latido();                       // sale el GET del auto-refresco y queda en vuelo
    expect(cola).toHaveLength(1);

    await teclear(inputDe(container, 3, 0), '22');   // el operador escribe MIENTRAS viaja la respuesta

    // La respuesta trae otro valor para esa misma celda y un chip distinto.
    await act(async () => {
      cola[0].resolver(respuesta(payload({
        celdas: { 3: { 1: celda({ consumo_id: 301, cantidad: 19 }) } },
        sis: bloqueSis({ periodos_ok: 20 }),
      })));
    });

    expect(inputDe(container, 3, 0).value).toBe('22');   // lo tecleado manda
    expect(chip(container)).toBe('SIS 20/24 · 15:42');   // pero el snapshot/chip sí se refrescaron
    teardown();
  });

  it('una respuesta que llega fuera de orden se descarta', async () => {
    const { container, teardown } = await render();

    modoManual = true;
    await latido();
    await latido();
    expect(cola).toHaveLength(2);

    // Se resuelve primero la MÁS NUEVA y después la vieja: la vieja no puede pisarla.
    await act(async () => { cola[1].resolver(respuesta(payload({ sis: bloqueSis({ periodos_ok: 21 }) }))); });
    expect(chip(container)).toBe('SIS 21/24 · 15:42');

    await act(async () => { cola[0].resolver(respuesta(payload({ sis: bloqueSis({ periodos_ok: 5 }) }))); });
    expect(chip(container)).toBe('SIS 21/24 · 15:42');
    teardown();
  });

  it('la respuesta de otra fecha no se pinta bajo la cabecera de la fecha nueva', async () => {
    const { container, reprops, teardown } = await render();

    modoManual = true;
    await latido();                       // GET de HOY en vuelo
    await reprops({ fecha: AYER });       // el operador se mueve a ayer → sale el GET de AYER
    expect(cola).toHaveLength(2);

    // Llega la respuesta de HOY cuando en pantalla ya está AYER: debe tirarse entera.
    await act(async () => {
      cola[0].resolver(respuesta(payload({ sis: bloqueSis({ periodos_ok: 24, completo: true }) })));
    });
    expect(chip(container)).toBe('SIS 18/24 · 15:42');   // sigue el del render inicial

    await act(async () => { cola[1].resolver(respuesta(payload({ sis: bloqueSis({ periodos_ok: 9 }) }))); });
    expect(chip(container)).toBe('SIS 9/24 · 15:42');    // la de AYER sí entra
    teardown();
  });

  it('cruzar la medianoche apaga la gavela y el auto-refresco SIN descartar lo tecleado', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const { container, teardown } = await render();

    await teclear(inputDe(container, 3, 0), '22');
    expect(container.querySelector('.comb-gavela')).toBeTruthy();

    // 00:00 Bogotá: la fecha vista sigue siendo la de ayer, pero ya no es "hoy".
    reloj.hoy = '2026-08-27';
    await act(async () => { vi.advanceTimersByTime(60 * 1000); });

    expect(container.querySelector('.comb-gavela')).toBeNull();   // el contador se detiene y se limpia
    expect(inputDe(container, 3, 0).value).toBe('22');            // …sin descartar nada
    expect(guardar(container).disabled).toBe(false);

    // Y ya no hay auto-refresco sobre un día que dejó de ser hoy.
    const antes = llamadas.length;
    await act(async () => { vi.advanceTimersByTime(5 * 60 * 1000); });
    expect(llamadas.length).toBe(antes);
    teardown();   // `reloj.hoy` lo restaura el afterEach, pase o falle este caso
  });
});

// ── CA-34 · El override 0 no enciende Guardar ───────────────────────────────────────────────────

describe('CA-34 · override 0', () => {
  it('teclear 0 o vaciar una celda que el server ya tiene en 0 no enciende Guardar ni la gavela', async () => {
    cuerpoGet = payload({ celdas: { 1: { 1: celdaOverride({ cantidad: 0 }) } } });
    const { container, teardown } = await render();
    const input = inputDe(container, 1, 0);

    expect(input.value).toBe('0');
    expect(guardar(container).disabled).toBe(true);

    await teclear(input, '0');
    expect(guardar(container).disabled).toBe(true);
    expect(container.querySelector('.comb-gavela')).toBeNull();

    await teclear(input, '');
    expect(guardar(container).disabled).toBe(true);
    expect(container.querySelector('.comb-gavela')).toBeNull();
    teardown();
  });

  it('esa misma celda puede ir a 5 y volver a 0 sin dejar residuo', async () => {
    cuerpoGet = payload({ celdas: { 1: { 1: celdaOverride({ cantidad: 0 }) } } });
    const { container, teardown } = await render();
    const input = inputDe(container, 1, 0);

    await teclear(input, '5');
    expect(guardar(container).disabled).toBe(false);
    expect(container.querySelector('.comb-gavela')).toBeTruthy();

    await teclear(input, '0');
    expect(guardar(container).disabled).toBe(true);
    expect(container.querySelector('.comb-gavela')).toBeNull();
    teardown();
  });

  it('vaciar una celda con cantidad real SÍ es un cambio (el "vaciar" de C6 se conserva)', async () => {
    const { container, teardown } = await render();
    await teclear(inputDe(container, 3, 0), '');
    expect(guardar(container).disabled).toBe(false);
    teardown();
  });
});

// ── CA-35 · Popover y banderín ──────────────────────────────────────────────────────────────────

describe('CA-35 · popover y banderín', () => {
  it('el banderín está fuera del recorrido del Tab', async () => {
    const { container, teardown } = await render();
    const banderines = [...container.querySelectorAll('.comb-override')];
    expect(banderines.length).toBeGreaterThan(0);
    expect(banderines.every((b) => b.getAttribute('tabindex') === '-1')).toBe(true);
    teardown();
  });

  it('el banderín sigue abriendo y cerrando el popover con clic, y Escape lo cierra', async () => {
    const { container, teardown } = await render();
    const banderin = celdasDe(container, 1)[0].querySelector('.comb-override');

    expect(celdasDe(container, 1)[0].querySelector('.comb-tip').classList.contains('open')).toBe(false);
    await click(banderin);
    expect(celdasDe(container, 1)[0].querySelector('.comb-tip').classList.contains('open')).toBe(true);
    expect(banderin.getAttribute('aria-expanded')).toBe('true');

    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(celdasDe(container, 1)[0].querySelector('.comb-tip').classList.contains('open')).toBe(false);
    teardown();
  });
});

// ── CA-37 · El refetch preservado no puede convertirse en un borrado al guardar ─────────────────

describe('CA-37 · lo que el operador no tocó no viaja en el Guardar', () => {
  // El escenario de H24, tal cual pasa en producción: GEC32 viendo hoy, el `focus` dispara el
  // latido del auto-refresco, y el operador teclea mientras el GET está en vuelo. L08 arregló que
  // no se perdiera lo tecleado dejando el buffer viejo contra un snapshot nuevo — y abrió el camino
  // de vuelta: la celda que el SIS escribió durante ese GET queda "solo en el snapshot" y el
  // Guardar siguiente la manda con `cantidad: null`. El backend la convierte en override 0 a nombre
  // del operador (o la borra), y la ownership de D-029 impide que el scraper la reponga.
  //
  // Por eso todos estos casos afirman sobre el BODY REAL del POST: en pantalla no se nota nada.

  it('una celda que el SIS CREÓ durante el GET no aparece en el body', async () => {
    const { container, teardown } = await render();

    modoManual = true;
    await latido();                                   // GET del auto-refresco en vuelo
    await teclear(inputDe(container, 3, 0), '22');    // el operador teclea MIENTRAS viaja

    await act(async () => {
      cola[0].resolver(respuesta(payload({
        celdas: {
          3: { 1: celda({ consumo_id: 301, cantidad: 20 }) },
          5: { 1: celda({ consumo_id: 501, cantidad: 7 }) },   // ← la escribió el SIS recién
        },
      })));
    });
    modoManual = false;

    expect(inputDe(container, 3, 0).value).toBe('22');   // lo tecleado manda
    expect(inputDe(container, 5, 0).value).toBe('7');    // y la lectura nueva ya se ve

    await click(guardar(container));
    expect(celdasDelPost()).toEqual([
      { periodo: 3, combustible_id: 1, cantidad: 22, detalle: null },
    ]);
    teardown();
  });

  it('una celda que el SIS ACTUALIZÓ durante el GET no se pisa con el número viejo', async () => {
    // La cara simétrica: acá la celda ya existía y el SIS le cambió el valor. Mandarla al POST la
    // devolvería al número que el buffer tenía desde antes del GET.
    cuerpoGet = payload({
      celdas: {
        3: { 1: celda({ consumo_id: 301, cantidad: 20 }) },
        6: { 1: celda({ consumo_id: 601, cantidad: 11 }) },
      },
    });
    const { container, teardown } = await render();

    modoManual = true;
    await latido();
    await teclear(inputDe(container, 3, 0), '22');

    await act(async () => {
      cola[0].resolver(respuesta(payload({
        celdas: {
          3: { 1: celda({ consumo_id: 301, cantidad: 20 }) },
          6: { 1: celda({ consumo_id: 601, cantidad: 13 }) },   // ← 11 → 13, por debajo
        },
      })));
    });
    modoManual = false;

    expect(inputDe(container, 6, 0).value).toBe('13');   // se adopta el valor fresco del SIS

    await click(guardar(container));
    expect(celdasDelPost()).toEqual([
      { periodo: 3, combustible_id: 1, cantidad: 22, detalle: null },
    ]);
    teardown();
  });

  it('en el conflicto real gana lo tecleado, y el badge muestra el valor_sis nuevo', async () => {
    // El operador corrige la MISMA celda que el SIS acaba de cambiar. Lo tecleado es el override:
    // manda. Pero el tooltip tiene que hablar de la lectura nueva, que ya viene en el snapshot.
    const { container, teardown } = await render();

    modoManual = true;
    await latido();
    await teclear(inputDe(container, 1, 0), '21');

    await act(async () => {
      cola[0].resolver(respuesta(payload({
        celdas: { 1: { 1: celdaOverride({ valor_sis: 19 }) } },
      })));
    });
    modoManual = false;

    expect(inputDe(container, 1, 0).value).toBe('21');
    expect(celdasDe(container, 1)[0].querySelector('.comb-tip-texto').textContent)
      .toContain('Valor SIS: 19 Ton');

    await click(guardar(container));
    expect(celdasDelPost()).toEqual([
      { periodo: 1, combustible_id: 1, cantidad: 21, detalle: null },
    ]);
    teardown();
  });

  it('Descartar olvida lo editado: esa celda vuelve a ser del server', async () => {
    // Descartar tiene que borrar la marca de "editada", no solo devolver el valor. Si la marca
    // sobrevive, la celda queda clavada al número descartado: la reconciliación del latido
    // siguiente ya no adopta lo que el SIS escribió y el Guardar la manda de vuelta al valor viejo,
    // aunque el operador ya haya dicho que descartaba.
    const { container, teardown } = await render();

    await teclear(inputDe(container, 3, 0), '22');
    await click(container.querySelector('.comb-gavela button'));   // Descartar
    expect(guardar(container).disabled).toBe(true);

    // El latido sale con el buffer ya limpio (es la única condición en que sale, CA-13) y el
    // operador teclea OTRA celda mientras viaja.
    modoManual = true;
    await latido();
    await teclear(inputDe(container, 3, 1), '9');
    await act(async () => {
      cola[0].resolver(respuesta(payload({
        celdas: { 3: { 1: celda({ consumo_id: 301, cantidad: 25 }) } },   // ← el SIS la subió
      })));
    });
    modoManual = false;

    expect(inputDe(container, 3, 0).value).toBe('25');
    await click(guardar(container));
    expect(celdasDelPost()).toEqual([
      { periodo: 3, combustible_id: 2, cantidad: 9, detalle: null },
    ]);
    teardown();
  });

  it('lo editado se olvida al cambiar de fecha (son coordenadas de otro día)', async () => {
    const { container, reprops, teardown } = await render();

    await teclear(inputDe(container, 3, 0), '22');
    await reprops({ fecha: AYER });
    expect(guardar(container).disabled).toBe(true);   // el buffer de ayer llegó limpio

    await teclear(inputDe(container, 1, 8), '4');     // CALIZA de ayer
    await click(guardar(container));
    expect(celdasDelPost()).toEqual([
      { periodo: 1, combustible_id: 9, cantidad: 4, detalle: null },
    ]);
    teardown();
  });

  it('vaciar una celda sigue viajando como cantidad null', async () => {
    // La protección no puede tragarse el vaciado, que es una edición como cualquier otra (C6).
    const { container, teardown } = await render();
    await teclear(inputDe(container, 3, 0), '');
    await click(guardar(container));
    expect(celdasDelPost()).toEqual([{ periodo: 3, combustible_id: 1, cantidad: null }]);
    teardown();
  });
});

// ── CA-38 · El comentario de la celda sobrevive a limpiar y volver a escribir ───────────────────

describe('CA-38 · el detalle de la celda no se borra al corregir la cifra', () => {
  const conNota = () => payload({
    celdas: { 3: { 1: celda({ consumo_id: 301, cantidad: 18.5, detalle: 'Tolva atascada' }) } },
  });

  it('limpiar y volver a escribir conserva el detalle en el body', async () => {
    // H25: vaciar borra la celda del buffer, y volver a teclear la reconstruía desde `{}`. El diff
    // mandaba `detalle: null` y el backend, en su rama de UPDATE, escribía NULL: la nota
    // desaparecía con un 200 que decía "1 actualizado".
    cuerpoGet = conNota();
    const { container, teardown } = await render();
    const input = inputDe(container, 3, 0);

    await teclear(input, '');
    await teclear(input, '20');

    await click(guardar(container));
    expect(celdasDelPost()).toEqual([
      { periodo: 3, combustible_id: 1, cantidad: 20, detalle: 'Tolva atascada' },
    ]);
    teardown();
  });

  it('corregir la cifra de una vez (sin limpiar) también lo conserva', async () => {
    cuerpoGet = conNota();
    const { container, teardown } = await render();

    await teclear(inputDe(container, 3, 0), '20');

    await click(guardar(container));
    expect(celdasDelPost()).toEqual([
      { periodo: 3, combustible_id: 1, cantidad: 20, detalle: 'Tolva atascada' },
    ]);
    teardown();
  });

  it('una celda nueva sigue naciendo sin detalle', async () => {
    // La siembra desde el snapshot no puede inventar metadata donde el server no tiene celda.
    const { container, teardown } = await render();
    await teclear(inputDe(container, 7, 2), '6');
    await click(guardar(container));
    expect(celdasDelPost()).toEqual([
      { periodo: 7, combustible_id: 3, cantidad: 6, detalle: null },
    ]);
    teardown();
  });
});

// ── CA-39 · El lado del popover se decide midiendo ──────────────────────────────────────────────

describe('CA-39 · el popover mide, no cuenta periodos', () => {
  // La aritmética vive en `override.test.js › ladoPopover` (12 casos con rects sintéticos). Acá se
  // prueba el CABLEADO: que el componente mida el banderín contra `.comb-scroll` al abrir y aplique
  // la clase que salga. jsdom no hace layout, así que los dos rects se ponen a mano.
  const CONT = { top: 100, bottom: 500, left: 0, right: 1000 };

  // El wrap y el botón del banderín ocupan exactamente la misma caja de 14×14 (el popover es
  // `position:absolute` y no cuenta para el tamaño del wrap), así que se les pone el mismo rect:
  // el hover mide el wrap y el clic mide el botón.
  function prepararMedicion(container, celdaTd, rectBanderin) {
    conRect(container.querySelector('.comb-scroll'), CONT);
    conRect(celdaTd.querySelector('.comb-override'), rectBanderin);
    return conRect(celdaTd.querySelector('.comb-override-wrap'), rectBanderin);
  }

  it('un banderín pegado al borde inferior abre hacia arriba al hacer clic', async () => {
    const { container, teardown } = await render();
    const td = celdasDe(container, 1)[0];
    const wrap = prepararMedicion(container, td, { top: 470, bottom: 484, left: 40, right: 54 });

    expect(td.querySelector('.comb-tip').classList.contains('comb-tip--arriba')).toBe(false);
    await click(wrap.querySelector('.comb-override'));
    expect(td.querySelector('.comb-tip').classList.contains('comb-tip--arriba')).toBe(true);
    teardown();
  });

  it('un banderín pegado al borde derecho abre hacia la izquierda', async () => {
    const { container, teardown } = await render();
    const td = celdasDe(container, 1)[0];
    const wrap = prepararMedicion(container, td, { top: 120, bottom: 134, left: 940, right: 954 });

    await click(wrap.querySelector('.comb-override'));
    const tip = td.querySelector('.comb-tip');
    expect(tip.classList.contains('comb-tip--izq')).toBe(true);
    expect(tip.classList.contains('comb-tip--arriba')).toBe(false);
    teardown();
  });

  it('el hover también mide: el popover que aparece solo por puntero no queda recortado', async () => {
    const { container, teardown } = await render();
    const td = celdasDe(container, 1)[0];
    const wrap = prepararMedicion(container, td, { top: 470, bottom: 484, left: 940, right: 954 });

    await entrar(wrap);
    const tip = td.querySelector('.comb-tip');
    expect(tip.classList.contains('comb-tip--arriba')).toBe(true);
    expect(tip.classList.contains('comb-tip--izq')).toBe(true);
    expect(tip.classList.contains('open')).toBe(false);   // el hover no lo fija: eso es del clic
    teardown();
  });

  it('P24 con lienzo debajo abre hacia ABAJO: el número de periodo ya no decide', async () => {
    // La regresión que cierra H26. Con la regla vieja (`p >= 19`), P24 abría siempre hacia arriba
    // aunque estuviera arriba del todo por el scroll — contra el `thead` sticky.
    const { container, teardown } = await render();
    const td = celdasDe(container, 24)[0];
    const wrap = prepararMedicion(container, td, { top: 120, bottom: 134, left: 40, right: 54 });

    await click(wrap.querySelector('.comb-override'));
    const tip = td.querySelector('.comb-tip');
    expect(tip.classList.contains('comb-tip--arriba')).toBe(false);
    expect(tip.classList.contains('open')).toBe(true);
    teardown();
  });

  it('el último alimentador con lienzo a la derecha ya no se voltea', async () => {
    const { container, teardown } = await render();
    const td = celdasDe(container, 1)[7];             // ALIM_8
    const wrap = prepararMedicion(container, td, { top: 120, bottom: 134, left: 620, right: 634 });

    await click(wrap.querySelector('.comb-override'));
    expect(td.querySelector('.comb-tip').classList.contains('comb-tip--izq')).toBe(false);
    teardown();
  });

  it('sin medida (jsdom sin layout) el popover se queda en el default del CSS', async () => {
    const { container, teardown } = await render();
    for (const tip of container.querySelectorAll('.comb-tip')) {
      expect(tip.classList.contains('comb-tip--arriba')).toBe(false);
      expect(tip.classList.contains('comb-tip--izq')).toBe(false);
    }
    teardown();
  });
});
