import type Database from 'better-sqlite3';
import type { TareaTipo } from '../../src/types/tarea';
import type {
  BandejaCondicion, BandejaOperativaPaginatedResult, BandejaOperativaQuery,
  BandejaOperativaResumen, BandejaOperativaRow,
} from '../../src/types/bandejaOperativa';
import { normalizeTareaDate } from './tareaRepository';
import { ALERTAS_OPERATIVAS_CTE } from './alertaOperativaSql';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const PAGE_SIZES = [25, 50, 100] as const;
const ORIGINS = ['TAREA', 'PROMESA', 'ALERTA'] as const;
const PRIORITIES = ['ALTA', 'MEDIA', 'BAJA'] as const;
const SORTS = ['PRIORIDAD', 'FECHA_ASC', 'FECHA_DESC'] as const;

function localTimestamp(value = new Date()): string {
  const p = (part:number) => String(part).padStart(2, '0');
  return `${value.getFullYear()}-${p(value.getMonth()+1)}-${p(value.getDate())} ${p(value.getHours())}:${p(value.getMinutes())}:${p(value.getSeconds())}`;
}

function validDate(value:unknown): value is string {
  if (typeof value !== 'string') return false;
  if (normalizeTareaDate(value)) return true;
  const match = DATE_ONLY.exec(value);
  if (!match) return false;
  const date = new Date(Number(match[1]), Number(match[2])-1, Number(match[3]));
  return date.getFullYear()===Number(match[1]) && date.getMonth()===Number(match[2])-1 && date.getDate()===Number(match[3]);
}

type Normalized = BandejaOperativaQuery & { page:number; pageSize:25|50|100; now:string };
function normalize(query:BandejaOperativaQuery):Normalized {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 25;
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('page inválida.');
  if (!PAGE_SIZES.includes(pageSize as never)) throw new Error('pageSize inválido; use 25, 50 o 100.');
  if (query.cliente !== undefined && typeof query.cliente !== 'string') throw new Error('cliente inválido.');
  if (query.origen !== undefined && !ORIGINS.includes(query.origen as never)) throw new Error('origen inválido.');
  if (query.prioridad !== undefined && !PRIORITIES.includes(query.prioridad as never)) throw new Error('prioridad inválida.');
  if (query.sort !== undefined && !SORTS.includes(query.sort as never)) throw new Error('sort inválido.');
  if (query.fechaDesde !== undefined && !validDate(query.fechaDesde)) throw new Error('fechaDesde inválida.');
  if (query.fechaHasta !== undefined && !validDate(query.fechaHasta)) throw new Error('fechaHasta inválida.');
  const now = query.now ?? localTimestamp();
  if (!normalizeTareaDate(now)) throw new Error('now inválido.');
  return { ...query, page, pageSize, now };
}

