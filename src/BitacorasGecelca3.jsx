// ============================================================
// PROTOTIPO VISUAL — Bitácoras Gecelca3
// Archivo único autocontenido (React + Tailwind + Lucide)
// Todos los datos son ficticios y viven en estado de React.
// ============================================================

import React, { useState, useMemo, useCallback, useEffect } from "react";
import {
  LogIn,
  LogOut,
  Clock,
  Plus,
  Save,
  Trash2,
  Lock,
  CheckCircle2,
  AlertTriangle,
  X,
  ChevronDown,
  Search,
  Filter,
  FileText,
  Activity,
  Flame,
  Droplets,
  Zap,
  Gauge,
  Cpu,
  FlaskConical,
  Leaf,
  Settings,
  Edit3,
  Eye,
  XCircle,
  Check,
  Info,
} from "lucide-react";

// ============================================================
// 1. CONSTANTES Y DATOS FICTICIOS
// ============================================================

// Paleta corporativa
const COLORS = {
  greenPrimary: "#31a354",
  greenDark: "#006f36",
  blueDark: "#003566",
  blueDeep: "#001d3d",
  blueDeepest: "#011027",
  red: "#DC3545",
  yellow: "#FFC107",
  grayLight: "#f8f9fa",
  grayMid: "#e9ecef",
  grayBorder: "#dee2e6",
  grayText: "#6c757d",
  white: "#ffffff",
};

// Catálogo de las 9 bitácoras con iconos asociados
const BITACORAS = [
  { id: "b1", nombre: "Disponibilidad", codigo: "DISP", icon: "Activity" },
  { id: "b2", nombre: "Sincronización", codigo: "SINC", icon: "Settings" },
  { id: "b3", nombre: "Caldera", codigo: "CAL", icon: "Flame" },
  { id: "b4", nombre: "Planta de Agua", codigo: "AGUA", icon: "Droplets" },
  { id: "b5", nombre: "Turbina", codigo: "TURB", icon: "Gauge" },
  { id: "b6", nombre: "Eléctrica", codigo: "ELEC", icon: "Zap" },
  { id: "b7", nombre: "Instrumentación y Control", codigo: "IC", icon: "Cpu" },
  { id: "b8", nombre: "Química", codigo: "QUIM", icon: "FlaskConical" },
  { id: "b9", nombre: "Medio Ambiente", codigo: "MA", icon: "Leaf" },
];

// Mapa de iconos para renderizar dinámicamente
const ICON_MAP = {
  Activity, Settings, Flame, Droplets, Gauge, Zap, Cpu, FlaskConical, Leaf,
};

// Tipos de evento disponibles
const TIPOS_EVENTO = [
  "Operativo",
  "Maniobra",
  "Alarma",
  "Falla",
  "Mantenimiento",
  "Inspección",
  "Cambio de Estado",
  "Redespacho",
  "Autorización",
  "Administrativo",
  "Otro",
];

// Usuarios simulados
const USUARIOS = [
  {
    id: "u1",
    nombre: "Ing. Carlos Méndez",
    rol: "Jefe de Turno",
    planta: "Gecelca3",
    turno: "Turno 2",
    email: "carlos.mendez@gecelca.com",
  },
  {
    id: "u2",
    nombre: "Ing. María López",
    rol: "Ingeniero de Turno",
    planta: "Gecelca3",
    turno: "Turno 2",
    email: "maria.lopez@gecelca.com",
  },
];

// Función para determinar turno actual
const getTurnoActual = () => {
  const hora = new Date().getHours();
  return hora < 12 ? "Turno 1" : "Turno 2";
};

