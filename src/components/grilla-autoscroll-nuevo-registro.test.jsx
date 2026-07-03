// @vitest-environment jsdom
//
// Verifica el auto-scroll al crear "+ Nuevo Registro" en GrillaRegistros.
//
// Bug: el borrador se agregaba al final de la lista con scroll, pero el contenedor no bajaba, así que
// el nuevo registro quedaba fuera de vista. Fix: un efecto baja al fondo del contenedor SOLO cuando
// aparece un borrador nuevo (detectado por su `_localId`), no en cada re-render/edición/guardado.
//
// Este test reproduce el MISMO mecanismo (derivación de `draftId` + el efecto con su timing real de
// React) y espía `scrollTo` para comprobar que dispara exactamente en las transiciones correctas.
import { describe, it, expect } from 'vitest';
import { createElement as h, useRef, useEffect, useState, act } from 'react';
import { createRoot } from 'react-dom/client';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Réplica del bloque de auto-scroll de GrillaRegistros, sobre una lista `regs` controlada.
function Lista({ regs }) {
  const scrollRef = useRef(null);
  const draftId = regs.find((r) => !r.registro_id)?._localId || null;
  const prevDraftId = useRef(null);
  useEffect(() => {
    if (draftId && draftId !== prevDraftId.current) {
      const el = scrollRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
    prevDraftId.current = draftId;
  }, [draftId]);

  return h(
    'div',
    { ref: scrollRef, className: 'scroller' },
    regs.map((r) => h('div', { key: r.registro_id || r._localId }, r.detalle || '(borrador)')),
  );
}

function Harness() {
  const [regs, setRegs] = useState([{ registro_id: 1, detalle: 'A' }, { registro_id: 2, detalle: 'B' }]);
  return h(
    'div',
    null,
    h('button', { className: 'add', onClick: () => setRegs((p) => [...p, { _localId: `draft_${p.length}`, _dirty: true }]) }, '+ Nuevo'),
    h('button', { className: 'edit', onClick: () => setRegs((p) => p.map((r) => (r.registro_id ? r : { ...r, detalle: 'editado' }))) }, 'editar'),
    h('button', { className: 'save', onClick: () => setRegs((p) => p.filter((r) => r.registro_id)) }, 'guardar'),
    h(Lista, { regs }),
  );
}

function setup() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const calls = [];
  // jsdom no implementa scroll: instrumentamos scrollTo en el prototipo de Element para capturarlo.
  const original = Element.prototype.scrollTo;
  Element.prototype.scrollTo = function (opts) { calls.push(opts); };
  const root = createRoot(container);
  act(() => { root.render(h(Harness)); });
  const click = (sel) => act(() => {
    container.querySelector(sel).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  const teardown = () => {
    act(() => { root.unmount(); });
    container.remove();
    Element.prototype.scrollTo = original;
  };
  return { calls, click, teardown };
}

describe('GrillaRegistros · auto-scroll al crear registro nuevo', () => {
  it('baja al fondo cuando aparece un borrador nuevo', () => {
    const { calls, click, teardown } = setup();
    expect(calls.length).toBe(0);         // reposo: no scroll
    click('button.add');
    expect(calls.length).toBe(1);         // nuevo borrador → 1 scroll
    expect(calls[0]).toMatchObject({ behavior: 'smooth' });
    teardown();
  });

  it('NO vuelve a bajar al editar el mismo borrador', () => {
    const { calls, click, teardown } = setup();
    click('button.add');
    expect(calls.length).toBe(1);
    click('button.edit');                 // edita un registro existente (mismo draftId)
    expect(calls.length).toBe(1);         // sin scroll adicional
    teardown();
  });

  it('al guardar (borrador desaparece) no baja, y un nuevo borrador vuelve a bajar', () => {
    const { calls, click, teardown } = setup();
    click('button.add');
    expect(calls.length).toBe(1);
    click('button.save');                 // borrador eliminado → draftId null
    expect(calls.length).toBe(1);         // sin scroll
    click('button.add');                  // otro borrador nuevo (id distinto)
    expect(calls.length).toBe(2);         // vuelve a bajar
    teardown();
  });
});
