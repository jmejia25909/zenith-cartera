import { app, BrowserWindow, ipcMain, dialog, shell, session } from "electron";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, extname } from "node:path";
import { validateExcelStructure } from "./excelStructureValidator";
import { openDb, getDbFilePath } from "./db";
import { computeDashboardExecutiveStats } from "./dashboardExecutive";
import { getManagementReportsSummary } from "./managementReports";
import { getManagementReportDetail } from "./managementReportDetails";
import { importContificoExcel } from "./importContifico";
import { reconcileCollections } from "./collectionReconciliation";
import {
  getCollectionPeriodReconciliation,
  saveCollectionPeriodReconciliation,
} from "./collectionPeriodReconciliation";
import {
  importCancelledDocumentsExcel,
  previewCancelledDocumentsExcel,
} from "./importCancelledDocuments";
import {
  importCreditNotesExcel,
  previewCreditNotesExcel,
} from "./importCreditNotes";
import {
  importCollectionMovementsExcel,
  previewCollectionMovementsExcel,
} from "./importCollectionMovements";
import {
  backfillHistoricalTransactionBatches,
  registerHistoricalTransactionBatch,
} from "./reconciliation/historicalTransactionBatchRegistry";
import {
  createGestion,
  deleteGestion as deleteGestionById,
  fulfillGestion,
  migrateLegacyGestiones,
  updateGestion as updateGestionById,
} from "./repositories/gestionRepository";
import {
  changePromesaState,
  bootstrapLegacyPromises,
  createPromesa,
  getPromesaById,
  listPromesas,
  migrateHistoricalPromises,
  isPromiseLegacyBootstrapClosed,
  reconcilePromises,
  updatePromesaAtomic,
  updatePromesa,
} from "./repositories/promesaRepository";
import { createTareaIpcHandlers } from "./ipc/tareaIpc";
import { createAlertaOperativaIpcHandlers } from "./ipc/alertaOperativaIpc";
import * as XLSX from "xlsx";
import fs from "node:fs";
import { createHash } from "node:crypto";
import http from "node:http";
import os from "node:os";
import { spawn } from "child_process";
/* eslint-disable @typescript-eslint/no-explicit-any */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Exponer __dirname para dependencias CommonJS (ej. ngrok) en entorno ESM
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).__dirname = __dirname;

/*
 * CONTRATO PERMANENTE DE ACTUALIZACIÓN OFFLINE:
 * el rebranding NO cambia la carpeta persistente histórica.
 */
app.setPath(
  "userData",
  join(app.getPath("appData"), "cartera-dashboard"),
);

app.setName("Zenith Cartera");

let mainWindow: BrowserWindow | null = null;
let db: any;
let cloudflaredProcess: any = null;
let ngrokUrl: string = "";
let ngrokListener: any = null;

// Token secreto para identificar que la petición viene de la app desktop
const DESKTOP_TOKEN = `desktop-${Date.now()}-${Math.random().toString(36)}`;

// Constantes para ngrok (acceso remoto)
const NGROK_PORT = 3000;
const NGROK_AUTHTOKEN = process.env.NGROK_AUTHTOKEN || "";

// Verbosidad de logs (por defecto reducido para evitar ruido en terminal)
const VERBOSE_API_LOGS = process.env.VERBOSE_API_LOGS === "1";
const VERBOSE_IP_LOGS = process.env.VERBOSE_IP_LOGS === "1";

// Constantes placeholder para compatibilidad con lógica previa de Cloudflare
const CLOUDFLARE_TUNNEL_URL = "";
const CLOUDFLARE_TUNNEL_NAME = "";

type UpdateMeta = {
  updateCount: number;
  lastVersion: string;
  currentVersion?: string;
  updatedAt?: string;
  firstRunAt?: string;
};

function getUpdateMetaPath(): string {
  return join(app.getPath("userData"), "update-meta.json");
}

function readUpdateMeta(): UpdateMeta {
  const nowIso = new Date().toISOString();
  try {
    const p = getUpdateMetaPath();
    if (!fs.existsSync(p)) {
      return { updateCount: 0, lastVersion: "", firstRunAt: nowIso };
    }
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as UpdateMeta;
    return {
      updateCount: Number.isFinite(parsed.updateCount) ? parsed.updateCount : 0,
      lastVersion: parsed.lastVersion || "",
      currentVersion: parsed.currentVersion,
      updatedAt: parsed.updatedAt,
      firstRunAt: parsed.firstRunAt || nowIso,
    };
  } catch (e) {
    console.warn("No se pudo leer update-meta.json:", e);
    return { updateCount: 0, lastVersion: "", firstRunAt: nowIso };
  }
}

function writeUpdateMeta(meta: UpdateMeta) {
  try {
    fs.writeFileSync(getUpdateMetaPath(), JSON.stringify(meta, null, 2));
  } catch (e) {
    console.warn("No se pudo guardar update-meta.json:", e);
  }
}

function trackUpdateInstall(): UpdateMeta {
  const currentVersion = app.getVersion();
  const nowIso = new Date().toISOString();
  const meta = readUpdateMeta();
  meta.currentVersion = currentVersion;
  if (!meta.firstRunAt) meta.firstRunAt = nowIso;
  if (meta.lastVersion !== currentVersion) {
    meta.updateCount = (meta.updateCount || 0) + 1;
    meta.lastVersion = currentVersion;
    meta.updatedAt = nowIso;
    console.log(`✅ Instalación registrada: v${currentVersion} | Instalación #${meta.updateCount} | ${nowIso}`);
  }
  writeUpdateMeta(meta);
  return meta;
}

