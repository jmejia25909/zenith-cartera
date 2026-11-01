// src/global.d.ts
export {};

import type {
  Filtros, 
  Documento, 
  EmpresaData, 
  ClienteInfo, 
  GestionData, 
  GestionCreateInput,
  GestionUpdateInput,
  GestionMutationResult,
  GestionLegacyInput,
  GestionLegacyMigrationResult,
  Promesa,
  PromesaCreateInput,
  PromesaUpdateInput,
  PromesaAtomicUpdateInput,
  PromesaState,
  PromesaMutationResult,
  GestionesReporteArgs,
  CampanaData,
  DisputaData,
  CuentaAplicarData,
  TopCliente,
  PronosticoMes
} from '../../types/api.types';
import type {
  DashboardExecutiveFilters,
  DashboardExecutiveStats,
} from '../../types/dashboardExecutive';
import type { BandejaOperativaListResult, BandejaOperativaQuery, BandejaOperativaResumenResult } from '../../types/bandejaOperativa';
import type {
  CollectionReconciliationResult,
  SaveCollectionPeriodReconciliationInput,
} from '../../types/collectionReconciliation';
import type {
  ManagementReportFilters,
  ManagementReportsSummary,
} from '../../types/managementReports';
import type {
  ManagementReportDetailRequest,
  ManagementReportDetailResult,
} from '../../types/managementReportDetails';
import type { AlertaOperativaQuery, AlertaOperativaListResult, AlertaOperativaResumenResult } from '../../types/alertaOperativa';
import type {
  PaginatedResult,
  Tarea,
  TareaCancelInput,
  TareaCompleteInput,
  TareaCreateInput,
  TareaEditRequest,
  TareaErrorResult,
  TareaEvent,
  TareaEventListQuery,
  TareaListQuery,
  TareaStateChangeInput,
} from '../../types/tarea';