const BANDEJA_CTE = `${ALERTAS_OPERATIVAS_CTE},
alertas_por_tarea AS (
 SELECT tarea_id,
  (SELECT json_group_array(json_object('key',ordenada.key,'tipo',ordenada.tipo,'prioridad',ordenada.prioridad))
   FROM (SELECT key,tipo,prioridad FROM alertas_operativas ordenable
     WHERE ordenable.tarea_id=agrupada.tarea_id
     ORDER BY CASE prioridad WHEN 'ALTA' THEN 1 WHEN 'MEDIA' THEN 2 ELSE 3 END,
      datetime(fecha_referencia),key) ordenada) condiciones,
  MAX(CASE prioridad WHEN 'ALTA' THEN 3 WHEN 'MEDIA' THEN 2 ELSE 1 END) prioridad_rango,
  MAX(tipo='TAREA_VENCIDA') es_vencida,MAX(tipo='TAREA_HOY') es_hoy
 FROM alertas_operativas agrupada WHERE tarea_id IS NOT NULL GROUP BY tarea_id
),
alertas_por_promesa AS (
 SELECT promesa_id,
  (SELECT json_group_array(json_object('key',ordenada.key,'tipo',ordenada.tipo,'prioridad',ordenada.prioridad))
   FROM (SELECT key,tipo,prioridad FROM alertas_operativas ordenable
     WHERE ordenable.promesa_id=agrupada.promesa_id
     ORDER BY CASE prioridad WHEN 'ALTA' THEN 1 WHEN 'MEDIA' THEN 2 ELSE 3 END,
      datetime(fecha_referencia),key) ordenada) condiciones,
  MAX(CASE prioridad WHEN 'ALTA' THEN 3 WHEN 'MEDIA' THEN 2 ELSE 1 END) prioridad_rango,
  MAX(tipo='PROMESA_VENCIDA') es_vencida
 FROM alertas_operativas agrupada WHERE promesa_id IS NOT NULL GROUP BY promesa_id
),
tareas_bandeja AS (
 SELECT 'TAREA:'||t.id key,'TAREA' origen,t.cliente,t.titulo,COALESCE(t.descripcion,'Seguimiento pendiente') descripcion,
  CASE WHEN a.prioridad_rango=3 THEN 'ALTA' WHEN a.prioridad_rango=2 THEN 'MEDIA' WHEN a.prioridad_rango=1 THEN 'BAJA' ELSE t.prioridad END prioridad,
  t.fecha_programada fecha_referencia,COALESCE(a.condiciones,'[]') condiciones,
  t.id tarea_id,t.promesa_id,t.estado,CASE WHEN datetime(t.fecha_programada)<datetime(@now) THEN 'VENCIDA' WHEN date(t.fecha_programada)=date(@now) THEN 'HOY' ELSE 'PROXIMA' END estado_operativo,
  t.version,t.tipo tipo_tarea,t.responsable,NULL alerta_tipo,NULL monto_referencia,NULL monto_prometido,NULL monto_pagado,NULL saldo_promesa,
  COALESCE(a.es_vencida,0) es_vencida,COALESCE(a.es_hoy,0) es_hoy
 FROM tareas t LEFT JOIN alertas_por_tarea a ON a.tarea_id=t.id WHERE t.estado IN('PENDIENTE','EN_PROGRESO')
),
promesas_bandeja AS (
 SELECT 'PROMESA:'||p.id,'PROMESA',p.cliente,'Promesa de pago','Compromiso de pago accionable',
  CASE WHEN a.prioridad_rango=3 THEN 'ALTA' WHEN a.prioridad_rango=2 THEN 'MEDIA' WHEN a.prioridad_rango=1 THEN 'BAJA' ELSE 'MEDIA' END,
  p.fecha_promesa,COALESCE(a.condiciones,'[]'),NULL,p.id,p.estado,NULL,NULL,NULL,NULL,NULL,NULL,p.monto_prometido,p.monto_pagado,MAX(p.monto_prometido-p.monto_pagado,0),COALESCE(a.es_vencida,0),0
 FROM promesas p LEFT JOIN alertas_por_promesa a ON a.promesa_id=p.id WHERE p.estado IN('PENDIENTE','CUMPLIDA_PARCIAL')
),
alertas_autonomas AS (
 SELECT key,'ALERTA',cliente,titulo,descripcion,prioridad,fecha_referencia,
  json_array(json_object('key',key,'tipo',tipo,'prioridad',prioridad)),NULL,NULL,NULL,NULL,NULL,NULL,NULL,tipo,
  (SELECT SUM(d.saldo_pendiente) FROM documentos d
   WHERE TRIM(d.cliente)=TRIM(a.cliente) COLLATE NOCASE AND d.is_subtotal=0
    AND d.posicion_cartera='DEUDA_VIVA' AND COALESCE(d.saldo_pendiente,0)>0
    AND COALESCE(d.estado_documento,'ACTIVO')<>'ANULADO'
    AND UPPER(TRIM(COALESCE(d.tipo_documento,'')))<>'NCT'),NULL,NULL,NULL,0,0
 FROM alertas_operativas a
 WHERE tarea_id IS NULL AND promesa_id IS NULL
   AND EXISTS (
     SELECT 1 FROM documentos d
     WHERE TRIM(d.cliente)=TRIM(a.cliente) COLLATE NOCASE
       AND d.is_subtotal=0
       AND d.posicion_cartera='DEUDA_VIVA'
       AND COALESCE(d.saldo_pendiente,0)>0
       AND COALESCE(d.estado_documento,'ACTIVO')<>'ANULADO'
       AND UPPER(TRIM(COALESCE(d.tipo_documento,'')))<>'NCT'
   )
),
bandeja AS (SELECT * FROM tareas_bandeja UNION ALL SELECT * FROM promesas_bandeja UNION ALL SELECT * FROM alertas_autonomas)`;

function filters(query:Normalized) {
  const clauses:string[]=[];
  const params:Record<string,unknown>={now:query.now};
  if (query.cliente?.trim()) { clauses.push("cliente LIKE @cliente ESCAPE '\\'"); params.cliente=`%${query.cliente.trim().replace(/[\\%_]/g,'\\$&')}%`; }
  if (query.origen) { clauses.push('origen=@origen'); params.origen=query.origen; }
  if (query.prioridad) { clauses.push('prioridad=@prioridad'); params.prioridad=query.prioridad; }
  if (query.fechaDesde) { clauses.push('date(fecha_referencia)>=date(@fechaDesde)'); params.fechaDesde=query.fechaDesde; }
  if (query.fechaHasta) { clauses.push('date(fecha_referencia)<=date(@fechaHasta)'); params.fechaHasta=query.fechaHasta; }
  return { sql:clauses.length?` WHERE ${clauses.join(' AND ')}`:'', params };
}

const SELECT_COLUMNS = `key,origen,cliente,titulo,descripcion,prioridad,fecha_referencia,condiciones,
 tarea_id,promesa_id,estado,estado_operativo,version,tipo_tarea,responsable,alerta_tipo,monto_referencia,monto_prometido,monto_pagado,saldo_promesa`;
