const Database = require("better-sqlite3");

const DB_PATH = process.env.CARTERA_TEST_DB_PATH || require("node:path").resolve(
  process.cwd(),
  "tests",
  "data",
  "cartera.db",
);
const db = new Database(DB_PATH);

db.pragma("foreign_keys = ON");

function scalar(sql, params = []) {
  const row = db.prepare(sql).get(...params);
  return row ? Object.values(row)[0] : null;
}

console.log("\n============================================================");
console.log(" PACK-046 — REPARACION METADATOS + GATE HISTORICO FINAL");
console.log("============================================================");

// ============================================================
// 1. ESTADO PREVIO
// ============================================================

console.log("\n=== 1. ESTADO PREVIO ===");

console.table(
  db.prepare(`
    SELECT
      b.id AS batch_id,
      b.periodo_desde,
      b.periodo_hasta,
      b.registros_leidos,
      b.registros_in_scope,
      b.registros_ignorados AS batch_ignorados,
      b.registros_legacy,
      i.id AS importacion_id,
      i.registros_importados,
      i.registros_ignorados AS import_ignorados,
      i.registros_duplicados
    FROM historical_bootstrap_batches b
    JOIN importaciones i
      ON i.tipo = 'COBROS_MOVIMIENTOS'
     AND i.reconciliation_generation = b.generation
     AND i.periodo_desde = b.periodo_desde
     AND i.periodo_hasta = b.periodo_hasta
    WHERE b.fuente = 'COBROS_MOVIMIENTOS'
    ORDER BY b.periodo_desde
  `).all()
);

// ============================================================
// 2. BACKUP LOGICO DE VALORES
// ============================================================

const before = db.prepare(`
  SELECT
    b.id,
    b.registros_ignorados
  FROM historical_bootstrap_batches b
  WHERE b.fuente = 'COBROS_MOVIMIENTOS'
`).all();

// ============================================================
// 3. REPARACION TRANSACCIONAL
// ============================================================

console.log("\n=== 2. REPARANDO METADATOS ===");

const repair = db.transaction(() => {

  const rows = db.prepare(`
    SELECT
      b.id AS batch_id,
      b.registros_leidos,
      b.registros_in_scope,
      b.registros_legacy,
      i.registros_importados,
      i.registros_ignorados,
      i.registros_duplicados
    FROM historical_bootstrap_batches b
    JOIN importaciones i
      ON i.tipo = 'COBROS_MOVIMIENTOS'
     AND i.reconciliation_generation = b.generation
     AND i.periodo_desde = b.periodo_desde
     AND i.periodo_hasta = b.periodo_hasta
    WHERE b.fuente = 'COBROS_MOVIMIENTOS'
  `).all();

  if (rows.length !== 6) {
    throw new Error(
      `Se esperaban 6 batches COBROS y se encontraron ${rows.length}`
    );
  }

  const update = db.prepare(`
    UPDATE historical_bootstrap_batches
    SET registros_ignorados = ?
    WHERE id = ?
  `);

  for (const row of rows) {

    if (row.registros_in_scope !== row.registros_importados) {
      throw new Error(
        `Batch ${row.batch_id}: in_scope != registros_importados`
      );
    }

    const reconstructed =
      row.registros_importados +
      row.registros_ignorados +
      row.registros_legacy +
      row.registros_duplicados;

    if (reconstructed !== row.registros_leidos) {
      throw new Error(
        `Batch ${row.batch_id}: cierre inválido ` +
        `${row.registros_leidos} != ${reconstructed}`
      );
    }

    update.run(row.registros_ignorados, row.batch_id);
  }
});

try {
  repair();
  console.log("Reparacion transaccional: OK");
} catch (error) {
  console.error("REPARACION ABORTADA:", error.message);
  db.close();
  process.exit(1);
}

// ============================================================
// 4. VERIFICAR METADATOS
// ============================================================

console.log("\n=== 3. BATCHES DESPUES DE REPARACION ===");

const batches = db.prepare(`
  SELECT
    id,
    periodo_desde,
    periodo_hasta,
    registros_leidos,
    registros_in_scope,
    registros_ignorados,
    registros_legacy
  FROM historical_bootstrap_batches
  WHERE fuente = 'COBROS_MOVIMIENTOS'
  ORDER BY periodo_desde
`).all();

console.table(batches);

const totals = db.prepare(`
  SELECT
    COUNT(*) AS batches,
    SUM(registros_leidos) AS leidos,
    SUM(registros_in_scope) AS in_scope,
    SUM(registros_ignorados) AS ignorados,
    SUM(registros_legacy) AS legacy
  FROM historical_bootstrap_batches
  WHERE fuente = 'COBROS_MOVIMIENTOS'
`).get();

