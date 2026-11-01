import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { backupDatabase, publishBackupFile, recoverPendingBackup, type BackupFileOperations } from '../../electron/sqliteBackup';
import { restoreDatabaseFile } from '../../electron/databaseSafety';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-sqlite-backup-'));
const sourcePath = path.join(root, 'source.db');
const backupPath = path.join(root, 'backup.db');
const restoredPath = path.join(root, 'restored.db');

function cleanup(): void {
  fs.rmSync(root, { recursive: true, force: true });
}

async function run(): Promise<void> {
  const recoveryPath = path.join(root, 'recovery.db');
  const recoveryCandidate = `${recoveryPath}.previous-test`;
  const recoverySource = new Database(recoveryCandidate);
  recoverySource.pragma('journal_mode = WAL');
  recoverySource.exec('CREATE TABLE datos(id INTEGER PRIMARY KEY, valor TEXT NOT NULL)');
  recoverySource.prepare('INSERT INTO datos VALUES (1, ?)').run('recuperado');
  try {
    assert.equal((await recoverPendingBackup(recoveryPath)).recovered, true);
    const recovered = new Database(recoveryPath, { readonly: true });
    try {
      assert.equal(recovered.prepare('SELECT valor FROM datos WHERE id=1').pluck().get(), 'recuperado');
      assert.equal(recovered.pragma('integrity_check', { simple: true }), 'ok');
    } finally {
      recovered.close();
    }
    assert.equal(fs.existsSync(recoveryCandidate), true);
    const destinationWal = `${recoveryPath}-wal`;
    assert.ok(!fs.existsSync(destinationWal) || fs.statSync(destinationWal).size === 0);
  } finally {
    recoverySource.close();
  }

  const existingPath = path.join(root, 'existing.db');
  const existingCandidate = `${existingPath}.previous-existing`;
  const existingDb = new Database(existingPath);
  existingDb.exec('CREATE TABLE datos(valor TEXT NOT NULL)');
  existingDb.prepare('INSERT INTO datos VALUES (?)').run('principal');
  existingDb.close();
  fs.writeFileSync(existingCandidate, 'should-not-be-used');
  assert.deepEqual(await recoverPendingBackup(existingPath), { recovered: false, candidatePath: null });
  const existingCheck = new Database(existingPath, { readonly: true });
  assert.equal(existingCheck.prepare('SELECT valor FROM datos').pluck().get(), 'principal');
  existingCheck.close();

  const multiplePath = path.join(root, 'multiple.db');
  fs.writeFileSync(`${multiplePath}.previous-a`, 'candidate-a');
  fs.writeFileSync(`${multiplePath}.previous-b`, 'candidate-b');
  await assert.rejects(() => recoverPendingBackup(multiplePath), /Recuperacion ambigua/);
  assert.equal(fs.existsSync(multiplePath), false);

  const corruptPath = path.join(root, 'corrupt.db');
  fs.writeFileSync(`${corruptPath}.previous-corrupt`, 'not sqlite');
  await assert.rejects(() => recoverPendingBackup(corruptPath), /SQLite|malformed|file is not a database/);
  assert.equal(fs.existsSync(corruptPath), false);

  const activeSidecarPath = path.join(root, 'active-sidecar.db');
  fs.writeFileSync(`${activeSidecarPath}-wal`, 'active-sidecar');
  await assert.rejects(() => recoverPendingBackup(activeSidecarPath), /sidecars potencialmente activos/);
  assert.equal(fs.existsSync(activeSidecarPath), false);

  const firstRenamePath = path.join(root, 'first-rename.db');
  const firstRenameTemp = path.join(root, 'first-rename.tmp');
  fs.writeFileSync(firstRenamePath, 'old-first');
  fs.writeFileSync(`${firstRenamePath}-wal`, 'old-wal');
  fs.writeFileSync(`${firstRenamePath}-shm`, 'old-shm');
  fs.writeFileSync(firstRenameTemp, 'new-first');
  const firstRenameFailure: BackupFileOperations = {
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    rmSync: fs.rmSync,
    renameSync: () => { throw new Error('first rename failed'); },
  };
  assert.throws(() => publishBackupFile(firstRenameTemp, firstRenamePath, firstRenameFailure), /first rename failed/);
  assert.equal(fs.readFileSync(firstRenamePath, 'utf8'), 'old-first');
  assert.equal(fs.readFileSync(`${firstRenamePath}-wal`, 'utf8'), 'old-wal');
  assert.equal(fs.readFileSync(`${firstRenamePath}-shm`, 'utf8'), 'old-shm');
  assert.equal(fs.existsSync(firstRenameTemp), false);

  const secondRenamePath = path.join(root, 'second-rename.db');
  const secondRenameTemp = path.join(root, 'second-rename.tmp');
  fs.writeFileSync(secondRenamePath, 'old-second');
  fs.writeFileSync(`${secondRenamePath}-wal`, 'old-second-wal');
  fs.writeFileSync(secondRenameTemp, 'new-second');
  let secondRenameCount = 0;
  const secondRenameFailure: BackupFileOperations = {
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    rmSync: fs.rmSync,
    renameSync(source, destination) {
      secondRenameCount += 1;
      if (secondRenameCount === 2) throw new Error('second rename failed');
      fs.renameSync(source, destination);
    },
  };
  assert.throws(() => publishBackupFile(secondRenameTemp, secondRenamePath, secondRenameFailure), /second rename failed/);
  assert.equal(fs.readFileSync(secondRenamePath, 'utf8'), 'old-second');
  assert.equal(fs.readFileSync(`${secondRenamePath}-wal`, 'utf8'), 'old-second-wal');
  assert.equal(fs.existsSync(secondRenameTemp), false);

  const rollbackFailurePath = path.join(root, 'rollback-failure.db');
  const rollbackFailureTemp = path.join(root, 'rollback-failure.tmp');
  const rollbackDb = new Database(rollbackFailurePath);
  rollbackDb.exec('CREATE TABLE datos(id INTEGER PRIMARY KEY, valor TEXT NOT NULL)');
  rollbackDb.prepare('INSERT INTO datos VALUES (1, ?)').run('respaldo-anterior');
  rollbackDb.close();
  fs.writeFileSync(`${rollbackFailurePath}-wal`, 'old-rollback-wal');
  fs.writeFileSync(rollbackFailureTemp, 'new-rollback');
  let rollbackCount = 0;
  const rollbackFailure: BackupFileOperations = {
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    rmSync: fs.rmSync,
    renameSync(source, destination) {
      rollbackCount += 1;
      if (rollbackCount === 2) throw new Error('publish rename failed');
      if (rollbackCount === 3) throw new Error('rollback rename failed');
      fs.renameSync(source, destination);
    },
  };
  assert.throws(() => publishBackupFile(rollbackFailureTemp, rollbackFailurePath, rollbackFailure), /rollback incompleto/);
  const preservedPrevious = fs.readdirSync(root).find(name => name.startsWith('rollback-failure.db.previous-'));
  assert.ok(preservedPrevious);
  const preservedDb = new Database(path.join(root, preservedPrevious!), { readonly: true });
  assert.equal(preservedDb.prepare('SELECT valor FROM datos WHERE id=1').pluck().get(), 'respaldo-anterior');
  assert.equal(preservedDb.pragma('integrity_check', { simple: true }), 'ok');
  preservedDb.close();
  assert.equal(fs.existsSync(rollbackFailureTemp), true);

  const cleanupPath = path.join(root, 'cleanup.db');
  const cleanupTemp = path.join(root, 'cleanup.tmp');
  fs.writeFileSync(cleanupPath, 'old-cleanup');
  fs.writeFileSync(cleanupTemp, 'new-cleanup');
  const cleanupFailure: BackupFileOperations = {
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    renameSync: fs.renameSync,
    rmSync(source, options) {
      if (String(source).includes('.previous-')) throw new Error('cleanup failed');
      fs.rmSync(source, options);
    },
  };
  const cleanupResult = publishBackupFile(cleanupTemp, cleanupPath, cleanupFailure);
  assert.equal(cleanupResult.state, 'PUBLISHED');
  assert.equal(cleanupResult.cleanupErrors.length, 1);
  assert.equal(fs.readFileSync(cleanupPath, 'utf8'), 'new-cleanup');

  const replacementPath = path.join(root, 'replacement.db');
  fs.writeFileSync(replacementPath, 'old-backup');
  const replacementTemp = path.join(root, 'replacement.tmp');
  fs.writeFileSync(replacementTemp, 'new-backup');
  publishBackupFile(replacementTemp, replacementPath);
  assert.equal(fs.readFileSync(replacementPath, 'utf8'), 'new-backup');

  const failedPath = path.join(root, 'failed-replacement.db');
  const failedTemp = path.join(root, 'failed-replacement.tmp');
  fs.writeFileSync(failedPath, 'recoverable-old-backup');
  fs.writeFileSync(failedTemp, 'new-backup-that-will-fail');
  let renameCount = 0;
  const failingOperations = {
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    rmSync: fs.rmSync,
    renameSync(source: fs.PathLike, destination: fs.PathLike): void {
      renameCount += 1;
      if (renameCount === 2) throw new Error('simulated publish failure');
      fs.renameSync(source, destination);
    },
  };
  assert.throws(() => publishBackupFile(failedTemp, failedPath, failingOperations), /simulated publish failure/);
  assert.equal(fs.readFileSync(failedPath, 'utf8'), 'recoverable-old-backup');
  assert.equal(fs.existsSync(failedTemp), false);

  const sidecarPath = path.join(root, 'sidecars.db');
  const sidecarTemp = path.join(root, 'sidecars.tmp');
  fs.writeFileSync(sidecarPath, 'old-backup');
  fs.writeFileSync(`${sidecarPath}-wal`, 'stale-wal');
  fs.writeFileSync(`${sidecarPath}-shm`, 'stale-shm');
  fs.writeFileSync(sidecarTemp, 'new-backup');
  publishBackupFile(sidecarTemp, sidecarPath);
  assert.equal(fs.readFileSync(sidecarPath, 'utf8'), 'new-backup');
  assert.equal(fs.existsSync(`${sidecarPath}-wal`), false);
  assert.equal(fs.existsSync(`${sidecarPath}-shm`), false);

  const db = new Database(sourcePath);
  try {
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE eventos(id INTEGER PRIMARY KEY, valor TEXT NOT NULL)');
    db.prepare('INSERT INTO eventos VALUES (?, ?)').run(1, 'inicial');
    db.prepare('INSERT INTO eventos VALUES (?, ?)').run(2, 'confirmado-en-WAL');
    assert.equal(fs.existsSync(`${sourcePath}-wal`), true);

    await backupDatabase(db, backupPath);
    restoreDatabaseFile(restoredPath, backupPath);

    let restored = new Database(restoredPath, { readonly: true });
    try {
      assert.deepEqual(restored.prepare('SELECT * FROM eventos ORDER BY id').all(), [
        { id: 1, valor: 'inicial' },
        { id: 2, valor: 'confirmado-en-WAL' },
      ]);
      assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
    } finally {
      restored.close();
    }

    db.prepare('INSERT INTO eventos VALUES (?, ?)').run(3, 'segundo-respaldo');
    await backupDatabase(db, backupPath);
    restoreDatabaseFile(restoredPath, backupPath);
    restored = new Database(restoredPath, { readonly: true });
    try {
      assert.equal(restored.prepare('SELECT COUNT(*) FROM eventos').pluck().get(), 3);
      assert.equal(restored.prepare('SELECT valor FROM eventos WHERE id=3').pluck().get(), 'segundo-respaldo');
      assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
    } finally {
      restored.close();
    }
  } finally {
    db.close();
  }

  const closedDb = new Database(sourcePath, { readonly: true });
  closedDb.close();
  const closedDbBackupPath = path.join(root, 'closed-db-failed.db');
  await assert.rejects(() => backupDatabase(closedDb, closedDbBackupPath));
  assert.equal(fs.existsSync(closedDbBackupPath), false);
  assert.equal(fs.readdirSync(root).some(name => name.includes('.tmp-')), false);
}

run()
  .then(() => {
    console.log('SQLITE_BACKUP_RESULT_JSON=' + JSON.stringify({ status: 'PASS' }));
    cleanup();
  })
  .catch(error => {
    console.error(error);
    cleanup();
    process.exitCode = 1;
  });
