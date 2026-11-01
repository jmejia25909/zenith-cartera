import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as XLSX from "xlsx";

import { importCollectionMovementsExcel } from "../../electron/importCollectionMovements";
import { TEST_DATABASE_PATH } from "../testDatabasePath";

const SOURCE_DB = TEST_DATABASE_PATH;

const TEMP_DIR =
  path.join(process.cwd(), "_test_cobro_rehydrate");

const TEMP_DB =
  path.join(TEMP_DIR, "cartera-cobro-test.db");

const TEMP_XLS =
  path.join(TEMP_DIR, "Cobros-overlap-test.xls");

const MOV =
  "ae5a148ebd5fa689fef3b02819792b5d57fbf3406afce825d55faf14c1997312";

const DOC =
  "1001000022032";

fs.rmSync(TEMP_DIR, {
  recursive: true,
  force: true,
});

fs.mkdirSync(TEMP_DIR, {
  recursive: true,
});

/* ============================================================
   1. COPIA CONSISTENTE SQLITE/WAL
   ============================================================ */

const sourceDb = new Database(
  SOURCE_DB,
  { readonly: true },
);

sourceDb.exec(`
  VACUUM INTO '${TEMP_DB.replace(/'/g, "''")}'
`);

sourceDb.close();

const db = new Database(TEMP_DB);


/* ============================================================
   2. ESTADO ORIGINAL
   ============================================================ */

console.log("\n=== 1. MOVIMIENTO ORIGINAL ===");

const movementBefore = db.prepare(`
  SELECT *
  FROM cobros_movimientos_importados
  WHERE movimiento_key = ?
`).get(MOV) as any;

console.log(movementBefore);

if (!movementBefore) {
  throw new Error("Movimiento histórico de prueba no encontrado.");
}

if (
  movementBefore.estado_conciliacion !==
  "PENDIENTE_CONCILIACION"
) {
  throw new Error(
    "El movimiento seleccionado ya no está pendiente.",
  );
}

const originalMovementId =
  Number(movementBefore.id);

const originalImportId =
  Number(movementBefore.importacion_id);


/* ============================================================
   3. SIMULAR REAPARICION DE FACTURA
   ============================================================ */

console.log("\n=== 2. SIMULANDO REAPARICION FACTURA ===");

const template = db.prepare(`
  SELECT *
  FROM documentos
  WHERE is_subtotal = 0
  LIMIT 1
`).get() as Record<string, unknown> | undefined;

if (!template) {
  throw new Error(
    "No existe documento plantilla en la copia.",
  );
}

const cloned: Record<string, unknown> = {
  ...template,
};

delete cloned.id;

cloned.documento =
  "001-001-000022032";

cloned.documento_normalizado =
  DOC;

cloned.tipo_documento =
  "FAC";

cloned.cliente =
  "ROSA SUDAMERICA ALIMENTOS ROSASUD S.A.S.,";

cloned.razon_social =
  "ROSA SUDAMERICA ALIMENTOS ROSASUD S.A.S.,";

cloned.total =
  15000;

cloned.valor_documento =
  15000;

cloned.saldo_original =
  15000;

cloned.saldo_pendiente =
  15000;

cloned.posicion_cartera =
  "DEUDA_VIVA";

cloned.estado_documento =
  "ACTIVO_PENDIENTE";

cloned.estado_confirmacion =
  "CONFIRMADO";

cloned.estado_fuente =
  "CARTERA_CONTIFICO";

cloned.anulado =
  0;

cloned.is_subtotal =
  0;

const columns =
  Object.keys(cloned);

const placeholders =
  columns.map(() => "?").join(",");

db.prepare(`
  INSERT INTO documentos (
    ${columns.join(",")}
  )
  VALUES (
    ${placeholders}
  )
`).run(
  ...columns.map(
    (column) => cloned[column],
  ),
);

