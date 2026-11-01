import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import * as XLSX from "xlsx";

import { importCancelledDocumentsExcel } from "../../electron/importCancelledDocuments";
import { importCollectionMovementsExcel } from "../../electron/importCollectionMovements";
import { importarCarteraPorCobrarExcel } from "../../electron/importContifico";
import { importCreditNotesExcel } from "../../electron/importCreditNotes";
import { getNetRecoveryTotal } from "../../electron/reconciliation/recoveryProjection";
import { ensureEvidenceAttributionBaseline } from "../../electron/reconciliation/evidenceAttribution";

export type PortfolioDocument = {
  document: string;
  balance: number;
  customer?: string;
  type?: string;
  retention?: number;
};

export type ScenarioContext = {
  db: Database.Database;
  directory: string;
  close: () => void;
};

const SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente TEXT NOT NULL UNIQUE,
    razon_social TEXT,
    vendedor TEXT,
    categoria_persona TEXT,
    centro_costo TEXT,
    tipo_credito TEXT DEFAULT 'CONTADO',
    dias_credito INTEGER,
    credito_configurado INTEGER DEFAULT 0
  );

  CREATE TABLE documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente TEXT,
    razon_social TEXT,
    tipo_documento TEXT,
    documento TEXT,
    documento_normalizado TEXT,
    fecha_emision TEXT,
    fecha_vencimiento TEXT,
    vendedor TEXT,
    total REAL DEFAULT 0,
    descripcion TEXT,
    valor_documento REAL DEFAULT 0,
    retenciones REAL DEFAULT 0,
    cobros REAL DEFAULT 0,
    is_subtotal INTEGER NOT NULL DEFAULT 0,
    importado_en TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    dias_credito_aplicados INTEGER,
    credito_fuente TEXT,
    credito_pendiente INTEGER DEFAULT 0,
    estado_documento TEXT DEFAULT 'ACTIVO_PENDIENTE',
    estado_confirmacion TEXT DEFAULT 'CONFIRMADO',
    estado_fuente TEXT DEFAULT 'CARTERA_CONTIFICO',
    saldo_pendiente REAL DEFAULT 0,
    saldo_original REAL DEFAULT 0,
    posicion_cartera TEXT DEFAULT 'DEUDA_VIVA',
    anulado INTEGER DEFAULT 0,
    fecha_anulacion TEXT,
    motivo_anulacion TEXT,
    fuente_anulacion TEXT,
    ultima_conciliacion_en TEXT
  );

  CREATE TABLE alertas_credito (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente TEXT NOT NULL UNIQUE,
    motivo TEXT,
    estado TEXT,
    detectado_en TEXT,
    resuelto_en TEXT
  );

  CREATE TABLE abonos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    documento TEXT NOT NULL,
    documento_normalizado TEXT,
    total_anterior REAL NOT NULL,
    total_nuevo REAL NOT NULL,
    fecha TEXT DEFAULT (datetime('now','localtime')),
    observacion TEXT DEFAULT '',
    estado TEXT DEFAULT 'ACTIVO',
    reversado INTEGER DEFAULT 0,
    motivo_reversion TEXT,
    reversado_en TEXT
  );

  CREATE TABLE importaciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    archivo_nombre TEXT NOT NULL,
    archivo_hash TEXT,
    periodo_desde TEXT,
    periodo_hasta TEXT,
    registros_leidos INTEGER DEFAULT 0,
    registros_importados INTEGER DEFAULT 0,
    registros_ignorados INTEGER DEFAULT 0,
    registros_duplicados INTEGER DEFAULT 0,
    estado TEXT DEFAULT 'PROCESANDO',
    importado_en TEXT DEFAULT (datetime('now','localtime')),
    revertido_en TEXT,
    observacion TEXT DEFAULT '',
    metadata_json TEXT DEFAULT '{}',
    reconciliation_generation INTEGER DEFAULT 1
  );

  CREATE TABLE reconciliation_control (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cutoff_date TEXT NOT NULL,
    operation_start_date TEXT NOT NULL,
    mode TEXT NOT NULL,
    generation INTEGER NOT NULL,
    next_snapshot_date TEXT,
    actualizado_en TEXT DEFAULT (datetime('now','localtime'))
  );
  INSERT INTO reconciliation_control
    (id, cutoff_date, operation_start_date, mode, generation)
  VALUES (1, '2024-01-01', '2024-02-01', 'PRODUCTION', 1);

  CREATE TABLE cartera_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    importacion_id INTEGER NOT NULL UNIQUE,
    generation INTEGER NOT NULL,
    fecha_snapshot TEXT NOT NULL,
    snapshot_anterior_id INTEGER,
    cantidad_documentos INTEGER DEFAULT 0,
    cantidad_legacy INTEGER DEFAULT 0,
    hash_contenido TEXT NOT NULL,
    baseline INTEGER DEFAULT 0,
    creado_en TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE cartera_snapshot_documentos (
    snapshot_id INTEGER NOT NULL,
    documento_normalizado TEXT NOT NULL,
    documento TEXT NOT NULL,
    cliente TEXT,
    fecha_emision TEXT,
    saldo REAL DEFAULT 0,
    saldo_centavos INTEGER DEFAULT 0,
    temporal_scope TEXT DEFAULT 'IN_SCOPE',
    posicion_cartera TEXT DEFAULT 'DEUDA_VIVA',
    PRIMARY KEY (snapshot_id, documento_normalizado)
  );

  CREATE TABLE documento_saldos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    documento_normalizado TEXT NOT NULL,
    importacion_id INTEGER NOT NULL,
    saldo_anterior REAL,
    saldo_actual REAL NOT NULL,
    delta REAL DEFAULT 0,
    presente_cartera INTEGER DEFAULT 1,
    registrado_en TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(documento_normalizado, importacion_id)
  );

  CREATE TABLE documento_eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key TEXT NOT NULL UNIQUE,
    documento_normalizado TEXT NOT NULL,
    tipo_evento TEXT NOT NULL,
    fuente TEXT NOT NULL,
    importe REAL DEFAULT 0,
    estado_anterior TEXT,
    estado_nuevo TEXT,
    provisional INTEGER DEFAULT 0,
    importacion_id INTEGER,
    referencia_externa TEXT,
    metadata_json TEXT DEFAULT '{}',
    ocurrido_en TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE cobros_movimientos_importados (
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
    valor REAL DEFAULT 0,
    clase_movimiento TEXT DEFAULT 'COBRO',
    estado_conciliacion TEXT DEFAULT 'PENDIENTE_CONCILIACION',
    importacion_id INTEGER,
    creado_en TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE notas_credito_importadas (
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
    subtotal REAL DEFAULT 0,
    iva REAL DEFAULT 0,
    total_nc REAL DEFAULT 0,
    saldo_nc REAL DEFAULT 0,
    estado_fuente TEXT,
    descripcion TEXT,
    estado_conciliacion TEXT DEFAULT 'PENDIENTE_CONCILIACION',
    importacion_id INTEGER,
    creado_en TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE documentos_anulados_log (
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
    tipo_documento TEXT,
    estado_origen TEXT,
    numero_autorizacion TEXT,
    importacion_id INTEGER,
    UNIQUE(documento_normalizado, archivo_origen)
  );

  CREATE TABLE promesas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, cliente TEXT NOT NULL, gestion_id INTEGER NULL UNIQUE,
    documento_id INTEGER NULL, fecha_promesa TEXT NOT NULL, monto_prometido REAL NOT NULL,
    monto_pagado REAL NOT NULL DEFAULT 0, estado TEXT NOT NULL DEFAULT 'PENDIENTE', fecha_pago TEXT,
    motivo_incumplimiento TEXT, observacion TEXT, origen TEXT NOT NULL DEFAULT 'NATIVE',
    monto_cumplido_base REAL NOT NULL DEFAULT 0, cumplimiento_automatico_desde TEXT,
    creado_en TEXT NOT NULL DEFAULT(datetime('now','localtime')), actualizado_en TEXT
  );
  CREATE TABLE promesa_documentos (
    promesa_id INTEGER NOT NULL, documento_normalizado TEXT NOT NULL, monto_comprometido REAL,
    creado_en TEXT NOT NULL DEFAULT(datetime('now','localtime')),
    PRIMARY KEY(promesa_id,documento_normalizado)
  );
  CREATE TABLE promesa_cobro_atribuciones (
    promesa_id INTEGER NOT NULL, movement_key TEXT NOT NULL, importe_atribuido REAL NOT NULL,
    attributed_at TEXT NOT NULL DEFAULT(datetime('now','localtime')), documento_normalizado TEXT NOT NULL,
    PRIMARY KEY(promesa_id,movement_key)
  );
  CREATE TABLE promesa_eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, promesa_id INTEGER NOT NULL, tipo_evento TEXT NOT NULL,
    estado_anterior TEXT, estado_nuevo TEXT, fecha TEXT NOT NULL DEFAULT(datetime('now','localtime')),
    metadata TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE app_migrations (
    key TEXT PRIMARY KEY, completed_at TEXT NOT NULL DEFAULT(datetime('now','localtime')), metadata TEXT
  );
`;

function safeRemove(directory: string): void {
  const resolved = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  if (resolved === tempRoot || !resolved.startsWith(`${tempRoot}${path.sep}`)) {
    throw new Error(`Directorio temporal fuera de alcance seguro: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

export function createScenarioContext(label: string): ScenarioContext {
  const safeLabel = label.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `zenith-${safeLabel}-`));
  const db = new Database(path.join(directory, "integration.sqlite"));
  db.exec(SCHEMA);
  ensureEvidenceAttributionBaseline(db);

  return {
    db,
    directory,
    close: () => {
      db.close();
      safeRemove(directory);
    },
  };
}

