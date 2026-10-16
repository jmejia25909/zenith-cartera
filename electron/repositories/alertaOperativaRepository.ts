import type Database from 'better-sqlite3';
import type { AlertaOperativa, AlertaOperativaQuery, AlertasOperativasResumen } from '../../src/types/alertaOperativa';
import type { PaginatedResult } from '../../src/types/tarea';

/* Las dos condiciones de Tarea son la traducción SQL exacta de deriveTareaEstadoOperativo:
   abierta + instante anterior => VENCIDA; misma fecha local y no anterior => HOY. */
const ALERTS_CTE = `WITH alertas_operativas AS (
 SELECT 'TAREA_VENCIDA:tarea:'||t.id key,'TAREA_VENCIDA' tipo,'tarea' entidad_tipo,CAST(t.id AS TEXT) entidad_id,t.cliente,
  'Tarea vencida: '||t.titulo titulo,COALESCE(t.descripcion,'Seguimiento pendiente') descripcion,
  CASE WHEN CAST(julianday(date(@now))-julianday(date(t.fecha_programada)) AS INTEGER)>3 THEN 'ALTA' ELSE 'MEDIA' END prioridad,
  t.fecha_programada fecha_referencia,CAST(julianday(date(@now))-julianday(date(t.fecha_programada)) AS INTEGER) dias,NULL monto_referencia,t.id tarea_id,NULL promesa_id,'ABRIR_TAREA' accion_sugerida
 FROM tareas t WHERE t.estado IN('PENDIENTE','EN_PROGRESO') AND datetime(t.fecha_programada)<datetime(@now)
 UNION ALL
 SELECT 'TAREA_HOY:tarea:'||t.id,'TAREA_HOY','tarea',CAST(t.id AS TEXT),t.cliente,'Tarea para hoy: '||t.titulo,COALESCE(t.descripcion,'Seguimiento programado para hoy'),'MEDIA',t.fecha_programada,0,NULL,t.id,NULL,'ABRIR_TAREA'
 FROM tareas t WHERE t.estado IN('PENDIENTE','EN_PROGRESO') AND datetime(t.fecha_programada)>=datetime(@now) AND date(t.fecha_programada)=date(@now)
 UNION ALL
 SELECT 'PROMESA_POR_VENCER:promesa:'||p.id,'PROMESA_POR_VENCER','promesa',CAST(p.id AS TEXT),p.cliente,'Promesa por vencer','Compromiso de pago próximo','MEDIA',p.fecha_promesa,CAST(julianday(date(p.fecha_promesa))-julianday(date(@now)) AS INTEGER),p.monto_prometido-p.monto_pagado,NULL,p.id,'CREAR_SEGUIMIENTO'
 FROM promesas p WHERE p.estado IN('PENDIENTE','CUMPLIDA_PARCIAL') AND date(p.fecha_promesa) BETWEEN date(@now) AND date(@now,'+3 days') /* INCUMPLIDA se excluye por política operativa D3.B: incumplimiento ya reconocido, aunque sea reprogramable. */
 UNION ALL
 SELECT 'PROMESA_VENCIDA:promesa:'||p.id,'PROMESA_VENCIDA','promesa',CAST(p.id AS TEXT),p.cliente,'Promesa vencida','Compromiso de pago vencido','ALTA',p.fecha_promesa,CAST(julianday(date(@now))-julianday(date(p.fecha_promesa)) AS INTEGER),p.monto_prometido-p.monto_pagado,NULL,p.id,'CREAR_SEGUIMIENTO'
 FROM promesas p WHERE p.estado IN('PENDIENTE','CUMPLIDA_PARCIAL') AND date(p.fecha_promesa)<date(@now)
 UNION ALL
 SELECT 'PROMESA_PARCIAL:promesa:'||p.id,'PROMESA_PARCIAL','promesa',CAST(p.id AS TEXT),p.cliente,'Promesa parcialmente cumplida','Existe saldo pendiente del compromiso',CASE WHEN date(p.fecha_promesa)<date(@now) THEN 'ALTA' ELSE 'MEDIA' END,p.fecha_promesa,CAST(julianday(date(@now))-julianday(date(p.fecha_promesa)) AS INTEGER),p.monto_prometido-p.monto_pagado,NULL,p.id,'CREAR_SEGUIMIENTO'
 FROM promesas p WHERE p.estado='CUMPLIDA_PARCIAL' AND p.monto_prometido>p.monto_pagado
 UNION ALL
 SELECT 'CLIENTE_SIN_GESTION_RECIENTE:cliente:'||lower(hex(lower(trim(d.cliente)))),'CLIENTE_SIN_GESTION_RECIENTE','cliente',lower(trim(d.cliente)),trim(d.cliente),'Cliente sin gestión reciente','Cartera activa sin gestión durante los últimos 30 días','MEDIA',date(@now),30,SUM(d.saldo_pendiente),NULL,NULL,'CREAR_SEGUIMIENTO'
 FROM documentos d WHERE d.is_subtotal=0 AND d.posicion_cartera='DEUDA_VIVA' AND COALESCE(d.saldo_pendiente,0)>0 AND COALESCE(d.estado_documento,'ACTIVO')<>'ANULADO' AND TRIM(COALESCE(d.cliente,''))<>''
  AND NOT EXISTS(SELECT 1 FROM gestiones g WHERE trim(g.cliente)=trim(d.cliente) COLLATE NOCASE AND datetime(g.fecha)>=datetime(@now,'-30 days'))
 GROUP BY lower(trim(d.cliente))
)`;