function logInstallationEvent(event: string, details?: any) {
  const logDir = join(app.getPath('userData'), 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, 'installation.log');
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${event} | Version: ${app.getVersion()} | ${JSON.stringify(details || {})}`;
  try {
    fs.appendFileSync(logFile, entry + '\n', 'utf-8');
  } catch (e) {
    console.warn('No se pudo escribir en installation.log:', e);
  }
}

// Función para verificar si la petición viene de la aplicación desktop
function isDesktopClient(req: http.IncomingMessage): boolean {
  return req.headers["x-desktop-token"] === DESKTOP_TOKEN;
}

// --- FUNCIONES AUXILIARES (Extraídas para usar en API Web y Desktop) ---

function getEmpresa() {
  try {
    return db.prepare("SELECT * FROM empresa WHERE id = 1").get();
  } catch (e: any) {
    return { nombre: "Mi Empresa" };
  }
}

function getAnalisisRiesgo() {
  try {
    const rows = db.prepare(`
      SELECT 
        cliente, 
        MAX(razon_social) as razon_social,
        COUNT(1) as docs_count,
        COALESCE(SUM(total), 0) as total_deuda,
        COALESCE(SUM(CASE WHEN date(fecha_vencimiento) < date('now', 'localtime') THEN total ELSE 0 END), 0) as deuda_vencida,
        MAX(CAST(julianday(date('now', 'localtime')) - julianday(fecha_vencimiento) AS INTEGER)) as max_dias_mora
      FROM documentos 
      WHERE is_subtotal = 0
      GROUP BY cliente
      HAVING total_deuda > 0.01
      ORDER BY total_deuda DESC
    `).all();

    const analisis = rows.map((r: any) => {
      let score = 100;
      const pctVencida = r.total_deuda > 0 ? (r.deuda_vencida / r.total_deuda) : 0;
      const maxMora = r.max_dias_mora || 0;

      if (pctVencida > 0.05) score -= 10;
      if (pctVencida > 0.30) score -= 15;
      if (pctVencida > 0.70) score -= 20;

      if (maxMora > 5) score -= 5;
      if (maxMora > 30) score -= 15;
      if (maxMora > 60) score -= 20;
      if (maxMora > 90) score -= 30;

      return { ...r, score: Math.max(0, Math.round(score)) };
    });

    const sorted = analisis.sort((a: any, b: any) => a.score - b.score) as Array<Record<string, unknown>>;
    return { ok: true, rows: sorted };
  } catch (e: any) {
    return { ok: false, message: e.message, rows: [] as unknown[] };
  }
}

function getNetworkIp(log: boolean = false) {
  const interfaces = os.networkInterfaces();
  const validIps: { name: string; address: string; priority: number }[] = [];
  
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family === "IPv4" && !iface.internal) {
        // Determinar prioridad: WiFi > Ethernet > VirtualBox > Otros
        let priority = 999;
        const nameLower = name.toLowerCase();
        
        if (nameLower.includes('wi-fi') || nameLower.includes('wifi') || nameLower.includes('wlan')) {
          priority = 1; // Mayor prioridad para WiFi
        } else if (nameLower.includes('ethernet') || nameLower.includes('eth')) {
          priority = 2;
        } else if (nameLower.includes('virtualbox') || nameLower.includes('vmware') || nameLower.includes('vbox')) {
          priority = 100; // Menor prioridad para adaptadores virtuales
        }
        
        validIps.push({ name, address: iface.address, priority });
      }
    }
  }
  
  // Ordenar por prioridad y devolver la primera
  if (validIps.length > 0) {
    validIps.sort((a, b) => a.priority - b.priority);
    if (log || VERBOSE_IP_LOGS) {
      console.log(`📡 IP seleccionada: ${validIps[0].address} (${validIps[0].name})`);
    }
    return validIps[0].address;
  }
  
  return "localhost";
}

// Función para verificar si el túnel de Cloudflare está activo
async function checkCloudflaredTunnel(): Promise<boolean> {
  try {
    const response = await fetch(`${CLOUDFLARE_TUNNEL_URL}/api/stats`, {
      method: "GET",
      timeout: 5000,
    } as any);
    const isHealthy = response.status >= 200 && response.status < 500;
    console.log(`🌐 Tunnel health check: ${isHealthy ? "✓ OK" : "✗ FAILED"} (${response.status})`);
    return isHealthy;
  } catch (error) {
    console.log(`🌐 Tunnel health check failed:`, error);
    return false;
  }
}

// Función para reiniciar el túnel de Cloudflare
async function restartCloudflaredTunnel(): Promise<boolean> {
  try {
    console.log("🌐 Intentando reiniciar túnel de Cloudflare...");
    
    // Path del ejecutable cloudflared
    const cloudflaredPath = "C:\\Users\\j-mej\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\\cloudflared.exe";
    
    // Ejecutar el túnel en background
    cloudflaredProcess = spawn(cloudflaredPath, ["tunnel", "run", CLOUDFLARE_TUNNEL_NAME], {
      detached: true,
      stdio: "ignore",
    });
    
    cloudflaredProcess.unref();
    console.log(`✅ Túnel reiniciado (PID: ${cloudflaredProcess?.pid})`);
    
    // Esperar 5 segundos para que se conecte
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Verificar que esté conectado
    const isHealthy = await checkCloudflaredTunnel();
    if (isHealthy) {
      mainWindow?.webContents.send("tunnel-status", { status: "connected" });
      return true;
    } else {
      console.log("⚠️ Túnel reiniciado pero aún no responde");
      return false;
    }
  } catch (error) {
    console.error("❌ Error reiniciando túnel:", error);
    return false;
  }
}

// Función para iniciar ngrok y obtener URL remota
async function startNgrok(): Promise<string> {
  try {
    const ngrok = await import("@ngrok/ngrok");
    console.log("🌐 Iniciando ngrok para acceso remoto...");
    
    // Configurar authtoken si existe
    if (NGROK_AUTHTOKEN) {
      console.log("🔐 Usando authtoken de ngrok");
    }
    
    // Iniciar listener
    ngrokListener = await ngrok.forward({
      addr: NGROK_PORT,
      authtoken_from_env: true,
    });
    
    const url = ngrokListener.url();
    ngrokUrl = url || "";
    console.log(`✅ ngrok conectado: ${ngrokUrl}`);
    mainWindow?.webContents.send("remote-url-updated", { url: ngrokUrl });
    return ngrokUrl;
  } catch (error) {
    console.error("❌ Error iniciando ngrok:", error);
    return "";
  }
}

// Función para verificar y reiniciar ngrok si es necesario
async function checkAndRefreshNgrok(): Promise<string> {
  try {
    // Probar si la URL actual funciona
    if (ngrokUrl) {
      const response = await fetch(`${ngrokUrl}/api/stats`, {
        timeout: 5000,
      } as any);
      
      if (response.status >= 200 && response.status < 500) {
        console.log(`✅ ngrok sigue activo: ${ngrokUrl}`);
        return ngrokUrl;
      }
    }
    
    // Si no funciona, reiniciar
    console.log("⚠️ ngrok desconectado, reiniciando...");
    if (ngrokListener) {
      await ngrokListener.close();
      ngrokListener = null;
    }
    return await startNgrok();
  } catch (error) {
    console.error("❌ Error verificando ngrok:", error);
    try {
      return await startNgrok();
    } catch (e) {
      return "";
    }
  }
}

function getClienteInfo(codigo: string) {
  try {
    let info = db.prepare("SELECT * FROM clientes WHERE cliente = ?").get(codigo);
    if (!info) {
      const doc = db.prepare("SELECT razon_social, vendedor FROM documentos WHERE cliente = ? LIMIT 1").get(codigo);
      info = { cliente: codigo, razon_social: doc?.razon_social || "", vendedor: doc?.vendedor || "", telefono: "", email: "", direccion: "", contacto: "" };
    }
    return info;
  } catch (e) { return null; }
}

function listGestiones(cliente: string) {
  try {
    if (!cliente) {
      // Si no se especifica cliente, devolver TODAS las gestiones (no solo promesas)
      // Ordenadas por fecha más reciente primero
      return db.prepare(`
        SELECT 
          g.id, g.cliente, g.fecha, g.tipo, g.resultado, g.observacion, g.fecha_promesa, g.monto_promesa,
          COALESCE((SELECT d.razon_social FROM documentos d WHERE d.cliente = g.cliente LIMIT 1), g.cliente) as razon_social 
        FROM gestiones g
        ORDER BY 
          g.fecha DESC
        LIMIT 5000
      `).all();
    }
    // Para cliente específico: devolver sus gestiones ordenadas por fecha reciente
    return db.prepare("SELECT * FROM gestiones WHERE cliente = ? ORDER BY fecha DESC LIMIT 1000").all(cliente);
  } catch (e: any) { 
    console.error("Error obteniendo gestiones:", e.message);
    return []; 
  }
}

function getLocalGestionsPath(): string {
  return join(app.getPath("userData"), "gestiones-locales.json");
}

function loadLocalGestiones(): any[] {
  try {
    const path = getLocalGestionsPath();
    if (fs.existsSync(path)) {
      const data = fs.readFileSync(path, "utf-8");
      return JSON.parse(data) || [];
    }
  } catch (e) {
    console.error("Error cargando gestiones locales:", e);
  }
  return [];
}

function saveLocalGestiones(gestiones: any[]): void {
  try {
    const path = getLocalGestionsPath();
    fs.writeFileSync(path, JSON.stringify(gestiones, null, 2), "utf-8");
  } catch (e) {
    console.error("Error guardando gestiones locales:", e);
  }
}

function listGestionesCombinadas(cliente: string): any[] {
  try {
    // Obtener gestiones de BD
    let dbGestiones: any[] = [];
    if (!cliente) {
      dbGestiones = db.prepare(`
        SELECT g.id, g.cliente, g.fecha, g.tipo, g.resultado, g.observacion, g.fecha_promesa, g.monto_promesa,
          COALESCE((SELECT d.razon_social FROM documentos d WHERE d.cliente = g.cliente LIMIT 1), g.cliente) as razon_social 
        FROM gestiones g
        ORDER BY g.fecha DESC
        LIMIT 5000
      `).all();
    } else {
      dbGestiones = db.prepare("SELECT * FROM gestiones WHERE cliente = ? ORDER BY fecha DESC LIMIT 1000").all(cliente);
    }
    
    // Obtener gestiones locales
    let localGestiones = loadLocalGestiones();
    
    // Filtrar por cliente si es necesario
    if (cliente) {
      localGestiones = localGestiones.filter((g: any) => g.cliente === cliente);
    }
    
    // Combinar y deduplicar
    const deduped = [...dbGestiones];
    for (const local of localGestiones) {
      const isDuplicate = dbGestiones.some((bg: any) => {
        const sameClient = bg.cliente === local.cliente;
        const sameType = bg.tipo === local.tipo;
        const sameObs = bg.observacion === local.observacion;
        try {
          if (local.fecha && bg.fecha) {
            const localTime = new Date(local.fecha).getTime();
            const bgTime = new Date(bg.fecha).getTime();
            if (!isNaN(localTime) && !isNaN(bgTime)) {
              return sameClient && sameType && sameObs && Math.abs(localTime - bgTime) < 10000;
            }
          }
        } catch (e) {
          // ignore
        }
        return false;
      });
      
      if (!isDuplicate) {
        deduped.push(local);
      }
    }
    
    // Ordenar por fecha descendente
    return deduped.sort((a: any, b: any) => {
      const dateA = new Date(a.fecha || 0).getTime();
      const dateB = new Date(b.fecha || 0).getTime();
      return dateB - dateA;
    });
  } catch (e: any) {
    console.error("Error en listGestionesCombinadas:", e.message);
    return [];
  }
}

function getGestionesReporte(args?: { desde?: string, hasta?: string }) {
  try {
    const where: string[] = [];
    const params: any = {};

    if (args?.desde) {
      where.push("date(g.fecha) >= date(@desde)");
      params.desde = args.desde;
    }
    if (args?.hasta) {
      where.push("date(g.fecha) <= date(@hasta)");
      params.hasta = args.hasta;
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    return db.prepare(`
      SELECT 
        g.*,
        COALESCE(c.razon_social, g.cliente) as razon_social
      FROM gestiones g
      LEFT JOIN clientes c ON g.cliente = c.cliente
      ${whereClause}
      ORDER BY g.fecha DESC
      LIMIT 2000
    `).all(params);
  } catch (e: any) {
    return [];
  }
}

// --- SERVIDOR WEB LOCAL ---
function startWebServer() {
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-desktop-token");
    
    // Manejar preflight requests
    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }
    
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const isDesktop = isDesktopClient(req);
    
    // 1. API Endpoints
    if (url.pathname.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json");
      
      // Operaciones que requieren permisos de escritura (solo desktop)
      const writeOperations = [
        "/api/importar",
        "/api/limpiar",
        "/api/empresa/guardar",
        "/api/cliente/guardar",
        "/api/gestion/guardar",
        "/api/gestion/eliminar",
        "/api/gestion/cumplir",
        "/api/campana/guardar",
        "/api/campana/eliminar",
        "/api/disputa/crear",
        "/api/cuenta-aplicar/crear",
        "/api/cuenta-aplicar/actualizar",
        "/api/gestiones-locales/guardar"
      ];
      
      // Verificar permisos para operaciones de escritura
      if (writeOperations.some(op => url.pathname.startsWith(op)) && !isDesktop) {
        res.writeHead(403);
        res.end(JSON.stringify({ 
          ok: false, 
          message: "⚠️ Operación no permitida. Solo la aplicación de escritorio puede hacer cambios."
        }));
        return;
      }
      
      // Manejar POST para gestiones locales
      if (req.method === "POST" && url.pathname === "/api/gestiones-locales/guardar") {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          try {
            const gestiones = JSON.parse(body);
            saveLocalGestiones(gestiones);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, message: "Gestiones guardadas correctamente" }));
          } catch (e: any) {
            res.writeHead(400);
            res.end(JSON.stringify({ ok: false, message: e.message }));
          }
        });
        return;
      }
      
      try {
        let data: any = { ok: false, message: "Ruta no encontrada" };

        if (VERBOSE_API_LOGS) {
          console.log(`📥 [${url.pathname}] Request desde ${isDesktop ? 'Desktop' : 'Web'}`);
        }

        if (url.pathname === "/api/config") {
          // Endpoint para obtener configuración (IP local, etc)
          const localIp = getNetworkIp();
          data = { 
            ok: true, 
            remoteUrl: `http://${localIp}:${NGROK_PORT}`,
            localIp,
            port: NGROK_PORT
          };
        }
        else if (url.pathname === "/api/stats") data = computeStats();
        else if (url.pathname === "/api/dashboard-executive") {
          const yearValue = url.searchParams.get("year");
          const monthValue = url.searchParams.get("month");

          data = computeDashboardExecutiveStats(
            db,
            new Date(),
            {
              year: yearValue
                ? Number(yearValue)
                : undefined,
              month:
                monthValue === "all"
                  ? null
                  : monthValue
                    ? Number(monthValue)
                    : undefined,
            },
          );
        }
        else if (url.pathname === "/api/filtros") data = listFiltros();
        else if (url.pathname === "/api/empresa") data = getEmpresa();
        else if (url.pathname === "/api/top-clientes") data = topClientes(Number(url.searchParams.get("limit")) || 10);
        else if (url.pathname === "/api/analisis") data = getAnalisisRiesgo();
        else if (url.pathname === "/api/cliente-info") data = getClienteInfo(url.searchParams.get("id") || "");
        else if (url.pathname === "/api/gestiones") data = listGestionesCombinadas(url.searchParams.get("cliente") || "");
        else if (url.pathname === "/api/gestiones-reporte") data = getGestionesReporte({ desde: url.searchParams.get("desde") || undefined, hasta: url.searchParams.get("hasta") || undefined });
        else if (url.pathname === "/api/documentos") {
          data = { ok: true, rows: listarDocumentos({
            cliente: url.searchParams.get("cliente") || undefined,
            vendedor: url.searchParams.get("vendedor") || undefined,
            tipoDocumento: url.searchParams.get("tipoDocumento") || undefined,
            tipoFecha: (url.searchParams.get("tipoFecha") as any) || "emision",
            desde: url.searchParams.get("desde") || undefined,
            hasta: url.searchParams.get("hasta") || undefined,
            buscar: url.searchParams.get("buscar") || undefined,
            soloVencidos: url.searchParams.get("soloVencidos") === "true",
          })};
        }
        res.writeHead(200);
        res.end(JSON.stringify(data));
      } catch (e: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, message: e.message }));
      }
      return;
    }

    // 2. Archivos Estáticos (Frontend)
    let safePath = url.pathname === "/" ? "/index.html" : url.pathname;
    // Evitar salir del directorio
    if (safePath.includes("..")) safePath = "/index.html";
    
    const distPath = join(__dirname, "../dist");
    if (!fs.existsSync(distPath)) {
      console.log("⚠️  ADVERTENCIA: No se encontró la carpeta 'dist'. Recuerda ejecutar 'npm run build' para que funcione en el celular.");
    }
    const filePath = join(distPath, safePath.startsWith("/") ? safePath.slice(1) : safePath);

    // Tipos MIME correctos (CRUCIAL para que no salga pantalla blanca)
    const mimeTypes: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon"
    };

    const serveFile = (pathToFile: string) => {
      fs.readFile(pathToFile, (err, content) => {
        if (err) {
          // Si no encuentra el archivo (ej. una ruta de React Router), servir index.html
          if (pathToFile !== join(distPath, "index.html")) {
            serveFile(join(distPath, "index.html"));
          } else {
            res.writeHead(404);
            res.end("Not found");
          }
        } else {
          const ext = extname(pathToFile).toLowerCase();
          const contentType = mimeTypes[ext] || "application/octet-stream";
          res.writeHead(200, { "Content-Type": contentType });
          res.end(content);
        }
      });
    };

    serveFile(filePath);
  });

  server.listen(3000, "0.0.0.0", () => {
    const interfaces = os.networkInterfaces();
    const urls: string[] = [];
    Object.keys(interfaces).forEach((ifaceName) => {
      interfaces[ifaceName]?.forEach((iface) => {
        if (iface.family === "IPv4" && !iface.internal) {
          urls.push(`http://${iface.address}:3000`);
        }
      });
    });

    console.log(`--- SERVIDOR WEB LOCAL INICIADO --- ${urls.join(" | ")}`);
    if (VERBOSE_IP_LOGS) {
      urls.forEach(u => console.log(`Acceso disponible en: ${u}`));
    }
    
    // Enviar IP local como URL remota inicial
    const localIp = getNetworkIp();
    if (localIp !== "localhost") {
      mainWindow?.webContents.send("remote-url-updated", { url: `http://${localIp}:3000` });
    }
  });
}