const duplicados = scalar(`
  SELECT COALESCE(SUM(registros_duplicados),0)
  FROM importaciones
  WHERE tipo = 'COBROS_MOVIMIENTOS'
    AND estado IN ('COMPLETADA','COMPLETADA_ADVERTENCIAS')
`);

console.log({
  ...totals,
  duplicados,
  reconstruido:
    totals.in_scope +
    totals.ignorados +
    totals.legacy +
    duplicados
});

// ============================================================
// 5. VALIDACION FECHA EFECTIVA CORRECTA
// ============================================================

console.log("\n=== 4. FECHA EFECTIVA COBROS — MATCH EXACTO ===");

/*
 * La auditoria anterior comparaba documento + valor globalmente.
 * Eso puede cruzar movimientos distintos.
 *
 * La validacion correcta usa:
 *   - importacion_id
 *   - documento
 *   - importe
 *   - y exige existencia de movimiento en la fecha del evento.
 */

const eventos = scalar(`
  SELECT COUNT(*)
  FROM documento_eventos
  WHERE fuente = 'COBROS_MOVIMIENTOS'
    AND tipo_evento = 'COBRO_CONFIRMADO'
`);

const eventosSinImportacion = scalar(`
  SELECT COUNT(*)
  FROM documento_eventos
  WHERE fuente = 'COBROS_MOVIMIENTOS'
    AND tipo_evento = 'COBRO_CONFIRMADO'
    AND importacion_id IS NULL
`);

const fechasIncorrectas = scalar(`
  SELECT COUNT(*)
  FROM documento_eventos e
  WHERE e.fuente = 'COBROS_MOVIMIENTOS'
    AND e.tipo_evento = 'COBRO_CONFIRMADO'

    AND NOT EXISTS (
      SELECT 1
      FROM cobros_movimientos_importados m
      WHERE m.importacion_id = e.importacion_id
        AND m.documento_relacionado_normalizado =
            e.documento_normalizado
        AND ABS(
          COALESCE(m.valor,0) -
          COALESCE(e.importe,0)
        ) < 0.005
        AND m.fecha_movimiento = e.ocurrido_en
    )
`);

console.log({
  eventos,
  eventosSinImportacion,
  fechasIncorrectas
});

// ============================================================
// 6. INVARIANTES CRITICOS
// ============================================================

console.log("\n=== 5. GATE CRITICO ===");

const checks = [];

function check(nombre, ok, detalle) {
  checks.push({ nombre, ok, detalle });
  console.log(
    `${ok ? "[PASS]" : "[FAIL]"} ${nombre}`,
    detalle ?? ""
  );
}

check(
  "Existen exactamente 6 batches COBROS",
  totals.batches === 6,
  totals.batches
);

check(
  "Cobros leidos cierran matematicamente",
  totals.leidos ===
    totals.in_scope +
    totals.ignorados +
    totals.legacy +
    duplicados,
  {
    leidos: totals.leidos,
    in_scope: totals.in_scope,
    ignorados: totals.ignorados,
    legacy: totals.legacy,
    duplicados
  }
);

check(
  "Ignorados historicos = 14145",
  totals.ignorados === 14145,
  totals.ignorados
);

check(
  "In scope = 11239",
  totals.in_scope === 11239,
  totals.in_scope
);

check(
  "Duplicados = 1",
  duplicados === 1,
  duplicados
);

check(
  "Existen 105 eventos COBRO_CONFIRMADO",
  eventos === 105,
  eventos
);

check(
  "Todos los eventos COBRO_CONFIRMADO tienen importacion_id",
  eventosSinImportacion === 0,
  eventosSinImportacion
);

check(
  "Todos los COBRO_CONFIRMADO usan fecha efectiva",
  fechasIncorrectas === 0,
  fechasIncorrectas
);

const importacionesError = scalar(`
  SELECT COUNT(*)
  FROM importaciones
  WHERE estado = 'ERROR'
    AND revertido_en IS NULL
`);

check(
  "No existen importaciones ERROR activas",
  importacionesError === 0,
  importacionesError
);

const batchesIncompletos = scalar(`
  SELECT COUNT(*)
  FROM historical_bootstrap_batches
  WHERE estado <> 'COMPLETADO'
`);

check(
  "Todos los batches historicos estan COMPLETADOS",
  batchesIncompletos === 0,
  batchesIncompletos
);

// ============================================================
// 7. RESULTADO
// ============================================================

const failures = checks.filter(c => !c.ok);

console.log("\n============================================================");

if (failures.length === 0) {
  console.log(" PACK-046: PASS");
  console.log(" HISTORICAL LOAD: APROBADO");
  console.log(" Los 2 fallos de PACK-045 quedan resueltos.");
} else {
  console.log(` PACK-046: FAIL (${failures.length})`);
  console.log(" NO cerrar historico.");
}

console.log("============================================================");

db.close();

process.exit(failures.length === 0 ? 0 : 1);
