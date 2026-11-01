import { useState, useEffect, useMemo, useCallback } from "react";
import "./App.css";
import { useRef } from "react";
import "./pages/gestion/gestion.css";
import { GestionFiltersPanel, GestionClientRow, GestionClientsRows, GestionClientsHeaderRow, GestionClientsTableBody, GestionClientsTableHeader, GestionClientsTable, GestionClientsTableShell, GestionClientsPanel, GestionKpiCard, GestionKpisPanel, GestionToolbarPanel } from "./pages/gestion/components";
import { buildGestionClientSummaries } from "./pages/gestion/services";
import {
  AppHeader,
  AppNavigation,
  ChangeHistoryModal,
  ClearDatabaseModal,
  DocumentationModal,
  ToastContainer,
} from "./components";
import {
  AbonosPage,
  AlertsPage,
  CreditPoliciesPage,
  CancelledDocumentsPage,
  ConfigPage,
  DashboardPage,
  PromisesPage,
  ReportsPage,
  SeguimientosPage,
  ManagementReportsPage,
  TendenciasPage,
} from "./pages";
import {
  createPdfContext,
  generateAbonosReport,
  generateAlertasReport,
  generateAnalisisReport,
  generateCarteraReport,
  generateEstadoCuentaReport,
  generateGestionReport,
  generatePromesasReport,
  generateTendenciasReport,
} from "./pdf";

import type {
  Alerta,
  Documento,
} from "./types";
import type {
  GestionData,
  GestionLegacyInput,
  Promesa,
  PromesaState,
} from "./types/api.types";
import type { DashboardExecutiveStats } from "./types/dashboardExecutive";
import {
  fmtMoney,
  getDocAmount,
} from "./utils";
import {
  useAlertFilters,
  useDocumentFilters,
  usePromiseFilters,
} from "./hooks";
import {
  buildAnalisisRiesgo,
  calculateAnalisisPorVendedor,
  calculateAnalisisRetenciones,
  calculateDeudoresCronicos,
  calculateEficienciaCobranza,
  calculateVencimientosProximos,
  getClientesConVencidos,
  getDocumentosVencidos,
  getResumenVencidos,
} from "./services";
import { persistLegacyGestionIds } from "./services/gestionLegacyMigration";
import { normalizeDatetimeLocalForTarea } from "./services/tareaForm";
import type { TareaPrioridad, TareaTipo } from "./types/tarea";
import {
  checkHttpApiAvailable,
  createHttpApiClient,
  getElectronApi,
} from "./app/api";
import { createDemoData } from "./app/demoData";
import { APP_NAVIGATION_TABS } from "./app/config/navigation";

const LEGACY_GESTIONES_KEY = "cartera_gestiones_locales";
const LEGACY_GESTIONES_SOURCE = "localStorage:cartera_gestiones_locales";
const LEGACY_GESTIONES_COMPLETE_KEY = "cartera_gestiones_migration_complete_v1";

