// ============================================================
// Bitácoras Gecelca3 — conectado a backend (localhost:3002)
// React + Tailwind + Lucide
// ============================================================

import React, { useState, useMemo, useCallback, useEffect } from "react";
import {
  LogIn, LogOut, Clock, Plus, Save, Trash2, Lock, CheckCircle2,
  AlertTriangle, X, ChevronDown, Search, Filter, FileText,
  Activity, Flame, Droplets, Zap, Gauge, Cpu, FlaskConical, Leaf,
  Settings, FileCheck, Edit3, Eye, XCircle, Check,
} from "lucide-react";
import { useAuth } from "./hooks/useAuth";
import { useCatalogos } from "./hooks/useCatalogos";
import { useRegistros } from "./hooks/useRegistros";
import { useCierre } from "./hooks/useCierre";

const COLORS = {
  greenPrimary: "#31a354", greenDark: "#006f36",
  blueDark: "#003566", blueDeep: "#001d3d", blueDeepest: "#011027",
  red: "#DC3545", yellow: "#FFC107",
  grayLight: "#f8f9fa", grayMid: "#e9ecef", grayBorder: "#dee2e6",
  grayText: "#6c757d", white: "#ffffff",
};

const ICON_MAP = {
  Activity, Settings, Flame, Droplets, Gauge, Zap, Cpu,
  FlaskConical, Leaf, FileCheck,
};

const getLocalISOString = (date = new Date()) => {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const formatFechaHora = (isoStr) => {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  return d.toLocaleString("es-CO", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
};

const getTurnoLabel = (turno) => (turno === 1 || turno === "1" ? "Turno 1" : "Turno 2");
const getTurnoActualNum = () => (new Date().getHours() < 12 ? 1 : 2);

const iniciales = (nombre = "") =>
  nombre.trim().split(/\s+/).slice(0, 2).map((n) => n[0]).join("").toUpperCase() || "?";

const parseSnapshot = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw) || []; } catch { return []; }
};

const joinNombres = (arr) => arr.map((u) => u.nombre_completo).join(", ");

const parseDefinicionCampos = (def) => {
  if (!def) return [];
  if (Array.isArray(def)) return def;
  try { return JSON.parse(def) || []; } catch { return []; }
};

const getCamposExtraEditables = (def) =>
  parseDefinicionCampos(def).filter((c) => c && c.tipo && c.tipo !== "auto");

const parseCamposExtra = (ce) => {
  if (!ce) return {};
  if (typeof ce === "object") return ce;
  try { return JSON.parse(ce) || {}; } catch { return {}; }
};

const labelCampo = (c) => c.label || c.campo;

const formatValorCampo = (v, tipo) => {
  if (v === null || v === undefined || v === "") return "";
  if (tipo === "float" || tipo === "int") return String(v);
  return String(v);
};

// ============================================================
// UI helpers
// ============================================================

function Toast({ message, type, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 3500);
    return () => clearTimeout(t);
  }, [onClose]);

  const bgColor = type === "success" ? "bg-emerald-600" : type === "error" ? "bg-red-600" : "bg-amber-500";
  const IconComp = type === "success" ? Check : type === "error" ? XCircle : AlertTriangle;

  return (
    <div className={`fixed top-6 right-6 z-50 ${bgColor} text-white px-5 py-3 rounded-xl shadow-2xl flex items-center gap-3 animate-slide-in min-w-72`}>
      <IconComp size={20} />
      <span className="text-sm font-medium">{message}</span>
      <button onClick={onClose} className="ml-auto hover:opacity-70 transition-opacity">
        <X size={16} />
      </button>
    </div>
  );
}

