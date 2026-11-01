import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createPromesa, getPromesaById, reconcilePromises, updatePromesaAtomic } from '../../electron/repositories/promesaRepository';

const SCHEMA = `
CREATE TABLE documentos(id INTEGER PRIMARY KEY,cliente TEXT NOT NULL,razon_social TEXT,documento TEXT,documento_normalizado TEXT NOT NULL,total REAL DEFAULT 0,valor_documento REAL DEFAULT 0,cobros REAL DEFAULT 0,is_subtotal INTEGER DEFAULT 0);
CREATE TABLE gestiones(id INTEGER PRIMARY KEY,cliente TEXT NOT NULL);
CREATE TABLE promesas(id INTEGER PRIMARY KEY AUTOINCREMENT,cliente TEXT NOT NULL,gestion_id INTEGER NULL UNIQUE,documento_id INTEGER NULL,fecha_promesa TEXT NOT NULL,monto_prometido REAL NOT NULL,monto_pagado REAL NOT NULL DEFAULT 0,estado TEXT NOT NULL,fecha_pago TEXT NULL,motivo_incumplimiento TEXT NULL,observacion TEXT NULL,origen TEXT NOT NULL DEFAULT 'NATIVE',monto_cumplido_base REAL NOT NULL DEFAULT 0,cumplimiento_automatico_desde TEXT NULL,creado_en TEXT NOT NULL DEFAULT(datetime('now','localtime')),actualizado_en TEXT NULL);
CREATE TABLE promesa_documentos(promesa_id INTEGER NOT NULL,documento_normalizado TEXT NOT NULL,monto_comprometido REAL,creado_en TEXT NOT NULL DEFAULT(datetime('now','localtime')),PRIMARY KEY(promesa_id,documento_normalizado));
CREATE TABLE promesa_eventos(id INTEGER PRIMARY KEY AUTOINCREMENT,promesa_id INTEGER NOT NULL,tipo_evento TEXT NOT NULL,estado_anterior TEXT NULL,estado_nuevo TEXT NULL,fecha TEXT NOT NULL DEFAULT(datetime('now','localtime')),metadata TEXT NOT NULL DEFAULT '{}');
CREATE TABLE cobros_movimientos_importados(id INTEGER PRIMARY KEY,movimiento_key TEXT NOT NULL UNIQUE,fecha_movimiento TEXT,documento_relacionado_normalizado TEXT,valor REAL NOT NULL,clase_movimiento TEXT NOT NULL,estado_conciliacion TEXT NOT NULL);
CREATE TABLE promesa_cobro_atribuciones(promesa_id INTEGER NOT NULL,movement_key TEXT NOT NULL,importe_atribuido REAL NOT NULL,documento_normalizado TEXT NOT NULL,PRIMARY KEY(promesa_id,movement_key));
CREATE TABLE notas_credito_importadas(id INTEGER PRIMARY KEY,documento_relacionado_normalizado TEXT,total_nc REAL NOT NULL,estado_conciliacion TEXT NOT NULL);
`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-promesa-docs-'));
const file = path.join(root, 'promesas.sqlite');
const db = new Database(file);
db.exec(SCHEMA);

function insertDocument(id:number, client:string, normalized:string):void { db.prepare('INSERT INTO documentos(id,cliente,razon_social,documento,documento_normalizado,total,valor_documento) VALUES(?,?,?,?,?,?,?)').run(id,client,client,normalized,normalized,100,100); }
function documentsFor(database:Database.Database,id:number):string[] { return (database.prepare('SELECT documento_normalizado FROM promesa_documentos WHERE promesa_id=? ORDER BY documento_normalizado').pluck().all(id) as string[]); }
function base(documentos?:Array<{documento_normalizado:string;monto_comprometido?:number|null}>){return {cliente:'ACME',fecha_promesa:'2026-12-01',monto_prometido:100,documentos};}

try {
  insertDocument(1,'ACME','FAC-A');
  insertDocument(2,'ACME','FAC-C');
  insertDocument(3,'OTRO','FAC-B');
  insertDocument(4,'ACME','FAC-D');
  insertDocument(5,'OTRO','FAC-D');

  const created = createPromesa(db, base([{documento_normalizado:'FAC-A',monto_comprometido:100}]));
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error(created.message);
  const id = created.promesa.id;
  assert.deepEqual(documentsFor(db,id), ['FAC-A']);

  const before = db.prepare('SELECT * FROM promesas WHERE id=?').get(id);
  assert.equal(createPromesa(db, base([{documento_normalizado:'FAC-B',monto_comprometido:100}])).ok, false);
  assert.equal(createPromesa(db, base([{documento_normalizado:'NO-EXISTE',monto_comprometido:100}])).ok, false);
  assert.equal(createPromesa(db, base([{documento_normalizado:'FAC-D',monto_comprometido:100}])).ok, false);
  assert.equal(createPromesa(db, base([{documento_normalizado:'FAC-A'},{documento_normalizado:'FAC-A'}])).ok, false);
  assert.deepEqual(db.prepare('SELECT * FROM promesas WHERE id=?').get(id), before);
  assert.deepEqual(documentsFor(db,id), ['FAC-A']);

  const invalidReplacement = updatePromesaAtomic(db,id,{documentos:[{documento_normalizado:'FAC-B',monto_comprometido:100}]});
  assert.equal(invalidReplacement.ok, false);
  assert.deepEqual(documentsFor(db,id), ['FAC-A']);
  assert.deepEqual(db.prepare('SELECT * FROM promesas WHERE id=?').get(id), before);

  const replaced = updatePromesaAtomic(db,id,{documentos:[{documento_normalizado:'FAC-C',monto_comprometido:100}]});
  assert.equal(replaced.ok, true);
  assert.deepEqual(documentsFor(db,id), ['FAC-C']);

  db.close();
  const reopened = new Database(file);
  try { assert.deepEqual(documentsFor(reopened,id), ['FAC-C']); assert.equal(getPromesaById(reopened,id)?.documentos?.[0]?.documento_normalizado,'FAC-C'); }
  finally { reopened.close(); }

  const financialBefore = new Database(file);
  financialBefore.prepare("INSERT INTO cobros_movimientos_importados VALUES(1,'RET-1','2026-11-02','FAC-C',25,'RETENCION','CONCILIADO')").run();
  financialBefore.prepare("INSERT INTO notas_credito_importadas VALUES(1,'FAC-C',20,'CONCILIADA')").run();
  const promesaBefore = financialBefore.prepare('SELECT * FROM promesas WHERE id=?').get(id);
  reconcilePromises(financialBefore);
  assert.deepEqual(financialBefore.prepare('SELECT * FROM promesas WHERE id=?').get(id), promesaBefore);
  assert.equal(createPromesa(financialBefore,{...base(),estado:'CUMPLIDA'}).ok,false);
  financialBefore.close();
  const finalDb = new Database(file);
  assert.deepEqual(documentsFor(finalDb,id), ['FAC-C']);
  finalDb.close();
  console.log('PROMESA_DOCUMENT_ASSOCIATIONS_RESULT_JSON=' + JSON.stringify({status:'PASS'}));
} finally {
  if (db.open) db.close();
  fs.rmSync(root,{recursive:true,force:true});
}
