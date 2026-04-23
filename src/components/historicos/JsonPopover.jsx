import { useEffect, useRef, useState } from 'react';
import { Users, FileJson, X } from 'lucide-react';

const iniciales = (nombre = '') =>
  nombre.trim().split(/\s+/).slice(0, 2).map((n) => n[0]).join('').toUpperCase() || '?';

const parseJson = (raw) => {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return undefined; }
};

function PopoverPanel({ anchorRect, onClose, children }) {
  const panelRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!anchorRect) return;
    const panel = panelRef.current;
    const pw = panel?.offsetWidth ?? 280;
    const ph = panel?.offsetHeight ?? 200;
    const margin = 8;
    let left = anchorRect.left;
    let top = anchorRect.bottom + margin;
    if (left + pw > window.innerWidth - margin) left = window.innerWidth - pw - margin;
    if (left < margin) left = margin;
    if (top + ph > window.innerHeight - margin) top = anchorRect.top - ph - margin;
    setPos({ top: Math.max(margin, top), left });
  }, [anchorRect]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onClick = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      role="dialog"
      style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 60 }}
      className="w-72 max-h-80 overflow-auto bg-white rounded-xl shadow-2xl border border-gray-200 animate-scale-in"
    >
      {children}
    </div>
  );
}

function UsuariosContent({ items, onClose }) {
  return (
    <>
      <div className="sticky top-0 bg-white flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
        <div className="text-xs uppercase tracking-wide font-semibold text-gray-500">
          Usuarios ({items.length})
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-400">
          <X size={14} />
        </button>
      </div>
      {items.length === 0 ? (
        <div className="px-4 py-6 text-sm text-gray-400 text-center">Sin datos</div>
      ) : (
        <ul className="divide-y divide-gray-100">
          {items.map((u) => (
            <li key={u.usuario_id} className="px-4 py-2.5 flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white shrink-0"
                style={{ backgroundColor: '#006f36' }}>
                {iniciales(u.nombre_completo)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-gray-800 truncate">{u.nombre_completo}</div>
                <div className="text-xs text-gray-400">ID {u.usuario_id}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function CamposContent({ obj, onClose }) {
  const entries = obj && typeof obj === 'object' ? Object.entries(obj) : [];
  return (
    <>
      <div className="sticky top-0 bg-white flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
        <div className="text-xs uppercase tracking-wide font-semibold text-gray-500">
          Campos ({entries.length})
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-400">
          <X size={14} />
        </button>
      </div>
      {entries.length === 0 ? (
        <div className="px-4 py-6 text-sm text-gray-400 text-center">Sin datos</div>
      ) : (
        <table className="w-full text-sm">
          <tbody className="divide-y divide-gray-100">
            {entries.map(([k, v]) => (
              <tr key={k}>
                <td className="px-4 py-2 font-mono text-xs text-gray-500 align-top whitespace-nowrap">{k}</td>
                <td className="px-4 py-2 text-gray-800 break-words">
                  {v === null || v === undefined ? <span className="text-gray-300">—</span>
                    : typeof v === 'object' ? <code className="text-xs">{JSON.stringify(v)}</code>
                    : String(v)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export function JsonPopover({ json, variant, emptyLabel }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const btnRef = useRef(null);
  const parsed = parseJson(json);

  const invalid = parsed === undefined;
  const items = variant === 'usuarios' ? (Array.isArray(parsed) ? parsed : []) : [];
  const count = variant === 'usuarios'
    ? items.length
    : (parsed && typeof parsed === 'object' ? Object.keys(parsed).length : 0);

  const Icon = variant === 'usuarios' ? Users : FileJson;
  const colorClass = variant === 'usuarios'
    ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
    : 'bg-sky-50 text-sky-700 hover:bg-sky-100';

  const handleOpen = () => {
    if (!btnRef.current) return;
    setRect(btnRef.current.getBoundingClientRect());
    setOpen(true);
  };

  if (invalid) {
    return <span className="text-xs text-red-500">(inválido)</span>;
  }

  if (count === 0) {
    return <span className="text-xs text-gray-300">{emptyLabel || '—'}</span>;
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleOpen}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-semibold transition-colors ${colorClass} focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-emerald-400`}
      >
        <Icon size={12} />
        <span>{count}</span>
      </button>
      {open && (
        <PopoverPanel anchorRect={rect} onClose={() => setOpen(false)}>
          {variant === 'usuarios'
            ? <UsuariosContent items={items} onClose={() => setOpen(false)} />
            : <CamposContent obj={parsed} onClose={() => setOpen(false)} />}
        </PopoverPanel>
      )}
    </>
  );
}