function where(query:AlertaOperativaQuery){const clauses:string[]=[];const params:Record<string,unknown>={now:query.now??new Date().toLocaleString('sv-SE').replace('T',' ')};if(query.tipo){clauses.push('tipo=@tipo');params.tipo=query.tipo;}if(query.cliente){clauses.push('cliente LIKE @cliente');params.cliente=`%${query.cliente}%`;}if(query.prioridad){clauses.push('prioridad=@prioridad');params.prioridad=query.prioridad;}if(query.search){clauses.push('(cliente LIKE @search OR titulo LIKE @search OR descripcion LIKE @search)');params.search=`%${query.search}%`;}if(query.fechaDesde){clauses.push('datetime(fecha_referencia)>=datetime(@fechaDesde)');params.fechaDesde=query.fechaDesde;}if(query.fechaHasta){clauses.push('datetime(fecha_referencia)<=datetime(@fechaHasta)');params.fechaHasta=query.fechaHasta;}return{sql:clauses.length?` WHERE ${clauses.join(' AND ')}`:'',params};}
export function listAlertasOperativas(db:Database.Database,query:AlertaOperativaQuery={}):PaginatedResult<AlertaOperativa>{const page=Math.max(1,query.page??1),pageSize=Math.min(100,Math.max(1,query.pageSize??25));const filter=where(query);const total=Number(db.prepare(`${ALERTS_CTE} SELECT COUNT(*) FROM alertas_operativas${filter.sql}`).pluck().get(filter.params));const order=query.sort==='FECHA_ASC'?'datetime(fecha_referencia),key':query.sort==='PRIORIDAD'?"CASE prioridad WHEN 'ALTA' THEN 1 WHEN 'MEDIA' THEN 2 ELSE 3 END,datetime(fecha_referencia),key":'datetime(fecha_referencia) DESC,key';const items=db.prepare(`${ALERTS_CTE} SELECT * FROM alertas_operativas${filter.sql} ORDER BY ${order} LIMIT @limit OFFSET @offset`).all({...filter.params,limit:pageSize,offset:(page-1)*pageSize}) as AlertaOperativa[];return{items,page,pageSize,total,totalPages:Math.ceil(total/pageSize)};}
export function getAlertasOperativasResumen(db:Database.Database,query:Pick<AlertaOperativaQuery,'tipo'|'cliente'|'prioridad'|'search'|'fechaDesde'|'fechaHasta'|'now'>={}):AlertasOperativasResumen{const filter=where(query);const row=db.prepare(`${ALERTS_CTE} SELECT COUNT(*) total,SUM(prioridad='ALTA') altas,SUM(prioridad='MEDIA') medias,SUM(prioridad='BAJA') bajas,SUM(tipo='TAREA_VENCIDA') tareasVencidas,SUM(tipo='TAREA_HOY') tareasHoy,SUM(tipo='PROMESA_VENCIDA') promesasVencidas,SUM(tipo='PROMESA_POR_VENCER') promesasPorVencer,SUM(tipo='PROMESA_PARCIAL') promesasParciales,SUM(tipo='CLIENTE_SIN_GESTION_RECIENTE') clientesSinGestion FROM alertas_operativas${filter.sql}`).get(filter.params) as Record<string,number|null>;return{total:Number(row.total),altas:Number(row.altas),medias:Number(row.medias),bajas:Number(row.bajas),tareasVencidas:Number(row.tareasVencidas),tareasHoy:Number(row.tareasHoy),promesasVencidas:Number(row.promesasVencidas),promesasPorVencer:Number(row.promesasPorVencer),promesasParciales:Number(row.promesasParciales),clientesSinGestion:Number(row.clientesSinGestion)};}
