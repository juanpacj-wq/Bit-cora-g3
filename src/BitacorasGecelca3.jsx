// ============================================================
// Bitácoras Gecelca3 — conectado a backend (localhost:3002)
// React + Tailwind + Lucide
// ============================================================

import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  LogIn, LogOut, Clock, Plus, Save, Trash2, Lock, CheckCircle2,
  AlertTriangle, X, ChevronDown, ChevronLeft, ChevronRight, Calendar,
  Search, Filter, FileText,
  Activity, Flame, Droplets, Zap, Gauge, Cpu, FlaskConical, Leaf,
  Settings, FileCheck, Edit3, Eye, XCircle, Check, Users, History,
  User, LayoutDashboard, MonitorCog,
} from "lucide-react";
import { HistoricoView } from "./components/historicos/HistoricoView";
import CierrePendientesModal from "./components/CierrePendientesModal";
import SalaDeMandoGrid from "./components/SalaDeMando/SalaDeMandoGrid";
import DisponibilidadDashboard from "./components/Disponibilidad/DisponibilidadDashboard";
import { useAuth } from "./hooks/useAuth";
import { useCatalogos } from "./hooks/useCatalogos";
import { useRegistros } from "./hooks/useRegistros";
import { useCierre } from "./hooks/useCierre";
import { useUsuariosActivos } from "./hooks/useUsuariosActivos";
import { useBitacoraCounts } from "./hooks/useBitacoraCounts";
import { useFlipReorder } from "./hooks/useFlipReorder";
import { useBitacoraSesion, useFinalizarTurno } from "./hooks/useBitacoraSesion";
import { getTodayBogota, shiftDate, horaBogota } from "./utils/fecha";

const COLORS = {
  greenPrimary: "#31a354", greenDark: "#006f36",
  blueDark: "#003566", blueDeep: "#001d3d", blueDeepest: "#011027",
  red: "#DC3545", yellow: "#FFC107",
  grayLight: "#f8f9fa", grayMid: "#e9ecef", grayBorder: "#dee2e6",
  grayText: "#6c757d", white: "#ffffff",
};

const ICON_MAP = {
  Activity, Settings, Flame, Droplets, Gauge, Zap, Cpu,
  FlaskConical, Leaf, FileCheck, MonitorCog,
};

// F20: presentación + entrada de fecha en hora Bogotá explícita, independiente del navegador.
const FECHA_HORA_FMT = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  day: "2-digit", month: "2-digit", year: "numeric",
  hour: "2-digit", minute: "2-digit",
});
const BOGOTA_LOCAL_FMT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/Bogota",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
const BOGOTA_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit",
});
const RELOJ_FECHA_FMT = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  weekday: "long", day: "numeric", month: "long", year: "numeric",
});
const RELOJ_HORA_FMT = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit",
});

// `value` puede ser ISO con Z/offset (post-backend) o "YYYY-MM-DDTHH:mm" wallclock Bogotá (post-edit).
// Devuelve "YYYY-MM-DDTHH:mm" Bogotá wallclock para popular <input type="datetime-local">.
const toBogotaLocal = (value) => {
  if (!value) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return value;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return BOGOTA_LOCAL_FMT.format(d).replace(" ", "T").slice(0, 16);
};

const toBogotaDate = (value) => {
  if (!value) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) && !/Z|[+-]\d{2}:?\d{2}$/.test(value)) {
    return value.slice(0, 10);
  }
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "" : BOGOTA_DATE_FMT.format(d);
};

// Wallclock Bogotá → ISO UTC. Apendemos -05:00 fijo (Colombia sin DST). Idempotente con ISO UTC.
const bogotaLocalToIso = (value) => {
  if (!value) return null;
  const wall = toBogotaLocal(value);
  if (!wall) return null;
  return new Date(`${wall}:00-05:00`).toISOString();
};

const nowBogotaLocal = () => toBogotaLocal(new Date());

const formatFechaHora = (isoStr) => (isoStr ? FECHA_HORA_FMT.format(new Date(isoStr)) : "");

const getTurnoLabel = (turno) => (turno === 1 || turno === "1" ? "Turno 1" : "Turno 2");
// Canonical turno window (F1, server/utils/turno.js): 1=diurno [6,17], 2=nocturno [18,5].
const turnoFromHora = (hora) => (hora >= 6 && hora < 18 ? 1 : 2);
const getTurnoActualNum = () => turnoFromHora(Math.floor(horaBogota()));
// `fechaLocal` es Bogotá wallclock "YYYY-MM-DDTHH:mm" — el slice de hora ya está en hora Bogotá.
const turnoFromFechaLocal = (fechaLocal) => {
  if (!fechaLocal || fechaLocal.length < 13) return getTurnoActualNum();
  const hora = parseInt(fechaLocal.slice(11, 13), 10);
  return Number.isFinite(hora) ? turnoFromHora(hora) : getTurnoActualNum();
};

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

