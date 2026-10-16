export const ALERTA_OPERATIVA_TIPOS = ['TAREA_VENCIDA', 'TAREA_HOY', 'PROMESA_POR_VENCER', 'PROMESA_VENCIDA', 'PROMESA_PARCIAL', 'CLIENTE_SIN_GESTION_RECIENTE'] as const;
export const ALERTA_OPERATIVA_PRIORIDADES = ['ALTA', 'MEDIA', 'BAJA'] as const;
export type AlertaOperativaTipo = typeof ALERTA_OPERATIVA_TIPOS[number];
export type AlertaOperativaPrioridad = typeof ALERTA_OPERATIVA_PRIORIDADES[number];
export interface AlertaOperativa { key:string; tipo:AlertaOperativaTipo; entidad_tipo:'tarea'|'promesa'|'cliente'; entidad_id:string; cliente:string; titulo:string; descripcion:string; prioridad:AlertaOperativaPrioridad; fecha_referencia:string; dias:number; monto_referencia:number|null; tarea_id:number|null; promesa_id:number|null; accion_sugerida:'ABRIR_TAREA'|'CREAR_SEGUIMIENTO'; }
export interface AlertaOperativaQuery { page?:number; pageSize?:number; tipo?:AlertaOperativaTipo; cliente?:string; prioridad?:AlertaOperativaPrioridad; search?:string; fechaDesde?:string; fechaHasta?:string; sort?:'FECHA_ASC'|'FECHA_DESC'|'PRIORIDAD'; now?:string; }
export interface AlertasOperativasResumen { total:number; altas:number; medias:number; bajas:number; tareasVencidas:number; tareasHoy:number; promesasVencidas:number; promesasPorVencer:number; promesasParciales:number; clientesSinGestion:number; }
export type AlertaOperativaError = {ok:false;code:'ALERTA_INVALID'|'ALERTA_ERROR';message:string};
export type AlertaOperativaListResult = import('./tarea').PaginatedResult<AlertaOperativa>|AlertaOperativaError;
export type AlertaOperativaResumenResult = AlertasOperativasResumen|AlertaOperativaError;