// Formatear fecha local como YYYY-MM-DDTHH:MM (sin conversión a UTC)
const getLocalISOString = (date = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

// Fecha actual formateada
const getFechaHoy = () => {
  return getLocalISOString().split("T")[0];
};

const formatFechaHora = (isoStr) => {
  const d = new Date(isoStr);
  return d.toLocaleString("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

// Registros de ejemplo con descripciones realistas
const generarRegistrosIniciales = () => {
  const hoy = getFechaHoy();
  return [
    // Operación G3
    {
      id: "r1", numero_fila: 1, fecha_evento: `${hoy}T08:15`,
      turno: "Turno 1", ingeniero_id: "u1", ingeniero_nombre: "Ing. Carlos Méndez",
      rol: "Jefe de Turno", planta: "Gecelca3", area: "Operación G3",
      tipo_evento: "Operativo", descripcion: "Inicio de sincronización de unidad G3 con el SIN. Parámetros de voltaje y frecuencia dentro de rangos nominales.",
      estado: "Aprobado", bitacora_id: "b1", created_at: `${hoy}T08:15`, updated_at: `${hoy}T08:15`, guardado: true,
    },
    {
      id: "r2", numero_fila: 2, fecha_evento: `${hoy}T09:30`,
      turno: "Turno 1", ingeniero_id: "u2", ingeniero_nombre: "Ing. María López",
      rol: "Ingeniero de Turno", planta: "Gecelca3", area: "Operación G3",
      tipo_evento: "Redespacho", descripcion: "XM solicita aumento de generación a 170 MW por restricción en línea Cerromatoso-Urabá. Se ajusta set point.",
      estado: "Aprobado", bitacora_id: "b1", created_at: `${hoy}T09:30`, updated_at: `${hoy}T09:30`, guardado: true,
    },
    {
      id: "r3", numero_fila: 3, fecha_evento: `${hoy}T14:00`,
      turno: "Turno 2", ingeniero_id: "u1", ingeniero_nombre: "Ing. Carlos Méndez",
      rol: "Jefe de Turno", planta: "Gecelca3", area: "Operación G3",
      tipo_evento: "Maniobra", descripcion: "Apertura de seccionador de línea 110 kV para mantenimiento programado en bahía de transformador T3.",
      estado: "Borrador", bitacora_id: "b1", created_at: `${hoy}T14:00`, updated_at: `${hoy}T14:00`, guardado: true,
    },
    // Caldera
    {
      id: "r4", numero_fila: 1, fecha_evento: `${hoy}T07:00`,
      turno: "Turno 1", ingeniero_id: "u2", ingeniero_nombre: "Ing. María López",
      rol: "Ingeniero de Turno", planta: "Gecelca3", area: "Caldera",
      tipo_evento: "Inspección", descripcion: "Inspección visual de tubería de sobrecalentador. No se observan fugas ni deformaciones. Temperatura de metal dentro de límites.",
      estado: "Cerrado", bitacora_id: "b3", created_at: `${hoy}T07:00`, updated_at: `${hoy}T07:00`, guardado: true,
    },
    {
      id: "r5", numero_fila: 2, fecha_evento: `${hoy}T10:45`,
      turno: "Turno 1", ingeniero_id: "u2", ingeniero_nombre: "Ing. María López",
      rol: "Ingeniero de Turno", planta: "Gecelca3", area: "Caldera",
      tipo_evento: "Alarma", descripcion: "Alarma por alta temperatura en gases de escape del economizador (385°C). Se reduce carga de carbón y se monitorea tendencia.",
      estado: "Cerrado", bitacora_id: "b3", created_at: `${hoy}T10:45`, updated_at: `${hoy}T10:45`, guardado: true,
    },
    // Turbina
    {
      id: "r6", numero_fila: 1, fecha_evento: `${hoy}T06:30`,
      turno: "Turno 1", ingeniero_id: "u1", ingeniero_nombre: "Ing. Carlos Méndez",
      rol: "Jefe de Turno", planta: "Gecelca3", area: "Turbina",
      tipo_evento: "Operativo", descripcion: "Arranque de turbina de vapor. Rampa de calentamiento según procedimiento. Vibración axial en 2.1 mm/s (normal).",
      estado: "Aprobado", bitacora_id: "b5", created_at: `${hoy}T06:30`, updated_at: `${hoy}T06:30`, guardado: true,
    },
    // Eléctrica
    {
      id: "r7", numero_fila: 1, fecha_evento: `${hoy}T13:20`,
      turno: "Turno 2", ingeniero_id: "u1", ingeniero_nombre: "Ing. Carlos Méndez",
      rol: "Jefe de Turno", planta: "Gecelca3", area: "Eléctrica",
      tipo_evento: "Falla", descripcion: "Disparo de interruptor 52-3 por protección de sobrecorriente (50/51). Se investiga causa. Carga transferida a barra auxiliar.",
      estado: "Borrador", bitacora_id: "b6", created_at: `${hoy}T13:20`, updated_at: `${hoy}T13:20`, guardado: true,
    },
    {
      id: "r8", numero_fila: 2, fecha_evento: `${hoy}T15:10`,
      turno: "Turno 2", ingeniero_id: "u2", ingeniero_nombre: "Ing. María López",
      rol: "Ingeniero de Turno", planta: "Gecelca3", area: "Eléctrica",
      tipo_evento: "Mantenimiento", descripcion: "Mantenimiento correctivo en interruptor 52-3. Se reemplaza contacto principal desgastado. Pruebas de operación satisfactorias.",
      estado: "Borrador", bitacora_id: "b6", created_at: `${hoy}T15:10`, updated_at: `${hoy}T15:10`, guardado: true,
    },
    // Química
    {
      id: "r9", numero_fila: 1, fecha_evento: `${hoy}T08:00`,
      turno: "Turno 1", ingeniero_id: "u2", ingeniero_nombre: "Ing. María López",
      rol: "Ingeniero de Turno", planta: "Gecelca3", area: "Química",
      tipo_evento: "Inspección", descripcion: "Análisis de agua de caldera: pH 9.2, conductividad 18 µS/cm, sílice 0.8 ppm. Todos los parámetros dentro de especificación.",
      estado: "Aprobado", bitacora_id: "b8", created_at: `${hoy}T08:00`, updated_at: `${hoy}T08:00`, guardado: true,
    },
    // Medio Ambiente
    {
      id: "r10", numero_fila: 1, fecha_evento: `${hoy}T11:00`,
      turno: "Turno 1", ingeniero_id: "u2", ingeniero_nombre: "Ing. María López",
      rol: "Ingeniero de Turno", planta: "Gecelca3", area: "Medio Ambiente",
      tipo_evento: "Operativo", descripcion: "Lectura de CEMS: SO2 245 mg/Nm³, NOx 180 mg/Nm³, material particulado 38 mg/Nm³. Valores dentro de límites de Resolución 909/2008.",
      estado: "Cerrado", bitacora_id: "b9", created_at: `${hoy}T11:00`, updated_at: `${hoy}T11:00`, guardado: true,
    },
  ];
};

// Estados de bitácora iniciales
const generarEstadosBitacora = () => ({
  b1: "En Desarrollo", b2: "En Desarrollo", b3: "Cerrada",
  b4: "En Desarrollo", b5: "Aprobada", b6: "En Desarrollo",
  b7: "En Desarrollo", b8: "Aprobada", b9: "Cerrada",
});

// ============================================================
// 2. COMPONENTES DE UI REUTILIZABLES
// ============================================================

// --- Toast de notificación ---
function Toast({ message, type, onClose }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 3500);
    return () => clearTimeout(timer);
  }, [onClose]);

  const bgColor = type === "success"
    ? "bg-emerald-600"
    : type === "error"
    ? "bg-red-600"
    : "bg-amber-500";

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

// --- Modal de confirmación ---
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
        {/* Encabezado del modal */}
        <div className="px-6 pt-6 pb-4 flex items-start gap-4">
          {IconProp && (
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${
              confirmColor === "red" ? "bg-red-100 text-red-600" : confirmColor === "green" ? "bg-emerald-100 text-emerald-600" : "bg-blue-100 text-blue-700"
            }`}>
              <IconProp size={24} />
            </div>
          )}
          <div>
            <h3 className="text-lg font-bold text-gray-900">{title}</h3>
            <p className="text-sm text-gray-500 mt-1">{message}</p>
          </div>
        </div>
        {/* Botones */}
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

// --- Badge de estado ---
function EstadoBadge({ estado }) {
  const config = {
    Borrador: { bg: "bg-amber-100", text: "text-amber-800", dot: "bg-amber-500" },
    Cerrado: { bg: "bg-blue-100", text: "text-blue-800", dot: "bg-blue-500" },
    Aprobado: { bg: "bg-emerald-100", text: "text-emerald-800", dot: "bg-emerald-500" },
    "En Desarrollo": { bg: "bg-amber-100", text: "text-amber-800", dot: "bg-amber-500" },
    Cerrada: { bg: "bg-blue-100", text: "text-blue-800", dot: "bg-blue-500" },
    Aprobada: { bg: "bg-emerald-100", text: "text-emerald-800", dot: "bg-emerald-500" },
  };
  const c = config[estado] || config.Borrador;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${c.bg} ${c.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {estado}
    </span>
  );
}

// ============================================================
// 3. PANTALLA DE LOGIN SIMULADO
// ============================================================

const PLANTAS = [
  { id: "Gecelca3", label: "Gecelca 3", descripcion: "Unidad de generación G3" },
  { id: "Gecelca3.2", label: "Gecelca 3.2", descripcion: "Unidad de generación G3.2" },
];

function LoginScreen({ onLogin }) {
  const [plantaSeleccionada, setPlantaSeleccionada] = useState(null);

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${COLORS.blueDeepest} 0%, ${COLORS.blueDeep} 40%, ${COLORS.blueDark} 100%)` }}>
      <div className="bg-white rounded-3xl shadow-2xl p-10 max-w-md w-full mx-4">
        {/* Logo y título */}
        <div className="text-center mb-8">
          <img src="/G3 blanco.png" alt="Gecelca3" className="h-16 mx-auto mb-4" onError={(e) => { e.target.style.display = "none"; }} />
          <h1 className="text-2xl font-bold" style={{ color: COLORS.blueDeep }}>
            Bitácoras de Planta
          </h1>
          <p className="text-gray-500 text-sm mt-1">Sistema de Registro Operativo — Gecelca3</p>
        </div>

        {!plantaSeleccionada ? (
          /* Paso 1: Selección de planta */
          <div className="space-y-3">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              Selecciona tu planta
            </p>
            {PLANTAS.map((p) => (
              <button
                key={p.id}
                onClick={() => setPlantaSeleccionada(p.id)}
                className="w-full flex items-center gap-4 p-4 rounded-2xl border-2 border-gray-100 hover:border-emerald-400 hover:shadow-lg transition-all group text-left"
              >
                <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold text-sm flex-shrink-0"
                  style={{ backgroundColor: COLORS.greenDark }}>
                  {p.label.split(" ").pop()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-gray-900 group-hover:text-emerald-700 transition-colors">
                    {p.label}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">{p.descripcion}</div>
                </div>
                <LogIn size={20} className="text-gray-300 group-hover:text-emerald-500 transition-colors flex-shrink-0" />
              </button>
            ))}
          </div>
        ) : (
          /* Paso 2: Selección de perfil */
          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-4">
              <button
                onClick={() => setPlantaSeleccionada(null)}
                className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1 transition-colors"
              >
                ← Cambiar planta
              </button>
              <span className="text-xs font-semibold px-2 py-0.5 rounded-md text-white"
                style={{ backgroundColor: COLORS.greenDark }}>
                {PLANTAS.find((p) => p.id === plantaSeleccionada)?.label}
              </span>
            </div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              Selecciona tu perfil para ingresar
            </p>
            {USUARIOS.map((u) => (
              <button
                key={u.id}
                onClick={() => onLogin({ ...u, planta: plantaSeleccionada })}
                className="w-full flex items-center gap-4 p-4 rounded-2xl border-2 border-gray-100 hover:border-emerald-400 hover:shadow-lg transition-all group text-left"
              >
                <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold text-lg flex-shrink-0"
                  style={{ backgroundColor: u.rol === "Jefe de Turno" ? COLORS.greenDark : COLORS.blueDark }}>
                  {u.nombre.split(" ").slice(1, 3).map((n) => n[0]).join("")}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-gray-900 group-hover:text-emerald-700 transition-colors">
                    {u.nombre}
                  </div>
                  <div className="text-xs text-gray-500 flex items-center gap-2 mt-0.5">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-medium"
                      style={{ backgroundColor: u.rol === "Jefe de Turno" ? "#e6f4ea" : "#e8f0fe", color: u.rol === "Jefe de Turno" ? COLORS.greenDark : COLORS.blueDark }}>
                      {u.rol}
                    </span>
                    <span>•</span>
                    <span>{u.turno}</span>
                  </div>
                </div>
                <LogIn size={20} className="text-gray-300 group-hover:text-emerald-500 transition-colors flex-shrink-0" />
              </button>
            ))}
          </div>
        )}

        <p className="text-center text-xs text-gray-400 mt-8">
          Prototipo de validación — Los datos no se persisten
        </p>
      </div>
    </div>
  );
}

