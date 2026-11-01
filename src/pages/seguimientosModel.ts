import type {
  Tarea,
  TareaCreateInput,
  TareaErrorResult,
  TareaEventListQuery,
  TareaEventListResult,
  TareaEditRequest,
  TareaListQuery,
  TareaListResult,
  TareaMutationResult,
} from '../types/tarea';

export type SeguimientosApi = Pick<NonNullable<Window['carteraApi']>,
  'tareasListar' | 'tareaCrear' | 'tareaEditar' | 'tareaCambiarEstado' |
  'tareaCompletar' | 'tareaCancelar' | 'tareaEventosListar'> & Partial<Pick<NonNullable<Window['carteraApi']>,
  'tareaObtener'|'alertasOperativasListar'|'alertasOperativasResumen'|'bandejaOperativaListar'|'bandejaOperativaResumen'>>;

export const SEGUIMIENTO_VIEWS = ['HOY', 'VENCIDA', 'PROXIMA', 'COMPLETADA', 'TODAS'] as const;
export type SeguimientoView = typeof SEGUIMIENTO_VIEWS[number];

export interface HistoryRequestToken { sequence: number; tareaId: number; page: number }

export function createHistoryRequestGuard() {
  let sequence = 0;
  return {
    begin(tareaId: number, page: number): HistoryRequestToken { return { sequence: ++sequence, tareaId, page }; },
    invalidate(): void { sequence += 1; },
    isCurrent(token: HistoryRequestToken, tareaId: number | null, page: number, open: boolean): boolean {
      return open && token.sequence === sequence && token.tareaId === tareaId && token.page === page;
    },
  };
}

export function normalizedPage(currentPage: number, totalPages: number): number {
  if (totalPages <= 0) return 1;
  return Math.min(Math.max(1, currentPage), totalPages);
}
export function createLatestRequestGuard(){let sequence=0;return{begin(){return++sequence;},invalidate(){sequence+=1;},isCurrent(token:number){return token===sequence;}};}

export function canonicalNow(value = new Date()): string {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

export function datetimeLocalToCanonical(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/.exec(value.trim());
  return match ? `${match[1]} ${match[2]}:${match[3] ?? '00'}` : null;
}

export function canonicalToDatetimeLocal(value: string): string {
  return value.length >= 16 ? `${value.slice(0, 10)}T${value.slice(11, 16)}` : '';
}

export function friendlyTaskDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):\d{2}$/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]} ${match[4]}:${match[5]}` : value;
}

export function tareaOrigin(tarea: Pick<Tarea, 'gestion_origen_id' | 'promesa_id'>): string {
  if (tarea.gestion_origen_id != null) return `Gestión #${tarea.gestion_origen_id}`;
  if (tarea.promesa_id != null) return `Promesa #${tarea.promesa_id}`;
  return 'Sin vínculo';
}

export function taskErrorMessage(error: TareaErrorResult): string {
  if (error.code === 'TAREA_VERSION_CONFLICT') return 'La tarea fue modificada en otra ventana. Actualice la información antes de continuar.';
  if (error.code === 'TAREA_NOT_FOUND') return 'La tarea ya no existe. Actualice el listado.';
  if (error.code === 'TAREA_INVALID') return error.message || 'Los datos de la tarea no son válidos.';
  return error.message;
}

export function buildTaskQuery(view: SeguimientoView, filters: Omit<TareaListQuery, 'page' | 'pageSize' | 'estado' | 'now'>, page: number, pageSize: number, now = canonicalNow()): TareaListQuery {
  return {
    ...filters,
    page,
    pageSize,
    sort: filters.sort ?? 'FECHA_ASC',
    now,
    ...(view === 'TODAS' ? {} : { estado: view }),
  };
}

export function isTaskError(result: TareaListResult | TareaEventListResult): result is TareaErrorResult {
  return 'ok' in result && result.ok === false;
}

export function createSeguimientosClient(api: SeguimientosApi) {
  return {
    list: (query: TareaListQuery): Promise<TareaListResult> => api.tareasListar(query),
    count: async (estado: Exclude<SeguimientoView, 'TODAS'>, now = canonicalNow()): Promise<number> => {
      const result = await api.tareasListar({ estado, page: 1, pageSize: 1, now });
      if (isTaskError(result)) throw result;
      return result.total;
    },
    create: (input: TareaCreateInput): Promise<TareaMutationResult> => api.tareaCrear(input),
    edit: (tarea: Tarea, changes: Omit<TareaEditRequest, 'id' | 'expectedVersion'>): Promise<TareaMutationResult> => api.tareaEditar({ ...changes, id: tarea.id, expectedVersion: tarea.version }),
    changeState: (tarea: Tarea, estado: 'PENDIENTE' | 'EN_PROGRESO'): Promise<TareaMutationResult> => api.tareaCambiarEstado({ id: tarea.id, expectedVersion: tarea.version, estado }),
    complete: (tarea: Tarea): Promise<TareaMutationResult> => api.tareaCompletar({ id: tarea.id, expectedVersion: tarea.version }),
    cancel: (tarea: Tarea, motivo?: string): Promise<TareaMutationResult> => api.tareaCancelar({ id: tarea.id, expectedVersion: tarea.version, motivo }),
    events: (query: TareaEventListQuery): Promise<TareaEventListResult> => api.tareaEventosListar(query),
  };
}
