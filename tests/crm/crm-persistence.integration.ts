import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import {
  createGestion,
  canonicalizeLegacyGestion,
  deleteGestion,
  fulfillGestion,
  getGestionById,
  migrateLegacyGestiones,
  hashLegacyGestion,
  updateGestion,
} from "../../electron/repositories/gestionRepository";
import { createSingleFlight, ensureLegacyGestionIds, persistLegacyGestionIds } from "../../src/services/gestionLegacyMigration";
import { prepareLegacyPromises } from "../../src/services/promesaLegacyMigration";
import { bootstrapLegacyPromises, changePromesaState, createPromesa, getPromesaById, hashLegacyPromise, isPromiseLegacyBootstrapClosed, listPromesas, migrateHistoricalPromises, migrateLegacyPromises, PROMISE_LEGACY_BOOTSTRAP_KEY, reconcilePromises, updatePromesa, updatePromesaAtomic } from "../../electron/repositories/promesaRepository";
import { createScenarioContext, ensureScenarioDocument, importCollection, importPortfolio, normalized } from "../integration/support";

type Gestion = {
  id?: number | string;
  cliente: string;
  fecha?: string;
  tipo: string;
  resultado: string;
  observacion: string;
  fecha_promesa?: string | null;
  monto_promesa?: number;
  usuario?: string;
  motivo?: string | null;
};

type Scenario = {
  id: string;
  name: string;
  expectedFailure: boolean;
  defect?: string;
  run: () => void;
};

const SCHEMA = `
  CREATE TABLE documentos (id INTEGER PRIMARY KEY AUTOINCREMENT, cliente TEXT, razon_social TEXT, documento_normalizado TEXT UNIQUE);
  CREATE TABLE gestiones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente TEXT NOT NULL,
    fecha TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    tipo TEXT,
    resultado TEXT,
    observacion TEXT,
    fecha_promesa TEXT,
    monto_promesa REAL DEFAULT 0,
    usuario TEXT DEFAULT 'sistema',
    creado_en TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    actualizado_en TEXT,
    motivo TEXT
  );
  CREATE INDEX idx_gestiones_cliente ON gestiones(cliente);
  CREATE TABLE gestion_legacy_migrations (
    source TEXT NOT NULL,
    legacy_id TEXT NOT NULL,
    gestion_id INTEGER NULL,
    migrated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    payload_hash TEXT NOT NULL,
    deleted_at TEXT NULL,
    PRIMARY KEY (source, legacy_id),
    FOREIGN KEY (gestion_id) REFERENCES gestiones(id)
  );
  CREATE TABLE promesas (id INTEGER PRIMARY KEY AUTOINCREMENT,cliente TEXT NOT NULL,gestion_id INTEGER NULL UNIQUE,documento_id INTEGER NULL,fecha_promesa TEXT NOT NULL,monto_prometido REAL NOT NULL CHECK(monto_prometido>=0),monto_pagado REAL NOT NULL DEFAULT 0 CHECK(monto_pagado>=0 AND monto_pagado<=monto_prometido),estado TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK(estado IN('PENDIENTE','CUMPLIDA','CUMPLIDA_PARCIAL','INCUMPLIDA','CANCELADA','REPROGRAMADA')),fecha_pago TEXT NULL,motivo_incumplimiento TEXT NULL,observacion TEXT NULL,origen TEXT NOT NULL DEFAULT 'NATIVE' CHECK(origen IN('NATIVE','MIGRATED_GESTION','MIGRATED_LEGACY')),monto_cumplido_base REAL NOT NULL DEFAULT 0,cumplimiento_automatico_desde TEXT NULL,creado_en TEXT NOT NULL DEFAULT(datetime('now','localtime')),actualizado_en TEXT NULL,FOREIGN KEY(gestion_id) REFERENCES gestiones(id));
  CREATE TABLE promesa_legacy_migrations(source TEXT NOT NULL,legacy_id TEXT NOT NULL,promesa_id INTEGER NOT NULL,payload_hash TEXT NOT NULL,migrated_at TEXT NOT NULL DEFAULT(datetime('now','localtime')),PRIMARY KEY(source,legacy_id),FOREIGN KEY(promesa_id) REFERENCES promesas(id));
  CREATE TABLE app_migrations(key TEXT PRIMARY KEY,completed_at TEXT NOT NULL DEFAULT(datetime('now','localtime')),metadata TEXT NULL);
  CREATE TABLE promesa_eventos(id INTEGER PRIMARY KEY AUTOINCREMENT,promesa_id INTEGER NOT NULL,tipo_evento TEXT NOT NULL,estado_anterior TEXT,estado_nuevo TEXT,fecha TEXT NOT NULL DEFAULT(datetime('now','localtime')),metadata TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE promesa_documentos(promesa_id INTEGER NOT NULL,documento_normalizado TEXT NOT NULL,monto_comprometido REAL,creado_en TEXT NOT NULL DEFAULT(datetime('now','localtime')),PRIMARY KEY(promesa_id,documento_normalizado));
  CREATE TABLE cobros_movimientos_importados(id INTEGER PRIMARY KEY AUTOINCREMENT,movimiento_key TEXT NOT NULL UNIQUE,fecha_movimiento TEXT,documento_relacionado_normalizado TEXT,valor REAL NOT NULL,clase_movimiento TEXT NOT NULL,estado_conciliacion TEXT NOT NULL);
  CREATE TABLE notas_credito_importadas(id INTEGER PRIMARY KEY AUTOINCREMENT,documento_relacionado_normalizado TEXT,total_nc REAL NOT NULL,estado_conciliacion TEXT NOT NULL);
  CREATE TABLE documentos_anulados_log(id INTEGER PRIMARY KEY AUTOINCREMENT,documento_normalizado TEXT NOT NULL);
  CREATE TABLE promesa_cobro_atribuciones(promesa_id INTEGER NOT NULL,movement_key TEXT NOT NULL,importe_atribuido REAL NOT NULL,attributed_at TEXT NOT NULL DEFAULT(datetime('now','localtime')),documento_normalizado TEXT NOT NULL,PRIMARY KEY(promesa_id,movement_key));
`;

const tempRoot = path.resolve(os.tmpdir());