function shouldOpenDevTools() {
  return process.env.OPEN_DEVTOOLS === "1" || process.env.OPEN_DEVTOOLS === "true";
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1000,
    minHeight: 600,
    frame: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    // Intentar cargar icono personalizado
    icon: fs.existsSync(join(app.getPath("userData"), "custom-logo.png"))
      ? join(app.getPath("userData"), "custom-logo.png")
      : app.isPackaged
        ? join(process.resourcesPath, "icon.ico")
        : join(process.cwd(), "build", "icon.ico")
  });

  mainWindow.maximize();
  mainWindow.show();

  const devUrl = process.env.VITE_DEV_SERVER_URL;

  if (devUrl) {
    /*
     * En desarrollo evitamos que Chromium reutilice módulos ESM
     * antiguos después de cambios estructurales/HMR.
     */
    await session.defaultSession.clearCache();

    await mainWindow.loadURL(
      `${devUrl}?renderer=${Date.now()}`,
    );
    if (shouldOpenDevTools()) mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadFile(join(__dirname, "../dist/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function closeDb() {
  try {
    db?.close();
  } catch {
    // ignore
  }
}

function toDateOnlyIso(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function computeStats() {
  const todayIso = toDateOnlyIso(new Date());

  const totalSaldo = Number(
    db.prepare(`SELECT COALESCE(SUM(total), 0) AS v FROM documentos WHERE is_subtotal = 0`).get().v
  );
  const totalCobrado = Number(
    db.prepare(`SELECT COALESCE(SUM(cobros), 0) AS v FROM documentos WHERE is_subtotal = 0`).get().v
  );
  const vencidaSaldo = Number(
    db
      .prepare(
        `SELECT COALESCE(SUM(total), 0) AS v
         FROM documentos
         WHERE is_subtotal = 0
           AND total > 0
           AND date(fecha_vencimiento) < date('now', 'localtime')`
      )
      .get().v
  );

  const mora90Saldo = Number(
    db
      .prepare(
        `SELECT COALESCE(SUM(total), 0) AS v
         FROM documentos
         WHERE is_subtotal = 0
           AND total > 0
           AND date(fecha_vencimiento) < date('now', 'localtime', '-90 day')`
      )
      .get().v
  );

  const mora120Saldo = Number(
    db
      .prepare(
        `SELECT COALESCE(SUM(total), 0) AS v
         FROM documentos
         WHERE is_subtotal = 0
           AND total > 0
           AND date(fecha_vencimiento) < date(?, '-120 day')`
      )
      .get(todayIso).v
  );

  const docsPendientes = Number(
    db
      .prepare(
        `SELECT COUNT(1) AS c
         FROM documentos
         WHERE is_subtotal = 0 AND total > 0`
      )
      .get().c
  );

  const clientesConSaldo = Number(
    db
      .prepare(
        `SELECT COUNT(DISTINCT cliente) AS c
         FROM documentos
         WHERE is_subtotal = 0 AND total > 0 AND cliente IS NOT NULL AND cliente <> ''`
      )
      .get().c
  );

  // Calculamos el Aging dinámicamente comparando fechas (más preciso que guardar valores fijos)
  const aging = db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN (julianday(@today) - julianday(fecha_vencimiento)) <= 0 THEN total ELSE 0 END), 0) AS por_vencer,
        COALESCE(SUM(CASE WHEN (julianday(@today) - julianday(fecha_vencimiento)) > 0 AND (julianday(@today) - julianday(fecha_vencimiento)) <= 30 THEN total ELSE 0 END), 0) AS d30,
        COALESCE(SUM(CASE WHEN (julianday(@today) - julianday(fecha_vencimiento)) > 30 AND (julianday(@today) - julianday(fecha_vencimiento)) <= 60 THEN total ELSE 0 END), 0) AS d60,
        COALESCE(SUM(CASE WHEN (julianday(@today) - julianday(fecha_vencimiento)) > 60 AND (julianday(@today) - julianday(fecha_vencimiento)) <= 90 THEN total ELSE 0 END), 0) AS d90,
        COALESCE(SUM(CASE WHEN (julianday(@today) - julianday(fecha_vencimiento)) > 90 AND (julianday(@today) - julianday(fecha_vencimiento)) <= 120 THEN total ELSE 0 END), 0) AS d120,
        COALESCE(SUM(CASE WHEN (julianday(@today) - julianday(fecha_vencimiento)) > 120 AND (julianday(@today) - julianday(fecha_vencimiento)) <= 150 THEN total ELSE 0 END), 0) AS d150,
        COALESCE(SUM(CASE WHEN (julianday(@today) - julianday(fecha_vencimiento)) > 150 AND (julianday(@today) - julianday(fecha_vencimiento)) <= 180 THEN total ELSE 0 END), 0) AS d180,
        COALESCE(SUM(CASE WHEN (julianday(@today) - julianday(fecha_vencimiento)) > 180 AND (julianday(@today) - julianday(fecha_vencimiento)) <= 210 THEN total ELSE 0 END), 0) AS d210,
        COALESCE(SUM(CASE WHEN (julianday(@today) - julianday(fecha_vencimiento)) > 210 AND (julianday(@today) - julianday(fecha_vencimiento)) <= 240 THEN total ELSE 0 END), 0) AS d240,
        COALESCE(SUM(CASE WHEN (julianday(@today) - julianday(fecha_vencimiento)) > 240 AND (julianday(@today) - julianday(fecha_vencimiento)) <= 270 THEN total ELSE 0 END), 0) AS d270,
        COALESCE(SUM(CASE WHEN (julianday(@today) - julianday(fecha_vencimiento)) > 270 AND (julianday(@today) - julianday(fecha_vencimiento)) <= 300 THEN total ELSE 0 END), 0) AS d300,
        COALESCE(SUM(CASE WHEN (julianday(@today) - julianday(fecha_vencimiento)) > 300 AND (julianday(@today) - julianday(fecha_vencimiento)) <= 330 THEN total ELSE 0 END), 0) AS d330,
        COALESCE(SUM(CASE WHEN (julianday(@today) - julianday(fecha_vencimiento)) > 330 AND (julianday(@today) - julianday(fecha_vencimiento)) <= 360 THEN total ELSE 0 END), 0) AS d360,
        COALESCE(SUM(CASE WHEN (julianday(@today) - julianday(fecha_vencimiento)) > 360 THEN total ELSE 0 END), 0) AS d360p
       FROM documentos
       WHERE is_subtotal = 0`
    )
    .get({ today: todayIso });

  const top10Sum = Number(
    db
      .prepare(
        `SELECT COALESCE(SUM(saldo), 0) AS v
         FROM (
           SELECT cliente, SUM(total) AS saldo
           FROM documentos
           WHERE is_subtotal = 0
           GROUP BY cliente
           ORDER BY saldo DESC
           LIMIT 10
         )`
      )
      .get().v
  );

  const percentVencida = totalSaldo > 0 ? (vencidaSaldo / totalSaldo) * 100 : 0;
  const percentMora90 = totalSaldo > 0 ? (mora90Saldo / totalSaldo) * 100 : 0;
  const percentTop10 = totalSaldo > 0 ? (top10Sum / totalSaldo) * 100 : 0;

  // --- KPIs CRÍTICOS ADICIONALES ---
  // 1. NPL (Non-Performing Loans): % de cartera vencida
  const npl = percentVencida; // Ya lo calculamos arriba

  // 2. DSO (Days Sales Outstanding): días promedio para cobrar
  const totalVentas = Number(
    db.prepare(`SELECT COALESCE(SUM(valor_documento), 0) AS v FROM documentos WHERE is_subtotal = 0`).get().v
  );
  const diasPromedio = totalVentas > 0 ? Math.round((totalSaldo / totalVentas) * 365) : 0;
  const dso = Math.max(0, diasPromedio);

  // 3. Recuperación del mes actual (cobros registrados)
  const inicioMes = `${todayIso.substring(0, 7)}-01`;
  const recuperacionMesActual = Number(
    db.prepare(
      `SELECT COALESCE(SUM(cobros), 0) AS v FROM documentos WHERE is_subtotal = 0 AND date(importado_en) >= date(?)`
    ).get(inicioMes).v
  );

  // 4. Meta mensual (de la tabla empresa)
  const empresa = db.prepare("SELECT * FROM empresa WHERE id = 1").get();
  const metaMensual = empresa?.meta_mensual || 100000; // Default $100k

  // 5. % de cumplimiento de meta
  const percentMetaCumplida = metaMensual > 0 ? Math.min((recuperacionMesActual / metaMensual) * 100, 100) : 0;

  // 6. Tasa de cumplimiento de promesas
  const totalPromesas = Number(
    db.prepare(`SELECT COUNT(1) AS c FROM promesas`).get().c
  );
  const promesasCumplidas = Number(
    db.prepare(`SELECT COUNT(1) AS c FROM promesas WHERE estado = 'CUMPLIDA'`).get().c
  );
  const tasaCumplimientoPromesas = totalPromesas > 0 ? Math.round((promesasCumplidas / totalPromesas) * 100) : 0;

  return {
    fechaCorte: todayIso,
    totalSaldo,
    totalCobrado,
    vencidaSaldo,
    percentVencida,
    mora90Saldo,
    percentMora90,
    mora120Saldo,
    docsPendientes,
    clientesConSaldo,
    aging: {
      porVencer: Number(aging.por_vencer || 0),
      d30: Number(aging.d30 || 0),
      d60: Number(aging.d60 || 0),
      d90: Number(aging.d90 || 0),
      d120: Number(aging.d120 || 0),
      d150: Number(aging.d150 || 0),
      d180: Number(aging.d180 || 0),
      d210: Number(aging.d210 || 0),
      d240: Number(aging.d240 || 0),
      d270: Number(aging.d270 || 0),
      d300: Number(aging.d300 || 0),
      d330: Number(aging.d330 || 0),
      d360: Number(aging.d360 || 0),
      d360p: Number(aging.d360p || 0),
    },
    percentTop10,
    // KPIs Críticos FASE 1
    npl: Math.round(npl * 100) / 100,
    dso,
    recuperacionMesActual,
    metaMensual,
    percentMetaCumplida: Math.round(percentMetaCumplida * 100) / 100,
    tasaCumplimientoPromesas,
  };
}

function listFiltros() {
  const clientes = db
    .prepare(
      `SELECT DISTINCT cliente, razon_social
       FROM documentos
       WHERE is_subtotal = 0 AND cliente IS NOT NULL AND cliente <> ''
       ORDER BY razon_social, cliente`
    )
    .all();
  const vendedores = db
    .prepare(
      `SELECT DISTINCT vendedor AS v
       FROM documentos
       WHERE is_subtotal = 0 AND vendedor IS NOT NULL AND vendedor <> ''
       ORDER BY v`
    )
    .all()
    .map((r: any) => r.v);
  const tipos = db
    .prepare(
      `SELECT DISTINCT tipo_documento AS v
       FROM documentos
       WHERE is_subtotal = 0 AND tipo_documento IS NOT NULL AND tipo_documento <> ''
       ORDER BY v`
    )
    .all()
    .map((r: any) => r.v);

  return { clientes, vendedores, tipos };
}

type ListarArgs = {
  cliente?: string;
  vendedor?: string;
  tipoDocumento?: string;
  tipoFecha?: "emision" | "vencimiento"; // Nuevo parámetro
  desde?: string; // YYYY-MM-DD
  hasta?: string; // YYYY-MM-DD
  buscar?: string;
  soloVencidos?: boolean;
  limit?: number;
  ids?: number[]; // Nuevo filtro por IDs
};

function listarDocumentos(args: ListarArgs) {
  const where: string[] = ["is_subtotal = 0"];
  const params: any[] = [];

  if (args.cliente && args.cliente !== "(Todos)") {
    // Filtramos por Razón Social para evitar problemas con IDs duplicados o S/N
    where.push("razon_social = ?");
    params.push(args.cliente);
  }
  if (args.vendedor && args.vendedor !== "(Todos)") {
    where.push("vendedor = ?");
    params.push(args.vendedor);
  }
  if (args.tipoDocumento && args.tipoDocumento !== "(Todos)") {
    where.push("tipo_documento = ?");
    params.push(args.tipoDocumento);
  }
  
  // Determinamos qué columna de fecha usar (por defecto Emisión)
  const dateCol = args.tipoFecha === "vencimiento" ? "fecha_vencimiento" : "fecha_emision";

  if (args.desde) {
    where.push(`date(${dateCol}) >= date(?)`);
    params.push(args.desde);
  }
  if (args.hasta) {
    where.push(`date(${dateCol}) <= date(?)`);
    params.push(args.hasta);
  }
  if (args.soloVencidos) {
    where.push("date(fecha_vencimiento) < date('now') AND total > 0");
  }
  if (args.buscar && args.buscar.trim()) {
    const s = `%${args.buscar.trim()}%`;
    where.push("(razon_social LIKE ? OR cliente LIKE ? OR documento LIKE ? OR descripcion LIKE ?)");
    params.push(s, s, s, s);
  }
  if (args.ids && args.ids.length > 0) {
    const placeholders = args.ids.map(() => "?").join(",");
    where.push(`id IN (${placeholders})`);
    params.push(...args.ids);
  }

  const limit = Math.min(Math.max(args.limit ?? 2000, 1), 5000);

  const sql = `
    SELECT
      id,
      cliente,
      razon_social,
      tipo_documento,
      documento,
      fecha_emision,
      fecha_vencimiento,
      vendedor,
      descripcion,
      valor_documento,
      retenciones,
      iva,
      cobros,
      total,
      -- Calculamos días vencidos al vuelo: (Hoy - Vencimiento)
      CAST(julianday(date('now', 'localtime')) - julianday(fecha_vencimiento) AS INTEGER) as dias_vencidos
    FROM documentos
    WHERE ${where.join(" AND ")}
    ORDER BY date(fecha_vencimiento) ASC, razon_social ASC, documento ASC
    LIMIT ${limit}
  `;

  return db.prepare(sql).all(...params);
}

function topClientes(limit = 10) {
  const n = Math.min(Math.max(limit, 1), 200);
  return db
    .prepare(
      `SELECT
         cliente,
         MAX(razon_social) AS razon_social,
         SUM(total) AS total,
         SUM(CASE WHEN date(fecha_vencimiento) < date('now', 'localtime') AND total > 0 THEN total ELSE 0 END) AS vencida,
         SUM(CASE WHEN date(fecha_vencimiento) < date('now', 'localtime', '-90 day') AND total > 0 THEN total ELSE 0 END) AS mora90,
         COUNT(1) AS documentos
       FROM documentos
       WHERE is_subtotal = 0
       GROUP BY cliente
       ORDER BY total DESC
       LIMIT ${n}`
    )
    .all();
}

function clientesListar() {
  try {
    // Obtener todos los clientes de la tabla clientes con su información
    const clientes = db.prepare(`
      SELECT 
        c.id,
        c.cliente,
        c.razon_social,
        c.vendedor,
        c.telefono,
        c.email,
        c.direccion,
        c.contacto,
        COALESCE(SUM(d.total), 0) as total_deuda,
        COALESCE(SUM(CASE WHEN date(d.fecha_vencimiento) < date('now', 'localtime') AND d.total > 0 THEN d.total ELSE 0 END), 0) as deuda_vencida,
        COUNT(d.id) as total_documentos,
        MAX(CASE WHEN date(d.fecha_vencimiento) < date('now', 'localtime') THEN CAST(julianday(date('now', 'localtime')) - julianday(d.fecha_vencimiento) AS INTEGER) ELSE 0 END) as max_dias_vencidos
      FROM clientes c
      LEFT JOIN documentos d ON c.cliente = d.cliente AND d.is_subtotal = 0
      GROUP BY c.id, c.cliente, c.razon_social, c.vendedor, c.telefono, c.email, c.direccion, c.contacto
      ORDER BY c.razon_social ASC
    `).all();
    
    return { ok: true, rows: clientes };
  } catch (e: any) {
    console.error("Error en clientesListar:", e);
    return { ok: false, message: e.message, rows: [] as unknown[] };
  }
}

// -----------------------------
// Helpers de Importación
// -----------------------------

// Normalizar texto (quitar tildes y ñ)
const normalize = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// Formatear fecha de Excel a YYYY-MM-DD
const formatDate = (val: any) => {
  if (val instanceof Date) return val.toISOString().split('T')[0];
  const s = String(val || "").trim();
  if (!s) return "";
  // Detectar formato DD/MM/YYYY
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }
  return s;
};

// Helper para parsear números (maneja "1.234,56" y "217,33")
const parseNumber = (val: any): number => {
  if (val == null || val === "") return 0;
  if (typeof val === 'number') return val;
  
  let s = String(val).trim();
  // Limpiar posibles símbolos de moneda
  s = s.replace(/[$\s]/g, '');

  if (s.includes(',') && s.includes('.')) {
    // Caso mixto: detectar cuál es el separador decimal por la posición
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > lastDot) {
      // 1.234,56 -> 1234.56 (Europeo/Latino con miles)
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // 1,234.56 -> 1234.56 (Americano)
      s = s.replace(/,/g, '');
    }
  } else if (s.includes(',')) {
    // Solo coma: asumir decimal (217,33 -> 217.33)
    s = s.replace(',', '.');
  }
  
  const n = Number(s);
  return isNaN(n) ? 0 : n;
};

function _parseExcel(filePath: string, ivaPercent: number) {
  console.log("📄 Leyendo archivo...");
  const fileBuffer = fs.readFileSync(filePath);
  console.log("📚 Parseando workbook...");
  const workbook = XLSX.read(fileBuffer, { type: "buffer", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  console.log("📋 Hoja seleccionada:", sheetName);
  const sheet = workbook.Sheets[sheetName];
  
  console.log("🔄 Convirtiendo a JSON...");
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }) as any[][];
  console.log("📊 Total filas leídas:", rawRows.length);
  if (!rawRows || rawRows.length === 0) return [];

  // AJUSTE: El encabezado comienza en la Fila 5 (índice 4)
  const headerIdx = 4;

  if (!rawRows[headerIdx]) return [];

  const headers = rawRows[headerIdx].map(h => String(h).trim().toLowerCase());
  const dataRows = rawRows.slice(headerIdx + 1);
  const normalizedHeaders = headers.map(normalize);
  console.log("✅ Encabezados detectados:", normalizedHeaders.slice(0, 10), "...");

  // Validación de estructura mínima: abortar si faltan columnas clave.
  const hasHeader = (aliases: string[]) => aliases.some(alias => normalizedHeaders.some(h => h.includes(normalize(alias))));
  const missingHeaders: string[] = [];
  if (!hasHeader(["razon social", "nombre"])) missingHeaders.push("Razón Social / Nombre");
  if (!hasHeader(["documento", "# documento", "numero"])) missingHeaders.push("# Documento");
  if (!hasHeader(["total", "saldo"])) missingHeaders.push("Total / Saldo");
  if (!hasHeader(["vencimiento", "f. vencimiento", "vence"])) missingHeaders.push("Fecha de Vencimiento");

  if (missingHeaders.length > 0) {
    const msg = `Estructura de archivo no reconocida. Faltan columnas obligatorias: ${missingHeaders.join(", ")}. Verifica que el encabezado esté en la fila 5 y que los nombres de columna no se hayan removido o renombrado.`;
    throw new Error(msg);
  }
  console.log("✅ Validación de estructura OK");

  // Validar que el orden de columnas coincida con la importación anterior (si existe)
  const storedHeadersJson = db.prepare("SELECT excel_headers_json FROM empresa WHERE id = 1").get() as any;
  const storedHeaders = storedHeadersJson?.excel_headers_json ? JSON.parse(storedHeadersJson.excel_headers_json) : null;

  if (storedHeaders && Array.isArray(storedHeaders)) {
    // Comparar orden exacto
    if (JSON.stringify(normalizedHeaders) !== JSON.stringify(storedHeaders)) {
      const msg = `Orden de columnas no reconocido. Se esperaba: [${storedHeaders.join(", ")}]. Recibido: [${normalizedHeaders.join(", ")}]. Si cambió la estructura intencionalmente, usa 'Reiniciar estructura Excel' en Config.`;
      throw new Error(msg);
    }
  } else if (normalizedHeaders.length > 0) {
    // Primera importación: guardar la estructura
    try {
      db.prepare("UPDATE empresa SET excel_headers_json = @headers WHERE id = 1").run({ headers: JSON.stringify(normalizedHeaders) });
    } catch (err) {
      console.warn("No se pudo guardar la estructura de encabezados en DB:", err);
    }
  }

  const getVal = (row: any[], keys: string[], exclude: string[] = []) => {
    const idx = normalizedHeaders.findIndex(h => 
      keys.some(k => h.includes(normalize(k))) &&
      !exclude.some(e => h.includes(normalize(e)))
    );
    return (idx >= 0 && row[idx] != null) ? row[idx] : "";
  };

  const documents: any[] = [];

  for (const row of dataRows) {
    // 1. Validaciones básicas de fila
    if (!row || row.length < 2) continue;

    // Columna B: "razon social" (Nombre del cliente)
    const razon_social = String(getVal(row, ['razon social', 'razón social', 'nombre'])).trim();
    
    // Si no hay razón social o es una fila de "SUBTOTAL", saltamos
    if (!razon_social || razon_social.toUpperCase().includes("SUBTOTAL") || razon_social.toUpperCase().includes("TOTAL CLIENTE")) continue;

    // Usamos SIEMPRE la razón social como identificador, ignorando la columna A ("Cliente")
    const cliente = razon_social;

    // Columna D: "# documentos"
    // CORRECCIÓN: Excluir 'tipo' para que no lea la columna C ("Tipo Documento") por error
    const documento = String(getVal(row, ['# documentos', '# documento', 'documento', 'número'], ['tipo'])).trim();
    
    // Si no hay número de documento, es una fila inválida para la base de datos
    if (!documento || documento.toLowerCase() === "null" || documento === "0") continue;

    // 2. Extracción de valores financieros con limpieza extra
    const rawValor = getVal(row, ['valor documento', 'valor']);
    const rawTotal = getVal(row, ['total', 'saldo']);
    const rawRetenciones = getVal(row, ['retenciones', 'retencion']);
    const rawCobros = getVal(row, ['cobros', 'cobro']);
    
    // Si el total es 0 y el valor del documento también, probablemente es una fila informativa
    const total = Number(parseNumber(rawTotal).toFixed(2));
    const valor_documento = Number(parseNumber(rawValor).toFixed(2));
    const retenciones = Number(parseNumber(rawRetenciones).toFixed(2));
    const cobros = Number(parseNumber(rawCobros).toFixed(2));
    
    // VALIDACIÓN EXTRA: Verificar consistencia (Total = Valor - Retenciones - Cobros)
    // Usamos un margen de error de 0.05 para evitar fallos por redondeo de centavos
    const calculoEsperado = Number((valor_documento - retenciones - cobros).toFixed(2));
    if (Math.abs(total - calculoEsperado) > 0.05) {
      console.warn(`⚠️ Descuadre detectado en doc ${documento}: Excel dice ${total}, Cálculo dice ${calculoEsperado}. Se usará el Total del Excel.`);
    }

    if (total === 0 && valor_documento === 0) continue;

    // Cálculo de IVA: Desglosamos del valor_documento (Columna R)
    let iva = 0;
    if (iva === 0 && valor_documento > 0) {
      const base = valor_documento / (1 + (ivaPercent / 100));
      iva = Number((valor_documento - base).toFixed(2));
    }

    documents.push({
      cliente,
      razon_social,
      // Columna C: "tipo documento"
      tipo_documento: String(getVal(row, ['tipo documento', 'tipo doc', 'tipo'])).trim().toUpperCase() || 'FACTURA',
      documento,
      // Columna E: "f. emision"
      fecha_emision: formatDate(getVal(row, ['f. emision', 'f. emisión', 'emisión', 'emision'])),
      // Columna F: "f. vencimiento"
      fecha_vencimiento: formatDate(getVal(row, ['f. vencimiento', 'vencimiento', 'vence'])),
      // Columna G: "vendedor"
      vendedor: String(getVal(row, ['vendedor'])).trim(),
      total,
      valor_documento,
      iva,
      retenciones,
      cobros,
      // Columna Q: "descripcion"
      descripcion: String(getVal(row, ['descripcion', 'descripción', 'detalle'])).trim()
    });
  }
  return documents;
}

function _saveDocumentsToDb(db: any, docs: any[]) {
  // Marca de tiempo para esta importación
  const now = new Date();
  const importTimestamp = now.toISOString().replace('T', ' ').slice(0, 19);

  const checkStmt = db.prepare("SELECT id, total, cobros FROM documentos WHERE documento = @documento AND cliente = @cliente AND tipo_documento = @tipo_documento LIMIT 1");
  const insertAbono = db.prepare(`
    INSERT INTO abonos (documento, total_anterior, total_nuevo, fecha, observacion)
    VALUES (@documento, @total_anterior, @total_nuevo, @fecha, @observacion)
  `);
  const hasPrevDocs = Boolean(db.prepare("SELECT 1 FROM documentos WHERE is_subtotal = 0 LIMIT 1").get());
  
  const insertDoc = db.prepare(`
    INSERT INTO documentos (
      cliente, razon_social, tipo_documento, documento, 
      fecha_emision, fecha_vencimiento, vendedor,
      total, valor_documento, iva, retenciones, cobros, descripcion, is_subtotal,
      importado_en
    ) VALUES (
      @cliente, @razon_social, @tipo_documento, @documento,
      @fecha_emision, @fecha_vencimiento, @vendedor,
      @total, @valor_documento, @iva, @retenciones, @cobros, @descripcion, 0,
      @importado_en
    )
  `);

  // Actualización si hay cambios en valores
  const updateDocValues = db.prepare(`
    UPDATE documentos SET
      razon_social = @razon_social,
      fecha_emision = @fecha_emision,
      fecha_vencimiento = @fecha_vencimiento,
      vendedor = @vendedor,
      total = @total,
      valor_documento = @valor_documento,
      iva = @iva,
      retenciones = @retenciones,
      cobros = @cobros,
      descripcion = @descripcion,
      importado_en = @importado_en
    WHERE id = @id AND (
      COALESCE(razon_social, '') != @razon_social OR
      COALESCE(fecha_emision, '') != @fecha_emision OR
      COALESCE(fecha_vencimiento, '') != @fecha_vencimiento OR
      COALESCE(vendedor, '') != @vendedor OR
      ABS(COALESCE(total, 0) - @total) > 0.005 OR
      ABS(COALESCE(valor_documento, 0) - @valor_documento) > 0.005 OR
      ABS(COALESCE(iva, 0) - @iva) > 0.005 OR
      ABS(COALESCE(retenciones, 0) - @retenciones) > 0.005 OR
      ABS(COALESCE(cobros, 0) - @cobros) > 0.005 OR
      COALESCE(descripcion, '') != @descripcion
    )
  `);

  // Actualización simple de "Visto" (para confirmar que sigue en cartera aunque no cambie el saldo)
  const updateDocSeen = db.prepare(`UPDATE documentos SET importado_en = @importado_en WHERE id = @id`);

  let insertedDocs = 0;
  let updatedDocs = 0;
  let paidDocs = 0;
  const insertedIds: number[] = [];

  const transaction = db.transaction((documents: any[]) => {
    for (const doc of documents) {
      const existing = checkStmt.get({ documento: doc.documento, cliente: doc.cliente, tipo_documento: doc.tipo_documento });
      const docWithTime = { ...doc, importado_en: importTimestamp };

      if (existing) {
        // Intentamos actualizar valores
        const info = updateDocValues.run({ ...docWithTime, id: existing.id });
        if (info.changes > 0) {
          const prevTotal = Number(existing.total ?? 0);
          const prevCobros = Number(existing.cobros ?? 0);
          
          // Calculamos cuánto del cambio de total se debe realmente a un pago
          // y no a un ajuste de retenciones
          const cobrosSubio = doc.cobros > (prevCobros + 0.01);
          const totalBajoReal = doc.total < (prevTotal - 0.01);
          
          if (cobrosSubio || totalBajoReal) {
            // Solo registrar abono si hubo entrada de dinero (cobros subió)
            // o si el total bajó y no fue solo por un aumento de retenciones
            const montoAbono = Math.max(0, (prevTotal - doc.total) + (prevCobros - doc.cobros));
            
            if (montoAbono > 0.01) {
              insertAbono.run({
                documento: doc.documento,
                total_anterior: prevTotal,
                total_nuevo: doc.total,
                fecha: now.toISOString(),
                observacion: cobrosSubio 
                  ? 'Cobro registrado en Contifico' 
                  : 'Abono detectado por disminución de saldo'
              });
            }
          }
          updatedDocs++;
        } else {
          // Si no cambiaron valores, solo actualizamos la fecha de "visto"
          updateDocSeen.run({ importado_en: importTimestamp, id: existing.id });
        }
      } else {
        const info = insertDoc.run(docWithTime);
        insertedIds.push(Number(info.lastInsertRowid));
        insertedDocs++;
        if (!hasPrevDocs && Number(doc.cobros) > 0) {
          insertAbono.run({
            documento: doc.documento,
            total_anterior: Math.max(0, Number(doc.total) + Number(doc.cobros)),
            total_nuevo: Number(doc.total),
            fecha: now.toISOString(),
            observacion: 'Abono detectado por cobros en primera importacion'
          });
        }
      }
    }

    // LÓGICA CLAVE: Si una factura tenía saldo > 0 pero NO vino en este Excel (su importado_en es viejo),
    // significa que ya fue pagada totalmente en Contifico. 
    // NO LA BORRAMOS, solo actualizamos su saldo a 0 y ajustamos los cobros para que cuadre el historial.
    const closeInfo = db.prepare(`
      UPDATE documentos 
      SET 
        total = 0,
        cobros = MAX(0, valor_documento - retenciones)
      WHERE importado_en != @importTimestamp AND total > 0
    `).run({ importTimestamp });
    
    paidDocs = closeInfo.changes;

    if (paidDocs > 0) {
      const paidRows = db.prepare(`
        SELECT documento, total, valor_documento, retenciones
        FROM documentos
        WHERE importado_en != @importTimestamp AND total = 0
      `).all({ importTimestamp }) as Array<{ documento: string; total: number; valor_documento: number; retenciones: number }>;

      for (const row of paidRows) {
        const pago = Math.max(0, Number(row.valor_documento) - Number(row.retenciones));
        if (pago > 0) {
          insertAbono.run({
            documento: row.documento,
            total_anterior: pago,
            total_nuevo: 0,
            fecha: now.toISOString(),
            observacion: 'Cobro Total: Documento ya no aparece en cartera (Cancelado)'
          });
        }
      }
    }
  });

  transaction(docs);

  return { insertedDocs, updatedDocs, insertedIds, paidDocs };
}



type PortfolioSnapshot = {
  documentos: unknown[];
  abonos: unknown[];
  alertasCredito: unknown[];
};

function createPortfolioSnapshot(): PortfolioSnapshot {
  return {
    documentos: db.prepare("SELECT * FROM documentos").all(),
    abonos: db.prepare("SELECT * FROM abonos").all(),
    alertasCredito: db.prepare("SELECT * FROM alertas_credito").all(),
  };
}

function restoreSnapshotTable(
  tableName: "documentos" | "abonos" | "alertas_credito",
  rows: Array<Record<string, unknown>>,
): void {
  db.prepare(`DELETE FROM ${tableName}`).run();

  if (rows.length === 0) return;

  const columns = Object.keys(rows[0]);
  const quoted = columns.map((column) => `"${column.replace(/"/g, '""')}"`);
  const placeholders = columns.map(() => "?").join(", ");

  const insert = db.prepare(
    `INSERT INTO ${tableName} (${quoted.join(", ")}) VALUES (${placeholders})`,
  );

  for (const row of rows) {
    insert.run(...columns.map((column) => row[column] ?? null));
  }
}

