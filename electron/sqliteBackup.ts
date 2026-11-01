import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export interface BackupFileOperations {
  existsSync: typeof fs.existsSync;
  mkdirSync: typeof fs.mkdirSync;
  renameSync: typeof fs.renameSync;
  rmSync: typeof fs.rmSync;
}

const SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

export type BackupPublicationState =
  | "TEMP_READY"
  | "PREVIOUS_MOVED"
  | "PUBLISHED"
  | "CLEANUP";

export class BackupPublicationError extends Error {
  constructor(
    message: string,
    readonly state: BackupPublicationState,
    readonly destinationPath: string,
    readonly temporaryPath: string,
    readonly previousPath: string,
    readonly preservedPaths: string[],
    readonly rollbackErrors: string[],
  ) {
    super(message);
  }
}

export interface BackupPublicationResult {
  state: "PUBLISHED";
  destinationPath: string;
  cleanupErrors: string[];
}

export interface PendingRecoveryResult {
  recovered: boolean;
  candidatePath: string | null;
}

function rollbackPath(destinationPath: string): string {
  return `${destinationPath}.previous-${process.pid}-${Date.now()}`;
}

function removeTemporary(temporaryPath: string, operations: BackupFileOperations): void {
  if (operations.existsSync(temporaryPath)) {
    operations.rmSync(temporaryPath, { force: true });
  }
}

function pendingCandidates(destinationPath: string): string[] {
  const directory = path.dirname(destinationPath);
  const prefix = `${path.basename(destinationPath)}.previous-`;
  return fs.readdirSync(directory)
    .filter(name => name.startsWith(prefix) && !name.endsWith("-wal") && !name.endsWith("-shm"))
    .map(name => path.join(directory, name))
    .filter(candidate => fs.statSync(candidate).isFile());
}

function assertReadableDatabase(databasePath: string): Database.Database {
  const candidate = new Database(databasePath, { readonly: true, fileMustExist: true });
  const integrity = candidate.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") {
    candidate.close();
    throw new Error(`SQLite integrity_check fallo para ${databasePath}: ${String(integrity)}`);
  }
  return candidate;
}

export async function recoverPendingBackup(
  destinationPath: string,
): Promise<PendingRecoveryResult> {
  if (fs.existsSync(destinationPath)) return { recovered: false, candidatePath: null };

  const activeSidecars = SIDECAR_SUFFIXES
    .map(suffix => `${destinationPath}${suffix}`)
    .filter(sidecar => fs.existsSync(sidecar));
  const candidates = pendingCandidates(destinationPath);

  if (activeSidecars.length > 0) {
    throw new Error(
      `No existe la base principal y hay sidecars potencialmente activos: ${activeSidecars.join(", ")}`,
    );
  }
  if (candidates.length === 0) return { recovered: false, candidatePath: null };
  if (candidates.length > 1) {
    throw new Error(
      `Recuperacion ambigua: existen varios respaldos pendientes: ${candidates.join(", ")}`,
    );
  }

  const candidatePath = candidates[0]!;
  const candidateDb = assertReadableDatabase(candidatePath);
  const temporaryPath = `${destinationPath}.recovery-${process.pid}-${Date.now()}`;

  try {
    await candidateDb.backup(temporaryPath);
  } finally {
    candidateDb.close();
  }

  publishBackupFile(temporaryPath, destinationPath);
  const recoveredDb = assertReadableDatabase(destinationPath);
  recoveredDb.close();

  return { recovered: true, candidatePath };
}

export function publishBackupFile(
  temporaryPath: string,
  destinationPath: string,
  operations: BackupFileOperations = fs,
): BackupPublicationResult {
  const previousPath = rollbackPath(destinationPath);
  const movedSidecars: Array<{ sourcePath: string; stagedPath: string }> = [];
  let state: BackupPublicationState = "TEMP_READY";
  let previousMoved = false;
  let published = false;

  if (!operations.existsSync(temporaryPath)) {
    throw new BackupPublicationError(
      `No existe el respaldo temporal: ${temporaryPath}`,
      state,
      destinationPath,
      temporaryPath,
      previousPath,
      [],
      [],
    );
  }

  try {
    if (operations.existsSync(destinationPath)) {
      operations.renameSync(destinationPath, previousPath);
      previousMoved = true;
      state = "PREVIOUS_MOVED";
    }

    for (const suffix of SIDECAR_SUFFIXES) {
      const sourceSidecar = `${destinationPath}${suffix}`;
      const previousSidecar = `${previousPath}${suffix}`;
      if (operations.existsSync(sourceSidecar)) {
        operations.renameSync(sourceSidecar, previousSidecar);
        movedSidecars.push({ sourcePath: sourceSidecar, stagedPath: previousSidecar });
      }
    }

    operations.renameSync(temporaryPath, destinationPath);
    published = true;
    state = "PUBLISHED";
  } catch (error) {
    if (published) throw error;

    const rollbackErrors: string[] = [];
    state = previousMoved || movedSidecars.length > 0 ? "PREVIOUS_MOVED" : "TEMP_READY";
    try {
      for (const movedSidecar of [...movedSidecars].reverse()) {
        operations.renameSync(movedSidecar.stagedPath, movedSidecar.sourcePath);
      }
    } catch (restoreError) {
      rollbackErrors.push(String(restoreError));
    }
    if (previousMoved) {
      try {
        operations.renameSync(previousPath, destinationPath);
      } catch (restoreError) {
        rollbackErrors.push(String(restoreError));
      }
    }

    if (rollbackErrors.length === 0) {
      removeTemporary(temporaryPath, operations);
      throw error;
    }

    const preservedPaths = [temporaryPath];
    if (previousMoved) preservedPaths.push(previousPath);
    preservedPaths.push(...movedSidecars.map(item => item.stagedPath));
    throw new BackupPublicationError(
      `No se pudo publicar el respaldo; rollback incompleto. Archivos recuperables: ${preservedPaths.join(", ")}`,
      state,
      destinationPath,
      temporaryPath,
      previousPath,
      preservedPaths,
      rollbackErrors,
    );
  }

  state = "CLEANUP";
  const cleanupErrors: string[] = [];
  for (const pathToRemove of [
    ...(previousMoved ? [previousPath] : []),
    ...movedSidecars.map(item => item.stagedPath),
  ]) {
    try {
      operations.rmSync(pathToRemove, { force: true });
    } catch (cleanupError) {
      cleanupErrors.push(`${pathToRemove}: ${String(cleanupError)}`);
    }
  }

  if (cleanupErrors.length > 0) {
    console.warn(`Respaldo publicado; limpieza pendiente: ${cleanupErrors.join(" | ")}`);
  }

  return { state: "PUBLISHED", destinationPath, cleanupErrors };
}

export async function backupDatabase(
  db: Database.Database,
  destinationPath: string,
): Promise<void> {
  const directory = path.dirname(destinationPath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;

  try {
    await db.backup(temporaryPath);
    publishBackupFile(temporaryPath, destinationPath);
  } catch (error) {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}