type SqlRow = Record<string, unknown> & { condiciones:string; origen:'TAREA'|'PROMESA'|'ALERTA' };
function mapRow(row:SqlRow):BandejaOperativaRow {
  const condiciones=JSON.parse(row.condiciones) as BandejaCondicion[];
  const base={key:String(row.key),origen:row.origen,cliente:String(row.cliente),titulo:String(row.titulo),descripcion:String(row.descripcion),prioridad:row.prioridad as 'ALTA'|'MEDIA'|'BAJA',fecha_referencia:String(row.fecha_referencia),condiciones};
  if(row.origen==='TAREA') return {...base,origen:'TAREA',tarea_id:Number(row.tarea_id),promesa_id:row.promesa_id==null?null:Number(row.promesa_id),estado:row.estado as 'PENDIENTE'|'EN_PROGRESO',estado_operativo:row.estado_operativo as 'VENCIDA'|'HOY'|'PROXIMA',version:Number(row.version),tipo_tarea:row.tipo_tarea as TareaTipo,responsable:String(row.responsable)};
  if(row.origen==='PROMESA') return {...base,origen:'PROMESA',promesa_id:Number(row.promesa_id),estado:row.estado as 'PENDIENTE'|'CUMPLIDA_PARCIAL',monto_prometido:Number(row.monto_prometido),monto_pagado:Number(row.monto_pagado),saldo_promesa:Number(row.saldo_promesa)};
  return {...base,origen:'ALERTA',alerta_tipo:row.alerta_tipo as 'CLIENTE_SIN_GESTION_RECIENTE',tarea_id:null,promesa_id:null,monto_referencia:row.monto_referencia==null?null:Number(row.monto_referencia)};
}

function order(sort:Normalized['sort']):string {
  const tie="CASE origen WHEN 'TAREA' THEN 1 WHEN 'PROMESA' THEN 2 ELSE 3 END,key";
  if(sort==='FECHA_ASC') return `datetime(fecha_referencia) ASC,CASE prioridad WHEN 'ALTA' THEN 1 WHEN 'MEDIA' THEN 2 ELSE 3 END,${tie}`;
  if(sort==='FECHA_DESC') return `datetime(fecha_referencia) DESC,CASE prioridad WHEN 'ALTA' THEN 1 WHEN 'MEDIA' THEN 2 ELSE 3 END,${tie}`;
  return `CASE prioridad WHEN 'ALTA' THEN 1 WHEN 'MEDIA' THEN 2 ELSE 3 END,datetime(fecha_referencia) ASC,${tie}`;
}

export function listarBandejaOperativa(db:Database.Database,query:BandejaOperativaQuery={}):BandejaOperativaPaginatedResult {
  const q=normalize(query), filter=filters(q);
  const total=Number(db.prepare(`${BANDEJA_CTE} SELECT COUNT(*) FROM bandeja${filter.sql}`).pluck().get(filter.params));
  const rows=db.prepare(`${BANDEJA_CTE} SELECT ${SELECT_COLUMNS} FROM bandeja${filter.sql} ORDER BY ${order(q.sort)} LIMIT @limit OFFSET @offset`)
    .all({...filter.params,limit:q.pageSize,offset:(q.page-1)*q.pageSize}) as SqlRow[];
  return {items:rows.map(mapRow),total,page:q.page,pageSize:q.pageSize,totalPages:Math.ceil(total/q.pageSize)};
}

export function obtenerResumenBandejaOperativa(db:Database.Database,query:Omit<BandejaOperativaQuery,'page'|'pageSize'|'sort'>={}):BandejaOperativaResumen {
  const q=normalize(query), filter=filters(q);
  const row=db.prepare(`${BANDEJA_CTE} SELECT COUNT(*) totalAcciones,SUM(origen='TAREA') tareas,SUM(origen='PROMESA') promesas,SUM(origen='ALERTA') alertasAutonomas,
   SUM(prioridad='ALTA') altas,SUM(prioridad='MEDIA') medias,SUM(prioridad='BAJA') bajas,COUNT(DISTINCT lower(trim(cliente))) clientesUnicos,SUM(es_vencida) vencidas,SUM(es_hoy) paraHoy
   FROM bandeja${filter.sql}`).get(filter.params) as Record<string,number|null>;
  return {totalAcciones:Number(row.totalAcciones),tareas:Number(row.tareas),promesas:Number(row.promesas),alertasAutonomas:Number(row.alertasAutonomas),altas:Number(row.altas),medias:Number(row.medias),bajas:Number(row.bajas),clientesUnicos:Number(row.clientesUnicos),vencidas:Number(row.vencidas),paraHoy:Number(row.paraHoy)};
}

export const BANDEJA_OPERATIVA_SQL = BANDEJA_CTE;
