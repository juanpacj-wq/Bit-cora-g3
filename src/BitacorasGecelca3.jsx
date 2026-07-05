// ============================================================
// Bitácoras Gecelca3 — conectado a backend (localhost:3002)
// React + Tailwind + Lucide
// ============================================================

import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  LogIn, LogOut, Clock, Plus, Save, Trash2, Lock, Unlock, CheckCircle2, RotateCcw,
  AlertTriangle, X, ChevronDown, ChevronLeft, ChevronRight, Calendar,
  Search, Filter, FileText,
  Activity, Flame, Droplets, Zap, Gauge, Cpu, FlaskConical, Leaf,
  Settings, FileCheck, Edit3, Eye, XCircle, Check, Users, History,
  LayoutDashboard, MonitorCog, Menu, ArrowLeftRight,
} from "lucide-react";
import { HistoricoView } from "./components/historicos/HistoricoView";
import TurnoTransicionModal from "./components/TurnoTransicionModal";
import CierrePendientesModal from "./components/CierrePendientesModal";
import LogoutModal from "./components/LogoutModal";
import SalaDeMandoGrid from "./components/SalaDeMando/SalaDeMandoGrid";
import DisponibilidadDashboard from "./components/Disponibilidad/DisponibilidadDashboard";
import ConsumosGrid from "./components/Combustibles/ConsumosGrid";
import { useAuth } from "./hooks/useAuth";
import { useCatalogos } from "./hooks/useCatalogos";
import { useRegistros } from "./hooks/useRegistros";
import { useTurno } from "./hooks/useTurno";
import { useCierre } from "./hooks/useCierre";
import { useUsuariosActivos } from "./hooks/useUsuariosActivos";
import { useBitacoraCounts } from "./hooks/useBitacoraCounts";
import { useFlipReorder } from "./hooks/useFlipReorder";
import { useBitacoraSesion, useFinalizarTurno, useRevertirTurno } from "./hooks/useBitacoraSesion";
import { useAppRoute } from "./hooks/useAppRoute";
import { buildHash } from "./routing/appRoute";
import { getTodayBogota, shiftDate, horaBogota } from "./utils/fecha";
import { FILTROS_VACIOS } from "./utils/filtros";
import { asset } from "./config/paths";

const COLORS = {
  greenPrimary: "#31a354", greenDark: "#006f36", greenDeepest: "#011a0e",
  blueDark: "#003566", blueDeep: "#001d3d", blueDeepest: "#011027",
  red: "#DC3545", yellow: "#FFC107",
  grayLight: "#f8f9fa", grayMid: "#e9ecef", grayBorder: "#dee2e6",
  grayText: "#6c757d", white: "#ffffff",
};

// Tema visual del header por unidad: azul = GEC3, verde = GEC32, para que sea obvio en qué
// unidad se hizo login. En tema verde los acentos (badge de turno, avatar) se invierten a
// azul — sobre el gradiente verde los acentos verdes se camuflan. Clases Tailwind como
// literales completos (requisito del JIT). Fallback azul para plantas desconocidas (TST).
const TEMA_UNIDAD = {
  GEC3: {
    gradiente: `linear-gradient(90deg, ${COLORS.blueDeepest} 0%, ${COLORS.blueDark} 100%)`,
    textoSuave: "text-blue-300",
    textoReloj: "text-blue-200",
    badgeBg: COLORS.greenPrimary,
    avatarBg: COLORS.greenDark,
  },
  GEC32: {
    gradiente: `linear-gradient(90deg, ${COLORS.greenDeepest} 0%, ${COLORS.greenDark} 100%)`,
    textoSuave: "text-emerald-300",
    textoReloj: "text-emerald-200",
    badgeBg: COLORS.blueDark,
    avatarBg: COLORS.blueDeep,
  },
};
const temaUnidad = (plantaId) => TEMA_UNIDAD[plantaId] || TEMA_UNIDAD.GEC3;

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

// URL del dashboard hermano (dashboard-gen-gec3). En el despliegue unificado vive en /dashboard
// del MISMO dominio; en dev corre en su propio server (localhost:5173, mientras bitácora está en
// 5174). Default inteligente por entorno; se puede forzar con VITE_DASHBOARD_URL en el .env.
const DASHBOARD_URL = import.meta.env.VITE_DASHBOARD_URL
  || (import.meta.env.DEV ? 'http://localhost:5173/' : '/dashboard/');

