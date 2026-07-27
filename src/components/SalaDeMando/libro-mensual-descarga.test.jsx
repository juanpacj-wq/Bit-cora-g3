// @vitest-environment jsdom
//
// D-058 E9 (REQ-06) — la barra del libro mensual, sobre el componente REAL `SalaDeMandoGrid`:
//   1. Sin `puedeCrear` no hay selector ni botón (criterio 2 de REQ-06). Es la cara front del 403
//      del backend: acá el control ni siquiera se ofrece, allá se rechaza igual si alguien se evade.
//   2. Con `puedeCrear` el selector arranca en el mes EN CURSO (Bogotá) y lo lleva de tope (`max`):
//      el futuro no se puede pedir ni con el calendario nativo.
//   3. Descargar pega en `/api/sala-de-mando/reporte-mensual?mes=…` **con la cookie de sesión**
//      (`credentials: 'include'`) — el endpoint vive tras `requireEntra` y abrir la URL a secas
//      devolvería 401 — y el archivo se guarda con el nombre que mandó el `Content-Disposition`.
//   4. Cambiar el mes avisa al dashboard (`onMesChange`), que es quien lo escribe en el hash.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import SalaDeMandoGrid from './SalaDeMandoGrid.jsx';
import { getCurrentMonthBogota } from '../../utils/fecha';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOMBRE_ARCHIVO = '2026_06_OPG3-F03 Estado G3 y eventos diarios de operación.xlsx';

// Respuesta mínima con la forma que consumen `useApi` (JSON) y la descarga (blob + headers).
function respuestaJson(cuerpo) {
  return { ok: true, status: 200, json: async () => cuerpo, headers: new Headers() };
}
function respuestaLibro() {
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob(['PK'], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    headers: new Headers({
      'Content-Disposition':
        `attachment; filename="2026_06_OPG3-F03 Estado G3 y eventos diarios de operacion.xlsx"; ` +
        `filename*=UTF-8''${encodeURIComponent(NOMBRE_ARCHIVO)}`,
    }),
  };
}

let llamadas;
let descargas;
let clickOriginal;

beforeEach(() => {
  llamadas = [];
  descargas = [];
  globalThis.fetch = vi.fn(async (url, opciones) => {
    llamadas.push({ url: String(url), opciones });
    if (String(url).includes('/reporte-mensual')) return respuestaLibro();
    return respuestaJson({ lotes: [] });
  });
  // jsdom no implementa ni los object URL ni la navegación del ancla. Se interceptan los dos: el
  // segundo, además, deja ver con qué nombre se habría guardado el archivo.
  URL.createObjectURL = vi.fn(() => 'blob:libro');
  URL.revokeObjectURL = vi.fn();
  clickOriginal = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function interceptado() {
    descargas.push({ href: this.href, nombre: this.download });
  };
});

afterEach(() => {
  window.HTMLAnchorElement.prototype.click = clickOriginal;
  vi.restoreAllMocks();
});

async function render(props) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(h(SalaDeMandoGrid, {
      bitacora: { codigo: 'MAND', bitacora_id: 3, nombre: 'Operación 24h' },
      plantaId: 'GEC3',
      showToast: () => {},
      onError: () => {},
      ...props,
    }));
  });
  const click = async (el) => act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  const type = async (el, value) => act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const teardown = () => {
    act(() => { root.unmount(); });
    container.remove();
  };
  return { container, click, type, teardown };
}

describe('SalaDeMandoGrid · libro mensual F03 (D-058 E9)', () => {
  it('sin puedeCrear no se pinta el selector ni el botón (criterio 2)', async () => {
    const { container, teardown } = await render({ puedeCrear: false, mes: '2026-06' });
    expect(container.querySelector('input[type="month"]')).toBeNull();
    expect(container.textContent).not.toContain('Libro mensual');
    // La grilla sí está: lo que desaparece es la descarga, no el apartado.
    expect(container.textContent).toContain('Autorización');
    teardown();
  });

  it('con puedeCrear el selector arranca en el mes en curso y lo lleva de tope', async () => {
    const mesActual = getCurrentMonthBogota();
    const { container, teardown } = await render({ puedeCrear: true, mes: undefined });
    const input = container.querySelector('input[type="month"]');
    expect(input).toBeTruthy();
    expect(input.value).toBe(mesActual);
    expect(input.getAttribute('max')).toBe(mesActual);
    teardown();
  });

  it('Descargar pide el mes seleccionado con la cookie de sesión y guarda el nombre del formato', async () => {
    const { container, click, teardown } = await render({ puedeCrear: true, mes: '2026-06' });
    const boton = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Descargar'));
    expect(boton).toBeTruthy();
    await click(boton);

    const descarga = llamadas.find((l) => l.url.includes('/reporte-mensual'));
    expect(descarga).toBeTruthy();
    expect(descarga.url).toContain('mes=2026-06');
    expect(descarga.opciones?.credentials).toBe('include');
    expect(descargas).toEqual([{ href: 'blob:libro', nombre: NOMBRE_ARCHIVO }]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:libro');
    teardown();
  });

  it('cambiar el mes avisa al dashboard, que es quien lo escribe en el hash', async () => {
    const elegidos = [];
    const { container, type, teardown } = await render({
      puedeCrear: true, mes: '2026-06', onMesChange: (m) => elegidos.push(m),
    });
    await type(container.querySelector('input[type="month"]'), '2026-05');
    expect(elegidos).toEqual(['2026-05']);
    teardown();
  });
});
