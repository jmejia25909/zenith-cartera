// Tipos centralizados para la API de Cartera

export interface Filtros {
  cliente?: string;
  vendedor?: string;
  tipo?: string;
  desde?: string;
  hasta?: string;
  estado?: string;
  minTotal?: number;
  maxTotal?: number;
}

export interface Documento {
  id: number;
  cliente: string;
  razon_social: string;
  tipo_documento: string;
  documento: string;
  fecha_emision: string;
  fecha_vencimiento: string;
  vendedor: string;
  total: number;
  descripcion: string;
  valor_documento: number;
  retenciones: number;
  iva: number;
  cobros: number;
  is_subtotal: number;
  importado_en: string;
}

export interface EmpresaData {
  nombre: string;
  ruc?: string;
  direccion?: string;
  telefono?: string;
  email?: string;
  administrador?: string;
  iva_percent?: number;
  meta_mensual?: number;
  excel_headers_json?: string;
  tema?: string;
  logo?: string;
}

export interface ClienteInfo {
  cliente: string;
  razon_social?: string;
  vendedor?: string;
  telefono?: string;
  email?: string;
  direccion?: string;
  contacto?: string;
}

export interface GestionData {
  id?: number;
  cliente: string;
  fecha?: string;
  tipo?: string;
  resultado?: string;
  observacion?: string;
  fecha_promesa?: string;
  monto_promesa?: number;
  usuario?: string;
  creado_en?: string;
  actualizado_en?: string | null;
  motivo?: string | null;
}

export type GestionCreateInput = Omit<
  GestionData,
  'id' | 'creado_en' | 'actualizado_en'
> & { promesa_documentos?: Array<{ documento_normalizado: string; monto_comprometido?: number | null }> };

export type GestionUpdateInput = Pick<
  GestionData,
  'tipo' | 'resultado' | 'observacion' | 'fecha_promesa' | 'monto_promesa' | 'usuario' | 'motivo'
>;

export type GestionMutationResult =
  | { ok: true; gestion: GestionData }
  | { ok: false; code: 'GESTION_NOT_FOUND' | 'GESTION_INVALID_ID'; message: string };

export interface GestionLegacyInput extends GestionCreateInput {
  legacy_id: string;
  id?: number;
}

export type GestionLegacyMigrationResult = {
  ok: true;
  mappings: Array<{
    legacy_id: string;
    gestion_id: number | null;
    inserted: boolean;
    deleted: boolean;
  }>;
} | {
  ok: false;
  code: 'LEGACY_ID_CONFLICT' | 'LEGACY_INVALID_RECORD';
  legacy_id: string;
  message: string;
};

export type PromesaState = 'PENDIENTE' | 'CUMPLIDA' | 'CUMPLIDA_PARCIAL' | 'INCUMPLIDA' | 'CANCELADA' | 'REPROGRAMADA';
export interface Promesa {
  id: number; cliente: string; gestion_id?: number | null; documento_id?: number | null;
  fecha_promesa: string; monto_prometido: number; monto_pagado: number; estado: PromesaState;
  fecha_pago?: string | null; motivo_incumplimiento?: string | null; observacion?: string | null;
  origen: 'NATIVE' | 'MIGRATED_GESTION' | 'MIGRATED_LEGACY';
  monto_cumplido_base?: number; cumplimiento_automatico_desde?: string | null;
  documentos?: Array<{ documento_normalizado: string; monto_comprometido?: number | null }>;
  creado_en: string; actualizado_en?: string | null; razon_social?: string;
}
export type PromesaCreateInput = Pick<Promesa, 'cliente' | 'fecha_promesa' | 'monto_prometido'> & Partial<Pick<Promesa, 'gestion_id' | 'documento_id' | 'monto_pagado' | 'estado' | 'fecha_pago' | 'motivo_incumplimiento' | 'observacion' | 'documentos'>>;
export type PromesaUpdateInput = Partial<Pick<Promesa, 'fecha_promesa' | 'monto_prometido' | 'monto_pagado' | 'fecha_pago' | 'motivo_incumplimiento' | 'observacion' | 'documento_id' | 'documentos'>>;
export type PromesaAtomicUpdateInput = PromesaUpdateInput & { estado?: PromesaState };
export type PromesaMutationResult = { ok: true; promesa: Promesa } | { ok: false; code: 'PROMESA_NOT_FOUND' | 'PROMESA_INVALID' | 'PROMESA_INVALID_TRANSITION' | 'PROMESA_DOCUMENT_ALLOCATION_MISMATCH' | 'PROMESA_LEGACY_ID_CONFLICT' | 'PROMESA_LEGACY_MAPPING_ORPHAN'; message: string; legacy_id?: string };
export interface PromesaLegacyInput extends PromesaCreateInput { legacy_id: string; promesa_id?: number; actualizado_en?: string | null; }
export type PromesaLegacyMigrationResult = { ok: true; mappings: Array<{ legacy_id: string; promesa_id: number; inserted: boolean }> } | Extract<PromesaMutationResult, { ok: false }>;

export interface GestionesReporteArgs {
  cliente?: string;
  tipo?: string;
  resultado?: string;
  desde?: string;
  hasta?: string;
}

export interface CampanaData {
  id?: number;
  nombre: string;
  descripcion?: string;
  fecha_inicio?: string;
  fecha_fin?: string;
  responsable?: string;
  clientes?: string[];
}

export interface DisputaData {
  id?: number;
  documento: string;
  cliente: string;
  monto?: number;
  motivo?: string;
  estado?: string;
  observacion?: string;
}

export interface CuentaAplicarData {
  id?: number;
  documento?: string;
  cliente: string;
  monto?: number;
  tipo?: string;
  estado?: string;
  fecha_aplicacion?: string;
  documento_aplicado?: string;
  observacion?: string;
}

export interface TopCliente {
  cliente: string;
  razon_social: string;
  total: number;
  percent: number;
}

export interface RiesgoCliente {
  cliente: string;
  razon_social: string;
  nivel: string;
  score: number;
  total: number;
}

export interface PronosticoMes {
  mes: string;
  proyectado: number;
  comprometido: number;
  riesgo: number;
}