// ============================================================
// 4. HEADER DEL PORTAL
// ============================================================

function Header({ user, onLogout }) {
  const [reloj, setReloj] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setReloj(new Date()), 30000);
    return () => clearInterval(interval);
  }, []);

  const fechaStr = reloj.toLocaleDateString("es-CO", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
  const horaStr = reloj.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });

  return (
    <header className="text-white px-6 py-3 flex items-center justify-between shadow-lg relative z-10"
      style={{ background: `linear-gradient(90deg, ${COLORS.blueDeepest} 0%, ${COLORS.blueDark} 100%)` }}>
      {/* Logo y título */}
      <div className="flex items-center gap-4">
        <img src="/G3 blanco.png" alt="Gecelca3" className="h-10" onError={(e) => { e.target.style.display = "none"; }} />
        <div>
          <h1 className="text-lg font-bold tracking-tight">Bitácoras de Planta</h1>
          <p className="text-xs text-blue-300 opacity-80">Sistema de Registro Operativo</p>
        </div>
      </div>

      {/* Fecha, hora y turno */}
      <div className="hidden md:flex items-center gap-6 text-sm">
        <div className="flex items-center gap-2 text-blue-200">
          <Clock size={16} />
          <span className="capitalize">{fechaStr}</span>
          <span className="font-mono font-bold text-white">{horaStr}</span>
        </div>
        <span className="px-3 py-1 rounded-lg text-xs font-bold" style={{ backgroundColor: COLORS.greenPrimary }}>
          {getTurnoActual()}
        </span>
      </div>

      {/* Usuario y logout */}
      <div className="flex items-center gap-3">
        <div className="text-right hidden sm:block">
          <div className="text-sm font-semibold">{user.nombre}</div>
          <div className="text-xs text-blue-300">{user.rol} — {user.planta}</div>
        </div>
        <div className="w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold"
          style={{ backgroundColor: COLORS.greenDark }}>
          {user.nombre.split(" ").slice(1, 3).map((n) => n[0]).join("")}
        </div>
        <button onClick={onLogout} className="p-2 rounded-lg hover:bg-white/10 transition-colors" title="Cerrar sesión">
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}