function LoginScreen({ auth, plantas, onReady, showToast }) {
  // Login Entra ID: dos pasos. 'microsoft' (sin sesión Entra) → 'planta' (autenticado, elige
  // planta). El cargo lo asigna Entra automáticamente desde los App Roles; ya NO hay paso de
  // selección de cargo ni de credenciales.
  const paso = auth.user ? "planta" : "microsoft";

  // Surfacing de resultados del callback OIDC (/?auth=...): error → toast, y limpiamos la URL
  // para no repetir el toast al recargar.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const a = params.get("auth");
    if (!a) return;
    if (a === "no_acceso") {
      showToast("Tu cuenta no tiene acceso a Bitácoras en Microsoft Entra.", "error");
    } else if (a === "error" || a === "state_invalido") {
      showToast("No se pudo completar el inicio de sesión. Intenta de nuevo.", "error");
    }
    params.delete("auth");
    const qs = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (qs ? "?" + qs : ""));
  }, [showToast]);

  const handleSelectPlanta = async (planta_id) => {
    try {
      await auth.selectContext(planta_id);
      onReady();
    } catch (err) {
      showToast(err.message || "Error al seleccionar planta", "error");
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
            <img src={asset("/gecelca3-logo.png")} alt="Gecelca3" className="h-11 mx-auto mb-3"
              onError={(e) => { e.target.style.display = "none"; }} />
            {paso === "microsoft" ? (
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
                  Selecciona tu planta de operación
                </p>
              </>
            )}
          </div>

          {paso === "microsoft" && (
            <div className="space-y-5 max-w-sm mx-auto w-full">
              <p className="text-center text-sm" style={{ color: COLORS.grayText }}>
                Accede con tu cuenta corporativa de Microsoft. Tu rol se asigna automáticamente.
              </p>
              <button
                type="button"
                onClick={() => auth.loginWithMicrosoft()}
                className="w-full flex items-center justify-center gap-3 py-3 rounded-xl border bg-white shadow-sm hover:shadow-lg hover:-translate-y-0.5 transition-all"
                style={{ borderColor: COLORS.grayBorder }}
                aria-label="Iniciar sesión con Microsoft"
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
            </div>
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
                    onClick={() => handleSelectPlanta(p.planta_id)}
                    disabled={auth.loading}
                    className="w-full flex items-center gap-4 p-4 rounded-2xl border-2 border-gray-100 hover:border-emerald-400 hover:shadow-lg transition-all group text-left bg-white disabled:opacity-60"
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

          {/* Foto de la planta enmarcada. El marco tiene altura fija + degradado de fondo propio:
              si la imagen falla (red corporativa), onError la oculta y queda el degradado de marca
              —panel intencional, NO una caja vacía como antes—. La foto pesa ~180 KB (antes 2 MB,
              causa del render vacío intermitente). width/height evitan reflow; eager + fetchPriority
              la priorizan en el primer paint. */}
          <div className="relative w-full max-w-sm">
            <div className="relative h-[460px] rounded-3xl overflow-hidden shadow-2xl ring-1 ring-white/20"
              style={{ background: `linear-gradient(160deg, ${COLORS.blueDeep} 0%, ${COLORS.greenDark} 100%)` }}>
              <img src={asset("/planta-gecelca3.jpg")} alt="Planta Gecelca3"
                width={880} height={889} loading="eager" decoding="async" fetchPriority="high"
                className="w-full h-full object-cover"
                onError={(e) => { e.currentTarget.style.display = "none"; }} />
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

      {/* Acceso al dashboard de generación (app hermana). Pestaña NUEVA (el navegador la
          enfoca): la bitácora queda abierta en la pestaña original. noopener corta la
          referencia window.opener hacia esta app. */}
      <a href={DASHBOARD_URL} target="_blank" rel="noopener noreferrer"
        className="absolute bottom-6 left-1/2 -translate-x-1/2 inline-flex items-center gap-2 px-5 py-2 rounded-full text-white shadow-xl select-none no-underline cursor-pointer hover:-translate-y-0.5 hover:shadow-2xl transition-all"
        style={{ backgroundColor: COLORS.blueDeepest, border: `1px solid ${COLORS.blueDark}` }}
        aria-label="Abrir el dashboard de generación en una pestaña nueva"
        title="Abrir el dashboard de generación en una pestaña nueva">
        <LayoutDashboard size={15} style={{ color: COLORS.greenPrimary }} />
        <span className="text-sm font-semibold">dashboard</span>
      </a>
    </div>
  );
}

// ============================================================
// Header
// ============================================================

// Menú de navegación (hamburguesa) del header. Portal a document.body — mismo patrón que el
// popup de usuarios conectados y los flyout de categorías — para no quedar clipeado por el
// overflow del header. Agrupa las acciones globales antes dispersas: Dashboard (app hermana,
// pestaña nueva), toggle Históricos/Bitácoras (antes botón suelto del nav), "Cambiar de unidad"
// (antes enlace inline del LogoutModal) y "Cerrar sesión" (abre el LogoutModal).
function HeaderMenu({ vista, onDashboard, onToggleVista, onCambiarUnidad, onLogout }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const onClickOutside = (e) => {
      const btn = buttonRef.current;
      const menu = document.getElementById('header-nav-menu');
      if (btn?.contains(e.target)) return;
      if (menu?.contains(e.target)) return;
      setOpen(false);
    };
    const onScrollOrResize = () => setOpen(false);
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
  }, [open]);

  const run = (fn) => { setOpen(false); fn(); };
  const enHistoricos = vista === 'historicos';

  const items = [
    { icon: LayoutDashboard, label: 'Dashboard', onClick: () => run(onDashboard) },
    {
      icon: enHistoricos ? FileText : History,
      label: enHistoricos ? 'Ver bitácoras' : 'Ver históricos',
      onClick: () => run(onToggleVista),
    },
    { icon: ArrowLeftRight, label: 'Cambiar de unidad', onClick: () => run(onCambiarUnidad) },
    { divider: true },
    { icon: LogOut, label: 'Cerrar sesión', onClick: () => run(onLogout), danger: true },
  ];

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((o) => !o)}
        className="p-2 rounded-lg hover:bg-white/10 transition-colors"
        title="Menú"
        aria-label="Abrir menú de navegación"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {open ? <X size={18} /> : <Menu size={18} />}
      </button>
      {open && createPortal(
        <div
          id="header-nav-menu"
          role="menu"
          className="bg-white text-gray-800 rounded-xl shadow-xl border border-gray-200 py-1.5 overflow-hidden"
          style={{ position: 'fixed', top: pos.top, right: pos.right, width: '15rem', zIndex: 50 }}
        >
          {items.map((it, i) => {
            if (it.divider) return <div key={`div-${i}`} className="my-1 border-t border-gray-100" />;
            const Icon = it.icon;
            return (
              <button
                key={it.label}
                role="menuitem"
                onClick={it.onClick}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm font-medium transition-colors ${
                  it.danger ? 'text-red-600 hover:bg-red-50' : 'text-gray-700 hover:bg-gray-100'
                }`}
              >
                <Icon size={17} className={it.danger ? 'text-red-500' : 'text-gray-400'} />
                <span className="flex-1 text-left">{it.label}</span>
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}

function Header({ user, sesion, cargoNombre, plantaNombre, usuariosActivos, sesionActualId, onLogout, vista, onToggleVista, onDashboard, onCambiarUnidad, turnoEstado, turnoBloqueo, turnoExtendido }) {
  const tema = temaUnidad(sesion?.planta_id);
  const [reloj, setReloj] = useState(new Date());
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, right: 0 });
  const [filtroUsuarios, setFiltroUsuarios] = useState('');
  const buttonRef = useRef(null);

  useEffect(() => {
    const i = setInterval(() => setReloj(new Date()), 30000);
    return () => clearInterval(i);
  }, []);

  // Posicionar el popup respecto al botón cuando se abre.
  useEffect(() => {
    if (!menuOpen || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  }, [menuOpen]);

  // Limpiar filtro al cerrar para no mostrar búsqueda vieja al reabrir.
  useEffect(() => { if (!menuOpen) setFiltroUsuarios(''); }, [menuOpen]);

  // Cerrar con Esc, click afuera, scroll de la página o resize. El popup vive en
  // document.body via Portal (igual que CategoriaTab), por eso el contains() también
  // revisa el portal. IMPORTANTE: el listener de scroll usa captura para detectar scroll
  // de cualquier contenedor de la página; filtramos scroll que ocurre dentro del propio
  // popup (su `<ul>` con overflow-y-auto) para no cerrarlo al usar la rueda o arrastrar
  // la barra lateral del listado de usuarios.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    const onClickOutside = (e) => {
      const btn = buttonRef.current;
      const popup = document.getElementById('header-users-popup');
      if (btn?.contains(e.target)) return;
      if (popup?.contains(e.target)) return;
      setMenuOpen(false);
    };
    const onScroll = (e) => {
      const popup = document.getElementById('header-users-popup');
      if (popup && e.target && (popup === e.target || popup.contains(e.target))) return;
      setMenuOpen(false);
    };
    const onResize = () => setMenuOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClickOutside);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClickOutside);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [menuOpen]);

  const fechaStr = RELOJ_FECHA_FMT.format(reloj);
  const horaStr = RELOJ_HORA_FMT.format(reloj);
  const activos = usuariosActivos || [];
  const activosFiltrados = useMemo(() => {
    const q = filtroUsuarios.trim().toLowerCase();
    if (!q) return activos;
    return activos.filter((u) => (u.nombre_completo || '').toLowerCase().includes(q));
  }, [activos, filtroUsuarios]);

  return (
    <header className="text-white px-6 py-3 flex items-center justify-between shadow-lg relative z-10"
      style={{ background: tema.gradiente }}>
      <div className="flex items-center gap-4">
        <img src={asset("/G3 blanco.png")} alt="Gecelca3" className="h-10" onError={(e) => { e.target.style.display = "none"; }} />
        <div>
          <h1 className="text-lg font-bold tracking-tight">Bitácoras de Planta</h1>
          <p className={`text-xs ${tema.textoSuave} opacity-80`}>Sistema de Registro Operativo</p>
        </div>
      </div>

      <div className="hidden md:flex items-center gap-6 text-sm">
        <div className={`flex items-center gap-2 ${tema.textoReloj}`}>
          <Clock size={16} />
          <span className="capitalize">{fechaStr}</span>
          <span className="font-mono font-bold text-white">{horaStr}</span>
        </div>
        <span className="px-3 py-1 rounded-lg text-xs font-bold" style={{ backgroundColor: tema.badgeBg }}>
          {getTurnoLabel(sesion?.turno)}
        </span>
        {/* D-045: estado del turno de la unidad. ABIERTO → abierto / extendido / en transición;
            cualquier otro (sin turno abierto: cerrado anticipado o auto-cerrado) → "Turno cerrado". */}
        {turnoEstado === 'ABIERTO' ? (
          <span className="px-3 py-1 rounded-lg text-xs font-bold text-white"
            style={{ backgroundColor: turnoBloqueo ? '#D97706' : turnoExtendido ? '#1D4ED8' : '#059669' }}>
            {turnoBloqueo ? 'En transición' : turnoExtendido ? 'Turno extendido' : 'Turno abierto'}
          </span>
        ) : (
          <span className="px-3 py-1 rounded-lg text-xs font-bold text-white flex items-center gap-1.5"
            style={{ backgroundColor: '#DC2626' }}>
            <Lock size={12} /> Turno cerrado
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <div className="relative">
          <button
            ref={buttonRef}
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-white/10 transition-colors"
            title="Usuarios conectados"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <Users size={18} />
            <span className="text-sm font-semibold">{activos.length}</span>
          </button>
          {menuOpen && createPortal(
            // Layout: header + search FIJOS arriba (no scrollean), `<ul>` scrolleable abajo
            // acotado a ~6 filas (≈ 22rem). El scroll vive en el `<ul>` para que el
            // listener captura del Header (`onScroll`) lo filtre y no cierre el popup.
            <div
              id="header-users-popup"
              role="menu"
              className="bg-white text-gray-800 rounded-xl shadow-xl border border-gray-200 flex flex-col overflow-hidden"
              style={{
                position: 'fixed',
                top: menuPos.top,
                right: menuPos.right,
                width: '20rem',
                zIndex: 50,
              }}
            >
              <div className="px-4 py-2 border-b border-gray-100 text-xs uppercase tracking-wide text-gray-500 flex items-center justify-between">
                <span>Conectados ({activos.length})</span>
                {filtroUsuarios && (
                  <span className="text-[10px] normal-case tracking-normal text-gray-400">
                    {activosFiltrados.length} coincidencia{activosFiltrados.length === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              <div className="px-3 py-2 border-b border-gray-100">
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                  <input
                    type="text"
                    autoFocus
                    placeholder="Buscar por nombre…"
                    value={filtroUsuarios}
                    onChange={(e) => setFiltroUsuarios(e.target.value)}
                    className="w-full pl-8 pr-2 py-1.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent"
                  />
                </div>
              </div>
              {activos.length === 0 ? (
                <div className="px-4 py-6 text-sm text-gray-400 text-center">Nadie más conectado</div>
              ) : activosFiltrados.length === 0 ? (
                <div className="px-4 py-6 text-sm text-gray-400 text-center">Sin coincidencias para "{filtroUsuarios}"</div>
              ) : (
                <ul className="overflow-y-auto divide-y divide-gray-100" style={{ maxHeight: '22rem' }}>
                  {activosFiltrados.map((u) => (
                    <li key={u.sesion_id} className="px-4 py-2.5 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate">
                          {u.nombre_completo}
                          {u.sesion_id === sesionActualId && (
                            <span className="ml-2 text-xs font-medium text-emerald-600">(tú)</span>
                          )}
                        </div>
                        {/* Cargo y planta en líneas separadas: un cargo largo (ej. "Coordinador de
                            carbón y maquinaria") ya no trunca ni oculta la planta. */}
                        <div className="text-xs text-gray-500">
                          <div className="truncate">{u.cargo_nombre}</div>
                          <div className="truncate">{u.planta_nombre}</div>
                        </div>
                      </div>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 whitespace-nowrap">
                        T{u.turno}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>,
            document.body
          )}
        </div>

        <div className="text-right hidden sm:block">
          <div className="text-sm font-semibold">{user.nombre_completo}</div>
          <div className={`text-xs ${tema.textoSuave}`}>{cargoNombre} — {plantaNombre}</div>
        </div>
        <div className="w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold"
          style={{ backgroundColor: tema.avatarBg }}>
          {iniciales(user.nombre_completo)}
        </div>
        <HeaderMenu
          vista={vista}
          onDashboard={onDashboard}
          onToggleVista={onToggleVista}
          onCambiarUnidad={onCambiarUnidad}
          onLogout={onLogout}
        />
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
// El `nombre` es el del menú desplegable (categoría que agrupa Disponibilidad + Operación 24h).
// NO confundir con `b.nombre` de la bitácora MAND, que sigue siendo "Operación 24h" (el nombre
// de la grilla individual).
const CATEGORIAS = [
  {
    codigo: 'SALA_DE_MANDOS',
    nombre: 'Despachos',
    nombreCorto: 'Despachos',
    icono: 'MonitorCog',
    bitacora_codigos: ['DISP', 'MAND'],
  },
  // D-027: Combustibles → Consumos. Categoría propia con UI especial (grilla 24×N + total
  // calculado). Hoy solo agrupa COMB; el slot está listo para sumar futuras bitácoras
  // de combustibles (ej. medidores de gas, calibración tanques) sin tocar el routing.
  {
    codigo: 'COMBUSTIBLES',
    nombre: 'Combustibles',
    nombreCorto: 'Comb',
    icono: 'Flame',
    bitacora_codigos: ['COMB'],
  },
];

// Bitácoras que NO muestran badge numérico. DISP por su naturaleza (siempre 1 estado activo,
// el count no aporta señal de "sin cerrar"). D-027: COMB es un report numérico (no eventos
// que se "cierran"), no hay "pendientes" que contar.
const SIN_BADGE_CODIGOS = new Set(['DISP', 'COMB']);

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
  onCerrarTurno, onReabrirTurno, onFinalizarTurno, finalizandoTurno, turnoFinalizado, turnoUnidadCerrado,
  onRevertirTurno, revirtiendoTurno,
  filtroTexto, setFiltroTexto, filtroTipo, setFiltroTipo,
  filtroFecha, setFiltroFecha, onCommitFecha, filtroTurno, setFiltroTurno,
  tiposEvento, onAddRegistro,
  mandDirty, mandGuardando, onGuardarMand,
}) {
  const isMand = bitacora?.codigo === 'MAND';
  // R1/R3: el selector de día usa un valor "pendiente" que solo se aplica al pulsar "Guardar"
  // (o Enter, o las flechas/"Hoy" que son clics explícitos). `onCommitFecha` centraliza el commit
  // (puede abrir el popup de borrador). El futuro queda bloqueado con max=hoy Bogotá.
  const hoyBogota = getTodayBogota();
  // `pendingFecha` = valor tecleado en el input, aún sin commitear (solo aplica al pulsar
  // Guardar/Enter). Se resincroniza con `filtroFecha` DURANTE el render (patrón oficial de
  // React "adjusting state when a prop changes"), NO en un useEffect post-paint: al navegar con
  // las flechas/"Hoy" `onCommitFecha` cambia `filtroFecha` de inmediato, y un efecto tardío dejaba
  // un frame con `pendingFecha` viejo ≠ `filtroFecha` nuevo → el botón "Guardar" parpadeaba. Ajustar
  // en render corta ese frame antes de pintar.
  const [pendingFecha, setPendingFecha] = useState(filtroFecha);
  const [prevFiltroFecha, setPrevFiltroFecha] = useState(filtroFecha);
  if (filtroFecha !== prevFiltroFecha) {
    setPrevFiltroFecha(filtroFecha);
    setPendingFecha(filtroFecha);
  }
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
          (F10) y muestra los 24 periodos, así que el turno es derivable visualmente.
          D-027: COMB ya no llega acá — la BarraEstado entera se omite en el routing. */}
      {!isMand && (
        <div className="flex items-center gap-2 flex-wrap">
          <Calendar size={16} className="text-gray-400" />
          <button
            onClick={() => onCommitFecha(shiftDate(filtroFecha || hoyBogota, -1))}
            title="Día anterior"
            className="p-1.5 rounded border border-gray-200 hover:bg-gray-50"
          >
            <ChevronLeft size={16} />
          </button>
          <input
            type="date"
            value={pendingFecha}
            max={hoyBogota}
            onChange={(e) => setPendingFecha(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && pendingFecha && pendingFecha <= hoyBogota && pendingFecha !== filtroFecha) {
                onCommitFecha(pendingFecha);
              }
            }}
            title={filtroFecha ? `Día de trabajo: ${filtroFecha}` : "Sin filtro de día: se muestran todos los registros"}
            className={`px-3 py-2 rounded-xl border text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 ${
              filtroFecha ? "border-emerald-400 bg-emerald-50 font-medium" : "border-gray-300"
            }`}
          />
          {pendingFecha && pendingFecha !== filtroFecha && (
            <button
              onClick={() => onCommitFecha(pendingFecha)}
              disabled={pendingFecha > hoyBogota}
              title="Aplicar el día seleccionado"
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-white shadow-sm hover:shadow-md transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ backgroundColor: COLORS.greenPrimary }}
            >
              <Save size={14} />
              Guardar
            </button>
          )}
          <button
            onClick={() => onCommitFecha(shiftDate(filtroFecha || hoyBogota, 1))}
            disabled={(filtroFecha || hoyBogota) >= hoyBogota}
            title="Día siguiente"
            className="p-1.5 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronRight size={16} />
          </button>
          <button
            onClick={() => onCommitFecha(hoyBogota)}
            title="Saltar a hoy"
            className="px-3 py-2 rounded-xl border border-gray-300 text-sm font-medium hover:bg-gray-50"
          >
            Hoy
          </button>
          <select
            value={filtroTurno}
            onChange={(e) => setFiltroTurno(e.target.value)}
            className={`px-3 py-2 rounded-xl border text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 ${
              filtroTurno ? "border-emerald-400 bg-emerald-50 font-medium" : "border-gray-300 bg-white"
            }`}
          >
            <option value="">Todos los turnos</option>
            <option value="1">Turno 1 (Diurno)</option>
            <option value="2">Turno 2 (Nocturno)</option>
          </select>
          {(filtroFecha || filtroTurno || filtroTexto || filtroTipo) && (
            <button
              onClick={() => { setFiltroFecha(''); setFiltroTurno(''); setFiltroTexto(''); setFiltroTipo(''); }}
              title="Quitar todos los filtros y mostrar todos los registros"
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-amber-300 bg-amber-50 text-amber-700 text-sm font-medium hover:bg-amber-100"
            >
              <X size={14} />
              Borrar filtros
            </button>
          )}
        </div>
      )}

      {/* F17: filtros de búsqueda no aplican a MAND — la grilla muestra solo HOY.
          D-027: COMB ya no llega acá — la BarraEstado entera se omite en el routing. */}
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
        // D-040/D-045: gate de UI acotado a genéricas. Este botón vive en la rama !isMand de una
        // BarraEstado que solo se monta para no-DISP/COMB → es exclusivo de bitácoras genéricas.
        // Restamos turnoFinalizado (individual) y turnoUnidadCerrado (unidad sin turno abierto) SOLO acá.
        puedeCrear && !turnoFinalizado && !turnoUnidadCerrado && (
          <button onClick={onAddRegistro}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white shadow-sm hover:shadow-md transition-all"
            style={{ backgroundColor: COLORS.greenPrimary }}>
            <Plus size={18} />
            Nuevo Registro
          </button>
        )
      )}

      {/* F4/D-040 · acción INDIVIDUAL (afecta solo a quien la pulsa) → estilo OUTLINE para distinguirla
          del cierre de unidad (solid). Es REVERTIBLE y self-service. F17: oculta en MAND. D-045: oculta
          si la unidad ya está cerrada (no hay turno abierto que finalizar/revertir). */}
      {!isMand && !turnoUnidadCerrado && onFinalizarTurno && (
        turnoFinalizado ? (
          <button onClick={onRevertirTurno} disabled={revirtiendoTurno}
            title="Vuelve a habilitar TU registro en las bitácoras. Solo te afecta a ti."
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-white border-2 hover:bg-blue-50 transition-all disabled:opacity-60"
            style={{ borderColor: COLORS.blueDark, color: COLORS.blueDark }}>
            <RotateCcw size={16} />
            {revirtiendoTurno ? 'Revirtiendo…' : 'Revertir mi finalización'}
          </button>
        ) : (
          <button onClick={onFinalizarTurno} disabled={finalizandoTurno}
            title="Registra que TÚ terminaste tu turno. Es individual y reversible; NO cierra la unidad."
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-white border-2 hover:bg-emerald-50 transition-all disabled:opacity-60"
            style={{ borderColor: COLORS.greenDark, color: COLORS.greenDark }}>
            <CheckCircle2 size={16} />
            {finalizandoTurno ? 'Finalizando…' : 'Finalizar mi turno'}
          </button>
        )
      )}

      {/* D-045 · acción de UNIDAD (afecta a TODOS) → estilo SOLID. Cierre de turno por cabecera
          (POST /api/turno/cerrar). Solo cargos puede_cerrar_turno. Oculto en MAND (cierre del día
          automático vía sweeper). Oculto si la unidad ya está cerrada (ahí aparece "Reabrir Turno"). */}
      {!isMand && esJefeTurno && !turnoUnidadCerrado && (
        <button onClick={onCerrarTurno}
          title="Cierra el turno de TODA la unidad: archiva los registros y congela la conformación. Afecta a todos."
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-colors shadow-sm hover:shadow-md"
          style={{ backgroundColor: COLORS.blueDeep }}>
          <Lock size={16} />
          Cerrar Turno
        </button>
      )}

      {/* D-045 (reabrir) · acción de UNIDAD → SOLID. Cuando la unidad quedó sin turno abierto (cierre
          anticipado), el JdT/IngOp puede reabrirlo. Reemplaza a "Cerrar Turno" mientras está cerrada. */}
      {!isMand && esJefeTurno && turnoUnidadCerrado && onReabrirTurno && (
        <button onClick={onReabrirTurno}
          title="Reabre el turno de la unidad: devuelve los registros a borrador y habilita el registro para todos."
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-colors shadow-sm hover:shadow-md"
          style={{ backgroundColor: COLORS.greenDark }}>
          <Unlock size={16} />
          Reabrir Turno
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
  puedeCrear, bloqueado = false, onUpdateLocal, onSaveRegistro, onDeleteRegistro,
  filtroTexto, filtroTipo, filtroFecha, filtroTurno, onLimpiarFiltros,
}) {
  const [editingId, setEditingId] = useState(null);

  // D-040: al finalizar el turno la grilla pasa a solo-lectura. Cerramos cualquier edición en curso
  // para que ninguna fila quede con inputs/Guardar tras el bloqueo (y no se reabra sola al revertir).
  useEffect(() => {
    if (bloqueado) setEditingId(null);
  }, [bloqueado]);

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

  const ocultos = registros.length - regs.length;

  // UX: al crear un registro nuevo ("+ Nuevo Registro") el borrador se agrega al final de la lista
  // (ordenada por fecha asc, y el borrador nace a la hora actual → último). Si el scroll estaba
  // arriba, el nuevo registro quedaba fuera de vista. Bajamos al fondo SOLO cuando aparece un
  // borrador nuevo (por su `_localId`), no en cada edición/guardado.
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

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div ref={scrollRef} className="flex-1 overflow-auto px-6 py-4">
        {hayFiltrosActivos && ocultos > 0 && regs.length > 0 && (
          <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-700">
            <AlertTriangle size={14} className="shrink-0" />
            <span>{ocultos} registro{ocultos === 1 ? "" : "s"} oculto{ocultos === 1 ? "" : "s"} por los filtros aplicados.</span>
            <button onClick={onLimpiarFiltros} className="font-semibold underline hover:text-amber-900">
              Mostrar todos
            </button>
          </div>
        )}
        {regs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-gray-400">
            <FileText size={48} className="mb-4 opacity-50" />
            {hayFiltrosActivos ? (
              <>
                <p className="text-lg font-medium">No hay registros para los filtros aplicados</p>
                <p className="text-sm mt-1">
                  {registros.length > 0
                    ? `Hay ${registros.length} registro${registros.length === 1 ? "" : "s"} en otras fechas o turnos.`
                    : "Esta bitácora no tiene registros activos."}
                </p>
                <button
                  onClick={onLimpiarFiltros}
                  className="mt-3 px-4 py-2 rounded-xl border border-amber-300 bg-amber-50 text-amber-700 text-sm font-medium hover:bg-amber-100"
                >
                  Borrar filtros y mostrar todos
                </button>
              </>
            ) : (
              <>
                <p className="text-lg font-medium">No hay registros aún</p>
                <p className="text-sm mt-1">
                  {puedeCrear ? "Haz clic en \"Nuevo Registro\" para comenzar" : "Esta bitácora no tiene registros activos"}
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
                isEditing={!bloqueado && (editingId === (reg.registro_id || reg._localId) || (reg._dirty && !reg.registro_id))}
                onStartEdit={() => { if (!bloqueado) setEditingId(reg.registro_id || reg._localId); }}
                onCancelEdit={() => setEditingId(null)}
                onUpdate={(campo, valor) => onUpdateLocal(reg.registro_id || reg._localId, campo, valor)}
                onSave={async () => {
                  const ok = await onSaveRegistro(reg);
                  if (ok) setEditingId(null);
                }}
                onDelete={() => onDeleteRegistro(reg)}
                puedeEditar={!bloqueado && (reg.estado === "borrador" || !reg.registro_id)}
                bloqueado={bloqueado}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Textarea que crece con su contenido (sin scroll interno ni alto fijo).
function AutoGrowTextarea({ value, className, ...props }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      rows={1}
      className={className}
      style={{ overflow: "hidden" }}
      {...props}
    />
  );
}

function RegistroRow({ numero, registro: reg, tiposEvento, jefeNombre, jdtNombre, camposExtraDef = [], isEditing, onStartEdit, onCancelEdit, onUpdate, onSave, onDelete, puedeEditar, bloqueado = false }) {
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
  // Aviso suave contra typos de digitación en el datetime-local (ej. escribir 01/07 en un
  // navegador con locale MM/DD produce enero 7): fecha a más de 7 días de hoy se resalta
  // en ámbar con un hint, sin bloquear el guardado.
  const fechaEventoDia = toBogotaDate(reg.fecha_evento);
  const fechaSospechosa = !!fechaEventoDia
    && Math.abs(new Date(fechaEventoDia) - new Date(getTodayBogota())) > 7 * 86_400_000;
  // El turno se auto-sincroniza con la hora al editar el datetime, pero el select permite
  // sobrescribirlo. Si quedó incoherente con la hora, lo marcamos (y el guardado lo bloquea).
  const turnoNoCoincide = reg.turno != null
    && Number(reg.turno) !== turnoFromFechaLocal(toBogotaLocal(reg.fecha_evento));
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
                max={nowBogotaLocal()}
                onChange={(e) => {
                  const v = e.target.value;
                  onUpdate("fecha_evento", v);
                  onUpdate("turno", turnoFromFechaLocal(v));
                }}
                className={`w-full px-3 py-1.5 rounded-lg border text-sm focus:outline-none focus:ring-2 ${
                  fechaSospechosa
                    ? "border-amber-400 bg-amber-50 focus:ring-amber-400"
                    : "border-gray-300 focus:ring-emerald-400"
                }`}
              />
              {fechaSospechosa && (
                <p className="text-[11px] text-amber-600 leading-tight">
                  Fecha a más de 7 días de hoy — verifica día y mes.
                </p>
              )}
              <select
                value={reg.turno || 1}
                onChange={(e) => onUpdate("turno", parseInt(e.target.value, 10))}
                className={`w-full px-3 py-1.5 rounded-lg border text-sm focus:outline-none focus:ring-2 bg-white ${
                  turnoNoCoincide
                    ? "border-red-400 bg-red-50 focus:ring-red-400"
                    : "border-gray-300 focus:ring-emerald-400"
                }`}
              >
                <option value={1}>Turno 1</option>
                <option value={2}>Turno 2</option>
              </select>
              {turnoNoCoincide && (
                <p className="text-[11px] text-red-600 leading-tight">
                  La hora no coincide con el turno.
                </p>
              )}
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
            <AutoGrowTextarea
              value={reg.detalle || ""}
              onChange={(e) => onUpdate("detalle", e.target.value)}
              placeholder="Describe el evento operativo..."
              className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 resize-none min-h-[4.5rem]"
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
          {/* D-040: turno finalizado → solo lectura. Ninguna acción (editar/borrar/entrar en edición);
              la fila muestra un indicador de bloqueo y todos los datos quedan visibles en modo lectura. */}
          {bloqueado ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-400 bg-gray-50"
              title="Turno finalizado: registro bloqueado. Revierte la finalización para editar.">
              <Lock size={14} />
              <span className="hidden sm:inline">Bloqueado</span>
            </span>
          ) : isEditing ? (
            <>
              <button onClick={onSave} className="p-2 rounded-lg text-white transition-colors" style={{ backgroundColor: COLORS.greenPrimary }} title="Guardar">
                <Save size={16} />
              </button>
              <button onClick={reg.registro_id ? onCancelEdit : onDelete} className="p-2 rounded-lg text-gray-600 bg-gray-100 hover:bg-gray-200 transition-colors" title={reg.registro_id ? "Cancelar" : "Eliminar"}>
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
  // D-045 E8: estado del turno + acciones cerrar/extender (reemplaza useCierre/cierre masivo).
  const turnoHook = useTurno(auth.ready, auth.sesion?.sesion_id, auth.sesion?.planta_id, auth.turno);
  const cierre = useCierre(); // D-045: preview de pendientes + finalización forzada del popup de cierre
  const [cierreModalOpen, setCierreModalOpen] = useState(false);
  const [cerrandoTurno, setCerrandoTurno] = useState(false);
  const bitacorasMap = useMemo(
    () => new Map((catalogos.bitacoras || []).map((b) => [b.bitacora_id, b.nombre])),
    [catalogos.bitacoras],
  );
  const usuariosActivos = useUsuariosActivos(auth.ready, auth.sesion?.sesion_id);
  const { counts: registrosPorBitacora } = useBitacoraCounts(
    auth.ready,
    auth.sesion?.sesion_id,
    auth.sesion?.planta_id,
  );

  const [activeBitacora, setActiveBitacora] = useState(null);
  const [tiposEvento, setTiposEvento] = useState([]);
  // F11/R2/R3: filtros de la BarraEstado (bitácoras no-MAND). Default = TODOS vacíos (FILTROS_VACIOS,
  // fuente única): la lista arranca mostrando TODOS los registros, sin pre-filtro por día. Antes el
  // día sembraba HOY y ocultaba registros de otros días (incongruente con el badge del tab, que cuenta
  // todos los borradores). La `fecha` sigue teniendo doble función — filtra la lista Y fija el día en
  // que "Nuevo Registro" crea el borrador; con fecha vacía el borrador cae en HOY (ver handleAddRegistro).
  // Sin persistencia. Nunca acepta días futuros. "Borrar filtros" vuelve a este mismo estado vacío.
  const [filtroTexto, setFiltroTexto] = useState(FILTROS_VACIOS.texto);
  const [filtroTipo, setFiltroTipo] = useState(FILTROS_VACIOS.tipo);
  const [filtroFecha, setFiltroFecha] = useState(FILTROS_VACIOS.fecha);
  const [filtroTurno, setFiltroTurno] = useState(FILTROS_VACIOS.turno);
  const limpiarFiltros = useCallback(() => {
    setFiltroTexto(FILTROS_VACIOS.texto); setFiltroTipo(FILTROS_VACIOS.tipo);
    setFiltroFecha(FILTROS_VACIOS.fecha); setFiltroTurno(FILTROS_VACIOS.turno);
  }, []);
  const [toast, setToast] = useState(null);
  const [modal, setModal] = useState(null);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [draftLocal, setDraftLocal] = useState(null);
  const [vista, setVista] = useState('bitacoras');

  // D-035: subestado de las secciones con UI propia, lifted al dashboard para que la URL pueda
  // deep-linkearlo (DISP=planta, COMB=fecha). La URL es la fuente única de verdad; estos states
  // son su espejo en React. COMB arranca en hoy (Bogotá); DISP se siembra al entrar (ver derive).
  const [dispPlanta, setDispPlanta] = useState(null);
  const [combFecha, setCombFecha] = useState(() => getTodayBogota());

  // D-035: routing por hash. `route` (parseado) es la lectura; `navigate` empuja estado→URL.
  const { route, navigate } = useAppRoute();

  // F2: marca participación cuando el usuario abre una bitácora. Idempotente — reabrir tras
  // finalizar el turno crea una nueva ventana de participación sin requerir re-login.
  useBitacoraSesion(auth.sesion?.sesion_id ? activeBitacora : null);

  // F4/D-040: hooks para "Finalizar Turno" / "Revertir finalización" del header.
  const { finalizar: finalizarTurno, loading: finalizandoTurno } = useFinalizarTurno();
  const { revertir: revertirTurno, loading: revirtiendoTurno } = useRevertirTurno();
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

  // D-040: la finalización de turno es estado del BACKEND (sesion_activa.turno_finalizado_en),
  // fuente única y revertible. Se deriva de la sesión de app (sobrevive F5 vía /api/me) — ya no
  // vive en localStorage (divergía del backend y el reset de /abrir lo dejaba inconsistente). El
  // turno-sweeper la muere sola a fin de turno; select-context la limpia al reactivar (turno nuevo).
  const turnoFinalizado = sesion?.turno_finalizado_en != null;

  // D-045 (write-gate por unidad): cuando la unidad NO tiene turno ABIERTO (cierre manual anticipado
  // o auto-cierre sin sucesor) las bitácoras genéricas quedan en solo-lectura para TODOS —no solo para
  // quien finalizó— hasta que se abra el siguiente turno (por ventana o reapertura manual). estadoTurno
  // Actual devuelve 'ABIERTO' o null (nunca 'CERRADO'), así que null ≡ unidad sin turno abierto. Durante
  // la transición (bloqueo) el estado sigue 'ABIERTO' y lo cubre el modal, no este gate.
  const turnoUnidadCerrado = turnoHook.estado !== 'ABIERTO';

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

  // D-035: sincronización ruta ↔ estado. El dashboard es dueño del estado; los dos efectos de
  // abajo lo mantienen en espejo con la URL (fuente única de verdad, permission-gated). Refs para
  // leer el estado actual dentro del "derive" SIN meterlo en deps: así un cambio de estado (ej.
  // clic en un tab) no dispara una re-derivación desde la ruta vieja que lo revierta.
  const activeBitacoraRef = useRef(activeBitacora);
  const dispPlantaRef = useRef(dispPlanta);
  const combFechaRef = useRef(combFecha);
  activeBitacoraRef.current = activeBitacora;
  dispPlantaRef.current = dispPlanta;
  combFechaRef.current = combFecha;

  const codigoActivo = useMemo(
    () => bitacorasPermitidas.find((b) => b.bitacora_id === activeBitacora)?.codigo || null,
    [bitacorasPermitidas, activeBitacora]
  );

  // (a) Derivar estado DESDE la ruta: corre en el primer load (deep-link), al volver de "Cambiar
  // unidad" (cambia `sesion`) y ante navegación externa (back/forward, edición manual del hash).
  // Reemplaza el viejo init "primera permitida": el fallback de ruta vacía/desconocida/no-permitida
  // hace exactamente eso. Cuando la ruta cambió porque la escribimos nosotros (efecto b), aplicar
  // es no-op por los guards de igualdad → sin loop.
  useEffect(() => {
    if (!sesion || bitacorasPermitidas.length === 0) return;
    if (route.vista === 'historicos') {
      setVista('historicos');
      if (activeBitacoraRef.current == null) setActiveBitacora(bitacorasPermitidas[0].bitacora_id);
      return;
    }
    setVista('bitacoras');
    let target = route.codigo
      ? bitacorasPermitidas.find((b) => b.codigo === route.codigo)
      : null;
    if (!target) target = bitacorasPermitidas[0]; // fallback: codigo nulo o no permitido
    if (target.bitacora_id !== activeBitacoraRef.current) {
      setActiveBitacora(target.bitacora_id);
      // Al cambiar de bitácora los filtros vuelven al estado vacío (mostrar todo), no a "hoy".
      setFiltroTexto(FILTROS_VACIOS.texto); setFiltroTipo(FILTROS_VACIOS.tipo);
      setFiltroFecha(FILTROS_VACIOS.fecha); setFiltroTurno(FILTROS_VACIOS.turno); setDraftLocal(null);
    }
    if (target.codigo === 'DISP') {
      // Sembrar planta: param de la ruta → planta ya elegida → unidad del login (default).
      const next = route.params.planta || dispPlantaRef.current || sesion.planta_id;
      if (next && next !== dispPlantaRef.current) setDispPlanta(next);
    }
    if (target.codigo === 'COMB' && route.params.fecha && route.params.fecha !== combFechaRef.current) {
      setCombFecha(route.params.fecha);
    }
  }, [route, sesion, bitacorasPermitidas]);

  // (b) Escribir estado HACIA la ruta. Subestado (planta/fecha) y el primer write canónico usan
  // replaceState (no inundan el historial); el cambio de sección/vista usa pushState (back/forward
  // navega). Sin sesión (LoginScreen) NO escribe: el routing solo vive en el dashboard.
  const prevSectionKey = useRef(null);
  useEffect(() => {
    if (!sesion || bitacorasPermitidas.length === 0) return;
    let desired = null;
    if (vista === 'historicos') desired = { vista: 'historicos', codigo: null, params: {} };
    else if (codigoActivo === 'DISP') desired = { vista: 'bitacoras', codigo: 'DISP', params: { planta: dispPlanta } };
    else if (codigoActivo === 'COMB') desired = { vista: 'bitacoras', codigo: 'COMB', params: { fecha: combFecha } };
    else if (codigoActivo) desired = { vista: 'bitacoras', codigo: codigoActivo, params: {} };
    if (!desired) return;
    const sectionKey = `${desired.vista}:${desired.codigo}`;
    const replace = prevSectionKey.current === null || prevSectionKey.current === sectionKey;
    prevSectionKey.current = sectionKey;
    if (buildHash(desired) === window.location.hash) return;
    navigate(desired, { replace });
  }, [sesion, bitacorasPermitidas, vista, codigoActivo, dispPlanta, combFecha, navigate]);

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

  // El batch save MAND (useSalaDeMando) emite `bitacora:counts-refresh` para que el badge del
  // tab refresque. Reusamos el mismo evento para refetchear `registrosDeBitacora` y así
  // mantener sincronizados el badge superior y el "X registros" de BarraEstado en la pestaña
  // Operación 24h cuando se crean filas nuevas en la grilla AUTH/PRUEBA/REDESP.
  useEffect(() => {
    if (!activeBitacora || !sesion?.planta_id) return;
    const handler = () => {
      registrosHook.getActivos({ planta_id: sesion.planta_id, bitacora_id: activeBitacora }).catch(() => {});
    };
    window.addEventListener('bitacora:counts-refresh', handler);
    return () => window.removeEventListener('bitacora:counts-refresh', handler);
  }, [activeBitacora, sesion?.planta_id, registrosHook.getActivos]);

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
    // R2: el borrador nace en el día de trabajo seleccionado (hora actual Bogotá); si no hay día
    // seleccionado ("todos los días"), cae en hoy. El futuro ya está bloqueado en el selector.
    const fechaEventoNuevo = filtroFecha ? `${filtroFecha}T${nowBogotaLocal().slice(11)}` : nowBogotaLocal();
    setDraftLocal({
      _localId: `draft_${Date.now()}`,
      _dirty: true,
      bitacora_id: activeBitacora,
      planta_id: sesion.planta_id,
      fecha_evento: fechaEventoNuevo,
      turno: turnoFromFechaLocal(fechaEventoNuevo),
      detalle: "",
      tipo_evento_id: defTipo?.tipo_evento_id || null,
      tipo_evento_nombre: defTipo?.nombre,
      estado: "borrador",
      creado_por_id: user.usuario_id,
      creado_por_nombre: user.nombre_completo,
      bitacora_nombre: bitacorasPermitidas.find((b) => b.bitacora_id === activeBitacora)?.nombre,
    });
  }, [draftLocal, tiposEvento, activeBitacora, sesion, user, bitacorasPermitidas, showToast, filtroFecha]);

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
    // El turno debe corresponder a la hora del evento (T1 [06,17], T2 [18,05]). El select permite
    // sobrescribir el turno manualmente; acá bloqueamos guardar si quedó incoherente con la hora.
    if (Number(reg.turno) !== turnoFromFechaLocal(toBogotaLocal(reg.fecha_evento))) {
      showToast("La hora no coincide con el turno", "error");
      return false;
    }

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

  // R4: cambiar el día de trabajo con un borrador sin guardar abre un popup (Guardar borrador /
  // Descartar / Cancelar) para que el borrador no bloquee navegar a otro día y crear registros allí.
  // Sin borrador dirty, aplica el nuevo día directo.
  const intentarCambiarDia = useCallback((nuevoDia) => {
    if (draftLocal?._dirty && nuevoDia !== filtroFecha) {
      setModal({
        title: "Registro borrador sin guardar",
        message: `Tienes un registro en borrador sin guardar${filtroFecha ? ` en el día ${filtroFecha}` : ""}. ¿Qué deseas hacer antes de cambiar de día?`,
        confirmLabel: "Guardar borrador", confirmColor: "green", icon: Save,
        onConfirm: async () => {
          const ok = await handleSaveRegistro(draftLocal);
          if (ok) { setModal(null); setFiltroFecha(nuevoDia); }
        },
        secondaryLabel: "Descartar",
        onSecondary: () => { setDraftLocal(null); setModal(null); setFiltroFecha(nuevoDia); },
      });
      return;
    }
    setFiltroFecha(nuevoDia);
  }, [draftLocal, filtroFecha, handleSaveRegistro]);

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

  // D-045 E8: cierre de turno por cabecera (reemplaza el cierre masivo D-042). Sella la cabecera del
  // turno de la unidad, congela la conformación desde turno_participante y archiva los registros del
  // turno — atómico en el backend (POST /api/turno/cerrar). Confirmación con el ConfirmModal existente.
  const refrescarRegistrosActivos = useCallback(async () => {
    if (activeBitacora && sesion?.planta_id) {
      try { await registrosHook.getActivos({ planta_id: sesion.planta_id, bitacora_id: activeBitacora }); } catch { /* noop */ }
    }
  }, [activeBitacora, sesion, registrosHook]);

  const cerrarTurnoUnidad = useCallback(async () => {
    const r = await turnoHook.cerrar();
    await refrescarRegistrosActivos();
    const archivados = (r?.archivados || []).reduce((acc, x) => acc + (x.registros_cerrados || 0), 0);
    showToast(`Turno cerrado: ${archivados} registro(s) archivado(s), ${r?.conformados ?? 0} en conformación.`);
    return r;
  }, [turnoHook, refrescarRegistrosActivos, showToast]);

  // Botón manual "Cerrar Turno" del header (JdT/IngOp) — abre el popup de pendientes (bitácoras con
  // borradores + ingenieros sin finalizar) y carga el preview. El cierre real lo dispara el confirm.
  const handleCerrarTurno = useCallback(() => {
    const planta = auth.sesion?.planta_id;
    if (!planta) return;
    setCierreModalOpen(true);
    cierre.cargarPreview(planta);
  }, [auth, cierre]);

  // Confirmación del popup: finaliza forzado a los ingenieros pendientes y luego cierra el turno.
  const handleConfirmCierre = useCallback(async () => {
    const p = cierre.preview;
    const pendientes = (p && p !== 'loading' ? p.ingenieros_no_finalizados : []) || [];
    setCerrandoTurno(true);
    try {
      if (pendientes.length > 0) {
        await cierre.finalizarForzado(pendientes.map((u) => u.usuario_id));
      }
      await cerrarTurnoUnidad();
      setCierreModalOpen(false);
      cierre.limpiar();
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setCerrandoTurno(false);
    }
  }, [cierre, cerrarTurnoUnidad, showToast]);

  const handleCancelCierre = useCallback(() => {
    setCierreModalOpen(false);
    cierre.limpiar();
  }, [cierre]);

  // D-045 (reabrir): des-cierra el turno de la ventana vigente cuando la unidad quedó sin turno abierto
  // (cierre anticipado). Solo JdT/IngOp. Des-archiva los registros y devuelve la unidad a operación.
  const handleReabrirTurno = useCallback(() => {
    setModal({
      title: 'Reabrir turno',
      message: 'Vas a reabrir el turno de esta unidad: los registros archivados vuelven a borrador y la unidad queda operativa de nuevo. ¿Continuar?',
      confirmLabel: 'Reabrir turno', confirmColor: 'green', icon: Unlock,
      onConfirm: async () => {
        try {
          const r = await turnoHook.reabrir();
          await refrescarRegistrosActivos();
          setModal(null);
          showToast(`Turno reabierto: ${r?.desarchivados ?? 0} registro(s) devuelto(s) a borrador.`);
        } catch (e) { showToast(e.message, 'error'); }
      },
    });
  }, [turnoHook, refrescarRegistrosActivos, showToast]);

  // Acciones del modal bloqueante de transición (el modal maneja su propia confirmación en 2 pasos).
  const handleTurnoExtender = useCallback(async () => {
    try { await turnoHook.extender(); showToast('Turno extendido hasta el próximo cambio de turno.'); }
    catch (e) { showToast(e.message, 'error'); }
  }, [turnoHook, showToast]);

  const handleTurnoCerrarModal = useCallback(async () => {
    try { await cerrarTurnoUnidad(); }
    catch (e) { showToast(e.message, 'error'); }
  }, [cerrarTurnoUnidad, showToast]);

  // F4/D-040: "Finalizar Turno" — marca sesion_activa.turno_finalizado_en (fuente única) y emite
  // un CIET. No cierra registros (eso es del JdT/IngOp). El estado se refleja en cliente con
  // patchSesion (sin refetch); F5 rehidrata vía /api/me. Revertible con handleRevertirTurno.
  const handleFinalizarTurno = useCallback(async () => {
    // D-040/blindaje: la finalización deja las bitácoras genéricas en solo-lectura, así que un
    // borrador sin guardar quedaría atrapado (no se puede guardar ni descartar tras finalizar).
    // Se BLOQUEA la finalización mientras haya cambios sin guardar en la bitácora activa —
    // draftLocal nuevo o una edición en curso de un registro existente (ambos marcan `_dirty`).
    // Solo puede haber estado sucio en la bitácora que se ve (cambiar de bitácora/día lo limpia),
    // por eso basta revisar `registrosDeBitacora`. Garantiza el flujo pedido:
    // guardar todo → finalizar → solo lectura.
    const hayCambiosSinGuardar = registrosDeBitacora.some((r) => r._dirty);
    if (hayCambiosSinGuardar) {
      setModal({
        title: 'Registro borrador sin guardar',
        message: 'Hay un registro borrador sin guardar. Guárdalo o descártalo antes de finalizar el turno.',
        confirmLabel: 'Entendido', confirmColor: 'blue', icon: AlertTriangle,
        onConfirm: () => setModal(null),
      });
      return;
    }
    setModal({
      title: 'Finalizar turno',
      message: 'Esto registra que terminaste tu turno y bloquea el registro en las bitácoras generales hasta que lo reviertas. ¿Continuar?',
      confirmLabel: 'Finalizar', confirmColor: 'green', icon: CheckCircle2,
      onConfirm: async () => {
        try {
          const r = await finalizarTurno();
          auth.patchSesion({ turno_finalizado_en: r?.turno_finalizado_en ?? new Date().toISOString() });
          setModal(null);
          showToast('Finalizaste tu turno. El registro en bitácoras generales quedó bloqueado.');
        } catch (e) {
          showToast(e.message, 'error');
        }
      },
    });
  }, [finalizarTurno, showToast, auth, registrosDeBitacora]);

  // D-040: "Revertir finalización" — self-service. Limpia turno_finalizado_en (+ CIET 'reapertura')
  // y desbloquea el registro en bitácoras generales.
  const handleRevertirTurno = useCallback(async () => {
    setModal({
      title: 'Revertir finalización',
      message: 'Vas a reabrir tu turno para volver a registrar en las bitácoras generales. ¿Continuar?',
      confirmLabel: 'Revertir', confirmColor: 'green', icon: RotateCcw,
      onConfirm: async () => {
        try {
          await revertirTurno();
          auth.patchSesion({ turno_finalizado_en: null });
          setModal(null);
          showToast('Reabriste tu turno. Ya puedes registrar de nuevo.');
        } catch (e) {
          showToast(e.message, 'error');
        }
      },
    });
  }, [revertirTurno, showToast, auth]);

  // F4 + D-035: popup defensivo en logout. "Operar otra unidad" reemplaza al viejo "salir sin
  // finalizar": conserva el login Entra pero **mata la sesión de app** (`clearSesion` → POST
  // /api/auth/cerrar-app, activa=0) para que una persona no quede iniciada en 2 unidades; el
  // render cae en LoginScreen paso "planta" para elegir GEC3/GEC32 y select-context crea una
  // sesión limpia. "Sí, finalizar y salir" finaliza turno + logout backend (cookie incluida).
  // Igual que la navegación SPA de hoy, descarta los buffers no guardados del cliente sin aviso
  // cross-componente (beforeunload no aplica sin reload).
  const handleCambiarUnidad = useCallback(() => {
    setLogoutOpen(false);
    setActiveBitacora(null);
    setDraftLocal(null);
    auth.clearSesion();
  }, [auth]);

  // Abre el modal rediseñado (LogoutModal): ilustración hero + 2 acciones (Cancelar | Sí,
  // finalizar y salir). "Cambiar de unidad" ya no vive acá — se movió al HeaderMenu.
  const handleLogout = useCallback(() => setLogoutOpen(true), []);

  // Dashboard de generación (app hermana): pestaña nueva, igual que el enlace del LoginScreen.
  // noopener corta la referencia window.opener hacia esta app.
  const handleDashboard = useCallback(() => {
    window.open(DASHBOARD_URL, '_blank', 'noopener,noreferrer');
  }, []);

  const handleLogoutConfirm = useCallback(async () => {
    try { await finalizarTurno(); } catch {}
    await auth.logout(); // navega fuera (window.location); el desmontaje limpia el resto
    setLogoutOpen(false);
    setActiveBitacora(null);
    setDraftLocal(null);
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
        turnoEstado={turnoHook.estado}
        turnoBloqueo={turnoHook.bloqueo}
        turnoExtendido={turnoHook.extendido}
        onLogout={handleLogout}
        vista={vista}
        onToggleVista={() => setVista((v) => (v === 'historicos' ? 'bitacoras' : 'historicos'))}
        onDashboard={handleDashboard}
        onCambiarUnidad={handleCambiarUnidad}
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

          {bitacoraActiva && !['DISP', 'COMB'].includes(bitacoraActiva.codigo) && (
            <BarraEstado
              bitacora={bitacoraActiva}
              registros={registrosDeBitacora}
              estadoBitacora={estadoBitacora}
              puedeCrear={puedeCrear}
              esJefeTurno={esJefeTurno}
              onCerrarTurno={handleCerrarTurno}
              onReabrirTurno={handleReabrirTurno}
              onFinalizarTurno={handleFinalizarTurno}
              finalizandoTurno={finalizandoTurno}
              turnoFinalizado={turnoFinalizado}
              turnoUnidadCerrado={turnoUnidadCerrado}
              onRevertirTurno={handleRevertirTurno}
              revirtiendoTurno={revirtiendoTurno}
              filtroTexto={filtroTexto} setFiltroTexto={setFiltroTexto}
              filtroTipo={filtroTipo} setFiltroTipo={setFiltroTipo}
              filtroFecha={filtroFecha} setFiltroFecha={setFiltroFecha} onCommitFecha={intentarCambiarDia}
              filtroTurno={filtroTurno} setFiltroTurno={setFiltroTurno}
              tiposEvento={tiposEvento}
              onAddRegistro={handleAddRegistro}
              mandDirty={mandDirty}
              mandGuardando={mandGuardando}
              onGuardarMand={() => mandSaveRef.current?.()}
            />
          )}

          {/* D-045: aviso de turno de la unidad CERRADO (bloqueo para todos). Tiene precedencia sobre
              el aviso de finalización individual. Solo en bitácoras GENÉRICAS. */}
          {bitacoraActiva && !['DISP', 'COMB', 'MAND'].includes(bitacoraActiva.codigo) && turnoUnidadCerrado && (
            <div role="status"
              className="flex items-center gap-2 mt-3 rounded-xl border px-4 py-3 text-sm font-medium"
              style={{ backgroundColor: '#FEE2E2', borderColor: '#FECACA', color: '#991B1B' }}>
              <Lock size={16} className="shrink-0" />
              <span>El turno de esta unidad está cerrado. El registro en bitácoras está bloqueado hasta que un Jefe de Turno abra el siguiente turno.</span>
            </div>
          )}

          {/* D-040: aviso de turno finalizado por este usuario. Solo si la unidad NO está cerrada (ese
              aviso manda). MAND/DISP/COMB siguen operables → no muestran el banner. */}
          {bitacoraActiva && !['DISP', 'COMB', 'MAND'].includes(bitacoraActiva.codigo) && turnoFinalizado && !turnoUnidadCerrado && (
            <div role="status"
              className="flex items-center gap-2 mt-3 rounded-xl border px-4 py-3 text-sm font-medium"
              style={{ backgroundColor: '#FEF3C7', borderColor: '#FDE68A', color: '#92400E' }}>
              <AlertTriangle size={16} className="shrink-0" />
              <span>Finalizaste tu turno; el registro en bitácoras está bloqueado. Revierte para volver a registrar.</span>
            </div>
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
              planta={dispPlanta || sesion?.planta_id}
              onPlantaChange={setDispPlanta}
              puedeEditar={puedeCrear}
              showToast={showToast}
            />
          ) : bitacoraActiva?.codigo === 'COMB' ? (
            <ConsumosGrid
              bitacora={bitacoraActiva}
              plantaId={sesion?.planta_id}
              fecha={combFecha}
              onFechaChange={setCombFecha}
              puedeCrear={puedeCrear}
              showToast={showToast}
            />
          ) : (
            /* D-040/D-045: la grilla genérica se bloquea cuando (a) el turno está finalizado por este
               usuario (D-040, individual) o (b) la unidad no tiene turno abierto (D-045, para todos).
               `bloqueado` pone TODA la grilla en solo-lectura (sin editar, borrar ni entrar en modo
               edición); MAND/DISP/COMB reciben el puedeCrear crudo. */
            <GrillaRegistros
              registros={registrosDeBitacora}
              bitacora={bitacoraActiva}
              tiposEvento={tiposEvento}
              jefeNombre={catalogos.jefe?.nombre_completo}
              jdtNombre={null}
              puedeCrear={puedeCrear && !turnoFinalizado && !turnoUnidadCerrado}
              bloqueado={turnoFinalizado || turnoUnidadCerrado}
              onUpdateLocal={handleUpdateLocal}
              onSaveRegistro={handleSaveRegistro}
              onDeleteRegistro={handleDeleteRegistro}
              filtroTexto={filtroTexto}
              filtroTipo={filtroTipo}
              filtroFecha={filtroFecha}
              filtroTurno={filtroTurno}
              onLimpiarFiltros={limpiarFiltros}
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

      <LogoutModal
        open={logoutOpen}
        userName={user?.nombre_completo}
        onCancel={() => setLogoutOpen(false)}
        onConfirm={handleLogoutConfirm}
      />

      {/* D-045 E8: modal BLOQUEANTE al cambio de turno (z-50, inhabilita la unidad). Accionable para
          JdT/IngOp (extender/cerrar), informativo para el resto. Se muestra cuando el backend marca
          bloqueo=true (via WS turno-transicion o /api/me al recargar). */}
      <TurnoTransicionModal
        open={turnoHook.bloqueo}
        puedeDecidir={turnoHook.puedeDecidir}
        accionando={turnoHook.accionando}
        plantaNombre={plantaNombre}
        turno={turnoHook.turno}
        finNominal={turnoHook.finNominal}
        onExtender={handleTurnoExtender}
        onCerrar={handleTurnoCerrarModal}
      />

      {/* D-045: popup de pendientes antes del cierre manual (bitácoras con borradores + ingenieros sin
          finalizar). "Cerrar de todas formas" finaliza forzado a los pendientes y cierra el turno. */}
      <CierrePendientesModal
        open={cierreModalOpen}
        preview={cierre.preview}
        bitacorasMap={bitacorasMap}
        loading={cerrandoTurno}
        onConfirm={handleConfirmCierre}
        onCancel={handleCancelCierre}
      />

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
