import { useRef, useLayoutEffect, useCallback } from 'react';

export function useFlipReorder(items, idKey = 'id', duration = 220) {
  const nodesRef = useRef(new Map());
  const prevRectsRef = useRef(new Map());

  const registerNode = useCallback((id, node) => {
    if (node) nodesRef.current.set(id, node);
    else nodesRef.current.delete(id);
  }, []);

  useLayoutEffect(() => {
    const prev = prevRectsRef.current;
    const next = new Map();

    for (const [id, node] of nodesRef.current) {
      const rect = node.getBoundingClientRect();
      next.set(id, rect);
      const before = prev.get(id);
      if (before) {
        const dx = before.left - rect.left;
        const dy = before.top - rect.top;
        if (dx !== 0 || dy !== 0) {
          node.style.transition = 'none';
          node.style.transform = `translate(${dx}px, ${dy}px)`;
          // Force reflow then release
          // eslint-disable-next-line no-unused-expressions
          node.offsetWidth;
          requestAnimationFrame(() => {
            node.style.transition = `transform ${duration}ms ease-out`;
            node.style.transform = '';
          });
        }
      }
    }
    prevRectsRef.current = next;
  }, [items]);

  return registerNode;
}
