import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as XLSX from "xlsx";

import { importarCarteraPorCobrarExcel } from "../../electron/importContifico";
import { TEST_DATABASE_PATH } from "../testDatabasePath";

const SOURCE_DB = TEST_DATABASE_PATH;

const SOURCE_XLS =
  String.raw`C:\Users\j-mej\Downloads\CarteraPorCobrar (2).xls`;

const TEMP_DIR = path.join(process.cwd(), "_test_fiscal_rehydrate");
const TEMP_DB = path.join(TEMP_DIR, "cartera-test.db");
const TEMP_XLS = path.join(TEMP_DIR, "Cartera-reaparicion-test.xls");

fs.rmSync(TEMP_DIR, { recursive: true, force: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

const sourceDb = new Database(SOURCE_DB, { readonly: true });

sourceDb.exec(`
  VACUUM INTO '${TEMP_DB.replace(/'/g, "''")}'
`);

sourceDb.close();

console.log("\n=== 1. PREPARANDO EXCEL TEMPORAL ===");

const workbook = XLSX.readFile(SOURCE_XLS, {
  cellDates: true,
});

const sheetName = workbook.SheetNames[0];

if (!sheetName) {
  throw new Error("El Excel no contiene hojas.");
}

const worksheet = workbook.Sheets[sheetName];

const matrix = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
  header: 1,
  defval: "",
  raw: false,
});

const normalizeHeader = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ");

let headerIndex = -1;

for (let i = 0; i < matrix.length; i += 1) {
  const headers = matrix[i].map(normalizeHeader);

  const hasDocumento = headers.some((h) =>
    ["documento", "# documento", "numero documento", "n documento"].includes(h),
  );

  const hasCliente = headers.some((h) =>
    ["cliente", "razon social", "razon_social"].includes(h),
  );

  const hasTotal = headers.includes("total");

  if (hasDocumento && hasCliente && hasTotal) {
    headerIndex = i;
    break;
  }
}

if (headerIndex < 0) {
  throw new Error("No se pudo identificar la cabecera del reporte.");
}

const headers = matrix[headerIndex].map(normalizeHeader);

const findColumn = (...aliases: string[]): number => {
  for (const alias of aliases) {
    const index = headers.indexOf(normalizeHeader(alias));
    if (index >= 0) return index;
  }

  return -1;
};

const colCliente = 0;
const colTipo = 2;
const colDocumento = 3;
const colEmision = 4;
const colVence = 5;
const colPorVencer = 9;
const colTotal = 15;
const colValor = 17;
if (
  colDocumento < 0 ||
  colCliente < 0 ||
  colTipo < 0 ||
  colEmision < 0 ||
  colTotal < 0
) {
  console.log("HEADERS:", matrix[headerIndex]);
  throw new Error("Faltan columnas obligatorias para construir la fila de prueba.");
}

const newRow = new Array(matrix[headerIndex].length).fill("");

newRow[colDocumento] = "001-001-000022455";
newRow[colCliente] = "CLIENTE PRUEBA REHIDRATACION";
newRow[colTipo] = "FAC";
newRow[colEmision] = "14/08/2026";

if (colVence >= 0) {
  newRow[colVence] = "14/09/2026";
}

newRow[colTotal] = 500;

if (colPorVencer >= 0) {
  newRow[colPorVencer] = 500;
}

if (colValor >= 0) {
  newRow[colValor] = 500;
}

matrix.push(newRow);

const tempWorksheet = XLSX.utils.aoa_to_sheet(matrix);
workbook.Sheets[sheetName] = tempWorksheet;

XLSX.writeFile(workbook, TEMP_XLS, {
  bookType: "xls",
});

console.log("Excel temporal:", TEMP_XLS);
console.log("Documento agregado: 001-001-000022455");
console.log("Saldo fuente simulado: $500.00");


console.log("\n=== 2. ABRIENDO COPIA TEMPORAL DB ===");

