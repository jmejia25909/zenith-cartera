import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { backupDatabase, publishBackupFile } from "./sqliteBackup";

const DATA_SAFETY_MIGRATION = 1;

export interface DataSafetyResult {
  backupPath: string | null;
  migrationApplied: boolean;
}

interface ColumnInfo {
  name: string;
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(table);
  return Boolean(row);
}

function getColumns(db: Database.Database, table: string): Set<string> {
  if (!tableExists(db, table)) return new Set<string>();
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
  return new Set(rows.map((row) => row.name.toLowerCase()));
}

function hasUserData(db: Database.Database): boolean {
  const row = db
    .prepare(`
      SELECT COUNT(*) AS total
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
    `)
    .get() as { total: number };
  return row.total > 0;
}

function formatTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

async function createPreUpdateBackup(
  db: Database.Database,
  dbPath: string,
  targetVersion: string
): Promise<string | null> {
  if (!fs.existsSync(dbPath) || !hasUserData(db)) return null;

  const backupDir = path.join(path.dirname(dbPath), "backups");
  fs.mkdirSync(backupDir, { recursive: true });

  const safeVersion = targetVersion.replace(/[^0-9A-Za-z.-]/g, "-");
  const backupPath = path.join(
    backupDir,
    `cartera-pre-update-to-v${safeVersion}-${formatTimestamp(new Date())}.db`
  );

  await backupDatabase(db, backupPath);
  return backupPath;
}

function ensureMigrationTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `);
}

function migrationAlreadyApplied(db: Database.Database): boolean {
  if (!tableExists(db, "schema_migrations")) return false;
  const row = db
    .prepare("SELECT 1 FROM schema_migrations WHERE version = ? LIMIT 1")
    .get(DATA_SAFETY_MIGRATION);
  return Boolean(row);
}

function sqlExpression(columns: Set<string>, preferred: string[], fallback: string): string {
  const found = preferred.find((column) => columns.has(column.toLowerCase()));
  return found ? `"${found}"` : fallback;
}

function migrateLegacyDocuments(db: Database.Database): void {
  if (!tableExists(db, "documentos")) return;

  const columns = getColumns(db, "documentos");
  const hasLegacyDate = columns.has("fecha");
  const hasModernDates = columns.has("fecha_emision") && columns.has("fecha_vencimiento");

  if (!hasLegacyDate || hasModernDates) return;

  const sourceCount = (
    db.prepare("SELECT COUNT(*) AS total FROM documentos").get() as { total: number }
  ).total;

  db.exec(`
    DROP TABLE IF EXISTS documentos_migration_new;

    CREATE TABLE documentos_migration_new (
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
  `);

  const id = sqlExpression(columns, ["id"], "NULL");
  const cliente = sqlExpression(columns, ["cliente", "codigo_cliente"], "''");
  const razonSocial = sqlExpression(columns, ["razon_social", "cliente_nombre"], cliente);
  const tipoDocumento = sqlExpression(columns, ["tipo_documento", "tipo"], "''");
  const documento = sqlExpression(columns, ["documento", "numero_documento"], "''");
  const fechaEmision = sqlExpression(columns, ["fecha_emision", "fecha"], "''");
  const fechaVencimiento = sqlExpression(
    columns,
    ["fecha_vencimiento", "vencimiento", "fecha"],
    fechaEmision
  );
  const vendedor = sqlExpression(columns, ["vendedor"], "''");
  const total = sqlExpression(columns, ["total", "saldo"], "0");
  const descripcion = sqlExpression(columns, ["descripcion", "detalle"], "''");
  const valorDocumento = sqlExpression(columns, ["valor_documento", "valor", "total"], total);
  const retenciones = sqlExpression(columns, ["retenciones", "retencion"], "0");
  const iva = sqlExpression(columns, ["iva"], "0");
  const cobros = sqlExpression(columns, ["cobros", "cobrado"], "0");
  const isSubtotal = sqlExpression(columns, ["is_subtotal"], "0");
  const importadoEn = sqlExpression(columns, ["importado_en", "creado_en"], "datetime('now')");

  db.exec(`
    INSERT INTO documentos_migration_new (
      id,
      cliente,
      razon_social,
      tipo_documento,
      documento,
      fecha_emision,
      fecha_vencimiento,
      vendedor,
      total,
      descripcion,
      valor_documento,
      retenciones,
      iva,
      cobros,
      is_subtotal,
      importado_en
    )
    SELECT
      ${id},
      ${cliente},
      ${razonSocial},
      ${tipoDocumento},
      ${documento},
      ${fechaEmision},
      ${fechaVencimiento},
      ${vendedor},
      COALESCE(${total}, 0),
      ${descripcion},
      COALESCE(${valorDocumento}, 0),
      COALESCE(${retenciones}, 0),
      COALESCE(${iva}, 0),
      COALESCE(${cobros}, 0),
      COALESCE(${isSubtotal}, 0),
      COALESCE(${importadoEn}, datetime('now'))
    FROM documentos;
  `);

  const targetCount = (
    db.prepare("SELECT COUNT(*) AS total FROM documentos_migration_new").get() as {
      total: number;
    }
  ).total;

  if (sourceCount !== targetCount) {
    throw new Error(
      `Migracion de documentos incompleta: origen=${sourceCount}, destino=${targetCount}`
    );
  }

  db.exec(`
    ALTER TABLE documentos RENAME TO documentos_legacy_backup;
    ALTER TABLE documentos_migration_new RENAME TO documentos;
    DROP TABLE documentos_legacy_backup;

    CREATE INDEX IF NOT EXISTS idx_doc_cliente ON documentos(cliente);
    CREATE INDEX IF NOT EXISTS idx_doc_venc ON documentos(fecha_vencimiento);
    CREATE INDEX IF NOT EXISTS idx_doc_total ON documentos(total);
  `);
}

function recordMigration(db: Database.Database): void {
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations (version, name)
    VALUES (?, ?)
  `).run(DATA_SAFETY_MIGRATION, "safe-legacy-database-migration");
}

export function assertDatabaseIntegrity(db: Database.Database): void {
  const result = db.pragma("integrity_check", { simple: true });
  if (result !== "ok") {
    throw new Error(`SQLite integrity_check fallo: ${String(result)}`);
  }
}

export async function initializeDataSafety(
  db: Database.Database,
  dbPath: string,
  targetVersion: string
): Promise<DataSafetyResult> {
  const requiresMigration = !migrationAlreadyApplied(db);
  if (!requiresMigration) {
    assertDatabaseIntegrity(db);
    return { backupPath: null, migrationApplied: false };
  }

  const backupPath = await createPreUpdateBackup(db, dbPath, targetVersion);

  const migrate = db.transaction(() => {
    ensureMigrationTable(db);
    migrateLegacyDocuments(db);
    recordMigration(db);
  });

  migrate();
  assertDatabaseIntegrity(db);

  return { backupPath, migrationApplied: true };
}

export function restoreDatabaseFile(dbPath: string, backupPath: string): void {
  if (!fs.existsSync(backupPath)) {
    throw new Error(`No existe el respaldo de restauracion: ${backupPath}`);
  }

  const temporaryPath = `${dbPath}.restore-${process.pid}-${Date.now()}`;
  try {
    fs.copyFileSync(backupPath, temporaryPath);
    publishBackupFile(temporaryPath, dbPath);
  } catch (error) {
    if (fs.existsSync(temporaryPath)) {
      console.error(`Restauracion incompleta; respaldo temporal conservado en ${temporaryPath}`);
    }
    throw error;
  }
}
