import { beginReleaseUpgrade, completeReleaseUpgrade, validateReleaseSchema } from "./releaseUpgrade";
import type { ReleaseUpgradeContext } from "./releaseUpgrade";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import Database from "better-sqlite3";
import { ensureEvidenceAttributionBaseline } from "./reconciliation/evidenceAttribution";
import {
  assertDatabaseIntegrity,
  initializeDataSafety,
  restoreDatabaseFile,
} from "./databaseSafety";
import type { DataSafetyResult } from "./databaseSafety";
import { recoverPendingBackup } from "./sqliteBackup";

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function tableHasColumn(db: Database.Database, table: string, col: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => String(r.name).toLowerCase() === col.toLowerCase());
}

function ensureGestionLegacyMigrationSchema(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(gestion_legacy_migrations)").all() as Array<{ name: string; notnull: number }>;
  const gestionId = columns.find((column) => column.name === "gestion_id");
  const requiresRebuild = Boolean(gestionId?.notnull) || !columns.some((column) => column.name === "deleted_at");
  if (!requiresRebuild) return;

  db.transaction(() => {
    db.exec(`
      CREATE TABLE gestion_legacy_migrations_v2 (
        source TEXT NOT NULL,
        legacy_id TEXT NOT NULL,
        gestion_id INTEGER NULL,
        migrated_at TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        deleted_at TEXT NULL,
        PRIMARY KEY (source, legacy_id),
        FOREIGN KEY (gestion_id) REFERENCES gestiones(id)
      );
      INSERT INTO gestion_legacy_migrations_v2
        (source, legacy_id, gestion_id, migrated_at, payload_hash, deleted_at)
      SELECT source, legacy_id, gestion_id, migrated_at,
             COALESCE(payload_hash, ''), NULL
      FROM gestion_legacy_migrations;
      DROP TABLE gestion_legacy_migrations;
      ALTER TABLE gestion_legacy_migrations_v2 RENAME TO gestion_legacy_migrations;
      CREATE INDEX idx_gestion_legacy_migrations_gestion ON gestion_legacy_migrations(gestion_id);
    `);
  })();
}