function ConfirmModal({ open, title, message, confirmLabel, confirmColor, onConfirm, onCancel, icon: IconProp, secondaryLabel, onSecondary }) {
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
        <div className="px-6 pb-6 flex flex-wrap gap-3 justify-end">
          <button onClick={onCancel} className="px-5 py-2.5 rounded-xl text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 transition-colors">
            Cancelar
          </button>
          {secondaryLabel && onSecondary && (
            <button onClick={onSecondary} className="px-5 py-2.5 rounded-xl text-sm font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-100 transition-colors">
              {secondaryLabel}
            </button>
          )}
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
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [plantaSel, setPlantaSel] = useState(null);

  const handleLogin = async (e) => {
    e.preventDefault();
    try {
      await auth.login(username, password);
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
    <div className="min-h-screen relative flex items-center justify-center p-3 sm:p-4 overflow-hidden"
      style={{ background: "linear-gradient(135deg, #f5f7fa 0%, #eef2f7 50%, #e2eaf3 100%)" }}>

      {/* Decorativos sutiles sobre fondo claro */}
      <div className="absolute -top-24 -left-24 w-80 h-80 rounded-full blur-3xl opacity-25 pointer-events-none"
        style={{ backgroundColor: COLORS.greenPrimary }} />
      <div className="absolute -bottom-32 -right-20 w-96 h-96 rounded-full blur-3xl opacity-20 pointer-events-none"
        style={{ backgroundColor: COLORS.blueDark }} />
      <div className="absolute top-1/3 left-1/4 w-40 h-40 rounded-full blur-3xl opacity-10 pointer-events-none"
        style={{ backgroundColor: COLORS.blueDeep }} />

      {/* Card principal */}
      <div className="relative w-full max-w-5xl max-h-full bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col lg:flex-row ring-1 ring-black/5">

        {/* PANEL IZQUIERDO — Form */}
        <div className="flex-1 flex flex-col justify-center px-8 py-7 lg:px-12 lg:py-9">
          <div className="text-center mb-5">
            <img src="/gecelca3-logo.png" alt="Gecelca3" className="h-11 mx-auto mb-3"
              onError={(e) => { e.target.style.display = "none"; }} />
            {paso === "credenciales" ? (
              <>
                <h1 className="text-3xl font-bold tracking-tight" style={{ color: COLORS.blueDark }}>INICIAR SESION</h1>
                <p className="text-sm mt-1.5" style={{ color: COLORS.grayText }}>
                  Bitácoras de Planta — Sistema de Registro Operativo
                </p>
              </>
            ) : (
              <>
                <h1 className="text-2xl font-bold" style={{ color: COLORS.blueDeep }}>Bitácoras de Planta</h1>
                <p className="text-sm mt-1" style={{ color: COLORS.grayText }}>
                  {paso === "planta" ? "Selecciona tu planta de operación" : "Selecciona tu cargo"}
                </p>
              </>
            )}
          </div>

          {paso === "credenciales" && (
            <form onSubmit={handleLogin} className="space-y-4 max-w-sm mx-auto w-full">
              <div className="relative">
                <User size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                  style={{ color: COLORS.grayText }} />
                <input
                  type="text" required placeholder="Usuario"
                  autoComplete="username" autoCapitalize="off" autoCorrect="off" spellCheck="false"
                  value={username} onChange={(e) => setUsername(e.target.value.trim().toLowerCase())}
                  className="w-full pl-10 pr-4 py-3 rounded-xl border focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 outline-none text-sm transition-all"
                  style={{ backgroundColor: COLORS.grayLight, borderColor: COLORS.grayBorder }}
                />
              </div>
              <div className="relative">
                <Lock size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                  style={{ color: COLORS.grayText }} />
                <input
                  type="password" required placeholder="Contraseña"
                  value={password} onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 rounded-xl border focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 outline-none text-sm transition-all"
                  style={{ backgroundColor: COLORS.grayLight, borderColor: COLORS.grayBorder }}
                />
              </div>

              <div className="pt-2 flex justify-center">
                <button
                  type="submit" disabled={auth.loading}
                  className="px-10 py-3 rounded-xl text-white font-semibold shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all disabled:opacity-60 disabled:hover:translate-y-0"
                  style={{ background: `linear-gradient(135deg, ${COLORS.greenPrimary} 0%, ${COLORS.greenDark} 100%)` }}
                >
                  {auth.loading ? "Validando..." : "Iniciar sesión"}
                </button>
              </div>

              <div className="flex items-center gap-3 pt-3">
                <span className="flex-1 h-px" style={{ backgroundColor: COLORS.grayBorder }} />
                <span className="text-xs font-semibold" style={{ color: COLORS.grayText }}>
                  <strong style={{ color: COLORS.blueDeep }}>O continúa</strong> con
                </span>
                <span className="flex-1 h-px" style={{ backgroundColor: COLORS.grayBorder }} />
              </div>

              <span title="Próximamente — usar credenciales por ahora" className="inline-block w-full">
                <button
                  type="button" disabled
                  className="w-full flex items-center justify-center gap-3 py-3 rounded-xl border bg-white opacity-50 cursor-not-allowed"
                  style={{ borderColor: COLORS.grayBorder }}
                  aria-label="Iniciar sesión con Microsoft (próximamente)"
                >
                  <svg width="18" height="18" viewBox="0 0 23 23" aria-hidden="true">
                    <rect x="1" y="1" width="10" height="10" fill="#F25022" />
                    <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
                    <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
                    <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
                  </svg>
                  <span className="text-sm" style={{ color: COLORS.blueDeep }}>
                    Iniciar sesión con <strong>Microsoft</strong>
                  </span>
                </button>
              </span>
            </form>
          )}

          {paso === "planta" && (
            <div className="max-w-sm mx-auto w-full">
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <span className="text-xs" style={{ color: COLORS.grayText }}>Hola,</span>
                <span className="text-xs font-semibold px-2 py-0.5 rounded-md text-white" style={{ backgroundColor: COLORS.greenDark }}>
                  {auth.user?.nombre_completo}
                </span>
              </div>
              <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-gray-300 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-gray-400">
                {plantas.map((p) => (
                  <button
                    key={p.planta_id}
                    onClick={() => { setPlantaSel(p.planta_id); setPaso("cargo"); }}
                    className="w-full flex items-center gap-4 p-4 rounded-2xl border-2 border-gray-100 hover:border-emerald-400 hover:shadow-lg transition-all group text-left bg-white"
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
            </div>
          )}

          {paso === "cargo" && (
            <div className="max-w-sm mx-auto w-full">
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <button onClick={() => setPaso("planta")} className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1 transition-colors">
                  ← Cambiar planta
                </button>
                <span className="text-xs font-semibold px-2 py-0.5 rounded-md text-white" style={{ backgroundColor: COLORS.greenDark }}>
                  {plantas.find((p) => p.planta_id === plantaSel)?.nombre}
                </span>
              </div>
              <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-gray-300 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-gray-400">
                {cargos.map((c) => (
                  <button
                    key={c.cargo_id}
                    onClick={() => handleSelectCargo(c)}
                    className="w-full flex items-center gap-4 p-4 rounded-2xl border-2 border-gray-100 hover:border-emerald-400 hover:shadow-lg transition-all group text-left bg-white"
                  >
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold text-lg flex-shrink-0"
                      style={{ backgroundColor: c.puede_cerrar_turno ? COLORS.greenDark : COLORS.blueDark }}>
                      {iniciales(c.nombre)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-gray-900 group-hover:text-emerald-700 transition-colors">{c.nombre}</div>
                      <div className="text-xs text-gray-500 flex items-center gap-2 mt-0.5">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-medium"
                          style={{
                            backgroundColor: c.puede_cerrar_turno ? "#e6f4ea" : "#e8f0fe",
                            color: c.puede_cerrar_turno ? COLORS.greenDark : COLORS.blueDark,
                          }}>
                          {c.solo_lectura ? "Solo lectura" : "Operativo"}
                        </span>
                      </div>
                    </div>
                    <LogIn size={20} className="text-gray-300 group-hover:text-emerald-500 transition-colors flex-shrink-0" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* PANEL DERECHO — Hero (oculto en móvil) */}
        <div className="hidden lg:flex lg:w-[45%] relative items-center justify-center p-8 overflow-hidden"
          style={{ background: `linear-gradient(135deg, ${COLORS.blueDeepest} 0%, ${COLORS.blueDark} 100%)` }}>

          {/* Patrón decorativo: círculos translúcidos */}
          <div className="absolute -top-16 -right-16 w-64 h-64 rounded-full opacity-20"
            style={{ backgroundColor: COLORS.greenPrimary }} />
          <div className="absolute -bottom-20 -left-12 w-72 h-72 rounded-full opacity-10 bg-white" />
          <div className="absolute top-10 left-10 w-3 h-3 rounded-full bg-white opacity-40" />
          <div className="absolute bottom-16 right-20 w-2 h-2 rounded-full bg-white opacity-50" />

          {/* Foto de la planta enmarcada */}
          <div className="relative w-full max-w-sm">
            <div className="relative rounded-3xl overflow-hidden shadow-2xl ring-1 ring-white/20">
              <img src="/planta-gecelca3.jpg" alt="Planta Gecelca3"
                className="w-full h-[460px] object-cover"
                onError={(e) => { e.target.style.display = "none"; }} />
              <div className="absolute inset-0 pointer-events-none"
                style={{ background: `linear-gradient(180deg, transparent 60%, ${COLORS.blueDeepest}33 100%)` }} />
            </div>

            {/* Badge Zap (acento verde, equivalente al rayo amarillo del reference) */}
            <div className="absolute -left-6 bottom-12 w-16 h-16 rounded-full bg-white flex items-center justify-center shadow-xl ring-4"
              style={{ boxShadow: "0 12px 32px rgba(49,163,84,0.4)" }}>
              <div className="w-12 h-12 rounded-full flex items-center justify-center"
                style={{ background: `linear-gradient(135deg, ${COLORS.greenPrimary} 0%, ${COLORS.greenDark} 100%)` }}>
                <Zap size={22} className="text-white fill-white" />
              </div>
            </div>

            {/* Caption flotante */}
            <div className="absolute top-4 right-4 px-3 py-1.5 rounded-full backdrop-blur-md bg-white/15 border border-white/25">
              <span className="text-[11px] font-semibold tracking-wider text-white uppercase">Gecelca3</span>
            </div>
          </div>
        </div>
      </div>

      {/* Pill decorativa "dashboard" */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 inline-flex items-center gap-2 px-5 py-2 rounded-full text-white shadow-xl select-none"
        style={{ backgroundColor: COLORS.blueDeepest, border: `1px solid ${COLORS.blueDark}` }}
        aria-hidden="true">
        <LayoutDashboard size={15} style={{ color: COLORS.greenPrimary }} />
        <span className="text-sm font-semibold">dashboard</span>
      </div>
    </div>
  );
}

// ============================================================
// Header
// ============================================================

function Header({ user, sesion, cargoNombre, plantaNombre, usuariosActivos, sesionActualId, onLogout, vista, onToggleVista }) {
  const [reloj, setReloj] = useState(new Date());
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const i = setInterval(() => setReloj(new Date()), 30000);
    return () => clearInterval(i);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocMouseDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [menuOpen]);

  const fechaStr = RELOJ_FECHA_FMT.format(reloj);
  const horaStr = RELOJ_HORA_FMT.format(reloj);
  const activos = usuariosActivos || [];

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
        {onToggleVista && (
          <button
            onClick={onToggleVista}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-white/10 transition-colors text-sm font-semibold"
            title={vista === 'historicos' ? 'Volver a bitácoras' : 'Ver históricos'}
            aria-pressed={vista === 'historicos'}
          >
            {vista === 'historicos' ? <FileText size={18} /> : <History size={18} />}
            <span className="hidden md:inline">
              {vista === 'historicos' ? 'Bitácoras' : 'Históricos'}
            </span>
          </button>
        )}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-white/10 transition-colors"
            title="Usuarios conectados"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <Users size={18} />
            <span className="text-sm font-semibold">{activos.length}</span>
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-2 w-80 max-h-96 overflow-auto bg-white text-gray-800 rounded-xl shadow-xl border border-gray-200 z-20"
            >
              <div className="px-4 py-2 border-b border-gray-100 text-xs uppercase tracking-wide text-gray-500">
                Conectados ({activos.length})
              </div>
              {activos.length === 0 ? (
                <div className="px-4 py-6 text-sm text-gray-400 text-center">Nadie más conectado</div>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {activos.map((u) => (
                    <li key={u.sesion_id} className="px-4 py-2.5 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate">
                          {u.nombre_completo}
                          {u.sesion_id === sesionActualId && (
                            <span className="ml-2 text-xs font-medium text-emerald-600">(tú)</span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500 truncate">
                          {u.cargo_nombre} — {u.planta_nombre}
                        </div>
                      </div>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 whitespace-nowrap">
                        T{u.turno}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

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

const UMBRAL_ALTO = 5;

function nivelCarga(count) {
  if (count >= UMBRAL_ALTO) return "alto";
  if (count > 0) return "medio";
  return "nulo";
}

// Categorías de bitácoras: agrupan en un solo botón fijo a la izquierda con flyout en hover.
// Hardcoded en frontend porque hoy solo hay una categoría; cuando aparezca otra, mover a BD
// (lov_bit.bitacora.categoria_codigo + lov_bit.categoria).
const CATEGORIAS = [
  {
    codigo: 'SALA_DE_MANDOS',
    nombre: 'Operación 24h',
    nombreCorto: '24h',
    icono: 'MonitorCog',
    bitacora_codigos: ['DISP', 'MAND'],
  },
];

// Bitácoras que NO muestran badge numérico. DISP por su naturaleza (siempre 1 estado activo,
// el count no aporta señal de "sin cerrar").
const SIN_BADGE_CODIGOS = new Set(['DISP']);

function BitacoraTabs({ bitacoras, categorias, activeId, onSelect, registrosPorBitacora }) {
  const registerNode = useFlipReorder(bitacoras, "bitacora_id");
  return (
    <div className="bg-white border-b border-gray-200 px-4 overflow-x-auto">
      <div className="flex gap-1 min-w-max py-2">
        {categorias?.map((cat) => (
          <CategoriaTab
            key={cat.codigo}
            categoria={cat}
            activeId={activeId}
            onSelect={onSelect}
            registrosPorBitacora={registrosPorBitacora}
          />
        ))}
        {bitacoras.map((b) => {
          const isActive = b.bitacora_id === activeId;
          const IconComp = ICON_MAP[b.icono] || FileText;
          const count = registrosPorBitacora[b.bitacora_id] || 0;
          const nivel = nivelCarga(count);
          const showBadge = !SIN_BADGE_CODIGOS.has(b.codigo);

          let baseClass = "text-gray-600 hover:bg-gray-100 hover:text-gray-900";
          let baseStyle = {};
          if (isActive) {
            baseClass = "text-white shadow-md";
            baseStyle = { backgroundColor: COLORS.blueDark };
          } else if (nivel === "alto") {
            baseClass = "text-red-800 bg-red-50 hover:bg-red-100 ring-1 ring-red-200";
          } else if (nivel === "medio") {
            baseClass = "text-amber-800 bg-amber-50 hover:bg-amber-100 ring-1 ring-amber-200";
          }

          let dotColor = null;
          if (nivel === "alto") dotColor = isActive ? "#fff" : COLORS.red;
          else if (nivel === "medio") dotColor = isActive ? "#fff" : COLORS.yellow;

          let badgeClass = "bg-gray-200 text-gray-600";
          if (isActive) badgeClass = "bg-white/20 text-white";
          else if (nivel === "alto") badgeClass = "bg-red-200 text-red-900";
          else if (nivel === "medio") badgeClass = "bg-amber-200 text-amber-900";

          return (
            <button
              key={b.bitacora_id}
              ref={(node) => registerNode(b.bitacora_id, node)}
              onClick={() => onSelect(b.bitacora_id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap ${baseClass}`}
              style={baseStyle}
              aria-label={count > 0 ? `${b.nombre}, ${count} registros sin cerrar` : b.nombre}
            >
              {dotColor && (
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: dotColor }} />
              )}
              <IconComp size={16} />
              <span className="hidden lg:inline">{b.nombre}</span>
              <span className="lg:hidden">{b.codigo}</span>
              {showBadge && (
                <span className={`ml-1 min-w-5 h-5 flex items-center justify-center rounded-full text-xs font-bold ${badgeClass}`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Botón de categoría con flyout. El flyout se monta en document.body via Portal porque
// el contenedor padre tiene overflow-x-auto, lo que clipea cualquier popover absolute.
function CategoriaTab({ categoria, activeId, onSelect, registrosPorBitacora }) {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const buttonRef = useRef(null);
  const openTimer = useRef(null);
  const closeTimer = useRef(null);

  const open = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = setTimeout(() => setIsOpen(true), 80);
  };
  const close = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    closeTimer.current = setTimeout(() => setIsOpen(false), 150);
  };

  // Posiciona el flyout debajo del botón cuando se abre.
  useEffect(() => {
    if (!isOpen || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setPosition({ top: rect.bottom + 4, left: rect.left });
  }, [isOpen]);

  // Cerrar con Esc, click afuera, scroll o resize.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setIsOpen(false); };
    const onClickOutside = (e) => {
      const btn = buttonRef.current;
      const flyout = document.getElementById(`flyout-${categoria.codigo}`);
      if (btn?.contains(e.target)) return;
      if (flyout?.contains(e.target)) return;
      setIsOpen(false);
    };
    const onScrollOrResize = () => setIsOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClickOutside);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClickOutside);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [isOpen, categoria.codigo]);

  // Limpia timers al desmontar.
  useEffect(() => () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  const algunaActiva = categoria.bitacoras.some((b) => b.bitacora_id === activeId);
  const maxNivel = categoria.bitacoras.reduce((acc, b) => {
    const n = nivelCarga(registrosPorBitacora[b.bitacora_id] || 0);
    if (acc === 'alto') return acc;
    if (n === 'alto') return 'alto';
    if (n === 'medio') return 'medio';
    return acc;
  }, 'nulo');

  const Icon = ICON_MAP[categoria.icono] || FileText;

  let dotColor = null;
  if (maxNivel === 'alto') dotColor = COLORS.red;
  else if (maxNivel === 'medio') dotColor = COLORS.yellow;

  let baseClass = "text-gray-600 hover:bg-gray-100 hover:text-gray-900";
  if (algunaActiva) {
    baseClass = "text-gray-900 bg-gray-50 ring-1 ring-gray-300";
  } else if (maxNivel === 'alto') {
    baseClass = "text-red-800 bg-red-50 hover:bg-red-100 ring-1 ring-red-200";
  } else if (maxNivel === 'medio') {
    baseClass = "text-amber-800 bg-amber-50 hover:bg-amber-100 ring-1 ring-amber-200";
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setIsOpen((o) => !o)}
        onMouseEnter={open}
        onMouseLeave={close}
        aria-haspopup="true"
        aria-expanded={isOpen}
        className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap ${baseClass}`}
      >
        {dotColor && (
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: dotColor }} />
        )}
        <Icon size={16} />
        <span className="hidden lg:inline">{categoria.nombre}</span>
        <span className="lg:hidden">{categoria.nombreCorto}</span>
        <ChevronDown
          size={14}
          className={`transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {isOpen && createPortal(
        <div
          id={`flyout-${categoria.codigo}`}
          role="menu"
          onMouseEnter={open}
          onMouseLeave={close}
          className="bg-white rounded-xl shadow-lg border border-gray-200 py-2 min-w-[240px]"
          style={{ position: 'fixed', top: position.top, left: position.left, zIndex: 50 }}
        >
          {categoria.bitacoras.map((b) => {
            const isActive = b.bitacora_id === activeId;
            const IconHija = ICON_MAP[b.icono] || FileText;
            const count = registrosPorBitacora[b.bitacora_id] || 0;
            const nivel = nivelCarga(count);
            const showBadge = !SIN_BADGE_CODIGOS.has(b.codigo);

            let itemClass = "text-gray-700 hover:bg-gray-100";
            let itemStyle = {};
            if (isActive) {
              itemClass = "text-white";
              itemStyle = { backgroundColor: COLORS.blueDark };
            }

            let dotColorItem = null;
            if (nivel === 'alto') dotColorItem = isActive ? '#fff' : COLORS.red;
            else if (nivel === 'medio') dotColorItem = isActive ? '#fff' : COLORS.yellow;

            let badgeClass = "bg-gray-200 text-gray-600";
            if (isActive) badgeClass = "bg-white/20 text-white";
            else if (nivel === 'alto') badgeClass = "bg-red-200 text-red-900";
            else if (nivel === 'medio') badgeClass = "bg-amber-200 text-amber-900";

            return (
              <button
                key={b.bitacora_id}
                type="button"
                role="menuitem"
                onClick={() => { onSelect(b.bitacora_id); setIsOpen(false); }}
                className={`w-full flex items-center gap-2 px-4 py-2 text-sm font-medium ${itemClass}`}
                style={itemStyle}
              >
                {dotColorItem ? (
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: dotColorItem }} />
                ) : (
                  <span className="w-2 flex-shrink-0" />
                )}
                <IconHija size={16} />
                <span className="flex-1 text-left">{b.nombre}</span>
                {showBadge && (
                  <span className={`min-w-5 h-5 flex items-center justify-center rounded-full text-xs font-bold ${badgeClass}`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </>
  );
}

// ============================================================
// Barra de estado
// ============================================================

function BarraEstado({
  bitacora, registros, estadoBitacora, puedeCrear, esJefeTurno,
  onCerrarTurno, onCerrarMasivo, onFinalizarTurno, finalizandoTurno,
  filtroTexto, setFiltroTexto, filtroTipo, setFiltroTipo,
  filtroFecha, setFiltroFecha, filtroTurno, setFiltroTurno,
  tiposEvento, onAddRegistro,
  mandDirty, mandGuardando, onGuardarMand,
}) {
  const isMand = bitacora?.codigo === 'MAND';
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

      {/* F11: filtros fecha+turno para no-MAND. MAND tiene su propia paginación entre días
          (F10) y muestra los 24 periodos, así que el turno es derivable visualmente. */}
      {bitacora?.codigo !== 'MAND' && (
        <div className="flex items-center gap-2 flex-wrap">
          <Calendar size={16} className="text-gray-400" />
          <button
            onClick={() => setFiltroFecha(shiftDate(filtroFecha || getTodayBogota(), -1))}
            title="Día anterior"
            className="p-1.5 rounded border border-gray-200 hover:bg-gray-50"
          >
            <ChevronLeft size={16} />
          </button>
          <input
            type="date"
            value={filtroFecha}
            onChange={(e) => setFiltroFecha(e.target.value)}
            className="px-3 py-2 rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
          />
          <button
            onClick={() => setFiltroFecha(shiftDate(filtroFecha || getTodayBogota(), 1))}
            title="Día siguiente"
            className="p-1.5 rounded border border-gray-200 hover:bg-gray-50"
          >
            <ChevronRight size={16} />
          </button>
          <button
            onClick={() => setFiltroFecha(getTodayBogota())}
            title="Saltar a hoy"
            className="px-3 py-2 rounded-xl border border-gray-300 text-sm font-medium hover:bg-gray-50"
          >
            Hoy
          </button>
          <select
            value={filtroTurno}
            onChange={(e) => setFiltroTurno(e.target.value)}
            className="px-3 py-2 rounded-xl border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400"
          >
            <option value="">Todos los turnos</option>
            <option value="1">Turno 1 (Diurno)</option>
            <option value="2">Turno 2 (Nocturno)</option>
          </select>
          {(filtroFecha || filtroTurno) && (
            <button
              onClick={() => { setFiltroFecha(''); setFiltroTurno(''); }}
              title="Limpiar filtros de fecha y turno"
              className="text-xs text-gray-500 hover:text-gray-700 underline"
            >
              Limpiar
            </button>
          )}
        </div>
      )}

      {/* F17: filtros de búsqueda no aplican a MAND — la grilla muestra solo HOY. */}
      {!isMand && (
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
      )}

      {/* F17: en MAND el slot del "+ Nuevo Registro" se reemplaza por el botón "Guardar"
          que despacha el batch save del child via mandSaveRef. */}
      {isMand ? (
        puedeCrear && (
          <button
            onClick={onGuardarMand}
            disabled={!mandDirty || mandGuardando}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white shadow-sm hover:shadow-md transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ backgroundColor: COLORS.greenPrimary }}
          >
            <Save size={16} />
            {mandGuardando ? 'Guardando…' : 'Guardar'}
          </button>
        )
      ) : (
        puedeCrear && (
          <button onClick={onAddRegistro}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white shadow-sm hover:shadow-md transition-all"
            style={{ backgroundColor: COLORS.greenPrimary }}>
            <Plus size={18} />
            Nuevo Registro
          </button>
        )
      )}

      {/* F4: "Finalizar turno" para todo ingeniero logueado (preguntas3.md punto E). Finaliza
          globalmente todas sus sesion_bitacora y emite CIET. Convive con el popup de logout.
          F17: oculto en MAND (cierre del día es automático vía sweeper). */}
      {!isMand && onFinalizarTurno && (
        <button onClick={onFinalizarTurno} disabled={finalizandoTurno}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white shadow-sm hover:shadow-md transition-all disabled:opacity-60"
          style={{ backgroundColor: COLORS.greenDark }}>
          <CheckCircle2 size={16} />
          {finalizandoTurno ? 'Finalizando…' : 'Finalizar Turno'}
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

      {/* F4: cierre masivo con popup de pendientes — solo cargos puede_cerrar_turno.
          F17: oculto en MAND (sweeper automático en lugar de cierre manual). */}
      {!isMand && esJefeTurno && (
        <button onClick={onCerrarMasivo}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-colors shadow-sm hover:shadow-md"
          style={{ backgroundColor: COLORS.blueDeep }}>
          <Lock size={16} />
          Cerrar Masivo
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
  filtroTexto, filtroTipo, filtroFecha, filtroTurno,
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
      .filter((r) => {
        if (!filtroFecha) return true;
        return toBogotaDate(r.fecha_evento) === filtroFecha;
      })
      .filter((r) => (filtroTurno ? String(r.turno) === String(filtroTurno) : true))
      .sort((a, b) => new Date(a.fecha_evento) - new Date(b.fecha_evento));
  }, [registros, filtroTexto, filtroTipo, filtroFecha, filtroTurno]);

  const hayFiltrosActivos = !!(filtroTexto || filtroTipo || filtroFecha || filtroTurno);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-auto px-6 py-4">
        {regs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-gray-400">
            <FileText size={48} className="mb-4 opacity-50" />
            {hayFiltrosActivos ? (
              <>
                <p className="text-lg font-medium">No hay registros para los filtros aplicados</p>
                <p className="text-sm mt-1">Prueba limpiar fecha, turno, tipo o texto.</p>
              </>
            ) : (
              <>
                <p className="text-lg font-medium">No hay registros aún</p>
                <p className="text-sm mt-1">
                  {puedeCrear ? "Haz clic en \"Nuevo Registro\" para comenzar" : "Esta bitácora no tiene registros del día"}
                </p>
              </>
            )}
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
                value={toBogotaLocal(reg.fecha_evento)}
                onChange={(e) => {
                  const v = e.target.value;
                  onUpdate("fecha_evento", v);
                  onUpdate("turno", turnoFromFechaLocal(v));
                }}
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
  const usuariosActivos = useUsuariosActivos(auth.ready, auth.sesion?.sesion_id);
  const { counts: registrosPorBitacora } = useBitacoraCounts(
    auth.ready,
    auth.sesion?.sesion_id,
    auth.sesion?.planta_id,
  );

  const [activeBitacora, setActiveBitacora] = useState(null);
  const [tiposEvento, setTiposEvento] = useState([]);
  const [filtroTexto, setFiltroTexto] = useState("");
  const [filtroTipo, setFiltroTipo] = useState("");
  // F11: filtros fecha+turno para bitácoras no-MAND. Persisten en sessionStorage para
  // sobrevivir al cambio de tab y al refresh, no entre sesiones del navegador.
  const [filtroFecha, setFiltroFecha] = useState(
    () => sessionStorage.getItem('bitacoras.filtroFecha') || ''
  );
  const [filtroTurno, setFiltroTurno] = useState(
    () => sessionStorage.getItem('bitacoras.filtroTurno') || ''
  );
  useEffect(() => { sessionStorage.setItem('bitacoras.filtroFecha', filtroFecha); }, [filtroFecha]);
  useEffect(() => { sessionStorage.setItem('bitacoras.filtroTurno', filtroTurno); }, [filtroTurno]);
  const [toast, setToast] = useState(null);
  const [modal, setModal] = useState(null);
  const [draftLocal, setDraftLocal] = useState(null);
  const [vista, setVista] = useState('bitacoras');

  // F2: marca participación cuando el usuario abre una bitácora. Idempotente — reabrir tras
  // finalizar el turno crea una nueva ventana de participación sin requerir re-login.
  useBitacoraSesion(auth.sesion?.sesion_id ? activeBitacora : null);

  // F4: hook para botón "Finalizar Turno" del header.
  const { finalizar: finalizarTurno, loading: finalizandoTurno } = useFinalizarTurno();
  const [pendientesModal, setPendientesModal] = useState(null);
  // F17: estado lifted desde SalaDeMandoGrid para que el botón "Guardar" del header sepa
  // si hay diff pendiente y dispare la batch via ref. mandSaveRef.current es la fn que
  // el child registra al montar (registerSaveHandler).
  const [mandDirty, setMandDirty] = useState(false);
  const [mandGuardando, setMandGuardando] = useState(false);
  const mandSaveRef = useRef(null);
  const registerMandSave = useCallback((fn) => { mandSaveRef.current = fn; }, []);

  const showToast = useCallback((message, type = "success") => {
    setToast({ message, type, key: Date.now() });
  }, []);

  // F18-fix: callback estable para SalaDeMandoGrid. Sin esto, la arrow inline se recreaba
  // en cada render del padre, invalidaba `refresh` (useCallback con dep [onError]) en el
  // child y disparaba un re-fetch que limpiaba el buffer + editing → valores tipeados se
  // borraban antes de poder guardarlos.
  const handleMandError = useCallback((m) => showToast(m, 'error'), [showToast]);

  const sesion = auth.sesion;
  const user = auth.user;

  // Las bitácoras visibles se separan en (a) categorías agrupadas en un solo botón fijo
  // a la izquierda y (b) bitácoras "sueltas" que siguen siendo tabs reordenables por count.
  const { categorias: categoriasVisibles, bitacorasSueltas } = useMemo(() => {
    const base = catalogos.permisos.length
      ? (() => {
          const map = new Map(catalogos.permisos.map((p) => [p.bitacora_id, p]));
          return catalogos.bitacoras.filter((b) => map.get(b.bitacora_id)?.puede_ver);
        })()
      : catalogos.bitacoras;

    const codigosCategorizados = new Set(CATEGORIAS.flatMap((c) => c.bitacora_codigos));

    const cats = CATEGORIAS.map((c) => ({
      ...c,
      bitacoras: base.filter((b) => c.bitacora_codigos.includes(b.codigo)),
    })).filter((c) => c.bitacoras.length > 0);

    const sueltas = base
      .filter((b) => !codigosCategorizados.has(b.codigo))
      .sort((a, b) => {
        const ca = registrosPorBitacora[a.bitacora_id] || 0;
        const cb = registrosPorBitacora[b.bitacora_id] || 0;
        if (cb !== ca) return cb - ca;
        return (a.orden ?? 0) - (b.orden ?? 0);
      });

    return { categorias: cats, bitacorasSueltas: sueltas };
  }, [catalogos.bitacoras, catalogos.permisos, registrosPorBitacora]);

  // Lista plana usada por el resto del código (selección inicial, lookup por id, etc.).
  const bitacorasPermitidas = useMemo(
    () => [...categoriasVisibles.flatMap((c) => c.bitacoras), ...bitacorasSueltas],
    [categoriasVisibles, bitacorasSueltas]
  );

  const cargoNombre = catalogos.cargos.find((c) => c.cargo_id === sesion?.cargo_id)?.nombre || "";
  const plantaNombre = catalogos.plantas.find((p) => p.planta_id === sesion?.planta_id)?.nombre || sesion?.planta_id || "";
  // Puede cerrar turno y editar cualquier registro — hoy: Ingeniero Jefe de Turno e Ingeniero de Operación.
  // El flag lo trae loadSession() desde lov_bit.cargo.puede_cerrar_turno (desacoplado del nombre del cargo).
  const esJefeTurno = !!sesion?.puede_cerrar_turno;

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
      fecha_evento: nowBogotaLocal(),
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
      const fechaEventoIso = bogotaLocalToIso(reg.fecha_evento);
      if (!reg.registro_id) {
        // Crear
        const creado = await registrosHook.crear({
          bitacora_id: reg.bitacora_id,
          planta_id: reg.planta_id,
          fecha_evento: fechaEventoIso,
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
          fecha_evento: fechaEventoIso,
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

  // F4: botón "Cerrar Masivo" — abre modal con preview de pendientes antes de cerrar.
  const handleCerrarMasivo = useCallback(async () => {
    try {
      const preview = await cierre.previewMasivo(sesion.planta_id);
      setPendientesModal({ preview });
    } catch (e) {
      showToast(e.message, 'error');
    }
  }, [cierre, sesion, showToast]);

  const handleConfirmMasivo = useCallback(async () => {
    if (!pendientesModal?.preview) return;
    const usuarios_pendientes = pendientesModal.preview.ingenieros_no_finalizados.map((u) => u.usuario_id);
    try {
      const r = await cierre.cerrarMasivoConFinalizacionForzada({
        planta_id: sesion.planta_id,
        usuarios_pendientes,
      });
      if (activeBitacora) {
        await registrosHook.getActivos({ planta_id: sesion.planta_id, bitacora_id: activeBitacora });
      }
      setPendientesModal(null);
      // F17: ya no avisamos a SalaDeMandoGrid — la grilla MAND solo muestra HOY y no
      // depende de la lista de días pendientes (eliminada en F16/F17).
      const totalCerrados = (r.resumen || []).reduce((acc, x) => acc + (x.registros_cerrados || 0), 0);
      showToast(`Cierre masivo: ${totalCerrados} registro(s) cerrado(s), ${r.finalizados.length} ingeniero(s) finalizado(s)`);
    } catch (e) {
      showToast(e.message, 'error');
    }
  }, [pendientesModal, cierre, sesion, activeBitacora, registrosHook, showToast]);

  // F4: botón "Finalizar Turno" — finaliza globalmente todas las sesion_bitacora del usuario
  // actual y emite UN CIET. No cierra registros (eso es del JdT/IngOp).
  const handleFinalizarTurno = useCallback(async () => {
    setModal({
      title: 'Finalizar turno',
      message: 'Esto registra que terminaste tu turno. Tu actividad se marcará como finalizada en todas las bitácoras donde participas. ¿Continuar?',
      confirmLabel: 'Finalizar', confirmColor: 'green', icon: CheckCircle2,
      onConfirm: async () => {
        try {
          const r = await finalizarTurno();
          setModal(null);
          showToast(`Turno finalizado en ${r.finalizadas?.length || 0} bitácora(s)`);
        } catch (e) {
          showToast(e.message, 'error');
        }
      },
    });
  }, [finalizarTurno, showToast]);

  // F4: popup defensivo en logout — pregunta si quiere finalizar antes de salir.
  // 3 opciones: Sí, finalizar y salir / No, salir directo / Cancelar.
  // "Salir sin finalizar" hace solo cleanup local (D-003): sesion_activa.activa=1 queda
  // como antes (equivalente a cerrar pestaña). "Sí, finalizar y salir" finaliza turno
  // y dispara logout backend (activa=0).
  const handleLogout = useCallback(() => {
    setModal({
      title: 'Cerrar sesión',
      message: '¿Finalizas tu turno antes de salir? Si lo haces, se registra en histórico que terminaste tu participación.',
      confirmLabel: 'Sí, finalizar y salir',
      confirmColor: 'green',
      icon: LogOut,
      secondaryLabel: 'No, salir sin finalizar',
      onSecondary: () => {
        auth.logoutLocal();
        setModal(null);
        setActiveBitacora(null);
        setDraftLocal(null);
      },
      onConfirm: async () => {
        try { await finalizarTurno(); } catch {}
        await auth.logout();
        setModal(null);
        setActiveBitacora(null);
        setDraftLocal(null);
      },
    });
  }, [auth, finalizarTurno]);

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
      <Header
        user={user}
        sesion={sesion}
        cargoNombre={cargoNombre}
        plantaNombre={plantaNombre}
        usuariosActivos={usuariosActivos.usuarios}
        sesionActualId={sesion?.sesion_id}
        onLogout={handleLogout}
        vista={vista}
        onToggleVista={() => setVista((v) => (v === 'historicos' ? 'bitacoras' : 'historicos'))}
      />

      {vista === 'historicos' ? (
        <HistoricoView plantaSesion={sesion?.planta_id} />
      ) : (
        <>
          <BitacoraTabs
            bitacoras={bitacorasSueltas}
            categorias={categoriasVisibles}
            activeId={activeBitacora}
            onSelect={(id) => { setActiveBitacora(id); setFiltroTexto(""); setFiltroTipo(""); setDraftLocal(null); }}
            registrosPorBitacora={registrosPorBitacora}
          />

          {bitacoraActiva && bitacoraActiva.codigo !== 'DISP' && (
            <BarraEstado
              bitacora={bitacoraActiva}
              registros={registrosDeBitacora}
              estadoBitacora={estadoBitacora}
              puedeCrear={puedeCrear}
              esJefeTurno={esJefeTurno}
              onCerrarTurno={handleCerrarTurno}
              onCerrarMasivo={handleCerrarMasivo}
              onFinalizarTurno={handleFinalizarTurno}
              finalizandoTurno={finalizandoTurno}
              filtroTexto={filtroTexto} setFiltroTexto={setFiltroTexto}
              filtroTipo={filtroTipo} setFiltroTipo={setFiltroTipo}
              filtroFecha={filtroFecha} setFiltroFecha={setFiltroFecha}
              filtroTurno={filtroTurno} setFiltroTurno={setFiltroTurno}
              tiposEvento={tiposEvento}
              onAddRegistro={handleAddRegistro}
              mandDirty={mandDirty}
              mandGuardando={mandGuardando}
              onGuardarMand={() => mandSaveRef.current?.()}
            />
          )}

          {bitacoraActiva?.codigo === 'MAND' ? (
            <SalaDeMandoGrid
              bitacora={bitacoraActiva}
              plantaId={sesion?.planta_id}
              puedeCrear={puedeCrear}
              showToast={showToast}
              onError={handleMandError}
              onDirtyChange={setMandDirty}
              onGuardandoChange={setMandGuardando}
              registerSaveHandler={registerMandSave}
            />
          ) : bitacoraActiva?.codigo === 'DISP' ? (
            <DisponibilidadDashboard
              bitacoraId={bitacoraActiva.bitacora_id}
              plantaInicial={sesion?.planta_id}
              puedeEditar={puedeCrear}
              showToast={showToast}
            />
          ) : (
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
              filtroFecha={filtroFecha}
              filtroTurno={filtroTurno}
            />
          )}
        </>
      )}

      {toast && (<Toast key={toast.key} message={toast.message} type={toast.type} onClose={() => setToast(null)} />)}
      {modal && (
        <ConfirmModal
          open={true}
          title={modal.title} message={modal.message}
          confirmLabel={modal.confirmLabel} confirmColor={modal.confirmColor}
          icon={modal.icon}
          secondaryLabel={modal.secondaryLabel}
          onSecondary={modal.onSecondary}
          onConfirm={modal.onConfirm}
          onCancel={() => setModal(null)}
        />
      )}

      {pendientesModal && (
        <CierrePendientesModal
          open={true}
          preview={pendientesModal.preview}
          bitacorasMap={new Map(catalogos.bitacoras.map((b) => [b.bitacora_id, b.nombre]))}
          loading={cierre.loading}
          onConfirm={handleConfirmMasivo}
          onCancel={() => setPendientesModal(null)}
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