// ============================================================
// 5. NAVEGACIÓN DE BITÁCORAS (TABS)
// ============================================================

function BitacoraTabs({ activeId, onSelect, registros, estadosBitacora }) {
  // Contar registros por bitácora
  const conteos = useMemo(() => {
    const c = {};
    BITACORAS.forEach((b) => { c[b.id] = 0; });
    registros.forEach((r) => { if (c[r.bitacora_id] !== undefined) c[r.bitacora_id]++; });
    return c;
  }, [registros]);

  return (
    <div className="bg-white border-b border-gray-200 px-4 overflow-x-auto">
      <div className="flex gap-1 min-w-max py-2">
        {BITACORAS.map((b) => {
          const isActive = b.id === activeId;
          const IconComp = ICON_MAP[b.icon];
          const estadoBit = estadosBitacora[b.id];
          const estadoColor = estadoBit === "Aprobada"
            ? COLORS.greenPrimary
            : estadoBit === "Cerrada"
            ? COLORS.blueDark
            : "transparent";

          return (
            <button
              key={b.id}
              onClick={() => onSelect(b.id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all whitespace-nowrap ${
                isActive
                  ? "text-white shadow-md"
                  : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              }`}
              style={isActive ? { backgroundColor: COLORS.blueDark } : {}}
            >
              {/* Indicador de estado de bitácora */}
              {estadoColor !== "transparent" && (
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: isActive ? "#fff" : estadoColor }} />
              )}
              {IconComp && <IconComp size={16} />}
              <span className="hidden lg:inline">{b.nombre}</span>
              <span className="lg:hidden">{b.codigo}</span>
              {/* Badge con número de registros */}
              <span className={`ml-1 min-w-5 h-5 flex items-center justify-center rounded-full text-xs font-bold ${
                isActive ? "bg-white/20 text-white" : "bg-gray-200 text-gray-600"
              }`}>
                {conteos[b.id]}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// 6. BARRA DE ESTADO DE BITÁCORA
// ============================================================

function BarraEstado({ bitacoraId, registros, estadoBitacora, userRol, onCerrarTurno, onAprobarCierre, filtroTexto, setFiltroTexto, filtroTipo, setFiltroTipo, onAddRegistro }) {
  const bitacora = BITACORAS.find((b) => b.id === bitacoraId);
  const regs = registros.filter((r) => r.bitacora_id === bitacoraId);
  const borradores = regs.filter((r) => r.estado === "Borrador").length;
  const cerrados = regs.filter((r) => r.estado === "Cerrado").length;
  const aprobados = regs.filter((r) => r.estado === "Aprobado").length;

  const esJefe = userRol === "Jefe de Turno";
  const puedeAgregar = estadoBitacora === "En Desarrollo";

  return (
    <div className="bg-white border-b border-gray-200 px-6 py-3 flex flex-wrap items-center gap-4">
      {/* Info de la bitácora */}
      <div className="flex items-center gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-gray-900">{bitacora?.nombre}</h2>
            <EstadoBadge estado={estadoBitacora} />
          </div>
          <div className="flex items-center gap-4 text-xs text-gray-500 mt-1">
            <span>{regs.length} registros totales</span>
            {borradores > 0 && <span className="text-amber-600 font-medium">{borradores} borradores</span>}
            {cerrados > 0 && <span className="text-blue-600 font-medium">{cerrados} cerrados</span>}
            {aprobados > 0 && <span className="text-emerald-600 font-medium">{aprobados} aprobados</span>}
          </div>
        </div>
      </div>

      {/* Separador flexible para empujar los controles a la derecha */}
      <div className="flex-1" />

      {/* Búsqueda y filtro */}
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
            {TIPOS_EVENTO.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        </div>
      </div>

      {/* Botón nuevo registro */}
      {puedeAgregar && (
        <button onClick={onAddRegistro}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white shadow-sm hover:shadow-md transition-all"
          style={{ backgroundColor: COLORS.greenPrimary }}>
          <Plus size={18} />
          Nuevo Registro
        </button>
      )}

      {/* Acciones de turno (solo Jefe de Turno) */}
      {esJefe && (
        <div className="flex items-center gap-2">
          {estadoBitacora === "En Desarrollo" && regs.length > 0 && (
            <button onClick={onCerrarTurno}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-colors shadow-sm hover:shadow-md"
              style={{ backgroundColor: COLORS.blueDark }}>
              <Lock size={16} />
              Cerrar Turno
            </button>
          )}
          {estadoBitacora === "Cerrada" && (
            <button onClick={onAprobarCierre}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-colors shadow-sm hover:shadow-md"
              style={{ backgroundColor: COLORS.greenDark }}>
              <CheckCircle2 size={16} />
              Aprobar Cierre
            </button>
          )}
          {estadoBitacora === "Aprobada" && (
            <div className="flex items-center gap-2 text-emerald-600 text-sm font-medium">
              <CheckCircle2 size={18} />
              Turno aprobado
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// 7. GRILLA DE REGISTROS (DISEÑO VISUAL MODERNO)
// ============================================================

function GrillaRegistros({
  registros, bitacoraId, estadoBitacora, user,
  onAddRegistro, onUpdateRegistro, onDeleteRegistro, onSaveRegistro,
  filtroTexto, filtroTipo,
}) {
  const [editingId, setEditingId] = useState(null);

  const regs = useMemo(() => {
    return registros
      .filter((r) => r.bitacora_id === bitacoraId)
      .filter((r) => {
        if (filtroTexto) {
          const txt = filtroTexto.toLowerCase();
          return (
            r.descripcion.toLowerCase().includes(txt) ||
            r.ingeniero_nombre.toLowerCase().includes(txt) ||
            r.tipo_evento.toLowerCase().includes(txt)
          );
        }
        return true;
      })
      .filter((r) => (filtroTipo ? r.tipo_evento === filtroTipo : true))
      .sort((a, b) => a.numero_fila - b.numero_fila);
  }, [registros, bitacoraId, filtroTexto, filtroTipo]);

  const puedeAgregar = estadoBitacora === "En Desarrollo";

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Contenido de la grilla */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {regs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-gray-400">
            <FileText size={48} className="mb-4 opacity-50" />
            <p className="text-lg font-medium">No hay registros aún</p>
            <p className="text-sm mt-1">
              {puedeAgregar
                ? "Haz clic en \"Nuevo Registro\" para comenzar"
                : "Esta bitácora no tiene registros para el día de hoy"}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Encabezado de la tabla visual */}
            <div className="hidden lg:grid grid-cols-12 gap-3 px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider">
              <div className="col-span-1">#</div>
              <div className="col-span-2">Fecha / Turno</div>
              <div className="col-span-2">Ingeniero</div>
              <div className="col-span-1">Tipo</div>
              <div className="col-span-3">Descripción</div>
              <div className="col-span-1">Estado</div>
              <div className="col-span-2 text-right">Acciones</div>
            </div>

            {/* Filas de registros */}
            {regs.map((reg) => (
              <RegistroRow
                key={reg.id}
                registro={reg}
                isEditing={editingId === reg.id || (reg.estado === "Borrador" && !reg.guardado && estadoBitacora === "En Desarrollo")}
                onStartEdit={() => setEditingId(reg.id)}
                onCancelEdit={() => setEditingId(null)}
                onUpdate={(campo, valor) => onUpdateRegistro(reg.id, campo, valor)}
                onSave={() => { onSaveRegistro(reg.id); setEditingId(null); }}
                onDelete={() => onDeleteRegistro(reg.id)}
                estadoBitacora={estadoBitacora}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Fila individual de registro ---
function RegistroRow({ registro: reg, isEditing, onStartEdit, onCancelEdit, onUpdate, onSave, onDelete, estadoBitacora }) {
  const esEditable = reg.estado === "Borrador" && estadoBitacora === "En Desarrollo";

  // Color del borde izquierdo según tipo de evento
  const tipoBorderColor = {
    Alarma: "#DC3545", Falla: "#DC3545",
    Operativo: COLORS.greenPrimary, Maniobra: COLORS.blueDark,
    Mantenimiento: "#6f42c1", Inspección: "#17a2b8",
    "Cambio de Estado": "#fd7e14", Redespacho: "#20c997",
    Autorización: "#6610f2", Administrativo: COLORS.grayText,
    Otro: COLORS.grayText,
  };
  const borderColor = tipoBorderColor[reg.tipo_evento] || COLORS.grayBorder;

  return (
    <div className={`bg-white rounded-xl border transition-all ${
      isEditing ? "border-emerald-400 shadow-lg ring-2 ring-emerald-100" : "border-gray-200 hover:shadow-md hover:border-gray-300"
    }`}
      style={{ borderLeftWidth: "4px", borderLeftColor: borderColor }}
    >
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 p-4 items-start">
        {/* # Fila */}
        <div className="lg:col-span-1 flex items-center gap-2">
          <span className="text-lg font-bold text-gray-300">#{reg.numero_fila}</span>
        </div>

        {/* Fecha y Turno */}
        <div className="lg:col-span-2">
          <label className="text-xs text-gray-400 lg:hidden">Fecha / Turno</label>
          {isEditing ? (
            <div className="space-y-1.5">
              <input
                type="datetime-local" value={reg.fecha_evento}
                onChange={(e) => onUpdate("fecha_evento", e.target.value)}
                className="w-full px-3 py-1.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
              />
              <select
                value={reg.turno} onChange={(e) => onUpdate("turno", e.target.value)}
                className="w-full px-3 py-1.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 bg-white"
              >
                <option>Turno 1</option>
                <option>Turno 2</option>
              </select>
            </div>
          ) : (
            <div>
              <div className="text-sm text-gray-900 font-medium">{formatFechaHora(reg.fecha_evento)}</div>
              <div className="text-xs text-gray-500 mt-0.5">{reg.turno}</div>
            </div>
          )}
        </div>

        {/* Ingeniero (autocompletado, no editable) */}
        <div className="lg:col-span-2">
          <label className="text-xs text-gray-400 lg:hidden">Ingeniero</label>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
              style={{ backgroundColor: reg.rol === "Jefe de Turno" ? COLORS.greenDark : COLORS.blueDark }}>
              {reg.ingeniero_nombre.split(" ").slice(1, 3).map((n) => n[0]).join("")}
            </div>
            <div className="min-w-0">
              <div className="text-sm text-gray-900 truncate">{reg.ingeniero_nombre}</div>
              <div className="text-xs text-gray-400">{reg.rol}</div>
            </div>
          </div>
        </div>

        {/* Tipo de Evento */}
        <div className="lg:col-span-1">
          <label className="text-xs text-gray-400 lg:hidden">Tipo</label>
          {isEditing ? (
            <select
              value={reg.tipo_evento} onChange={(e) => onUpdate("tipo_evento", e.target.value)}
              className="w-full px-3 py-1.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 bg-white"
            >
              <option value="">Seleccionar...</option>
              {TIPOS_EVENTO.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          ) : (
            <span className="inline-block px-2.5 py-1 rounded-lg text-xs font-semibold"
              style={{ backgroundColor: borderColor + "18", color: borderColor }}>
              {reg.tipo_evento || "—"}
            </span>
          )}
        </div>

        {/* Descripción */}
        <div className="lg:col-span-3">
          <label className="text-xs text-gray-400 lg:hidden">Descripción</label>
          {isEditing ? (
            <textarea
              value={reg.descripcion}
              onChange={(e) => onUpdate("descripcion", e.target.value)}
              rows={3}
              placeholder="Describe el evento operativo..."
              className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 resize-none"
            />
          ) : (
            <p className="text-sm text-gray-700 leading-relaxed line-clamp-2">{reg.descripcion || <span className="text-gray-400 italic">Sin descripción</span>}</p>
          )}
        </div>

        {/* Estado */}
        <div className="lg:col-span-1">
          <label className="text-xs text-gray-400 lg:hidden">Estado</label>
          <EstadoBadge estado={reg.estado} />
        </div>

        {/* Acciones */}
        <div className="lg:col-span-2 flex items-center justify-end gap-2">
          {isEditing ? (
            <>
              <button onClick={onSave}
                className="p-2 rounded-lg text-white transition-colors" style={{ backgroundColor: COLORS.greenPrimary }}
                title="Guardar">
                <Save size={16} />
              </button>
              <button onClick={onCancelEdit}
                className="p-2 rounded-lg text-gray-600 bg-gray-100 hover:bg-gray-200 transition-colors" title="Cancelar">
                <X size={16} />
              </button>
            </>
          ) : (
            <>
              {esEditable && (
                <button onClick={onStartEdit}
                  className="p-2 rounded-lg text-blue-700 bg-blue-50 hover:bg-blue-100 transition-colors" title="Editar">
                  <Edit3 size={16} />
                </button>
              )}
              {!esEditable && (
                <button className="p-2 rounded-lg text-gray-500 bg-gray-50 hover:bg-gray-100 transition-colors" title="Ver detalle"
                  onClick={onStartEdit}>
                  <Eye size={16} />
                </button>
              )}
              {esEditable && (
                <button onClick={onDelete}
                  className="p-2 rounded-lg text-red-600 bg-red-50 hover:bg-red-100 transition-colors" title="Eliminar">
                  <Trash2 size={16} />
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Metadatos en modo lectura */}
      {!isEditing && (
        <div className="px-4 pb-3 flex flex-wrap items-center gap-3 text-xs text-gray-400 border-t border-gray-100 pt-2 mt-1">
          <span>Planta: {reg.planta}</span>
          <span>•</span>
          <span>Área: {reg.area}</span>
          <span>•</span>
          <span>Creado: {formatFechaHora(reg.created_at)}</span>
        </div>
      )}
    </div>
  );
}

// ============================================================
// 8. APP PRINCIPAL — ROUTER POR ESTADO
// ============================================================

export default function App() {
  // Estado de autenticación simulada
  const [user, setUser] = useState(null);

  // Estado de la app
  const [activeBitacora, setActiveBitacora] = useState("b1");
  const [registros, setRegistros] = useState(generarRegistrosIniciales);
  const [estadosBitacora, setEstadosBitacora] = useState(generarEstadosBitacora);

  // UI state
  const [toast, setToast] = useState(null);
  const [modal, setModal] = useState(null);
  const [filtroTexto, setFiltroTexto] = useState("");
  const [filtroTipo, setFiltroTipo] = useState("");

  // Contador para IDs únicos
  const [nextId, setNextId] = useState(100);

  // Mostrar toast
  const showToast = useCallback((message, type = "success") => {
    setToast({ message, type, key: Date.now() });
  }, []);

  // --- ACCIONES DE REGISTROS ---

  // Agregar nuevo registro
  const handleAddRegistro = useCallback(() => {
    const bitacora = BITACORAS.find((b) => b.id === activeBitacora);
    const regsEnBitacora = registros.filter((r) => r.bitacora_id === activeBitacora);
    const nuevoNumero = regsEnBitacora.length > 0
      ? Math.max(...regsEnBitacora.map((r) => r.numero_fila)) + 1
      : 1;
    const fechaStr = getLocalISOString();

    const nuevo = {
      id: `r_new_${nextId}`,
      numero_fila: nuevoNumero,
      fecha_evento: fechaStr,
      turno: getTurnoActual(),
      ingeniero_id: user.id,
      ingeniero_nombre: user.nombre,
      rol: user.rol,
      planta: user.planta,
      area: bitacora?.nombre || "",
      tipo_evento: "",
      descripcion: "",
      estado: "Borrador",
      bitacora_id: activeBitacora,
      created_at: fechaStr,
      updated_at: fechaStr,
      guardado: false,
    };

    setRegistros((prev) => [...prev, nuevo]);
    setNextId((prev) => prev + 1);
    showToast("Nueva fila agregada — completa los campos editables", "success");
  }, [activeBitacora, registros, nextId, user, showToast]);

  // Actualizar campo de registro
  const handleUpdateRegistro = useCallback((id, campo, valor) => {
    setRegistros((prev) =>
      prev.map((r) =>
        r.id === id ? { ...r, [campo]: valor, updated_at: getLocalISOString() } : r
      )
    );
  }, []);

  // Guardar registro (validación simulada)
  const handleSaveRegistro = useCallback((id) => {
    const reg = registros.find((r) => r.id === id);
    if (!reg) return;

    if (!reg.tipo_evento) {
      showToast("Selecciona un Tipo de Evento antes de guardar", "error");
      return;
    }
    if (!reg.descripcion.trim()) {
      showToast("Escribe una Descripción antes de guardar", "error");
      return;
    }

    setRegistros((prev) =>
      prev.map((r) =>
        r.id === id ? { ...r, guardado: true, updated_at: getLocalISOString() } : r
      )
    );
    showToast("Registro guardado correctamente");
  }, [registros, showToast]);

  // Eliminar registro (con confirmación)
  const handleDeleteRegistro = useCallback((id) => {
    const reg = registros.find((r) => r.id === id);
    if (!reg || reg.estado !== "Borrador") return;

    setModal({
      title: "Eliminar registro",
      message: `¿Estás seguro de eliminar el registro #${reg.numero_fila}? Esta acción no se puede deshacer.`,
      confirmLabel: "Eliminar",
      confirmColor: "red",
      icon: Trash2,
      onConfirm: () => {
        setRegistros((prev) => prev.filter((r) => r.id !== id));
        setModal(null);
        showToast("Registro eliminado");
      },
    });
  }, [registros, showToast]);

  // --- ACCIONES DE BITÁCORA ---

  // Cerrar turno
  const handleCerrarTurno = useCallback(() => {
    const regs = registros.filter((r) => r.bitacora_id === activeBitacora);
    const borradores = regs.filter((r) => r.estado === "Borrador");
    const incompletos = borradores.filter((r) => !r.tipo_evento || !r.descripcion.trim());

    if (incompletos.length > 0) {
      showToast(`Hay ${incompletos.length} registro(s) incompletos. Completa todos los campos antes de cerrar.`, "error");
      return;
    }

    const bitacora = BITACORAS.find((b) => b.id === activeBitacora);
    setModal({
      title: "Cerrar Turno",
      message: `¿Cerrar el turno de la bitácora "${bitacora?.nombre}"? Se cerrarán ${borradores.length} registro(s) en estado Borrador. Los registros cerrados no podrán editarse.`,
      confirmLabel: "Cerrar Turno",
      confirmColor: "blue",
      icon: Lock,
      onConfirm: () => {
        setRegistros((prev) =>
          prev.map((r) =>
            r.bitacora_id === activeBitacora && r.estado === "Borrador"
              ? { ...r, estado: "Cerrado" }
              : r
          )
        );
        setEstadosBitacora((prev) => ({ ...prev, [activeBitacora]: "Cerrada" }));
        setModal(null);
        showToast("Turno cerrado exitosamente");
      },
    });
  }, [registros, activeBitacora, showToast]);

  // Aprobar cierre
  const handleAprobarCierre = useCallback(() => {
    const bitacora = BITACORAS.find((b) => b.id === activeBitacora);
    setModal({
      title: "Aprobar Cierre de Turno",
      message: `¿Aprobar el cierre de la bitácora "${bitacora?.nombre}"? Todos los registros pasarán a estado Aprobado.`,
      confirmLabel: "Aprobar",
      confirmColor: "green",
      icon: CheckCircle2,
      onConfirm: () => {
        setRegistros((prev) =>
          prev.map((r) =>
            r.bitacora_id === activeBitacora && r.estado === "Cerrado"
              ? { ...r, estado: "Aprobado" }
              : r
          )
        );
        setEstadosBitacora((prev) => ({ ...prev, [activeBitacora]: "Aprobada" }));
        setModal(null);
        showToast("Cierre aprobado exitosamente");
      },
    });
  }, [activeBitacora, showToast]);

  // --- LOGIN / LOGOUT ---
  const handleLogin = useCallback((u) => setUser(u), []);
  const handleLogout = useCallback(() => {
    setUser(null);
    setRegistros(generarRegistrosIniciales());
    setEstadosBitacora(generarEstadosBitacora());
    setActiveBitacora("b1");
  }, []);

  // ============================
  // RENDER
  // ============================

  // Pantalla de login
  if (!user) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <div className="h-screen flex flex-col bg-gray-100">
      {/* Header */}
      <Header user={user} onLogout={handleLogout} />

      {/* Tabs de bitácoras */}
      <BitacoraTabs
        activeId={activeBitacora}
        onSelect={(id) => { setActiveBitacora(id); setFiltroTexto(""); setFiltroTipo(""); }}
        registros={registros}
        estadosBitacora={estadosBitacora}
      />

      {/* Barra de estado */}
      <BarraEstado
        bitacoraId={activeBitacora}
        registros={registros}
        estadoBitacora={estadosBitacora[activeBitacora]}
        userRol={user.rol}
        onCerrarTurno={handleCerrarTurno}
        onAprobarCierre={handleAprobarCierre}
        filtroTexto={filtroTexto}
        setFiltroTexto={setFiltroTexto}
        filtroTipo={filtroTipo}
        setFiltroTipo={setFiltroTipo}
        onAddRegistro={handleAddRegistro}
      />

      {/* Grilla de registros */}
      <GrillaRegistros
        registros={registros}
        bitacoraId={activeBitacora}
        estadoBitacora={estadosBitacora[activeBitacora]}
        user={user}
        onAddRegistro={handleAddRegistro}
        onUpdateRegistro={handleUpdateRegistro}
        onDeleteRegistro={handleDeleteRegistro}
        onSaveRegistro={handleSaveRegistro}
        filtroTexto={filtroTexto}
        filtroTipo={filtroTipo}
      />

      {/* Toast de notificación */}
      {toast && (
        <Toast
          key={toast.key}
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}

      {/* Modal de confirmación */}
      {modal && (
        <ConfirmModal
          open={true}
          title={modal.title}
          message={modal.message}
          confirmLabel={modal.confirmLabel}
          confirmColor={modal.confirmColor}
          icon={modal.icon}
          onConfirm={modal.onConfirm}
          onCancel={() => setModal(null)}
        />
      )}

      {/* Estilos de animación inline */}
      <style>{`
        @keyframes slideIn {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @keyframes scaleIn {
          from { transform: scale(0.9); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
        .animate-slide-in { animation: slideIn 0.3s ease-out; }
        .animate-scale-in { animation: scaleIn 0.2s ease-out; }
        .line-clamp-2 {
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
      `}</style>
    </div>
  );
}
