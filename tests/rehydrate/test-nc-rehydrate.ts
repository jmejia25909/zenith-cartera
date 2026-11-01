import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as XLSX from "xlsx";

import { importCreditNotesExcel } from "../../electron/importCreditNotes";
import { TEST_DATABASE_PATH } from "../testDatabasePath";

const SOURCE_DB = TEST_DATABASE_PATH;

const TEMP_DIR = path.join(process.cwd(), "_test_nc_rehydrate");
const TEMP_DB = path.join(TEMP_DIR, "cartera-nc-test.db");
const TEMP_XLS = path.join(TEMP_DIR, "NotasCredito-overlap-test.xls");

const NC = "1001000000417";
const DOC = "1001000019779";

fs.rmSync(TEMP_DIR, { recursive: true, force: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

/* ============================================================
   1. COPIA CONSISTENTE DE SQLITE/WAL
   ============================================================ */

const sourceDb = new Database(SOURCE_DB, { readonly: true });

sourceDb.exec(`
  VACUUM INTO '${TEMP_DB.replace(/'/g, "''")}'
`);

sourceDb.close();

const db = new Database(TEMP_DB);

console.log("\n=== 1. NC ORIGINAL ===");

const ncBefore = db.prepare(`
  SELECT *
  FROM notas_credito_importadas
  WHERE numero_nc_normalizado = ?
`).get(NC) as any;

console.log(ncBefore);

if (!ncBefore) {
  throw new Error("No existe NC 417 en la copia temporal.");
}

if (ncBefore.estado_conciliacion !== "PENDIENTE_CONCILIACION") {
  throw new Error("La NC de prueba ya no está pendiente.");
}

const originalImportId = Number(ncBefore.importacion_id);

/* ============================================================
   2. SIMULAR REAPARICION DE LA FACTURA
   ============================================================ */

console.log("\n=== 2. SIMULANDO REAPARICION FACTURA ===");

const template = db.prepare(`
  SELECT *
  FROM documentos
  WHERE is_subtotal = 0
  LIMIT 1
`).get() as Record<string, unknown> | undefined;

if (!template) {
  throw new Error("No existe documento plantilla.");
}

const cloned: Record<string, unknown> = { ...template };

delete cloned.id;

cloned.documento = "001-001-000019779";
cloned.documento_normalizado = DOC;
cloned.tipo_documento = "FAC";
cloned.cliente = "ISOLATOT SA";
cloned.razon_social = "ISOLATOT SA";
cloned.total = 638.94;
cloned.valor_documento = 638.94;
cloned.saldo_pendiente = 638.94;
cloned.saldo_original = 638.94;
cloned.posicion_cartera = "DEUDA_VIVA";
cloned.estado_documento = "ACTIVO_PENDIENTE";
cloned.estado_confirmacion = "CONFIRMADO";
cloned.estado_fuente = "CARTERA_CONTIFICO";
cloned.anulado = 0;
cloned.is_subtotal = 0;

const columns = Object.keys(cloned);
const placeholders = columns.map(() => "?").join(",");

db.prepare(`
  INSERT INTO documentos (${columns.join(",")})
  VALUES (${placeholders})
`).run(...columns.map((column) => cloned[column]));

console.log(
  db.prepare(`
    SELECT
      documento,
      documento_normalizado,
      total,
      estado_documento,
      saldo_pendiente
    FROM documentos
    WHERE documento_normalizado = ?
  `).get(DOC)
);

/* ============================================================
   3. EXCEL SUPERPUESTO CON LA MISMA NC
   ============================================================ */

console.log("\n=== 3. CREANDO EXCEL NC SUPERPUESTO ===");

const rows = [
  [
    "Fecha",
    "Tipo Documento",
    "# Documento",
    "# Tipo Documento Relacionado",
    "# Documento Relacionado",
    "Autorizacion",
    "Persona",
    "Identificacion",
    "Vendedor",
    "Subtotal IVA mayor a 0%",
    "Subtotal IVA 0%",
    "IVA",
    "Total",
    "Saldo",
    "Estado",
    "Descripcion",
  ],
  [
    "06/08/2026",
    "Nota de Credito",
    "001-001-000000417",
    "Factura",
    "001-001-000019779",
    "0608202604099315790200120010010000004171167136111",
    "ISOLATOT SA",
    "0992839155001",
    "VAQUE VERA VICTOR BOLIVAR",
    555.60,
    0,
    83.34,
    638.94,
    0,
    "Pagado",
    "SE REALIZA LA REFACTURACION EN EL MES DE JULIO",
  ],
];

const workbook = XLSX.utils.book_new();
const worksheet = XLSX.utils.aoa_to_sheet(rows);

XLSX.utils.book_append_sheet(
  workbook,
  worksheet,
  "Notas de Credito",
);

XLSX.writeFile(workbook, TEMP_XLS, {
  bookType: "xls",
});

console.log("Excel:", TEMP_XLS);

/* ============================================================
   4. IMPORTACION TEMPORAL
   ============================================================ */

const control = db.prepare(`
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
    'NOTAS_CREDITO',
    'NotasCredito-overlap-test.xls',
    'TEST-NC-REHYDRATE-001',
    0,
    0,
    0,
    0,
    'PROCESANDO',
    ?,
    datetime('now','localtime')
  )
`).run(Number(control?.generation ?? 3));

const testImportId = Number(insertImport.lastInsertRowid);

console.log("\nImportacion temporal:", testImportId);

/* ============================================================
   5. EJECUTAR IMPORTADOR REAL
   ============================================================ */

console.log("\n=== 4. EJECUTANDO IMPORTADOR REAL ===");

const result = importCreditNotesExcel(
  TEMP_XLS,
  db,
  testImportId,
);

console.log(result);

/* ============================================================
   6. RESULTADOS
   ============================================================ */

console.log("\n=== 5. NC DESPUES ===");

const ncAfter = db.prepare(`
  SELECT *
  FROM notas_credito_importadas
  WHERE numero_nc_normalizado = ?
`).get(NC) as any;

console.log(ncAfter);

console.log("\n=== 6. EVENTOS NC ===");

const events = db.prepare(`
  SELECT
    event_key,
    documento_normalizado,
    tipo_evento,
    fuente,
    importe,
    importacion_id,
    ocurrido_en,
    metadata_json
  FROM documento_eventos
  WHERE event_key = ?
`).all(`NC:${NC}:${DOC}`);

console.log(events);

console.log("\n=== 7. PROYECCION FACTURA ===");

const projected = db.prepare(`
  SELECT
    documento,
    documento_normalizado,
    total,
    saldo_pendiente,
    estado_documento,
    estado_confirmacion,
    estado_fuente
  FROM documentos
  WHERE documento_normalizado = ?
`).get(DOC) as any;

console.log(projected);

console.log("\n=== 8. IMPORTACION TEST ===");

const testImport = db.prepare(`
  SELECT
    id,
    registros_leidos,
    registros_importados,
    registros_ignorados,
    registros_duplicados,
    estado,
    metadata_json
  FROM importaciones
  WHERE id = ?
`).get(testImportId) as any;

console.log(testImport);

/* ============================================================
   7. INVARIANTES
   ============================================================ */

console.log("\n=== 9. INVARIANTES ===");

const metadata = JSON.parse(testImport?.metadata_json || "{}");

const checks = {
  mismaNcFisica:
    Number(ncAfter?.id) === Number(ncBefore?.id),

  importacionOriginalPreservada:
    Number(ncAfter?.importacion_id) === originalImportId &&
    originalImportId === 19,

  conciliada:
    ncAfter?.estado_conciliacion === "CONCILIADA",

  unSoloEvento:
    events.length === 1,

  eventoNcCorrecto:
    events[0]?.tipo_evento === "NOTA_CREDITO_APLICADA",

  eventoConImportacionOriginal:
    Number(events[0]?.importacion_id) === originalImportId,

  proyeccionAjustadaNc:
    projected?.estado_documento === "AJUSTADO_NC" &&
    projected?.estado_fuente === "NOTAS_CREDITO",

  saldoNoRestadoDosVeces:
    Math.abs(Number(projected?.saldo_pendiente) - 638.94) < 0.005,

  ceroNuevas:
    Number(testImport?.registros_importados) === 0,

  historicaIgnorada:
    Number(testImport?.registros_ignorados) === 1,

  ceroDuplicadosExcel:
    Number(testImport?.registros_duplicados) === 0,

  metadataHistorica:
    Number(metadata.historicalDuplicates) === 1,

  metadataRehidratada:
    Number(metadata.rehydratedCreditNotes) === 1,
};

console.table(checks);

const failed = Object.entries(checks)
  .filter(([, value]) => !value)
  .map(([key]) => key);

db.close();

if (failed.length > 0) {
  console.error("\nPRUEBA NC FALLIDA:", failed);
  process.exit(1);
}

console.log("\n✅ PRUEBA NC OVERLAP + REHIDRATACION APROBADA.");

