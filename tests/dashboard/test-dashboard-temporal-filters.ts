import Database from "better-sqlite3";
import {
  computeDashboardExecutiveStats,
} from "../../electron/dashboardExecutive";
import { TEST_DATABASE_PATH } from "../testDatabasePath";

const DB_PATH = TEST_DATABASE_PATH;

const db = new Database(DB_PATH, { readonly: true });

type TestCase = {
  year: number;
  month: number | null;
  label: string;
};

const cases: TestCase[] = [
  { year: 2024, month: 1, label: "2024-Ene" },
  { year: 2025, month: 7, label: "2025-Jul" },
  { year: 2026, month: null, label: "2026-Todos" },
];

function expectedValue(
  year: number,
  month: number | null,
): { movimientos: number; total: number } {
  if (month !== null) {
    const from =
      `${year}-${String(month).padStart(2, "0")}-01`;

    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;

    const to =
      `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

    return db.prepare(`
      SELECT
        COUNT(*) AS movimientos,
        ROUND(COALESCE(SUM(valor), 0), 2) AS total
      FROM cobros_movimientos_importados
      WHERE fecha_movimiento >= ?
        AND fecha_movimiento < ?
        AND clase_movimiento IN ('COBRO', 'CRUCE')
    `).get(from, to) as {
      movimientos: number;
      total: number;
    };
  }

  return db.prepare(`
    SELECT
      COUNT(*) AS movimientos,
      ROUND(COALESCE(SUM(valor), 0), 2) AS total
    FROM cobros_movimientos_importados
    WHERE strftime('%Y', fecha_movimiento) = ?
      AND clase_movimiento IN ('COBRO', 'CRUCE')
  `).get(String(year)) as {
    movimientos: number;
    total: number;
  };
}

function expectedMonthly(year: number) {
  const rows = db.prepare(`
    SELECT
      CAST(strftime('%m', fecha_movimiento) AS INTEGER) AS month,

      ROUND(
        COALESCE(
          SUM(
            CASE
              WHEN clase_movimiento = 'COBRO'
              THEN valor
              ELSE 0
            END
          ),
          0
        ),
        2
      ) AS cobros,

      ROUND(
        COALESCE(
          SUM(
            CASE
              WHEN clase_movimiento = 'CRUCE'
              THEN valor
              ELSE 0
            END
          ),
          0
        ),
        2
      ) AS cruces,

      ROUND(
        COALESCE(SUM(valor), 0),
        2
      ) AS total

    FROM cobros_movimientos_importados
    WHERE strftime('%Y', fecha_movimiento) = ?
      AND clase_movimiento IN ('COBRO', 'CRUCE')

    GROUP BY
      CAST(strftime('%m', fecha_movimiento) AS INTEGER)

    ORDER BY month
  `).all(String(year)) as Array<{
    month: number;
    cobros: number;
    cruces: number;
    total: number;
  }>;

  const map = new Map(
    rows.map((row) => [row.month, row]),
  );

  return Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    const row = map.get(month);

    return {
      month,
      cobros: Number(row?.cobros ?? 0),
      cruces: Number(row?.cruces ?? 0),
      total: Number(row?.total ?? 0),
    };
  });
}

console.log("\n==============================================");
console.log("TEST FILTROS TEMPORALES DASHBOARD");
console.log("==============================================");

let failed = false;

for (const test of cases) {
  console.log(`\n=== ${test.label} ===`);

  const expected = expectedValue(
    test.year,
    test.month,
  );

  const actual = computeDashboardExecutiveStats(
    db,
    new Date(),
    {
      year: test.year,
      month: test.month,
    },
  );

  const actualTotal =
    Number(actual.cobrosMes.totalDetectado ?? 0);

  const actualMovements =
    Number(actual.cobrosMes.movimientosDetectados ?? 0);

  const totalOk =
    Math.abs(actualTotal - Number(expected.total)) < 0.005;

  const movementsOk =
    actualMovements === Number(expected.movimientos);

  console.log({
    esperado: expected,
    dashboard: {
      movimientos: actualMovements,
      total: actualTotal,
      periodo: actual.periodo,
    },
    totalOk,
    movementsOk,
  });

  if (!totalOk || !movementsOk) {
    failed = true;
  }
}

console.log("\n=== VALIDACION 2026 / TODOS ===");

const expected2026 = expectedValue(2026, null);

const actual2026 = computeDashboardExecutiveStats(
  db,
  new Date(),
  {
    year: 2026,
    month: null,
  },
);

const actualSeries =
  actual2026.historico.series;

const expectedSeries =
  expectedMonthly(2026);

console.log("\n=== KPI ANUAL ===");

console.log({
  esperado: expected2026,
  dashboard: {
    movimientos:
      actual2026.cobrosMes.movimientosDetectados,
    total:
      actual2026.cobrosMes.totalDetectado,
  },
});

console.log("\n=== SERIE DASHBOARD 2026 ===");

console.table(
  actualSeries.map((row) => ({
    mes: row.month,
    cobros: row.partialPayments,
    cruces: row.otherMovements,
    total: row.total,
  })),
);

console.log("\n=== SERIE SQL REAL 2026 ===");

console.table(expectedSeries);

const annualTotalOk =
  Math.abs(
    Number(actual2026.cobrosMes.totalDetectado) -
      Number(expected2026.total),
  ) < 0.005;

const annualMovementsOk =
  Number(actual2026.cobrosMes.movimientosDetectados) ===
  Number(expected2026.movimientos);

const seriesLengthOk =
  actualSeries.length === 12;

const seriesValuesOk =
  actualSeries.every((row, index) => {
    const expected = expectedSeries[index];

    return (
      row.month === expected.month &&
      Math.abs(
        Number(row.partialPayments) -
        Number(expected.cobros),
      ) < 0.005 &&
      Math.abs(
        Number(row.otherMovements) -
        Number(expected.cruces),
      ) < 0.005 &&
      Math.abs(
        Number(row.total) -
        Number(expected.total),
      ) < 0.005
    );
  });

console.log("\n=== INVARIANTES TODOS ===");

console.table({
  totalAnualCorrecto: annualTotalOk,
  movimientosAnualesCorrectos: annualMovementsOk,
  serieTiene12Meses: seriesLengthOk,
  serieMensualExacta: seriesValuesOk,
});

if (
  !annualTotalOk ||
  !annualMovementsOk ||
  !seriesLengthOk ||
  !seriesValuesOk
) {
  failed = true;
}

db.close();

if (failed) {
  console.error(
    "\n❌ FILTROS TEMPORALES DASHBOARD: FALLÓ ALGUNA INVARIANTE.",
  );

  process.exit(1);
}

console.log(
  "\n✅ FILTROS TEMPORALES DASHBOARD APROBADOS.",
);

console.log(
  "Cambio de año, mes específico y Todos coinciden exactamente con cobros_movimientos_importados.",
);


