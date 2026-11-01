/* CTE canónico D3.B. Los consumidores deben enlazar @now en hora local canónica. */
export const ALERTAS_OPERATIVAS_CTE = `WITH alertas_operativas AS (
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