async function migrarGestionesLegacy(
  api: NonNullable<Window["carteraApi"]>,
): Promise<void> {
  const stored = localStorage.getItem(LEGACY_GESTIONES_KEY);
  if (!stored) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch (error) {
    console.error("No se pudo interpretar la persistencia CRM legacy:", error);
    return;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return;

  const normalized = persistLegacyGestionIds(
    parsed,
    () => crypto.randomUUID(),
    (records) => localStorage.setItem(LEGACY_GESTIONES_KEY, JSON.stringify(records)),
  );

  const records: GestionLegacyInput[] = normalized.map((record) => ({
    legacy_id: String(record.legacy_id),
    ...(typeof record.id === "number" ? { id: record.id } : {}),
    cliente: String(record.cliente ?? "").trim(),
    fecha: typeof record.fecha === "string" ? record.fecha : undefined,
    tipo: typeof record.tipo === "string" ? record.tipo : undefined,
    resultado: typeof record.resultado === "string" ? record.resultado : undefined,
    observacion: typeof record.observacion === "string" ? record.observacion : undefined,
    fecha_promesa: typeof record.fecha_promesa === "string" ? record.fecha_promesa : undefined,
    monto_promesa: Number(record.monto_promesa) || 0,
    usuario: typeof record.usuario === "string" ? record.usuario : undefined,
    motivo: typeof record.motivo === "string" ? record.motivo : undefined,
  }));

  const result = await api.gestionesLegacyMigrar({
    source: LEGACY_GESTIONES_SOURCE,
    records,
  });

  if (result.ok === false) {
    throw new Error(`${result.code} (${result.legacy_id}): ${result.message}`);
  }
  if (result.mappings.length !== records.length) {
    throw new Error("La migración legacy CRM quedó incompleta.");
  }

  localStorage.setItem(LEGACY_GESTIONES_COMPLETE_KEY, "1");
}

export default function App() {
  // --- ESTADOS RESTAURADOS ---
  const [tab, setTab] = useState("dashboard");
  const [theme, setTheme] = useState("claro");
  const [pendingTheme, setPendingTheme] = useState("claro");
  const [density, setDensity] = useState<'normal' | 'compact'>(() => (localStorage.getItem('cartera_density') as 'normal' | 'compact') || 'normal');
  const [autoDark, setAutoDark] = useState<boolean>(() => localStorage.getItem('cartera_auto_dark') === '1');
  const [isWeb, setIsWeb] = useState(() => typeof window !== 'undefined' && !getElectronApi());
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  const [hasWritePermissions, setHasWritePermissions] = useState(true);
  
  // Datos principales
  const [docs, setDocs] = useState<any[]>([]);
  const [clientes, setClientes] = useState<any[]>([]);
  const [vendedores, setVendedores] = useState<string[]>([]);
  const [topClientes, setTopClientes] = useState<any[]>([]);
  const [allGestiones, setAllGestiones] = useState<any[]>([]);
  
  // Filtros y Búsquedas
  const [selectedCliente, setSelectedCliente] = useState("");
  const [selectedVendedor, setSelectedVendedor] = useState("");
  
  // Filtrar gestiones del cliente seleccionado desde allGestiones
  const gestiones = useMemo(() => {
    if (!selectedCliente || selectedCliente === 'Todos') return allGestiones;
    return allGestiones.filter(g => g.cliente === selectedCliente || g.razon_social === selectedCliente);
  }, [allGestiones, selectedCliente]);
  
  const [tendencias, setTendencias] = useState<any[]>([]);
  const [abonos, setAbonos] = useState<any[]>([]);
  const [_cuentasAplicar, setCuentasAplicar] = useState<any[]>([]);
  const [promesas, setPromesas] = useState<Promesa[]>([]);
  const [alertas, setAlertas] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [executiveStats, setExecutiveStats] =
    useState<DashboardExecutiveStats | null>(null);
  
  const [searchDocumentos, setSearchDocumentos] = useState("");
  const [filtroCentroCosto, setFiltroCentroCosto] = useState("Todos");
  const [filtroAging, setFiltroAging] = useState("Todos");
  const [searchAlertas, setSearchAlertas] = useState("");
  const [filtroSeveridad, setFiltroSeveridad] = useState("Todos");
  const [filtroFecha, setFiltroFecha] = useState("Todas");
  const [filtroMonto, setFiltroMonto] = useState("Todos");
  const [filtroVistaGestion, setFiltroVistaGestion] = useState("Todos");
  const [vistaAgrupada, setVistaAgrupada] = useState(false);
  const [filtroFechaDesde, setFiltroFechaDesde] = useState("");
  const [filtroFechaHasta, setFiltroFechaHasta] = useState("");
  const [abonosFechaDesde, setAbonosFechaDesde] = useState("");
  const [abonosFechaHasta, setAbonosFechaHasta] = useState("");
  const [soloPendientes, setSoloPendientes] = useState(true);
  const [vistaAnalisis, setVistaAnalisis] = useState("motivos");
  const [mostrarGraficaTendencias, setMostrarGraficaTendencias] = useState(false);

  // UI y Modales
  const [showModalGestion, setShowModalGestion] = useState(false);
  const [showModalEmpresa, setShowModalEmpresa] = useState(false);
  const [showModalLimpiar, setShowModalLimpiar] = useState(false);
  const [limpiandoBase, setLimpiandoBase] = useState(false);
  const [showModalDocumentacion, setShowModalDocumentacion] = useState(false);
  const [showModalHistorial, setShowModalHistorial] = useState(false);
  const [showModalEditarPromesa, setShowModalEditarPromesa] = useState(false);
  const [promesaEditando, setPromesaEditando] = useState<any>(null);
  const [toasts, setToasts] = useState<any[]>([]);
  const [gestionForm, setGestionForm] = useState({ tipo: "Llamada", resultado: "Contactado", observacion: "", motivo: "", fecha_promesa: "", monto_promesa: "" });
  const [promesaDocumentosSeleccionados,setPromesaDocumentosSeleccionados]=useState<string[]>([]);
  const [gestionSaving, setGestionSaving] = useState(false);
  const gestionSavingRef = useRef(false);
  const [gestionParaSeguimiento, setGestionParaSeguimiento] = useState<GestionData | null>(null);
  const [showSeguimientoPrompt, setShowSeguimientoPrompt] = useState(false);
  const [showModalSeguimiento, setShowModalSeguimiento] = useState(false);
  const [seguimientoSaving, setSeguimientoSaving] = useState(false);
  const seguimientoSavingRef = useRef(false);
  const seguimientoAttemptKeyRef = useRef<string | null>(null);
  const [seguimientoForm, setSeguimientoForm] = useState<{
    tipo: TareaTipo;
    titulo: string;
    descripcion: string;
    fechaProgramada: string;
    prioridad: TareaPrioridad;
    responsable: string;
  }>({ tipo: "LLAMAR", titulo: "", descripcion: "", fechaProgramada: "", prioridad: "MEDIA", responsable: "sistema" });
  
  // Configuración
  const [empresa, setEmpresa] = useState<any>({});
  const [remoteUrl, setRemoteUrl] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [remoteUrlHealthy, setRemoteUrlHealthy] = useState(false);
  const [localUrlHealthy, setLocalUrlHealthy] = useState(false);
  const [centrosCosto, setCentrosCosto] = useState<string[]>([]);
  const [_clientesGestionados, _setClientesGestionados] = useState<string[]>([]);
  const [dbPath, setDbPath] = useState("");
  const [updateInfo, setUpdateInfo] = useState<{ updateCount: number; currentVersion?: string; lastVersion?: string; updatedAt?: string; firstRunAt?: string } | null>(null);

  // Placeholders para datos derivados
  const [motivosData, setMotivosData] = useState<any[]>([]);
  const [productividadData, setProductividadData] = useState<any[]>([]);
  const [analisisRiesgo, setAnalisisRiesgo] = useState<any[]>([]);

  // Sprint 005: filtros y estado derivado desacoplados de App.tsx
  const docsFiltrados = useDocumentFilters(docs as Documento[], {
    selectedCliente,
    selectedVendedor,
    filtroCentroCosto,
    filtroAging,
    searchDocumentos,
    soloPendientes,
  });

  const filteredAlertas = useAlertFilters(
    alertas as Alerta[],
    searchAlertas,
    filtroSeveridad
  );

  const {
    promesasFiltradas,
    totalPromesas,
    montoTotal,
    vencidas,
    calcularDiasDiferencia,
  } = usePromiseFilters(promesas, filtroFecha, filtroMonto);

  useEffect(() => {
    const storedTheme = localStorage.getItem('cartera_theme');
    if (storedTheme) {
      setTheme(storedTheme);
      setPendingTheme(storedTheme);
    }
  }, []);

  useEffect(() => {
    const appliedTheme = theme || 'claro';
    document.documentElement.setAttribute('data-theme', appliedTheme);
    document.body.setAttribute('data-theme', appliedTheme);
    try {
      localStorage.setItem('cartera_theme', appliedTheme);
    } catch (e) {
      console.error('Error guardando tema en localStorage:', e);
    }
  }, [theme]);

  // Aplicar densidad (compacta/normal)
  useEffect(() => {
    document.documentElement.setAttribute('data-density', density);
    try {
      localStorage.setItem('cartera_density', density);
    } catch (e) {
      console.error('Error guardando densidad en localStorage:', e);
    }
  }, [density]);

  // Tema automático: oscurecer por preferencia del sistema u horario si está activado
  useEffect(() => {
    if (!autoDark) return;
    const applyAutoTheme = () => {
      try {
        const hour = new Date().getHours();
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        const shouldDark = prefersDark || hour >= 19 || hour < 7;
        setTheme(shouldDark ? 'oscuro' : (pendingTheme || 'claro'));
      } catch {
        // El tema automático es opcional; se conserva el tema vigente.
      }
    };
    applyAutoTheme();
    const timer = setInterval(applyAutoTheme, 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, [autoDark, pendingTheme]);

  // Funciones auxiliares básicas
  const addToast = (message: string, type = "info") => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    addToast("Copiado", "success");
  };

  const formatUpdateDate = (value?: string) => {
    if (!value) return "N/A";

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;

    return new Intl.DateTimeFormat("es-EC", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
  };

  const checkPermissions = async () => {
    const api = getElectronApi();
    if (api?.hasWritePermissions) {
      try {
        const canWrite = await api.hasWritePermissions();
        setHasWritePermissions(canWrite);
      } catch {
        setHasWritePermissions(false);
      }
    } else {
      setHasWritePermissions(false);
    }
  }; 
  const registrarGestion = async (g: GestionData) => {
    const api = getElectronApi();
    if (isWeb || !api?.gestionGuardar) return;
    try {
      const targetCliente = (g?.cliente || selectedCliente || '').trim();
      const payload = { cliente: targetCliente, ...g };
      const result = await api.gestionGuardar(payload);
      setAllGestiones((current) => [result.gestion, ...current]);
    } catch (e) {
      addToast("Error registrando gestión", "error");
      console.error("Error registrando gestión automática:", e);
    }
  };


  // Variables derivadas restauradas
  const clientesConVencidos = useMemo(
    () => getClientesConVencidos(docs as Documento[]),
    [docs]
  );
  const todosDocsVencidos = useMemo(
    () => getDocumentosVencidos(docs as Documento[]),
    [docs]
  );
  const docsVencidosCliente = useMemo(() => (!selectedCliente || selectedCliente === "Todos") ? [] : todosDocsVencidos.filter(d => d.razon_social === selectedCliente || d.cliente === selectedCliente), [todosDocsVencidos, selectedCliente]);
  const totalVencidoCliente = useMemo(() => docsVencidosCliente.reduce((sum, d) => sum + getDocAmount(d), 0), [docsVencidosCliente]);
  const clientesUnicos = useMemo(() => (selectedCliente && selectedCliente !== "Todos") ? [selectedCliente] : clientesConVencidos, [clientesConVencidos, selectedCliente]);
  const filteredGestiones = useMemo(() => {
    if (!selectedCliente || selectedCliente === "Todos") return allGestiones;
    return allGestiones.filter(g => g.cliente === selectedCliente || g.razon_social === selectedCliente);
  }, [allGestiones, selectedCliente]);

  const getWeekStartMonday = (date: Date) => {
    const d = new Date(date);
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d;
  };

  const weekStartMonday = getWeekStartMonday(new Date());
  const isInCurrentWeek = (fecha?: string) => {
    if (!fecha) return false;
    const date = new Date(fecha);
    if (Number.isNaN(date.getTime())) return false;
    return date >= weekStartMonday;
  };

  // Effect para detectar tamaño de pantalla
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Effect para detectar cambios de IP y cargar configuración al montar - REMOVIDO fetch(/api/config) que causaba errores

  // Effect para detectar cambios de IP y cargar datos al montar
  useEffect(() => {
    const api = getElectronApi();
    if (!api) {
      // Intentar conectar a la API HTTP
      checkHttpApiAvailable().then(available => {
        if (!available) {
          const demo = createDemoData();
          setIsWeb(true);
          setHasWritePermissions(false);
          setEmpresa({ nombre: 'Mi Empresa' });
          setDocs(demo.docs);
          setClientes(demo.clientes as any[]);
          setVendedores(demo.vendedores);
          setTopClientes(demo.topClientes as any[]);
          setAllGestiones(demo.gestiones as any[]);
          setAlertas(demo.alertas as any[]);
          setTendencias(demo.tendencias as any[]);
          setAbonos(demo.abonos as any[]);
          setPromesas(demo.gestiones.filter((g: any) => g.resultado?.includes('Promesa')) as any[]);
          setStats(demo.stats);
          setAnalisisRiesgo(demo.analisisRiesgo as any[]);
        } else {
          cargarDatos();
        }
      });
      return;
    }
    // Verificar permisos y cargar datos al montar
    checkPermissions();
    console.log('[DEBUG] Llamando cargarDatos() al montar App');
    cargarDatos();

    if (api?.getUpdateInfo) {
      api.getUpdateInfo()
        .then((info: any) => setUpdateInfo(info))
        .catch(() => setUpdateInfo(null));
    }
    
    // Log para depuración de gestiones después de 3 segundos
    setTimeout(() => {
      console.log('[DEBUG] allGestiones:', allGestiones);
    }, 3000);

    // Verificar IP cada 30 segundos (desde API Electron, no desde servidor HTTP)
    const ipCheckInterval = setInterval(async () => {
      const api = getElectronApi();
      if (!api?.getGitRemoteUrl) return;
      try {
        const result = await api.getGitRemoteUrl();
        if (result.ok && result.url && result.url !== repoUrl) {
          console.log(`📡 IP local actualizada: ${repoUrl} -> ${result.url}`);
          setRepoUrl(result.url);
        }
      } catch (error) {
        console.error("Error verificando IP:", error);
      }
    }, 30000);

    // Cargar URL remota (ngrok) al iniciar desde API Electron
    if (!isWeb && api?.getRemoteUrl) {
      (async () => {
        try {
          const result = await api.getRemoteUrl();
          if (result.ok && result.url) {
            setRemoteUrl(result.url);
            setRemoteUrlHealthy(true);
          }
        } catch (error) {
          console.error("Error cargando URL remota:", error);
        }
      })();
    }

    return () => clearInterval(ipCheckInterval);
  }, []);

  // Marcar la URL local como disponible cuando exista un valor
  useEffect(() => {
    setLocalUrlHealthy(Boolean(repoUrl));
  }, [repoUrl]);

  async function cargarDatos() {
    const api = getElectronApi();
    const httpApi = createHttpApiClient();
    const httpAvailable = api ? true : await checkHttpApiAvailable();

    if (!api && !httpAvailable) {
      const demo = createDemoData();
      setIsWeb(true);
      setHasWritePermissions(false);
      setEmpresa({ nombre: 'Mi Empresa' });
      setDocs(demo.docs);
      setClientes(demo.clientes as any[]);
      setVendedores(demo.vendedores);
      setTopClientes(demo.topClientes as any[]);
      setAllGestiones(demo.gestiones as any[]);
      setAlertas(demo.alertas as any[]);
      setTendencias(demo.tendencias as any[]);
      setAbonos(demo.abonos as any[]);
      setPromesas(demo.gestiones.filter((g: any) => g.resultado?.includes('Promesa')) as any[]);
      setStats(demo.stats);
      setAnalisisRiesgo(demo.analisisRiesgo as any[]);
      return;
    }

    // const apiToUse = api || httpApi;

    try {
      if (api?.gestionesLegacyMigrar) {
        try {
          await migrarGestionesLegacy(api);
        } catch (error) {
          console.error("La migración CRM legacy no pudo completarse:", error);
          addToast("Migración de gestiones legacy pendiente", "warning");
        }
      }
      const [empData, statsData, filtros, top, gestionesData, promesasData, alertasData, tendData, cuentasData, abonosData] = await Promise.all([
        api ? api.empresaObtener() : httpApi.empresaObtener(),
        api ? api.statsObtener() : httpApi.statsObtener(),
        api ? api.filtrosListar() : httpApi.filtrosListar(),
        api ? api.topClientes() : httpApi.topClientes(),
        api ? api.gestionesListar("") : httpApi.gestionesListar(""),
        api ? api.promesasListar() : Promise.resolve([]),
        api ? api.alertasIncumplimiento() : httpApi.alertasIncumplimiento(),
        api ? api.tendenciasHistoricas() : httpApi.tendenciasHistoricas(),
        api ? api.cuentasAplicarListar() : httpApi.cuentasAplicarListar(),
        api ? api.abonosListar() : httpApi.abonosListar()
      ]);

      const executiveData = await (
        api
          ? api.dashboardExecutiveStats()
          : httpApi.dashboardExecutiveStats()
      );

      setIsWeb(!api);
      
      if (empData) {
        setEmpresa(empData);
        if (empData.tema) {
          setTheme(empData.tema);
          setPendingTheme(empData.tema);
        }
      }
      if (statsData) setStats(statsData);
      if (executiveData) setExecutiveStats(executiveData as DashboardExecutiveStats);
      if (top) setTopClientes(top);
      if (filtros) {
        if (filtros.clientes) setClientes(filtros.clientes);
        if (filtros.vendedores) setVendedores(filtros.vendedores);
      }
      if (gestionesData) {
          const gestionesBackend: GestionData[] = Array.isArray(gestionesData)
            ? gestionesData as GestionData[]
            : [];
          setAllGestiones(gestionesBackend);
      }
      if(promesasData)setPromesas(promesasData);
      if (alertasData) setAlertas(alertasData as any[]);
      if (tendData) setTendencias(tendData as any[]);
      if (cuentasData) setCuentasAplicar(cuentasData);
      if (abonosData) setAbonos(abonosData);

      // Cargar documentos
      const docsPromise = api ? api.documentosListar({}) : httpApi.documentosListar({});
      const docsResult = await docsPromise;
      if (docsResult?.rows) {
        const rows = docsResult.rows as Documento[];
        setDocs(rows);
        setAnalisisRiesgo(buildAnalisisRiesgo(rows));
      }

      if ((api || httpAvailable) && (api?.getGitRemoteUrl)) {
        try {
          const remoteUrl = await api!.getGitRemoteUrl();
          if (remoteUrl?.url) setRepoUrl(remoteUrl.url);
        } catch (e) {
          console.log("No se pudo obtener URL remoto:", e);
        }
      }

      if (!isWeb && (api?.getDbPath)) {
        try {
          const path = await api!.getDbPath();
          if (path) setDbPath(path);
        } catch (e) {
          console.log("No se pudo obtener ruta de BD:", e);
        }
      }

      try {
        if ((api || httpAvailable) && (api?.motivosImpago)) {
          const motivosResult = await api!.motivosImpago();
          if (motivosResult) setMotivosData(motivosResult as any[]);
        }
      } catch (e) {
        console.log("Error cargando Motivos de Impago:", e);
      }

      try {
        if ((api || httpAvailable) && (api?.productividadGestor)) {
          const productividadResult = await api!.productividadGestor();
          if (productividadResult) setProductividadData(productividadResult as any[]);
        }
      } catch (e) {
        console.log("Error cargando Productividad:", e);
      }

    } catch (e) {
      console.error("Error cargando datos:", e);
    }
  }

  // Datos derivados para Gestión (Memoizados para rendimiento)

  // Paginación para Reportes
  // Eliminado: paginatedDocumentos y paginación no se usan

  const resumenVencidos = useMemo(
    () => getResumenVencidos(todosDocsVencidos as Documento[]),
    [todosDocsVencidos]
  );

  // Cálculos de negocio centralizados en services
  const eficienciaCobranza = useMemo(
    () => calculateEficienciaCobranza(docs as Documento[]),
    [docs]
  );

  const vencimientosProximos = useMemo(
    () => calculateVencimientosProximos(docs as Documento[]),
    [docs]
  );

  const analisisRetenciones = useMemo(
    () => calculateAnalisisRetenciones(docs as Documento[]),
    [docs]
  );

  const analisisPorVendedor = useMemo(
    () => calculateAnalisisPorVendedor(docs as Documento[]),
    [docs]
  );

  const deudoresCronicos = useMemo(
    () => calculateDeudoresCronicos(docs as Documento[]),
    [docs]
  );

  // 6. Extraer centros de costo únicos
  useEffect(() => {
    const centros = Array.from(new Set((docs || []).map(d => d?.centro_costo).filter(Boolean))).sort();
    setCentrosCosto(centros as string[]);
  }, [docs]);

  const cargarDocumentos = useCallback(async () => {
    const api = getElectronApi();
    if (isWeb || !api?.documentosListar) return;
    try {
      const result = await api.documentosListar({
        cliente: selectedCliente || undefined,
        vendedor: selectedVendedor || undefined
      });
      const resultTyped = result as { ok?: boolean; rows?: unknown[] };
      if (resultTyped?.rows) {
        const rows = resultTyped.rows as unknown as Documento[];
        setDocs(rows);
        setAnalisisRiesgo(buildAnalisisRiesgo(rows));
      }
    } catch (e) {
      console.error("Error cargando documentos:", e);
    }
  }, [selectedCliente, selectedVendedor]);



  useEffect(() => {
    cargarDocumentos();
  }, [cargarDocumentos]);

  async function guardarGestion() {
    const api = getElectronApi();
    if (gestionSavingRef.current || isWeb || !selectedCliente || !api?.gestionGuardar) return;
    gestionSavingRef.current = true;
    setGestionSaving(true);
    try {
      // Convertir monto_promesa a número si es una promesa de pago
      const gestionParaGuardar = {
        ...gestionForm,
        ...(gestionForm.resultado === "Promesa de Pago" && { monto_promesa: gestionForm.monto_promesa ? Number(gestionForm.monto_promesa) : 0 })
      };
      
      // Guardar en backend
      const result = await api.gestionGuardar({
        cliente: selectedCliente,
        ...gestionParaGuardar,
        promesa_documentos: promesaDocumentosSeleccionados.map(documento_normalizado=>({documento_normalizado}))
      });
      
      if (result?.ok) {
        addToast("Gestión guardada exitosamente", "success");
        setAllGestiones((current) => [result.gestion, ...current]);
        if(gestionParaGuardar.resultado==='Promesa de Pago')setPromesas(await api.promesasListar());
        
        // Limpiar formulario
        setShowModalGestion(false);
        setGestionForm({
          tipo: "Llamada",
          resultado: "Contactado",
          observacion: "",
          motivo: "",
          fecha_promesa: "",
          monto_promesa: ""
        });
        setPromesaDocumentosSeleccionados([]);
        if (typeof result.gestion.id === "number") {
          setGestionParaSeguimiento(result.gestion);
          setShowSeguimientoPrompt(true);
        }
      }
    } catch (e) {
      addToast("Error guardando gestión", "error");
      console.error("Error guardando gestión:", e);
    } finally {
      gestionSavingRef.current = false;
      setGestionSaving(false);
    }
  }

  function abrirFormularioSeguimiento() {
    if (!gestionParaSeguimiento || typeof gestionParaSeguimiento.id !== "number") return;
    seguimientoAttemptKeyRef.current = crypto.randomUUID();
    setSeguimientoForm({
      tipo: "LLAMAR",
      titulo: `Seguimiento de ${gestionParaSeguimiento.tipo || "gestión"}`,
      descripcion: "",
      fechaProgramada: "",
      prioridad: "MEDIA",
      responsable: "sistema",
    });
    setShowSeguimientoPrompt(false);
    setShowModalSeguimiento(true);
  }

  function cerrarFlujoSeguimiento(force = false) {
    if (seguimientoSavingRef.current && !force) return;
    setShowSeguimientoPrompt(false);
    setShowModalSeguimiento(false);
    setGestionParaSeguimiento(null);
    seguimientoAttemptKeyRef.current = null;
  }

  async function guardarSeguimiento() {
    const api = getElectronApi();
    if (seguimientoSavingRef.current || !api?.tareaCrear || !gestionParaSeguimiento || typeof gestionParaSeguimiento.id !== "number") return;
    const fechaProgramada = normalizeDatetimeLocalForTarea(seguimientoForm.fechaProgramada);
    if (!fechaProgramada) {
      addToast("Fecha y hora de seguimiento inválidas", "error");
      return;
    }
    if (!seguimientoAttemptKeyRef.current) seguimientoAttemptKeyRef.current = crypto.randomUUID();
    seguimientoSavingRef.current = true;
    setSeguimientoSaving(true);
    try {
      const result = await api.tareaCrear({
        cliente: gestionParaSeguimiento.cliente,
        gestion_origen_id: gestionParaSeguimiento.id,
        tipo: seguimientoForm.tipo,
        titulo: seguimientoForm.titulo,
        descripcion: seguimientoForm.descripcion,
        fecha_programada: fechaProgramada,
        prioridad: seguimientoForm.prioridad,
        responsable: seguimientoForm.responsable,
        idempotency_key: seguimientoAttemptKeyRef.current,
      });
      if (result.ok === false) {
        addToast(`${result.code}: ${result.message}`, "error");
        return;
      }
      addToast("Seguimiento creado exitosamente", "success");
      cerrarFlujoSeguimiento(true);
    } catch (error) {
      addToast("No se pudo crear el seguimiento; puede reintentar", "error");
      console.error("Error creando seguimiento:", error);
    } finally {
      seguimientoSavingRef.current = false;
      setSeguimientoSaving(false);
    }
  }

  async function eliminarGestion(id: number) {
    const api = getElectronApi();
    if (isWeb || !api?.gestionEliminar) return;
    try {
      const result = await api.gestionEliminar(id);
      if (!result.ok) {
        addToast("message" in result ? result.message : "Gestión no encontrada", "error");
        return;
      }
      addToast("Gestión eliminada", "success");
      setAllGestiones((current) => current.filter(g => g.id !== id));
    } catch (e) {
      addToast("Error eliminando gestión", "error");
      console.error("Error eliminando gestión:", e);
    }
  }

  async function cumplirPromesa(id: number) {
    void id;
    const api = getElectronApi();
    if (isWeb || !api?.promesasReconciliar) return;
    try {
      const result = await api.promesasReconciliar();
      setPromesas(result.promesas);
      addToast(result.updated>0?"Pagos importados conciliados":"No hay pagos importados nuevos para esta promesa",result.updated>0?"success":"info");
    } catch (e) {
      addToast("Error cumpliendo promesa", "error");
      console.error("Error cumpliendo promesa:", e);
    }
  }

  async function actualizarPromesa(promesaActualizada: any) {
    const api=getElectronApi();if (isWeb||!api?.promesaActualizar) return;
    try {
      const result=await api.promesaActualizar({id:promesaActualizada.id,fecha_promesa:promesaActualizada.fecha_promesa,monto_prometido:Number(promesaActualizada.monto_prometido),motivo_incumplimiento:promesaActualizada.motivo_incumplimiento||null,observacion:promesaActualizada.observacion||null,estado:promesaActualizada.estado as PromesaState,documentos:(promesaActualizada.documentos??[]).map((documento:any)=>({documento_normalizado:String(documento.documento_normalizado).trim(),monto_comprometido:documento.monto_comprometido??null}))});
      if(result.ok===false)throw new Error(result.message);
      const saved=result.promesa;
      setPromesas(current=>current.map(p=>p.id===saved.id?saved:p));
      setShowModalEditarPromesa(false);
      setPromesaEditando(null);
      addToast("Promesa actualizada correctamente", "success");
      
    } catch (e) {
      addToast("Error actualizando promesa", "error");
      console.error("Error actualizando promesa:", e);
    }
  }

  async function cancelarPromesa(id:number){const api=getElectronApi();if(isWeb||!api?.promesaCambiarEstado)return;const result=await api.promesaCambiarEstado({id,estado:'CANCELADA'});if(result.ok===false){addToast(result.message,'error');return;}setPromesas(current=>current.map(p=>p.id===id?result.promesa:p));addToast('Promesa cancelada','success');}

  async function guardarEmpresa() {
    const api = getElectronApi();
    if (isWeb || !api?.empresaGuardar) return;
    try {
      await api.empresaGuardar(empresa);
      setShowModalEmpresa(false);
      addToast("Datos de empresa guardados", "success");
      await cargarDatos();
    } catch (e) {
      addToast("Error guardando empresa", "error");
      console.error("Error guardando empresa:", e);
    }
  }

  const [descuadresDetectados, setDescuadresDetectados] = useState<number>(0);

  async function importarExcel() {
  const api = getElectronApi();
  if (isWeb || !api?.importarContifico) return;
  try {
    const result = await api.importarContifico();
    const resultTyped = result as { 
      ok?: boolean; 
      insertedDocs?: number; 
      descuadresDetectados?: number; 
      message?: string 
    };

    if (resultTyped?.ok) {
      const descuadres = resultTyped.descuadresDetectados || 0;
      setDescuadresDetectados(descuadres);

      if (descuadres > 0) {
        addToast(`⚠️ Importado: ${resultTyped.insertedDocs} docs (${descuadres} con descuadres en tramos)`, "warning");
      } else {
        addToast(`✅ Importación exitosa: ${resultTyped.insertedDocs} documentos perfectamente cuadrados`, "success");
      }

      await cargarDatos();
      await cargarDocumentos();
    } else {
      const errorMsg = resultTyped?.message || "Error desconocido";
      addToast("Error en importación: " + errorMsg, "error");
    }
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    addToast("Error importando Excel: " + errorMsg, "error");
  }
}

  const exportarAbonosPDF = async (): Promise<void> => {
    let abonosFiltrados = abonos;

    if (abonosFechaDesde) {
      abonosFiltrados = abonosFiltrados.filter(
        (abono) => abono.fecha && abono.fecha >= abonosFechaDesde
      );
    }

    if (abonosFechaHasta) {
      const hasta =
        abonosFechaHasta.length === 10
          ? `${abonosFechaHasta}T23:59:59`
          : abonosFechaHasta;

      abonosFiltrados = abonosFiltrados.filter(
        (abono) => abono.fecha && abono.fecha <= hasta
      );
    }

    if (abonosFiltrados.length === 0) {
      addToast(
        "No hay abonos para reportar en el rango seleccionado",
        "info"
      );
      return;
    }

    try {
      await generateAbonosReport({
        abonos: abonosFiltrados,
        context: createPdfContext(empresa),
      });

      addToast("✅ Reporte de abonos generado", "success");
    } catch (error: unknown) {
      console.error(error);
      const message =
        error instanceof Error ? error.message : "Error desconocido";
      addToast(`Error generando reporte de abonos: ${message}`, "error");
    }
  };

  const canExportAnalisis = useMemo(() => {
    if (vistaAnalisis === 'motivos') return motivosData.length > 0;
    if (vistaAnalisis === 'productividad') return productividadData.length > 0;
    if (vistaAnalisis === 'riesgo') return analisisRiesgo.length > 0;
    return deudoresCronicos.length > 0;
  }, [
    vistaAnalisis,
    motivosData,
    productividadData,
    analisisRiesgo,
    deudoresCronicos,
  ]);

  const exportarAnalisisPDF = async (): Promise<void> => {
    try {
      await generateAnalisisReport({
        vista: vistaAnalisis,
        motivos: motivosData,
        productividad: productividadData,
        riesgos: analisisRiesgo,
        deudoresCronicos,
        context: createPdfContext(empresa),
      });

      addToast('✅ Reporte de análisis generado', 'success');
    } catch (error: unknown) {
      console.error(error);

      const message =
        error instanceof Error
          ? error.message
          : 'Error desconocido al generar el reporte';

      addToast(
        `Error generando reporte de análisis: ${message}`,
        'error'
      );
    }
  };


  async function exportarBackup() {
    const api = getElectronApi();
    if (isWeb || !api?.exportarBackup) {
      addToast("Esta función solo está disponible en la versión de escritorio", "info");
      return;
    }
    try {
      const result = await api.exportarBackup();
      if (result.ok) {
        addToast("Respaldo exportado correctamente", "success");
      } else {
        addToast("Error: " + result.message, "error");
      }
    } catch (e) {
      console.error(e);
      addToast("Error al exportar respaldo", "error");
    }
  }

  async function cambiarLogo() {
    const api = getElectronApi();
    if (isWeb || !api?.cambiarLogo) {
      addToast("Solo disponible en la versión de escritorio", "info");
      return;
    }
    try {
      const result = await api.cambiarLogo();
      if (result.ok) {
        addToast("Logotipo actualizado correctamente", "success");
        // Actualizar estado local inmediatamente
        setEmpresa((prev: any) => ({ ...prev, logo: result.logo }));
      }
      else if (result.message !== "Cancelado") addToast("Error: " + result.message, "error");
    } catch (e) {
      console.error(e);
    }
  }

  const aplicarTemaPendiente = async (): Promise<void> => {
    setTheme(pendingTheme);

    if (isWeb) {
      addToast("Tema aplicado (local)", "success");
      return;
    }

    const api = getElectronApi();

    try {
      if (api?.empresaGuardar) {
        await api.empresaGuardar({ ...empresa, tema: pendingTheme });
        addToast("Tema guardado y aplicado", "success");
        return;
      }

      addToast("Tema aplicado (local)", "success");
    } catch (error: unknown) {
      console.error(error);
      addToast("Error guardando tema", "error");
    }
  };

  const exportarReporteTendencias = async (): Promise<void> => {
    if (tendencias.length === 0) {
      addToast("No hay datos de tendencias para exportar", "info");
      return;
    }

    try {
      await generateTendenciasReport({
        tendencias,
        context: createPdfContext(empresa),
      });

      addToast("✅ Reporte de tendencias generado", "success");
    } catch (error: unknown) {
      console.error(error);
      const message =
        error instanceof Error ? error.message : "Error desconocido";
      addToast(`Error generando reporte de tendencias: ${message}`, "error");
    }
  };

  const agingData = useMemo(() => {
    if (!stats?.aging) return null;
    // Calcular acumulado para >240 días (sumando todos los rangos posteriores)
    const mas240 = (stats.aging.d270 || 0) + (stats.aging.d300 || 0) + (stats.aging.d330 || 0) + (stats.aging.d360 || 0) + (stats.aging.d360p || 0);

    return [
      { name: "Por Vencer", saldo: stats.aging.porVencer || 0, fill: "#10b981" },
      { name: "30", saldo: stats.aging.d30 || 0, fill: "#3b82f6" },
      { name: "60", saldo: stats.aging.d60 || 0, fill: "#f59e0b" },
      { name: "90", saldo: stats.aging.d90 || 0, fill: "#ef4444" },
      { name: "120", saldo: stats.aging.d120 || 0, fill: "#dc2626" },
      { name: "150", saldo: stats.aging.d150 || 0, fill: "#b91c1c" },
      { name: "180", saldo: stats.aging.d180 || 0, fill: "#991b1b" },
      { name: "210", saldo: stats.aging.d210 || 0, fill: "#7f1d1d" },
      { name: "240", saldo: stats.aging.d240 || 0, fill: "#6b1515" },
      { name: ">240", saldo: mas240, fill: "#5c0e0e" }
    ];
  }, [stats]);

  const topClientesData = useMemo(() => {
    if (!topClientes.length) return null;
    
    // Función para interpolar entre verde (bajo saldo) y rojo (alto saldo)
    const interpolateColor = (percentage: number): string => {
      // Verde: rgb(34, 197, 94), Rojo: rgb(239, 68, 68)
      const green = [34, 197, 94];
      const red = [239, 68, 68];
      
      // Clamp percentage entre 0 y 1
      const p = Math.max(0, Math.min(1, percentage));
      
      const r = Math.round(green[0] + (red[0] - green[0]) * p);
      const g = Math.round(green[1] + (red[1] - green[1]) * p);
      const b = Math.round(green[2] + (red[2] - green[2]) * p);
      
      return `rgb(${r}, ${g}, ${b})`;
    };
    
    // Encontrar el máximo saldo para calcular porcentajes
    const maxTotal = Math.max(...topClientes.map(c => c.total || 0));
    
    // Retornar datos en formato Recharts con color
    return topClientes.map(c => {
      const percentage = maxTotal > 0 ? (c.total || 0) / maxTotal : 0;
      const color = interpolateColor(percentage);
      return {
        name: c.razon_social?.substring(0, 18) || 'Cliente',
        saldo: c.total || 0,
        fill: color
      };
    });
  }, [topClientes]);

  // Renderizado condicional por tab
  function renderContent() {

    if (tab === "creditos") {
      return <CreditPoliciesPage />;
    }

    if (tab === "anulados") {
      return <CancelledDocumentsPage />;
    }

    if (tab === "dashboard") {
      return (
        <DashboardPage
          isMobile={isMobile}
          descuadresDetectados={descuadresDetectados}
          stats={stats}
          agingData={agingData}
          topClientesData={topClientesData}
          eficienciaCobranza={eficienciaCobranza}
          vencimientosProximos={vencimientosProximos}
          analisisRetenciones={analisisRetenciones}
          analisisPorVendedor={analisisPorVendedor}
          deudoresCronicos={deudoresCronicos}
          executiveStats={executiveStats}
          empresa={empresa}
          dbPath={dbPath}
          onRefresh={cargarDatos}
          onNavigate={(target) => setTab(target)}
          onOpenReports={() => setTab("reportes")}
        />
      );
    }

    if (tab === "gestion") {
      // VISTA FUSIONADA COMPLETA: Gestión + Estados de Cuenta
      
      // KPIs globales
      const totalVencidoSistema = todosDocsVencidos.reduce((s, d) => s + getDocAmount(d), 0);
      const totalPorGestionar = (selectedCliente && selectedCliente !== "Todos")
        ? docsVencidosCliente.reduce((sum, d) => sum + getDocAmount(d), 0)
        : totalVencidoSistema;
      
      // Calcular gestiones de hoy
      const hoy = new Date().toISOString().split('T')[0];
      
      // EN GENERAL: clientes únicos / EN INDIVIDUAL: total de gestiones
      const gestionesHoy = (selectedCliente && selectedCliente !== "Todos")
        ? gestiones.filter(g => g.fecha && g.fecha.startsWith(hoy)).length  // Individual: todas las gestiones del cliente
        : allGestiones
            .filter(g => g.fecha && g.fecha.startsWith(hoy))
            .map(g => g.cliente || g.razon_social)
            .filter((cliente, index, arr) => arr.indexOf(cliente) === index)  // General: clientes únicos
            .length;
      
      // PDFs generados hoy
      // EN GENERAL: clientes únicos / EN INDIVIDUAL: total de PDFs
      const pdfsGenerados = (selectedCliente && selectedCliente !== "Todos")
        ? gestiones.filter(g => g.fecha && g.fecha.startsWith(hoy) && g.tipo === "PDF").length  // Individual: total de PDFs del cliente
        : allGestiones
            .filter(g => g.fecha && g.fecha.startsWith(hoy) && g.tipo === "PDF")
            .map(g => g.cliente || g.razon_social)
            .filter((cliente, index, arr) => arr.indexOf(cliente) === index)  // General: clientes únicos con PDF
            .length;
      
      // Función para exportar PDF
      const exportarEstadoDeCuenta = async (
        clienteNombre: string
      ): Promise<void> => {
        if (!clienteNombre || clienteNombre === "Todos") {
          addToast(
            "Selecciona un cliente específico para generar su estado de cuenta",
            "info"
          );
          return;
        }

        const docsCliente = docs
          .filter(
            (documento) =>
              (documento.razon_social === clienteNombre ||
                documento.cliente === clienteNombre) &&
              getDocAmount(documento) > 0.01
          )
          .sort(
            (a, b) =>
              (b.dias_vencidos || 0) - (a.dias_vencidos || 0)
          );

        if (docsCliente.length === 0) {
          addToast("Este cliente no tiene documentos pendientes", "info");
          return;
        }

        try {
          await generateEstadoCuentaReport({
            clienteNombre,
            documentos: docsCliente,
            context: createPdfContext(empresa),
          });

          addToast("Estado de cuenta generado", "success");

          registrarGestion({
            cliente: clienteNombre,
            tipo: "PDF",
            resultado: "Generado",
            observacion: "Estado de cuenta generado en PDF",
            fecha: new Date().toISOString(),
          });
        } catch (error: unknown) {
          console.error(error);
          const message =
            error instanceof Error ? error.message : "Error desconocido";
          addToast(`Error generando estado de cuenta: ${message}`, "error");
        }
      };

      const enviarEmail = (clienteNombre: string) => {
        const empresaNombre = empresa?.nombre || "[Nombre Empresa]";
        const fechaHoy = new Date().toLocaleDateString();
        const docsCliente = todosDocsVencidos.filter(d => (d.razon_social === clienteNombre || d.cliente === clienteNombre));
        const totalCliente = docsCliente.reduce((sum, d) => sum + getDocAmount(d), 0);
        
        const asunto = `Estado de Cuenta - ${empresaNombre}`;
        const lineas = [
          `Estimado cliente *${clienteNombre}*,`,
          '',
          `Adjunto el estado de cuenta al ${fechaHoy}.`,
          `Total Vencido: ${fmtMoney(totalCliente)}`,
          '',
          'Saludos cordiales.'
        ];
        const cuerpo = encodeURIComponent(lineas.join('\r\n'));
        window.open(`mailto:?subject=${asunto}&body=${cuerpo}`, '_blank');

        // Registrar gestión automática de Email
        registrarGestion({
          cliente: clienteNombre,
          tipo: "Email",
          resultado: "Enviado",
          observacion: "Recordatorio de pago enviado por correo",
          fecha: new Date().toISOString()
        });
        addToast("Gestión de Email registrada", "success");
      };

      // Función para generar Reporte de Gestión (Evidencia)
      const exportarReporteGestion = async (): Promise<void> => {
        let gestionesFiltradas = filteredGestiones;

        if (filtroFechaDesde) {
          gestionesFiltradas = gestionesFiltradas.filter(
            (gestion) => gestion.fecha && gestion.fecha >= filtroFechaDesde
          );
        }

        if (filtroFechaHasta) {
          const hasta =
            filtroFechaHasta.length === 10
              ? `${filtroFechaHasta}T23:59:59`
              : filtroFechaHasta;

          gestionesFiltradas = gestionesFiltradas.filter(
            (gestion) => gestion.fecha && gestion.fecha <= hasta
          );
        }

        if (gestionesFiltradas.length === 0) {
          addToast(
            "No hay gestiones para reportar en el rango seleccionado",
            "info"
          );
          return;
        }

        try {
          const alcance =
            selectedCliente === "Todos" || !selectedCliente
              ? "General (Todos los clientes)"
              : selectedCliente;

          await generateGestionReport({
            gestiones: gestionesFiltradas,
            alcance,
            context: createPdfContext(empresa),
          });

          addToast("✅ Reporte de gestión generado", "success");
        } catch (error: unknown) {
          console.error(error);
          const message =
            error instanceof Error ? error.message : "Error desconocido";
          addToast(`Error generando reporte: ${message}`, "error");
        }
      };

      return (
        <div className="gestion-powerbi-page" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div className="gestion-executive-layout gestion-workspace-header">
            <GestionKpisPanel>
              <div className="gestion-kpi-grid">
                <GestionKpiCard
                  label={<>Clientes con vencimientos</>}
                  value={<>{clientesConVencidos.length}</>}
                  tone="primary"
                />
                <GestionKpiCard
                  label={<>Total vencido</>}
                  value={<>{fmtMoney(totalPorGestionar)}</>}
                  tone="danger"
                  negative
                />
                <GestionKpiCard
                  label={<>En gestión esta semana</>}
                  value={<>{gestionesHoy}</>}
                  tone="success"
                />
                <GestionKpiCard
                  label={<>Estados generados</>}
                  value={<>{pdfsGenerados}</>}
                  tone="violet"
                />
              </div>
            </GestionKpisPanel>

            <GestionToolbarPanel>
              <GestionFiltersPanel>
                <div className="gestion-toolbar-content">
                  <div className="gestion-filter-column">
                    <label className="gestion-field">
                      <span>Cliente</span>
                      <select
                        value={selectedCliente}
                        onChange={(event) => {
                          const value = event.target.value;
                          setSelectedCliente(
                            value === "Todos" ? "" : value,
                          );
                        }}
                      >
                        <option value="Todos">Todos</option>
                        {clientes.map((cliente) => (
                          <option
                            key={
                              cliente.cliente ||
                              cliente.razon_social
                            }
                            value={
                              cliente.cliente ||
                              cliente.razon_social
                            }
                          >
                            {cliente.razon_social ||
                              cliente.cliente}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="gestion-field">
                      <span>Estado</span>
                      <select
                        value={filtroVistaGestion}
                        onChange={(event) =>
                          setFiltroVistaGestion(
                            event.target.value,
                          )
                        }
                      >
                        <option value="Todos">Todos</option>
                        <option value="Con Vencidos">
                          Con vencidos
                        </option>
                        <option value="Mayor Deuda">
                          Mayor deuda
                        </option>
                        <option value="Más Días Vencidos">
                          Más días vencidos
                        </option>
                      </select>
                    </label>
                  </div>

                  <div className="gestion-report-column">
                    <div className="gestion-date-title">
                      <span aria-hidden="true">📅</span>
                      <span>Periodo del reporte</span>
                    </div>

                    <div className="gestion-date-range">
                      <label className="gestion-date-field">
                        <span>Desde</span>
                        <input
                          type="date"
                          value={filtroFechaDesde}
                          onChange={(event) =>
                            setFiltroFechaDesde(
                              event.target.value,
                            )
                          }
                        />
                      </label>

                      <span
                        className="gestion-date-separator"
                        aria-hidden="true"
                      >
                        →
                      </span>

                      <label className="gestion-date-field">
                        <span>Hasta</span>
                        <input
                          type="date"
                          value={filtroFechaHasta}
                          onChange={(event) =>
                            setFiltroFechaHasta(
                              event.target.value,
                            )
                          }
                        />
                      </label>
                    </div>

                    <div className="gestion-action-row">
                      <button
                        className="btn primary gestion-action-button"
                        onClick={exportarReporteGestion}
                      >
                        <span aria-hidden="true">📊</span>
                        Reporte
                      </button>

                      <button
                        className="btn secondary gestion-action-button"
                        onClick={() => {
                          if (resumenVencidos.length === 0) {
                            addToast(
                              "No hay clientes con vencidos",
                              "info",
                            );
                            return;
                          }

                          const top =
                            resumenVencidos.slice(0, 50);
                          const lines = top.map(
                            (item) =>
                              `${item.cliente}: ${fmtMoney(
                                item.total,
                              )}`,
                          );

                          copyToClipboard(
                            lines.join("\r\n"),
                          );
                          addToast(
                            "Lista masiva copiada al portapapeles",
                            "success",
                          );
                        }}
                        disabled={!hasWritePermissions}
                      >
                        <span aria-hidden="true">📞</span>
                        Masiva
                      </button>

                      <button
                        className="btn secondary gestion-action-button"
                        onClick={() => {
                          if (resumenVencidos.length === 0) {
                            addToast(
                              "No hay clientes con vencidos",
                              "info",
                            );
                            return;
                          }

                          const top =
                            resumenVencidos.slice(0, 30);
                          const lines = [
                            `Resumen de vencidos - ${new Date().toLocaleDateString()}`,
                            "",
                            ...top.map(
                              (item) =>
                                `- ${item.cliente}: ${fmtMoney(
                                  item.total,
                                )}`,
                            ),
                          ];

                          const cuerpo = encodeURIComponent(
                            lines.join("\r\n"),
                          );

                          window.open(
                            `mailto:?subject=Resumen%20de%20Vencidos&body=${cuerpo}`,
                            "_blank",
                          );

                          addToast(
                            "Resumen masivo listo para enviar",
                            "success",
                          );
                        }}
                        disabled={!hasWritePermissions}
                      >
                        <span aria-hidden="true">📧</span>
                        Estados
                      </button>
                    </div>
                  </div>
                </div>
              </GestionFiltersPanel>
            </GestionToolbarPanel>
          </div>

          {/* GESTOR INTEGRADO DE CLIENTE - UNA SOLA INTERFAZ FUNCIONAL */}
          {selectedCliente && selectedCliente !== "Todos" ? (
            <GestionClientsPanel>
              <div className="gestion-client-workspace">
              {/* HEADER DEL CLIENTE */}
              <div className="gestion-client-header" style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingBottom: '16px',
                borderBottom: '2px solid #e5e7eb',
                marginBottom: '16px',
                flexWrap: 'wrap',
                gap: '12px'
              }}>
                <div className="gestion-client-identity">\n                  <h2 className="gestion-client-name" style={{margin: '0 0 8px 0', fontSize: '1.5rem', fontWeight: 700, color: '#1f2937'}}>
                    👤 {selectedCliente}
                  </h2>
                  <div className="gestion-client-summary" style={{
                    display: 'flex',
                    gap: '24px',
                    fontSize: '0.9rem',
                    color: '#6b7280',
                    flexWrap: 'wrap'
                  }}>
                    <span>💰 Vencido: <strong style={{color: '#ef4444', fontSize: '1.1rem'}}>{fmtMoney(totalVencidoCliente)}</strong></span>
                    {todosDocsVencidos.find(d => d.razon_social === selectedCliente || d.cliente === selectedCliente) && (
                      <span>⏰ Máx Días Venc.: <strong style={{color: '#f59e0b', fontSize: '1.1rem'}}>{Math.max(...todosDocsVencidos.filter(d => d.razon_social === selectedCliente || d.cliente === selectedCliente).map(d => d.dias_vencidos || 0))} días</strong></span>
                    )}
                    {gestiones.filter(g => isInCurrentWeek(g.fecha)).length > 0 && (
                      <span>📞 Última contacto: <strong style={{color: '#3b82f6'}}>{gestiones.find(g => isInCurrentWeek(g.fecha))?.fecha ? gestiones.find(g => isInCurrentWeek(g.fecha))?.fecha.substring(0, 10) : 'N/A'}</strong></span>
                    )}
                  </div>
                </div>
                <button 
                  className="btn secondary gestion-client-back"
                  style={{padding: '8px 16px', fontSize: '0.9rem'}}
                  onClick={() => setSelectedCliente(null)}
                  title="Volver a lista de clientes"
                >
                  🔙 Volver
                </button>
              </div>

              {/* ACCIONES RÁPIDAS */}
              <div className="gestion-client-actions" style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                gap: '12px',
                marginBottom: '24px'
              }}>
                <button 
                  className="btn secondary gestion-client-action"
                  style={{
                    padding: '14px',
                    fontSize: '0.95rem',
                    fontWeight: '600',
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '6px'
                  }}
                  onClick={() => setShowModalGestion(true)}
                  disabled={!hasWritePermissions}
                >
                  <span style={{fontSize: '1.4rem'}}>📞</span>
                  Registrar Llamada
                </button>

                <button 
                  className="btn secondary gestion-client-action"
                  style={{
                    padding: '14px',
                    fontSize: '0.95rem',
                    fontWeight: '600',
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '6px'
                  }}
                  onClick={() => enviarEmail(selectedCliente)}
                >
                  <span style={{fontSize: '1.4rem'}}>📧</span>
                  Enviar Email
                </button>

                <button 
                  className="btn secondary gestion-client-action"
                  style={{
                    padding: '14px',
                    fontSize: '0.95rem',
                    fontWeight: '600',
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '6px'
                  }}
                  onClick={async () => {
                    const empresaNombre = empresa?.nombre || "[Nombre de tu Empresa]";
                    const fechaHoy = new Date().toLocaleDateString();
                    const docsCliente = todosDocsVencidos.filter(d => (d.razon_social === selectedCliente || d.cliente === selectedCliente));
                    const totalCliente = docsCliente.reduce((sum, d) => sum + getDocAmount(d), 0);
                    const lineas = [
                      `Hola *${selectedCliente}*,`,
                      '',
                      `Te saluda el Departamento de Cobranzas de *${empresaNombre}*.`,
                      '',
                      `*Recordatorio de Pago* al ${fechaHoy}`,
                      `*Total Vencido:* ${fmtMoney(totalCliente)}`,
                      '',
                      `Adjunto el detalle en PDF para tu revisión.`,
                      '',
                      `Por favor, ayúdanos con la confirmación del pago a la brevedad posible.`,
                      '',
                      `¡Saludos!`
                    ];
                    const mensaje = encodeURIComponent(lineas.join('\n'));
                    window.open(`https://wa.me/?text=${mensaje}`, '_blank');
                    registrarGestion({
                      cliente: selectedCliente,
                      tipo: "WhatsApp",
                      resultado: "Enviado",
                      observacion: "Recordatorio enviado por WhatsApp",
                      fecha: new Date().toISOString()
                    });
                    addToast("Gestión de WhatsApp registrada", "success");
                  }}
                >
                  <span style={{fontSize: '1.4rem'}}>💬</span>
                  WhatsApp
                </button>

                <button 
                  className="btn primary gestion-client-action"
                  style={{
                    padding: '14px',
                    fontSize: '0.95rem',
                    fontWeight: '600',
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '6px'
                  }}
                  onClick={() => exportarEstadoDeCuenta(selectedCliente)}
                >
                  <span style={{fontSize: '1.4rem'}}>📄</span>
                  Estado de Cuenta
                </button>
              </div>

              {/* DOCUMENTOS VENCIDOS DEL CLIENTE */}
              {docsVencidosCliente.length > 0 && (
                <div className="gestion-client-documents" style={{marginBottom: '24px'}}>
                  <h3 className="gestion-client-section-title" style={{fontSize: '1.1rem', fontWeight: '700', marginBottom: '12px', color: '#1f2937'}}>
                    📋 Documentos Vencidos ({docsVencidosCliente.length})
                  </h3>
                  <GestionClientsTableShell>
                    <table className="data-table" style={{fontSize: '0.85rem', marginBottom: 0}}>
                      <thead>
                        <tr>
                          <th>Documento</th>
                          <th>Emisión</th>
                          <th>Vencimiento</th>
                          <th className="num">Días Vencidos</th>
                          <th className="num">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {docsVencidosCliente.slice(0, 10).map(d => (
                          <tr key={d.id}>
                            <td style={{fontWeight: '600'}}>{d.documento || d.numero}</td>
                            <td>{d.fecha_emision}</td>
                            <td>{d.fecha_vencimiento}</td>
                            <td className="num">
                              <span style={{
                                backgroundColor: (d.dias_vencidos || 0) > 90 ? '#fee2e2' : (d.dias_vencidos || 0) > 60 ? '#fef3c7' : '#e0e7ff',
                                color: (d.dias_vencidos || 0) > 90 ? '#dc2626' : (d.dias_vencidos || 0) > 60 ? '#d97706' : '#4f46e5',
                                padding: '2px 8px',
                                borderRadius: '4px',
                                fontWeight: '600',
                                fontSize: '0.9rem'
                              }}>
                                {d.dias_vencidos || 0}
                              </span>
                            </td>
                            <td className="num" style={{fontWeight: '600'}}>{fmtMoney(d.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </GestionClientsTableShell>
                </div>
              )}

              {/* HISTORIAL DE GESTIONES */}
              <div className="gestion-client-history">
                <div className="gestion-client-history-header" style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '12px',
                  flexWrap: 'wrap',
                  gap: '12px'
                }}>
                  <h3 className="gestion-client-section-title" style={{fontSize: '1.1rem', fontWeight: '700', margin: 0, color: '#1f2937'}}>
                    📞 Historial de Gestiones ({gestiones.length})
                  </h3>
                  {gestiones.length > 0 && (
                    <button 
                      className="btn secondary"
                      style={{padding: '6px 12px', fontSize: '0.85rem'}}
                      onClick={exportarReporteGestion}
                    >
                      📊 Generar Reporte
                    </button>
                  )}
                </div>

                <div className="table-wrapper">
                  <table className="data-table" style={{fontSize: '0.85rem', marginBottom: 0}}>
                    <thead>
                      <tr>
                        <th style={{minWidth: '120px'}}>Fecha</th>
                        <th style={{minWidth: '100px'}}>Tipo</th>
                        <th>Resultado</th>
                        <th>Observación</th>
                        <th className="num">Monto Promesa</th>
                        <th style={{width: '40px'}}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {gestiones.length === 0 ? (
                        <tr>
                          <td colSpan={6} style={{textAlign: 'center', padding: '24px', color: '#9ca3af'}}>
                            📭 Sin gestiones registradas. ¡Comienza registrando una!
                          </td>
                        </tr>
                      ) : (
                        gestiones.slice(0, 20).map(g => (
                          <tr key={g.id} style={{
                            borderLeft: g.resultado?.includes('Promesa') && !g.resultado?.includes('Cumplida') ? '4px solid #3b82f6' : '',
                            paddingLeft: '8px'
                          }}>
                            <td style={{fontWeight: '600', color: '#374151'}}>
                              {g.fecha ? g.fecha.replace('T', ' ').substring(0, 16) : '-'}
                            </td>
                            <td>
                              <span style={{
                                backgroundColor: 
                                  g.tipo?.includes('Llamada') ? '#dcfce7' :
                                  g.tipo?.includes('Email') ? '#dbeafe' :
                                  g.tipo?.includes('WhatsApp') ? '#dcfce7' :
                                  g.tipo?.includes('PDF') ? '#f3e8ff' : '#f3f4f6',
                                color:
                                  g.tipo?.includes('Llamada') ? '#166534' :
                                  g.tipo?.includes('Email') ? '#1e40af' :
                                  g.tipo?.includes('WhatsApp') ? '#166534' :
                                  g.tipo?.includes('PDF') ? '#7e22ce' : '#374151',
                                padding: '4px 8px',
                                borderRadius: '4px',
                                fontSize: '0.8rem',
                                fontWeight: '600'
                              }}>
                                {g.tipo || 'N/A'}
                              </span>
                            </td>
                            <td style={{fontWeight: '600', color: g.resultado?.includes('Promesa') ? '#3b82f6' : '#374151'}}>
                              {g.resultado || '-'}
                            </td>
                            <td style={{fontSize: '0.8rem', maxWidth: '250px', color: '#6b7280'}}>
                              {g.observacion ? (g.observacion.length > 40 ? g.observacion.substring(0, 40) + '...' : g.observacion) : '-'}
                            </td>
                            <td className="num">
                              {g.fecha_promesa ? (
                                <span style={{
                                  backgroundColor: '#fef3c7',
                                  color: '#d97706',
                                  padding: '2px 8px',
                                  borderRadius: '4px',
                                  fontSize: '0.8rem',
                                  fontWeight: '600'
                                }}>
                                  {g.fecha_promesa} ${(g.monto_promesa || 0).toLocaleString()}
                                </span>
                              ) : '-'}
                            </td>
                            <td style={{textAlign: 'center'}}>
                              <button 
                                className="promesa-eliminar"
                                style={{position: 'static', transform: 'none', marginLeft: 0, fontSize: '1rem'}}
                                onClick={() => eliminarGestion(g.id)}
                                disabled={!hasWritePermissions}
                                title="Eliminar gestión"
                              >
                                ❌
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                {gestiones.length > 20 && (
                  <p style={{textAlign: 'center', color: '#9ca3af', fontSize: '0.8rem', marginTop: '8px', marginBottom: 0}}>
                    Mostrando últimas 20 de {gestiones.length} gestiones
                  </p>
                )}
              </div>
                          </div>
            </GestionClientsPanel>
          ) : (
            /* TABLA DE CLIENTES PARA SELECCIONAR */
            <div className="card gestion-clients-panel gestion-clients-overview">
              <div className="card-title gestion-table-title"><span><strong>Clientes con vencimientos</strong><small>Selecciona un cliente para iniciar la gestión</small></span></div>
              <div className="table-wrapper">
                <div style={{overflowX: 'auto', width: '100%', padding: 0, margin: 0}}>
                  <GestionClientsTable>
                    <GestionClientsTableHeader>
                      <GestionClientsHeaderRow>
                        <th>Cliente</th>
                        <th className="num">Vencido</th>
                        <th className="text-center" title="Última llamada">📞</th>
                        <th className="text-center" title="Último email">📧</th>
                        <th className="text-center" title="Último WhatsApp">💬</th>
                        <th className="text-center" title="Último estado de cuenta">📄</th>
                        <th style={{width: '100px'}}>Acción</th>
                      </GestionClientsHeaderRow>
                    </GestionClientsTableHeader>
                    <GestionClientsTableBody><GestionClientsRows>
                      {clientesUnicos.length === 0 ? (
                        <GestionClientRow>
                          <td colSpan={7} style={{textAlign: 'center', color: '#9ca3af', padding: '24px'}}>
                            No se encontraron clientes con vencimientos
                          </td>
                        </GestionClientRow>
                      ) : (
                        buildGestionClientSummaries({
                          clientes: clientesUnicos,
                          documentos: todosDocsVencidos,
                          getClientName: (documento) =>
                            documento.razon_social || documento.cliente || "",
                          getAmount: getDocAmount,
                        })
                          .map(({ cliente, docsCliente, totalCliente }) => {
                            const maxDias = docsCliente.length > 0 ? Math.max(...docsCliente.map(d => d.dias_vencidos || 0)) : 0;
                            const gestionesSemana = allGestiones.filter(g =>
                              (g.razon_social || g.cliente) === cliente && isInCurrentWeek(g.fecha)
                            );
                            const lastCall = gestionesSemana.find(g => g.tipo === 'Llamada' || g.tipo === 'Visita');
                            const lastEmail = gestionesSemana.find(g => g.tipo === 'Email');
                            const lastWhatsapp = gestionesSemana.find(g => g.tipo === 'WhatsApp');
                            const lastPdf = gestionesSemana.find(g => g.tipo === 'PDF');
                            const colorIndicador = maxDias > 90 ? '#ef4444' : maxDias > 60 ? '#f59e0b' : '#10b981';

                            return (
                              <tr
                                key={cliente}
                                style={{
                                  borderLeft: `4px solid ${colorIndicador}`,
                                  cursor: 'pointer'
                                }}
                              >
                                <td style={{fontWeight: '600', color: '#7c3aed'}}>{cliente}</td>
                                <td className="num" style={{fontWeight: '700', fontSize: '0.95rem'}}>{fmtMoney(totalCliente)}</td>
                                <td className="text-center" title={lastCall ? lastCall.fecha : 'Sin contacto'}>
                                  {lastCall ? <span style={{color:'#10b981', fontSize: '1.1rem'}}>✅</span> : '—'}
                                </td>
                                <td className="text-center" title={lastEmail ? lastEmail.fecha : 'Sin envío'}>
                                  {lastEmail ? <span style={{color:'#3b82f6', fontSize: '1.1rem'}}>✅</span> : '—'}
                                </td>
                                <td className="text-center" title={lastWhatsapp ? lastWhatsapp.fecha : 'Sin envío'}>
                                  {lastWhatsapp ? <span style={{color:'#22c55e', fontSize: '1.1rem'}}>✅</span> : '—'}
                                </td>
                                <td className="text-center" title={lastPdf ? lastPdf.fecha : 'Sin estado de cuenta'}>
                                  {lastPdf ? <span style={{color:'#6366f1', fontSize: '1.1rem'}}>✅</span> : '—'}
                                </td>
                                <td>
                                  <button 
                                    className="btn secondary"
                                    style={{padding: '6px 12px', fontSize: '0.85rem', width: '100%'}}
                                    onClick={() => setSelectedCliente(cliente)}
                                  >
                                    Gestionar →
                                  </button>
                                </td>
                              </tr>
                            );
                          })
                      )}
                    </GestionClientsRows></GestionClientsTableBody>
                  </GestionClientsTable>
                </div>
              </div>
            </div>
          )}
        </div>
      );
    }

    if (tab === "config") {
      return (
        <ConfigPage
          pendingTheme={pendingTheme}
          onPendingThemeChange={setPendingTheme}
          density={density}
          onDensityChange={setDensity}
          autoDark={autoDark}
          onAutoDarkChange={setAutoDark}
          onApplyTheme={aplicarTemaPendiente}
          hasWritePermissions={hasWritePermissions}
          onEditCompany={() => setShowModalEmpresa(true)}
          onChangeLogo={cambiarLogo}
          onImportExcel={importarExcel}
          onOpenCancelledImport={() => setTab("anulados")}
          onExportBackup={exportarBackup}
          onClearDatabase={() => setShowModalLimpiar(true)}
          onOpenDocumentation={() => setShowModalDocumentacion(true)}
          onOpenHistory={() => setShowModalHistorial(true)}
          updateInfo={updateInfo}
          formatUpdateDate={formatUpdateDate}
          dbPath={dbPath}
          onCopyDbPath={copyToClipboard}
        />
      );
    }

    if (tab === "gerencia") {
      return <ManagementReportsPage />;
    }

    if (tab === "reportes") {
      const exportarReporteCarteraPdf = async (): Promise<void> => {
        if (docsFiltrados.length === 0) {
          addToast('No hay documentos para generar el reporte PDF', 'info');
          return;
        }

        try {
          await generateCarteraReport({
            documentos: docsFiltrados,
            filtros: {
              cliente: selectedCliente,
              vendedor: selectedVendedor,
            },
            context: createPdfContext(empresa),
          });

          addToast('✅ Reporte PDF generado correctamente', 'success');
        } catch (error: unknown) {
          console.error('Error generando reporte PDF:', error);
          const mensaje =
            error instanceof Error ? error.message : 'Error desconocido';
          addToast(`❌ Error al generar PDF: ${mensaje}`, 'error');
        }
      };

      return (
        <ReportsPage
          isMobile={isMobile}
          documentos={docsFiltrados}
          clientes={clientes}
          vendedores={vendedores}
          centrosCosto={centrosCosto}
          selectedCliente={selectedCliente}
          setSelectedCliente={setSelectedCliente}
          selectedVendedor={selectedVendedor}
          setSelectedVendedor={setSelectedVendedor}
          filtroCentroCosto={filtroCentroCosto}
          setFiltroCentroCosto={setFiltroCentroCosto}
          filtroAging={filtroAging}
          setFiltroAging={setFiltroAging}
          searchDocumentos={searchDocumentos}
          setSearchDocumentos={setSearchDocumentos}
          vistaAgrupada={vistaAgrupada}
          setVistaAgrupada={setVistaAgrupada}
          soloPendientes={soloPendientes}
          setSoloPendientes={setSoloPendientes}
          analisisPorVendedor={analisisPorVendedor}
          analisisRetenciones={analisisRetenciones}
          onExportPdf={exportarReporteCarteraPdf}
          onNotify={addToast}
        />
      );
    }

    if (tab === "crm") {
      const exportarReportePromesas = async (): Promise<void> => {
        if (promesasFiltradas.length === 0) {
          addToast("No hay promesas para reportar con los filtros seleccionados", "info");
          return;
        }

        try {
          await generatePromesasReport({
            promesas,
            promesasFiltradas,
            context: createPdfContext(empresa),
          });

          addToast("✅ Reporte de promesas generado", "success");
        } catch (error: unknown) {
          console.error("Error generando reporte de promesas:", error);
          const message = error instanceof Error ? error.message : "Error desconocido";
          addToast(`❌ Error generando reporte: ${message}`, "error");
        }
      };

      return (
        <PromisesPage
          promesasFiltradas={promesasFiltradas}
          totalPromesas={totalPromesas}
          montoTotal={montoTotal}
          vencidas={vencidas}
          tasaCumplimiento={stats?.tasaCumplimientoPromesas || 0}
          filtroFecha={filtroFecha}
          setFiltroFecha={setFiltroFecha}
          filtroMonto={filtroMonto}
          setFiltroMonto={setFiltroMonto}
          calcularDiasDiferencia={calcularDiasDiferencia}
          hasWritePermissions={hasWritePermissions}
          isMobile={isMobile}
          onExportPdf={exportarReportePromesas}
          onCrearPromesa={()=>{setGestionForm({tipo:'Llamada',resultado:'Promesa de Pago',observacion:'',motivo:'',fecha_promesa:'',monto_promesa:''});setShowModalGestion(true);}}
          onCumplirPromesa={cumplirPromesa}
          onEditarPromesa={(promesa) => {
            setPromesaEditando(promesa);
            setShowModalEditarPromesa(true);
          }}
          onEliminarPromesa={cancelarPromesa}
        />
      );
    }

    if (tab === "seguimientos") {
      return <SeguimientosPage onRegisterGestion={(cliente) => { setSelectedCliente(cliente); setGestionForm({ tipo: 'Llamada', resultado: 'Contactado', observacion: '', motivo: '', fecha_promesa: '', monto_promesa: '' }); setShowModalGestion(true); }} />;
    }

    if (tab === "analisis") {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div className="card">
            <div className="card-title">📊 Panel de Análisis</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '16px', alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button className={`btn ${vistaAnalisis === 'motivos' ? 'primary' : 'secondary'}`} onClick={() => setVistaAnalisis('motivos')}>Motivos Impago</button>
                <button className={`btn ${vistaAnalisis === 'productividad' ? 'primary' : 'secondary'}`} onClick={() => setVistaAnalisis('productividad')}>Productividad</button>
                <button className={`btn ${vistaAnalisis === 'riesgo' ? 'primary' : 'secondary'}`} onClick={() => setVistaAnalisis('riesgo')}>Análisis Riesgo</button>
                <button
                  className={`btn ${vistaAnalisis === 'cronicos' ? 'primary' : 'secondary'}`}
                  onClick={() => setVistaAnalisis('cronicos')}
                >
                  ⚠️ Deudores Crónicos
                </button>
              </div>
              <button className="btn primary" onClick={exportarAnalisisPDF} disabled={!canExportAnalisis}>
                Generar reporte
              </button>
            </div>

            {vistaAnalisis === 'motivos' && (
              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Motivo</th>
                      <th className="num">Casos</th>
                      <th className="num">Monto Total</th>
                      <th className="num">%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {motivosData.length > 0 ? motivosData.map((m, i) => {
                      const total = motivosData.reduce((sum, x) => sum + x.total, 0);
                      return (
                        <tr key={i}>
                          <td>{m.label}</td>
                          <td className="num">{m.count}</td>
                          <td className="num">{fmtMoney(m.total)}</td>
                          <td className="num">{total > 0 ? ((m.total / total * 100).toFixed(1)) : '0'}%</td>
                        </tr>
                      );
                    }) : <tr><td colSpan={4} style={{textAlign: 'center', color: '#888', fontSize: '1.1rem'}}><b>Motivos de Impago</b><br/><span style={{fontWeight: 'normal'}}>Sin datos</span></td></tr>}
                  </tbody>
                </table>
              </div>
            )}

            {vistaAnalisis === 'productividad' && (
              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Gestor</th>
                      <th className="num">Gestiones</th>
                      <th className="num">Promesas</th>
                      <th className="num">Pagos</th>
                      <th className="num">Tasa Promesa</th>
                      <th className="num">Saldo Recuperable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {productividadData.length > 0 ? productividadData.map((p, i) => (
                      <tr key={i}>
                        <td>{p.usuario}</td>
                        <td className="num">{p.total_gestiones}</td>
                        <td className="num">{p.promesas}</td>
                        <td className="num">{p.pagos}</td>
                        <td className="num">{p.tasa_promesa}%</td>
                        <td className="num">{fmtMoney(p.saldo_recuperable)}</td>
                      </tr>
                    )) : <tr><td colSpan={6} style={{textAlign: 'center', color: '#888', fontSize: '1.1rem'}}><b>Productividad de Gestores</b><br/><span style={{fontWeight: 'normal'}}>Sin datos</span></td></tr>}
                  </tbody>
                </table>
              </div>
            )}

            {vistaAnalisis === 'riesgo' && (
              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Cliente</th>
                      <th className="num">Deuda Total</th>
                      <th className="num">Deuda Vencida</th>
                      <th className="num">Días Mora</th>
                      <th className="num">Score</th>
                      <th className="num">Predicción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analisisRiesgo.length > 0 ? (
                      analisisRiesgo.map((a, i) => {
                        const prediccion = a.score < 30 ? '🔴 Alto Riesgo' : a.score < 60 ? '🟡 Riesgo Medio' : '🟢 Bajo Riesgo';
                        return (
                          <tr key={i}>
                            <td>{a.razon_social}</td>
                            <td className="num">{fmtMoney(a.total_deuda)}</td>
                            <td className="num">{fmtMoney(a.deuda_vencida)}</td>
                            <td className="num">{a.max_dias_mora}</td>
                            <td className="num">
                              <span className={a.score < 50 ? "kpi-negative" : ""}>{a.score}</span>
                            </td>
                            <td>{prediccion}</td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan={6} style={{textAlign: 'center', color: '#9ca3af', padding: '20px'}}>
                          Sin datos de riesgo
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {vistaAnalisis === 'cronicos' && (
              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Cliente</th>
                      <th>Vendedor</th>
                      <th className="num">Deuda Total</th>
                      <th className="num">Vencido (+90 días)</th>
                      <th className="num">Docs Vencidos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deudoresCronicos.length > 0 ? (
                      deudoresCronicos.map((d, idx) => (
                        <tr key={idx} style={{ borderLeft: '4px solid #dc2626' }}>
                          <td><strong>{idx + 1}</strong></td>
                          <td>{d.razon_social}</td>
                          <td>{d.vendedor}</td>
                          <td className="num">{fmtMoney(d.totalDeuda)}</td>
                          <td className="num kpi-negative">{fmtMoney(d.totalVencido)}</td>
                          <td className="num">{d.documentosVencidos}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={6} style={{textAlign: 'center', color: '#9ca3af', padding: '20px'}}>
                          ✅ No hay deudores crónicos (mora mayor a 90 días)
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
        </div>
        </div>
      );
    }

    if (tab === "alertas") {
      const exportarAlertas = async (): Promise<void> => {
        if (filteredAlertas.length === 0) {
          addToast("No hay alertas para exportar", "info");
          return;
        }

        try {
          await generateAlertasReport({
            alertas: filteredAlertas,
            context: createPdfContext(empresa),
          });

          addToast("PDF exportado exitosamente", "success");
        } catch (error: unknown) {
          console.error(error);
          const message =
            error instanceof Error ? error.message : "Error desconocido";
          addToast(`Error al exportar PDF: ${message}`, "error");
        }
      };

      return (
        <AlertsPage
          alertas={filteredAlertas}
          searchAlertas={searchAlertas}
          setSearchAlertas={setSearchAlertas}
          filtroSeveridad={filtroSeveridad}
          setFiltroSeveridad={setFiltroSeveridad}
          onExportPdf={exportarAlertas}
        />
      );
    }

    if (tab === "tendencias") {
      return (
        <TendenciasPage
          tendencias={tendencias}
          mostrarGrafica={mostrarGraficaTendencias}
          onToggleGrafica={() =>
            setMostrarGraficaTendencias((previous) => !previous)
          }
          onExportPdf={exportarReporteTendencias}
        />
      );
    }

    if (tab === "cuentas") {
      return (
        <AbonosPage
          abonos={abonos}
          fechaDesde={abonosFechaDesde}
          fechaHasta={abonosFechaHasta}
          onFechaDesdeChange={setAbonosFechaDesde}
          onFechaHastaChange={setAbonosFechaHasta}
          onExportPdf={exportarAbonosPDF}
          onReconciled={cargarDatos}
        />
      );
    }

    return null;
  }

  const limpiarBaseDatos = async (): Promise<void> => {
    if (limpiandoBase) return;

    setLimpiandoBase(true);

    try {
      console.log("🧹 Limpiando almacenamiento local...");

      try {
        localStorage.clear();
        sessionStorage.clear();
        localStorage.removeItem("cartera_gestiones_locales");
        localStorage.removeItem("cartera_theme");
        localStorage.removeItem("electron_data");
        console.log("✅ Almacenamiento local limpio");
      } catch (storageError) {
        console.error("Error limpiando almacenamiento local:", storageError);
      }

      console.log("🗑️ Limpiando base de datos...");
      const api = getElectronApi();
      const result = await api?.limpiarBaseDatos?.();

      if (!result?.ok) {
        addToast(result?.message || "Error limpiando base", "error");
        return;
      }

      setShowModalLimpiar(false);
      addToast(
        "Base de datos y caché local limpiados completamente. Recargando sistema...",
        "success"
      );

      await new Promise((resolve) => setTimeout(resolve, 1000));
      window.location.reload();
    } catch (error: unknown) {
      console.error("Error limpiando base de datos:", error);
      addToast("Error limpiando base de datos", "error");
    } finally {
      setLimpiandoBase(false);
    }
  };

  return (
    <div className="app">
      <AppHeader
        empresa={empresa}
        isWeb={isWeb}
        remoteUrl={remoteUrl}
        remoteUrlHealthy={remoteUrlHealthy}
        repoUrl={repoUrl}
        localUrlHealthy={localUrlHealthy}
        onCopyUrl={copyToClipboard}
        onRefresh={() => window.location.reload()}
      />

      <AppNavigation
        tabs={APP_NAVIGATION_TABS}
        activeTab={tab}
        onChange={setTab}
      />

      <main className="content" style={{ overflowX: 'hidden', overflowY: tab === 'dashboard' ? 'hidden' : 'auto' }}>
        {renderContent()}
      </main>

      <ToastContainer toasts={toasts} />

      {/* Modal Gestión */}
      {showModalGestion && (
        <div className="modal-overlay" onClick={() => setShowModalGestion(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">Nueva Gestión</div>
            <div className="modal-body">
              <label className="field">
                <span>Cliente</span>
                <select value={selectedCliente} onChange={e=>setSelectedCliente(e.target.value)}>
                  <option value="">-- Seleccionar cliente --</option>
                  {clientes.map((cliente:any)=><option key={cliente.cliente??cliente} value={cliente.cliente??cliente}>{cliente.razon_social??cliente.cliente??cliente}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Tipo</span>
                <select value={gestionForm.tipo} onChange={e => setGestionForm({...gestionForm, tipo: e.target.value})}>
                  <option>Llamada</option>
                  <option>WhatsApp</option>
                  <option>Email</option>
                  <option>Visita</option>
                </select>
              </label>
              <label className="field">
                <span>Resultado</span>
                <select value={gestionForm.resultado} onChange={e => setGestionForm({...gestionForm, resultado: e.target.value})}>
                  <option>Contactado</option>
                  <option>No contesta</option>
                  <option>Promesa de Pago</option>
                  <option>Rechazado</option>
                </select>
              </label>
              <label className="field">
                <span>Motivo (si aplica)</span>
                <select value={gestionForm.motivo} onChange={e => setGestionForm({...gestionForm, motivo: e.target.value})}>
                  <option value="">-- Seleccionar --</option>
                  <option>Falta de liquidez</option>
                  <option>Disputa comercial</option>
                  <option>Olvido/Descuido</option>
                  <option>Producto defectuoso</option>
                  <option>Error administrativo</option>
                  <option>En reclamo</option>
                  <option>Cambio de facturación</option>
                  <option>Otros</option>
                </select>
              </label>
              <label className="field">
                <span>Observación</span>
                <textarea value={gestionForm.observacion} onChange={e => setGestionForm({...gestionForm, observacion: e.target.value})} rows={3} placeholder="Detalles de la gestión..." />
              </label>
              {gestionForm.resultado === "Promesa de Pago" && (
                <>
                  <label className="field">
                    <span>Fecha Promesa</span>
                    <input type="date" value={gestionForm.fecha_promesa} onChange={e => setGestionForm({...gestionForm, fecha_promesa: e.target.value})} />
                  </label>
                  <label className="field">
                    <span>Monto Promesa</span>
                    <input type="number" value={gestionForm.monto_promesa} onChange={e => setGestionForm({...gestionForm, monto_promesa: e.target.value})} placeholder="0" />
                  </label>
                  <label className="field">
                    <span>Documentos asociados (opcional)</span>
                    <select multiple value={promesaDocumentosSeleccionados} onChange={e=>setPromesaDocumentosSeleccionados(Array.from(e.currentTarget.selectedOptions,option=>option.value))} style={{minHeight:'90px'}}>
                      {docs.filter(doc=>(doc.cliente===selectedCliente||doc.razon_social===selectedCliente)&&Number(doc.total)>0).map(doc=>{const key=String(doc.documento_normalizado||doc.documento||'').trim();return key?<option key={doc.id||key} value={key}>{doc.documento||key} — ${Number(doc.total).toLocaleString()}</option>:null;})}
                    </select>
                    <small>Ctrl/Cmd + clic para seleccionar varios. Sin documentos, el cumplimiento queda para revisión manual.</small>
                  </label>
                </>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn secondary" onClick={() => setShowModalGestion(false)}>Cancelar</button>
              <button className="btn primary" onClick={guardarGestion} disabled={gestionSaving}>{gestionSaving ? "Guardando…" : "Guardar"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Decisión explícita posterior: la Gestión ya quedó persistida. */}
      {showSeguimientoPrompt && gestionParaSeguimiento && (
        <div className="modal-overlay" onClick={() => cerrarFlujoSeguimiento()}>
          <div className="modal" onClick={event => event.stopPropagation()}>
            <div className="modal-header">Gestión registrada</div>
            <div className="modal-body">
              <p>La Gestión #{gestionParaSeguimiento.id} quedó guardada. ¿Desea programar una actividad futura para este cliente?</p>
            </div>
            <div className="modal-footer">
              <button className="btn secondary" onClick={() => cerrarFlujoSeguimiento()}>Ahora no</button>
              <button className="btn primary" onClick={abrirFormularioSeguimiento}>Crear seguimiento</button>
            </div>
          </div>
        </div>
      )}

      {showModalSeguimiento && gestionParaSeguimiento && (
        <div className="modal-overlay" onClick={() => cerrarFlujoSeguimiento()}>
          <div className="modal" onClick={event => event.stopPropagation()}>
            <div className="modal-header">Nuevo seguimiento</div>
            <div className="modal-body">
              <label className="field">
                <span>Cliente</span>
                <input value={gestionParaSeguimiento.cliente} disabled />
              </label>
              <label className="field">
                <span>Gestión de origen</span>
                <input value={`#${gestionParaSeguimiento.id}`} disabled />
              </label>
              <label className="field">
                <span>Tipo</span>
                <select value={seguimientoForm.tipo} onChange={event => setSeguimientoForm(current => ({ ...current, tipo: event.target.value as TareaTipo }))}>
                  <option value="LLAMAR">Llamar</option>
                  <option value="ENVIAR_CORREO">Enviar correo</option>
                  <option value="VISITAR">Visitar</option>
                  <option value="REVISAR_PROMESA">Revisar promesa</option>
                  <option value="REVISAR_DOCUMENTOS">Revisar documentos</option>
                  <option value="SEGUIMIENTO_GENERAL">Seguimiento general</option>
                </select>
              </label>
              <label className="field">
                <span>Título</span>
                <input value={seguimientoForm.titulo} onChange={event => setSeguimientoForm(current => ({ ...current, titulo: event.target.value }))} />
              </label>
              <label className="field">
                <span>Descripción</span>
                <textarea rows={3} value={seguimientoForm.descripcion} onChange={event => setSeguimientoForm(current => ({ ...current, descripcion: event.target.value }))} />
              </label>
              <label className="field">
                <span>Fecha programada</span>
                <input type="datetime-local" step="1" value={seguimientoForm.fechaProgramada} onChange={event => setSeguimientoForm(current => ({ ...current, fechaProgramada: event.target.value }))} />
              </label>
              <label className="field">
                <span>Prioridad</span>
                <select value={seguimientoForm.prioridad} onChange={event => setSeguimientoForm(current => ({ ...current, prioridad: event.target.value as TareaPrioridad }))}>
                  <option value="ALTA">Alta</option>
                  <option value="MEDIA">Media</option>
                  <option value="BAJA">Baja</option>
                </select>
              </label>
              <label className="field">
                <span>Responsable</span>
                <input value={seguimientoForm.responsable} onChange={event => setSeguimientoForm(current => ({ ...current, responsable: event.target.value }))} />
              </label>
            </div>
            <div className="modal-footer">
              <button className="btn secondary" disabled={seguimientoSaving} onClick={() => cerrarFlujoSeguimiento()}>Cancelar</button>
              <button className="btn primary" disabled={seguimientoSaving} onClick={() => void guardarSeguimiento()}>{seguimientoSaving ? "Guardando…" : "Crear seguimiento"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Editar Promesa */}
      {showModalEditarPromesa && promesaEditando && (
        <div className="modal-overlay" onClick={() => { setShowModalEditarPromesa(false); setPromesaEditando(null); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">Editar Promesa de Pago</div>
            <div className="modal-body">
              <div className="form-group" style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: '600', marginBottom: '4px' }}>Cliente</label>
                <div style={{ padding: '8px', background: 'var(--bg-nav)', borderRadius: '4px', fontWeight: '600' }}>
                  {promesaEditando.razon_social || promesaEditando.cliente}
                </div>
              </div>
              
              <label className="field">
                <span>Fecha Promesa</span>
                <input 
                  type="date" 
                  value={promesaEditando.fecha_promesa || ''} 
                  onChange={e => setPromesaEditando({...promesaEditando, fecha_promesa: e.target.value})}
                />
              </label>
              
              <label className="field">
                <span>Monto Prometido</span>
                <input 
                  type="number" 
                  value={promesaEditando.monto_prometido || ''}
                  onChange={e => setPromesaEditando({...promesaEditando, monto_prometido: Number(e.target.value)})}
                  placeholder="0"
                />
              </label>
              
              <label className="field">
                <span>Monto cumplido (desde importaciones)</span>
                <input 
                  type="number" 
                  value={promesaEditando.monto_pagado || ''} 
                  readOnly
                  placeholder="0"
                />
              </label>
              
              <label className="field">
                <span>Fecha último cumplimiento</span>
                <input 
                  type="date" 
                  value={promesaEditando.fecha_pago || ''} 
                  readOnly
                />
              </label>
              
              <label className="field">
                <span>Estado</span>
                <select 
                  value={promesaEditando.estado || 'PENDIENTE'}
                  onChange={e => setPromesaEditando({...promesaEditando, estado: e.target.value})}
                  style={{width: '100%', fontSize: '0.8rem', padding: '5px 6px'}}
                >
                  <option value="PENDIENTE">⏳ Pendiente</option>
                  <option value="CUMPLIDA_PARCIAL" disabled>⚠️ Parcialmente Cumplida (automática)</option>
                  <option value="CUMPLIDA" disabled>✅ Cumplida (automática)</option>
                  <option value="INCUMPLIDA">❌ Incumplida</option>
                  <option value="CANCELADA">🚫 Cancelada</option>
                  <option value="REPROGRAMADA">🔄 Reprogramada</option>
                </select>
              </label>
              
              <label className="field">
                <span>Facturas asociadas</span>
                <select
                  multiple
                  value={(promesaEditando.documentos ?? []).map((documento:any) => String(documento.documento_normalizado))}
                  onChange={event => setPromesaEditando({...promesaEditando, documentos: Array.from(event.currentTarget.selectedOptions, option => ({ documento_normalizado: option.value }))})}
                  style={{minHeight:'90px'}}
                >
                  {docs.filter(doc => {
                    const selectedClient = String(promesaEditando.cliente ?? '').trim().toLowerCase();
                    return String(doc.cliente ?? '').trim().toLowerCase() === selectedClient || String(doc.razon_social ?? '').trim().toLowerCase() === selectedClient;
                  }).map(doc => {
                    const key = String(doc.documento_normalizado || doc.documento || '').trim();
                    return key ? <option key={doc.id || key} value={key}>{doc.documento || key} — ${Number(doc.total).toLocaleString()}</option> : null;
                  })}
                </select>
                <small>Selecciona únicamente facturas del cliente. El cambio se valida y guarda como una sola operación.</small>
              </label>

              <label className="field">
                <span>Observación</span>
                <textarea 
                  value={promesaEditando.observacion || ''} 
                  onChange={e => setPromesaEditando({...promesaEditando, observacion: e.target.value})} 
                  rows={3} 
                  placeholder="Detalles, cambios o notas..."
                />
              </label>
              
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', background: 'var(--bg-nav)', padding: '8px', borderRadius: '4px', marginBottom: '12px' }}>
                <strong>ℹ️ Nota:</strong> Cumplimiento calculado desde importaciones. Estos cambios no registran pagos ni afectan el saldo financiero.
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn secondary" onClick={() => { setShowModalEditarPromesa(false); setPromesaEditando(null); }}>Cancelar</button>
              <button className="btn primary" onClick={() => actualizarPromesa(promesaEditando)}>Guardar Cambios</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Empresa */}
      {showModalEmpresa && (
        <div className="modal-overlay" onClick={() => setShowModalEmpresa(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">Datos de Empresa</div>
            <div className="modal-body">
              <label className="field">
                <span>Nombre</span>
                <input value={empresa.nombre} onChange={e => setEmpresa({...empresa, nombre: e.target.value})} />
              </label>
              <label className="field">
                <span>RUC</span>
                <input value={empresa.ruc || ""} onChange={e => setEmpresa({...empresa, ruc: e.target.value})} />
              </label>
              <label className="field">
                <span>Dirección</span>
                <textarea value={empresa.direccion || ""} onChange={e => setEmpresa({...empresa, direccion: e.target.value})} rows={2} />
              </label>
              <label className="field">
                <span>Teléfono</span>
                <input value={empresa.telefono || ""} onChange={e => setEmpresa({...empresa, telefono: e.target.value})} />
              </label>
              <label className="field">
                <span>Email</span>
                <input value={empresa.email || ""} onChange={e => setEmpresa({...empresa, email: e.target.value})} />
              </label>
              <label className="field">
                <span>Usuario responsable de reportes</span>
                <input value={empresa.administrador || ""} onChange={e => setEmpresa({...empresa, administrador: e.target.value})} placeholder="Ej: Lic. Alba Mayorga L." />
              </label>
              <label className="field">
                <span>Meta Mensual $</span>
                <input type="number" value={empresa.meta_mensual ?? ''} onChange={e => setEmpresa({...empresa, meta_mensual: Number(e.target.value)})} />
              </label>
            </div>
            <div className="modal-footer">
              <button className="btn secondary" onClick={() => setShowModalEmpresa(false)}>Cancelar</button>
              <button className="btn primary" onClick={guardarEmpresa}>Guardar</button>
            </div>
          </div>
        </div>
      )}

      <DocumentationModal
        open={showModalDocumentacion}
        onClose={() => setShowModalDocumentacion(false)}
      />

      <ChangeHistoryModal
        open={showModalHistorial}
        onClose={() => setShowModalHistorial(false)}
      />

      <ClearDatabaseModal
        open={showModalLimpiar}
        loading={limpiandoBase}
        onClose={() => setShowModalLimpiar(false)}
        onConfirm={limpiarBaseDatos}
      />
    </div>
  );
}