export function ensureScenarioDocument(
  context: ScenarioContext,
  document: string,
  customer = "CLIENTE-P",
  balance = 100,
  isSubtotal = 0,
): void {
  context.db.prepare(`
    INSERT OR IGNORE INTO documentos (
      cliente, razon_social, tipo_documento, documento, documento_normalizado,
      total, valor_documento, saldo_pendiente, saldo_original, posicion_cartera, is_subtotal
    ) VALUES (?, ?, 'FAC', ?, ?, ?, ?, ?, ?, 'DEUDA_VIVA', ?)
  `).run(customer, customer, document, normalized(document), balance, balance, balance, balance, isSubtotal);
}

function createImport(db: Database.Database, type: string, label: string): number {
  const result = db.prepare(`
    INSERT INTO importaciones (
      tipo, archivo_nombre, archivo_hash, estado, reconciliation_generation
    ) VALUES (?, ?, ?, 'PROCESANDO', 1)
  `).run(type, label, `${type}:${label}`);
  return Number(result.lastInsertRowid);
}

function finishImport(db: Database.Database, id: number): void {
  db.prepare("UPDATE importaciones SET estado = 'COMPLETADA' WHERE id = ?").run(id);
}

function writeWorkbook(directory: string, filename: string, rows: unknown[][], sheet: string): string {
  const filePath = path.join(directory, filename);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheet);
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

