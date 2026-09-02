// @vitest-environment jsdom
/* global process */
//
// D-065 · L08 (CA-20) — el popup de toma de control sobre el componente REAL y el hook REAL.
//
// Lo que fija este archivo:
//   1. La REGLA DE VISIBILIDAD, que es el criterio entero: el popup aparece solo a quien el backend
//      dice (`aplica`), nunca al titular del turno y nunca a quien ya respondió. Los tres excluidos
//      por nombre en CA-20 —Administrador y Debugging, Gerente de Producción, USUARIO DE CONSULTA—
//      llegan como `aplica: false` y por eso hay además un guard estático de que este front NO
//      conoce esos nombres (convención 12: el gating es data-driven, jamás por nombre de cargo).
//   2. La COPIA LITERAL en tuteo (decisión R11). La aserción sobre "¿Deseas tomar el control" existe
//      para que un futuro "¿Desea…" —o un voseo— se ponga rojo acá y no llegue a producción.
//   3. Que el "No" es un `POST /descartar` y no un `setState` local, y que la otra mitad del ciclo
//      (abandonar) es alcanzable desde la UI.
//   4. Que no hay `localStorage`, `sessionStorage` ni tareas recurrentes en ninguno de los dos
//      archivos del lote (CA-23 y el criterio de D-040): una consulta al montar y nada más.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import PopupTomaControl, { modoPopup } from './PopupTomaControl.jsx';
import { useTomaControl } from '../../hooks/useTomaControl.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ── Fixtures con la forma exacta de C5 ──────────────────────────────────────────────────────────

const CARGO = 'Operador de Planta - Sala de Mando';
const TITULAR = { usuario_id: 61, nombre: 'Jefferson Ceballos Sanchez' };
const OTRO = { usuario_id: 77, nombre: 'Marcela Ospina Rivera' };

// Los dos archivos del lote, leídos del disco para los guards estáticos. `import.meta.url` no sirve
// acá: bajo la transformación de vitest no es una URL `file:`, y `readFileSync` la rechaza.
const RAIZ = process.cwd();
const ARCHIVOS_DEL_LOTE = [
  join(RAIZ, 'src/components/Rotacion/PopupTomaControl.jsx'),
  join(RAIZ, 'src/hooks/useTomaControl.js'),
];
// Sin comentarios: ahí sí se nombran los cargos y el almacenamiento, para explicar por qué NO se
// usan. Lo que no puede existir es esa cadena dentro del código.
const leerFuentes = () => ARCHIVOS_DEL_LOTE.map((f) => readFileSync(f, 'utf8')
  .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));

// Las 9 claves del contrato, en su orden. `principal` es SIEMPRE el tope de `pila` (invariante que
// el GATE-O2 §6.7 fija y que este componente asume).
function estadoC5(over = {}) {
  return {
    aplica: true,
    turno_id: 231,
    cargo_id: 8,
    cargo_nombre: CARGO,
    principal: { usuario_id: TITULAR.usuario_id, nombre: TITULAR.nombre },
    soy_principal: false,
    soy_titular: false,
    ya_respondi: false,
    pila: [{ ...TITULAR, es_titular: true }],
    ...over,
  };
}

// El estado que deja un TOMAR propio: soy el tope, no soy titular, y `ya_respondi` quedó en true
// (los tres verbos lo encienden). Es el caso que exige que la rama de abandonar gane sobre él.
function estadoTomado(over = {}) {
  return estadoC5({
    principal: { usuario_id: OTRO.usuario_id, nombre: OTRO.nombre },
    soy_principal: true,
    soy_titular: false,
    ya_respondi: true,
    pila: [{ ...TITULAR, es_titular: true }, { ...OTRO, es_titular: false }],
    ...over,
  });
}

// Error con la forma que arma `useApi` a partir de `{ error, codigo, mensaje }` del backend.
function errorHttp(codigo, mensaje, status = 409) {
  const err = new Error(codigo);
  err.status = status;
  err.codigo = codigo;
  err.body = { error: codigo, codigo, mensaje };
  return err;
}

function diferido() {
  let resolver; let rechazar;
  const promesa = new Promise((res, rej) => { resolver = res; rechazar = rej; });
  return { promesa, resolver, rechazar };
}

// ── Arnés de render ─────────────────────────────────────────────────────────────────────────────

const montados = [];

function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(element); });
  const rerender = (siguiente) => act(() => { root.render(siguiente); });
  const teardown = () => { act(() => { root.unmount(); }); container.remove(); };
  montados.push(teardown);
  return { container, rerender, teardown };
}