function ensureSchema(db: Database.Database) {
      // Tabla de campañas de cobranza
      db.exec(`
        CREATE TABLE IF NOT EXISTS campanas (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          nombre TEXT NOT NULL,
          descripcion TEXT,
          fecha_inicio TEXT,
          fecha_fin TEXT,
          responsable TEXT,
          creado_en TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS campana_clientes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          campana_id INTEGER NOT NULL,
          cliente TEXT NOT NULL,
          asignado_en TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (campana_id) REFERENCES campanas(id),
          FOREIGN KEY (cliente) REFERENCES clientes(cliente)
        );
        CREATE INDEX IF NOT EXISTS idx_campana_clientes_campana ON campana_clientes(campana_id);
        CREATE INDEX IF NOT EXISTS idx_campana_clientes_cliente ON campana_clientes(cliente);
      `);
    // Nueva tabla para historial de abonos y cambios de estado
    db.exec(`
      CREATE TABLE IF NOT EXISTS abonos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        documento TEXT NOT NULL,
        total_anterior REAL NOT NULL,
        total_nuevo REAL NOT NULL,
        fecha TEXT NOT NULL DEFAULT (datetime('now')),
        observacion TEXT DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_abonos_documento ON abonos(documento);
    `);

    // Conciliación financiera mensual.
    db.exec(`
      CREATE TABLE IF NOT EXISTS conciliaciones_cobros (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        anio INTEGER NOT NULL,
        mes INTEGER NOT NULL,
        valor_detectado REAL NOT NULL DEFAULT 0,
        valor_oficial REAL NOT NULL DEFAULT 0,
        diferencia REAL NOT NULL DEFAULT 0,
        movimientos_detectados INTEGER NOT NULL DEFAULT 0,
        estado TEXT NOT NULL DEFAULT 'CONCILIADO'
          CHECK (estado IN ('CONCILIADO', 'ANULADO')),
        observacion TEXT DEFAULT '',
        conciliado_por TEXT NOT NULL DEFAULT 'sistema',
        conciliado_en TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        actualizado_en TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE(anio, mes)
      );

      CREATE INDEX IF NOT EXISTS idx_conciliaciones_cobros_periodo
        ON conciliaciones_cobros(anio, mes);

      CREATE INDEX IF NOT EXISTS idx_conciliaciones_cobros_estado
        ON conciliaciones_cobros(estado);
    `);



  // LIMPIEZA: Eliminar columnas de aging estático si existen (ahora se calculan dinámicamente)
  const agingCols = ["por_vencer", "dias_30", "dias_60", "dias_90", "dias_120", "dias_mas_120"];
  for (const col of agingCols) {
    if (tableHasColumn(db, "documentos", col)) {
      try {
        db.exec(`ALTER TABLE documentos DROP COLUMN ${col}`);
      } catch {
        // Ignorar si la versión de SQLite no soporta DROP COLUMN o si falla
      }
    }
  }

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente TEXT NOT NULL UNIQUE,
      razon_social TEXT,
      vendedor TEXT, 
      telefono TEXT DEFAULT '',
      email TEXT DEFAULT '',
      direccion TEXT DEFAULT '',
      contacto TEXT DEFAULT '',
      creado_en TEXT NOT NULL DEFAULT (datetime('now'))
    );

    /*
      Tabla principal: cartera importada desde Contifico (CarteraPorCobrar).
      Nota: en el Excel existen filas "subtotal" por cliente donde "Tipo Documento" viene vacío.
      Esas filas se guardan con is_subtotal=1 para poder usarlas (opcionalmente) en reportes,
      pero la vista de "Documentos" debe filtrar is_subtotal=0.
    */
    CREATE TABLE IF NOT EXISTS documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente TEXT,
      razon_social TEXT,
      tipo_documento TEXT,
      documento TEXT,
      fecha_emision TEXT,
      fecha_vencimiento TEXT,
      vendedor TEXT,
      total REAL DEFAULT 0,
      descripcion TEXT,
      valor_documento REAL DEFAULT 0,
      retenciones REAL DEFAULT 0,
      iva REAL DEFAULT 0,
      cobros REAL DEFAULT 0,
      is_subtotal INTEGER NOT NULL DEFAULT 0,
      importado_en TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_doc_cliente ON documentos(cliente);
    CREATE INDEX IF NOT EXISTS idx_doc_venc ON documentos(fecha_vencimiento);
    CREATE INDEX IF NOT EXISTS idx_doc_total ON documentos(total);

    CREATE TABLE IF NOT EXISTS empresa (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      nombre TEXT DEFAULT 'Mi Empresa',
      direccion TEXT DEFAULT '',
      telefono TEXT DEFAULT '',
      email TEXT DEFAULT '',
      ruc TEXT DEFAULT '',
      administrador TEXT DEFAULT '',
      iva_percent REAL DEFAULT 15.0,
      meta_mensual REAL DEFAULT 100000,
      logo TEXT
    );

    /* Tabla de Gestiones (CRM) */
    CREATE TABLE IF NOT EXISTS gestiones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente TEXT NOT NULL,
      fecha TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      tipo TEXT, -- Llamada, Visita, WhatsApp, Email
      resultado TEXT, -- Contactado, No contesta, Promesa, etc.
      observacion TEXT,
      fecha_promesa TEXT,
      monto_promesa REAL DEFAULT 0,
      usuario TEXT DEFAULT 'sistema',
      creado_en TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      actualizado_en TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_gestiones_cliente ON gestiones(cliente);

    CREATE TABLE IF NOT EXISTS gestion_legacy_migrations (
      source TEXT NOT NULL,
      legacy_id TEXT NOT NULL,
      gestion_id INTEGER NULL,
      migrated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      payload_hash TEXT NOT NULL,
      deleted_at TEXT NULL,
      PRIMARY KEY (source, legacy_id),
      FOREIGN KEY (gestion_id) REFERENCES gestiones(id)
    );

    CREATE INDEX IF NOT EXISTS idx_gestion_legacy_migrations_gestion
      ON gestion_legacy_migrations(gestion_id);

    CREATE TABLE IF NOT EXISTS promesas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente TEXT NOT NULL,
      gestion_id INTEGER NULL UNIQUE,
      documento_id INTEGER NULL,
      fecha_promesa TEXT NOT NULL,
      monto_prometido REAL NOT NULL CHECK (monto_prometido >= 0),
      monto_pagado REAL NOT NULL DEFAULT 0 CHECK (monto_pagado >= 0 AND monto_pagado <= monto_prometido),
      estado TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE','CUMPLIDA','CUMPLIDA_PARCIAL','INCUMPLIDA','CANCELADA','REPROGRAMADA')),
      fecha_pago TEXT NULL,
      motivo_incumplimiento TEXT NULL,
      observacion TEXT NULL,
      origen TEXT NOT NULL DEFAULT 'NATIVE' CHECK (origen IN ('NATIVE','MIGRATED_GESTION','MIGRATED_LEGACY')),
      creado_en TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      actualizado_en TEXT NULL,
      FOREIGN KEY (gestion_id) REFERENCES gestiones(id),
      FOREIGN KEY (documento_id) REFERENCES documentos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_promesas_cliente ON promesas(cliente);
    CREATE INDEX IF NOT EXISTS idx_promesas_estado ON promesas(estado);
    CREATE INDEX IF NOT EXISTS idx_promesas_fecha ON promesas(fecha_promesa);
    CREATE INDEX IF NOT EXISTS idx_promesas_gestion ON promesas(gestion_id);

    CREATE TABLE IF NOT EXISTS promesa_legacy_migrations (
      source TEXT NOT NULL,
      legacy_id TEXT NOT NULL,
      promesa_id INTEGER NOT NULL,
      payload_hash TEXT NOT NULL,
      migrated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (source, legacy_id),
      FOREIGN KEY (promesa_id) REFERENCES promesas(id)
    );
    CREATE INDEX IF NOT EXISTS idx_promesa_legacy_promesa ON promesa_legacy_migrations(promesa_id);

    CREATE TABLE IF NOT EXISTS app_migrations (
      key TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      metadata TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS promesa_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      promesa_id INTEGER NOT NULL,
      tipo_evento TEXT NOT NULL,
      estado_anterior TEXT NULL,
      estado_nuevo TEXT NULL,
      fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (promesa_id) REFERENCES promesas(id)
    );
    CREATE INDEX IF NOT EXISTS idx_promesa_eventos_promesa ON promesa_eventos(promesa_id, id);

    /* Tareas / seguimientos CRM: trabajo pendiente, separado de Gestiones y Promesas. */
    CREATE TABLE IF NOT EXISTS tareas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente TEXT NOT NULL,
      responsable TEXT NOT NULL DEFAULT 'sistema',
      gestion_origen_id INTEGER NULL,
      promesa_id INTEGER NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('LLAMAR','ENVIAR_CORREO','VISITAR','REVISAR_PROMESA','REVISAR_DOCUMENTOS','SEGUIMIENTO_GENERAL')),
      titulo TEXT NOT NULL,
      descripcion TEXT NULL,
      fecha_programada TEXT NOT NULL,
      prioridad TEXT NOT NULL DEFAULT 'MEDIA' CHECK (prioridad IN ('ALTA','MEDIA','BAJA')),
      estado TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE','EN_PROGRESO','COMPLETADA','CANCELADA')),
      creado_en TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      actualizado_en TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      completado_en TEXT NULL,
      cancelado_en TEXT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      idempotency_key TEXT NULL UNIQUE,
      creation_payload_hash TEXT NULL,
      FOREIGN KEY (gestion_origen_id) REFERENCES gestiones(id) ON DELETE SET NULL,
      FOREIGN KEY (promesa_id) REFERENCES promesas(id) ON DELETE SET NULL,
      CHECK (TRIM(cliente) <> ''),
      CHECK (TRIM(responsable) <> ''),
      CHECK (TRIM(titulo) <> ''),
      CHECK (
        (estado = 'COMPLETADA' AND completado_en IS NOT NULL AND cancelado_en IS NULL)
        OR (estado = 'CANCELADA' AND cancelado_en IS NOT NULL AND completado_en IS NULL)
        OR (estado IN ('PENDIENTE','EN_PROGRESO') AND completado_en IS NULL AND cancelado_en IS NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS tarea_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarea_id INTEGER NOT NULL,
      tipo_evento TEXT NOT NULL CHECK (tipo_evento IN ('TAREA_CREADA','TAREA_EDITADA','TAREA_REPROGRAMADA','TAREA_ESTADO_CAMBIADO','TAREA_COMPLETADA','TAREA_CANCELADA')),
      estado_anterior TEXT NULL,
      estado_nuevo TEXT NULL,
      actor TEXT NOT NULL DEFAULT 'sistema',
      fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (tarea_id) REFERENCES tareas(id)
    );

    CREATE INDEX IF NOT EXISTS idx_tareas_fecha_abiertas ON tareas(fecha_programada, id) WHERE estado IN ('PENDIENTE','EN_PROGRESO');
    CREATE INDEX IF NOT EXISTS idx_tareas_cliente_fecha ON tareas(cliente, fecha_programada DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_tareas_estado_fecha ON tareas(estado, fecha_programada, id);
    CREATE INDEX IF NOT EXISTS idx_tareas_responsable_fecha ON tareas(responsable, estado, fecha_programada, id);
    CREATE INDEX IF NOT EXISTS idx_tareas_prioridad_fecha ON tareas(prioridad, fecha_programada, id);
    CREATE INDEX IF NOT EXISTS idx_tareas_promesa ON tareas(promesa_id, estado, fecha_programada) WHERE promesa_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tareas_gestion_origen ON tareas(gestion_origen_id) WHERE gestion_origen_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tarea_eventos_tarea ON tarea_eventos(tarea_id, id DESC);

    CREATE TABLE IF NOT EXISTS promesa_documentos (
      promesa_id INTEGER NOT NULL,
      documento_normalizado TEXT NOT NULL,
      monto_comprometido REAL NULL CHECK (monto_comprometido IS NULL OR monto_comprometido > 0),
      creado_en TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (promesa_id, documento_normalizado),
      FOREIGN KEY (promesa_id) REFERENCES promesas(id)
    );
    CREATE INDEX IF NOT EXISTS idx_promesa_documentos_documento ON promesa_documentos(documento_normalizado);

    CREATE TABLE IF NOT EXISTS promesa_cobro_atribuciones (
      promesa_id INTEGER NOT NULL,
      movement_key TEXT NOT NULL,
      importe_atribuido REAL NOT NULL CHECK (importe_atribuido > 0),
      attributed_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      documento_normalizado TEXT NOT NULL,
      PRIMARY KEY (promesa_id, movement_key),
      FOREIGN KEY (promesa_id) REFERENCES promesas(id),
      FOREIGN KEY (movement_key) REFERENCES cobros_movimientos_importados(movimiento_key)
    );
    CREATE INDEX IF NOT EXISTS idx_promesa_atribuciones_movement ON promesa_cobro_atribuciones(movement_key);

    /* Tabla de Disputas */
    CREATE TABLE IF NOT EXISTS disputas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      documento TEXT NOT NULL,
      cliente TEXT NOT NULL,
      monto REAL DEFAULT 0,
      motivo TEXT, -- Error facturación, Producto defectuoso, Servicio no prestado, etc.
      fecha_creacion TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      estado TEXT DEFAULT 'Abierta', -- Abierta, En revisión, Resuelta, Rechazada
      fecha_resolucion TEXT,
      observacion TEXT,
      usuario_creador TEXT DEFAULT 'sistema'
    );

    CREATE INDEX IF NOT EXISTS idx_disputas_cliente ON disputas(cliente);
    CREATE INDEX IF NOT EXISTS idx_disputas_estado ON disputas(estado);

    /* Tabla de Cuentas por Aplicar */
    CREATE TABLE IF NOT EXISTS cuentas_aplicar (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      documento TEXT,
      cliente TEXT NOT NULL,
      monto REAL DEFAULT 0,
      tipo TEXT, -- Adelanto, Abono sin factura, Nota crédito, Devolución
      fecha_recepcion TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      estado TEXT DEFAULT 'Pendiente', -- Pendiente, Aplicada, Rechazada
      fecha_aplicacion TEXT,
      documento_aplicado TEXT,
      observacion TEXT,
      usuario_creador TEXT DEFAULT 'sistema'
    );

    CREATE INDEX IF NOT EXISTS idx_cuentas_cliente ON cuentas_aplicar(cliente);
    CREATE INDEX IF NOT EXISTS idx_cuentas_estado ON cuentas_aplicar(estado);
  `);

  // Upgrade D2.C: no se infiere hash para requests históricos porque la fila puede haber mutado.
  if (!tableHasColumn(db, "tareas", "creation_payload_hash")) {
    db.exec("ALTER TABLE tareas ADD COLUMN creation_payload_hash TEXT NULL");
  }

  ensureGestionLegacyMigrationSchema(db);

  // Migración suave: agregar columnas de auditoría si faltan
  const gestionCols = [
    { name: "usuario", type: "TEXT DEFAULT 'sistema'" },
    { name: "creado_en", type: "TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))" },
    { name: "actualizado_en", type: "TEXT" },
    { name: "motivo", type: "TEXT" }
  ];
  for (const col of gestionCols) {
    if (!tableHasColumn(db, "gestiones", col.name)) {
      try { db.exec(`ALTER TABLE gestiones ADD COLUMN ${col.name} ${col.type}`); } catch (e) { console.warn(`Error al agregar columna ${col.name} a gestiones:`, e); }
    }
  }

  // Migraciones suaves: si la tabla existe (por DB previa) y faltan columnas nuevas, se agregan.
  const alters: string[] = [];
  const docCols = [
    "cliente",
    "razon_social",
    "tipo_documento",
    "documento",
    "fecha_emision",
    "fecha_vencimiento",
    "vendedor",
    "total",
    "descripcion",
    "valor_documento",
    "retenciones",
    "iva",
    "cobros",
    "is_subtotal",
    "importado_en",
  ];

  for (const c of docCols) {
    if (!tableHasColumn(db, "documentos", c)) {
      // Tipos por defecto
      let sqlType = "TEXT";
      if (["total", "valor_documento", "retenciones", "cobros", "iva"].includes(c)) {
        sqlType = "REAL DEFAULT 0";
      }
      if (c === "is_subtotal") sqlType = "INTEGER NOT NULL DEFAULT 0";
      if (c === "importado_en") sqlType = "TEXT NOT NULL DEFAULT (datetime('now'))";
      alters.push(`ALTER TABLE documentos ADD COLUMN ${c} ${sqlType}`);
    }
  }

  for (const sql of alters) {
    try {
      db.exec(sql);
    } catch (e) {
      console.warn(`Error al ejecutar alter: ${sql}`, e);
    }
  }

  // Migración: Agregar columna administrador si no existe
  if (!tableHasColumn(db, "empresa", "administrador")) {
    try {
      db.exec("ALTER TABLE empresa ADD COLUMN administrador TEXT DEFAULT ''");
    } catch (e) { console.warn("Error al agregar columna administrador a empresa:", e); }
  }

  // Migración: Agregar columna iva_percent si no existe
  if (!tableHasColumn(db, "empresa", "iva_percent")) {
    try {
      db.exec("ALTER TABLE empresa ADD COLUMN iva_percent REAL DEFAULT 15.0");
    } catch (e) { console.warn("Error al agregar columna iva_percent a empresa:", e); }
  }

  // Migración: Agregar columna meta_mensual si no existe
  if (!tableHasColumn(db, "empresa", "meta_mensual")) {
    try {
      db.exec("ALTER TABLE empresa ADD COLUMN meta_mensual REAL DEFAULT 100000");
    } catch (e) { console.warn("Error al agregar columna meta_mensual a empresa:", e); }
  }

  // Migración: Agregar columna excel_headers_json para guardar estructura esperada
  if (!tableHasColumn(db, "empresa", "excel_headers_json")) {
    try {
      db.exec("ALTER TABLE empresa ADD COLUMN excel_headers_json TEXT DEFAULT ''");
    } catch (e) { console.warn("Error al agregar columna excel_headers_json a empresa:", e); }
  }

  // Migración: Agregar columnas a clientes si no existen
  const clientCols = ["telefono", "email", "direccion", "contacto"];

  const importerClientCols = [
    { name: "categoria_persona", type: "TEXT DEFAULT ''" },
    { name: "vendedor", type: "TEXT DEFAULT ''" },
    { name: "centro_costo", type: "TEXT DEFAULT ''" },
  ];
  for (const col of importerClientCols) {
    if (!tableHasColumn(db, "clientes", col.name)) {
      try { db.exec(`ALTER TABLE clientes ADD COLUMN ${col.name} ${col.type}`); }
      catch (e) { console.warn(`Error al agregar columna ${col.name} a clientes:`, e); }
    }
  }
  for (const c of clientCols) {
    if (!tableHasColumn(db, "clientes", c)) {
      try { db.exec(`ALTER TABLE clientes ADD COLUMN ${c} TEXT DEFAULT ''`); } catch (e) { console.warn(`Error al agregar columna ${c} a clientes:`, e); }
    }
  }

  // Migración: Agregar columna logo si no existe
  if (!tableHasColumn(db, "empresa", "logo")) {
    try {
      db.exec("ALTER TABLE empresa ADD COLUMN logo TEXT");
    } catch (e) { console.warn("Error al agregar columna logo a empresa:", e); }
  }


  const creditClientCols = [
    { name: "tipo_credito", type: "TEXT NOT NULL DEFAULT 'PENDIENTE'" },
    { name: "dias_credito", type: "INTEGER" },
    { name: "credito_configurado", type: "INTEGER NOT NULL DEFAULT 0" },
    { name: "credito_actualizado_en", type: "TEXT" }
  ];
  for (const col of creditClientCols) {
    if (!tableHasColumn(db, "clientes", col.name)) {
      try { db.exec(`ALTER TABLE clientes ADD COLUMN ${col.name} ${col.type}`); }
      catch (e) { console.warn(`Error al agregar columna ${col.name} a clientes:`, e); }
    }
  }
  const creditDocumentCols = [
    { name: "dias_credito_aplicados", type: "INTEGER" },
    { name: "credito_fuente", type: "TEXT NOT NULL DEFAULT 'CONTIFICO'" },
    { name: "credito_pendiente", type: "INTEGER NOT NULL DEFAULT 0" }
  ];
  for (const col of creditDocumentCols) {
    if (!tableHasColumn(db, "documentos", col.name)) {
      try { db.exec(`ALTER TABLE documentos ADD COLUMN ${col.name} ${col.type}`); }
      catch (e) { console.warn(`Error al agregar columna ${col.name} a documentos:`, e); }
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS alertas_credito (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente TEXT NOT NULL UNIQUE,
      motivo TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'PENDIENTE',
      detectado_en TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      resuelto_en TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alertas_credito_estado ON alertas_credito(estado);
  `);


  // Clasificar documentos historicos de credito.
  db.exec(`
    UPDATE documentos
    SET credito_fuente = 'PENDIENTE_CONFIGURACION',
        credito_pendiente = 1,
        dias_credito_aplicados = NULL
    WHERE is_subtotal = 0
      AND TRIM(COALESCE(cliente, '')) <> ''
      AND (
        TRIM(COALESCE(fecha_emision, '')) = ''
        OR TRIM(COALESCE(fecha_vencimiento, '')) = ''
        OR date(fecha_vencimiento) <= date(fecha_emision)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM clientes c
        WHERE c.cliente = documentos.cliente
          AND c.credito_configurado = 1
          AND c.dias_credito IS NOT NULL
      );

    INSERT INTO alertas_credito (
      cliente, motivo, estado, detectado_en, resuelto_en
    )
    SELECT DISTINCT
      d.cliente,
      'Cliente sin dias de credito configurados y vencimiento importado no valido',
      'PENDIENTE',
      datetime('now', 'localtime'),
      NULL
    FROM documentos d
    WHERE d.credito_pendiente = 1
      AND TRIM(COALESCE(d.cliente, '')) <> ''
    ON CONFLICT(cliente) DO UPDATE SET
      motivo = excluded.motivo,
      estado = 'PENDIENTE',
      detectado_en = excluded.detectado_en,
      resuelto_en = NULL;
  `);


  // Migración de documentos anulados.
  const ensureCancelledColumn = (
    tableName: string,
    columnName: string,
    definition: string,
  ): void => {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === columnName)) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  };

  ensureCancelledColumn("documentos", "estado_documento", "TEXT DEFAULT 'ACTIVO'");
  ensureCancelledColumn("documentos", "anulado", "INTEGER DEFAULT 0");
  ensureCancelledColumn("documentos", "fecha_anulacion", "TEXT");
  ensureCancelledColumn("documentos", "motivo_anulacion", "TEXT");
  ensureCancelledColumn("documentos", "fuente_anulacion", "TEXT");

  ensureCancelledColumn("abonos", "estado", "TEXT DEFAULT 'ACTIVO'");
  ensureCancelledColumn("abonos", "reversado", "INTEGER DEFAULT 0");
  ensureCancelledColumn("abonos", "motivo_reversion", "TEXT");
  ensureCancelledColumn("abonos", "reversado_en", "TEXT");
  ensureCancelledColumn("abonos", "documento_normalizado", "TEXT");

  db.exec(`
    UPDATE abonos
    SET documento_normalizado = CASE
      WHEN TRIM(COALESCE(documento, '')) = '' THEN ''
      ELSE LTRIM(REPLACE(REPLACE(REPLACE(REPLACE(UPPER(documento), '-', ''), ' ', ''), '.', ''), '/', ''), '0')
    END
    WHERE TRIM(COALESCE(documento_normalizado, '')) = '';

    CREATE TABLE IF NOT EXISTS documentos_anulados_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      documento TEXT NOT NULL,
      documento_normalizado TEXT NOT NULL,
      cliente TEXT,
      fecha_anulacion TEXT,
      motivo TEXT,
      archivo_origen TEXT NOT NULL,
      detectado_en TEXT NOT NULL,
      documento_id INTEGER,
      resultado TEXT NOT NULL,
      UNIQUE(documento_normalizado, archivo_origen)
    );

    CREATE INDEX IF NOT EXISTS idx_documentos_anulados_log_documento
      ON documentos_anulados_log(documento_normalizado);

    CREATE INDEX IF NOT EXISTS idx_documentos_estado_documento
      ON documentos(estado_documento);

    CREATE INDEX IF NOT EXISTS idx_abonos_documento_normalizado
      ON abonos(documento_normalizado);

    CREATE INDEX IF NOT EXISTS idx_abonos_estado
      ON abonos(estado, reversado);
  `);

  ensureCancelledColumn(
    "documentos_anulados_log",
    "tipo_documento",
    "TEXT"
  );
  ensureCancelledColumn(
    "documentos_anulados_log",
    "estado_origen",
    "TEXT"
  );
  ensureCancelledColumn(
    "documentos_anulados_log",
    "numero_autorizacion",
    "TEXT"
  );
  ensureCancelledColumn(
    "documentos_anulados_log",
    "importacion_id",
    "INTEGER"
  );

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_documentos_anulados_log_importacion
      ON documentos_anulados_log(importacion_id);
  `);


  // Conciliación histórica de cobros duplicados y movimientos no positivos.
  db.exec(`
    UPDATE abonos
    SET estado = 'REVERSADO',
        reversado = 1,
        motivo_reversion = 'DUPLICADO_POR_DESAPARICION',
        reversado_en = datetime('now', 'localtime')
    WHERE COALESCE(reversado, 0) = 0
      AND observacion = 'Abono detectado por documento no presente en importacion'
      AND EXISTS (
        SELECT 1
        FROM abonos total
        WHERE COALESCE(total.reversado, 0) = 0
          AND total.observacion = 'Cobro Total: Documento ya no aparece en cartera (Cancelado)'
          AND total.documento_normalizado = abonos.documento_normalizado
      );

    UPDATE abonos
    SET estado = 'REVERSADO',
        reversado = 1,
        motivo_reversion = 'MOVIMIENTO_NO_POSITIVO',
        reversado_en = datetime('now', 'localtime')
    WHERE COALESCE(reversado, 0) = 0
      AND (COALESCE(total_anterior, 0) - COALESCE(total_nuevo, 0)) <= 0;
  `);


    // Centro de Importaciones: auditoría de archivos procesados.
    db.exec(`
      CREATE TABLE IF NOT EXISTS importaciones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo TEXT NOT NULL CHECK (tipo IN ('CARTERA','ANULADOS','NOTAS_CREDITO','COBROS_MOVIMIENTOS')),
        archivo_nombre TEXT NOT NULL,
        archivo_hash TEXT,
        periodo_desde TEXT,
        periodo_hasta TEXT,
        registros_leidos INTEGER NOT NULL DEFAULT 0,
        registros_importados INTEGER NOT NULL DEFAULT 0,
        registros_ignorados INTEGER NOT NULL DEFAULT 0,
        registros_duplicados INTEGER NOT NULL DEFAULT 0,
        estado TEXT NOT NULL DEFAULT 'PROCESANDO'
          CHECK (estado IN ('PROCESANDO','COMPLETADA','COMPLETADA_ADVERTENCIAS','ERROR','REVERTIDA')),
        importado_en TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        revertido_en TEXT,
        observacion TEXT DEFAULT '',
        metadata_json TEXT DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_importaciones_tipo_fecha ON importaciones(tipo,importado_en DESC);
      CREATE INDEX IF NOT EXISTS idx_importaciones_estado ON importaciones(estado);
      CREATE INDEX IF NOT EXISTS idx_importaciones_hash ON importaciones(archivo_hash);
    `);

  // PACK 044: frontera temporal + generaciones de reconstrucción.
  ensureCancelledColumn(
    "importaciones",
    "reconciliation_generation",
    "INTEGER DEFAULT 1"
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS reconciliation_control (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cutoff_date TEXT NOT NULL DEFAULT '2024-01-01',
      operation_start_date TEXT NOT NULL DEFAULT '2024-02-01',
      mode TEXT NOT NULL DEFAULT 'TEST'
        CHECK (mode IN ('TEST','HISTORICAL_LOAD','PRODUCTION')),
      generation INTEGER NOT NULL DEFAULT 1,
      next_snapshot_date TEXT,
      actualizado_en TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    INSERT OR IGNORE INTO reconciliation_control (
      id,
      cutoff_date,
      operation_start_date,
      mode,
      generation
    ) VALUES (
      1,
      '2024-01-01',
      '2024-02-01',
      'TEST',
      1
    );

    UPDATE reconciliation_control
    SET cutoff_date = '2024-01-01',
        operation_start_date = '2024-02-01'
    WHERE id = 1;

    CREATE TABLE IF NOT EXISTS cartera_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      importacion_id INTEGER NOT NULL UNIQUE,
      generation INTEGER NOT NULL,
      fecha_snapshot TEXT NOT NULL DEFAULT (date('now','localtime')),
      snapshot_anterior_id INTEGER,
      cantidad_documentos INTEGER NOT NULL DEFAULT 0,
      cantidad_legacy INTEGER NOT NULL DEFAULT 0,
      hash_contenido TEXT NOT NULL,
      baseline INTEGER NOT NULL DEFAULT 0,
      creado_en TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (importacion_id) REFERENCES importaciones(id),
      FOREIGN KEY (snapshot_anterior_id) REFERENCES cartera_snapshots(id)
    );

    CREATE INDEX IF NOT EXISTS idx_cartera_snapshots_generation
      ON cartera_snapshots(generation, id DESC);

    CREATE INDEX IF NOT EXISTS idx_cartera_snapshots_generation_fecha
      ON cartera_snapshots(generation, fecha_snapshot DESC, id DESC);

    CREATE TABLE IF NOT EXISTS reconciliation_source_semantics (
      fuente TEXT PRIMARY KEY,
      semantics TEXT NOT NULL CHECK (semantics IN ('LIVE_OUTSTANDING_SNAPSHOT','HISTORICAL_EVENT_SOURCE')),
      historical_chunking INTEGER NOT NULL DEFAULT 0 CHECK (historical_chunking IN (0,1)),
      effective_date_replay INTEGER NOT NULL DEFAULT 0 CHECK (effective_date_replay IN (0,1)),
      cutoff_date TEXT NOT NULL DEFAULT '2024-01-01',
      actualizado_en TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    INSERT INTO reconciliation_source_semantics (fuente, semantics, historical_chunking, effective_date_replay, cutoff_date) VALUES
      ('CARTERA', 'LIVE_OUTSTANDING_SNAPSHOT', 0, 0, '2024-01-01'),
      ('ANULADOS', 'HISTORICAL_EVENT_SOURCE', 1, 1, '2024-01-01'),
      ('NOTAS_CREDITO', 'HISTORICAL_EVENT_SOURCE', 1, 1, '2024-01-01'),
      ('COBROS_MOVIMIENTOS', 'HISTORICAL_EVENT_SOURCE', 1, 1, '2024-01-01')
    ON CONFLICT(fuente) DO UPDATE SET
      semantics=excluded.semantics,
      historical_chunking=excluded.historical_chunking,
      effective_date_replay=excluded.effective_date_replay,
      cutoff_date=excluded.cutoff_date,
      actualizado_en=datetime('now','localtime');

    CREATE TABLE IF NOT EXISTS historical_bootstrap_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      generation INTEGER NOT NULL,
      fuente TEXT NOT NULL,
      periodo_desde TEXT NOT NULL,
      periodo_hasta TEXT NOT NULL,
      archivo_hash TEXT,
      estado TEXT NOT NULL DEFAULT 'PROCESANDO'
        CHECK (estado IN ('PROCESANDO','COMPLETADO','ERROR')),
      registros_leidos INTEGER NOT NULL DEFAULT 0,
      registros_in_scope INTEGER NOT NULL DEFAULT 0,
      registros_legacy INTEGER NOT NULL DEFAULT 0,
      creado_en TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      completado_en TEXT,
      UNIQUE(generation, fuente, periodo_desde, periodo_hasta, archivo_hash)
    );

    CREATE TABLE IF NOT EXISTS cartera_snapshot_documentos (
      snapshot_id INTEGER NOT NULL,
      documento_normalizado TEXT NOT NULL,
      documento TEXT NOT NULL,
      cliente TEXT,
      fecha_emision TEXT,
      saldo REAL NOT NULL DEFAULT 0,
      saldo_centavos INTEGER NOT NULL DEFAULT 0,
      temporal_scope TEXT NOT NULL DEFAULT 'IN_SCOPE'
        CHECK (temporal_scope IN ('IN_SCOPE','OUT_OF_SCOPE_LEGACY')),
      PRIMARY KEY (snapshot_id, documento_normalizado),
      FOREIGN KEY (snapshot_id) REFERENCES cartera_snapshots(id)
    );

    CREATE INDEX IF NOT EXISTS idx_cartera_snapshot_documentos_documento
      ON cartera_snapshot_documentos(documento_normalizado, snapshot_id DESC);
  `);

  // PACK-045-FIX-009: ignorados != legacy. Los excluidos por semántica de fuente
  // se contabilizan aparte de los movimientos anteriores al cutoff temporal.
  ensureCancelledColumn(
    "historical_bootstrap_batches",
    "registros_ignorados",
    "INTEGER NOT NULL DEFAULT 0"
  );

  ensureCancelledColumn(
    "reconciliation_control",
    "next_snapshot_date",
    "TEXT"
  );

  // Snapshot reversible de importaciones de cartera.
  db.exec(`
    CREATE TABLE IF NOT EXISTS importacion_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      importacion_id INTEGER NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      creado_en TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (importacion_id) REFERENCES importaciones(id)
    );

    CREATE INDEX IF NOT EXISTS idx_importacion_snapshots_importacion
      ON importacion_snapshots(importacion_id);
  `);

  // PACK 038: conciliación documental event-driven.
  // Se conserva `documentos` como proyección de cartera vigente y se agrega
  // un ledger inmutable para explicar cambios entre cortes.
  ensureCancelledColumn("documentos", "documento_normalizado", "TEXT");
  ensureCancelledColumn("documentos", "estado_confirmacion", "TEXT DEFAULT 'CONFIRMADO'");
  ensureCancelledColumn("documentos", "estado_fuente", "TEXT DEFAULT 'CARTERA_CONTIFICO'");
  ensureCancelledColumn("documentos", "saldo_pendiente", "REAL DEFAULT 0");
  ensureCancelledColumn(
    "documentos",
    "posicion_cartera",
    "TEXT DEFAULT 'DEUDA_VIVA'"
  );
  ensureCancelledColumn(
    "cartera_snapshot_documentos",
    "posicion_cartera",
    "TEXT DEFAULT 'DEUDA_VIVA'"
  );
  ensureCancelledColumn("documentos", "saldo_original", "REAL DEFAULT 0");
  ensureCancelledColumn("documentos", "ultima_conciliacion_en", "TEXT");

  db.exec(`
    UPDATE documentos
    SET documento_normalizado = CASE
      WHEN TRIM(COALESCE(documento, '')) = '' THEN ''
      ELSE LTRIM(REPLACE(REPLACE(REPLACE(REPLACE(UPPER(documento), '-', ''), ' ', ''), '.', ''), '/', ''), '0')
    END
    WHERE TRIM(COALESCE(documento_normalizado, '')) = '';

    UPDATE documentos
    SET posicion_cartera = CASE
      WHEN UPPER(TRIM(COALESCE(tipo_documento, ''))) = 'NCT'
       AND COALESCE(total, 0) < 0
      THEN 'CREDITO_VIVO'
      ELSE 'DEUDA_VIVA'
    END
    WHERE is_subtotal = 0;

    UPDATE cartera_snapshot_documentos
    SET posicion_cartera = CASE
      WHEN COALESCE(saldo, 0) < 0
      THEN 'CREDITO_VIVO'
      ELSE 'DEUDA_VIVA'
    END;

    UPDATE documentos
    SET saldo_pendiente = COALESCE(total, 0)
    WHERE COALESCE(saldo_pendiente, 0) = 0
      AND COALESCE(total, 0) > 0;

    UPDATE documentos
    SET saldo_original = MAX(COALESCE(valor_documento, 0), COALESCE(total, 0))
    WHERE COALESCE(saldo_original, 0) <= 0;

    CREATE INDEX IF NOT EXISTS idx_documentos_documento_normalizado
      ON documentos(documento_normalizado);

    CREATE TABLE IF NOT EXISTS documento_saldos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      documento_normalizado TEXT NOT NULL,
      importacion_id INTEGER NOT NULL,
      saldo_anterior REAL,
      saldo_actual REAL NOT NULL,
      delta REAL NOT NULL DEFAULT 0,
      presente_cartera INTEGER NOT NULL DEFAULT 1,
      registrado_en TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(documento_normalizado, importacion_id),
      FOREIGN KEY (importacion_id) REFERENCES importaciones(id)
    );

    CREATE INDEX IF NOT EXISTS idx_documento_saldos_documento
      ON documento_saldos(documento_normalizado, importacion_id DESC);

    CREATE TABLE IF NOT EXISTS documento_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      documento_normalizado TEXT NOT NULL,
      tipo_evento TEXT NOT NULL,
      fuente TEXT NOT NULL,
      importe REAL NOT NULL DEFAULT 0,
      estado_anterior TEXT,
      estado_nuevo TEXT,
      provisional INTEGER NOT NULL DEFAULT 0,
      importacion_id INTEGER,
      referencia_externa TEXT,
      metadata_json TEXT DEFAULT '{}',
      ocurrido_en TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (importacion_id) REFERENCES importaciones(id)
    );

    CREATE INDEX IF NOT EXISTS idx_documento_eventos_documento
      ON documento_eventos(documento_normalizado, id DESC);
    CREATE INDEX IF NOT EXISTS idx_documento_eventos_tipo
      ON documento_eventos(tipo_evento, fuente);
    CREATE INDEX IF NOT EXISTS idx_documento_eventos_importacion
      ON documento_eventos(importacion_id);


    CREATE TABLE IF NOT EXISTS notas_credito_importadas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero_nc TEXT NOT NULL,
      numero_nc_normalizado TEXT NOT NULL UNIQUE,
      fecha_nc TEXT,
      tipo_documento_relacionado TEXT,
      documento_relacionado TEXT,
      documento_relacionado_normalizado TEXT,
      autorizacion TEXT,
      persona TEXT,
      identificacion TEXT,
      vendedor TEXT,
      subtotal REAL NOT NULL DEFAULT 0,
      iva REAL NOT NULL DEFAULT 0,
      total_nc REAL NOT NULL DEFAULT 0,
      saldo_nc REAL NOT NULL DEFAULT 0,
      estado_fuente TEXT,
      descripcion TEXT,
      estado_conciliacion TEXT NOT NULL DEFAULT 'PENDIENTE_CONCILIACION'
        CHECK (estado_conciliacion IN ('CONCILIADA','PENDIENTE_CONCILIACION')),
      importacion_id INTEGER,
      creado_en TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (importacion_id) REFERENCES importaciones(id)
    );

    CREATE INDEX IF NOT EXISTS idx_notas_credito_documento_relacionado
      ON notas_credito_importadas(documento_relacionado_normalizado);
    CREATE INDEX IF NOT EXISTS idx_notas_credito_importacion
      ON notas_credito_importadas(importacion_id);


    CREATE TABLE IF NOT EXISTS cobros_movimientos_importados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      movimiento_key TEXT NOT NULL UNIQUE,
      fecha_movimiento TEXT,
      identificacion TEXT,
      persona TEXT,
      tipo_fuente TEXT NOT NULL,
      forma_cobro_pago TEXT,
      asiento TEXT,
      documento_cruce TEXT,
      codigo_comprobante TEXT,
      documento_relacionado TEXT,
      documento_relacionado_normalizado TEXT,
      detalle TEXT,
      valor REAL NOT NULL DEFAULT 0,
      clase_movimiento TEXT NOT NULL DEFAULT 'COBRO'
        CHECK (clase_movimiento IN ('COBRO','CRUCE','ANTICIPO','RETENCION','OTRO')),
      estado_conciliacion TEXT NOT NULL DEFAULT 'PENDIENTE_CONCILIACION'
        CHECK (estado_conciliacion IN ('CONCILIADO','PENDIENTE_CONCILIACION')),
      importacion_id INTEGER,
      creado_en TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (importacion_id) REFERENCES importaciones(id)
    );

    CREATE INDEX IF NOT EXISTS idx_cobros_movimientos_documento
      ON cobros_movimientos_importados(documento_relacionado_normalizado);
    CREATE INDEX IF NOT EXISTS idx_cobros_movimientos_fecha
      ON cobros_movimientos_importados(fecha_movimiento);
    CREATE INDEX IF NOT EXISTS idx_cobros_movimientos_clase
      ON cobros_movimientos_importados(clase_movimiento, estado_conciliacion);
    CREATE INDEX IF NOT EXISTS idx_cobros_movimientos_importacion
      ON cobros_movimientos_importados(importacion_id);

    -- Migración histórica: las antiguas filas ficticias dejan evidencia completa
    -- en el ledger y después se retiran de la proyección de cartera vigente.
    INSERT OR IGNORE INTO documento_eventos (
      event_key, documento_normalizado, tipo_evento, fuente, importe,
      estado_anterior, estado_nuevo, provisional, referencia_externa, metadata_json
    )
    SELECT
      'LEGACY_DESAPARICION:' || COALESCE(d.documento_normalizado, ''),
      d.documento_normalizado,
      'DOCUMENTO_DESAPARECIDO',
      'DELTA_CARTERA',
      COALESCE((
        SELECT MAX(MAX(COALESCE(a.total_anterior, 0) - COALESCE(a.total_nuevo, 0), 0))
        FROM abonos a
        WHERE a.documento_normalizado = d.documento_normalizado
      ), 0),
      'ACTIVO_PENDIENTE',
      'PAGADO_TOTAL',
      1,
      d.documento,
      json_object('migrado_desde', 'LIQUIDACION_AUTOMATICA')
    FROM documentos d
    WHERE d.is_subtotal = 0
      AND d.credito_fuente = 'LIQUIDACION_AUTOMATICA'
      AND TRIM(COALESCE(d.documento_normalizado, '')) <> '';

    INSERT OR IGNORE INTO documento_eventos (
      event_key, documento_normalizado, tipo_evento, fuente, importe,
      estado_anterior, estado_nuevo, provisional, referencia_externa, metadata_json
    )
    SELECT
      'LEGACY_LIQUIDACION:' || COALESCE(d.documento_normalizado, ''),
      d.documento_normalizado,
      'PAGO_TOTAL_INFERIDO',
      'DELTA_CARTERA',
      COALESCE((
        SELECT MAX(MAX(COALESCE(a.total_anterior, 0) - COALESCE(a.total_nuevo, 0), 0))
        FROM abonos a
        WHERE a.documento_normalizado = d.documento_normalizado
      ), 0),
      'ACTIVO_PENDIENTE',
      'PAGADO_TOTAL',
      1,
      d.documento,
      json_object('migrado_desde', 'LIQUIDACION_AUTOMATICA')
    FROM documentos d
    WHERE d.is_subtotal = 0
      AND d.credito_fuente = 'LIQUIDACION_AUTOMATICA'
      AND TRIM(COALESCE(d.documento_normalizado, '')) <> '';

    -- Ya existe evidencia auditable en documento_eventos; la fila sintética no
    -- representa cartera vigente y debe salir de la proyección materializada.
    DELETE FROM documentos
    WHERE is_subtotal = 0
      AND credito_fuente = 'LIQUIDACION_AUTOMATICA';
  `);

  // Insertar registro de empresa por defecto si no existe
  if (!tableHasColumn(db, "promesas", "origen")) {
    db.exec("ALTER TABLE promesas ADD COLUMN origen TEXT NOT NULL DEFAULT 'NATIVE' CHECK (origen IN ('NATIVE','MIGRATED_GESTION','MIGRATED_LEGACY'))");
  }
  if (!tableHasColumn(db, "promesas", "monto_cumplido_base")) {
    db.exec("ALTER TABLE promesas ADD COLUMN monto_cumplido_base REAL NOT NULL DEFAULT 0 CHECK (monto_cumplido_base >= 0)");
    db.exec("UPDATE promesas SET monto_cumplido_base=monto_pagado");
  }
  if (!tableHasColumn(db, "promesas", "cumplimiento_automatico_desde")) {
    db.exec("ALTER TABLE promesas ADD COLUMN cumplimiento_automatico_desde TEXT NULL");
    db.exec("UPDATE promesas SET cumplimiento_automatico_desde=datetime('now','localtime')");
  }

  db.exec("INSERT OR IGNORE INTO empresa (id, nombre) VALUES (1, 'Mi Empresa')");
  ensureEvidenceAttributionBaseline(db);
}

