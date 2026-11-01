import path from "node:path";

export const TEST_DATABASE_PATH = path.resolve(
  process.env.CARTERA_TEST_DB_PATH ?? path.join("tests", "data", "cartera.db"),
);