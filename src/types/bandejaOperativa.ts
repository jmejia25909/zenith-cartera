import type { AlertaOperativaPrioridad, AlertaOperativaTipo } from './alertaOperativa';
import type { PromesaState } from './api.types';
import type { TareaEstado, TareaEstadoOperativo, TareaTipo } from './tarea';

export type BandejaOrigen = 'TAREA' | 'PROMESA' | 'ALERTA';
export type BandejaPrioridad = AlertaOperativaPrioridad;
export type BandejaSort = 'PRIORIDAD' | 'FECHA_ASC' | 'FECHA_DESC';
export interface BandejaCondicion { key:string; tipo:AlertaOperativaTipo; prioridad:BandejaPrioridad }
interface BandejaBase { key:string; origen:BandejaOrigen; cliente:string; titulo:string; descripcion:string; prioridad:BandejaPrioridad; fecha_referencia:string; condiciones:BandejaCondicion[] }
export interface BandejaTareaRow extends BandejaBase { origen:'TAREA'; tarea_id:number; promesa_id:number|null; estado:Extract<TareaEstado,'PENDIENTE'|'EN_PROGRESO'>; estado_operativo:Extract<TareaEstadoOperativo,'VENCIDA'|'HOY'|'PROXIMA'>; version:number; tipo_tarea:TareaTipo; responsable:string }
export interface BandejaPromesaRow extends BandejaBase { origen:'PROMESA'; promesa_id:number; estado:Extract<PromesaState,'PENDIENTE'|'CUMPLIDA_PARCIAL'>; monto_prometido:number; monto_pagado:number; saldo_promesa:number }
export interface BandejaAlertaRow extends BandejaBase { origen:'ALERTA'; alerta_tipo:'CLIENTE_SIN_GESTION_RECIENTE'; tarea_id:null; promesa_id:null; monto_referencia:number|null }
export type BandejaOperativaRow = BandejaTareaRow | BandejaPromesaRow | BandejaAlertaRow;
export interface BandejaOperativaQuery { page?:number; pageSize?:25|50|100; cliente?:string; origen?:BandejaOrigen; prioridad?:BandejaPrioridad; fechaDesde?:string; fechaHasta?:string; sort?:BandejaSort; now?:string }
export interface BandejaOperativaResumen { totalAcciones:number; tareas:number; promesas:number; alertasAutonomas:number; altas:number; medias:number; bajas:number; clientesUnicos:number; vencidas:number; paraHoy:number }
export interface BandejaOperativaPaginatedResult { items:BandejaOperativaRow[]; total:number; page:number; pageSize:25|50|100; totalPages:number }
export type BandejaOperativaError = { ok:false; code:'BANDEJA_INVALID'|'BANDEJA_ERROR'; message:string };
export type BandejaOperativaListResult = BandejaOperativaPaginatedResult | BandejaOperativaError;
export type BandejaOperativaResumenResult = BandejaOperativaResumen | BandejaOperativaError;