console.log(
  db.prepare(`
    SELECT
      documento,
      documento_normalizado,
      total,
      saldo_pendiente,
      estado_documento,
      estado_fuente
    FROM documentos
    WHERE documento_normalizado = ?
      AND is_subtotal = 0
  `).get(DOC),
);


/* ============================================================
   4. CREAR EXCEL SUPERPUESTO
   ============================================================ */

console.log("\n=== 3. CREANDO EXCEL SUPERPUESTO ===");

const rows = [
  [
    "Fecha",
    "Identificacion",
    "Persona",
    "Tipo",
    "Forma Cobro/Pago",
    "# Asiento",
    "Documento Cruce",
    "Codigo Comprobante",
    "Detalle",
    "Valor",
  ],
  [
    "08/08/2026",
    "0993382275001",
    "ROSA SUDAMERICA ALIMENTOS ROSASUD S.A.S.,",
    "Cobro",
    "Transferencia",
    "ING 202608000022",
    "",
    "FAC 001-001-000022032",
    "-",
    10072.38,
  ],
];

const workbook =
  XLSX.utils.book_new();

const worksheet =
  XLSX.utils.aoa_to_sheet(rows);

XLSX.utils.book_append_sheet(
  workbook,
  worksheet,
  "Cobros",
);

XLSX.writeFile(
  workbook,
  TEMP_XLS,
  {
    bookType: "xls",
  },
);

console.log("Excel:", TEMP_XLS);


/* ============================================================
   5. CREAR IMPORTACION TEMPORAL 1
   ============================================================ */

const control = db.prepare(`
  SELECT generation
  FROM reconciliation_control
  WHERE id = 1
`).get() as {
  generation?: number;
};

function createImport(
  suffix: string,
): number {
  const inserted = db.prepare(`
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
      'COBROS_MOVIMIENTOS',
      ?,
      ?,
      0,
      0,
      0,
      0,
      'PROCESANDO',
      ?,
      datetime('now','localtime')
    )
  `).run(
    `Cobros-overlap-test-${suffix}.xls`,
    `TEST-COBRO-REHYDRATE-${suffix}`,
    Number(control?.generation ?? 3),
  );

  return Number(
    inserted.lastInsertRowid,
  );
}


/* ============================================================
   6. PRIMERA EJECUCION
   ============================================================ */

const import1 =
  createImport("001");

console.log(
  "\n=== 4. PRIMERA EJECUCION ===",
);

const result1 =
  importCollectionMovementsExcel(
    TEMP_XLS,
    db,
    import1,
  );

console.log(result1);


/* ============================================================
   7. ESTADO POST PRIMERA EJECUCION
   ============================================================ */

console.log(
  "\n=== 5. ESTADO DESPUES PRIMERA EJECUCION ===",
);

const movementAfter1 = db.prepare(`
  SELECT *
  FROM cobros_movimientos_importados
  WHERE movimiento_key = ?
`).get(MOV) as any;

console.log(movementAfter1);

const eventsAfter1 = db.prepare(`
  SELECT
    id,
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
`).all(`COBRO:${MOV}`) as any[];

console.log(
  "\nEVENTOS:",
  eventsAfter1,
);

const documentAfter1 = db.prepare(`
  SELECT
    documento,
    documento_normalizado,
    total,
    saldo_pendiente,
    estado_documento,
    estado_fuente
  FROM documentos
  WHERE documento_normalizado = ?
    AND is_subtotal = 0
`).get(DOC) as any;

console.log(
  "\nDOCUMENTO:",
  documentAfter1,
);

const importRow1 = db.prepare(`
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
`).get(import1) as any;

console.log(
  "\nIMPORTACION 1:",
  importRow1,
);


/* ============================================================
   8. SEGUNDA EJECUCION IDEMPOTENTE
   ============================================================ */

const import2 =
  createImport("002");

console.log(
  "\n=== 6. SEGUNDA EJECUCION ===",
);

const result2 =
  importCollectionMovementsExcel(
    TEMP_XLS,
    db,
    import2,
  );

