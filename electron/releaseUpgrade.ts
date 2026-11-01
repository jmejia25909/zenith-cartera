import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { backupDatabase } from "./sqliteBackup";

export interface ReleaseUpgradeContext {
  backupPath: string | null;
  targetVersion: string;
  requiresUpgrade: boolean;
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
    ).get(table),
  );
}

function hasPersistentData(db: Database.Database): boolean {
  const tables = ["documentos", "gestiones", "clientes", "importaciones"];

  for (const table of tables) {
    if (!tableExists(db, table)) continue;

    const row = db
      .prepare(`SELECT COUNT(*) AS total FROM "${table}"`)
      .get() as { total: number };

    if (Number(row.total) > 0) return true;
  }

  return false;
}

function formatTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
}

function getAppliedVersions(db: Database.Database): Set<string> {
  if (!tableExists(db, "app_release_migrations")) {
    return new Set<string>();
  }

  const rows = db.prepare(`
    SELECT app_version
    FROM app_release_migrations
    WHERE status = 'APPLIED'
  `).all() as Array<{ app_version: string }>;

  return new Set(rows.map((row) => String(row.app_version)));
}

async function createReleaseBackup(
  db: Database.Database,
  dbPath: string,
  targetVersion: string,
): Promise<string | null> {
  if (!fs.existsSync(dbPath) || !hasPersistentData(db)) {
    return null;
  }

  const backupDir = path.join(path.dirname(dbPath), "backups");
  fs.mkdirSync(backupDir, { recursive: true });

  const safeVersion = targetVersion.replace(/[^0-9A-Za-z.-]/g, "-");

  const backupPath = path.join(
    backupDir,
    `cartera-pre-upgrade-to-v${safeVersion}-${formatTimestamp(new Date())}.db`,
  );

  await backupDatabase(db, backupPath);
  return backupPath;
}

export async function beginReleaseUpgrade(
  db: Database.Database,
  dbPath: string,
  targetVersion: string,
): Promise<ReleaseUpgradeContext> {
  const requiresUpgrade = !getAppliedVersions(db).has(targetVersion);

  if (!requiresUpgrade) {
    return {
      backupPath: null,
      targetVersion,
      requiresUpgrade: false,
    };
  }

  return {
    backupPath: await createReleaseBackup(db, dbPath, targetVersion),
    targetVersion,
    requiresUpgrade: true,
  };
}

export function validateReleaseSchema(db: Database.Database): void {
  const requiredTables = [
    "documentos",
    "gestiones",
    "clientes",
    "importaciones",
    "historical_bootstrap_batches",
    "reconciliation_control",
    "cartera_snapshots",
    "cartera_snapshot_documentos",
    "documento_eventos",
    "cobros_movimientos_importados",
    "notas_credito_importadas",
  ];

  for (const table of requiredTables) {
    if (!tableExists(db, table)) {
      throw new Error(`Migración incompleta: falta la tabla ${table}.`);
    }
  }

  const requiredColumns: Record<string, string[]> = {
    historical_bootstrap_batches: [
      "generation",
      "fuente",
      "periodo_desde",
      "periodo_hasta",
      "registros_in_scope",
      "registros_legacy",
      "registros_ignorados",
    ],
    documentos: [
      "documento_normalizado",
      "estado_confirmacion",
      "estado_fuente",
      "saldo_pendiente",
      "posicion_cartera",
      "saldo_original",
    ],
    cobros_movimientos_importados: [
      "documento_relacionado_normalizado",
      "clase_movimiento",
      "estado_conciliacion",
    ],
  };

  for (const [table, columns] of Object.entries(requiredColumns)) {
    const existing = new Set(
      (
        db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>
      ).map((row) => row.name),
    );

    for (const column of columns) {
      if (!existing.has(column)) {
        throw new Error(`Migración incompleta: falta ${table}.${column}.`);
      }
    }
  }
}

export function completeReleaseUpgrade(
  db: Database.Database,
  context: ReleaseUpgradeContext,
): void {
  if (!context.requiresUpgrade) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_release_migrations (
      app_version TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('APPLIED')),
      backup_path TEXT,
      applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
  `);

  db.prepare(`
    INSERT INTO app_release_migrations (
      app_version,
      status,
      backup_path,
      applied_at
    )
    VALUES (?, 'APPLIED', ?, datetime('now','localtime'))
    ON CONFLICT(app_version) DO UPDATE SET
      status = excluded.status,
      backup_path = excluded.backup_path,
      applied_at = excluded.applied_at
  `).run(context.targetVersion, context.backupPath);
}