function removeTemporaryDirectory(directory: string): void {
  const resolved = path.resolve(directory);
  if (resolved === tempRoot || !resolved.startsWith(`${tempRoot}${path.sep}`)) {
    throw new Error(`Directorio temporal fuera de alcance seguro: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function withDatabase(run: (db: Database.Database, file: string) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-crm-c1-"));
  const file = path.join(directory, "crm.sqlite");
  let db = new Database(file);
  db.exec(SCHEMA);
  db.exec("INSERT INTO documentos(id,cliente,razon_social,documento_normalizado) VALUES (1,'CLIENTE-P','Cliente P','A'),(2,'CLIENTE-P','Cliente P','B'),(3,'CLIENTE-P','Cliente P','FAC-I')");

  try {
    run(db, file);
  } finally {
    if (db.open) db.close();
    removeTemporaryDirectory(directory);
  }
}

function saveGestion(db: Database.Database, data: Gestion) {
  return { ok: true as const, gestion: createGestion(db, data) };
}

function listGestiones(db: Database.Database, cliente = ""): Gestion[] {
  if (!cliente) {
    return db.prepare(`
      SELECT id, cliente, fecha, tipo, resultado, observacion,
             fecha_promesa, monto_promesa
      FROM gestiones
      ORDER BY fecha DESC
      LIMIT 5000
    `).all() as Gestion[];
  }
  return db.prepare(`
    SELECT * FROM gestiones
    WHERE cliente = ?
    ORDER BY fecha DESC
    LIMIT 1000
  `).all(cliente) as Gestion[];
}

function baseGestion(overrides: Partial<Gestion> = {}): Gestion {
  return {
    cliente: "CLIENTE-C1",
    tipo: "Llamada",
    resultado: "Contactado",
    observacion: "Contacto sintético C1",
    ...overrides,
  };
}

function row(db: Database.Database, id: number): Gestion | undefined {
  return getGestionById(db, id) as Gestion | undefined;
}

function insertedId(db: Database.Database): number {
  return Number(
    (db.prepare("SELECT MAX(id) AS id FROM gestiones").get() as { id: number }).id,
  );
}
const basePromesa=()=>({cliente:'CLIENTE-P',fecha_promesa:'2026-12-15',monto_prometido:100,estado:'PENDIENTE' as const,observacion:'Compromiso'});
const linkedPromesa=(db:Database.Database,documento='FAC-I',monto=100)=>{db.prepare("INSERT OR IGNORE INTO documentos(cliente,razon_social,documento_normalizado) VALUES('CLIENTE-P','Cliente P',?)").run(documento);const result=createPromesa(db,{...basePromesa(),monto_prometido:monto,documentos:[{documento_normalizado:documento}]});if(!result.ok)throw new Error(result.message);return result.promesa;};
const importedCobro=(db:Database.Database,key:string,documento='FAC-I',valor=100,fecha='2099-01-01',clase='COBRO',estado='CONCILIADO')=>db.prepare('INSERT OR IGNORE INTO cobros_movimientos_importados(movimiento_key,fecha_movimiento,documento_relacionado_normalizado,valor,clase_movimiento,estado_conciliacion) VALUES(?,?,?,?,?,?)').run(key,fecha,documento,valor,clase,estado);

function assertProductionContract(): void {
  const root = process.cwd();
  const main = fs.readFileSync(path.join(root, "electron", "main.ts"), "utf8");
  const app = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");
  const preload = fs.readFileSync(path.join(root, "electron", "preload.ts"), "utf8");
  const globals = fs.readFileSync(path.join(root, "src", "assets", "types", "global.d.ts"), "utf8");

  assert.match(main, /ipcMain\.handle\("gestionGuardar"/);
  assert.match(main, /const gestion = createGestion\(db, data\)/);
  assert.match(main, /createPromesa\(db/);
  assert.match(main, /LIMIT 5000/);
  assert.match(main, /fulfillGestion\(db, id\)/);
  assert.match(app, /cartera_gestiones_locales/);
  assert.match(preload, /cartera_promesas_locales/);
  assert.doesNotMatch(app, /manual_\$\{Date\.now\(\)\}/);
  assert.doesNotMatch(app, /Math\.abs\(localTime - bgTime\) < 10000/);
  const createFlow = app.slice(
    app.indexOf("async function guardarGestion"),
    app.indexOf("async function eliminarGestion"),
  );
  assert.match(createFlow, /setAllGestiones\(\(current\) => \[result\.gestion, \.\.\.current\]\)/);
  assert.doesNotMatch(createFlow, /cartera_gestiones_locales|LEGACY_GESTIONES_KEY/);
  assert.doesNotMatch(app, /getItem\(['"]cartera_promesas_locales['"]\)/);
  assert.doesNotMatch(preload, /promesasLegacyMigrar\s*:/);
  assert.doesNotMatch(globals, /promesasLegacyMigrar\s*:/);
  assert.doesNotMatch(main, /ipcMain\.handle\("promesasLegacyMigrar"/);
}

assertProductionContract();

const scenarios: Scenario[] = [
  {
    id: "C1-01",
    name: "crear gestión y recuperarla desde SQLite",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      const result = saveGestion(db, baseGestion());
      assert.equal(result.ok, true);
      assert.equal(typeof result.gestion.id, "number");
      assert.equal(listGestiones(db).length, 1);
      assert.equal(listGestiones(db)[0]?.cliente, "CLIENTE-C1");
    }),
  },
  {
    id: "C1-02",
    name: "dos gestiones consecutivas conservan IDs SQLite distintos",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      saveGestion(db, baseGestion());
      saveGestion(db, baseGestion());
      const rows = listGestiones(db);
      assert.equal(rows.length, 2);
      assert.notEqual(rows[0]?.id, rows[1]?.id);
    }),
  },
  {
    id: "C1-03",
    name: "eliminar mediante ID SQLite real",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      saveGestion(db, baseGestion());
      const id = insertedId(db);
      assert.equal(deleteGestion(db, id).ok, true);
      assert.equal(row(db, id), undefined);
    }),
  },
  {
    id: "C1-04",
    name: "cumplir promesa mediante ID SQLite real",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      saveGestion(db, baseGestion({ resultado: "Promesa de Pago" }));
      const id = insertedId(db);
      assert.equal(fulfillGestion(db, id).ok, true);
      assert.equal(row(db, id)?.resultado, "Promesa Cumplida");
    }),
  },
  {
    id: "C1-05",
    name: "editar gestión y persistir después de reabrir DB",
    expectedFailure: false,
    run: () => withDatabase((db, file) => {
      saveGestion(db, baseGestion());
      const id = insertedId(db);
      assert.equal(updateGestion(db, id, baseGestion({ observacion: "Editada" })).ok, true);
      db.close();
      const reopened = new Database(file);
      try {
        assert.equal(row(reopened, id)?.observacion, "Editada");
      } finally {
        reopened.close();
      }
    }),
  },
  {
    id: "C1-06",
    name: "crear promesa como gestión con fecha y monto",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      saveGestion(db, baseGestion({
        resultado: "Promesa de Pago",
        fecha_promesa: "2026-09-15",
        monto_promesa: 425.75,
      }));
      const promise = row(db, insertedId(db));
      assert.equal(promise?.fecha_promesa, "2026-09-15");
      assert.equal(promise?.monto_promesa, 425.75);
    }),
  },
  {
    id: "C1-07",
    name: "edición UI de promesa sobrevive reinicio SQLite",
    expectedFailure: false,
    run: () => withDatabase((db, file) => {
      saveGestion(db, baseGestion({
        resultado: "Promesa de Pago",
        fecha_promesa: "2026-09-15",
        monto_promesa: 100,
      }));
      migrateHistoricalPromises(db);const promise=listPromesas(db)[0]!;
      assert.equal(updatePromesa(db,promise.id,{fecha_promesa:"2026-10-01",monto_prometido:250}).ok,true);
      db.close();
      const reopened = new Database(file);
      try {
        assert.equal(getPromesaById(reopened,promise.id)?.fecha_promesa,"2026-10-01");
        assert.equal(getPromesaById(reopened,promise.id)?.monto_prometido,250);
      } finally {
        reopened.close();
      }
    }),
  },
  {
    id: "C1-08",
    name: "ID manual queda relacionado con fila SQLite",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      const saved = saveGestion(db, baseGestion());
      assert.equal(saved.gestion.id, insertedId(db));
    }),
  },
  {
    id: "C1-09",
    name: "rehidratación SQLite más cartera_gestiones_locales",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      saveGestion(db, baseGestion({ observacion: "SQLite" }));
      const local = baseGestion({
        id: "manual_1",
        fecha: "2026-08-21T12:00:00.000Z",
        observacion: "Sólo local",
      });
      const result = migrateLegacyGestiones(db, "localStorage", [{
        ...local,
        legacy_id: String(local.id),
      }]);
      assert.equal(result.mappings.length, 1);
      assert.equal(listGestiones(db).length, 2);
    }),
  },
  {
    id: "C1-10",
    name: "ID numérico legacy no infiere identidad SQLite",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      saveGestion(db, baseGestion());
      const stored = listGestiones(db)[0]!;
      const result = migrateLegacyGestiones(db, "localStorage", [{
        ...stored,
        legacy_id: String(stored.id),
        id: Number(stored.id),
      }]);
      assert.notEqual(result.mappings[0]?.gestion_id, stored.id);
      assert.equal(listGestiones(db).length, 2);
    }),
  },
  {
    id: "C1-11",
    name: "dos gestiones legítimas con mismo texto conservan IDs al fusionar",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      const first = baseGestion({ fecha: "2026-08-21T17:00:00.000Z" });
      const second = baseGestion({ fecha: "2026-08-21T17:00:05.000Z" });
      migrateLegacyGestiones(db, "localStorage", [
        { ...first, legacy_id: "manual_1" },
        { ...second, legacy_id: "manual_2" },
      ]);
      assert.equal(listGestiones(db).length, 2);
      assert.equal(new Set(listGestiones(db).map((item) => item.id)).size, 2);
    }),
  },
  {
    id: "C1-12",
    name: "deduplicación tolera representación UTC frente a hora local",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      const backend = baseGestion({ id: 1, fecha: "2026-08-21 12:00:00" });
      const local = baseGestion({ id: "manual_3", fecha: "2026-08-21T17:00:00.000Z" });
      migrateLegacyGestiones(db, "localStorage", [
        { ...backend, id: undefined, legacy_id: "backend-explicit" },
        { ...local, id: undefined, legacy_id: "local-explicit" },
      ]);
      assert.equal(listGestiones(db).length, 2);
    }),
  },
  {
    id: "C1-13",
    name: "cartera_promesas_locales se rehidrata después de reinicio",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      saveGestion(db, baseGestion({
        resultado: "Promesa de Pago",
        fecha_promesa: "2026-09-15",
        monto_promesa: 100,
      }));
      const gestionId=insertedId(db);migrateHistoricalPromises(db);
      const promise=listPromesas(db)[0]!;
      const result=migrateLegacyPromises(db,'localStorage',[{legacy_id:'local-edit',gestion_id:gestionId,cliente:'CLIENTE-C1',fecha_promesa:'2026-09-15',monto_prometido:900}]);assert.equal(result.ok,true);
      assert.equal(getPromesaById(db,promise.id)?.monto_prometido,100);assert.equal(listPromesas(db).length,2);
    }),
  },
  {
    id: "C1-14",
    name: "eliminación con ID artificial se rechaza explícitamente",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      saveGestion(db, baseGestion());
      const id = insertedId(db);
      const result = deleteGestion(db, "manual_123");
      assert.equal(result.ok, false);
      assert.equal("code" in result && result.code, "GESTION_INVALID_ID");
      assert.notEqual(row(db, id), undefined);
    }),
  },
  {
    id: "C1-15",
    name: "cumplimiento con ID artificial se rechaza explícitamente",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      saveGestion(db, baseGestion({ resultado: "Promesa de Pago" }));
      const id = insertedId(db);
      const result = fulfillGestion(db, "manual_123");
      assert.equal(result.ok, false);
      assert.equal("code" in result && result.code, "GESTION_INVALID_ID");
      assert.equal(row(db, id)?.resultado, "Promesa de Pago");
    }),
  },
  {
    id: "C1-16",
    name: "gestionesListar recupera histórico superior al límite",
    expectedFailure: true,
    defect: "La consulta global aplica LIMIT 5000 sin paginación ni señal de truncamiento.",
    run: () => withDatabase((db) => {
      const insert = db.prepare(`
        INSERT INTO gestiones (cliente, tipo, resultado, observacion)
        VALUES ('CLIENTE-C1', 'Llamada', 'Contactado', ?)
      `);
      const seed = db.transaction(() => {
        for (let index = 0; index < 5001; index += 1) insert.run(`C1-${index}`);
      });
      seed();
      assert.equal(
        Number((db.prepare("SELECT COUNT(*) AS total FROM gestiones").get() as { total: number }).total),
        5001,
      );
      assert.equal(listGestiones(db).length, 5001);
    }),
  },
  {
    id: "C2-01",
    name: "gestionGuardar devuelve ID SQLite real",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      const result = saveGestion(db, baseGestion());
      assert.equal(result.gestion.id, insertedId(db));
    }),
  },
  {
    id: "C2-02",
    name: "altas iguales generan IDs distintos",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      const first = saveGestion(db, baseGestion()).gestion.id;
      const second = saveGestion(db, baseGestion()).gestion.id;
      assert.notEqual(first, second);
    }),
  },
  {
    id: "C2-03",
    name: "error INSERT no crea gestión fantasma en estado local",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      const state: Gestion[] = [];
      db.exec(`
        CREATE TRIGGER fail_crm_insert
        BEFORE INSERT ON gestiones
        BEGIN SELECT RAISE(ABORT, 'fallo sintético'); END;
      `);
      assert.throws(() => {
        const persisted = saveGestion(db, baseGestion()).gestion;
        state.unshift(persisted);
      }, /fallo sintético/);
      assert.equal(state.length, 0);
      assert.equal(listGestiones(db).length, 0);
    }),
  },
  {
    id: "C2-04",
    name: "eliminar ID inexistente devuelve NOT_FOUND",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      const result = deleteGestion(db, 999);
      assert.equal(result.ok, false);
      assert.equal("code" in result && result.code, "GESTION_NOT_FOUND");
    }),
  },
  {
    id: "C2-05",
    name: "cumplir ID inexistente devuelve NOT_FOUND",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      const result = fulfillGestion(db, 999);
      assert.equal(result.ok, false);
      assert.equal("code" in result && result.code, "GESTION_NOT_FOUND");
    }),
  },
  {
    id: "C2-06",
    name: "gestionEditar persiste tras reinicio",
    expectedFailure: false,
    run: () => withDatabase((db, file) => {
      const id = saveGestion(db, baseGestion()).gestion.id!;
      const result = updateGestion(db, id, baseGestion({ observacion: "C2 editada" }));
      assert.equal(result.ok, true);
      db.close();
      const reopened = new Database(file);
      try {
        assert.equal(row(reopened, id)?.observacion, "C2 editada");
      } finally {
        reopened.close();
      }
    }),
  },
  {
    id: "C2-07",
    name: "alta exitosa no escribe cartera_gestiones_locales",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      const legacyStorage = JSON.stringify([{ legacy_id: "legacy-existing" }]);
      const result = saveGestion(db, baseGestion());
      assert.equal(result.ok, true);
      assert.equal(JSON.stringify([{ legacy_id: "legacy-existing" }]), legacyStorage);
    }),
  },
  {
    id: "C2-08",
    name: "migración legacy es idempotente",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      const records = [{ ...baseGestion(), legacy_id: "manual_100" }];
      const first = migrateLegacyGestiones(db, "localStorage", records);
      const second = migrateLegacyGestiones(db, "localStorage", records);
      assert.equal(first.mappings[0]?.gestion_id, second.mappings[0]?.gestion_id);
      assert.equal(listGestiones(db).length, 1);
    }),
  },
  {
    id: "C2-09",
    name: "migración conserva dos gestiones legítimas distintas",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      migrateLegacyGestiones(db, "localStorage", [
        { ...baseGestion(), legacy_id: "manual_101" },
        { ...baseGestion(), legacy_id: "manual_102" },
      ]);
      assert.equal(listGestiones(db).length, 2);
    }),
  },
  {
    id: "C2-10",
    name: "registro migrado obtiene ID SQLite real",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      const result = migrateLegacyGestiones(db, "localStorage", [
        { ...baseGestion(), legacy_id: "manual_103" },
      ]);
      const id = result.mappings[0]?.gestion_id;
      assert.equal(typeof id, "number");
      assert.equal(row(db, id!)?.id, id);
    }),
  },
  {
    id: "C2-11",
    name: "legacy sin ID recibe UUID estable antes de migrar",
    expectedFailure: false,
    run: () => {
      let calls = 0;
      const first = ensureLegacyGestionIds([baseGestion()], () => `stable-${++calls}`);
      const persisted = JSON.parse(JSON.stringify(first)) as unknown[];
      const retry = ensureLegacyGestionIds(persisted, () => `new-${++calls}`);
      assert.equal(first[0]?.legacy_id, "uuid_stable-1");
      assert.equal(retry[0]?.legacy_id, first[0]?.legacy_id);
      assert.equal(calls, 1);
    },
  },
  {
    id: "C2-12",
    name: "reintento tras fallo parcial reutiliza UUID y no duplica",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      const records = ensureLegacyGestionIds([
        baseGestion({ observacion: "OK" }),
        baseGestion({ observacion: "FAIL" }),
      ], (() => {
        let value = 0;
        return () => `retry-${++value}`;
      })());
      db.exec(`
        CREATE TRIGGER fail_second_legacy
        BEFORE INSERT ON gestiones
        WHEN NEW.observacion = 'FAIL'
        BEGIN SELECT RAISE(ABORT, 'fallo parcial'); END;
      `);
      assert.throws(
        () => migrateLegacyGestiones(db, "localStorage", records.map((item) => ({
          ...baseGestion(item),
          legacy_id: item.legacy_id,
        }))),
        /fallo parcial/,
      );
      assert.equal(listGestiones(db).length, 1);
      db.exec("DROP TRIGGER fail_second_legacy");
      migrateLegacyGestiones(db, "localStorage", records.map((item) => ({
        ...baseGestion(item),
        legacy_id: item.legacy_id,
      })));
      assert.equal(listGestiones(db).length, 2);
      assert.equal(new Set(records.map((item) => item.legacy_id)).size, 2);
    }),
  },
  {
    id: "C2-13",
    name: "contenido idéntico con UUID distintos migra como dos gestiones",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      migrateLegacyGestiones(db, "localStorage", [
        { ...baseGestion(), legacy_id: "uuid_first" },
        { ...baseGestion(), legacy_id: "uuid_second" },
      ]);
      assert.equal(listGestiones(db).length, 2);
    }),
  },
  {
    id: "C2-14",
    name: "correspondencia legacy sobrevive reinicio",
    expectedFailure: false,
    run: () => withDatabase((db, file) => {
      const migrated = migrateLegacyGestiones(db, "localStorage", [
        { ...baseGestion(), legacy_id: "uuid_restart" },
      ]);
      const expectedId = migrated.mappings[0]?.gestion_id;
      db.close();
      const reopened = new Database(file);
      try {
        const mapping = reopened.prepare(`
          SELECT gestion_id FROM gestion_legacy_migrations
          WHERE source = 'localStorage' AND legacy_id = 'uuid_restart'
        `).get() as { gestion_id: number };
        assert.equal(mapping.gestion_id, expectedId);
      } finally {
        reopened.close();
      }
    }),
  },
  {
    id: "C2-15",
    name: "doble migración conserva cantidad exacta",
    expectedFailure: false,
    run: () => withDatabase((db) => {
      const records = [
        { ...baseGestion(), legacy_id: "uuid_count_1" },
        { ...baseGestion(), legacy_id: "uuid_count_2" },
      ];
      migrateLegacyGestiones(db, "localStorage", records);
      const firstCount = listGestiones(db).length;
      migrateLegacyGestiones(db, "localStorage", records);
      assert.equal(listGestiones(db).length, firstCount);
      assert.equal(firstCount, 2);
    }),
  },
  {
    id: "C2H-01", name: "ID numérico colisionado crea otra gestión", expectedFailure: false,
    run: () => withDatabase((db) => { const original=createGestion(db,baseGestion({cliente:"A",observacion:"X"})); const result=migrateLegacyGestiones(db,"localStorage",[{...baseGestion({cliente:"B",observacion:"Y"}),id:original.id,legacy_id:"25"}]); assert.equal(result.ok,true); if(result.ok)assert.notEqual(result.mappings[0]?.gestion_id,original.id); assert.equal(row(db,original.id!)?.observacion,"X"); assert.equal(listGestiones(db).length,2); }),
  },
  {
    id: "C2H-02", name: "mismo legacy_id y payload es idempotente", expectedFailure: false,
    run: () => withDatabase((db) => { const value={...baseGestion(),legacy_id:"same"}; const a=migrateLegacyGestiones(db,"s",[value]); const b=migrateLegacyGestiones(db,"s",[value]); if(!a.ok||!b.ok)throw new Error("migration"); assert.equal(a.mappings[0]?.gestion_id,b.mappings[0]?.gestion_id); assert.equal(b.mappings[0]?.inserted,false); assert.equal(listGestiones(db).length,1); }),
  },
  {
    id: "C2H-03", name: "payload mutado devuelve conflicto", expectedFailure: false,
    run: () => withDatabase((db) => { migrateLegacyGestiones(db,"s",[{...baseGestion(),legacy_id:"conflict"}]); const result=migrateLegacyGestiones(db,"s",[{...baseGestion({observacion:"otra"}),legacy_id:"conflict"}]); assert.equal(result.ok,false); if(!result.ok)assert.equal(result.code,"LEGACY_ID_CONFLICT"); assert.equal(listGestiones(db).length,1); }),
  },
  {
    id: "C2H-04", name: "colisión dentro del lote se detecta antes de insertar", expectedFailure: false,
    run: () => withDatabase((db) => { const result=migrateLegacyGestiones(db,"s",[{...baseGestion(),legacy_id:"dup"},{...baseGestion({observacion:"otra"}),legacy_id:"dup"}]); assert.equal(result.ok,false); assert.equal(listGestiones(db).length,0); }),
  },
  {
    id: "C2H-05", name: "fallo persistiendo UUID impide IPC", expectedFailure: false,
    run: () => { let ipc=0; assert.throws(()=>persistLegacyGestionIds([baseGestion()],()=>"stable",()=>{throw new Error("quota")}),/quota/); assert.equal(ipc,0); },
  },
  {
    id: "C2H-06", name: "UUID durable se reutiliza tras fallo IPC", expectedFailure: false,
    run: () => withDatabase((db) => { let stored:unknown[]=[]; const normalized=persistLegacyGestionIds([baseGestion()],()=>"retry",v=>{stored=v}); db.exec(`CREATE TRIGGER fail_ipc BEFORE INSERT ON gestiones BEGIN SELECT RAISE(ABORT,'ipc'); END`); assert.throws(()=>migrateLegacyGestiones(db,"s",normalized as any),/ipc/); db.exec("DROP TRIGGER fail_ipc"); const retry=ensureLegacyGestionIds(stored,()=>"different"); migrateLegacyGestiones(db,"s",retry as any); assert.equal(retry[0]?.legacy_id,"uuid_retry"); assert.equal(listGestiones(db).length,1); }),
  },
  {
    id: "C2H-07", name: "cliente vacío se rechaza", expectedFailure: false,
    run: () => withDatabase((db) => { const result=migrateLegacyGestiones(db,"s",[{...baseGestion({cliente:" "}),legacy_id:"bad"}]); assert.equal(result.ok,false); if(!result.ok)assert.equal(result.code,"LEGACY_INVALID_RECORD"); assert.equal(listGestiones(db).length,0); assert.equal((db.prepare("SELECT count(*) n FROM gestion_legacy_migrations").get() as any).n,0); }),
  },
  {
    id: "C2H-08", name: "eliminación crea tombstone y no resucita", expectedFailure: false,
    run: () => withDatabase((db) => { const value={...baseGestion(),legacy_id:"gone"}; const first=migrateLegacyGestiones(db,"s",[value]); if(!first.ok)throw new Error("migration"); deleteGestion(db,first.mappings[0]!.gestion_id); const retry=migrateLegacyGestiones(db,"s",[value]); assert.equal(retry.ok,true); if(retry.ok)assert.equal(retry.mappings[0]?.deleted,true); assert.equal(listGestiones(db).length,0); }),
  },
  {
    id: "C2H-09", name: "tombstone sobrevive reinicio", expectedFailure: false,
    run: () => withDatabase((db,file) => { const value={...baseGestion(),legacy_id:"restart-gone"}; const first=migrateLegacyGestiones(db,"s",[value]); if(!first.ok)throw new Error("migration"); deleteGestion(db,first.mappings[0]!.gestion_id); db.close(); const reopened=new Database(file); try{const tomb=reopened.prepare("SELECT gestion_id,deleted_at FROM gestion_legacy_migrations WHERE legacy_id='restart-gone'").get() as any;assert.equal(tomb.gestion_id,null);assert.ok(tomb.deleted_at);}finally{reopened.close();} }),
  },
  {
    id: "C2H-10", name: "marca completa no omite legacy nuevo", expectedFailure: false,
    run: () => { const app=fs.readFileSync(path.resolve("src/App.tsx"),"utf8"); assert.doesNotMatch(app,/getItem\(LEGACY_GESTIONES_COMPLETE_KEY\).*return/); },
  },
  {
    id: "C2H-11", name: "restore DB reevalúa aunque exista marca", expectedFailure: false,
    run: () => { const app=fs.readFileSync(path.resolve("src/App.tsx"),"utf8"); assert.match(app,/gestionesLegacyMigrar/); assert.doesNotMatch(app,/COMPLETE_KEY\) === "1"/); },
  },
  {
    id: "C2H-12", name: "payload idéntico con IDs distintos crea dos filas", expectedFailure: false,
    run: () => withDatabase((db) => { const value=baseGestion(); migrateLegacyGestiones(db,"s",[{...value,legacy_id:"A"},{...value,legacy_id:"B"}]); assert.equal(listGestiones(db).length,2); assert.equal(hashLegacyGestion({...value,legacy_id:"A"}),hashLegacyGestion({...value,legacy_id:"B"})); assert.equal(canonicalizeLegacyGestion({...value,legacy_id:"A"}),canonicalizeLegacyGestion({...value,legacy_id:"B"})); }),
  },
  {
    id: "C2H-13", name: "doble submit concurrente ejecuta una operación", expectedFailure: false,
    run: () => { let calls=0; let release!:()=>void; const pending=new Promise<void>(resolve=>{release=resolve}); const guarded=createSingleFlight(async()=>{calls++;await pending;}); void guarded(); void guarded(); assert.equal(calls,1); release(); },
  },
  {
    id: "C2H-14", name: "fallo insertando mapping revierte gestión", expectedFailure: false,
    run: () => withDatabase((db) => { db.exec(`CREATE TRIGGER fail_mapping BEFORE INSERT ON gestion_legacy_migrations BEGIN SELECT RAISE(ABORT,'mapping'); END`); assert.throws(()=>migrateLegacyGestiones(db,"s",[{...baseGestion(),legacy_id:"atomic"}]),/mapping/); assert.equal(listGestiones(db).length,0); assert.equal((db.prepare("SELECT count(*) n FROM gestion_legacy_migrations").get() as any).n,0); }),
  },
  {id:'C3-01',name:'crear promesa y recuperar tras reinicio',expectedFailure:false,run:()=>withDatabase((db,file)=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);db.close();const reopened=new Database(file);try{assert.equal(getPromesaById(reopened,r.promesa.id)?.cliente,'CLIENTE-P');}finally{reopened.close();}})},
  {id:'C3-02',name:'editar fecha y monto persiste',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);updatePromesa(db,r.promesa.id,{fecha_promesa:'2027-01-01',monto_prometido:200});assert.equal(getPromesaById(db,r.promesa.id)?.monto_prometido,200);})},
  {id:'C3-03',name:'cumplimiento manual rechazado',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);assert.equal(changePromesaState(db,r.promesa.id,'CUMPLIDA').ok,false);})},
  {id:'C3-04',name:'cumplimiento parcial manual rechazado',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);assert.equal(changePromesaState(db,r.promesa.id,'CUMPLIDA_PARCIAL',{monto_pagado:40}).ok,false);})},
  {id:'C3-05',name:'estado incumplida',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);assert.equal(changePromesaState(db,r.promesa.id,'INCUMPLIDA').ok,true);})},
  {id:'C3-06',name:'cancelar promesa',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);assert.equal(changePromesaState(db,r.promesa.id,'CANCELADA').ok,true);})},
  {id:'C3-07',name:'monto pagado excesivo rechazado',expectedFailure:false,run:()=>withDatabase(db=>{assert.equal(createPromesa(db,{...basePromesa(),monto_pagado:101}).ok,false);})},
  {id:'C3-08',name:'transición inválida rechazada',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);changePromesaState(db,r.promesa.id,'CANCELADA');const x=changePromesaState(db,r.promesa.id,'CUMPLIDA');assert.equal(x.ok,false);if(!x.ok)assert.equal(x.code,'PROMESA_INVALID_TRANSITION');})},
  {id:'C3-09',name:'migración histórica idempotente',expectedFailure:false,run:()=>withDatabase(db=>{createGestion(db,baseGestion({resultado:'Promesa de Pago',fecha_promesa:'2026-12-01',monto_promesa:50}));assert.equal(migrateHistoricalPromises(db),1);assert.equal(migrateHistoricalPromises(db),0);assert.equal(listPromesas(db).length,1);})},
  {id:'C3-10',name:'Promesa Cumplida histórica permanece sólo como CRM',expectedFailure:false,run:()=>withDatabase(db=>{const gestion=createGestion(db,baseGestion({resultado:'Promesa Cumplida',fecha_promesa:'2026-12-01',monto_promesa:50}));assert.equal(migrateHistoricalPromises(db),0);assert.equal(listPromesas(db).length,0);assert.equal(getGestionById(db,gestion.id!)?.resultado,'Promesa Cumplida');})},
  {id:'C3-11',name:'migración cartera_promesas_locales',expectedFailure:false,run:()=>withDatabase(db=>{const x=migrateLegacyPromises(db,'localStorage',[{...basePromesa(),legacy_id:'local-1'}]);assert.equal(x.ok,true);assert.equal(listPromesas(db).length,1);})},
  {id:'C3-12',name:'reinicio conserva migración local',expectedFailure:false,run:()=>withDatabase((db,file)=>{migrateLegacyPromises(db,'localStorage',[{...basePromesa(),legacy_id:'local-r'}]);db.close();const reopened=new Database(file);try{assert.equal(listPromesas(reopened).length,1);}finally{reopened.close();}})},
  {id:'C3-13',name:'nueva promesa no escribe localStorage',expectedFailure:false,run:()=>{const app=fs.readFileSync(path.resolve('src/App.tsx'),'utf8');assert.doesNotMatch(app,/localStorage\.setItem\(['"]cartera_promesas_locales/);}},
  {id:'C3-14',name:'SQLite nativo no sobrescrito por legacy viejo',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);migrateLegacyPromises(db,'localStorage',[{...basePromesa(),legacy_id:'old',gestion_id:undefined,observacion:'viejo'}]);assert.equal(getPromesaById(db,r.promesa.id)?.observacion,'Compromiso');})},
  {id:'C3-15',name:'dos promesas del mismo cliente independientes',expectedFailure:false,run:()=>withDatabase(db=>{createPromesa(db,basePromesa());createPromesa(db,{...basePromesa(),fecha_promesa:'2026-12-16'});assert.equal(listPromesas(db).length,2);})},
  {id:'C3-16',name:'gestión permanece tras migrar',expectedFailure:false,run:()=>withDatabase(db=>{const g=createGestion(db,baseGestion({resultado:'Promesa de Pago',fecha_promesa:'2026-12-01',monto_promesa:50}));migrateHistoricalPromises(db);assert.ok(getGestionById(db,g.id!));})},
  {id:'C3-17',name:'cancelación no borra gestión',expectedFailure:false,run:()=>withDatabase(db=>{const g=createGestion(db,baseGestion({resultado:'Promesa de Pago',fecha_promesa:'2026-12-01',monto_promesa:50}));migrateHistoricalPromises(db);changePromesaState(db,listPromesas(db)[0]!.id,'CANCELADA');assert.ok(getGestionById(db,g.id!));})},
  {id:'C3-18',name:'ID promesa SQLite real',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());assert.equal(r.ok&&typeof r.promesa.id,'number');})},
  {id:'C3-19',name:'update inexistente devuelve NOT_FOUND',expectedFailure:false,run:()=>withDatabase(db=>{const r=updatePromesa(db,999,{observacion:'x'});assert.equal(r.ok,false);if(!r.ok)assert.equal(r.code,'PROMESA_NOT_FOUND');})},
  {id:'C3-20',name:'migración doble no duplica',expectedFailure:false,run:()=>withDatabase(db=>{const value={...basePromesa(),legacy_id:'twice'};migrateLegacyPromises(db,'s',[value]);migrateLegacyPromises(db,'s',[value]);assert.equal(listPromesas(db).length,1);})},
  {id:'C3H-01',name:'colisión ID numérico legacy no vincula gestión',expectedFailure:false,run:()=>withDatabase(db=>{const g=createGestion(db,baseGestion({cliente:'A'}));const native=createPromesa(db,{...basePromesa(),cliente:'A',gestion_id:g.id});if(!native.ok)throw new Error(native.message);const x=migrateLegacyPromises(db,'localStorage',[{...basePromesa(),legacy_id:String(g.id),gestion_id:g.id,cliente:'B'}]);assert.equal(x.ok,true);assert.equal(getPromesaById(db,native.promesa.id)?.cliente,'A');assert.equal(listPromesas(db).find(p=>p.cliente==='B')?.gestion_id,null);})},
  {id:'C3H-02',name:'legacy viejo no sobrescribe SQLite vinculada',expectedFailure:false,run:()=>withDatabase(db=>{const g=createGestion(db,baseGestion({resultado:'Promesa de Pago',fecha_promesa:'2026-12-01',monto_promesa:100}));migrateHistoricalPromises(db);const original=listPromesas(db)[0]!;const x=migrateLegacyPromises(db,'s',[{...basePromesa(),legacy_id:'old',gestion_id:g.id,observacion:'viejo'}]);assert.equal(x.ok,true);assert.equal(getPromesaById(db,original.id)?.observacion,baseGestion().observacion);})},
  {id:'C3H-03',name:'restore sin mapping conserva promesa nativa',expectedFailure:false,run:()=>withDatabase((db,file)=>{const g=createGestion(db,baseGestion());const r=createPromesa(db,{...basePromesa(),gestion_id:g.id,observacion:'nuevo'});if(!r.ok)throw new Error(r.message);db.close();const restored=new Database(file);try{migrateLegacyPromises(restored,'s',[{...basePromesa(),legacy_id:'restore-old',gestion_id:g.id,observacion:'viejo'}]);assert.equal(getPromesaById(restored,r.promesa.id)?.observacion,'nuevo');}finally{restored.close();}})},
  {id:'C3H-04',name:'mapping huérfano devuelve error explícito',expectedFailure:false,run:()=>withDatabase(db=>{const value={...basePromesa(),legacy_id:'orphan'};const first=migrateLegacyPromises(db,'s',[value]);if(!first.ok)throw new Error(first.message);db.pragma('foreign_keys = OFF');db.prepare('DELETE FROM promesas WHERE id=?').run(first.mappings[0]!.promesa_id);const x=migrateLegacyPromises(db,'s',[value]);assert.equal(x.ok,false);if(!x.ok)assert.equal(x.code,'PROMESA_LEGACY_MAPPING_ORPHAN');})},
  {id:'C3H-05',name:'hash legacy idempotente',expectedFailure:false,run:()=>withDatabase(db=>{const value={...basePromesa(),legacy_id:'same'};const a=migrateLegacyPromises(db,'s',[value]);const b=migrateLegacyPromises(db,'s',[value]);assert.equal(a.ok&&b.ok,true);assert.equal(listPromesas(db).length,1);})},
  {id:'C3H-06',name:'hash legacy conflictivo',expectedFailure:false,run:()=>withDatabase(db=>{migrateLegacyPromises(db,'s',[{...basePromesa(),legacy_id:'conflict'}]);const x=migrateLegacyPromises(db,'s',[{...basePromesa(),legacy_id:'conflict',observacion:'mutado'}]);assert.equal(x.ok,false);if(!x.ok)assert.equal(x.code,'PROMESA_LEGACY_ID_CONFLICT');})},
  {id:'C3H-07',name:'edición y transición inválida es atómica',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);changePromesaState(db,r.promesa.id,'CANCELADA');const x=updatePromesaAtomic(db,r.promesa.id,{observacion:'no persistir',estado:'CUMPLIDA'});assert.equal(x.ok,false);assert.equal(getPromesaById(db,r.promesa.id)?.observacion,'Compromiso');})},
  {id:'C3H-08',name:'edición más cumplimiento manual se rechaza atómicamente',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);const x=updatePromesaAtomic(db,r.promesa.id,{observacion:'pagada',estado:'CUMPLIDA'});assert.equal(x.ok,false);assert.equal(getPromesaById(db,r.promesa.id)?.observacion,'Compromiso');})},
  {id:'C3H-09',name:'edición genera evento con cambios',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);updatePromesaAtomic(db,r.promesa.id,{fecha_promesa:'2027-01-01',monto_prometido:200,observacion:'editada'});const e=db.prepare("SELECT metadata FROM promesa_eventos WHERE promesa_id=? AND tipo_evento='PROMESA_EDITADA'").get(r.promesa.id) as any;assert.equal(JSON.parse(e.metadata).changes.monto_prometido.nuevo,200);})},
  {id:'C3H-10',name:'fallo de evento revierte update',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);db.exec("CREATE TRIGGER fail_promise_event BEFORE INSERT ON promesa_eventos WHEN NEW.tipo_evento='PROMESA_EDITADA' BEGIN SELECT RAISE(ABORT,'event'); END");assert.throws(()=>updatePromesaAtomic(db,r.promesa.id,{observacion:'no persistir'}),/event/);assert.equal(getPromesaById(db,r.promesa.id)?.observacion,'Compromiso');})},
  {id:'C3H-11',name:'NaN rechazado',expectedFailure:false,run:()=>withDatabase(db=>{assert.equal(createPromesa(db,{...basePromesa(),monto_pagado:Number.NaN}).ok,false);})},
  {id:'C3H-12',name:'Infinity rechazado',expectedFailure:false,run:()=>withDatabase(db=>{assert.equal(createPromesa(db,{...basePromesa(),monto_prometido:Number.POSITIVE_INFINITY}).ok,false);})},
  {id:'C3H-13',name:'monto pagado excedido rechazado',expectedFailure:false,run:()=>withDatabase(db=>{assert.equal(createPromesa(db,{...basePromesa(),monto_pagado:101}).ok,false);})},
  {id:'C3H-14',name:'promesas idénticas legítimas independientes',expectedFailure:false,run:()=>withDatabase(db=>{createPromesa(db,basePromesa());createPromesa(db,basePromesa());assert.equal(listPromesas(db).length,2);})},
  {id:'C3H-15',name:'legacy ambiguo no modifica existente',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);migrateLegacyPromises(db,'s',[{...basePromesa(),legacy_id:'ambiguous',gestion_id:777,observacion:'legacy'}]);assert.equal(getPromesaById(db,r.promesa.id)?.observacion,'Compromiso');assert.equal(listPromesas(db).length,2);})},
  {id:'C3F-01',name:'CUMPLIDA rechaza monto_pagado Infinity',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);assert.equal(updatePromesaAtomic(db,r.promesa.id,{estado:'CUMPLIDA',monto_pagado:Number.POSITIVE_INFINITY}).ok,false);})},
  {id:'C3F-02',name:'CUMPLIDA rechaza monto_pagado NaN',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);assert.equal(updatePromesaAtomic(db,r.promesa.id,{estado:'CUMPLIDA',monto_pagado:Number.NaN}).ok,false);})},
  {id:'C3F-03',name:'CUMPLIDA rechaza monto_pagado -Infinity',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);assert.equal(updatePromesaAtomic(db,r.promesa.id,{estado:'CUMPLIDA',monto_pagado:Number.NEGATIVE_INFINITY}).ok,false);})},
  {id:'C3F-04',name:'CUMPLIDA rechaza monto_pagado string',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);assert.equal(updatePromesaAtomic(db,r.promesa.id,{estado:'CUMPLIDA',monto_pagado:'100'} as any).ok,false);})},
  {id:'C3F-05',name:'CUMPLIDA rechaza monto_pagado undefined explícito',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);assert.equal(updatePromesaAtomic(db,r.promesa.id,{estado:'CUMPLIDA',monto_pagado:undefined}).ok,false);})},
  {id:'C3F-06',name:'CUMPLIDA manual sin monto_pagado también se rechaza',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);assert.equal(updatePromesaAtomic(db,r.promesa.id,{estado:'CUMPLIDA'}).ok,false);})},
  {id:'C3F-07',name:'CUMPLIDA rechaza pago distinto al prometido',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);assert.equal(updatePromesaAtomic(db,r.promesa.id,{estado:'CUMPLIDA',monto_pagado:99}).ok,false);})},
  {id:'C3F-08',name:'PENDIENTE a PENDIENTE sin cambios es no-op',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);db.prepare("UPDATE promesas SET actualizado_en='2020-01-01 00:00:00' WHERE id=?").run(r.promesa.id);const before=getPromesaById(db,r.promesa.id)!;const events=(db.prepare('SELECT count(*) n FROM promesa_eventos WHERE promesa_id=?').get(r.promesa.id) as any).n;const x=updatePromesaAtomic(db,r.promesa.id,{estado:'PENDIENTE'});assert.equal(x.ok,true);assert.deepEqual(getPromesaById(db,r.promesa.id),before);assert.equal((db.prepare('SELECT count(*) n FROM promesa_eventos WHERE promesa_id=?').get(r.promesa.id) as any).n,events);})},
  {id:'C3F-09',name:'promesa CUMPLIDA histórica sin edición es no-op',expectedFailure:false,run:()=>withDatabase(db=>{const x=migrateLegacyPromises(db,'s',[{...basePromesa(),legacy_id:'fulfilled-noop',estado:'CUMPLIDA',monto_pagado:100}]);if(!x.ok)throw new Error(x.message);const id=x.mappings[0]!.promesa_id;db.prepare("UPDATE promesas SET actualizado_en='2020-01-01 00:00:00' WHERE id=?").run(id);const before=getPromesaById(db,id)!;const events=(db.prepare('SELECT count(*) n FROM promesa_eventos WHERE promesa_id=?').get(id) as any).n;assert.equal(updatePromesaAtomic(db,id,{}).ok,true);assert.deepEqual(getPromesaById(db,id),before);assert.equal((db.prepare('SELECT count(*) n FROM promesa_eventos WHERE promesa_id=?').get(id) as any).n,events);})},
  {id:'C3F-10',name:'mismo estado con observación genera sólo edición',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);db.prepare("UPDATE promesas SET actualizado_en='2020-01-01 00:00:00' WHERE id=?").run(r.promesa.id);const x=updatePromesaAtomic(db,r.promesa.id,{estado:'PENDIENTE',observacion:'modificada'});assert.equal(x.ok,true);assert.notEqual(getPromesaById(db,r.promesa.id)?.actualizado_en,'2020-01-01 00:00:00');assert.equal((db.prepare("SELECT count(*) n FROM promesa_eventos WHERE promesa_id=? AND tipo_evento='PROMESA_EDITADA'").get(r.promesa.id) as any).n,1);assert.equal((db.prepare("SELECT count(*) n FROM promesa_eventos WHERE promesa_id=? AND tipo_evento='PROMESA_ESTADO_CAMBIADO'").get(r.promesa.id) as any).n,0);})},
  {id:'C3F-11',name:'update idéntico repetido no duplica evento',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,basePromesa());if(!r.ok)throw new Error(r.message);updatePromesaAtomic(db,r.promesa.id,{observacion:'única'});const before=getPromesaById(db,r.promesa.id)!;const count=(db.prepare("SELECT count(*) n FROM promesa_eventos WHERE promesa_id=? AND tipo_evento='PROMESA_EDITADA'").get(r.promesa.id) as any).n;updatePromesaAtomic(db,r.promesa.id,{observacion:'única'});assert.deepEqual(getPromesaById(db,r.promesa.id),before);assert.equal((db.prepare("SELECT count(*) n FROM promesa_eventos WHERE promesa_id=? AND tipo_evento='PROMESA_EDITADA'").get(r.promesa.id) as any).n,count);})},
  {id:'C3G-01',name:'crear manual CUMPLIDA sin pago se rechaza',expectedFailure:false,run:()=>withDatabase(db=>{assert.equal(createPromesa(db,{cliente:'G',fecha_promesa:'2027-01-01',monto_prometido:100,estado:'CUMPLIDA'}).ok,false);})},
  {id:'C3G-02',name:'crear manual CUMPLIDA con pago se rechaza',expectedFailure:false,run:()=>withDatabase(db=>{assert.equal(createPromesa(db,{cliente:'G',fecha_promesa:'2027-01-01',monto_prometido:100,monto_pagado:100,estado:'CUMPLIDA'}).ok,false);})},
  {id:'C3G-03',name:'crear CUMPLIDA con pago distinto rechaza',expectedFailure:false,run:()=>withDatabase(db=>{assert.equal(createPromesa(db,{cliente:'G',fecha_promesa:'2027-01-01',monto_prometido:100,monto_pagado:99,estado:'CUMPLIDA'}).ok,false);})},
  {id:'C3G-04',name:'crear CUMPLIDA con undefined explícito rechaza',expectedFailure:false,run:()=>withDatabase(db=>{assert.equal(createPromesa(db,{cliente:'G',fecha_promesa:'2027-01-01',monto_prometido:100,monto_pagado:undefined,estado:'CUMPLIDA'}).ok,false);})},
  {id:'C3G-05',name:'crear CUMPLIDA rechaza pagos no finitos o no numéricos',expectedFailure:false,run:()=>withDatabase(db=>{for(const value of [Number.NaN,Number.POSITIVE_INFINITY,Number.NEGATIVE_INFINITY,'100',{},[]])assert.equal(createPromesa(db,{cliente:'G',fecha_promesa:'2027-01-01',monto_prometido:100,monto_pagado:value,estado:'CUMPLIDA'} as any).ok,false);})},
  {id:'C3G-06',name:'legacy CUMPLIDA sin pago deriva total y crea mapping',expectedFailure:false,run:()=>withDatabase(db=>{let persisted:unknown[]=[];const prepared=prepareLegacyPromises([{id:'fulfilled-old',cliente:'G',fecha_promesa:'2027-01-01',monto_prometido:100,estado:'CUMPLIDA'}],()=> 'unused',value=>{persisted=value});assert.equal(Object.prototype.hasOwnProperty.call(prepared[0]!,'monto_pagado'),false);assert.equal(Object.prototype.hasOwnProperty.call(persisted[0] as object,'monto_pagado'),false);const x=migrateLegacyPromises(db,'s',prepared);assert.equal(x.ok,true);assert.equal(listPromesas(db)[0]?.monto_pagado,100);assert.equal((db.prepare('SELECT count(*) n FROM promesa_legacy_migrations').get() as any).n,1);})},
  {id:'C3G-07',name:'legacy CUMPLIDA con pago inválido no deja filas',expectedFailure:false,run:()=>withDatabase(db=>{const prepared=prepareLegacyPromises([{id:'bad-old',cliente:'G',fecha_promesa:'2027-01-01',monto_prometido:100,monto_pagado:'bad',estado:'CUMPLIDA'}],()=> 'unused',()=>{});assert.equal(migrateLegacyPromises(db,'s',prepared).ok,false);assert.equal(listPromesas(db).length,0);assert.equal((db.prepare('SELECT count(*) n FROM promesa_legacy_migrations').get() as any).n,0);})},
  {id:'C3G-08',name:'eliminar gestión conserva y desacopla promesa con evento',expectedFailure:false,run:()=>withDatabase(db=>{const g=createGestion(db,baseGestion());const p=createPromesa(db,{...basePromesa(),gestion_id:g.id});if(!p.ok)throw new Error(p.message);assert.equal(deleteGestion(db,g.id).ok,true);assert.equal(getPromesaById(db,p.promesa.id)?.gestion_id,null);assert.equal((db.prepare("SELECT count(*) n FROM promesa_eventos WHERE promesa_id=? AND tipo_evento='PROMESA_GESTION_DESVINCULADA'").get(p.promesa.id) as any).n,1);})},
  {id:'C3G-09',name:'evento de desacoplamiento conserva metadata',expectedFailure:false,run:()=>withDatabase(db=>{const g=createGestion(db,baseGestion());const p=createPromesa(db,{...basePromesa(),gestion_id:g.id});if(!p.ok)throw new Error(p.message);deleteGestion(db,g.id);const e=db.prepare("SELECT metadata FROM promesa_eventos WHERE promesa_id=? AND tipo_evento='PROMESA_GESTION_DESVINCULADA'").get(p.promesa.id) as any;const metadata=JSON.parse(e.metadata);assert.equal(metadata.changes.gestion_id.anterior,g.id);assert.equal(metadata.changes.gestion_id.nuevo,null);assert.equal(metadata.reason,'GESTION_DELETED');})},
  {id:'C3G-10',name:'fallo de evento revierte delete completo y tombstone',expectedFailure:false,run:()=>withDatabase(db=>{const legacy={...baseGestion(),legacy_id:'delete-atomic'};const migrated=migrateLegacyGestiones(db,'s',[legacy]);if(!migrated.ok)throw new Error(migrated.message);const gestionId=migrated.mappings[0]!.gestion_id!;const p=createPromesa(db,{...basePromesa(),gestion_id:gestionId});if(!p.ok)throw new Error(p.message);db.exec("CREATE TRIGGER fail_unlink_event BEFORE INSERT ON promesa_eventos WHEN NEW.tipo_evento='PROMESA_GESTION_DESVINCULADA' BEGIN SELECT RAISE(ABORT,'unlink event'); END");assert.throws(()=>deleteGestion(db,gestionId),/unlink event/);assert.ok(getGestionById(db,gestionId));assert.equal(getPromesaById(db,p.promesa.id)?.gestion_id,gestionId);const mapping=db.prepare("SELECT gestion_id,deleted_at FROM gestion_legacy_migrations WHERE source='s' AND legacy_id='delete-atomic'").get() as any;assert.equal(mapping.gestion_id,gestionId);assert.equal(mapping.deleted_at,null);assert.equal((db.prepare("SELECT count(*) n FROM promesa_eventos WHERE tipo_evento='PROMESA_GESTION_DESVINCULADA'").get() as any).n,0);})},
  {id:'C3G-11',name:'eliminar gestión sin promesa no crea evento ficticio',expectedFailure:false,run:()=>withDatabase(db=>{const g=createGestion(db,baseGestion());assert.equal(deleteGestion(db,g.id).ok,true);assert.equal((db.prepare("SELECT count(*) n FROM promesa_eventos WHERE tipo_evento='PROMESA_GESTION_DESVINCULADA'").get() as any).n,0);})},
  {id:'C3G-12',name:'reintento tras eliminación no resucita ni duplica evento',expectedFailure:false,run:()=>withDatabase(db=>{const legacy={...baseGestion(),legacy_id:'delete-once'};const migrated=migrateLegacyGestiones(db,'s',[legacy]);if(!migrated.ok)throw new Error(migrated.message);const gestionId=migrated.mappings[0]!.gestion_id!;const p=createPromesa(db,{...basePromesa(),gestion_id:gestionId});if(!p.ok)throw new Error(p.message);assert.equal(deleteGestion(db,gestionId).ok,true);assert.equal(deleteGestion(db,gestionId).ok,false);const retry=migrateLegacyGestiones(db,'s',[legacy]);assert.equal(retry.ok,true);assert.equal(getGestionById(db,gestionId),undefined);assert.equal(getPromesaById(db,p.promesa.id)?.gestion_id,null);assert.equal((db.prepare("SELECT count(*) n FROM promesa_eventos WHERE promesa_id=? AND tipo_evento='PROMESA_GESTION_DESVINCULADA'").get(p.promesa.id) as any).n,1);})},
  {id:'C3I-01',name:'crear promesa no altera evidencia financiera',expectedFailure:false,run:()=>withDatabase(db=>{importedCobro(db,'base');const before=db.prepare('SELECT count(*) n,sum(valor) total FROM cobros_movimientos_importados').get();linkedPromesa(db);assert.deepEqual(db.prepare('SELECT count(*) n,sum(valor) total FROM cobros_movimientos_importados').get(),before);})},
  {id:'C3I-02',name:'monto, fecha y estados de pago manuales se rechazan',expectedFailure:false,run:()=>withDatabase(db=>{assert.equal(createPromesa(db,{...basePromesa(),monto_pagado:10}).ok,false);const p=linkedPromesa(db);assert.equal(updatePromesaAtomic(db,p.id,{monto_pagado:10,fecha_pago:'2099-01-01',estado:'CUMPLIDA_PARCIAL'}).ok,false);assert.equal(getPromesaById(db,p.id)?.monto_pagado,0);})},
  {id:'C3I-03',name:'COBRO conciliado produce cumplimiento parcial',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db);importedCobro(db,'partial','FAC-I',40);reconcilePromises(db);assert.equal(getPromesaById(db,p.id)?.estado,'CUMPLIDA_PARCIAL');assert.equal(getPromesaById(db,p.id)?.monto_pagado,40);})},
  {id:'C3I-04',name:'COBRO conciliado completa promesa',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db);importedCobro(db,'p1','FAC-I',40);importedCobro(db,'p2','FAC-I',60,'2099-01-02');reconcilePromises(db);assert.equal(getPromesaById(db,p.id)?.estado,'CUMPLIDA');assert.equal(getPromesaById(db,p.id)?.monto_pagado,100);})},
  {id:'C3I-05',name:'reconciliación repetida es idempotente',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db);importedCobro(db,'once');reconcilePromises(db);const before=db.prepare('SELECT count(*) n,sum(importe_atribuido) total FROM promesa_cobro_atribuciones').get();reconcilePromises(db);assert.deepEqual(db.prepare('SELECT count(*) n,sum(importe_atribuido) total FROM promesa_cobro_atribuciones').get(),before);assert.equal(getPromesaById(db,p.id)?.monto_pagado,100);})},
  {id:'C3I-06',name:'RETENCION no cumple promesa',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db);importedCobro(db,'ret','FAC-I',100,'2099-01-01','RETENCION');reconcilePromises(db);assert.equal(getPromesaById(db,p.id)?.estado,'PENDIENTE');})},
  {id:'C3I-07',name:'nota de crédito no cumple promesa',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db);db.prepare("INSERT INTO notas_credito_importadas(documento_relacionado_normalizado,total_nc,estado_conciliacion) VALUES('FAC-I',100,'CONCILIADO')").run();reconcilePromises(db);assert.equal(getPromesaById(db,p.id)?.monto_pagado,0);})},
  {id:'C3I-08',name:'anulación no cumple promesa',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db);db.prepare("INSERT INTO documentos_anulados_log(documento_normalizado) VALUES('FAC-I')").run();reconcilePromises(db);assert.equal(getPromesaById(db,p.id)?.monto_pagado,0);})},
  {id:'C3I-09',name:'cobro anterior a creación no se atribuye',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db);importedCobro(db,'old','FAC-I',100,'2020-01-01');reconcilePromises(db);assert.equal(getPromesaById(db,p.id)?.monto_pagado,0);})},
  {id:'C3I-10',name:'documento no asociado no se atribuye',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db);importedCobro(db,'other','FAC-OTRA');reconcilePromises(db);assert.equal(getPromesaById(db,p.id)?.monto_pagado,0);})},
  {id:'C3I-11',name:'un cobro no se duplica entre promesas',expectedFailure:false,run:()=>withDatabase(db=>{const first=linkedPromesa(db);const second=linkedPromesa(db);importedCobro(db,'global');reconcilePromises(db);assert.equal(getPromesaById(db,first.id)?.monto_pagado,100);assert.equal(getPromesaById(db,second.id)?.monto_pagado,0);assert.equal((db.prepare("SELECT sum(importe_atribuido) total FROM promesa_cobro_atribuciones WHERE movement_key='global'").get() as any).total,100);})},
  {id:'C3I-12',name:'consumo global sigue FIFO',expectedFailure:false,run:()=>withDatabase(db=>{const first=linkedPromesa(db,'FAC-I',500);const second=linkedPromesa(db,'FAC-I',500);importedCobro(db,'fifo','FAC-I',750);reconcilePromises(db);assert.equal(getPromesaById(db,first.id)?.monto_pagado,500);assert.equal(getPromesaById(db,second.id)?.monto_pagado,250);})},
  {id:'C3I-13',name:'cancelada deja de consumir cobros',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db);assert.equal(changePromesaState(db,p.id,'CANCELADA').ok,true);importedCobro(db,'cancelled');reconcilePromises(db);assert.equal(getPromesaById(db,p.id)?.monto_pagado,0);})},
  {id:'C3I-14',name:'reprogramada deja de consumir cobros',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db);assert.equal(changePromesaState(db,p.id,'REPROGRAMADA').ok,true);importedCobro(db,'rescheduled');reconcilePromises(db);assert.equal(getPromesaById(db,p.id)?.monto_pagado,0);})},
  {id:'C3I-15',name:'atribución sobrevive reinicio',expectedFailure:false,run:()=>withDatabase((db,file)=>{const p=linkedPromesa(db);importedCobro(db,'durable','FAC-I',35);reconcilePromises(db);db.close();const reopened=new Database(file);try{assert.equal(getPromesaById(reopened,p.id)?.monto_pagado,35);assert.equal((reopened.prepare("SELECT count(*) n FROM promesa_cobro_atribuciones WHERE movement_key='durable'").get() as any).n,1);}finally{reopened.close();}})},
  {id:'C3I-16',name:'importación tardía dispara cumplimiento al reconciliar',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db,'FAC-TARDIA');reconcilePromises(db);importedCobro(db,'late','FAC-TARDIA');reconcilePromises(db);assert.equal(getPromesaById(db,p.id)?.estado,'CUMPLIDA');})},
  {id:'C3I-17',name:'movimiento duplicado no duplica atribución',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db);importedCobro(db,'duplicate','FAC-I',50);importedCobro(db,'duplicate','FAC-I',50);reconcilePromises(db);assert.equal(getPromesaById(db,p.id)?.monto_pagado,50);assert.equal((db.prepare("SELECT count(*) n FROM promesa_cobro_atribuciones WHERE movement_key='duplicate'").get() as any).n,1);})},
  {id:'C3I-18',name:'sobrepago se limita al monto prometido',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db);importedCobro(db,'over','FAC-I',1000);reconcilePromises(db);assert.equal(getPromesaById(db,p.id)?.monto_pagado,100);assert.equal((db.prepare("SELECT importe_atribuido FROM promesa_cobro_atribuciones WHERE movement_key='over'").get() as any).importe_atribuido,100);})},
  {id:'C3I-19',name:'reintento no duplica eventos automáticos',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db);importedCobro(db,'event');reconcilePromises(db);const before=(db.prepare("SELECT count(*) n FROM promesa_eventos WHERE promesa_id=? AND tipo_evento LIKE 'PROMESA_%AUTOMATICAMENTE'").get(p.id) as any).n;reconcilePromises(db);assert.equal((db.prepare("SELECT count(*) n FROM promesa_eventos WHERE promesa_id=? AND tipo_evento LIKE 'PROMESA_%AUTOMATICAMENTE'").get(p.id) as any).n,before);})},
  {id:'C3I-20',name:'operaciones de promesa no mutan ledger financiero',expectedFailure:false,run:()=>withDatabase(db=>{importedCobro(db,'financial','FAC-I',77);const before=db.prepare('SELECT count(*) n,sum(valor) total FROM cobros_movimientos_importados').get();const p=linkedPromesa(db);updatePromesaAtomic(db,p.id,{observacion:'sólo CRM'});reconcilePromises(db);assert.deepEqual(db.prepare('SELECT count(*) n,sum(valor) total FROM cobros_movimientos_importados').get(),before);})},
  {id:'C3J-01',name:'preload normal no expone migración legacy',expectedFailure:false,run:()=>{const preload=fs.readFileSync(path.resolve('electron/preload.ts'),'utf8');const globals=fs.readFileSync(path.resolve('src/assets/types/global.d.ts'),'utf8');assert.doesNotMatch(preload,/promesasLegacyMigrar\s*:/);assert.doesNotMatch(globals,/promesasLegacyMigrar\s*:/);}},
  {id:'C3J-02',name:'payload productivo manipulado no crea cumplimiento',expectedFailure:false,run:()=>withDatabase(db=>{assert.equal(createPromesa(db,{...basePromesa(),estado:'CUMPLIDA',monto_pagado:100,fecha_pago:'2099-01-01'}).ok,false);const p=linkedPromesa(db);assert.equal(updatePromesaAtomic(db,p.id,{estado:'CUMPLIDA',monto_pagado:100,fecha_pago:'2099-01-01'}).ok,false);})},
  {id:'C3J-03',name:'bootstrap legacy histórico conserva cumplimiento',expectedFailure:false,run:()=>withDatabase(db=>{const r=migrateLegacyPromises(db,'localStorage:cartera_promesas_locales',[{...basePromesa(),legacy_id:'bootstrap',estado:'CUMPLIDA',monto_pagado:100}]);assert.equal(r.ok,true);assert.equal(listPromesas(db)[0]?.estado,'CUMPLIDA');})},
  {id:'C3J-04',name:'bootstrap legacy repetido es idempotente',expectedFailure:false,run:()=>withDatabase(db=>{const value={...basePromesa(),legacy_id:'bootstrap-twice'};migrateLegacyPromises(db,'localStorage:cartera_promesas_locales',[value]);migrateLegacyPromises(db,'localStorage:cartera_promesas_locales',[value]);assert.equal(listPromesas(db).length,1);})},
  {id:'C3J-05',name:'cobro del mismo día no cumple',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db);db.prepare("UPDATE promesas SET creado_en='2026-08-22 17:00:00',cumplimiento_automatico_desde='2026-08-22 17:00:00' WHERE id=?").run(p.id);importedCobro(db,'same-day','FAC-I',100,'2026-08-22');reconcilePromises(db);assert.equal(getPromesaById(db,p.id)?.monto_pagado,0);})},
  {id:'C3J-06',name:'cobro del día siguiente cumple',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db);db.prepare("UPDATE promesas SET creado_en='2026-08-22 17:00:00',cumplimiento_automatico_desde='2026-08-22 17:00:00' WHERE id=?").run(p.id);importedCobro(db,'next-day','FAC-I',100,'2026-08-23');reconcilePromises(db);assert.equal(getPromesaById(db,p.id)?.estado,'CUMPLIDA');})},
  {id:'C3J-07',name:'cobro del día anterior no cumple',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db);db.prepare("UPDATE promesas SET creado_en='2026-08-22 17:00:00',cumplimiento_automatico_desde='2026-08-22 17:00:00' WHERE id=?").run(p.id);importedCobro(db,'previous-day','FAC-I',100,'2026-08-21');reconcilePromises(db);assert.equal(getPromesaById(db,p.id)?.monto_pagado,0);})},
  {id:'C3J-08',name:'atribución histórica existente permanece',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db);importedCobro(db,'historical','FAC-I',40,'2026-08-22');db.prepare("INSERT INTO promesa_cobro_atribuciones(promesa_id,movement_key,importe_atribuido,documento_normalizado) VALUES(?,?,?,?)").run(p.id,'historical',40,'FAC-I');db.prepare("UPDATE promesas SET monto_pagado=40,estado='CUMPLIDA_PARCIAL',fecha_pago='2026-08-22',cumplimiento_automatico_desde='2026-08-22 17:00:00' WHERE id=?").run(p.id);reconcilePromises(db);assert.equal(getPromesaById(db,p.id)?.monto_pagado,40);assert.equal((db.prepare("SELECT count(*) n FROM promesa_cobro_atribuciones WHERE movement_key='historical'").get() as any).n,1);})},
  {id:'C3J-09',name:'cobro antes de cartera queda pendiente',expectedFailure:false,run:()=>{const ctx=createScenarioContext('c3j09');try{const doc='001-001-000000901';ensureScenarioDocument(ctx,doc,'CLIENTE-P',100,1);const p=createPromesa(ctx.db,{...basePromesa(),documentos:[{documento_normalizado:normalized(doc)}]});if(!p.ok)throw new Error(p.message);importCollection(ctx,'c3j09-cobro',doc,100,{date:'2099-01-01'});assert.equal((ctx.db.prepare("SELECT estado_conciliacion FROM cobros_movimientos_importados").get() as any).estado_conciliacion,'PENDIENTE_CONCILIACION');}finally{ctx.close();}}},
  {id:'C3J-10',name:'cartera posterior concilia y actualiza promesa',expectedFailure:false,run:()=>{const ctx=createScenarioContext('c3j10');try{const doc='001-001-000000902';ensureScenarioDocument(ctx,doc);const p=createPromesa(ctx.db,{...basePromesa(),documentos:[{documento_normalizado:normalized(doc)}]});if(!p.ok)throw new Error(p.message);importCollection(ctx,'c3j10-cobro',doc,100,{date:'2099-01-01'});importPortfolio(ctx,'c3j10-cartera',[{document:doc,balance:100}]);assert.equal((ctx.db.prepare("SELECT estado_conciliacion FROM cobros_movimientos_importados").get() as any).estado_conciliacion,'CONCILIADO');assert.equal(getPromesaById(ctx.db,p.promesa.id)?.estado,'CUMPLIDA');}finally{ctx.close();}}},
  {id:'C3J-11',name:'cartera cumple sin reimportar cobro',expectedFailure:false,run:()=>{const ctx=createScenarioContext('c3j11');try{const doc='001-001-000000903';ensureScenarioDocument(ctx,doc);const p=createPromesa(ctx.db,{...basePromesa(),documentos:[{documento_normalizado:normalized(doc)}]});if(!p.ok)throw new Error(p.message);importCollection(ctx,'c3j11-cobro',doc,100,{date:'2099-01-01'});importPortfolio(ctx,'c3j11-cartera',[{document:doc,balance:100}]);assert.equal((ctx.db.prepare('SELECT count(*) n FROM cobros_movimientos_importados').get() as any).n,1);assert.equal(getPromesaById(ctx.db,p.promesa.id)?.monto_pagado,100);}finally{ctx.close();}}},
  {id:'C3J-12',name:'reimportar cartera no duplica atribución ni eventos',expectedFailure:false,run:()=>{const ctx=createScenarioContext('c3j12');try{const doc='001-001-000000904';ensureScenarioDocument(ctx,doc);const p=createPromesa(ctx.db,{...basePromesa(),documentos:[{documento_normalizado:normalized(doc)}]});if(!p.ok)throw new Error(p.message);importCollection(ctx,'c3j12-cobro',doc,100,{date:'2099-01-01'});importPortfolio(ctx,'c3j12-cartera-a',[{document:doc,balance:100}]);const before=(ctx.db.prepare('SELECT count(*) n FROM promesa_eventos WHERE promesa_id=?').get(p.promesa.id) as any).n;importPortfolio(ctx,'c3j12-cartera-b',[{document:doc,balance:100}]);assert.equal((ctx.db.prepare('SELECT count(*) n FROM promesa_cobro_atribuciones').get() as any).n,1);assert.equal((ctx.db.prepare('SELECT count(*) n FROM promesa_eventos WHERE promesa_id=?').get(p.promesa.id) as any).n,before);}finally{ctx.close();}}},
  {id:'C3J-13',name:'editar 500 asignado a 450 se rechaza',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,{...basePromesa(),monto_prometido:500,documentos:[{documento_normalizado:'A',monto_comprometido:250},{documento_normalizado:'B',monto_comprometido:250}]});if(!r.ok)throw new Error(r.message);const x=updatePromesaAtomic(db,r.promesa.id,{monto_prometido:450});assert.equal(x.ok,false);if(!x.ok)assert.equal(x.code,'PROMESA_DOCUMENT_ALLOCATION_MISMATCH');})},
  {id:'C3J-14',name:'editar 500 asignado a 1000 se rechaza',expectedFailure:false,run:()=>withDatabase(db=>{const r=createPromesa(db,{...basePromesa(),monto_prometido:500,documentos:[{documento_normalizado:'A',monto_comprometido:500}]});if(!r.ok)throw new Error(r.message);assert.equal(updatePromesaAtomic(db,r.promesa.id,{monto_prometido:1000}).ok,false);})},
  {id:'C3J-15',name:'editar por debajo del cumplimiento se rechaza',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db,'FAC-I',500);importedCobro(db,'paid-400','FAC-I',400);reconcilePromises(db);assert.equal(updatePromesaAtomic(db,p.id,{monto_prometido:300}).ok,false);assert.equal(getPromesaById(db,p.id)?.monto_prometido,500);})},
  {id:'C3J-16',name:'modo no asignado permite editar monto coherente',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db,'FAC-I',500);const x=updatePromesaAtomic(db,p.id,{monto_prometido:600});assert.equal(x.ok,true);assert.equal(getPromesaById(db,p.id)?.monto_prometido,600);})},
  {id:'C3J-17',name:'mezcla explícito y NULL se rechaza',expectedFailure:false,run:()=>withDatabase(db=>{assert.throws(()=>createPromesa(db,{...basePromesa(),monto_prometido:500,documentos:[{documento_normalizado:'A',monto_comprometido:500},{documento_normalizado:'B'}]}),/Documentos de promesa inválidos/);assert.equal(listPromesas(db).length,0);})},
  {id:'C3J-18',name:'parcial puede cancelarse conservando cumplimiento',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db,'FAC-I',500);importedCobro(db,'cancel-partial','FAC-I',200);reconcilePromises(db);assert.equal(changePromesaState(db,p.id,'CANCELADA').ok,true);assert.equal(getPromesaById(db,p.id)?.monto_pagado,200);assert.equal((db.prepare('SELECT count(*) n FROM promesa_cobro_atribuciones WHERE promesa_id=?').get(p.id) as any).n,1);})},
  {id:'C3J-19',name:'parcial puede reprogramarse conservando cumplimiento',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db,'FAC-I',500);importedCobro(db,'reprogram-partial','FAC-I',200);reconcilePromises(db);assert.equal(changePromesaState(db,p.id,'REPROGRAMADA').ok,true);assert.equal(getPromesaById(db,p.id)?.monto_pagado,200);})},
  {id:'C3J-20',name:'cancelada parcial no consume cobro posterior',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db,'FAC-I',500);importedCobro(db,'cancel-first','FAC-I',200);reconcilePromises(db);changePromesaState(db,p.id,'CANCELADA');importedCobro(db,'cancel-later','FAC-I',300,'2099-01-02');reconcilePromises(db);assert.equal(getPromesaById(db,p.id)?.monto_pagado,200);})},
  {id:'C3J-21',name:'reprogramada parcial no consume cobro posterior',expectedFailure:false,run:()=>withDatabase(db=>{const p=linkedPromesa(db,'FAC-I',500);importedCobro(db,'reprogram-first','FAC-I',200);reconcilePromises(db);changePromesaState(db,p.id,'REPROGRAMADA');importedCobro(db,'reprogram-later','FAC-I',300,'2099-01-02');reconcilePromises(db);assert.equal(getPromesaById(db,p.id)?.monto_pagado,200);})},
  {id:'C3K-01',name:'bootstrap inicial migra y crea marca durable',expectedFailure:false,run:()=>withDatabase(db=>{const result=bootstrapLegacyPromises(db,[{...basePromesa(),legacy_id:'k-initial'}]);assert.equal(result.ok,true);assert.equal(isPromiseLegacyBootstrapClosed(db),true);assert.equal(listPromesas(db).length,1);assert.ok(db.prepare('SELECT completed_at FROM app_migrations WHERE key=?').get(PROMISE_LEGACY_BOOTSTRAP_KEY));})},
  {id:'C3K-02',name:'reinicio no repite bootstrap',expectedFailure:false,run:()=>withDatabase((db,file)=>{const value={...basePromesa(),legacy_id:'k-restart'};bootstrapLegacyPromises(db,[value]);db.close();const reopened=new Database(file);try{const result=bootstrapLegacyPromises(reopened,[value]);assert.equal(result.ok&&result.alreadyClosed,true);assert.equal(listPromesas(reopened).length,1);}finally{reopened.close();}})},
  {id:'C3K-03',name:'nuevo legacy después de CLOSED se ignora',expectedFailure:false,run:()=>withDatabase(db=>{bootstrapLegacyPromises(db,[{...basePromesa(),legacy_id:'k-original'}]);const result=bootstrapLegacyPromises(db,[{...basePromesa(),legacy_id:'k-new'}]);assert.equal(result.ok&&result.alreadyClosed,true);assert.equal(listPromesas(db).length,1);})},
  {id:'C3K-04',name:'legacy CUMPLIDA malicioso tras CLOSED se ignora',expectedFailure:false,run:()=>withDatabase(db=>{bootstrapLegacyPromises(db,[]);const result=bootstrapLegacyPromises(db,[{...basePromesa(),legacy_id:'k-malicious',estado:'CUMPLIDA',monto_pagado:100,fecha_pago:'2099-01-01'}]);assert.equal(result.ok&&result.alreadyClosed,true);assert.equal(listPromesas(db).length,0);})},
  {id:'C3K-05',name:'marca CLOSED sobrevive reinicio',expectedFailure:false,run:()=>withDatabase((db,file)=>{bootstrapLegacyPromises(db,[]);db.close();const reopened=new Database(file);try{assert.equal(isPromiseLegacyBootstrapClosed(reopened),true);assert.equal(bootstrapLegacyPromises(reopened,[{...basePromesa(),legacy_id:'k-after-restart'}]).ok,true);assert.equal(listPromesas(reopened).length,0);}finally{reopened.close();}})},
  {id:'C3K-06',name:'fallo antes de marca revierte bootstrap completo',expectedFailure:false,run:()=>withDatabase(db=>{db.exec("CREATE TRIGGER fail_bootstrap_mark BEFORE INSERT ON app_migrations BEGIN SELECT RAISE(ABORT,'mark failed'); END");assert.throws(()=>bootstrapLegacyPromises(db,[{...basePromesa(),legacy_id:'k-fail'}]),/mark failed/);assert.equal(isPromiseLegacyBootstrapClosed(db),false);assert.equal(listPromesas(db).length,0);assert.equal((db.prepare('SELECT count(*) n FROM promesa_legacy_migrations').get() as any).n,0);})},
  {id:'C3K-07',name:'retry posterior migra una vez y cierra',expectedFailure:false,run:()=>withDatabase(db=>{const value={...basePromesa(),legacy_id:'k-retry'};db.exec("CREATE TRIGGER fail_bootstrap_mark BEFORE INSERT ON app_migrations BEGIN SELECT RAISE(ABORT,'mark failed'); END");assert.throws(()=>bootstrapLegacyPromises(db,[value]),/mark failed/);db.exec('DROP TRIGGER fail_bootstrap_mark');const result=bootstrapLegacyPromises(db,[value]);assert.equal(result.ok,true);assert.equal(isPromiseLegacyBootstrapClosed(db),true);assert.equal(listPromesas(db).length,1);})},
  {id:'C3K-08',name:'invocación interna directa tras CLOSED no crea datos',expectedFailure:false,run:()=>withDatabase(db=>{bootstrapLegacyPromises(db,[]);const before=(db.prepare('SELECT count(*) n FROM promesa_eventos').get() as any).n;const result=bootstrapLegacyPromises(db,[{...basePromesa(),legacy_id:'k-direct',estado:'CUMPLIDA',monto_pagado:100}]);assert.equal(result.ok&&result.alreadyClosed,true);assert.equal(listPromesas(db).length,0);assert.equal((db.prepare('SELECT count(*) n FROM promesa_eventos').get() as any).n,before);})},
  {id:'C3K-09',name:'restore pre-CLOSED permite bootstrap una vez',expectedFailure:false,run:()=>withDatabase((db,file)=>{db.close();const restored=new Database(file);try{assert.equal(isPromiseLegacyBootstrapClosed(restored),false);const result=bootstrapLegacyPromises(restored,[{...basePromesa(),legacy_id:'k-pre-restore'}]);assert.equal(result.ok&&!result.alreadyClosed,true);assert.equal(listPromesas(restored).length,1);assert.equal(isPromiseLegacyBootstrapClosed(restored),true);}finally{restored.close();}})},
  {id:'C3K-10',name:'restore post-CLOSED no reabre bootstrap',expectedFailure:false,run:()=>withDatabase((db,file)=>{bootstrapLegacyPromises(db,[{...basePromesa(),legacy_id:'k-post-original'}]);db.close();const restored=new Database(file);try{const result=bootstrapLegacyPromises(restored,[{...basePromesa(),legacy_id:'k-post-new'}]);assert.equal(result.ok&&result.alreadyClosed,true);assert.equal(listPromesas(restored).length,1);}finally{restored.close();}})},
  {id:'C3K-11',name:'legacy posterior no genera mapping',expectedFailure:false,run:()=>withDatabase(db=>{bootstrapLegacyPromises(db,[]);bootstrapLegacyPromises(db,[{...basePromesa(),legacy_id:'k-no-mapping'}]);assert.equal((db.prepare("SELECT count(*) n FROM promesa_legacy_migrations WHERE legacy_id='k-no-mapping'").get() as any).n,0);})},
  {id:'C3K-12',name:'tras CLOSED sólo COBRO conciliado cumple',expectedFailure:false,run:()=>withDatabase(db=>{bootstrapLegacyPromises(db,[]);assert.equal(createPromesa(db,{...basePromesa(),estado:'CUMPLIDA',monto_pagado:100}).ok,false);const p=linkedPromesa(db);importedCobro(db,'k-real-payment');reconcilePromises(db);assert.equal(getPromesaById(db,p.id)?.estado,'CUMPLIDA');})},
  {id:'C3L-01',name:'gestionGuardar Promesa Cumplida crea sólo gestión',expectedFailure:false,run:()=>withDatabase(db=>{const gestion=db.transaction(()=>createGestion(db,baseGestion({resultado:'Promesa Cumplida',fecha_promesa:'2027-01-01',monto_promesa:999})))();assert.equal(getGestionById(db,gestion.id!)?.resultado,'Promesa Cumplida');assert.equal(listPromesas(db).length,0);})},
  {id:'C3L-02',name:'promesasListar no convierte Promesa Cumplida',expectedFailure:false,run:()=>withDatabase(db=>{createGestion(db,baseGestion({resultado:'Promesa Cumplida',fecha_promesa:'2027-01-01',monto_promesa:999}));migrateHistoricalPromises(db);assert.equal(listPromesas(db).length,0);})},
  {id:'C3L-03',name:'reinicio no convierte Promesa Cumplida',expectedFailure:false,run:()=>withDatabase((db,file)=>{createGestion(db,baseGestion({resultado:'Promesa Cumplida',fecha_promesa:'2027-01-01',monto_promesa:999}));db.close();const reopened=new Database(file);try{assert.equal(migrateHistoricalPromises(reopened),0);assert.equal(listPromesas(reopened).length,0);}finally{reopened.close();}})},
  {id:'C3L-04',name:'migración histórica repetida ignora Promesa Cumplida',expectedFailure:false,run:()=>withDatabase(db=>{createGestion(db,baseGestion({resultado:'Promesa Cumplida',fecha_promesa:'2027-01-01',monto_promesa:999}));for(let i=0;i<5;i++)assert.equal(migrateHistoricalPromises(db),0);assert.equal(listPromesas(db).length,0);})},
  {id:'C3L-05',name:'Promesa de Pago origina PENDIENTE',expectedFailure:false,run:()=>withDatabase(db=>{const gestion=createGestion(db,baseGestion({resultado:'Promesa de Pago',fecha_promesa:'2027-01-01',monto_promesa:125}));assert.equal(migrateHistoricalPromises(db),1);const promise=listPromesas(db)[0]!;assert.equal(promise.gestion_id,gestion.id);assert.equal(promise.estado,'PENDIENTE');assert.equal(promise.origen,'MIGRATED_GESTION');})},
  {id:'C3L-06',name:'promesa desde gestión nace sin cumplimiento',expectedFailure:false,run:()=>withDatabase(db=>{createGestion(db,baseGestion({resultado:'Promesa de Pago',fecha_promesa:'2027-01-01',monto_promesa:125}));migrateHistoricalPromises(db);const promise=listPromesas(db)[0]!;assert.equal(promise.monto_pagado,0);assert.equal(promise.fecha_pago,null);})},
  {id:'C3L-07',name:'gestión legacy cumplida no genera promesa',expectedFailure:false,run:()=>withDatabase(db=>{const result=migrateLegacyGestiones(db,'legacy',[{...baseGestion({resultado:'Promesa Cumplida',fecha_promesa:'2027-01-01',monto_promesa:999}),legacy_id:'c3l-legacy-fulfilled'}]);assert.equal(result.ok,true);assert.equal(migrateHistoricalPromises(db),0);assert.equal(listPromesas(db).length,0);})},
  {id:'C3L-08',name:'gestión legacy Promesa de Pago origina PENDIENTE',expectedFailure:false,run:()=>withDatabase(db=>{const result=migrateLegacyGestiones(db,'legacy',[{...baseGestion({resultado:'Promesa de Pago',fecha_promesa:'2027-01-01',monto_promesa:125}),legacy_id:'c3l-legacy-pending'}]);assert.equal(result.ok,true);assert.equal(migrateHistoricalPromises(db),1);const promise=listPromesas(db)[0]!;assert.equal(promise.estado,'PENDIENTE');assert.equal(promise.monto_pagado,0);})},
  {id:'C3L-09',name:'IPC manipulado Promesa Cumplida no crea fila cumplida',expectedFailure:false,run:()=>withDatabase(db=>{const main=fs.readFileSync(path.resolve('electron/main.ts'),'utf8');assert.match(main,/data\?\.resultado === "Promesa de Pago"/);createGestion(db,baseGestion({resultado:'Promesa Cumplida',fecha_promesa:'2027-01-01',monto_promesa:999}));migrateHistoricalPromises(db);assert.equal((db.prepare("SELECT count(*) n FROM promesas WHERE estado IN ('CUMPLIDA','CUMPLIDA_PARCIAL')").get() as any).n,0);})},
  {id:'C3L-10',name:'IPC legacy cumplida más reinicio no fabrica pago',expectedFailure:false,run:()=>withDatabase((db,file)=>{migrateLegacyGestiones(db,'renderer',[{...baseGestion({resultado:'Promesa Cumplida',fecha_promesa:'2027-01-01',monto_promesa:999}),legacy_id:'c3l-renderer'}]);db.close();const reopened=new Database(file);try{migrateHistoricalPromises(reopened);assert.equal(listPromesas(reopened).length,0);assert.equal((reopened.prepare('SELECT count(*) n FROM promesa_cobro_atribuciones').get() as any).n,0);}finally{reopened.close();}})},
  {id:'C3L-11',name:'COBRO conciliado conserva cumplimiento válido',expectedFailure:false,run:()=>withDatabase(db=>{const promise=linkedPromesa(db);importedCobro(db,'c3l-valid-payment');assert.equal(reconcilePromises(db),1);assert.equal(getPromesaById(db,promise.id)?.estado,'CUMPLIDA');})},
  {id:'C3L-12',name:'cumplimiento histórico persistido no se degrada',expectedFailure:false,run:()=>withDatabase(db=>{const gestion=createGestion(db,baseGestion({resultado:'Promesa Cumplida',fecha_promesa:'2020-01-01',monto_promesa:80}));db.prepare("INSERT INTO promesas(cliente,gestion_id,fecha_promesa,monto_prometido,monto_pagado,estado,fecha_pago,origen,monto_cumplido_base) VALUES(?,?,?,?,?,'CUMPLIDA',?,'MIGRATED_GESTION',?)").run(gestion.cliente,gestion.id,'2020-01-01',80,80,'2020-01-02',80);assert.equal(migrateHistoricalPromises(db),0);const promise=listPromesas(db)[0]!;assert.equal(promise.estado,'CUMPLIDA');assert.equal(promise.monto_pagado,80);assert.equal(promise.fecha_pago,'2020-01-02');})},
];

type Result = {
  id: string;
  scenario: string;
  status: "PASS" | "EXPECTED FAIL" | "UNEXPECTED FAIL";
  detail: string;
};

const results: Result[] = [];

for (const scenario of scenarios) {
  try {
    scenario.run();
    results.push({
      id: scenario.id,
      scenario: scenario.name,
      status: "PASS",
      detail: scenario.expectedFailure
        ? "El comportamiento deseado ya se cumple; revisar y retirar la expectativa en C2."
        : "Comportamiento actual conforme a la baseline C1.",
    });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({
      id: scenario.id,
      scenario: scenario.name,
      status: scenario.expectedFailure ? "EXPECTED FAIL" : "UNEXPECTED FAIL",
      detail: scenario.expectedFailure ? `${scenario.defect} | ${detail}` : detail,
    });
  }
}

const totals = {
  PASS: results.filter((item) => item.status === "PASS").length,
  EXPECTED_FAIL: results.filter((item) => item.status === "EXPECTED FAIL").length,
  UNEXPECTED_FAIL: results.filter((item) => item.status === "UNEXPECTED FAIL").length,
};

console.log("\nZENITH CARTERA - C1 BASELINE DE PERSISTENCIA CRM\n");
console.table(results);
console.log("CRM_INTEGRATION_RESULT_JSON=" + JSON.stringify({ totals, results }));

if (totals.UNEXPECTED_FAIL > 0) process.exitCode = 1;