export function importPortfolio(
  context: ScenarioContext,
  label: string,
  documents: PortfolioDocument[],
) {
  const headers = [
    "Cliente", "Tipo Documento", "# Documento", "F. Emision",
    "F. Vencimiento", "Vendedor", "Centro de Costo", "Categoria de Persona",
    "Por Vencer", "30 Dias", "60 Dias", "90 Dias", "120 Dias", "> 120 Dias",
    "Total", "Descripcion", "Valor Documento", "Retenciones", "Cobros",
  ];
  const rows = documents.map((item) => [
    item.customer ?? "CLIENTE SINTETICO",
    item.type ?? "FAC",
    item.document,
    "2026-01-01",
    "2026-02-01",
    "VENDEDOR QA",
    "QA",
    "SINTETICO",
    item.balance,
    0, 0, 0, 0, 0,
    item.balance,
    "Fixture sintético",
    item.balance,
    item.retention ?? 0,
    0,
  ]);
  const filePath = writeWorkbook(context.directory, `${label}.xlsx`, [headers, ...rows], "Cartera");
  const importId = createImport(context.db, "CARTERA", label);
  const result = importarCarteraPorCobrarExcel(filePath, context.db, importId);
  finishImport(context.db, importId);
  return { importId, result };
}

export function importCollection(
  context: ScenarioContext,
  label: string,
  document: string,
  amount: number,
  options?: { form?: string; detail?: string; date?: string },
) {
  const rows = [[
    "Tipo", "Fecha", "Identificacion", "Persona", "Forma Cobro Pago",
    "# Asiento", "Documento Cruce", "Codigo Comprobante", "Valor", "Detalle",
  ], [
    "COBRO",
    options?.date ?? "2026-01-15",
    "0999999999001",
    "CLIENTE SINTETICO",
    options?.form ?? "TRANSFERENCIA",
    `AS-${label}`,
    document,
    document,
    amount,
    options?.detail ?? "COBRO SINTETICO",
  ]];
  const filePath = writeWorkbook(context.directory, `${label}.xlsx`, rows, "Cobros");
  const importId = createImport(context.db, "COBROS_MOVIMIENTOS", label);
  const result = importCollectionMovementsExcel(filePath, context.db, importId);
  return { importId, result, filePath };
}

