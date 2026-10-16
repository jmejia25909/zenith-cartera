import { contextBridge, ipcRenderer } from "electron";

import { prepareLegacyPromises } from "../src/services/promesaLegacyMigration";
import type {
  TareaCancelInput,
  TareaCompleteInput,
  TareaCreateInput,
  TareaEditRequest,
  TareaEventListQuery,
  TareaListQuery,
  TareaStateChangeInput,
} from "../src/types/tarea";
import type { AlertaOperativaQuery } from "../src/types/alertaOperativa";

const LEGACY_PROMISES_KEY = "cartera_promesas_locales";
try {
  const status = ipcRenderer.sendSync("promesasLegacyBootstrapStatusInternal") as { closed?: boolean };
  if (!status?.closed) {
    const stored = window.localStorage.getItem(LEGACY_PROMISES_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    const records = Array.isArray(parsed) && parsed.length > 0
      ? prepareLegacyPromises(parsed, () => crypto.randomUUID(), (value) =>
          window.localStorage.setItem(LEGACY_PROMISES_KEY, JSON.stringify(value)))
      : [];
    ipcRenderer.sendSync("promesasLegacyBootstrapInternal", records);
  }
} catch (error) {
  console.error("Bootstrap interno de promesas legacy pendiente:", error);
}

const apiMethods = {
  cambiarLogo: () => {
    console.log("🔄 Preload: Iniciando cambio de logo...");
    return ipcRenderer.invoke("cambiarLogo");
  },
  ping: () => ipcRenderer.invoke("ping"),
  getDbPath: () => ipcRenderer.invoke("getDbPath"),
  getDesktopToken: () => ipcRenderer.invoke("getDesktopToken"),
  hasWritePermissions: () => ipcRenderer.invoke("hasWritePermissions"),
  statsObtener: () => ipcRenderer.invoke("statsObtener"),
  dashboardExecutiveStats: (filters?: {
    year?: number;
    month?: number | null;
  }) =>
    ipcRenderer.invoke(
      "dashboardExecutiveStats",
      filters,
    ),

  managementReportsSummary: (filters: {
    year: number;
    month?: number | null;
  }) =>
    ipcRenderer.invoke(
      "managementReportsSummary",
      filters,
    ),
  managementReportDetail: (request: {
    type:
      | "COLLECTIONS_DETAIL"
      | "CRM_ACTIVITY"
      | "PORTFOLIO_AGING"
      | "CANCELLED_DOCUMENTS"
      | "CREDIT_NOTES";
    filters: {
      year: number;
      month?: number | null;
      customer?: string;
      seller?: string;
      movementClass?: "COBRO" | "CRUCE" | null;
      reconciliationStatus?: string | null;
    };
  }) =>
    ipcRenderer.invoke(
      "managementReportDetail",
      request,
    ),

  collectionReconciliationGet: (payload: { year: number; month: number }) => ipcRenderer.invoke("collectionReconciliationGet", payload),
  collectionReconciliationSave: (payload: { year: number; month: number; officialValue: number; observation?: string; user?: string }) => ipcRenderer.invoke("collectionReconciliationSave", payload),
  filtrosListar: () => ipcRenderer.invoke("filtrosListar"),
  topClientes: (limit?: number) => ipcRenderer.invoke("topClientes", limit),
  documentosListar: (args: unknown) => ipcRenderer.invoke("documentosListar", args),
  creditPoliciesList: () => ipcRenderer.invoke("creditPoliciesList"),
  creditPolicyPreview: (cliente: string) => ipcRenderer.invoke("creditPolicyPreview", cliente),
  creditPolicySave: (data: unknown) => ipcRenderer.invoke("creditPolicySave", data),
  previewCancelledDocuments: () =>
    ipcRenderer.invoke("previewCancelledDocuments"),
  confirmCancelledDocumentsImport: (filePath: string) =>
    ipcRenderer.invoke("confirmCancelledDocumentsImport", filePath),
  previewCreditNotes: () =>
    ipcRenderer.invoke("previewCreditNotes"),
  confirmCreditNotesImport: (filePath: string) =>
    ipcRenderer.invoke("confirmCreditNotesImport", filePath),
  previewCollectionMovements: () =>
    ipcRenderer.invoke("previewCollectionMovements"),
  confirmCollectionMovementsImport: (filePath: string) =>
    ipcRenderer.invoke("confirmCollectionMovementsImport", filePath),
  cancelledDocumentsList: () => ipcRenderer.invoke("cancelledDocumentsList"),
  cancelledDocumentsReversalSummary: () =>
    ipcRenderer.invoke("cancelledDocumentsReversalSummary"),
  importarContifico: () => ipcRenderer.invoke("importarContifico"),
  importHistoryList: (args?: {
    tipo?: "CARTERA" | "ANULADOS" | "NOTAS_CREDITO" | "COBROS_MOVIMIENTOS";
    limit?: number;
  }) => ipcRenderer.invoke("importHistoryList", args),
  importHistoryGet: (id: number) =>
    ipcRenderer.invoke("importHistoryGet", id),
  importHistoryRevert: (args: {
    id: number;
    observacion?: string;
  }) => ipcRenderer.invoke("importHistoryRevert", args),
  exportarBackup: () => ipcRenderer.invoke("exportarBackup"),
  limpiarBaseDatos: () => ipcRenderer.invoke("limpiarBaseDatos"),
  resetReconciliationProjection: () =>
    ipcRenderer.invoke("resetReconciliationProjection"),
  reconciliationControlGet: () =>
    ipcRenderer.invoke("reconciliationControlGet"),
  historicalBootstrapStart: (snapshotDate: string) =>
    ipcRenderer.invoke("historicalBootstrapStart", { snapshotDate }),
  historicalBootstrapFinish: () =>
    ipcRenderer.invoke("historicalBootstrapFinish"),
  historicalBootstrapReset: () =>
    ipcRenderer.invoke("historicalBootstrapReset"),
  actualizarDiasCredito: (id: number, dias: number) => ipcRenderer.invoke("actualizarDiasCredito", { id, dias }),
  generarPDF: (filename: string) => ipcRenderer.invoke("generarPDF", filename),
  empresaObtener: () => ipcRenderer.invoke("empresaObtener"),
  empresaGuardar: (data: unknown) => ipcRenderer.invoke("empresaGuardar", data),
  clientesAnalisis: () => ipcRenderer.invoke("clientesAnalisis"),
  getNetworkInfo: () => ipcRenderer.invoke("getNetworkInfo"),
  clienteObtenerInfo: (codigo: string) => ipcRenderer.invoke("clienteObtenerInfo", codigo),
  clienteGuardarInfo: (data: unknown) => ipcRenderer.invoke("clienteGuardarInfo", data),
  gestionGuardar: (data: unknown) => ipcRenderer.invoke("gestionGuardar", data),
  gestionesListar: (cliente: string) => ipcRenderer.invoke("gestionesListar", cliente),
  gestionEditar: (data: unknown) => ipcRenderer.invoke("gestionEditar", data),
  gestionCumplir: (id: number) => ipcRenderer.invoke("gestionCumplir", id),
  gestionEliminar: (id: number) => ipcRenderer.invoke("gestionEliminar", id),
  gestionesLegacyMigrar: (data: unknown) => ipcRenderer.invoke("gestionesLegacyMigrar", data),
  tareaCrear: (data: TareaCreateInput) => ipcRenderer.invoke("tareaCrear", data),
  tareaObtener: (id: number) => ipcRenderer.invoke("tareaObtener", id),
  tareasListar: (query: TareaListQuery) => ipcRenderer.invoke("tareasListar", query),
  tareaEditar: (data: TareaEditRequest) => ipcRenderer.invoke("tareaEditar", data),
  tareaCambiarEstado: (data: TareaStateChangeInput) => ipcRenderer.invoke("tareaCambiarEstado", data),
  tareaCompletar: (data: TareaCompleteInput) => ipcRenderer.invoke("tareaCompletar", data),
  tareaCancelar: (data: TareaCancelInput) => ipcRenderer.invoke("tareaCancelar", data),
  tareaEventosListar: (query: TareaEventListQuery) => ipcRenderer.invoke("tareaEventosListar", query),
  alertasOperativasListar: (query: AlertaOperativaQuery) => ipcRenderer.invoke("alertasOperativasListar", query),
  alertasOperativasResumen: (query?: AlertaOperativaQuery) => ipcRenderer.invoke("alertasOperativasResumen", query),
  promesaGuardar: (data: unknown) => ipcRenderer.invoke("promesaGuardar", data),
  promesasListar: () => ipcRenderer.invoke("promesasListar"),
  promesaObtener: (id: number) => ipcRenderer.invoke("promesaObtener", id),
  promesaEditar: (data: unknown) => ipcRenderer.invoke("promesaEditar", data),
  promesaActualizar: (data: unknown) => ipcRenderer.invoke("promesaActualizar", data),
  promesaCambiarEstado: (data: unknown) => ipcRenderer.invoke("promesaCambiarEstado", data),
  promesasReconciliar: () => ipcRenderer.invoke("promesasReconciliar"),
  gestionesReporte: (args: unknown) => ipcRenderer.invoke("gestionesReporte", args),
  campanasListar: () => ipcRenderer.invoke("campanasListar"),
  campanasGuardar: (data: unknown) => ipcRenderer.invoke("campanasGuardar", data),
  motivosImpago: () => ipcRenderer.invoke("motivosImpago"),
  productividadGestor: () => ipcRenderer.invoke("productividadGestor"),
  alertasIncumplimiento: () => ipcRenderer.invoke("alertasIncumplimiento"),
  pronosticoFlujoCaja: () => ipcRenderer.invoke("pronosticoFlujoCaja"),
  tendenciasHistoricas: () => ipcRenderer.invoke("tendenciasHistoricas"),
  disputasListar: () => ipcRenderer.invoke("disputasListar"),
  disputaCrear: (data: unknown) => ipcRenderer.invoke("disputaCrear", data),
  cuentasAplicarListar: () => ipcRenderer.invoke("cuentasAplicarListar"),
  cuentaAplicarCrear: (data: unknown) => ipcRenderer.invoke("cuentaAplicarCrear", data),
  cuentaAplicarActualizar: (data: unknown) => ipcRenderer.invoke("cuentaAplicarActualizar", data),
  abonosListar: () => ipcRenderer.invoke("abonosListar"),
  clientesListar: () => ipcRenderer.invoke("clientesListar"),
  getGitRemoteUrl: () => ipcRenderer.invoke("getGitRemoteUrl"),
  getUpdateInfo: () => ipcRenderer.invoke("getUpdateInfo"),
};

contextBridge.exposeInMainWorld("carteraApi", apiMethods);
contextBridge.exposeInMainWorld("api", apiMethods);