function resolveDevelopmentDbPath(): string {
  const configuredPath = process.env.CARTERA_DB_PATH?.trim();

  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  return path.resolve(
    process.cwd(),
    "tests",
    "data",
    "cartera.db",
  );
}

function resolveProductionDbPath(): string {
  return path.join(
    app.getPath("userData"),
    "data",
    "cartera.db",
  );
}

function resolveDbFilePath(): string {
  if (app.isPackaged) {
    return resolveProductionDbPath();
  }

  return resolveDevelopmentDbPath();
}

export async function openDb() {
  const dbPath = resolveDbFilePath();
  ensureDir(path.dirname(dbPath));
  await recoverPendingBackup(dbPath);
  const db = new Database(dbPath);

  // Configuración de SQLite para permitir múltiples lectores
  db.pragma("journal_mode = WAL");  // Write-Ahead Logging
  db.pragma("synchronous = NORMAL"); // Balance entre velocidad y seguridad
  db.pragma("cache_size = -64000");  // 64MB cache
  db.pragma("foreign_keys = ON");    // Integridad referencial
  db.pragma("temp_store = MEMORY");  // Tablas temp en memoria

  let safety: DataSafetyResult = {
    backupPath: null,
    migrationApplied: false,
  };
  let releaseUpgrade: ReleaseUpgradeContext = {
    backupPath: null,
    targetVersion: app.getVersion(),
    requiresUpgrade: false,
  };

  try {
    safety = await initializeDataSafety(
      db,
      dbPath,
      app.getVersion(),
    );

    releaseUpgrade = await beginReleaseUpgrade(
      db,
      dbPath,
      app.getVersion(),
    );

    ensureSchema(db);
    validateReleaseSchema(db);
    assertDatabaseIntegrity(db);

    completeReleaseUpgrade(
      db,
      releaseUpgrade,
    );
  } catch (error) {
    db.close();

    const restoreFrom =
      releaseUpgrade.backupPath ??
      safety.backupPath;

    if (restoreFrom) {
      restoreDatabaseFile(
        dbPath,
        restoreFrom,
      );

      console.error(
        `Base restaurada desde: ${restoreFrom}`,
      );
    }

    throw error;
  }

  if (releaseUpgrade.backupPath) {
    console.log(
      `Respaldo previo al upgrade ${app.getVersion()}: ` +
      releaseUpgrade.backupPath,
    );
  } else if (safety.backupPath) {
    console.log(
      `Respaldo previo a actualizacion: ${safety.backupPath}`,
    );
  }

  return { db, dbPath };
}

/**
 * Devuelve la ruta absoluta del archivo SQLite sin necesidad de abrir la conexión.
 * Útil para mostrar la "Ruta DB" en el renderer.
 */
export function getDbFilePath(): string {
  return resolveDbFilePath();
}



