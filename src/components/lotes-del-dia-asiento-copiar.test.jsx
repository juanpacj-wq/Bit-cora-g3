// @vitest-environment jsdom
//
// D-058 E2 — el asiento en el listado del día y las dos acciones de copiar (REQ-04 §8.1 y §8.3),
// sobre el componente REAL (`LotesDelDia`), no una réplica. Verifica:
//   1. El renglón pinta el `asiento` que llega del backend, COMPLETO (el front no lo arma ni lo
//      recorta: si lo recortara, copiarlo dejaría de servir para lo único que existe).
//   2. El botón del renglón copia SOLO ese asiento, sin la hora.
//   3. El de la cabecera copia el día entero como `HH:MM — asiento`, en el orden de pantalla, y el
//      lote sin hora va SIN prefijo (nunca `null —`).
//   4. Sin `navigator.clipboard` —contexto no seguro, que es lo que pasa por HTTP plano— cae al
//      fallback y copia igual.
//   5. Los dos botones existen sin `puedeCrear`: copiar no es escribir (RN-04.f).
import { describe, it, expect, afterEach } from 'vitest';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import LotesDelDia from './SalaDeMando/LotesDelDia.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// 2026-07-26 16:38 Bogotá (UTC-5, sin DST) — la hora de llamada del ejemplo canónico del insumo.
const HORA_ISO = '2026-07-26T21:38:00.000Z';
const ASIENTO_AUTH = 'Se recibe llamada del CND (J. Pérez) autorizando GEC3 a generar 150 MW del P17 al P19.';
const ASIENTO_SIN_HORA = 'Se declara prueba de GEC3 a 90 MW en el P1.';

function lote(overrides = {}) {
  return {
    lote_id: 'lote-1',
    tipo: 'AUTH',
    tipo_nombre: 'Autorización',
    hora_llamada: HORA_ISO,
    funcionariocnd: 'J. Pérez',
    detalle: null,
    creado_en: '2026-07-26T21:40:00.000Z',
    creado_por: { usuario_id: 7, nombre_completo: 'Operador Uno' },
    periodos: [{ periodo: 17, valor_mw: 150, registro_id: 1, publicado: true }],
    asiento: ASIENTO_AUTH,
    ...overrides,
  };
}

// Portapapeles instrumentado. `navigator.clipboard` no existe en jsdom, así que se define; con
// `presente: false` se prueba el camino sin API segura, donde el componente debe caer al textarea +
// execCommand (tampoco implementado por jsdom: se stubea para poder observarlo).
function instrumentarPortapapeles({ presente = true } = {}) {
  const escrito = [];
  if (presente) {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (texto) => { escrito.push(texto); } },
    });
  } else {
    Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: undefined });
    document.execCommand = () => {
      // El fallback monta un <textarea> con el texto, lo selecciona y dispara el copy del navegador.
      // Se lee del DOM y no de `activeElement` porque el `select()` de jsdom no da foco.
      escrito.push(document.querySelector('textarea')?.value ?? null);
      return true;
    };
  }
  return escrito;
}

function limpiarPortapapeles() {
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: undefined });
  delete document.execCommand;
}

function render({ lotes, puedeCrear = true }) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(h(LotesDelDia, {
      lotes, fecha: '2026-07-26', cargando: false, error: null, puedeCrear,
      onEditar: () => {}, onEliminar: () => {},
    }));
  });
  // El handler de copiar es async (await del portapapeles): sin `await act` el estado de feedback
  // se aplicaría fuera del acto y React avisaría.
  const click = async (el) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };
  const teardown = () => {
    act(() => { root.unmount(); });
    container.remove();
  };
  return { container, click, teardown };
}

afterEach(limpiarPortapapeles);

describe('LotesDelDia · asiento y copiar (D-058 E2)', () => {
  it('pinta el asiento completo que llega del backend', () => {
    const { container, teardown } = render({ lotes: [lote()] });
    expect(container.textContent).toContain(ASIENTO_AUTH);
    // La hora sigue en SU columna, no dentro del asiento.
    expect(container.textContent).toContain('16:38');
    teardown();
  });

  it('el botón del renglón copia solo ese asiento', async () => {
    const escrito = instrumentarPortapapeles();
    const { container, click, teardown } = render({
      lotes: [lote(), lote({ lote_id: 'lote-2', tipo: 'PRUEBA', asiento: ASIENTO_SIN_HORA, hora_llamada: null })],
    });
    const botones = container.querySelectorAll('button[title="Copiar este asiento"]');
    expect(botones.length).toBe(2);
    await click(botones[0]);
    expect(escrito).toEqual([ASIENTO_AUTH]);
    expect(container.textContent).toContain('Copiado');
    teardown();
  });

  it('el botón de la cabecera copia el día entero, con HH:MM y sin prefijo cuando no hay hora', async () => {
    const escrito = instrumentarPortapapeles();
    const { container, click, teardown } = render({
      lotes: [lote(), lote({ lote_id: 'lote-2', tipo: 'PRUEBA', asiento: ASIENTO_SIN_HORA, hora_llamada: null })],
    });
    await click(container.querySelector('button[title^="Copiar todos los eventos"]'));
    expect(escrito).toEqual([`16:38 — ${ASIENTO_AUTH}\n${ASIENTO_SIN_HORA}`]);
    teardown();
  });

  it('sin navigator.clipboard (HTTP plano) el fallback copia igual', async () => {
    const escrito = instrumentarPortapapeles({ presente: false });
    const { container, click, teardown } = render({ lotes: [lote()] });
    await click(container.querySelector('button[title="Copiar este asiento"]'));
    expect(escrito).toEqual([ASIENTO_AUTH]);
    expect(container.textContent).toContain('Copiado');
    teardown();
  });

  it('los botones de copiar existen sin puedeCrear, y los de corregir/eliminar no', () => {
    const { container, teardown } = render({ lotes: [lote()], puedeCrear: false });
    expect(container.querySelector('button[title="Copiar este asiento"]')).toBeTruthy();
    expect(container.querySelector('button[title^="Copiar todos los eventos"]')).toBeTruthy();
    expect(container.querySelector('button[title="Corregir este registro"]')).toBeNull();
    expect(container.querySelector('button[title="Eliminar este registro"]')).toBeNull();
    teardown();
  });
});