function restorePortfolioSnapshot(snapshot: PortfolioSnapshot): void {
  restoreSnapshotTable(
    "documentos",
    snapshot.documentos as Array<Record<string, unknown>>,
  );
  restoreSnapshotTable(
    "abonos",
    snapshot.abonos as Array<Record<string, unknown>>,
  );
  restoreSnapshotTable(
    "alertas_credito",
    snapshot.alertasCredito as Array<Record<string, unknown>>,
  );
}

function hashImportFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function currentReconciliationGeneration(): number {
  const row = db.prepare(`
    SELECT generation
    FROM reconciliation_control
    WHERE id = 1
  `).get() as { generation?: number } | undefined;

  return Number(row?.generation ?? 1);
}

function startPortfolioImport(
  filePath: string,
  fileHash: string,
): number {
  const fileName = filePath.split(/[\\/]/).pop() || "cartera.xlsx";

  const result = db.prepare(`
    INSERT INTO importaciones (
      tipo,
      archivo_nombre,
      archivo_hash,
      estado,
      observacion,
      metadata_json,
      reconciliation_generation
    )
    VALUES (
      'CARTERA',
      ?,
      ?,
      'PROCESANDO',
      'Importación de cartera Contífico',
      '{}',
      ?
    )
  `).run(
    fileName,
    fileHash,
    currentReconciliationGeneration(),
  );

  const importacionId = Number(result.lastInsertRowid);

  const snapshot = createPortfolioSnapshot();

  db.prepare(`
    INSERT INTO importacion_snapshots (
      importacion_id,
      payload_json
    )
    VALUES (?, ?)
  `).run(
    importacionId,
    JSON.stringify(snapshot),
  );

  return importacionId;
}