export function reimportCollectionFile(
  context: ScenarioContext,
  label: string,
  filePath: string,
) {
  const importId = createImport(context.db, "COBROS_MOVIMIENTOS", label);
  return importCollectionMovementsExcel(filePath, context.db, importId);
}

export function importCreditNote(
  context: ScenarioContext,
  label: string,
  creditNote: string,
  document: string,
  amount: number,
) {
  const rows = [[
    "Fecha", "Tipo Documento", "# Documento", "# Tipo Documento Relacionado",
    "# Documento Relacionado", "Autorizacion", "Persona", "Identificacion",
    "Vendedor", "Subtotal IVA mayor a 0%", "Subtotal IVA 0%", "IVA",
    "Total", "Saldo", "Estado", "Descripcion",
  ], [
    "2026-01-16", "Nota de Credito", creditNote, "Factura", document,
    `AUT-${label}`, "CLIENTE SINTETICO", "0999999999001", "VENDEDOR QA",
    amount, 0, 0, amount, 0, "Procesada", "NC SINTETICA",
  ]];
  const filePath = writeWorkbook(context.directory, `${label}.xlsx`, rows, "Notas de Credito");
  const importId = createImport(context.db, "NOTAS_CREDITO", label);
  const result = importCreditNotesExcel(filePath, context.db, importId);
  return { importId, result, filePath };
}

export function reimportCreditNoteFile(
  context: ScenarioContext,
  label: string,
  filePath: string,
) {
  const importId = createImport(context.db, "NOTAS_CREDITO", label);
  return importCreditNotesExcel(filePath, context.db, importId);
}

export function importCancellation(
  context: ScenarioContext,
  label: string,
  document: string,
) {
  const rows = [
    ["EMPRESA SINTETICA"],
    ["Documentos Anulados"],
    ["Fecha de Anulacion", "Tipo de Documento", "# Documento", "Estado", "# Autorizacion"],
    ["2026-01-17", "Factura", document, "Anulado", `AUT-${label}`],
  ];
  const filePath = writeWorkbook(context.directory, `${label}.xlsx`, rows, "DocumentosAnulados");
  const importId = createImport(context.db, "ANULADOS", label);
  const result = importCancelledDocumentsExcel(filePath, context.db, importId);
  return { importId, result, filePath };
}

export function reimportCancellationFile(
  context: ScenarioContext,
  label: string,
  filePath: string,
) {
  const importId = createImport(context.db, "ANULADOS", label);
  return importCancelledDocumentsExcel(filePath, context.db, importId);
}

export function normalized(document: string): string {
  return document.replace(/\D/g, "").replace(/^0+/, "") || "0";
}

export function latestEvent(db: Database.Database, document: string) {
  return db.prepare(`
    SELECT * FROM documento_eventos
    WHERE documento_normalizado = ?
    ORDER BY id DESC LIMIT 1
  `).get(normalized(document)) as Record<string, unknown> | undefined;
}

export function recovery(db: Database.Database, document?: string): number {
  return getNetRecoveryTotal(
    db,
    document ? normalized(document) : undefined,
  );
}

export function creditAdjustment(db: Database.Database, document: string): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(total_nc), 0) AS value
    FROM notas_credito_importadas
    WHERE documento_relacionado_normalizado = ?
      AND estado_conciliacion = 'CONCILIADA'
  `).get(normalized(document)) as { value: number };
  return Number(row.value ?? 0);
}
