import type Database from 'better-sqlite3';
import type { BandejaOperativaError, BandejaOperativaQuery } from '../../src/types/bandejaOperativa';
import { listarBandejaOperativa, obtenerResumenBandejaOperativa } from '../repositories/bandejaOperativaRepository';
import { normalizeTareaDate } from '../repositories/tareaRepository';

const LIST_KEYS = new Set(['page','pageSize','cliente','origen','prioridad','fechaDesde','fechaHasta','sort','now']);
const SUMMARY_KEYS = new Set(['cliente','origen','prioridad','fechaDesde','fechaHasta','now']);
const PAGE_SIZES = [25,50,100];
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const invalid=(message:string):BandejaOperativaError=>({ok:false,code:'BANDEJA_INVALID',message});

function validDate(value:unknown):value is string {
  if(typeof value!=='string') return false;
  if(normalizeTareaDate(value)) return true;
  const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if(!match) return false;
  const date=new Date(Number(match[1]),Number(match[2])-1,Number(match[3]));
  return date.getFullYear()===Number(match[1])&&date.getMonth()===Number(match[2])-1&&date.getDate()===Number(match[3]);
}

export function validateBandejaOperativaQuery(payload:unknown,summary=false):BandejaOperativaQuery|BandejaOperativaError {
  if(payload!==undefined&&!record(payload)) return invalid('Contrato de Bandeja inválido.');
  const query=(payload??{}) as Record<string,unknown>, allowed=summary?SUMMARY_KEYS:LIST_KEYS;
  const unexpected=Object.keys(query).find(key=>!allowed.has(key));
  if(unexpected) return invalid(`Propiedad no permitida: ${unexpected}.`);
  if(!summary&&query.page!==undefined&&(!Number.isSafeInteger(query.page)||Number(query.page)<1)) return invalid('page inválida.');
  if(!summary&&query.pageSize!==undefined&&(!Number.isSafeInteger(query.pageSize)||!PAGE_SIZES.includes(Number(query.pageSize)))) return invalid('pageSize debe ser 25, 50 o 100.');
  if(query.cliente!==undefined&&(typeof query.cliente!=='string'||query.cliente.length>200)) return invalid('cliente inválido.');
  if(query.origen!==undefined&&!['TAREA','PROMESA','ALERTA'].includes(String(query.origen))) return invalid('origen inválido.');
  if(query.prioridad!==undefined&&!['ALTA','MEDIA','BAJA'].includes(String(query.prioridad))) return invalid('prioridad inválida.');
  if(!summary&&query.sort!==undefined&&!['PRIORIDAD','FECHA_ASC','FECHA_DESC'].includes(String(query.sort))) return invalid('sort inválido.');
  for(const key of ['fechaDesde','fechaHasta'] as const) if(query[key]!==undefined&&!validDate(query[key])) return invalid(`${key} inválida.`);
  if(query.now!==undefined&&!normalizeTareaDate(query.now)) return invalid('now inválido.');
  if(typeof query.fechaDesde==='string'&&typeof query.fechaHasta==='string'&&query.fechaDesde.slice(0,10)>query.fechaHasta.slice(0,10)) return invalid('El rango temporal es incoherente.');
  return query as BandejaOperativaQuery;
}

export function createBandejaOperativaIpcHandlers(db:Database.Database){return{
  bandejaOperativaListar(payload:unknown){const query=validateBandejaOperativaQuery(payload);if('ok'in query)return query;try{return listarBandejaOperativa(db,query);}catch{return{ok:false,code:'BANDEJA_ERROR',message:'No fue posible cargar la Bandeja Operativa.'} as const;}},
  bandejaOperativaResumen(payload:unknown){const query=validateBandejaOperativaQuery(payload,true);if('ok'in query)return query;try{return obtenerResumenBandejaOperativa(db,query);}catch{return{ok:false,code:'BANDEJA_ERROR',message:'No fue posible cargar el resumen de la Bandeja.'} as const;}},
};}
