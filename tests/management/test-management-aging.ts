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
    type: "PORTFOLIO_AGING",
    filters: {
      year: 2026,
      month: 8,
    },
  },
);

console.log("\n=== PORTFOLIO AGING ===");

console.log({
  period: result.period,
  rows: result.rows.length,
  totals: result.totals,
});

console.log("\n=== DISTRIBUCION POR RANGO ===");

const bucketLabels: Record<string, string> = {
  POR_VENCER: "Por vencer",
  D1_30: "1-30 días",
  D31_60: "31-60 días",
  D61_90: "61-90 días",
  D91_120: "91-120 días",
  D121_180: "121-180 días",
  D181_360: "181-360 días",
  D360_PLUS: ">360 días",
};

const buckets = new Map<
  string,
  {
    documentos: number;
    clientes: Set<string>;
    saldo: number;
  }
>();

for (const key of Object.keys(bucketLabels)) {
  buckets.set(key, {
    documentos: 0,
    clientes: new Set<string>(),
    saldo: 0,
  });
}

for (const row of result.rows) {
  const key = String(row.aging_bucket);
  const bucket = buckets.get(key);

  if (!bucket) {
    throw new Error(
      `Bucket desconocido: ${key}`,
    );
  }

  bucket.documentos += 1;
  bucket.saldo += Number(
    row.saldo_pendiente ?? 0,
  );

  bucket.clientes.add(
    String(row.cliente ?? ""),
  );
}

const distribution = Array.from(
  buckets.entries(),
).map(([key, value]) => ({
  key,
  rango: bucketLabels[key],
  documentos: value.documentos,
  clientes: value.clientes.size,
  saldo: Math.round(
    value.saldo * 100,
  ) / 100,
  porcentaje:
    Number(result.totals.portfolio) > 0
      ? Math.round(
          (
            value.saldo /
            Number(result.totals.portfolio)
          ) *
            10000,
        ) / 100
      : 0,
}));

console.table(distribution);


console.log("\n=== INVARIANTES ===");

const portfolio =
  Number(result.totals.portfolio);

const overdue =
  Number(result.totals.overdue);

const current =
  Number(result.totals.current);

const critical90 =
  Number(result.totals.critical90);

const distributionTotal =
  distribution.reduce(
    (sum, item) => sum + item.saldo,
    0,
  );

const invariants = {
  tieneDocumentos:
    result.rows.length > 0,

  carteraPositiva:
    portfolio > 0,

  carteraCuadra:
    Math.abs(
      portfolio - (current + overdue)
    ) < 0.01,

  agingCuadra:
    Math.abs(
      portfolio - distributionTotal
    ) < 0.01,

  moraCriticaValida:
    critical90 >= 0 &&
    critical90 <= overdue + 0.01,

  documentosCuadran:
    distribution.reduce(
      (sum, item) =>
        sum + item.documentos,
      0,
    ) === result.rows.length,
};

console.table(invariants);

const approved =
  Object.values(invariants).every(Boolean);

db.close();

if (!approved) {
  console.error(
    "\n❌ PORTFOLIO AGING FALLÓ."
  );
  process.exit(1);
}

console.log(
  "\n✅ PORTFOLIO AGING APROBADO."
);

