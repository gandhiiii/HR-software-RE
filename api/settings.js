/**
 * Settings and holiday management routes.
 *
 * Settings are the 18 real keys seeded by lib/db.js: `GET` returns a key/value
 * map and `PATCH` validates and updates only those existing keys, so a typo
 * cannot create a stray setting. Numeric rate keys accept non-negative numbers
 * (Task 6 reads them on every payroll run), time keys accept HH:MM and the
 * remaining keys accept strings. All updates are validated before any write.
 *
 * Holidays support plain CRUD for HR/admin. Every route declares an explicit
 * roles array and all persistence goes through lib/repo.js.
 */
import { requireFields, isIsoDate } from '../lib/validate.js';
import { getRow, listRows, insertRow, updateRow, deleteRow } from '../lib/repo.js';

const HR_ROLES = ['admin', 'hr'];

const NUMERIC_KEYS = new Set([
  'working_days_per_month', 'pf_rate', 'pf_ceiling', 'esic_rate', 'esic_ceiling',
  'professional_tax', 'income_tax_rate', 'overtime_cap_minutes',
  'overtime_multiplier', 'grace_minutes', 'weekly_off_day',
]);
const TIME_KEYS = new Set(['shift_start_time', 'shift_end_time']);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/** Strict positive-integer id: numbers and numeric strings only. */
function positiveId(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Flatten the settings table into a key -> value map (via repo helpers). */
function settingsMap(db) {
  const map = {};
  for (const row of listRows(db, 'settings')) map[row.key] = row.value;
  return map;
}

function settingRow(db, key) {
  return listRows(db, 'settings', 'key = ?', [key])[0] ?? null;
}

/**
 * Accept a key/value map as the primary form, plus a few harmless equivalents
 * (`{settings: {...}}`, a single `{key, value}` pair or an array of pairs) so a
 * caller cannot accidentally 400 on the payload shape.
 */
function normalisePatchBody(body) {
  if (Array.isArray(body)) {
    const map = {};
    for (const item of body) {
      if (!item || typeof item !== 'object' || typeof item.key !== 'string') {
        throw httpError(400, 'expected an array of {key, value} objects');
      }
      map[item.key] = item.value;
    }
    return map;
  }
  if (!body || typeof body !== 'object') {
    throw httpError(400, 'settings body must be an object of key/value pairs');
  }
  if (body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)) {
    return body.settings;
  }
  if (typeof body.key === 'string' && Object.prototype.hasOwnProperty.call(body, 'value')) {
    return { [body.key]: body.value };
  }
  return body;
}

/** Validate the whole patch first, then write every key (all-or-nothing). */
function patchSettings(db, rawBody) {
  const body = normalisePatchBody(rawBody);
  const known = new Set(listRows(db, 'settings').map((row) => row.key));
  const updates = {};

  for (const [key, value] of Object.entries(body)) {
    if (!known.has(key)) throw httpError(400, `Unknown setting: ${key}`);
    if (NUMERIC_KEYS.has(key)) {
      if (typeof value !== 'number' && typeof value !== 'string') {
        throw httpError(400, `${key} must be a non-negative number`);
      }
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) {
        throw httpError(400, `${key} must be a non-negative number`);
      }
      updates[key] = String(number);
    } else if (TIME_KEYS.has(key)) {
      if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        throw httpError(400, `${key} must be a valid HH:MM time`);
      }
      updates[key] = value;
    } else {
      if (typeof value !== 'string') throw httpError(400, `${key} must be a string`);
      updates[key] = value;
    }
  }

  for (const [key, value] of Object.entries(updates)) {
    const row = settingRow(db, key);
    if (row) updateRow(db, 'settings', row.id, { value });
  }
  return { status: 200, body: settingsMap(db) };
}

function listHolidays(db, query) {
  const clauses = [];
  const params = [];
  for (const [key, op] of [['from', '>='], ['to', '<=']]) {
    if (query[key] !== undefined && query[key] !== '') {
      if (!isIsoDate(query[key])) throw httpError(400, `${key} must be a valid ISO date`);
      clauses.push(`date ${op} ?`);
      params.push(query[key]);
    }
  }
  const rows = listRows(db, 'holidays', clauses.length > 0 ? clauses.join(' AND ') : '1=1', params);
  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { status: 200, body: rows };
}

function createHoliday(db, body) {
  requireFields(body, ['date']);
  if (!isIsoDate(body.date)) {
    throw httpError(400, 'date must be a valid ISO date (YYYY-MM-DD)');
  }
  const name = body.name ?? null;
  if (name !== null && typeof name !== 'string') throw httpError(400, 'name must be a string');
  if (listRows(db, 'holidays', 'date = ?', [body.date]).length > 0) {
    throw httpError(409, 'A holiday already exists for this date');
  }
  const id = insertRow(db, 'holidays', { date: body.date, name });
  return { status: 201, body: getRow(db, 'holidays', id) };
}

function deleteHoliday(db, rawId) {
  const id = positiveId(rawId);
  if (id === null) throw httpError(400, 'Holiday id must be a positive integer');
  if (!getRow(db, 'holidays', id)) throw httpError(404, 'Holiday not found');
  deleteRow(db, 'holidays', id);
  return { status: 200, body: { ok: true } };
}

/** Delete by date as a convenience alternative to DELETE /holidays/:id. */
function deleteHolidayByDate(db, date) {
  if (typeof date !== 'string' || date === '') {
    throw httpError(400, 'date is required');
  }
  const rows = listRows(db, 'holidays', 'date = ?', [date]);
  if (rows.length === 0) throw httpError(404, 'Holiday not found');
  for (const row of rows) deleteRow(db, 'holidays', row.id);
  return { status: 200, body: { ok: true } };
}

/** Register all settings and holiday routes. */
export function registerSettingsRoutes(router) {
  router.register('GET', '/api/settings', HR_ROLES, async ({ db }) => ({
    status: 200,
    body: settingsMap(db),
  }));

  router.register('PATCH', '/api/settings', HR_ROLES, async ({ db, body }) =>
    patchSettings(db, body),
  );

  router.register('GET', '/api/settings/holidays', HR_ROLES, async ({ db, query }) =>
    listHolidays(db, query),
  );

  router.register('POST', '/api/settings/holidays', HR_ROLES, async ({ db, body }) =>
    createHoliday(db, body),
  );

  router.register('DELETE', '/api/settings/holidays', HR_ROLES, async ({ db, query, body }) => {
    const rawId = query.id ?? body?.id;
    if (rawId !== undefined && rawId !== '') return deleteHoliday(db, rawId);
    return deleteHolidayByDate(db, query.date ?? body?.date);
  });

  router.register('DELETE', '/api/settings/holidays/:id', HR_ROLES, async ({ db, params }) =>
    deleteHoliday(db, params.id),
  );
}