function finishPortfolioImport(
  importacionId: number,
  result: Record<string, unknown>,
): void {
  const insertedDocs = Number(result.insertedDocs ?? 0);
  const omittedRows = Number(result.omittedRows ?? 0);
  const legacy = Number(result.legacy ?? 0);
  const descuadres = Number(result.descuadresDetectados ?? 0);
  const nuevos = Number(result.nuevos ?? 0);
  const sinCambios = Number(result.sinCambios ?? 0);
  const reducidos = Number(result.reducidos ?? 0);
  const incrementados = Number(result.incrementados ?? 0);
  const desaparecidos = Number(result.desaparecidos ?? 0);
  const eventosGenerados = Number(result.eventosGenerados ?? 0);
  const baseline = Boolean(result.baseline);

  db.prepare(`
    UPDATE importaciones
    SET
      registros_leidos = ?,
      registros_importados = ?,
      registros_ignorados = ?,
      registros_duplicados = 0,
      estado = ?,
      observacion = ?,
      metadata_json = ?
    WHERE id = ?
  `).run(
    insertedDocs + omittedRows + legacy,
    insertedDocs,
    omittedRows + legacy,
    descuadres > 0 ? "COMPLETADA_ADVERTENCIAS" : "COMPLETADA",
    `Cartera ${baseline ? "BASELINE" : "INCREMENTAL"}: ` +
      `${nuevos} nuevos, ${sinCambios} sin cambios, ` +
      `${reducidos} reducidos, ${incrementados} incrementados, ` +
      `${desaparecidos} desaparecidos, ${legacy} legacy; ` +
      `${eventosGenerados} eventos.`,
    JSON.stringify({
      ...result,
      cutoffDate: "2024-01-01",
      operationStartDate: "2024-02-01",
      reconciliationGeneration: currentReconciliationGeneration(),
    }),
    importacionId,
  );
}

function failPortfolioImport(
  importacionId: number,
  message: string,
): void {
  db.prepare(`
    UPDATE importaciones
    SET
      estado = 'ERROR',
      observacion = ?
    WHERE id = ?
  `).run(message, importacionId);
}

// --- Centro de Importaciones ---
type ImportType =
  | "CARTERA"
  | "ANULADOS"
  | "NOTAS_CREDITO"
  | "COBROS_MOVIMIENTOS";

function listImportHistory(args?: {
  tipo?: ImportType;
  limit?: number;
}) {
  const limit = Math.min(
    Math.max(Number(args?.limit ?? 100), 1),
    500,
  );

  if (args?.tipo) {
    return db
      .prepare(
        [
          "SELECT *",
          "FROM importaciones",
          "WHERE tipo = ?",
          "ORDER BY datetime(importado_en) DESC, id DESC",
          "LIMIT ?",
        ].join(" "),
      )
      .all(args.tipo, limit);
  }

  return db
    .prepare(
      [
        "SELECT *",
        "FROM importaciones",
        "ORDER BY datetime(importado_en) DESC, id DESC",
        "LIMIT ?",
      ].join(" "),
    )
    .all(limit);
}

function getImportById(id: number) {
  return db
    .prepare("SELECT * FROM importaciones WHERE id = ?")
    .get(id);
}

function requestImportReversal(
  id: number,
  observacion = "",
) {
  const current = getImportById(id) as any;

  if (!current) {
    return {
      ok: false,
      message: "La importación no existe.",
    };
  }

  if (current.estado === "REVERTIDA") {
    return {
      ok: false,
      message: "La importación ya se encuentra revertida.",
    };
  }

  if (current.tipo !== "CARTERA") {
    return {
      ok: false,
      code: "REVERSAL_NOT_IMPLEMENTED",
      message:
        "La reversión transaccional todavía no está habilitada para este tipo de importación.",
    };
  }

  const later = db.prepare(`
    SELECT COUNT(*) AS total
    FROM importaciones
    WHERE tipo = 'CARTERA'
      AND estado NOT IN ('REVERTIDA', 'ERROR')
      AND id > ?
  `).get(id) as { total: number };

  if (Number(later.total) > 0) {
    return {
      ok: false,
      code: "LATER_IMPORTS_EXIST",
      message:
        "No se puede revertir esta importación porque existen importaciones de cartera posteriores activas. Revierte primero la más reciente.",
    };
  }

  const snapshotRow = db.prepare(`
    SELECT payload_json
    FROM importacion_snapshots
    WHERE importacion_id = ?
  `).get(id) as { payload_json?: string } | undefined;

  if (!snapshotRow?.payload_json) {
    return {
      ok: false,
      code: "SNAPSHOT_NOT_FOUND",
      message:
        "La importación no tiene un snapshot reversible asociado.",
    };
  }

  const snapshot = JSON.parse(
    snapshotRow.payload_json,
  ) as PortfolioSnapshot;

  const tx = db.transaction(() => {
    // PACK 038: los eventos/saldos del corte revertido pertenecen a esta
    // importación y deben retirarse junto con la proyección restaurada.
    db.prepare("DELETE FROM documento_eventos WHERE importacion_id = ?").run(id);
    db.prepare("DELETE FROM documento_saldos WHERE importacion_id = ?").run(id);

    restorePortfolioSnapshot(snapshot);

    db.prepare(`
      UPDATE importaciones
      SET
        estado = 'REVERTIDA',
        revertido_en = datetime('now', 'localtime'),
        observacion = CASE
          WHEN TRIM(COALESCE(observacion, '')) = '' THEN ?
          ELSE observacion || ' | ' || ?
        END
      WHERE id = ?
    `).run(
      observacion || "Importación revertida",
      observacion || "Importación revertida",
      id,
    );
  });

  tx();

  return {
    ok: true,
    message:
      "Importación de cartera revertida correctamente. Se restauraron documentos, movimientos inferidos y alertas al estado previo.",
  };
}
ipcMain.handle(
  "importHistoryList",
  (
    _event,
    args?: {
      tipo?: ImportType;
      limit?: number;
    },
  ) => {
    try {
      return {
        ok: true,
        rows: listImportHistory(args),
      };
    } catch (error: unknown) {
      return {
        ok: false,
        rows: [],
        message:
          error instanceof Error
            ? error.message
            : "No se pudo consultar el historial.",
      };
    }
  },
);

ipcMain.handle(
  "importHistoryGet",
  (_event, id: number) => {
    try {
      const row = getImportById(Number(id));

      return row
        ? { ok: true, row }
        : {
            ok: false,
            message: "La importación no existe.",
          };
    } catch (error: unknown) {
      return {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "No se pudo consultar la importación.",
      };
    }
  },
);

ipcMain.handle(
  "importHistoryRevert",
  (
    _event,
    args: {
      id: number;
      observacion?: string;
    },
  ) => {
    try {
      return requestImportReversal(
        Number(args?.id),
        args?.observacion ?? "",
      );
    } catch (error: unknown) {
      return {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "No se pudo revertir la importación.",
      };
    }
  },
);

// -----------------------------
// Electron lifecycle
// -----------------------------
app.whenReady().then(async () => {
  // Inicializar DB cuando la app esté lista
  const dbInstance = openDb();
  db = dbInstance.db;
  migrateHistoricalPromises(db);

  try {
    const backfilled = backfillHistoricalTransactionBatches(db);
    if (backfilled > 0) {
      console.log(`[PACK045-FIX004] Batches históricos verificados/backfill: ${backfilled}`);
    }
  } catch (error) {
    console.error("[PACK045-FIX004] Error verificando batches históricos:", error);
  }

  // Registrar conteo de actualizaciones por version
  const updateMeta = trackUpdateInstall();
  logInstallationEvent('APP_START', { updateCount: updateMeta.updateCount, version: app.getVersion() });

  // MIGRACIÓN AUTOMÁTICA: Asegurar que existe la columna 'tema'
  try {
    const cols = db.prepare("PRAGMA table_info(empresa)").all();
    if (!cols.find((c: any) => c.name === 'tema')) {
      db.prepare("ALTER TABLE empresa ADD COLUMN tema TEXT DEFAULT 'claro'").run();
    }
  } catch (e) { console.error("Error verificando columna tema:", e); }

  // INICIAR SERVIDOR WEB
  startWebServer();

  await createWindow();

  // ngrok deshabilitado (requiere cuenta verificada con authtoken)
  // Para acceso remoto, usa la IP local mostrada en la consola
  console.log("ℹ️  ngrok deshabilitado. Usa la IP local para acceso remoto en tu red WiFi.");

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  closeDb();
  if (process.platform !== "darwin") {
    // Limpiar procesos antes de cerrar
    cleanupProcesses();
    app.quit();
  }
});

// Manejador para antes de cerrar la aplicación (en Windows)
app.on("before-quit", () => {
  cleanupProcesses();
});

// Función para limpiar todos los procesos secundarios
function cleanupProcesses() {
  try {
    console.log("🧹 Iniciando limpieza de procesos...");
    
    // Cerrar ngrok listener de forma segura
    if (ngrokListener && typeof ngrokListener.close === 'function') {
      try {
        ngrokListener.close();
        console.log("✅ Listener de ngrok cerrado");
      } catch (e) {
        console.warn("⚠️ Error al cerrar listener de ngrok:", e);
      }
      ngrokListener = null;
    }
    
    // Cerrar proceso de cloudflare si existe
    if (cloudflaredProcess) {
      try {
        if (os.platform() === 'win32') {
          spawn("taskkill", ["/pid", cloudflaredProcess.pid, "/f", "/t"]);
        } else {
          cloudflaredProcess.kill('SIGTERM');
        }
        console.log("✅ Proceso de Cloudflare finalizado");
      } catch (e) {
        console.warn("⚠️ No se pudo matar el proceso de Cloudflare:", e);
      }
      cloudflaredProcess = null;
    }
    
    console.log("✨ Limpieza completada con éxito");
  } catch (e) {
    console.error("❌ Error crítico en limpieza de procesos:", e);
  }
}

// -----------------------------
// IPC
// -----------------------------
ipcMain.handle("ping", async () => ({ ok: true }));
ipcMain.handle("getDbPath", async () => getDbFilePath());

// Obtener el token de la aplicación desktop
ipcMain.handle("getDesktopToken", async () => DESKTOP_TOKEN);

// Verificar si tiene permisos de escritura (siempre true en desktop)
ipcMain.handle("hasWritePermissions", async () => true);

ipcMain.handle("statsObtener", async () => {
  return computeStats();
});

ipcMain.handle(
  "dashboardExecutiveStats",
  async (_evt, filters) => {
    return computeDashboardExecutiveStats(
      db,
      new Date(),
      filters || {},
    );
  },
);

ipcMain.handle(
  "managementReportsSummary",
  async (_evt, filters) => {
    return getManagementReportsSummary(
      db,
      filters,
    );
  },
);

ipcMain.handle(
  "managementReportDetail",
  async (_evt, request) => {
    return getManagementReportDetail(
      db,
      request,
    );
  },
);

ipcMain.handle("filtrosListar", async () => {
  return listFiltros();
});

ipcMain.handle("topClientes", async (_evt, limit?: number) => {
  return topClientes(limit ?? 10);
});

ipcMain.handle("documentosListar", async (_evt, args: ListarArgs) => {
  try {
    const rows = listarDocumentos(args || {});
    return { ok: true, rows };
  } catch (e: any) {
    return { ok: false, message: e?.message || String(e), rows: [] };
  }
});

