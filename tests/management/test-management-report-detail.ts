import Database from "better-sqlite3";
import {
  getManagementReportDetail,
} from "../../electron/managementReportDetails";
import { TEST_DATABASE_PATH } from "../testDatabasePath";

const db = new Database(
  TEST_DATABASE_PATH,
  { readonly: true },
);

const result = getManagementReportDetail(
  db,
  {
    type: "COLLECTIONS_DETAIL",
    filters: {
      year: 2026,
      month: 8,
    },
  },
);

console.log("\n=== RESULTADO ===");

console.log({
  period: result.period,
  rows: result.rows.length,
  totals: result.totals,
});

const invariants = {
  filas51:
    result.rows.length === 51,

  movimientos51:
    Number(result.totals.movements) === 51,

  total95114:
    Math.abs(
      Number(result.totals.total) - 95114.88
    ) < 0.005,

  cobros81368:
    Math.abs(
      Number(result.totals.collections) - 81368.23
    ) < 0.005,

  cruces13746:
    Math.abs(
      Number(result.totals.crossings) - 13746.65
    ) < 0.005,
};

console.table(invariants);

const approved =
  Object.values(invariants).every(Boolean);

db.close();

if (!approved) {
  console.error(
    "\n❌ MANAGEMENT REPORT DETAIL FALLÓ."
  );
  process.exit(1);
}

console.log(
  "\n✅ MANAGEMENT REPORT DETAIL APROBADO."
);

