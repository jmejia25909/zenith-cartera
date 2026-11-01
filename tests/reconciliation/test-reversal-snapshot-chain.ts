import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { importarCarteraPorCobrarExcel } from "../../electron/importContifico";
import { TEST_DATABASE_PATH } from "../testDatabasePath";

const SOURCE_DB = TEST_DATABASE_PATH;

const CARTERA_B =
  String.raw`C:\Users\j-mej\Downloads\CarteraPorCobrar (2).xls`;

const TEMP_DIR = path.resolve("_test_reversal_chain");
const TEMP_DB = path.join(TEMP_DIR, "cartera.db");

fs.rmSync(TEMP_DIR, { recursive: true, force: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

/* ============================================================
   1. COPIA CONSISTENTE
   ============================================================ */

console.log("\n=== 1. CREANDO COPIA CONSISTENTE ===");

const source = new Database(SOURCE_DB, { readonly: true });

source.exec(`
  VACUUM INTO '${TEMP_DB.replace(/'/g, "''")}'
`);

source.close();

const db = new Database(TEMP_DB);

const SNAPSHOT_B = 6;
const IMPORT_B = 28;
const SNAPSHOT_A = 5;

/* ============================================================
   2. VERIFICAR A Y B
   ============================================================ */

console.log("\n=== 2. CADENA ORIGINAL ===");

const before = db.prepare(`
  SELECT
    cs.id,
    cs.importacion_id,
    cs.snapshot_anterior_id,
    cs.hash_contenido,
    i.estado,
    i.metadata_json
  FROM cartera_snapshots cs
  JOIN importaciones i
    ON i.id = cs.importacion_id
  WHERE cs.id IN (?, ?)
  ORDER BY cs.id
`).all(SNAPSHOT_A, SNAPSHOT_B);

console.log(before);

const originalB = db.prepare(`
  SELECT metadata_json
  FROM importaciones
  WHERE id = ?
`).get(IMPORT_B) as { metadata_json?: string } | undefined;

const originalMetadata =
  JSON.parse(originalB?.metadata_json || "{}");

/* ============================================================
   3. OBTENER SNAPSHOT REVERSIBLE DE B
   ============================================================ */

console.log("\n=== 3. SNAPSHOT REVERSIBLE B ===");

const reversible = db.prepare(`
  SELECT payload_json
  FROM importacion_snapshots
  WHERE importacion_id = ?
`).get(IMPORT_B) as { payload_json?: string } | undefined;

if (!reversible?.payload_json) {
  throw new Error(
    "La importación 28 no tiene importacion_snapshots."
  );
}

const portfolioSnapshot =
  JSON.parse(reversible.payload_json) as {
    documentos: Array<Record<string, unknown>>;
    abonos: Array<Record<string, unknown>>;
    alertasCredito: Array<Record<string, unknown>>;
  };

console.log({
  documentos: portfolioSnapshot.documentos.length,
  abonos: portfolioSnapshot.abonos.length,
  alertasCredito: portfolioSnapshot.alertasCredito.length,
});

/* ============================================================
   4. MISMA RESTAURACION QUE requestImportReversal()
   ============================================================ */

function restoreTable(
  table:
    | "documentos"
    | "abonos"
    | "alertas_credito",
  rows: Array<Record<string, unknown>>,
): void {
  db.prepare(`DELETE FROM ${table}`).run();

  if (rows.length === 0) return;

  const columns = Object.keys(rows[0]);

  const quoted = columns.map(
    (column) =>
      `"${column.replace(/"/g, '""')}"`
  );

  const placeholders =
    columns.map(() => "?").join(", ");

  const insert = db.prepare(`
    INSERT INTO ${table}
      (${quoted.join(", ")})
    VALUES
      (${placeholders})
  `);

  for (const row of rows) {
    insert.run(
      ...columns.map(
        (column) => row[column] ?? null
      ),
    );
  }
}

console.log("\n=== 4. REVIRTIENDO B EN COPIA ===");

const reverseTx = db.transaction(() => {
  db.prepare(`
    DELETE FROM documento_eventos
    WHERE importacion_id = ?
  `).run(IMPORT_B);

  db.prepare(`
    DELETE FROM documento_saldos
    WHERE importacion_id = ?
  `).run(IMPORT_B);

  restoreTable(
    "documentos",
    portfolioSnapshot.documentos,
  );

  restoreTable(
    "abonos",
    portfolioSnapshot.abonos,
  );

  restoreTable(
    "alertas_credito",
    portfolioSnapshot.alertasCredito,
  );

  db.prepare(`
    UPDATE importaciones
    SET
      estado = 'REVERTIDA',
      revertido_en = datetime('now','localtime')
    WHERE id = ?
  `).run(IMPORT_B);
});

reverseTx();

console.log(
  db.prepare(`
    SELECT id, estado, revertido_en
    FROM importaciones
    WHERE id = ?
  `).get(IMPORT_B),
);

/* ============================================================
   5. CREAR IMPORTACION C
   ============================================================ */

console.log("\n=== 5. CREANDO IMPORTACION C ===");

const generation = db.prepare(`
  SELECT generation
  FROM reconciliation_control
  WHERE id = 1
`).get() as { generation?: number };

const insertImport = db.prepare(`
  INSERT INTO importaciones (
    tipo,
    archivo_nombre,
    archivo_hash,
    registros_leidos,
    registros_importados,
    registros_ignorados,
    registros_duplicados,
    estado,
    reconciliation_generation,
    importado_en
  )
  VALUES (
    'CARTERA',
    'TEST-C-AFTER-REVERSAL.xls',
    'TEST-C-AFTER-REVERSAL',
    0,
    0,
    0,
    0,
    'PROCESANDO',
    ?,
    datetime('now','localtime')
  )
`).run(Number(generation?.generation ?? 3));

const importC =
  Number(insertImport.lastInsertRowid);

console.log("Importación C:", importC);

/* ============================================================
   6. IMPORTAR NUEVAMENTE B COMO C
   ============================================================ */

console.log("\n=== 6. IMPORTANDO C ===");

const resultC =
  importarCarteraPorCobrarExcel(
    CARTERA_B,
    db,
    importC,
  );

console.log(resultC);

db.prepare(`
  UPDATE importaciones
  SET estado = 'COMPLETADA'
  WHERE id = ?
`).run(importC);

/* ============================================================
   7. SNAPSHOT C
   ============================================================ */

console.log("\n=== 7. SNAPSHOT C ===");

const snapshotC = db.prepare(`
  SELECT
    id,
    importacion_id,
    generation,
    snapshot_anterior_id,
    cantidad_documentos,
    hash_contenido,
    baseline
  FROM cartera_snapshots
  WHERE importacion_id = ?
`).get(importC) as any;

console.log(snapshotC);

/* ============================================================
   8. B SIGUE EXISTIENDO COMO AUDITORIA
   ============================================================ */

console.log("\n=== 8. SNAPSHOT B CONSERVADO ===");

const snapshotB = db.prepare(`
  SELECT
    cs.id,
    cs.importacion_id,
    cs.snapshot_anterior_id,
    cs.hash_contenido,
    i.estado
  FROM cartera_snapshots cs
  JOIN importaciones i
    ON i.id = cs.importacion_id
  WHERE cs.id = ?
`).get(SNAPSHOT_B) as any;

console.log(snapshotB);

/* ============================================================
   9. INVARIANTES
   ============================================================ */

console.log("\n=== 9. INVARIANTES ===");

const checks = {
  bQuedaRevertido:
    snapshotB?.estado === "REVERTIDA",

  bConservadoAuditoria:
    Number(snapshotB?.id) === SNAPSHOT_B,

  cNoUsaB:
    Number(snapshotC?.snapshot_anterior_id) !==
      SNAPSHOT_B,

  cUsaA:
    Number(snapshotC?.snapshot_anterior_id) ===
      SNAPSHOT_A,

  cNoEsBaseline:
    resultC.baseline === false,

  mismosDocumentosB:
    Number(resultC.insertedDocs) === 648,

  nuevosIgualesB:
    Number(resultC.nuevos) ===
      Number(originalMetadata.nuevos ?? 43),

  reducidosIgualesB:
    Number(resultC.reducidos) ===
      Number(originalMetadata.reducidos ?? 20),

  incrementadosIgualesB:
    Number(resultC.incrementados) ===
      Number(originalMetadata.incrementados ?? 0),

  desaparecidosIgualesB:
    Number(resultC.desaparecidos) ===
      Number(originalMetadata.desaparecidos ?? 22),

  hashCEquivaleB:
    snapshotC?.hash_contenido ===
      snapshotB?.hash_contenido,
};

console.table(checks);

const failed = Object.entries(checks)
  .filter(([, ok]) => !ok)
  .map(([name]) => name);

db.close();

if (failed.length > 0) {
  console.error(
    "\n❌ PRUEBA REVERSAL CHAIN FALLIDA:",
    failed,
  );

  process.exit(1);
}

console.log(
  "\n✅ PRUEBA REVERSAL SNAPSHOT CHAIN APROBADA."
);

console.log(
  "B permanece como evidencia REVERTIDA, " +
  "pero C compara correctamente contra A."
);