function ConfirmModal({ open, title, message, confirmLabel, confirmColor, onConfirm, onCancel, icon: IconProp }) {
  if (!open) return null;
  const btnClass = confirmColor === "red"
    ? "bg-red-600 hover:bg-red-700"
    : confirmColor === "green"
    ? "bg-emerald-600 hover:bg-emerald-700"
    : "bg-blue-700 hover:bg-blue-800";

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden animate-scale-in">
        <div className="px-6 pt-6 pb-4 flex items-start gap-4">
          {IconProp && (
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${
              confirmColor === "red" ? "bg-red-100 text-red-600"
              : confirmColor === "green" ? "bg-emerald-100 text-emerald-600"
              : "bg-blue-100 text-blue-700"
            }`}>
              <IconProp size={24} />
            </div>
          )}
          <div>
            <h3 className="text-lg font-bold text-gray-900">{title}</h3>
            <p className="text-sm text-gray-500 mt-1">{message}</p>
          </div>
        </div>
        <div className="px-6 pb-6 flex gap-3 justify-end">
          <button onClick={onCancel} className="px-5 py-2.5 rounded-xl text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 transition-colors">
            Cancelar
          </button>
          <button onClick={onConfirm} className={`px-5 py-2.5 rounded-xl text-sm font-medium text-white ${btnClass} transition-colors`}>
            {confirmLabel || "Confirmar"}
          </button>
        </div>
      </div>
    </div>
  );
}

function EstadoBadge({ estado }) {
  const config = {
    Borrador: { bg: "bg-amber-100", text: "text-amber-800", dot: "bg-amber-500" },
    Cerrado: { bg: "bg-blue-100", text: "text-blue-800", dot: "bg-blue-500" },
    "En Desarrollo": { bg: "bg-amber-100", text: "text-amber-800", dot: "bg-amber-500" },
    Cerrada: { bg: "bg-blue-100", text: "text-blue-800", dot: "bg-blue-500" },
    "Sin actividad": { bg: "bg-gray-100", text: "text-gray-600", dot: "bg-gray-400" },
  };
  const c = config[estado] || config["Sin actividad"];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${c.bg} ${c.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {estado}
    </span>
  );
}

// ============================================================
// Login (email/password → planta → cargo)
// ============================================================

function LoginScreen({ auth, plantas, cargos, onReady, showToast }) {
  const [paso, setPaso] = useState("credenciales"); // 'credenciales' | 'planta' | 'cargo'
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [plantaSel, setPlantaSel] = useState(null);

  const handleLogin = async (e) => {
    e.preventDefault();
    try {
      await auth.login(email, password);
      setPaso("planta");
    } catch (err) {
      showToast(err.message || "Error al iniciar sesión", "error");
    }
  };

  const handleSelectCargo = async (cargo) => {
    try {
      await auth.selectContext(plantaSel, cargo.cargo_id);
      onReady();
    } catch (err) {
      showToast(err.message || "Error al seleccionar contexto", "error");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center"
      style={{ background: `linear-gradient(135deg, ${COLORS.blueDeepest} 0%, ${COLORS.blueDeep} 40%, ${COLORS.blueDark} 100%)` }}>
      <div className="bg-white rounded-3xl shadow-2xl p-10 max-w-md w-full mx-4">
        <div className="text-center mb-8">
          <img src="/G3 blanco.png" alt="Gecelca3" className="h-16 mx-auto mb-4" onError={(e) => { e.target.style.display = "none"; }} />
          <h1 className="text-2xl font-bold" style={{ color: COLORS.blueDeep }}>Bitácoras de Planta</h1>
          <p className="text-gray-500 text-sm mt-1">Sistema de Registro Operativo — Gecelca3</p>
        </div>

        {paso === "credenciales" && (
          <form onSubmit={handleLogin} className="space-y-4">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Inicia sesión</p>
            <input
              type="email" required placeholder="Correo corporativo"
              value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 outline-none text-sm"
            />
            <input
              type="password" required placeholder="Contraseña"
              value={password} onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 outline-none text-sm"
            />
            <button
              type="submit" disabled={auth.loading}
              className="w-full py-3 rounded-xl text-white font-semibold shadow-sm hover:shadow-md transition-all disabled:opacity-60"
              style={{ backgroundColor: COLORS.greenPrimary }}
            >
              {auth.loading ? "Validando..." : "Iniciar sesión"}
            </button>
          </form>
        )}

        {paso === "planta" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xs text-gray-500">Hola,</span>
              <span className="text-xs font-semibold px-2 py-0.5 rounded-md text-white" style={{ backgroundColor: COLORS.greenDark }}>
                {auth.user?.nombre_completo}
              </span>
            </div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Selecciona tu planta</p>
            {plantas.map((p) => (
              <button
                key={p.planta_id}
                onClick={() => { setPlantaSel(p.planta_id); setPaso("cargo"); }}
                className="w-full flex items-center gap-4 p-4 rounded-2xl border-2 border-gray-100 hover:border-emerald-400 hover:shadow-lg transition-all group text-left"
              >
                <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold text-sm flex-shrink-0"
                  style={{ backgroundColor: COLORS.greenDark }}>
                  {p.planta_id}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-gray-900 group-hover:text-emerald-700 transition-colors">{p.nombre}</div>
                  <div className="text-xs text-gray-500 mt-0.5">Planta de generación</div>
                </div>
                <LogIn size={20} className="text-gray-300 group-hover:text-emerald-500 transition-colors flex-shrink-0" />
              </button>
            ))}
          </div>
        )}

        {paso === "cargo" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-4">
              <button onClick={() => setPaso("planta")} className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1 transition-colors">
                ← Cambiar planta
              </button>
              <span className="text-xs font-semibold px-2 py-0.5 rounded-md text-white" style={{ backgroundColor: COLORS.greenDark }}>
                {plantas.find((p) => p.planta_id === plantaSel)?.nombre}
              </span>
            </div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Selecciona tu cargo</p>
            {cargos.map((c) => (
              <button
                key={c.cargo_id}
                onClick={() => handleSelectCargo(c)}
                className="w-full flex items-center gap-4 p-4 rounded-2xl border-2 border-gray-100 hover:border-emerald-400 hover:shadow-lg transition-all group text-left"
              >
                <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold text-lg flex-shrink-0"
                  style={{ backgroundColor: c.nombre === "Jefe de Turno" ? COLORS.greenDark : COLORS.blueDark }}>
                  {iniciales(c.nombre)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-gray-900 group-hover:text-emerald-700 transition-colors">{c.nombre}</div>
                  <div className="text-xs text-gray-500 flex items-center gap-2 mt-0.5">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-medium"
                      style={{
                        backgroundColor: c.nombre === "Jefe de Turno" ? "#e6f4ea" : "#e8f0fe",
                        color: c.nombre === "Jefe de Turno" ? COLORS.greenDark : COLORS.blueDark,
                      }}>
                      {c.solo_lectura ? "Solo lectura" : "Operativo"}
                    </span>
                  </div>
                </div>
                <LogIn size={20} className="text-gray-300 group-hover:text-emerald-500 transition-colors flex-shrink-0" />
              </button>
            ))}
          </div>
        )}

        <p className="text-center text-xs text-gray-400 mt-8">Sistema conectado a backend de bitácoras</p>
      </div>
    </div>
  );
}

// ============================================================
// Header
// ============================================================

function Header({ user, sesion, cargoNombre, plantaNombre, onLogout }) {
  const [reloj, setReloj] = useState(new Date());
  useEffect(() => {
    const i = setInterval(() => setReloj(new Date()), 30000);
    return () => clearInterval(i);
  }, []);

  const fechaStr = reloj.toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const horaStr = reloj.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });

  return (
    <header className="text-white px-6 py-3 flex items-center justify-between shadow-lg relative z-10"
      style={{ background: `linear-gradient(90deg, ${COLORS.blueDeepest} 0%, ${COLORS.blueDark} 100%)` }}>
      <div className="flex items-center gap-4">
        <img src="/G3 blanco.png" alt="Gecelca3" className="h-10" onError={(e) => { e.target.style.display = "none"; }} />
        <div>
          <h1 className="text-lg font-bold tracking-tight">Bitácoras de Planta</h1>
          <p className="text-xs text-blue-300 opacity-80">Sistema de Registro Operativo</p>
        </div>
      </div>

      <div className="hidden md:flex items-center gap-6 text-sm">
        <div className="flex items-center gap-2 text-blue-200">
          <Clock size={16} />
          <span className="capitalize">{fechaStr}</span>
          <span className="font-mono font-bold text-white">{horaStr}</span>
        </div>
        <span className="px-3 py-1 rounded-lg text-xs font-bold" style={{ backgroundColor: COLORS.greenPrimary }}>
          {getTurnoLabel(sesion?.turno)}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <div className="text-right hidden sm:block">
          <div className="text-sm font-semibold">{user.nombre_completo}</div>
          <div className="text-xs text-blue-300">{cargoNombre} — {plantaNombre}</div>
        </div>
        <div className="w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold"
          style={{ backgroundColor: COLORS.greenDark }}>
          {iniciales(user.nombre_completo)}
        </div>
        <button onClick={onLogout} className="p-2 rounded-lg hover:bg-white/10 transition-colors" title="Cerrar sesión">
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}

// ============================================================
// Tabs
// ============================================================

function BitacoraTabs({ bitacoras, activeId, onSelect, registrosPorBitacora }) {
  return (
    <div className="bg-white border-b border-gray-200 px-4 overflow-x-auto">
      <div className="flex gap-1 min-w-max py-2">
        {bitacoras.map((b) => {
          const isActive = b.bitacora_id === activeId;
          const IconComp = ICON_MAP[b.icono] || FileText;
          const count = registrosPorBitacora[b.bitacora_id] || 0;
          const tieneActivos = count > 0;
          return (
            <button
              key={b.bitacora_id}
              onClick={() => onSelect(b.bitacora_id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all whitespace-nowrap ${
                isActive ? "text-white shadow-md" : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              }`}
              style={isActive ? { backgroundColor: COLORS.blueDark } : {}}
            >
              {tieneActivos && (
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: isActive ? "#fff" : COLORS.greenPrimary }} />
              )}
              <IconComp size={16} />
              <span className="hidden lg:inline">{b.nombre}</span>
              <span className="lg:hidden">{b.codigo}</span>
              <span className={`ml-1 min-w-5 h-5 flex items-center justify-center rounded-full text-xs font-bold ${
                isActive ? "bg-white/20 text-white" : "bg-gray-200 text-gray-600"
              }`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// Barra de estado
// ============================================================

function BarraEstado({
  bitacora, registros, estadoBitacora, puedeCrear, esJefeTurno,
  onCerrarTurno, filtroTexto, setFiltroTexto, filtroTipo, setFiltroTipo,
  tiposEvento, onAddRegistro,
}) {
  const borradores = registros.filter((r) => r.estado === "borrador").length;
  const cerrados = registros.filter((r) => r.estado === "cerrado").length;

  return (
    <div className="bg-white border-b border-gray-200 px-6 py-3 flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-gray-900">{bitacora?.nombre}</h2>
            <EstadoBadge estado={estadoBitacora} />
          </div>
          <div className="flex items-center gap-4 text-xs text-gray-500 mt-1">
            <span>{registros.length} registros</span>
            {borradores > 0 && <span className="text-amber-600 font-medium">{borradores} borradores</span>}
            {cerrados > 0 && <span className="text-blue-600 font-medium">{cerrados} cerrados</span>}
          </div>
        </div>
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-3">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text" placeholder="Buscar en registros..."
            value={filtroTexto} onChange={(e) => setFiltroTexto(e.target.value)}
            className="pl-9 pr-4 py-2 rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent w-64"
          />
        </div>
        <div className="relative">
          <Filter size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <select
            value={filtroTipo} onChange={(e) => setFiltroTipo(e.target.value)}
            className="pl-9 pr-8 py-2 rounded-xl border border-gray-300 text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent bg-white cursor-pointer"
          >
            <option value="">Todos los tipos</option>
            {tiposEvento.map((t) => (
              <option key={t.tipo_evento_id} value={t.tipo_evento_id}>{t.nombre}</option>
            ))}
          </select>
          <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        </div>
      </div>

      {puedeCrear && (
        <button onClick={onAddRegistro}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white shadow-sm hover:shadow-md transition-all"
          style={{ backgroundColor: COLORS.greenPrimary }}>
          <Plus size={18} />
          Nuevo Registro
        </button>
      )}

      {esJefeTurno && borradores + cerrados > 0 && (
        <button onClick={onCerrarTurno}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-colors shadow-sm hover:shadow-md"
          style={{ backgroundColor: COLORS.blueDark }}>
          <Lock size={16} />
          Cerrar Turno
        </button>
      )}
    </div>
  );
}

// ============================================================
// Grilla
// ============================================================

function GrillaRegistros({
  registros, bitacora, tiposEvento, jefeNombre, jdtNombre,
  puedeCrear, onUpdateLocal, onSaveRegistro, onDeleteRegistro,
  filtroTexto, filtroTipo,
}) {
  const [editingId, setEditingId] = useState(null);

  const camposExtraDef = useMemo(
    () => getCamposExtraEditables(bitacora?.definicion_campos),
    [bitacora?.definicion_campos],
  );
  const hasExtras = camposExtraDef.length > 0;

  const regs = useMemo(() => {
    return registros
      .filter((r) => {
        if (filtroTexto) {
          const t = filtroTexto.toLowerCase();
          return (r.detalle || "").toLowerCase().includes(t)
            || (r.creado_por_nombre || "").toLowerCase().includes(t)
            || joinNombres(parseSnapshot(r.ingenieros_snapshot)).toLowerCase().includes(t)
            || (r.tipo_evento_nombre || "").toLowerCase().includes(t);
        }
        return true;
      })
      .filter((r) => (filtroTipo ? String(r.tipo_evento_id) === String(filtroTipo) : true))
      .sort((a, b) => new Date(a.fecha_evento) - new Date(b.fecha_evento));
  }, [registros, filtroTexto, filtroTipo]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-auto px-6 py-4">
        {regs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-gray-400">
            <FileText size={48} className="mb-4 opacity-50" />
            <p className="text-lg font-medium">No hay registros aún</p>
            <p className="text-sm mt-1">
              {puedeCrear ? "Haz clic en \"Nuevo Registro\" para comenzar" : "Esta bitácora no tiene registros del día"}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="hidden lg:grid grid-cols-12 gap-3 px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider">
              <div className="col-span-1">#</div>
              <div className="col-span-2">Fecha / Turno</div>
              <div className="col-span-1">Tipo</div>
              <div className={hasExtras ? "col-span-3" : "col-span-5"}>Descripción</div>
              {hasExtras && (
                <div className="col-span-2">{camposExtraDef.map(labelCampo).join(" / ")}</div>
              )}
              <div className="col-span-1">Estado</div>
              <div className="col-span-2 text-right">Acciones</div>
            </div>
            {regs.map((reg, idx) => (
              <RegistroRow
                key={reg.registro_id || reg._localId}
                numero={idx + 1}
                registro={reg}
                tiposEvento={tiposEvento}
                jefeNombre={jefeNombre}
                jdtNombre={jdtNombre}
                camposExtraDef={camposExtraDef}
                isEditing={editingId === (reg.registro_id || reg._localId) || (reg._dirty && !reg.registro_id)}
                onStartEdit={() => setEditingId(reg.registro_id || reg._localId)}
                onCancelEdit={() => setEditingId(null)}
                onUpdate={(campo, valor) => onUpdateLocal(reg.registro_id || reg._localId, campo, valor)}
                onSave={async () => {
                  const ok = await onSaveRegistro(reg);
                  if (ok) setEditingId(null);
                }}
                onDelete={() => onDeleteRegistro(reg)}
                puedeEditar={reg.estado === "borrador" || !reg.registro_id}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RegistroRow({ numero, registro: reg, tiposEvento, jefeNombre, jdtNombre, camposExtraDef = [], isEditing, onStartEdit, onCancelEdit, onUpdate, onSave, onDelete, puedeEditar }) {
  const tipoNombre = reg.tipo_evento_nombre
    || tiposEvento.find((t) => t.tipo_evento_id === reg.tipo_evento_id)?.nombre
    || "";
  const tipoBorderColor = {
    "Evento General": COLORS.greenPrimary,
    "Cambio de Estado": "#fd7e14",
    Redespacho: "#20c997",
    Sincronización: COLORS.blueDark,
  };
  const borderColor = tipoBorderColor[tipoNombre] || COLORS.grayBorder;
  const estadoDisplay = reg.estado === "borrador" ? "Borrador" : reg.estado === "cerrado" ? "Cerrado" : "Borrador";
  const hasExtras = camposExtraDef.length > 0;
  const camposExtraValores = parseCamposExtra(reg.campos_extra);
  const updateCampoExtra = (campo, valorRaw, tipo) => {
    let v = valorRaw;
    if (valorRaw === "" || valorRaw === null || valorRaw === undefined) {
      v = "";
    } else if (tipo === "float") {
      const f = parseFloat(valorRaw);
      v = Number.isFinite(f) ? f : valorRaw;
    } else if (tipo === "int") {
      const n = parseInt(valorRaw, 10);
      v = Number.isFinite(n) ? n : valorRaw;
    }
    const next = { ...camposExtraValores, [campo]: v };
    onUpdate("campos_extra", next);
  };

  return (
    <div className={`bg-white rounded-xl border transition-all ${
      isEditing ? "border-emerald-400 shadow-lg ring-2 ring-emerald-100" : "border-gray-200 hover:shadow-md hover:border-gray-300"
    }`}
      style={{ borderLeftWidth: "4px", borderLeftColor: borderColor }}
    >
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 p-4 items-start">
        <div className="lg:col-span-1 flex items-center gap-2">
          <span className="text-lg font-bold text-gray-300">#{numero}</span>
        </div>

        <div className="lg:col-span-2">
          <label className="text-xs text-gray-400 lg:hidden">Fecha / Turno</label>
          {isEditing ? (
            <div className="space-y-1.5">
              <input
                type="datetime-local"
                value={(reg.fecha_evento || "").slice(0, 16)}
                onChange={(e) => onUpdate("fecha_evento", e.target.value)}
                className="w-full px-3 py-1.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
              />
              <select
                value={reg.turno || 1}
                onChange={(e) => onUpdate("turno", parseInt(e.target.value, 10))}
                className="w-full px-3 py-1.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 bg-white"
              >
                <option value={1}>Turno 1</option>
                <option value={2}>Turno 2</option>
              </select>
            </div>
          ) : (
            <div>
              <div className="text-sm text-gray-900 font-medium">{formatFechaHora(reg.fecha_evento)}</div>
              <div className="text-xs text-gray-500 mt-0.5">{getTurnoLabel(reg.turno)}</div>
            </div>
          )}
        </div>

        <div className="lg:col-span-1">
          <label className="text-xs text-gray-400 lg:hidden">Tipo</label>
          {isEditing ? (
            <select
              value={reg.tipo_evento_id || ""}
              onChange={(e) => onUpdate("tipo_evento_id", parseInt(e.target.value, 10))}
              className="w-full px-3 py-1.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 bg-white"
            >
              <option value="">Seleccionar...</option>
              {tiposEvento.map((t) => (
                <option key={t.tipo_evento_id} value={t.tipo_evento_id}>{t.nombre}</option>
              ))}
            </select>
          ) : (
            <span className="inline-block px-2.5 py-1 rounded-lg text-xs font-semibold"
              style={{ backgroundColor: borderColor + "18", color: borderColor }}>
              {tipoNombre || "—"}
            </span>
          )}
        </div>

        <div className={hasExtras ? "lg:col-span-3" : "lg:col-span-5"}>
          <label className="text-xs text-gray-400 lg:hidden">Descripción</label>
          {isEditing ? (
            <textarea
              value={reg.detalle || ""}
              onChange={(e) => onUpdate("detalle", e.target.value)}
              rows={3}
              placeholder="Describe el evento operativo..."
              className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 resize-none"
            />
          ) : (
            <p className="text-sm text-gray-700 leading-relaxed line-clamp-2">
              {reg.detalle || <span className="text-gray-400 italic">Sin descripción</span>}
            </p>
          )}
        </div>

        {hasExtras && (
          <div className="lg:col-span-2">
            <label className="text-xs text-gray-400 lg:hidden">{camposExtraDef.map(labelCampo).join(" / ")}</label>
            {isEditing ? (
              <div className="space-y-1.5">
                {camposExtraDef.map((c) => (
                  <input
                    key={c.campo}
                    type={c.tipo === "int" || c.tipo === "float" ? "number" : "text"}
                    step={c.tipo === "float" ? "0.01" : c.tipo === "int" ? "1" : undefined}
                    min={c.min}
                    max={c.max}
                    value={camposExtraValores[c.campo] ?? ""}
                    onChange={(e) => updateCampoExtra(c.campo, e.target.value, c.tipo)}
                    placeholder={labelCampo(c)}
                    className="w-full px-3 py-1.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
                  />
                ))}
              </div>
            ) : (
              <div className="text-sm text-gray-700 space-y-0.5">
                {camposExtraDef.map((c) => {
                  const v = camposExtraValores[c.campo];
                  return (
                    <div key={c.campo}>
                      {v === undefined || v === null || v === "" ? (
                        <span className="text-gray-400 italic">—</span>
                      ) : (
                        <span className="font-medium">{formatValorCampo(v, c.tipo)}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className="lg:col-span-1">
          <label className="text-xs text-gray-400 lg:hidden">Estado</label>
          <EstadoBadge estado={estadoDisplay} />
        </div>

        <div className="lg:col-span-2 flex items-center justify-end gap-2">
          {isEditing ? (
            <>
              <button onClick={onSave} className="p-2 rounded-lg text-white transition-colors" style={{ backgroundColor: COLORS.greenPrimary }} title="Guardar">
                <Save size={16} />
              </button>
              <button onClick={onCancelEdit} className="p-2 rounded-lg text-gray-600 bg-gray-100 hover:bg-gray-200 transition-colors" title="Cancelar">
                <X size={16} />
              </button>
            </>
          ) : (
            <>
              {puedeEditar ? (
                <button onClick={onStartEdit} className="p-2 rounded-lg text-blue-700 bg-blue-50 hover:bg-blue-100 transition-colors" title="Editar">
                  <Edit3 size={16} />
                </button>
              ) : (
                <button onClick={onStartEdit} className="p-2 rounded-lg text-gray-500 bg-gray-50 hover:bg-gray-100 transition-colors" title="Ver detalle">
                  <Eye size={16} />
                </button>
              )}
              {puedeEditar && (
                <button onClick={onDelete} className="p-2 rounded-lg text-red-600 bg-red-50 hover:bg-red-100 transition-colors" title="Eliminar">
                  <Trash2 size={16} />
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {!isEditing && (
        <div className="px-4 pb-3 flex flex-wrap items-center gap-3 text-xs text-gray-400 border-t border-gray-100 pt-2 mt-1">
          <span>Planta: {reg.planta_id}</span>
          <span>•</span>
          <span>Bitácora: {reg.bitacora_nombre}</span>
          {reg.creado_por_nombre && (<><span>•</span><span>Autor: {reg.creado_por_nombre}</span></>)}
          {(() => {
            const jdts = joinNombres(parseSnapshot(reg.jdts_snapshot));
            return jdts ? (<><span>•</span><span>JdTs: {jdts}</span></>) : null;
          })()}
          {(() => {
            const jefes = joinNombres(parseSnapshot(reg.jefes_snapshot));
            return jefes ? (<><span>•</span><span>Jefes: {jefes}</span></>) : null;
          })()}
          {(() => {
            const ings = joinNombres(parseSnapshot(reg.ingenieros_snapshot));
            return ings ? (<><span>•</span><span>Ingenieros: {ings}</span></>) : null;
          })()}
          {reg.creado_en && (<><span>•</span><span>Creado: {formatFechaHora(reg.creado_en)}</span></>)}
        </div>
      )}
    </div>
  );
}

// ============================================================
// App
// ============================================================

export default function App() {
  const auth = useAuth();
  const catalogos = useCatalogos(auth.sesion?.cargo_id, auth.ready);
  const registrosHook = useRegistros();
  const cierre = useCierre();

  const [activeBitacora, setActiveBitacora] = useState(null);
  const [tiposEvento, setTiposEvento] = useState([]);
  const [filtroTexto, setFiltroTexto] = useState("");
  const [filtroTipo, setFiltroTipo] = useState("");
  const [toast, setToast] = useState(null);
  const [modal, setModal] = useState(null);
  const [draftLocal, setDraftLocal] = useState(null);

  const showToast = useCallback((message, type = "success") => {
    setToast({ message, type, key: Date.now() });
  }, []);

  const sesion = auth.sesion;
  const user = auth.user;

  const bitacorasPermitidas = useMemo(() => {
    if (!catalogos.permisos.length) return catalogos.bitacoras;
    const map = new Map(catalogos.permisos.map((p) => [p.bitacora_id, p]));
    return catalogos.bitacoras.filter((b) => map.get(b.bitacora_id)?.puede_ver);
  }, [catalogos.bitacoras, catalogos.permisos]);

  const cargoNombre = catalogos.cargos.find((c) => c.cargo_id === sesion?.cargo_id)?.nombre || "";
  const plantaNombre = catalogos.plantas.find((p) => p.planta_id === sesion?.planta_id)?.nombre || sesion?.planta_id || "";
  const esJefeTurno = cargoNombre === "Jefe de Turno";

  const permisoActivo = catalogos.permisos.find((p) => p.bitacora_id === activeBitacora);
  const puedeCrear = !!permisoActivo?.puede_crear;

  // Selecciona primera bitácora permitida al iniciar
  useEffect(() => {
    if (!activeBitacora && bitacorasPermitidas.length > 0) {
      setActiveBitacora(bitacorasPermitidas[0].bitacora_id);
    }
  }, [bitacorasPermitidas, activeBitacora]);

  // Carga tipos evento cuando cambia la bitácora
  useEffect(() => {
    if (!activeBitacora) return;
    catalogos.getTiposEvento(activeBitacora).then(setTiposEvento).catch(() => setTiposEvento([]));
  }, [activeBitacora, catalogos.getTiposEvento]);

  // Carga registros activos cuando cambia bitácora o planta
  useEffect(() => {
    if (!activeBitacora || !sesion?.planta_id) return;
    registrosHook.getActivos({ planta_id: sesion.planta_id, bitacora_id: activeBitacora }).catch((e) => showToast(e.message, "error"));
    setDraftLocal(null);
  }, [activeBitacora, sesion?.planta_id, registrosHook.getActivos, showToast]);

  const registrosDeBitacora = useMemo(() => {
    const lista = registrosHook.registros.filter((r) => r.bitacora_id === activeBitacora);
    return draftLocal ? [...lista, draftLocal] : lista;
  }, [registrosHook.registros, activeBitacora, draftLocal]);

  const registrosPorBitacora = useMemo(() => {
    const c = {};
    registrosHook.registros.forEach((r) => { c[r.bitacora_id] = (c[r.bitacora_id] || 0) + 1; });
    return c;
  }, [registrosHook.registros]);

  const estadoBitacora = useMemo(() => {
    if (!registrosDeBitacora.length) return "Sin actividad";
    const hayBorrador = registrosDeBitacora.some((r) => r.estado === "borrador" || !r.registro_id);
    return hayBorrador ? "En Desarrollo" : "Cerrada";
  }, [registrosDeBitacora]);

  // Acciones
  const handleAddRegistro = useCallback(() => {
    if (draftLocal) { showToast("Termina de guardar el registro en edición", "info"); return; }
    const defTipo = tiposEvento.find((t) => t.es_default) || tiposEvento[0];
    setDraftLocal({
      _localId: `draft_${Date.now()}`,
      _dirty: true,
      bitacora_id: activeBitacora,
      planta_id: sesion.planta_id,
      fecha_evento: getLocalISOString(),
      turno: getTurnoActualNum(),
      detalle: "",
      tipo_evento_id: defTipo?.tipo_evento_id || null,
      tipo_evento_nombre: defTipo?.nombre,
      estado: "borrador",
      creado_por_id: user.usuario_id,
      creado_por_nombre: user.nombre_completo,
      bitacora_nombre: bitacorasPermitidas.find((b) => b.bitacora_id === activeBitacora)?.nombre,
    });
  }, [draftLocal, tiposEvento, activeBitacora, sesion, user, bitacorasPermitidas, showToast]);

  const handleUpdateLocal = useCallback((id, campo, valor) => {
    if (draftLocal && draftLocal._localId === id) {
      setDraftLocal((d) => ({ ...d, [campo]: valor }));
      return;
    }
    // Edición de existente → actualiza en memoria hasta guardar
    registrosHook.setRegistros((prev) =>
      prev.map((r) => (r.registro_id === id ? { ...r, [campo]: valor, _dirty: true } : r))
    );
  }, [draftLocal, registrosHook]);

  const handleSaveRegistro = useCallback(async (reg) => {
    if (!reg.tipo_evento_id) { showToast("Selecciona un tipo de evento", "error"); return false; }
    if (!reg.detalle || !reg.detalle.trim()) { showToast("Escribe una descripción", "error"); return false; }

    try {
      if (!reg.registro_id) {
        // Crear
        const creado = await registrosHook.crear({
          bitacora_id: reg.bitacora_id,
          planta_id: reg.planta_id,
          fecha_evento: reg.fecha_evento,
          turno: reg.turno,
          detalle: reg.detalle,
          tipo_evento_id: reg.tipo_evento_id,
          campos_extra: reg.campos_extra || null,
        });
        // refresca lista
        await registrosHook.getActivos({ planta_id: sesion.planta_id, bitacora_id: activeBitacora });
        setDraftLocal(null);
        showToast("Registro creado");
      } else {
        await registrosHook.actualizar(reg.registro_id, {
          detalle: reg.detalle,
          turno: reg.turno,
          fecha_evento: reg.fecha_evento,
          tipo_evento_id: reg.tipo_evento_id,
          campos_extra: reg.campos_extra || null,
        });
        await registrosHook.getActivos({ planta_id: sesion.planta_id, bitacora_id: activeBitacora });
        showToast("Registro actualizado");
      }
      return true;
    } catch (e) {
      showToast(e.message, "error");
      return false;
    }
  }, [registrosHook, user, sesion, activeBitacora, showToast]);

  const handleDeleteRegistro = useCallback((reg) => {
    if (!reg.registro_id) {
      setDraftLocal(null);
      showToast("Borrador descartado");
      return;
    }
    setModal({
      title: "Eliminar registro",
      message: "¿Confirmas eliminar este registro en borrador?",
      confirmLabel: "Eliminar", confirmColor: "red", icon: Trash2,
      onConfirm: async () => {
        try {
          await registrosHook.eliminar(reg.registro_id);
          await registrosHook.getActivos({ planta_id: sesion.planta_id, bitacora_id: activeBitacora });
          setModal(null);
          showToast("Registro eliminado");
        } catch (e) {
          showToast(e.message, "error");
        }
      },
    });
  }, [registrosHook, sesion, activeBitacora, showToast]);

  const handleCerrarTurno = useCallback(async () => {
    const bit = bitacorasPermitidas.find((b) => b.bitacora_id === activeBitacora);
    let incompletos = 0;
    try {
      const preview = await cierre.previewCierre(sesion.planta_id, activeBitacora);
      incompletos = preview.reduce((acc, p) => acc + (p.incompletos || 0), 0);
    } catch {}
    const aviso = incompletos > 0 ? `\n\n⚠ ${incompletos} registro(s) sin detalle se cerrarán igualmente.` : "";
    setModal({
      title: "Cerrar turno",
      message: `¿Cerrar la bitácora "${bit?.nombre}"? Los registros se moverán al histórico y no podrán editarse.${aviso}`,
      confirmLabel: "Cerrar turno", confirmColor: "blue", icon: Lock,
      onConfirm: async () => {
        try {
          const res = await cierre.cerrarBitacora(activeBitacora, sesion.planta_id);
          await registrosHook.getActivos({ planta_id: sesion.planta_id, bitacora_id: activeBitacora });
          setModal(null);
          showToast(`Cierre completado: ${res.registros_cerrados} registro(s)`);
        } catch (e) {
          showToast(e.message, "error");
        }
      },
    });
  }, [bitacorasPermitidas, activeBitacora, sesion, cierre, registrosHook, showToast]);

  const handleLogout = useCallback(async () => {
    await auth.logout();
    setActiveBitacora(null);
    setDraftLocal(null);
  }, [auth]);

  // ==================== RENDER ====================
  if (!auth.ready) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-400 bg-slate-950">
        Cargando…
      </div>
    );
  }
  if (!user || !sesion) {
    return (
      <>
        <LoginScreen
          auth={auth}
          plantas={catalogos.plantas}
          cargos={catalogos.cargos}
          onReady={() => {}}
          showToast={showToast}
        />
        {toast && (
          <Toast key={toast.key} message={toast.message} type={toast.type} onClose={() => setToast(null)} />
        )}
      </>
    );
  }

  const bitacoraActiva = bitacorasPermitidas.find((b) => b.bitacora_id === activeBitacora);

  return (
    <div className="h-screen flex flex-col bg-gray-100">
      <Header user={user} sesion={sesion} cargoNombre={cargoNombre} plantaNombre={plantaNombre} onLogout={handleLogout} />

      <BitacoraTabs
        bitacoras={bitacorasPermitidas}
        activeId={activeBitacora}
        onSelect={(id) => { setActiveBitacora(id); setFiltroTexto(""); setFiltroTipo(""); setDraftLocal(null); }}
        registrosPorBitacora={registrosPorBitacora}
      />

      {bitacoraActiva && (
        <BarraEstado
          bitacora={bitacoraActiva}
          registros={registrosDeBitacora}
          estadoBitacora={estadoBitacora}
          puedeCrear={puedeCrear}
          esJefeTurno={esJefeTurno}
          onCerrarTurno={handleCerrarTurno}
          filtroTexto={filtroTexto} setFiltroTexto={setFiltroTexto}
          filtroTipo={filtroTipo} setFiltroTipo={setFiltroTipo}
          tiposEvento={tiposEvento}
          onAddRegistro={handleAddRegistro}
        />
      )}

      <GrillaRegistros
        registros={registrosDeBitacora}
        bitacora={bitacoraActiva}
        tiposEvento={tiposEvento}
        jefeNombre={catalogos.jefe?.nombre_completo}
        jdtNombre={null}
        puedeCrear={puedeCrear}
        onUpdateLocal={handleUpdateLocal}
        onSaveRegistro={handleSaveRegistro}
        onDeleteRegistro={handleDeleteRegistro}
        filtroTexto={filtroTexto}
        filtroTipo={filtroTipo}
      />

      {toast && (<Toast key={toast.key} message={toast.message} type={toast.type} onClose={() => setToast(null)} />)}
      {modal && (
        <ConfirmModal
          open={true}
          title={modal.title} message={modal.message}
          confirmLabel={modal.confirmLabel} confirmColor={modal.confirmColor}
          icon={modal.icon}
          onConfirm={modal.onConfirm}
          onCancel={() => setModal(null)}
        />
      )}

      <style>{`
        @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes scaleIn { from { transform: scale(0.9); opacity: 0; } to { transform: scale(1); opacity: 1; } }
        .animate-slide-in { animation: slideIn 0.3s ease-out; }
        .animate-scale-in { animation: scaleIn 0.2s ease-out; }
        .line-clamp-2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      `}</style>
    </div>
  );
}