declare global {
  interface Window {
    carteraApi?: {
      ping: () => Promise<{ ok: boolean }>;
      getDbPath: () => Promise<string>;
      getDesktopToken: () => Promise<string>;
      hasWritePermissions: () => Promise<boolean>;

      creditPoliciesList: () => Promise<{
        ok: boolean;
        rows: Array<{
          cliente: string;
          tipo_credito: "CONTADO" | "CREDITO";
          dias_credito: number | null;
          credito_configurado: number;
          documentos_pendientes: number;
          alerta_estado: string | null;
        }>;
      }>;
      creditPolicyPreview: (cliente: string) => Promise<{
        ok: boolean;
        documentosPendientes: number;
      }>;
      creditPolicySave: (data: {
        cliente: string;
        tipoCredito: "CONTADO" | "CREDITO";
        diasCredito: number;
        recalcularPendientes: boolean;
      }) => Promise<{
        ok: boolean;
        message?: string;
        documentosActualizados: number;
      }>;

      previewCancelledDocuments: () => Promise<{
        ok: boolean;
        filePath: string;
        sheetName: string;
        companyName: string;
        reportTitle: string;
        totalRows: number;
        historicalDuplicates: number;
        foundDocuments: number;
        alreadyCancelledDocuments: number;
        unmatchedDocuments: number;
        paymentsToReverse: number;
        rows: Array<{
          rowNumber: number;
          cancellationDate: string;
          documentType: string;
          documentNumber: string;
          normalizedDocumentNumber: string;
          sourceStatus: string;
          authorizationNumber: string;
          matchStatus: "ENCONTRADO" | "NO_ENCONTRADO" | "YA_ANULADO";
          customer: string | null;
          activePayments: number;
        }>;
        message?: string;
      }>;

      confirmCancelledDocumentsImport: (
        filePath: string,
      ) => Promise<{
        ok: boolean;
        filePath: string;
        totalRows: number;
        matchedDocuments: number;
        alreadyCancelledDocuments: number;
        cancelledDocuments: number;
        reversedPayments: number;
        unmatchedDocuments: number;
        message?: string;
      }>;

      cancelledDocumentsReversalSummary: () => Promise<{
        reversedPayments: number;
        reversedAmount: number;
      }>;
      cancelledDocumentsList: () => Promise<{
        ok: boolean;
        rows: Array<{
          id: number;
          documento: string;
          cliente: string | null;
          fecha_anulacion: string | null;
          motivo: string | null;
          archivo_origen: string | null;
          detectado_en: string;
          resultado: string;
          tipo_documento: string | null;
          estado_origen: string | null;
          numero_autorizacion: string | null;
        }>;
      }>;

      importarContifico: () => Promise<{
        ok: boolean;
        filePath?: string;
        insertedDocs?: number;
        updatedDocs?: number;
        insertedClientes?: number;
        omittedRows?: number;
        message?: string;
        insertedIds?: number[];
      }>;

      documentosListar: (filtros: Filtros) => Promise<{ ok: boolean; rows: Documento[] }>;

      // Filtros para los combos (clientes, vendedores, etc)
      filtrosListar: () => Promise<{
        clientes: Array<{ cliente: string; razon_social: string }>;
        vendedores: string[];
        tipos: string[];
      }>;

      // KPIs del dashboard
      statsObtener: () => Promise<{
        fechaCorte: string;
        totalSaldo: number;
        totalCobrado?: number;
        vencidaSaldo: number;
        percentVencida: number;
        mora90Saldo: number;
        percentMora90: number;
        mora120Saldo?: number;
        percentTop10: number;
        docsPendientes: number;
        clientesConSaldo: number;
        aging: { porVencer: number; d30: number; d60: number; d90: number; d120: number; d120p: number };
        npl?: number;
        dso?: number;
        recuperacionMesActual?: number;
        metaMensual?: number;
        percentMetaCumplida?: number;
        tasaCumplimientoPromesas?: number;
      }>;

      dashboardExecutiveStats: (
        filters?: DashboardExecutiveFilters,
      ) => Promise<DashboardExecutiveStats>;

      managementReportsSummary: (
        filters: ManagementReportFilters,
      ) => Promise<ManagementReportsSummary>;

      managementReportDetail: (
        request: ManagementReportDetailRequest,
      ) => Promise<ManagementReportDetailResult>;

      collectionReconciliationGet: (payload: { year: number; month: number }) => Promise<CollectionReconciliationResult>;
      collectionReconciliationSave: (payload: SaveCollectionPeriodReconciliationInput) => Promise<CollectionReconciliationResult>;


      topClientes: (limit?: number) => Promise<TopCliente[]>;
      limpiarBaseDatos: () => Promise<{ ok: boolean; message: string }>;
      actualizarDiasCredito: (id: number, dias: number) => Promise<{ ok: boolean; message?: string }>;
      empresaObtener: () => Promise<EmpresaData>;
      empresaGuardar: (data: EmpresaData) => Promise<{ ok: boolean; message?: string }>;
      clienteObtenerInfo: (codigo: string) => Promise<ClienteInfo | null>;
      clienteGuardarInfo: (data: ClienteInfo) => Promise<{ ok: boolean; message?: string }>;
      gestionGuardar: (data: GestionCreateInput) => Promise<{ ok: true; gestion: GestionData }>;
      gestionesListar: (cliente: string) => Promise<GestionData[]>;
      gestionEditar: (data: GestionUpdateInput & { id: number }) => Promise<GestionMutationResult>;
      gestionCumplir: (id: number) => Promise<GestionMutationResult>;
      gestionEliminar: (id: number) => Promise<GestionMutationResult>;
      gestionesLegacyMigrar: (data: {
        source: string;
        records: GestionLegacyInput[];
      }) => Promise<GestionLegacyMigrationResult>;
      tareaCrear: (data: TareaCreateInput) => Promise<import('../../types/tarea').TareaMutationResult>;
      tareaObtener: (id: number) => Promise<Tarea | null>;
      tareasListar: (query: TareaListQuery) => Promise<PaginatedResult<Tarea> | TareaErrorResult>;
      tareaEditar: (data: TareaEditRequest) => Promise<import('../../types/tarea').TareaMutationResult>;
      tareaCambiarEstado: (data: TareaStateChangeInput) => Promise<import('../../types/tarea').TareaMutationResult>;
      tareaCompletar: (data: TareaCompleteInput) => Promise<import('../../types/tarea').TareaMutationResult>;
      tareaCancelar: (data: TareaCancelInput) => Promise<import('../../types/tarea').TareaMutationResult>;
      tareaEventosListar: (query: TareaEventListQuery) => Promise<PaginatedResult<TareaEvent> | TareaErrorResult>;
      alertasOperativasListar: (query: AlertaOperativaQuery) => Promise<AlertaOperativaListResult>;
      alertasOperativasResumen: (query?: AlertaOperativaQuery) => Promise<AlertaOperativaResumenResult>;
      bandejaOperativaListar: (query: BandejaOperativaQuery) => Promise<BandejaOperativaListResult>;
      bandejaOperativaResumen: (query?: BandejaOperativaQuery) => Promise<BandejaOperativaResumenResult>;
      promesaGuardar: (data: PromesaCreateInput) => Promise<PromesaMutationResult>;
      promesasListar: () => Promise<Promesa[]>;
      promesaObtener: (id: number) => Promise<Promesa | null>;
      promesaEditar: (data: PromesaUpdateInput & { id: number }) => Promise<PromesaMutationResult>;
      promesaActualizar: (data: PromesaAtomicUpdateInput & { id: number }) => Promise<PromesaMutationResult>;
      promesaCambiarEstado: (data: PromesaUpdateInput & { id: number; estado: PromesaState }) => Promise<PromesaMutationResult>;
      promesasReconciliar: () => Promise<{ ok: true; updated: number; promesas: Promesa[] }>;
      gestionesReporte: (args: GestionesReporteArgs) => Promise<GestionData[]>;
      campanasListar: () => Promise<CampanaData[]>;
      campanasGuardar: (data: CampanaData) => Promise<{ ok: boolean; message?: string }>;
      clientesAnalisis: () => Promise<unknown>;
      motivosImpago: () => Promise<unknown>;
      productividadGestor: () => Promise<unknown>;
      alertasIncumplimiento: () => Promise<unknown>;
      pronosticoFlujoCaja: () => Promise<PronosticoMes[]>;
      tendenciasHistoricas: () => Promise<unknown>;
      disputasListar: () => Promise<DisputaData[]>;
      disputaCrear: (data: DisputaData) => Promise<{ ok: boolean; message?: string }>;
      cuentasAplicarListar: () => Promise<CuentaAplicarData[]>;
      cuentaAplicarCrear: (data: CuentaAplicarData) => Promise<{ ok: boolean; message?: string }>;
      cuentaAplicarActualizar: (data: CuentaAplicarData) => Promise<{ ok: boolean; message?: string }>;
      abonosListar: () => Promise<any[]>;
      exportarBackup: () => Promise<{ ok: boolean; message?: string }>;
      cambiarLogo: () => Promise<{ ok: boolean; message?: string; logo?: string }>;
      generarPDF: (filename: string) => Promise<{ ok: boolean; message?: string }>;
      getNetworkInfo: () => Promise<{ ip: string; tunnel?: string }>;
      getGitRemoteUrl: () => Promise<{ ok: boolean; url?: string }>;
      getRemoteUrl: () => Promise<{ ok: boolean; url?: string }>;
      checkRemoteUrl: () => Promise<{ ok: boolean; url?: string }>;
      getCloudflareUrl: () => Promise<{ ok: boolean; url: string }>;
      checkCloudflaredStatus: () => Promise<{ ok: boolean; status: "connected" | "disconnected" | "error" }>;
      restartCloudflared: () => Promise<{ ok: boolean; message: string }>;
      getUpdateInfo: () => Promise<{ updateCount: number; currentVersion?: string; lastVersion?: string; updatedAt?: string; firstRunAt?: string }>;
      campanaCrear?: (data: CampanaData) => Promise<{ ok: boolean; message?: string }>;
      campanaEliminar?: (id: number) => Promise<{ ok: boolean; message?: string }>;
      reiniciarEstructuraExcel?: () => Promise<{ ok: boolean; message?: string }>;
    };
    api?: Window['carteraApi'];
  }
}