console.log(result2);


/* ============================================================
   9. ESTADO FINAL
   ============================================================ */

const movementAfter2 = db.prepare(`
  SELECT *
  FROM cobros_movimientos_importados
  WHERE movimiento_key = ?
`).get(MOV) as any;

const eventsAfter2 = db.prepare(`
  SELECT *
  FROM documento_eventos
  WHERE event_key = ?
`).all(`COBRO:${MOV}`) as any[];

const documentAfter2 = db.prepare(`
  SELECT
    documento,
    documento_normalizado,
    total,
    saldo_pendiente,
    estado_documento,
    estado_fuente
  FROM documentos
  WHERE documento_normalizado = ?
    AND is_subtotal = 0
`).get(DOC) as any;

const importRow2 = db.prepare(`
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
`).get(import2) as any;


/* ============================================================
   10. INVARIANTES
   ============================================================ */

console.log(
  "\n=== 7. INVARIANTES ===",
);

const meta1 =
  JSON.parse(
    importRow1?.metadata_json || "{}",
  );

const meta2 =
  JSON.parse(
    importRow2?.metadata_json || "{}",
  );

const checks = {
  mismoMovimientoFisico:
    Number(movementAfter2?.id) ===
      originalMovementId,

  importacionOriginalPreservada:
    Number(movementAfter2?.importacion_id) ===
      originalImportId &&
    originalImportId === 26,

  conciliado:
    movementAfter2?.estado_conciliacion ===
      "CONCILIADO",

  unSoloEventoPrimera:
    eventsAfter1.length === 1,

  unSoloEventoFinal:
    eventsAfter2.length === 1,

  eventoCorrecto:
    eventsAfter2[0]?.tipo_evento ===
      "COBRO_CONFIRMADO",

  eventoFuenteCorrecta:
    eventsAfter2[0]?.fuente ===
      "COBROS_MOVIMIENTOS",

  eventoImportacionOriginal:
    Number(
      eventsAfter2[0]?.importacion_id,
    ) === originalImportId,

  fechaFiscalPreservada:
    String(
      eventsAfter2[0]?.ocurrido_en,
    ).startsWith("2026-08-08"),

  saldoNoReducido:
    Math.abs(
      Number(
        documentAfter2?.saldo_pendiente,
      ) - 15000,
    ) < 0.005,

  totalNoReducido:
    Math.abs(
      Number(
        documentAfter2?.total,
      ) - 15000,
    ) < 0.005,

  primeraCeroNuevos:
    Number(
      importRow1?.registros_importados,
    ) === 0,

  primeraHistoricoIgnorado:
    Number(
      importRow1?.registros_ignorados,
    ) === 1,

  primeraCeroDuplicadosArchivo:
    Number(
      importRow1?.registros_duplicados,
    ) === 0,

  primeraRehidratada:
    Number(
      meta1.rehydratedMovements,
    ) === 1,

  primeraHistorico:
    Number(
      meta1.historicalDuplicates,
    ) === 1,

  segundaCeroNuevos:
    Number(
      importRow2?.registros_importados,
    ) === 0,

  segundaHistoricoIgnorado:
    Number(
      importRow2?.registros_ignorados,
    ) === 1,

  segundaCeroDuplicadosArchivo:
    Number(
      importRow2?.registros_duplicados,
    ) === 0,

  segundaNoRehidrata:
    Number(
      meta2.rehydratedMovements,
    ) === 0,

  saldoIdenticoSegunda:
    Number(documentAfter1?.saldo_pendiente) ===
      Number(documentAfter2?.saldo_pendiente),
};

console.table(checks);

const failed =
  Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

db.close();

if (failed.length > 0) {
  console.error(
    "\nPRUEBA COBROS FALLIDA:",
    failed,
  );

  process.exit(1);
}

console.log(
  "\n✅ PRUEBA COBROS OVERLAP + REHIDRATACION + IDEMPOTENCIA APROBADA.",
);

