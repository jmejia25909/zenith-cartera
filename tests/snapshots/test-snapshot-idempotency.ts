import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { importarCarteraPorCobrarExcel } from "../../electron/importContifico";
import { TEST_DATABASE_PATH } from "../testDatabasePath";

const SOURCE_DB = TEST_DATABASE_PATH;

const CARTERA =
  String.raw`C:\Users\j-mej\Downloads\CarteraPorCobrar (2).xls`;

const TEMP_DIR = path.resolve("_test_snapshot_idempotency");
const TEMP_DB = path.join(TEMP_DIR, "cartera.db");

fs.rmSync(TEMP_DIR, { recursive: true, force: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

console.log("\n=== 1. CREANDO COPIA CONSISTENTE ===");

const source = new Database(SOURCE_DB, { readonly: true });

source.exec(`
  VACUUM INTO '${TEMP_DB.replace(/'/g, "''")}'
`);

source.close();

const db = new Database(TEMP_DB);

const control = db.prepare(`
  SELECT mode, generation, cutoff_date
  FROM reconciliation_control
  WHERE id = 1
`).get();

console.log("Control:", control);

function createImport(): number {
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
      'TEST-IDEMPOTENCIA.xls',
      'TEST-IDEMPOTENCIA',
      'PROCESANDO',
      datetime('now','localtime')
    )
  `).run();

  return Number(result.lastInsertRowid);
}

function finishImport(id: number): void {
  db.prepare(`
    UPDATE importaciones
    SET estado = 'COMPLETADA'
    WHERE id = ?
  `).run(id);
}

console.log("\n=== 2. PRIMERA CARGA DEL MISMO ARCHIVO ===");

const import1 = createImport();

const result1 = importarCarteraPorCobrarExcel(
  CARTERA,
  db,
  import1,
);

finishImport(import1);

console.log(result1);

console.log("\n=== 3. SEGUNDA CARGA DEL MISMO ARCHIVO ===");

const import2 = createImport();

const result2 = importarCarteraPorCobrarExcel(
  CARTERA,
  db,
  import2,
);

finishImport(import2);

console.log(result2);

console.log("\n=== 4. SNAPSHOTS GENERADOS ===");

const snapshots = db.prepare(`
  SELECT
    id,
    importacion_id,
    generation,
    snapshot_anterior_id,
    fecha_snapshot,
    cantidad_documentos,
    hash_contenido,
    baseline
  FROM cartera_snapshots
  ORDER BY id DESC
  LIMIT 4
`).all();

console.log(snapshots);

console.log("\n=== 5. EVENTOS GENERADOS POR CADA CARGA ===");

const events = db.prepare(`
  SELECT
    importacion_id,
    COUNT(*) AS eventos
  FROM documento_eventos
  WHERE importacion_id IN (?, ?)
  GROUP BY importacion_id
  ORDER BY importacion_id
`).all(import1, import2);

console.log(events);

console.log("\n=== 6. INVARIANTES SEGUNDA CARGA ===");

const invariants = {
  nuevosCero:
    result2.nuevos === 0,

  reducidosCero:
    result2.reducidos === 0,

  incrementadosCero:
    result2.incrementados === 0,

  desaparecidosCero:
    result2.desaparecidos === 0,

  eventosCero:
    result2.eventosGenerados === 0,

  todosSinCambios:
    result2.sinCambios === result2.insertedDocs,

  mismoHash:
    snapshots.length >= 2 &&
    (snapshots[0] as any).hash_contenido ===
      (snapshots[1] as any).hash_contenido,
};

console.table(invariants);

const approved = Object.values(invariants).every(Boolean);

if (!approved) {
  console.error(
    "\n❌ PRUEBA DE IDEMPOTENCIA FALLIDA."
  );

  db.close();
  process.exit(1);
}

console.log(
  "\n✅ IDEMPOTENCIA DE CARTERA APROBADA."
);

console.log(
  "La segunda carga idéntica conserva el snapshot para auditoría, " +
  "pero no genera movimientos ni eventos falsos."
);

db.close();