const db = new Database(TEMP_DB);

const beforeProduction = db.prepare(`
  SELECT
    mode,
    generation
  FROM reconciliation_control
  WHERE id = 1
`).get();

console.log("Control:", beforeProduction);


console.log("\n=== 3. ANTECEDENTE FISCAL ===");

const fiscalEvidence = db.prepare(`
  SELECT
    documento,
    documento_normalizado,
    fecha_anulacion,
    resultado,
    importacion_id
  FROM documentos_anulados_log
  WHERE documento_normalizado = '1001000022455'
  ORDER BY id DESC
  LIMIT 1
`).get();

console.log(fiscalEvidence);

if (!fiscalEvidence) {
  throw new Error(
    "No existe antecedente fiscal para 1001000022455 en la copia de prueba.",
  );
}


console.log("\n=== 4. CREANDO IMPORTACION TEMPORAL ===");

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
    'Cartera-reaparicion-test.xls',
    'TEST-FISCAL-REHYDRATE-001',
    0,
    0,
    0,
    0,
    'PROCESANDO',
    ?,
    datetime('now','localtime')
  )
`).run(
  Number(
    (beforeProduction as { generation?: number } | undefined)?.generation ?? 3,
  ),
);

const importacionId = Number(insertImport.lastInsertRowid);

console.log("importacionId temporal:", importacionId);


console.log("\n=== 5. EJECUTANDO IMPORTADOR REAL ===");

const result = importarCarteraPorCobrarExcel(
  TEMP_XLS,
  db,
  importacionId,
);

console.log(result);


console.log("\n=== 6. RESULTADO DEL DOCUMENTO REAPARECIDO ===");

const projected = db.prepare(`
  SELECT
    documento,
    documento_normalizado,
    total,
    estado_documento,
    estado_confirmacion,
    estado_fuente,
    anulado,
    saldo_pendiente,
    fecha_anulacion,
    fuente_anulacion
  FROM documentos
  WHERE documento_normalizado = '1001000022455'
    AND is_subtotal = 0
`).get();

console.log(projected);


console.log("\n=== 7. SNAPSHOT BRUTO ===");

const snapshotRaw = db.prepare(`
  SELECT
    s.id AS snapshot_id,
    sd.documento,
    sd.documento_normalizado,
    sd.saldo,
    sd.posicion_cartera
  FROM cartera_snapshots s
  JOIN cartera_snapshot_documentos sd
    ON sd.snapshot_id = s.id
  WHERE s.importacion_id = ?
    AND sd.documento_normalizado = '1001000022455'
`).get(importacionId);

console.log(snapshotRaw);


console.log("\n=== 8. INVARIANTES ===");

const p = projected as any;
const s = snapshotRaw as any;

const checks = {
  documentoMaterializado: Boolean(p),
  estadoAnulado: p?.estado_documento === "ANULADO",
  confirmacionConfirmada: p?.estado_confirmacion === "CONFIRMADO",
  fuenteAnulados: p?.estado_fuente === "ANULADOS",
  flagAnulado: Number(p?.anulado ?? 0) === 1,
  saldoPendienteCero: Math.abs(Number(p?.saldo_pendiente ?? -1)) < 0.005,
  fechaFiscalPreservada: p?.fecha_anulacion === "2026-08-14",
  snapshotConservaFuente:
    Boolean(s) && Math.abs(Number(s?.saldo ?? 0) - 500) < 0.005,
};

console.table(checks);

const failed = Object.entries(checks)
  .filter(([, ok]) => !ok)
  .map(([name]) => name);

db.close();

if (failed.length > 0) {
  console.error("\n❌ PRUEBA FALLIDA:", failed);
  process.exit(1);
}

console.log("\n✅ PRUEBA FISCAL REHYDRATE APROBADA.");
console.log(
  "El snapshot conserva $500 reportados por Contífico, " +
  "pero la proyección queda ANULADA con saldo pendiente $0.",
);





