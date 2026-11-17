/**
 * Generic SQLite CRUD helpers. This is the ONLY place (besides lib/db.js) that
 * may build SQL for the application: later tasks call these helpers instead of
 * writing their own queries.
 *
 * Table names are checked against the authoritative `TABLES` list from
 * lib/db.js, and column names are checked against the live table schema, so
 * neither a caller-supplied table nor a typo'd column can alter a statement.
 * Filter text (`whereSql`) is intentionally a trusted SQL fragment supplied by
 * our own handlers — never pass raw user input into it; use `?` placeholders
 * via `params` instead.
 *
 * Invalid input fails as a 400-free-of-SQL-details error: raw SQLite messages
 * (e.g. "NOT NULL constraint failed") must not leak through the router as 500s.
 */
import { TABLES } from './db.js';

const ALLOWED_TABLES = new Set(TABLES);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A client/developer input error: safe to echo, mapped to HTTP 400. */
function badRequest(message) {
  return Object.assign(new TypeError(message), { status: 400 });
}

function assertTable(table) {
  if (typeof table !== 'string' || !ALLOWED_TABLES.has(table)) {
    throw badRequest(`Unknown table: ${String(table)}`);
  }
}

function assertData(db, table, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw badRequest('data must be a plain object');
  }
  // PRAGMA reads the schema that lib/db.js defined, so this list never drifts.
  const columns = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name),
  );
  for (const column of Object.keys(data)) {
    if (!IDENTIFIER.test(column)) throw badRequest(`Invalid column name: ${column}`);
    if (!columns.has(column)) throw badRequest(`Unknown column for ${table}: ${column}`);
  }
}

/**
 * SQLite's schema/constraint messages are internal details. Convert the
 * data-related ones to a safe 400. UNIQUE is deliberately NOT mapped here:
 * api/employees.js turns that specific case into a meaningful 409 instead.
 */
const BAD_DATA_SQL =
  /NOT NULL constraint failed|CHECK constraint failed|datatype mismatch|no such column|has no column named/i;

function mapSqlError(error, table) {
  const message = String(error?.message ?? '');
  return BAD_DATA_SQL.test(message) ? badRequest(`Invalid data for ${table}`) : error;
}

/** Run a statement, converting bad-data SQLite failures into clean 400s. */
function safely(db, table, operation) {
  try {
    return operation();
  } catch (error) {
    throw mapSqlError(error, table);
  }
}

/** node:sqlite cannot bind undefined; store it as SQL NULL instead. */
function sqlValue(value) {
  return value === undefined ? null : value;
}

/** Insert a row and return its numeric id. */
export function insertRow(db, table, data) {
  assertTable(table);
  assertData(db, table, data);
  return safely(db, table, () => {
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
  });
}

/** Return the row with the given id, or null when it does not exist. */
export function getRow(db, table, id) {
  assertTable(table);
  return safely(db, table, () =>
    db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) ?? null,
  );
}

/** Return all matching rows. `whereSql` is a trusted fragment; use `?` params. */
export function listRows(db, table, whereSql = '1=1', params = []) {
  assertTable(table);
  if (!Array.isArray(params)) throw badRequest('params must be an array');
  const clause = typeof whereSql === 'string' && whereSql.trim() ? whereSql : '1=1';
  return safely(db, table, () =>
    db.prepare(`SELECT * FROM ${table} WHERE ${clause}`).all(...params),
  );
}

/** Update the row with the given id; true when at least one row changed. */
export function updateRow(db, table, id, data) {
  assertTable(table);
  assertData(db, table, data);
  const columns = Object.keys(data);
  if (columns.length === 0) return false;
  return safely(db, table, () => {
    const assignments = columns.map((column) => `${column} = ?`).join(', ');
    const info = db
      .prepare(`UPDATE ${table} SET ${assignments} WHERE id = ?`)
      .run(...columns.map((column) => sqlValue(data[column])), id);
    return info.changes > 0;
  });
}

/** Delete the row with the given id; true when a row was actually removed. */
export function deleteRow(db, table, id) {
  assertTable(table);
  return safely(db, table, () =>
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes > 0,
  );
}
