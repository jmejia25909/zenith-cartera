import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { importarCarteraPorCobrarExcel } from "../../electron/importContifico";
import { TEST_DATABASE_PATH } from "../testDatabasePath";

const SOURCE_DB = TEST_DATABASE_PATH;

const CARTERA =
  String.raw`C:\Users\j-mej\Downloads\CarteraPorCobrar (2).xls`;

const TEMP_DIR = path.resolve("_test_reversal_determinism");
const TEMP_DB = path.join(TEMP_DIR, "cartera.db");

fs.rmSync(TEMP_DIR, { recursive: true, force: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

const source = new Database(SOURCE_DB, { readonly: true });

source.exec(`
  VACUUM INTO '${TEMP_DB.replace(/'/g, "''")}'
`);

source.close();

const db = new Database(TEMP_DB);

type Row = Record<string, unknown>;

type PortfolioState = {
  documentos: Row[];
  abonos: Row[];
  alertasCredito: Row[];
};

function captureState(): PortfolioState {
  return {
    documentos: db.prepare("SELECT * FROM documentos ORDER BY id").all() as Row[],
    abonos: db.prepare("SELECT * FROM abonos ORDER BY id").all() as Row[],
    alertasCredito: db.prepare("SELECT * FROM alertas_credito ORDER BY id").all() as Row[],
  };
}

function restoreTable(
  table: "documentos" | "abonos" | "alertas_credito",
  rows: Row[],
): void {
  db.prepare(`DELETE FROM ${table}`).run();

  if (rows.length === 0) return;

  const columns = Object.keys(rows[0]);
  const quoted = columns.map(
    (column) => `"${column.replace(/"/g, '""')}"`,
  );
  const placeholders = columns.map(() => "?").join(", ");

  const insert = db.prepare(
    `INSERT INTO ${table} (${quoted.join(", ")})
     VALUES (${placeholders})`,
  );

  for (const row of rows) {
    insert.run(
      ...columns.map((column) => row[column] ?? null),
    );
  }
}

function restoreState(state: PortfolioState): void {
  restoreTable("documentos", state.documentos);
  restoreTable("abonos", state.abonos);
  restoreTable("alertas_credito", state.alertasCredito);
}

function createImport(label: string): number {
  const result = db.prepare(`
    INSERT INTO importaciones (
      tipo,
      archivo_nombre,
      archivo_hash,
      estado,
      importado_en
    )
    VALUES (
      'CARTERA',
      ?,
      ?,
      'PROCESANDO',
      datetime('now','localtime')
    )
  `).run(label, label);

  return Number(result.lastInsertRowid);
}

function finishImport(id: number): void {
  db.prepare(`
    UPDATE importaciones
    SET estado = 'COMPLETADA'
    WHERE id = ?
  `).run(id);
}

function canonicalPortfolio(): string {
  return JSON.stringify(
    db.prepare(`
      SELECT
        documento_normalizado,
        ROUND(total, 2) AS total,
        estado_documento,
        estado_confirmacion,
        estado_fuente,
        ROUND(COALESCE(saldo_pendiente, 0), 2) AS saldo_pendiente,
        anulado
      FROM documentos
      WHERE is_subtotal = 0
      ORDER BY documento_normalizado
    `).all(),
  );
}

function fiscalEventCount(): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS total
    FROM documento_eventos
    WHERE fuente IN (
      'ANULADOS',
      'NOTAS_CREDITO',
      'COBROS_MOVIMIENTOS'
    )
  `).get() as { total: number };

  return Number(row.total);
}

console.log("\n=== ESTADO A ===");

const stateA = captureState();
const portfolioA = canonicalPortfolio();
const fiscalBefore = fiscalEventCount();

console.log("Documentos:", stateA.documentos.length);
console.log("Eventos fiscales:", fiscalBefore);


console.log("\n=== A -> IMPORTAR B ===");

const importB1 = createImport("TEST-REVERSAL-B1");

const resultB1 = importarCarteraPorCobrarExcel(
  CARTERA,
  db,
  importB1,
);

finishImport(importB1);

const portfolioB1 = canonicalPortfolio();

console.log(resultB1);


console.log("\n=== REVERTIR B -> A ===");

const reverse = db.transaction(() => {
  db.prepare(`
    DELETE FROM documento_eventos
    WHERE importacion_id = ?
  `).run(importB1);

  db.prepare(`
    DELETE FROM documento_saldos
    WHERE importacion_id = ?
  `).run(importB1);

  restoreState(stateA);

  db.prepare(`
    UPDATE importaciones
    SET
      estado = 'REVERTIDA',
      revertido_en = datetime('now','localtime')
    WHERE id = ?
  `).run(importB1);
});

reverse();

const portfolioAfterReverse = canonicalPortfolio();
const fiscalAfterReverse = fiscalEventCount();


console.log("\n=== REIMPORTAR B ===");

const importB2 = createImport("TEST-REVERSAL-B2");

const resultB2 = importarCarteraPorCobrarExcel(
  CARTERA,
  db,
  importB2,
);

finishImport(importB2);

const portfolioB2 = canonicalPortfolio();

console.log(resultB2);


console.log("\n=== INVARIANTES ===");

const eventsB1 = db.prepare(`
  SELECT COUNT(*) AS total
  FROM documento_eventos
  WHERE importacion_id = ?
`).get(importB1) as { total: number };

const eventsB2 = db.prepare(`
  SELECT COUNT(*) AS total
  FROM documento_eventos
  WHERE importacion_id = ?
`).get(importB2) as { total: number };

const revertedSnapshot = db.prepare(`
  SELECT
    cs.id,
    cs.importacion_id,
    i.estado
  FROM cartera_snapshots cs
  JOIN importaciones i
    ON i.id = cs.importacion_id
  WHERE cs.importacion_id = ?
`).get(importB1);

const activePreviousOfB2 = db.prepare(`
  SELECT
    cs.id,
    cs.importacion_id,
    i.estado
  FROM cartera_snapshots cs
  JOIN importaciones i
    ON i.id = cs.importacion_id
  WHERE cs.id = ?
`).get(resultB2.snapshotAnteriorId ?? -1);

const invariants = {
  retornoExactoA:
    portfolioAfterReverse === portfolioA,

  reconstruccionExactaB:
    portfolioB2 === portfolioB1,

  eventosB1Eliminados:
    Number(eventsB1.total) === 0,

  eventosB2GeneradosSegunResultado:
    Number(eventsB2.total) === resultB2.eventosGenerados,

  fiscalesPreservados:
    fiscalBefore === fiscalAfterReverse,

  snapshotRevertidoConservado:
    Boolean(revertedSnapshot),

  snapshotRevertidoMarcado:
    (revertedSnapshot as any)?.estado === "REVERTIDA",

  cadenaB2NoUsaSnapshotRevertido:
    (activePreviousOfB2 as any)?.importacion_id !== importB1,

  cadenaB2UsaSnapshotActivo:
    ["COMPLETADA", "COMPLETADA_ADVERTENCIAS"].includes(
      String((activePreviousOfB2 as any)?.estado ?? ""),
    ),
};

console.table(invariants);

console.log("\nSnapshot revertido:", revertedSnapshot);
console.log("Anterior efectivo B2:", activePreviousOfB2);

const approved =
  Object.values(invariants).every(Boolean);

if (!approved) {
  console.error(
    "\n❌ REVERSIBILIDAD DETERMINISTA FALLIDA.",
  );

  db.close();
  process.exit(1);
}

console.log(
  "\n✅ REVERSIBILIDAD DETERMINISTA APROBADA.",
);

console.log(
  "A -> B -> reversión -> A -> B produce estados equivalentes, " +
  "preserva evidencia fiscal y excluye el snapshot revertido de la cadena activa.",
);

db.close();

