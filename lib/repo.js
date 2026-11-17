/**
 * Generic SQLite CRUD helpers. This is the ONLY place (besides lib/db.js) that
 * may build SQL for the application: later tasks call these helpers instead of
 * writing their own queries.
 *
 * Table names are checked against the authoritative `TABLES` list from
 * lib/db.js, and column names must be plain identifiers, so no caller-supplied
 * string can alter the shape of a statement. Filter text (`whereSql`) is
 * intentionally a trusted SQL fragment supplied by our own handlers — never
 * pass raw user input into it; use `?` placeholders via `params` instead.
 */
import { TABLES } from './db.js';

const ALLOWED_TABLES = new Set(TABLES);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertTable(table) {
  if (typeof table !== 'string' || !ALLOWED_TABLES.has(table)) {
    throw new TypeError(`Unknown table: ${String(table)}`);
  }
}

function assertData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('data must be a plain object');
  }
  for (const column of Object.keys(data)) {
    if (!IDENTIFIER.test(column)) throw new TypeError(`Invalid column name: ${column}`);
  }
}

/** node:sqlite cannot bind undefined; store it as SQL NULL instead. */
function sqlValue(value) {
  return value === undefined ? null : value;
}

/** Insert a row and return its numeric id. */
export function insertRow(db, table, data) {
  assertTable(table);
  assertData(data);
  const columns = Object.keys(data);
  let info;
  if (columns.length === 0) {
    info = db.prepare(`INSERT INTO ${table} DEFAULT VALUES`).run();
  } else {
    const names = columns.join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    info = db
      .prepare(`INSERT INTO ${table} (${names}) VALUES (${placeholders})`)
      .run(...columns.map((column) => sqlValue(data[column])));
  }
  return Number(info.lastInsertRowid);
}

/** Return the row with the given id, or null when it does not exist. */
export function getRow(db, table, id) {
  assertTable(table);
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) ?? null;
}

/** Return all matching rows. `whereSql` is a trusted fragment; use `?` params. */
export function listRows(db, table, whereSql = '1=1', params = []) {
  assertTable(table);
  if (!Array.isArray(params)) throw new TypeError('params must be an array');
  const clause = typeof whereSql === 'string' && whereSql.trim() ? whereSql : '1=1';
  return db.prepare(`SELECT * FROM ${table} WHERE ${clause}`).all(...params);
}

/** Update the row with the given id; true when at least one row changed. */
export function updateRow(db, table, id, data) {
  assertTable(table);
  assertData(data);
  const columns = Object.keys(data);
  if (columns.length === 0) return false;
  const assignments = columns.map((column) => `${column} = ?`).join(', ');
  const info = db
    .prepare(`UPDATE ${table} SET ${assignments} WHERE id = ?`)
    .run(...columns.map((column) => sqlValue(data[column])), id);
  return info.changes > 0;
}

/** Delete the row with the given id; true when a row was actually removed. */
export function deleteRow(db, table, id) {
  assertTable(table);
  return db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes > 0;
}