const click = (el) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const clickAsync = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };

const botones = (container) => Array.from(container.querySelectorAll('button'));
const boton = (container, texto) => botones(container).find((b) => b.textContent.trim() === texto);

afterEach(() => {
  for (const desmontar of montados.splice(0)) desmontar();
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

// ── CA-20 · Regla de visibilidad ────────────────────────────────────────────────────────────────

describe('CA-20 · quién ve el popup', () => {
  it('modoPopup: el backend manda — aplica, titular, principal y ya_respondi, en ese orden', () => {
    expect(modoPopup(null)).toBe(null);
    expect(modoPopup(undefined)).toBe(null);
    expect(modoPopup(estadoC5({ aplica: false }))).toBe(null);
    expect(modoPopup(estadoC5({ soy_titular: true }))).toBe(null);
    expect(modoPopup(estadoC5({ ya_respondi: true }))).toBe(null);
    expect(modoPopup(estadoC5())).toBe('preguntar');
    // La rama de abandonar gana sobre `ya_respondi` (tomar el control lo enciende); pero NO sobre
    // `soy_titular` ni sobre `aplica`: el titular es el fondo de la pila y no abandona (CA-12).
    expect(modoPopup(estadoTomado())).toBe('abandonar');
    expect(modoPopup(estadoTomado({ soy_titular: true }))).toBe(null);
    expect(modoPopup(estadoTomado({ aplica: false }))).toBe(null);
  });

  it('aplica:false → no renderiza nada', () => {
    const { container } = render(h(PopupTomaControl, { estado: estadoC5({ aplica: false }) }));
    expect(container.textContent).toBe('');
    expect(botones(container)).toHaveLength(0);
  });

  it('ya_respondi:true → no renderiza (ya contestó en este turno)', () => {
    const { container } = render(h(PopupTomaControl, { estado: estadoC5({ ya_respondi: true }) }));
    expect(container.textContent).toBe('');
  });

  it('soy_titular:true → no renderiza (el titular no compite por su propio rol)', () => {
    const { container } = render(h(PopupTomaControl, {
      estado: estadoC5({ soy_titular: true, soy_principal: true }),
    }));
    expect(container.textContent).toBe('');
  });

  it('estado null (todavía cargando) → no renderiza', () => {
    const { container } = render(h(PopupTomaControl, { estado: null }));
    expect(container.textContent).toBe('');
  });

  it('Administrador, Gerente y USUARIO DE CONSULTA llegan como aplica:false y no ven nada', () => {
    for (const cargo of ['Administrador y Debugging', 'Gerente de Producción', 'USUARIO DE CONSULTA']) {
      const { container, teardown } = render(h(PopupTomaControl, {
        estado: estadoC5({ aplica: false, cargo_nombre: cargo, principal: null, pila: [] }),
      }));
      expect(container.textContent).toBe('');
      teardown();
      montados.pop();
    }
  });

  it('guard: el front NO conoce nombres de cargo ni flags de exclusión (convención 12)', () => {
    const fuentes = leerFuentes();
    for (const codigo of fuentes) {
      for (const prohibido of ['Administrador y Debugging', 'Gerente de Producción', 'USUARIO DE CONSULTA', 'es_observador', 'cargo_id ===']) {
        expect(codigo).not.toContain(prohibido);
      }
    }
  });

  it('guard: cero almacenamiento del navegador y cero tareas recurrentes (CA-23, D-040)', () => {
    const fuentes = leerFuentes();
    for (const codigo of fuentes) {
      for (const prohibido of ['localStorage', 'sessionStorage', 'setInterval', 'setTimeout', 'requestAnimationFrame']) {
        expect(codigo).not.toContain(prohibido);
      }
    }
  });
});

// ── CA-20 · La pregunta y su copia ──────────────────────────────────────────────────────────────

describe('CA-20 · la pregunta', () => {
  it('caso feliz: nombra al principal y hace la pregunta en tuteo, literal', () => {
    const { container } = render(h(PopupTomaControl, { estado: estadoC5() }));
    const texto = container.textContent;
    expect(texto).toContain('Toma de control del rol');
    expect(texto).toContain(`Durante este turno el ${CARGO} principal es ${TITULAR.nombre}.`);
    // Aserción literal de la copia (decisión R11): si alguien la pasa a "¿Desea…", esto se pone rojo.
    expect(texto).toContain('¿Deseas tomar el control');
    expect(texto).toContain('¿Deseas tomar el control del rol en este turno?');
    expect(boton(container, 'No')).toBeTruthy();
    expect(boton(container, 'Sí, tomarlo')).toBeTruthy();
  });

  it('la copia no tiene voseo ni trato de usted', () => {
    const { container } = render(h(PopupTomaControl, { estado: estadoC5() }));
    expect(container.textContent).not.toMatch(/Deseás|Querés|tomalo|tenés|hacé|¿Desea\b|usted/i);
  });

  it('principal null (rol sin nadie en el grupo de guardia) → pregunta igual, sin imprimir null', () => {
    const { container } = render(h(PopupTomaControl, {
      estado: estadoC5({ principal: null, pila: [] }),
    }));
    const texto = container.textContent;
    expect(texto).toContain(`Durante este turno ningún ${CARGO} tiene el control del rol.`);
    expect(texto).toContain('¿Deseas tomar el control del rol en este turno?');
    expect(texto).not.toMatch(/null|undefined/);
  });

  it('es accesible como diálogo modal', () => {
    const { container } = render(h(PopupTomaControl, { estado: estadoC5() }));
    const dialogo = container.querySelector('[role="dialog"]');
    expect(dialogo).toBeTruthy();
    expect(dialogo.getAttribute('aria-modal')).toBe('true');
  });
});

// ── CA-20 · El "No" es un DESCARTAR real ────────────────────────────────────────────────────────

describe('CA-20 · las acciones', () => {
  it('"No" dispara onDescartar (no un estado local) y no toca onTomar', async () => {
    const onDescartar = vi.fn(async () => {});
    const onTomar = vi.fn(async () => {});
    const onCerrar = vi.fn();
    const { container } = render(h(PopupTomaControl, {
      estado: estadoC5(), onDescartar, onTomar, onCerrar,
    }));
    await clickAsync(boton(container, 'No'));
    expect(onDescartar).toHaveBeenCalledTimes(1);
    expect(onTomar).not.toHaveBeenCalled();
    expect(onCerrar).toHaveBeenCalledTimes(1);
    // Tras responder, el popup deja de preguntar en este montaje. La verdad duradera la guarda el
    // backend (`ya_respondi`), no esto.
    expect(container.textContent).toBe('');
  });

  it('"Sí, tomarlo" dispara onTomar', async () => {
    const onTomar = vi.fn(async () => {});
    const { container } = render(h(PopupTomaControl, { estado: estadoC5(), onTomar }));
    await clickAsync(boton(container, 'Sí, tomarlo'));
    expect(onTomar).toHaveBeenCalledTimes(1);
  });

  it('con el POST en vuelo los dos botones quedan deshabilitados y no se envía dos veces', async () => {
    const d = diferido();
    const onTomar = vi.fn(() => d.promesa);
    const { container } = render(h(PopupTomaControl, { estado: estadoC5(), onTomar }));

    await clickAsync(boton(container, 'Sí, tomarlo'));
    expect(onTomar).toHaveBeenCalledTimes(1);
    const enVuelo = botones(container);
    expect(enVuelo.every((b) => b.disabled)).toBe(true);
    expect(container.textContent).toContain('Procesando…');

    // Un segundo clic mientras viaja el primero no debe emitir otro POST.
    await clickAsync(enVuelo.find((b) => b.textContent.trim() === 'Procesando…'));
    expect(onTomar).toHaveBeenCalledTimes(1);

    await act(async () => { d.resolver({}); });
    expect(container.textContent).toBe('');
  });
});

// ── CA-20 · La otra mitad del ciclo ─────────────────────────────────────────────────────────────

describe('CA-20 · abandonar el control', () => {
  it('soy_principal && !soy_titular → no pregunta: ofrece "Abandonar el control"', () => {
    const { container } = render(h(PopupTomaControl, { estado: estadoTomado() }));
    const texto = container.textContent;
    expect(texto).not.toContain('¿Deseas tomar el control');
    expect(texto).toContain(`Tienes el control del rol de ${CARGO} en este turno.`);
    expect(boton(container, 'Abandonar el control')).toBeTruthy();
    expect(boton(container, 'Cerrar')).toBeTruthy();
    expect(boton(container, 'Sí, tomarlo')).toBeUndefined();
  });

  it('el botón dispara onAbandonar; "Cerrar" solo cierra', async () => {
    const onAbandonar = vi.fn(async () => {});
    const onCerrar = vi.fn();
    const { container } = render(h(PopupTomaControl, { estado: estadoTomado(), onAbandonar, onCerrar }));

    click(boton(container, 'Cerrar'));
    expect(onCerrar).toHaveBeenCalledTimes(1);
    expect(onAbandonar).not.toHaveBeenCalled();

    const { container: c2 } = render(h(PopupTomaControl, { estado: estadoTomado(), onAbandonar, onCerrar }));
    await clickAsync(boton(c2, 'Abandonar el control'));
    expect(onAbandonar).toHaveBeenCalledTimes(1);
  });

  // GATE-O4 (CR4-1): el caso de arriba miraba SOLO que se llamara al callback, y por eso pasaba en
  // verde mientras el overlay se quedaba en pantalla. Lo que importa es que el diálogo DESAPAREZCA:
  // el padre cablea `onCerrar` a un no-op (lo correcto: el dueño de "no repreguntar en este montaje"
  // es este componente), así que si el botón no pone `cerrado` no hay ninguna otra salida —el
  // overlay es `fixed inset-0 z-50`, sin clic en el fondo ni Escape—, `soy_principal` sostiene el
  // modo `abandonar` durante todo el turno y un F5 lo vuelve a abrir. La app queda tapada justo
  // para quien acaba de tomar el control.
  it('CR4-1 · "Cerrar" quita el diálogo aunque el padre no haga nada con el aviso', () => {
    const { container } = render(h(PopupTomaControl, {
      estado: estadoTomado(), onAbandonar: vi.fn(), onCerrar: () => {},
    }));
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();

    click(boton(container, 'Cerrar'));

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toBe('');
  });
});

// ── CA-20 · La pila ─────────────────────────────────────────────────────────────────────────────

describe('CA-20 · la pila', () => {
  it('con más de un elemento muestra "Antes lo tenía" y marca al titular', () => {
    const { container } = render(h(PopupTomaControl, { estado: estadoTomado() }));
    const texto = container.textContent;
    expect(texto).toContain('Antes lo tenía');
    expect(texto).toContain(TITULAR.nombre);
    expect(texto).toContain('titular');
  });

  it('con un solo elemento no muestra la pila', () => {
    const { container } = render(h(PopupTomaControl, { estado: estadoC5() }));
    expect(container.textContent).not.toContain('Antes lo tenía');
  });

  it('los anteriores van del más reciente al más antiguo', () => {
    const tercero = { usuario_id: 90, nombre: 'Andrés Villa Mejía' };
    const { container } = render(h(PopupTomaControl, {
      estado: estadoTomado({
        principal: { usuario_id: tercero.usuario_id, nombre: tercero.nombre },
        pila: [{ ...TITULAR, es_titular: true }, { ...OTRO, es_titular: false }, { ...tercero, es_titular: false }],
      }),
    }));
    const nombres = Array.from(container.querySelectorAll('li')).map((li) => li.textContent);
    expect(nombres[0]).toContain(OTRO.nombre);
    expect(nombres[1]).toContain(TITULAR.nombre);
  });
});

// ── CA-20 · Los 409 ─────────────────────────────────────────────────────────────────────────────

describe('CA-20 · un 409 se muestra y deja de preguntar', () => {
  it('control_ocupado: muestra el mensaje del backend y al aceptar vuelve a ofrecerse', async () => {
    const mensaje = 'Otra persona está tomando o abandonando este rol justo ahora. Intenta de nuevo en unos segundos.';
    const onTomar = vi.fn(async () => { throw errorHttp('control_ocupado', mensaje); });
    const onCerrar = vi.fn();
    const { container } = render(h(PopupTomaControl, { estado: estadoC5(), onTomar, onCerrar }));

    await clickAsync(boton(container, 'Sí, tomarlo'));
    expect(container.textContent).toContain('Hay otra toma en curso');
    expect(container.textContent).toContain(mensaje);
    expect(container.textContent).not.toContain('¿Deseas tomar el control');
    expect(onCerrar).not.toHaveBeenCalled();

    // El `control_ocupado` no cambió nada en el server: la pregunta sigue aplicando.
    click(boton(container, 'Entendido'));
    expect(onCerrar).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('¿Deseas tomar el control del rol en este turno?');
  });

  it('turno_cerrado: el aviso sobrevive al refresco que deja aplica:false', async () => {
    const mensaje = 'El turno de esta unidad está cerrado. Un Jefe de Turno debe reabrirlo para volver a registrar.';
    const onTomar = vi.fn(async () => { throw errorHttp('turno_cerrado', mensaje); });
    const { container, rerender } = render(h(PopupTomaControl, { estado: estadoC5(), onTomar }));

    await clickAsync(boton(container, 'Sí, tomarlo'));
    expect(container.textContent).toContain('El turno se cerró');
    expect(container.textContent).toContain(mensaje);

    // Así queda el estado tras el refresco que hace el hook: sin turno, el popup ya no aplica. El
    // aviso no puede desaparecer con él, o nadie llega a leer por qué falló.
    rerender(h(PopupTomaControl, { estado: estadoC5({ aplica: false, turno_id: null }), onTomar }));
    expect(container.textContent).toContain('El turno se cerró');

    click(boton(container, 'Entendido'));
    expect(container.textContent).toBe('');
  });

  it('un codigo desconocido cae al encabezado genérico, sin parsear el texto', async () => {
    const onTomar = vi.fn(async () => { throw errorHttp('db_no_disponible', 'La base de datos no está disponible.', 503); });
    const { container } = render(h(PopupTomaControl, { estado: estadoC5(), onTomar }));
    await clickAsync(boton(container, 'Sí, tomarlo'));
    expect(container.textContent).toContain('No se pudo completar la acción');
    expect(container.textContent).toContain('La base de datos no está disponible.');
  });
});

// ── CA-20 / CA-23 · El hook, contra el `fetch` real de useApi ───────────────────────────────────

describe('useTomaControl', () => {
  let llamadas;
  let cuerpoEstado;
  let fallaPost;

  function respuesta(cuerpo, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => cuerpo, headers: new Headers() };
  }

  beforeEach(() => {
    llamadas = [];
    cuerpoEstado = estadoC5();
    fallaPost = null;
    globalThis.fetch = vi.fn(async (url, opciones) => {
      const u = String(url);
      llamadas.push({ url: u, metodo: opciones?.method ?? 'GET', body: opciones?.body });
      if (opciones?.method === 'POST') {
        if (fallaPost) return respuesta(fallaPost, 409);
        return respuesta(estadoTomado());
      }
      return respuesta(cuerpoEstado);
    });
  });

  let ultimo = null;
  function Arnes({ ready = true, plantaId = 'GEC3' }) {
    ultimo = useTomaControl(ready, plantaId);
    return null;
  }

  const montar = async (props = {}) => {
    const r = render(h(Arnes, props));
    await act(async () => {});
    return r;
  };

  const gets = () => llamadas.filter((l) => l.metodo === 'GET');
  const posts = () => llamadas.filter((l) => l.metodo === 'POST');

  it('una sola consulta al montar, y ninguna más por su cuenta (CA-23)', async () => {
    await montar();
    expect(gets()).toHaveLength(1);
    expect(gets()[0].url).toContain('/api/rotacion/control/estado');
    expect(ultimo.estado).toEqual(estadoC5());

    // Sin tareas recurrentes: por más ciclos de render que pasen, no sale otra petición.
    await act(async () => {});
    await act(async () => {});
    expect(llamadas).toHaveLength(1);
  });

  it('no toca localStorage ni sessionStorage en ningún momento', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const del = vi.spyOn(Storage.prototype, 'removeItem');
    await montar();
    await act(async () => { await ultimo.descartar(); });
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('no arranca hasta que la sesión está lista', async () => {
    await montar({ ready: false });
    expect(llamadas).toHaveLength(0);
    expect(ultimo.estado).toBe(null);
  });

  it('tomar(): POST sin cuerpo y adopta el estado devuelto, sin un GET extra', async () => {
    await montar();
    await act(async () => { await ultimo.tomar(); });
    expect(posts()).toHaveLength(1);
    expect(posts()[0].url).toContain('/api/rotacion/control/tomar');
    expect(posts()[0].body).toBeUndefined();
    expect(gets()).toHaveLength(1);          // el del montaje, y ninguno más
    expect(ultimo.estado.soy_principal).toBe(true);
  });

  it('abandonar() y descartar() pegan a su propia ruta', async () => {
    await montar();
    await act(async () => { await ultimo.abandonar(); });
    await act(async () => { await ultimo.descartar(); });
    expect(posts().map((p) => p.url.replace(/.*\/control\//, ''))).toEqual(['abandonar', 'descartar']);
  });

  it('un 409 refresca el estado y relanza el error con su codigo', async () => {
    await montar();
    fallaPost = { error: 'ya_es_principal', codigo: 'ya_es_principal', mensaje: 'Ya tienes el control de este rol en el turno en curso.' };
    let capturado = null;
    await act(async () => {
      try { await ultimo.tomar(); } catch (e) { capturado = e; }
    });
    expect(capturado).toBeTruthy();
    expect(capturado.codigo).toBe('ya_es_principal');
    expect(capturado.body.mensaje).toContain('Ya tienes el control');
    // El refresco es lo que deja la pantalla diciendo la verdad del server tras el fallo.
    expect(gets()).toHaveLength(2);
  });

  // ── CR3-2 · la respuesta obsoleta ─────────────────────────────────────────────────────────────
  //
  // Hasta la O3 `refrescar()` solo se protegía con `desmontadoRef`, y el efecto lo RESETEA a false
  // al principio para la unidad nueva: la lectura de la unidad vieja aterrizaba después y pisaba el
  // estado. El daño no es cosmético — el popup queda con el `turno_id` y el `principal` de la
  // unidad anterior y su `useEffect([turnoId])` lo VUELVE A ABRIR, ofreciendo tomar el control de un
  // rol de otra planta. Hoy nadie lo monta; L10 lo monta en esta misma ola.
  //
  // Un `fetch` que deja cada petición en vuelo es lo único que reproduce el cruce: con respuestas
  // ya resueltas el orden de llegada lo decide el microtask queue y siempre gana la última.
  function fetchEnVuelo() {
    const pendientes = [];
    globalThis.fetch = vi.fn(async (url, opciones) => {
      llamadas.push({ url: String(url), metodo: opciones?.method ?? 'GET', body: opciones?.body });
      const d = diferido();
      pendientes.push(d);
      return d.promesa;
    });
    return pendientes;
  }

  it('CR3-2 · la lectura de la unidad anterior llega TARDE y no pisa a la nueva', async () => {
    const pendientes = fetchEnVuelo();

    const { rerender } = render(h(Arnes, { plantaId: 'GEC3' }));
    await act(async () => {});
    expect(gets()).toHaveLength(1);

    rerender(h(Arnes, { plantaId: 'GEC32' }));
    expect(gets()).toHaveLength(2);

    // Responde la NUEVA…
    await act(async () => { pendientes[1].resolver(respuesta(estadoC5({ turno_id: 999 }))); });
    expect(ultimo.estado.turno_id).toBe(999);

    // …y después la VIEJA, que ya no manda: es de otra planta.
    await act(async () => { pendientes[0].resolver(respuesta(estadoC5({ turno_id: 111 }))); });
    expect(ultimo.estado.turno_id).toBe(999);
  });

  it('CR3-2 · la lectura de la unidad anterior llega ANTES y tampoco se muestra, ni apaga el indicador', async () => {
    const pendientes = fetchEnVuelo();

    const { rerender } = render(h(Arnes, { plantaId: 'GEC3' }));
    await act(async () => {});
    rerender(h(Arnes, { plantaId: 'GEC32' }));
    expect(ultimo.estado).toBe(null);
    expect(ultimo.cargando).toBe(true);

    await act(async () => { pendientes[0].resolver(respuesta(estadoC5({ turno_id: 111 }))); });
    expect(ultimo.estado).toBe(null);
    // El `.finally` de la promesa vieja apagaba el `cargando` de la petición NUEVA, que sigue en
    // vuelo: la pantalla se veía cargada con `estado` en null.
    expect(ultimo.cargando).toBe(true);

    await act(async () => { pendientes[1].resolver(respuesta(estadoC5({ turno_id: 999 }))); });
    expect(ultimo.estado.turno_id).toBe(999);
    expect(ultimo.cargando).toBe(false);
  });

  it('cambiar de unidad reconsulta y no deja ver el estado de la anterior', async () => {
    const { rerender } = await montar({ plantaId: 'GEC3' });
    expect(gets()).toHaveLength(1);

    // El cambio de unidad en caliente NO desmonta el componente (D-054): la invalidación es por
    // identidad. Mostrar el rol de la otra unidad se vería consistente y sería falso.
    let enVuelo = null;
    globalThis.fetch = vi.fn(async (url, opciones) => {
      llamadas.push({ url: String(url), metodo: opciones?.method ?? 'GET', body: opciones?.body });
      const d = diferido();
      enVuelo = d;
      return d.promesa;
    });
    rerender(h(Arnes, { plantaId: 'GEC32' }));
    expect(gets()).toHaveLength(2);
    expect(ultimo.estado).toBe(null);

    await act(async () => { enVuelo.resolver(respuesta(estadoC5({ turno_id: 999 }))); });
    expect(ultimo.estado.turno_id).toBe(999);
  });
});