ipcMain.handle("generarPDF", async (_evt, filename) => {
  if (!mainWindow) return { ok: false, message: "Ventana no encontrada" };
  try {
    // Genera el PDF usando los estilos CSS de @media print
    const pdfData = await mainWindow.webContents.printToPDF({
      printBackground: true,
      pageSize: "A4",
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } // Márgenes en pulgadas aprox
    });
    
    const downloadPath = app.getPath("downloads");
    const safeName = (filename || "documento").replace(/[^a-z0-9]/gi, '_');
    const fullPath = join(downloadPath, `${safeName}.pdf`);
    
    fs.writeFileSync(fullPath, pdfData);
    
    // Abre la carpeta y selecciona el archivo para facilitar el adjuntado
    shell.showItemInFolder(fullPath);
    
    return { ok: true, path: fullPath };
  } catch (e: any) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle("actualizarDiasCredito", async (_evt, { id, dias }) => {
  try {
    // SQLite permite sumar días directamente a una fecha: date(fecha, '+X days')
    const stmt = db.prepare("UPDATE documentos SET fecha_vencimiento = date(fecha_emision, '+' || @dias || ' days') WHERE id = @id");
    stmt.run({ id, dias });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle("empresaObtener", async () => {
  return getEmpresa();
});

ipcMain.handle("empresaGuardar", async (_evt, data) => {
  // Obtenemos datos actuales para asegurar que no falten campos al hacer merge
  const current = db.prepare("SELECT * FROM empresa WHERE id = 1").get();
  const finalData = { ...current, ...data };

  const stmt = db.prepare(`
    UPDATE empresa 
    SET nombre = @nombre, direccion = @direccion, telefono = @telefono, 
        email = @email, ruc = @ruc, administrador = @administrador, 
        iva_percent = @iva_percent,
        meta_mensual = @meta_mensual,
        tema = @tema
    WHERE id = 1
  `);
  stmt.run(finalData);
  return { ok: true };
});

ipcMain.handle("exportarBackup", async () => {
  try {
    const dbPath = getDbFilePath();
    const { filePath } = await dialog.showSaveDialog({
      title: "Guardar Respaldo de Base de Datos",
      defaultPath: `cartera-backup-${new Date().toISOString().split('T')[0]}.db`,
      filters: [{ name: "SQLite Database", extensions: ["db"] }]
    });

    if (filePath) {
      fs.copyFileSync(dbPath, filePath);
      return { ok: true, path: filePath };
    }
    return { ok: false, message: "Cancelado por el usuario" };
  } catch (e: any) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle("cambiarLogo", async () => {
  if (!mainWindow) return { ok: false, message: "Ventana no encontrada" };
  
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Seleccionar Logotipo",
      properties: ["openFile"],
      filters: [
        { name: "Imágenes", extensions: ["png", "jpg", "jpeg", "svg", "webp"] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, message: "Cancelado" };
    }

    const filePath = result.filePaths[0];
    const imageBuffer = fs.readFileSync(filePath);
    const ext = extname(filePath).toLowerCase();
    const mimeType = ext === '.svg' ? 'svg+xml' : (ext === '.jpg' || ext === '.jpeg') ? 'jpeg' : ext.slice(1);
    const base64Image = `data:image/${mimeType};base64,${imageBuffer.toString("base64")}`;

    db.prepare("UPDATE empresa SET logo = @logo WHERE id = 1").run({ logo: base64Image });
    return { ok: true, logo: base64Image };
  } catch (e: any) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle("reiniciarEstructuraExcel", async () => {
  try {
    db.prepare("UPDATE empresa SET excel_headers_json = '' WHERE id = 1").run();
    return { ok: true, message: "Estructura de Excel reiniciada. La próxima importación definirá una nueva estructura." };
  } catch (e: any) {
    return { ok: false, message: e.message };
  }
});


ipcMain.handle("limpiarBaseDatos", async () => {
  try {
    const tx = db.transaction(() => {
      // Ordenado de tablas dependientes a tablas padre. Si una tabla aun no
      // existe en una instalacion antigua, simplemente se omite.
      const tables = [
        "documento_eventos",
        "documento_saldos",
        "cobros_movimientos_importados",
        "notas_credito_importadas",
        "importacion_snapshots",
        "documentos_anulados_log",
        "promesa_cobro_atribuciones",
        "promesa_eventos",
        "promesa_documentos",
        "promesa_legacy_migrations",
        "promesas",
        "gestion_legacy_migrations",
        "gestiones",
        "disputas",
        "cuentas_aplicar",
        "conciliaciones_cobros",
        "abonos",
        "campana_clientes",
        "campanas",
        "documentos",
        "clientes",
        "importaciones",
      ];

      const exists = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
      );

      for (const table of tables) {
        if (exists.get(table)) db.exec(`DELETE FROM ${table}`);
      }

      db.prepare("UPDATE empresa SET excel_headers_json = '' WHERE id = 1").run();
    });
    tx();

    db.pragma("optimize");
    db.exec("VACUUM");

    return {
      ok: true,
      message: `Base de pruebas completamente limpia: ${getDbFilePath()}`,
    };
  } catch (e: any) {
    console.error("Error limpiando BD:", e);
    return { ok: false, message: e.message };
  }
});


ipcMain.handle("resetReconciliationProjection", async () => {
  try {
    const tx = db.transaction(() => {
      const current = currentReconciliationGeneration();
      const nextGeneration = current + 1;

      // Solo proyecciones reconstruibles. Se preservan raw ledgers,
      // historial de importaciones, snapshots, eventos, NC, cobros y anulados.
      db.prepare("DELETE FROM documentos").run();
      db.prepare("DELETE FROM alertas_credito").run();

      db.prepare(`
        UPDATE reconciliation_control
        SET generation = ?,
            mode = 'TEST',
            actualizado_en = datetime('now','localtime')
        WHERE id = 1
      `).run(nextGeneration);
    });

    tx();

    const state = db.prepare(`
      SELECT
        cutoff_date,
        operation_start_date,
        mode,
        generation
      FROM reconciliation_control
      WHERE id = 1
    `).get();

    return {
      ok: true,
      state,
      message:
        "Proyección reiniciada de forma controlada. " +
        "Los raw ledgers e historial fueron preservados. " +
        "La próxima Cartera será el BASELINE de una nueva generación.",
    };
  } catch (error: unknown) {
    console.error("Error reiniciando proyección:", error);
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Error desconocido reiniciando la proyección.",
    };
  }
});

ipcMain.handle("historicalBootstrapStart", () => {
  return { ok: false, message: "Cartera Contífico es LIVE_OUTSTANDING_SNAPSHOT y usa automáticamente la fecha real de ingesta; no requiere preparar un corte histórico." };
});

ipcMain.handle("historicalBootstrapFinish", () => {
  try {
    db.prepare(`UPDATE reconciliation_control SET mode='PRODUCTION', next_snapshot_date=NULL, actualizado_en=datetime('now','localtime') WHERE id=1`).run();
    return { ok: true, state: db.prepare(`SELECT cutoff_date, operation_start_date, mode, generation, next_snapshot_date FROM reconciliation_control WHERE id=1`).get(), message: "Carga histórica cerrada. Motor en modo PRODUCTION." };
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : "Error cerrando carga histórica." };
  }
});

ipcMain.handle("historicalBootstrapReset", () => {
  try {
    const tx = db.transaction(() => {
      const current = currentReconciliationGeneration();
      const nextGeneration = current + 1;
      const tables = [
        "promesa_cobro_atribuciones", "cartera_snapshot_documentos", "cartera_snapshots", "documento_eventos",
        "documento_saldos", "cobros_movimientos_importados", "notas_credito_importadas",
        "importacion_snapshots", "documentos_anulados_log", "conciliaciones_cobros",
        "abonos", "alertas_credito", "documentos", "clientes", "importaciones", "historical_bootstrap_batches"
      ];
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1");
      for (const table of tables) if (exists.get(table)) db.exec(`DELETE FROM ${table}`);
      db.prepare(`UPDATE reconciliation_control SET generation=?, mode='HISTORICAL_LOAD', next_snapshot_date=NULL, actualizado_en=datetime('now','localtime') WHERE id=1`).run(nextGeneration);
    });
    tx();
    return { ok: true, state: db.prepare(`SELECT cutoff_date, operation_start_date, mode, generation, next_snapshot_date FROM reconciliation_control WHERE id=1`).get(), message: "Bootstrap histórico reiniciado. Ledgers y proyecciones de prueba eliminados; esquema y configuración preservados." };
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : "Error reiniciando bootstrap histórico." };
  }
});

ipcMain.handle("reconciliationControlGet", () => {
  return {
    ok: true,
    state: db.prepare(`
      SELECT
        cutoff_date,
        operation_start_date,
        mode,
        generation,
        next_snapshot_date
      FROM reconciliation_control
      WHERE id = 1
    `).get(),
  };
});

ipcMain.handle("clientesAnalisis", async () => {
  return getAnalisisRiesgo();
});

ipcMain.handle("clienteObtenerInfo", (_evt, codigoCliente) => {
  return getClienteInfo(codigoCliente);
});

ipcMain.handle("clienteGuardarInfo", (_evt, data) => {
  const exists = db.prepare("SELECT 1 FROM clientes WHERE cliente = ?").get(data.cliente);
  if (exists) {
    db.prepare("UPDATE clientes SET telefono=@telefono, email=@email, direccion=@direccion, contacto=@contacto WHERE cliente=@cliente").run(data);
  } else {
    db.prepare("INSERT INTO clientes (cliente, razon_social, vendedor, telefono, email, direccion, contacto) VALUES (@cliente, @razon_social, @vendedor, @telefono, @email, @direccion, @contacto)").run(data);
  }
  return { ok: true };
});

ipcMain.handle("gestionGuardar", (_evt, data) => {
  return db.transaction(() => {
    const gestion = createGestion(db, data);
    if (data?.resultado === "Promesa de Pago") {
      const promiseResult = createPromesa(db, {
        cliente: gestion.cliente,
        gestion_id: gestion.id,
        fecha_promesa: data.fecha_promesa,
        monto_prometido: Number(data.monto_promesa),
        observacion: data.observacion,
        documentos: Array.isArray(data.promesa_documentos) ? data.promesa_documentos : [],
      });
      if (promiseResult.ok === false) throw new Error(promiseResult.message);
    }
    return { ok: true, gestion };
  })();
});

const tareaIpc = createTareaIpcHandlers(db);
ipcMain.handle("tareaCrear", (_evt, payload) => tareaIpc.tareaCrear(payload));
ipcMain.handle("tareaObtener", (_evt, id) => tareaIpc.tareaObtener(id));
ipcMain.handle("tareasListar", (_evt, payload) => tareaIpc.tareasListar(payload));
ipcMain.handle("tareaEditar", (_evt, payload) => tareaIpc.tareaEditar(payload));
ipcMain.handle("tareaCambiarEstado", (_evt, payload) => tareaIpc.tareaCambiarEstado(payload));
ipcMain.handle("tareaCompletar", (_evt, payload) => tareaIpc.tareaCompletar(payload));
ipcMain.handle("tareaCancelar", (_evt, payload) => tareaIpc.tareaCancelar(payload));
ipcMain.handle("tareaEventosListar", (_evt, payload) => tareaIpc.tareaEventosListar(payload));
const alertaOperativaIpc = createAlertaOperativaIpcHandlers(db);
ipcMain.handle("alertasOperativasListar", (_evt, payload) => alertaOperativaIpc.alertasOperativasListar(payload));
ipcMain.handle("alertasOperativasResumen", (_evt, payload) => alertaOperativaIpc.alertasOperativasResumen(payload));

ipcMain.handle("gestionesListar", (_evt, cliente) => {
  return listGestiones(cliente);
});

ipcMain.handle("gestionEditar", (_evt, { id, ...data }) => {
  return updateGestionById(db, id, data);
});

ipcMain.handle("gestionEliminar", (_evt, id) => {
  return deleteGestionById(db, id);
});

ipcMain.handle("gestionCumplir", (_evt, id) => {
  return fulfillGestion(db, id);
});

ipcMain.handle("gestionesLegacyMigrar", (_evt, payload) => {
  return migrateLegacyGestiones(
    db,
    payload?.source || "localStorage:cartera_gestiones_locales",
    Array.isArray(payload?.records) ? payload.records : [],
  );
});

ipcMain.handle("promesaGuardar", (_evt, data) => createPromesa(db, data));
ipcMain.handle("promesasListar", () => { migrateHistoricalPromises(db); return listPromesas(db); });
ipcMain.handle("promesaObtener", (_evt, id) => getPromesaById(db, Number(id)) ?? null);
ipcMain.handle("promesaEditar", (_evt, { id, ...data }) => updatePromesa(db, Number(id), data));
ipcMain.handle("promesaActualizar", (_evt, { id, ...data }) => updatePromesaAtomic(db, Number(id), data));
ipcMain.handle("promesaCambiarEstado", (_evt, { id, estado, ...data }) => changePromesaState(db, Number(id), estado, data));
ipcMain.handle("promesasReconciliar", () => ({ ok: true, updated: reconcilePromises(db), promesas: listPromesas(db) }));
ipcMain.on("promesasLegacyBootstrapInternal", (event, records) => {
  event.returnValue = bootstrapLegacyPromises(db, Array.isArray(records) ? records : []);
});
ipcMain.on("promesasLegacyBootstrapStatusInternal", (event) => {
  event.returnValue = { closed: isPromiseLegacyBootstrapClosed(db) };
});

ipcMain.handle("gestionesReporte", (_evt, args) => {
  return getGestionesReporte(args);
});

ipcMain.handle("getNetworkInfo", async () => {
  return { ip: getNetworkIp(), port: 3000 };
});

ipcMain.handle("campanasListar", async () => {
  const data = db.prepare(`
    SELECT id, nombre, descripcion, fecha_inicio, fecha_fin, responsable, creado_en
    FROM campanas
    ORDER BY creado_en DESC
  `).all();
  return { ok: true, rows: data };
});

ipcMain.handle("campanasGuardar", (_evt, data) => {
  if (data.id) {
    db.prepare(`
      UPDATE campanas
      SET nombre = @nombre, descripcion = @descripcion, fecha_inicio = @fecha_inicio, fecha_fin = @fecha_fin, responsable = @responsable
      WHERE id = @id
    `).run(data);
  } else {
    db.prepare(`
      INSERT INTO campanas (nombre, descripcion, fecha_inicio, fecha_fin, responsable)
      VALUES (@nombre, @descripcion, @fecha_inicio, @fecha_fin, @responsable)
    `).run(data);
  }
  return { ok: true };
});

ipcMain.handle("motivosImpago", async () => {
  const data = db.prepare(`
    SELECT g.motivo, COUNT(*) as count, SUM(COALESCE(d.total - d.cobros, 0)) as total
    FROM gestiones g
    LEFT JOIN documentos d ON g.cliente = d.cliente
    WHERE g.motivo IS NOT NULL AND g.motivo != ''
    GROUP BY g.motivo
    ORDER BY count DESC
  `).all();
  
  return data.map((row: any) => ({
    label: row.motivo,
    count: row.count,
    total: row.total || 0
  }));
});

ipcMain.handle("productividadGestor", async () => {
  const data = db.prepare(`
    SELECT 
      g.usuario,
      COUNT(*) as total_gestiones,
      COUNT(DISTINCT p.id) as promesas,
      SUM(CASE WHEN g.resultado LIKE '%Pagado%' OR g.resultado LIKE '%Abonado%' THEN 1 ELSE 0 END) as pagos,
      ROUND(100.0 * COUNT(DISTINCT p.id) / COUNT(DISTINCT g.id), 1) as tasa_promesa,
      ROUND(SUM(COALESCE(d.total - d.cobros, 0)), 2) as saldo_recuperable
    FROM gestiones g
    LEFT JOIN documentos d ON g.cliente = d.cliente
    LEFT JOIN promesas p ON p.gestion_id = g.id
    WHERE g.usuario IS NOT NULL AND g.usuario != ''
    GROUP BY g.usuario
    ORDER BY total_gestiones DESC
  `).all();
  
  return data;
});

ipcMain.handle("alertasIncumplimiento", async () => {
  const data = db.prepare(`
    SELECT 
      d.cliente,
      d.documento,
      d.total as monto,
      d.fecha_vencimiento,
      CAST((julianday('now') - julianday(d.fecha_vencimiento)) AS INTEGER) as dias_vencidos,
      CASE 
        WHEN CAST((julianday('now') - julianday(d.fecha_vencimiento)) AS INTEGER) > 120 THEN 'Crítico'
        WHEN CAST((julianday('now') - julianday(d.fecha_vencimiento)) AS INTEGER) > 90 THEN 'Alto'
        WHEN CAST((julianday('now') - julianday(d.fecha_vencimiento)) AS INTEGER) > 30 THEN 'Medio'
        ELSE 'Bajo'
      END as severidad
    FROM documentos d
    WHERE d.fecha_vencimiento < date('now') AND (d.total - d.cobros) > 0
    ORDER BY dias_vencidos DESC
    LIMIT 50
  `).all();

  return data.map((row: any) => ({
    cliente: row.cliente,
    documento: row.documento,
    monto: row.monto || 0,
    diasVencidos: row.dias_vencidos || 0,
    severidad: row.severidad
  }));
});

ipcMain.handle("pronosticoFlujoCaja", async () => {
  const periodos = [];
  for (let i = 1; i <= 3; i++) {
    const dias = i * 15;
    const fecha_hasta = new Date();
    fecha_hasta.setDate(fecha_hasta.getDate() + dias);
    
    const promesas = db.prepare(`
      SELECT SUM(MAX(monto_prometido - monto_pagado, 0)) as total
      FROM promesas
      WHERE estado IN ('PENDIENTE','CUMPLIDA_PARCIAL')
        AND fecha_promesa >= date('now')
        AND fecha_promesa <= date(?)
        AND monto_promesa > 0
    `).get(fecha_hasta.toISOString().split('T')[0]);

    periodos.push({
      periodo: `${dias} días`,
      fechaHasta: fecha_hasta.toISOString().split('T')[0],
      flujoEsperado: promesas?.total || 0,
      confianza: i === 1 ? 95 : i === 2 ? 75 : 50
    });
  }
  return periodos;
});

ipcMain.handle("tendenciasHistoricas", async () => {
  const meses = [];
  for (let i = 11; i >= 0; i--) {
    const fecha = new Date();
    fecha.setMonth(fecha.getMonth() - i);
    const yearMes = fecha.getFullYear().toString() + '-' + String(fecha.getMonth() + 1).padStart(2, '0');
    
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as documentos,
        SUM(COALESCE(total, 0)) as emision,
        SUM(CASE WHEN fecha_vencimiento < date('now') AND (total - cobros) > 0 THEN 1 ELSE 0 END) as vencidos,
        SUM(COALESCE(cobros, 0)) as cobrado
      FROM documentos
      WHERE fecha_emision LIKE ?
    `).get(yearMes + '%');

    meses.push({
      mes: yearMes,
      documentos: stats?.documentos || 0,
      emision: stats?.emision || 0,
      cobrado: stats?.cobrado || 0,
      vencidos: stats?.vencidos || 0
    });
  }
  return meses;
});

ipcMain.handle("disputasListar", async () => {
  const data = db.prepare(`
    SELECT id, documento, cliente, monto, motivo, estado, 
           fecha_creacion, fecha_resolucion, observacion
    FROM disputas
    ORDER BY fecha_creacion DESC
  `).all();
  return data;
});

ipcMain.handle("disputaCrear", (_evt, data) => {
  db.prepare(`
    INSERT INTO disputas (documento, cliente, monto, motivo, observacion, usuario_creador)
    VALUES (@documento, @cliente, @monto, @motivo, @observacion, @usuario)
  `).run({
    ...data,
    usuario: data.usuario || 'sistema'
  });
  return { ok: true };
});

ipcMain.handle("disputaActualizar", (_evt, data) => {
  db.prepare(`
    UPDATE disputas 
    SET estado = @estado, fecha_resolucion = @fecha_resolucion, observacion = @observacion
    WHERE id = @id
  `).run(data);
  return { ok: true };
});

ipcMain.handle("cuentasAplicarListar", async () => {
  const data = db.prepare(`
    SELECT id, documento, cliente, monto, tipo, estado, 
           fecha_recepcion, fecha_aplicacion, documento_aplicado, observacion
    FROM cuentas_aplicar
    ORDER BY fecha_recepcion DESC
  `).all();
  return data;
});

ipcMain.handle("cuentaAplicarCrear", (_evt, data) => {
  db.prepare(`
    INSERT INTO cuentas_aplicar (documento, cliente, monto, tipo, observacion, usuario_creador)
    VALUES (@documento, @cliente, @monto, @tipo, @observacion, @usuario)
  `).run({
    ...data,
    usuario: data.usuario || 'sistema'
  });
  return { ok: true };
});

ipcMain.handle("abonosListar", async () => {
  const data = db.prepare(`
    SELECT 
      a.id, 
      a.documento, 
      COALESCE(d.cliente, 'N/A') as cliente,
      COALESCE(d.razon_social, 'N/A') as razon_social,
      a.total_anterior, 
      a.total_nuevo, 
      a.fecha, 
      a.observacion
    FROM abonos a
    LEFT JOIN documentos d ON a.documento = d.documento
    ORDER BY a.fecha DESC
  `).all();
  return data;
});

ipcMain.handle("clientesListar", async () => {
  return clientesListar();
});

ipcMain.handle(
  "collectionReconciliationGet",
  (_evt, payload: { year: number; month: number }) => {
    try {
      const row = getCollectionPeriodReconciliation(
        db,
        Number(payload?.year),
        Number(payload?.month),
      );

      return { ok: true, row };
    } catch (error: unknown) {
      return {
        ok: false,
        row: null,
        message:
          error instanceof Error
            ? error.message
            : "Error consultando la conciliación.",
      };
    }
  },
);

ipcMain.handle(
  "collectionReconciliationSave",
  (
    _evt,
    payload: {
      year: number;
      month: number;
      officialValue: number;
      observation?: string;
      user?: string;
    },
  ) => {
    try {
      const year = Number(payload?.year);
      const month = Number(payload?.month);

      const stats = computeDashboardExecutiveStats(
        db,
        new Date(),
        { year, month },
      );

      const row = saveCollectionPeriodReconciliation(
        db,
        {
          year,
          month,
          officialValue: Number(payload?.officialValue),
          observation: payload?.observation,
          user: payload?.user,
        },
        {
          detectedValue: stats.cobrosMes.totalDetectado,
          detectedMovements: stats.cobrosMes.movimientosDetectados,
        },
      );

      return { ok: true, row };
    } catch (error: unknown) {
      return {
        ok: false,
        row: null,
        message:
          error instanceof Error
            ? error.message
            : "Error guardando la conciliación.",
      };
    }
  },
);

ipcMain.handle("cuentaAplicarActualizar", (_evt, data) => {
  db.prepare(`
    UPDATE cuentas_aplicar 
    SET estado = @estado, fecha_aplicacion = @fecha_aplicacion, documento_aplicado = @documento_aplicado, observacion = @observacion
    WHERE id = @id
  `).run(data);
  return { ok: true };
});

ipcMain.handle("importarContifico", async () => {
  const selection = await dialog.showOpenDialog({
    title: "Seleccionar cartera de Contifico",
    properties: ["openFile"],
    filters: [
      {
        name: "Archivos de Excel",
        extensions: ["xlsx", "xls"],
      },
    ],
  });

  if (
    selection.canceled ||
    selection.filePaths.length === 0
  ) {
    return {
      ok: false,
      message: "Importacion cancelada",
    };
  }

  const filePath = selection.filePaths[0];
  const structure = validateExcelStructure(filePath, "CARTERA");
  if (!structure.ok) {
    return {
      ok: false,
      code: "INVALID_IMPORT_STRUCTURE",
      message: structure.message,
      structure,
    };
  }

  // Cartera es un SNAPSHOT, no un ledger de movimientos.
  // Un archivo con el mismo hash puede representar un nuevo corte operativo
  // (o una repetición deliberada de QA). No se bloquea por hash: la verdadera
  // idempotencia se resuelve comparando el contenido documental del snapshot
  // contra el snapshot anterior de la misma generación. Si no cambió nada,
  // el resultado será NO_EVENT para todos los documentos.
  const fileHash = hashImportFile(filePath);

  let importacionId = 0;

  try {
    importacionId = startPortfolioImport(
      filePath,
      fileHash,
    );

    const result = importContificoExcel(
      filePath,
      db,
      importacionId,
    ) as Record<string, unknown>;

    if (!result?.ok) {
      const message = String(
        result?.message ||
          "La importación de cartera no pudo completarse.",
      );

      failPortfolioImport(
        importacionId,
        message,
      );

      return {
        ...result,
        importacionId,
      };
    }

    reconcileCollections(db);

    finishPortfolioImport(
      importacionId,
      result,
    );

    return {
      ...result,
      importacionId,
    };
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Error desconocido durante la importacion";

    if (importacionId > 0) {
      failPortfolioImport(
        importacionId,
        message,
      );
    }

    console.error(
      "Error importando cartera de Contifico:",
      error,
    );

    return {
      ok: false,
      importacionId:
        importacionId > 0
          ? importacionId
          : undefined,
      message,
    };
  }
});

ipcMain.handle("getGitRemoteUrl", async () => {
  // Retornar URL del servidor web local para compartir
  const networkIp = getNetworkIp();
  const port = 3000; // Puerto del servidor web
  return { ok: true, url: `http://${networkIp}:${port}` };
});

ipcMain.handle("getUpdateInfo", async () => {
  return trackUpdateInstall();
});

// Handler para obtener la URL remota de Cloudflare
ipcMain.handle("getCloudflareUrl", async () => {
  return { ok: true, url: CLOUDFLARE_TUNNEL_URL };
});

// Handler para verificar el estado del túnel de Cloudflare
ipcMain.handle("checkCloudflaredStatus", async () => {
  try {
    const isHealthy = await checkCloudflaredTunnel();
    return { ok: true, status: isHealthy ? "connected" : "disconnected" };
  } catch (error) {
    return { ok: false, status: "error" };
  }
});

// Handler para reiniciar manualmente el túnel (si falla)
ipcMain.handle("restartCloudflared", async () => {
  try {
    const success = await restartCloudflaredTunnel();
    return { ok: success, message: success ? "Túnel reiniciado" : "Error reiniciando túnel" };
  } catch (error: any) {
    return { ok: false, message: error.message };
  }
});

// Handler para obtener la URL remota de ngrok (dinámica)
ipcMain.handle("getRemoteUrl", async () => {
  if (!ngrokUrl) {
    ngrokUrl = await startNgrok();
  }
  return { ok: !!ngrokUrl, url: ngrokUrl };
});

// Handler para verificar y actualizar ngrok si es necesario
ipcMain.handle("checkRemoteUrl", async () => {
  const url = await checkAndRefreshNgrok();
  return { ok: !!url, url };
});




ipcMain.handle("previewCancelledDocuments", async () => {
  const selection = await dialog.showOpenDialog({
    title: "Seleccionar archivo Documentos Anulados",
    properties: ["openFile"],
    filters: [{ name: "Archivos de Excel", extensions: ["xlsx", "xls"] }],
  });

  if (selection.canceled || selection.filePaths.length === 0) {
    return { ok: false, message: "Selección cancelada" };
  }

  try {
    const filePath = selection.filePaths[0];
    const structure = validateExcelStructure(filePath, "ANULADOS");
    if (!structure.ok) {
      return {
        ok: false,
        code: "INVALID_IMPORT_STRUCTURE",
        message: structure.message,
        structure,
      };
    }

    return previewCancelledDocumentsExcel(filePath, db);
  } catch (error: unknown) {
    console.error("Error analizando documentos anulados:", error);

    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Error desconocido durante el análisis",
    };
  }
});

ipcMain.handle(
  "confirmCancelledDocumentsImport",
  (_event, filePath: string) => {
    const fileHash = hashImportFile(filePath);

    const duplicate = db.prepare(`
      SELECT id, archivo_nombre, importado_en
      FROM importaciones
      WHERE tipo = 'ANULADOS'
        AND archivo_hash = ?
        AND reconciliation_generation = ?
        AND estado IN ('COMPLETADA', 'COMPLETADA_ADVERTENCIAS')
      ORDER BY id DESC
      LIMIT 1
      `).get(fileHash, currentReconciliationGeneration()) as
      | { id: number; archivo_nombre: string; importado_en: string }
      | undefined;

    if (duplicate) {
      return {
        ok: false,
        duplicateImport: true,
        importacionId: duplicate.id,
        message:
          "Este archivo de documentos anulados ya fue importado anteriormente. " +
          "No se ejecutó nuevamente para preservar la idempotencia.",
      };
    }

    let importacionId = 0;

    try {
      const insert = db.prepare(`
        INSERT INTO importaciones (
          tipo,
          archivo_nombre,
          archivo_hash,
          estado,
          observacion,
          metadata_json,
          reconciliation_generation
        )
        VALUES ('ANULADOS', ?, ?, 'PROCESANDO', ?, '{}', ?)
      `).run(
        basename(filePath),
        fileHash,
        "Procesando archivo de documentos anulados.",
        currentReconciliationGeneration(),
      );

      importacionId = Number(insert.lastInsertRowid);

      const result = importCancelledDocumentsExcel(
        filePath,
        db,
        importacionId,
      );
      registerHistoricalTransactionBatch(db, importacionId, "ANULADOS");

      return {
        ...result,
        importacionId,
      };
    } catch (error: unknown) {
      console.error("Error importando documentos anulados:", error);

      if (importacionId > 0) {
        db.prepare(`
          UPDATE importaciones
          SET estado = 'ERROR',
              observacion = ?
          WHERE id = ?
        `).run(
          error instanceof Error
            ? error.message
            : "Error desconocido durante la importación",
          importacionId,
        );
      }

      return {
        ok: false,
        importacionId: importacionId || undefined,
        message:
          error instanceof Error
            ? error.message
            : "Error desconocido durante la importación",
      };
    }
  },
);


ipcMain.handle("previewCreditNotes", async () => {
  const selection = await dialog.showOpenDialog({
    title: "Seleccionar archivo de Notas de Crédito",
    properties: ["openFile"],
    filters: [{ name: "Archivos de Excel", extensions: ["xlsx", "xls"] }],
  });

  if (selection.canceled || selection.filePaths.length === 0) {
    return { ok: false, message: "Selección cancelada" };
  }

  try {
    const filePath = selection.filePaths[0];
    const structure = validateExcelStructure(filePath, "NOTAS_CREDITO");
    if (!structure.ok) {
      return {
        ok: false,
        code: "INVALID_IMPORT_STRUCTURE",
        message: structure.message,
        structure,
      };
    }

    return previewCreditNotesExcel(filePath, db);
  } catch (error: unknown) {
    console.error("Error analizando notas de crédito:", error);
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Error desconocido durante el análisis",
    };
  }
});

ipcMain.handle(
  "confirmCreditNotesImport",
  (_event, filePath: string) => {
    const fileHash = hashImportFile(filePath);

    const duplicate = db.prepare(`
      SELECT id, archivo_nombre, importado_en
      FROM importaciones
      WHERE tipo = 'NOTAS_CREDITO'
        AND archivo_hash = ?
        AND reconciliation_generation = ?
        AND estado IN ('COMPLETADA', 'COMPLETADA_ADVERTENCIAS')
      ORDER BY id DESC
      LIMIT 1
      `).get(fileHash, currentReconciliationGeneration()) as
      | { id: number; archivo_nombre: string; importado_en: string }
      | undefined;

    if (duplicate) {
      return {
        ok: false,
        duplicateImport: true,
        importacionId: duplicate.id,
        message:
          "Este archivo de notas de crédito ya fue importado anteriormente. " +
          "No se ejecutó nuevamente para preservar la idempotencia.",
      };
    }

    let importacionId = 0;

    try {
      const insert = db.prepare(`
        INSERT INTO importaciones (
          tipo,
          archivo_nombre,
          archivo_hash,
          estado,
          observacion,
          metadata_json,
          reconciliation_generation
        )
        VALUES ('NOTAS_CREDITO', ?, ?, 'PROCESANDO', ?, '{}', ?)
      `).run(
        basename(filePath),
        fileHash,
        "Procesando archivo de notas de crédito.",
        currentReconciliationGeneration(),
      );

      importacionId = Number(insert.lastInsertRowid);

      const result = importCreditNotesExcel(filePath, db, importacionId);
      registerHistoricalTransactionBatch(db, importacionId, "NOTAS_CREDITO");
      return result;
    } catch (error: unknown) {
      console.error("Error importando notas de crédito:", error);

      if (importacionId > 0) {
        db.prepare(`
          UPDATE importaciones
          SET estado = 'ERROR',
              observacion = ?
          WHERE id = ?
        `).run(
          error instanceof Error
            ? error.message
            : "Error desconocido durante la importación",
          importacionId,
        );
      }

      return {
        ok: false,
        importacionId: importacionId || undefined,
        message:
          error instanceof Error
            ? error.message
            : "Error desconocido durante la importación",
      };
    }
  },
);


ipcMain.handle("previewCollectionMovements", async () => {
  const selection = await dialog.showOpenDialog({
    title: "Seleccionar Cobros/Pagos - Excel Detallado",
    properties: ["openFile"],
    filters: [{ name: "Archivos de Excel", extensions: ["xlsx", "xls"] }],
  });

  if (selection.canceled || selection.filePaths.length === 0) {
    return { ok: false, message: "Selección cancelada" };
  }

  try {
    const filePath = selection.filePaths[0];
    const structure = validateExcelStructure(filePath, "COBROS_MOVIMIENTOS");

    if (!structure.ok) {
      return {
        ok: false,
        code: "INVALID_IMPORT_STRUCTURE",
        message: structure.message,
        structure,
      };
    }

    return previewCollectionMovementsExcel(filePath, db);
  } catch (error: unknown) {
    console.error("Error analizando Cobros/Pagos:", error);
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Error desconocido durante el análisis",
    };
  }
});

ipcMain.handle(
  "confirmCollectionMovementsImport",
  (_event, filePath: string) => {
    const fileHash = hashImportFile(filePath);

    const duplicate = db.prepare(`
      SELECT id, archivo_nombre, importado_en
      FROM importaciones
      WHERE tipo = 'COBROS_MOVIMIENTOS'
        AND archivo_hash = ?
        AND reconciliation_generation = ?
        AND estado IN ('COMPLETADA', 'COMPLETADA_ADVERTENCIAS')
      ORDER BY id DESC
      LIMIT 1
      `).get(fileHash, currentReconciliationGeneration()) as
      | { id: number; archivo_nombre: string; importado_en: string }
      | undefined;

    if (duplicate) {
      return {
        ok: false,
        duplicateImport: true,
        importacionId: duplicate.id,
        message:
          "Este archivo de Cobros/Pagos ya fue importado anteriormente. " +
          "No se ejecutó nuevamente para preservar la idempotencia.",
      };
    }

    let importacionId = 0;

    try {
      const insert = db.prepare(`
        INSERT INTO importaciones (
          tipo,
          archivo_nombre,
          archivo_hash,
          estado,
          observacion,
          metadata_json,
          reconciliation_generation
        )
        VALUES ('COBROS_MOVIMIENTOS', ?, ?, 'PROCESANDO', ?, '{}', ?)
      `).run(
        basename(filePath),
        fileHash,
        "Procesando Cobros/Pagos - Excel Detallado.",
        currentReconciliationGeneration(),
      );

      importacionId = Number(insert.lastInsertRowid);

      const result = importCollectionMovementsExcel(filePath, db, importacionId);
      if (result.ok) reconcilePromises(db);
      registerHistoricalTransactionBatch(db, importacionId, "COBROS_MOVIMIENTOS");
      return result;
    } catch (error: unknown) {
      console.error("Error importando Cobros/Pagos:", error);

      if (importacionId > 0) {
        db.prepare(`
          UPDATE importaciones
          SET estado = 'ERROR',
              observacion = ?
          WHERE id = ?
        `).run(
          error instanceof Error
            ? error.message
            : "Error desconocido durante la importación",
          importacionId,
        );
      }

      return {
        ok: false,
        importacionId: importacionId || undefined,
        message:
          error instanceof Error
            ? error.message
            : "Error desconocido durante la importación",
      };
    }
  },
);

ipcMain.handle("cancelledDocumentsReversalSummary", () => {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS reversedPayments,
      ROUND(COALESCE(SUM(total_anterior - total_nuevo), 0), 2) AS reversedAmount
    FROM abonos
    WHERE COALESCE(reversado, 0) = 1
      AND motivo_reversion = 'ANULACION_DOCUMENTO'
  `).get() as {
    reversedPayments: number;
    reversedAmount: number;
  };

  return {
    reversedPayments: Number(row?.reversedPayments || 0),
    reversedAmount: Number(row?.reversedAmount || 0),
  };
});

ipcMain.handle("cancelledDocumentsList", () => {
  const rows = db.prepare(`
    SELECT
      id,
      documento,
      cliente,
      fecha_anulacion,
      motivo,
      archivo_origen,
      detectado_en,
      resultado,
      tipo_documento,
      estado_origen,
      numero_autorizacion
    FROM documentos_anulados_log
    ORDER BY datetime(detectado_en) DESC, id DESC
  `).all();

  return { ok: true, rows };
});

ipcMain.handle("creditPoliciesList", () => {
  const rows = db.prepare(`
    WITH credit_clients AS (
      SELECT DISTINCT TRIM(cliente) AS cliente
      FROM documentos
      WHERE is_subtotal = 0
        AND TRIM(COALESCE(cliente, '')) <> ''

      UNION

      SELECT DISTINCT TRIM(cliente) AS cliente
      FROM alertas_credito
      WHERE TRIM(COALESCE(cliente, '')) <> ''

      UNION

      SELECT DISTINCT TRIM(cliente) AS cliente
      FROM clientes
      WHERE TRIM(COALESCE(cliente, '')) <> ''
    )
    SELECT
      cc.cliente,
      COALESCE(c.tipo_credito, 'CREDITO') AS tipo_credito,
      c.dias_credito,
      COALESCE(c.credito_configurado, 0) AS credito_configurado,
      SUM(CASE WHEN d.credito_pendiente = 1 THEN 1 ELSE 0 END) AS documentos_pendientes,
      MAX(a.estado) AS alerta_estado
    FROM credit_clients cc
    LEFT JOIN clientes c
      ON TRIM(c.cliente) = cc.cliente
    LEFT JOIN documentos d
      ON TRIM(d.cliente) = cc.cliente
      AND d.is_subtotal = 0
    LEFT JOIN alertas_credito a
      ON TRIM(a.cliente) = cc.cliente
    GROUP BY
      cc.cliente,
      c.tipo_credito,
      c.dias_credito,
      c.credito_configurado
    HAVING
      COALESCE(c.credito_configurado, 0) = 1
      OR SUM(CASE WHEN d.credito_pendiente = 1 THEN 1 ELSE 0 END) > 0
    ORDER BY
      CASE
        WHEN SUM(CASE WHEN d.credito_pendiente = 1 THEN 1 ELSE 0 END) > 0
          THEN 0
        ELSE 1
      END,
      cc.cliente COLLATE NOCASE
  `).all();

  return { ok: true, rows };
});

ipcMain.handle("creditPolicyPreview", (_event, cliente: string) => {
  const normalized = String(cliente ?? "").trim();
  if (!normalized) return { ok: false, documentosPendientes: 0 };

  const row = db.prepare(`
    SELECT COUNT(*) AS total
    FROM documentos
    WHERE cliente = ?
      AND is_subtotal = 0
      AND credito_pendiente = 1
  `).get(normalized) as { total: number };

  return { ok: true, documentosPendientes: Number(row?.total ?? 0) };
});

ipcMain.handle("creditPolicySave", (_event, payload: {
  cliente: string;
  tipoCredito: "CONTADO" | "CREDITO";
  diasCredito: number;
  recalcularPendientes: boolean;
}) => {
  const cliente = String(payload?.cliente ?? "").trim();
  const diasCredito = Number(payload?.diasCredito);
  const recalcular = payload?.recalcularPendientes === true;

  if (!cliente) {
    return { ok: false, message: "El cliente es obligatorio.", documentosActualizados: 0 };
  }
  if (!Number.isInteger(diasCredito) || diasCredito < 0 || diasCredito > 365) {
    return { ok: false, message: "Los días deben estar entre 0 y 365.", documentosActualizados: 0 };
  }

  const tipoCredito = diasCredito === 0 ? "CONTADO" : "CREDITO";

  const save = db.transaction(() => {
    db.prepare(`
      INSERT INTO clientes (
        cliente,
        razon_social,
        tipo_credito,
        dias_credito,
        credito_configurado,
        credito_actualizado_en
      )
      VALUES (
        ?,
        ?,
        ?,
        ?,
        1,
        datetime('now', 'localtime')
      )
      ON CONFLICT(cliente) DO UPDATE SET
        tipo_credito = excluded.tipo_credito,
        dias_credito = excluded.dias_credito,
        credito_configurado = 1,
        credito_actualizado_en = excluded.credito_actualizado_en
    `).run(
      cliente,
      cliente,
      tipoCredito,
      diasCredito,
    );

    let documentosActualizados = 0;

    if (recalcular) {
      const updateDocs = db.prepare(`
        UPDATE documentos
        SET fecha_vencimiento = date(fecha_emision, '+' || ? || ' day'),
            dias_credito_aplicados = ?,
            credito_fuente = 'POLITICA_CLIENTE',
            credito_pendiente = 0
        WHERE cliente = ?
          AND is_subtotal = 0
          AND credito_pendiente = 1
          AND TRIM(COALESCE(fecha_emision, '')) <> ''
      `).run(diasCredito, diasCredito, cliente);

      documentosActualizados = updateDocs.changes;
    }

    const pending = db.prepare(`
      SELECT COUNT(*) AS total
      FROM documentos
      WHERE cliente = ?
        AND is_subtotal = 0
        AND credito_pendiente = 1
    `).get(cliente) as { total: number };

    if (Number(pending?.total ?? 0) === 0) {
      db.prepare(`
        UPDATE alertas_credito
        SET estado = 'RESUELTA',
            resuelto_en = datetime('now', 'localtime')
        WHERE cliente = ?
      `).run(cliente);
    } else {
      db.prepare(`
        UPDATE alertas_credito
        SET estado = 'PENDIENTE',
            resuelto_en = NULL
        WHERE cliente = ?
      `).run(cliente);
    }

    return documentosActualizados;
  });

  try {
    const documentosActualizados = save();
    return {
      ok: true,
      message: "Política guardada correctamente.",
      documentosActualizados,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "No se pudo guardar la política.",
      documentosActualizados: 0,
    };
  }
});

// Legacy import helpers retained temporarily.
void _parseExcel;
void _saveDocumentsToDb;






