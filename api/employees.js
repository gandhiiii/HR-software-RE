/**
 * Employee management and organisation reference-list routes.
 *
 * All routes declare an explicit `['admin', 'hr']` roles array — there is no
 * implicit public access, and the employee role is deliberately excluded from
 * HR management endpoints. Every database access goes through lib/repo.js.
 */
import { requireFields, isIsoDate, isNonNegativeNumber } from '../lib/validate.js';
import { insertRow, getRow, listRows, updateRow, deleteRow } from '../lib/repo.js';

const HR_ROLES = ['admin', 'hr'];

// Only these keys are ever written to the employees table. Unknown body keys
// are ignored so a client cannot influence the generated SQL.
const EMPLOYEE_FIELDS = [
  'code',
  'name',
  'email',
  'phone',
  'department_id',
  'designation_id',
  'shift_id',
  'joining_date',
  'status',
  'basic',
  'hra',
  'allowances',
  'bank_account',
];
const MONEY_FIELDS = ['basic', 'hra', 'allowances'];
// `status` is TEXT NOT NULL in the schema; null/blank/invalid values must be
// rejected here rather than becoming a raw SQLite 500 (or a stored empty value).
const EMPLOYEE_STATUSES = new Set(['active', 'inactive']);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function pick(source, fields) {
  const result = {};
  for (const field of fields) {
    if (source && Object.prototype.hasOwnProperty.call(source, field)) {
      result[field] = source[field];
    }
  }
  return result;
}

function idFrom(value) {
  const id = Number(value);
  return Number.isInteger(id) ? id : -1;
}

function validateEmployeeData(data, { partial = false } = {}) {
  if (!partial) requireFields(data, ['code', 'name', 'joining_date']);
  if (data.joining_date !== undefined && !isIsoDate(data.joining_date)) {
    throw httpError(400, 'joining_date must be a valid ISO date (YYYY-MM-DD)');
  }
  for (const field of MONEY_FIELDS) {
    if (data[field] !== undefined && !isNonNegativeNumber(data[field])) {
      throw httpError(400, `${field} must be a non-negative number`);
    }
  }
  if (data.status !== undefined && !EMPLOYEE_STATUSES.has(data.status)) {
    throw httpError(400, `status must be one of: ${[...EMPLOYEE_STATUSES].join(', ')}`);
  }
}

/** Translate a UNIQUE violation into a clean 409 instead of a raw 500. */
function withoutUniqueErrors(operation) {
  try {
    return operation();
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(error?.message ?? '')) {
      throw httpError(409, 'Employee code already exists');
    }
    throw error;
  }
}

/** `?department=` accepts either a numeric department_id or a department name. */
function resolveDepartmentId(db, value) {
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const matches = listRows(db, 'departments', 'name = ?', [text]);
  return matches.length > 0 ? matches[0].id : null;
}

/** Register the employee CRUD endpoints. */
export function registerEmployeeRoutes(router) {
  router.register('POST', '/api/employees', HR_ROLES, async ({ db, body }) => {
    const data = pick(body, EMPLOYEE_FIELDS);
    validateEmployeeData(data);
    const id = withoutUniqueErrors(() => insertRow(db, 'employees', data));
    return { status: 201, body: getRow(db, 'employees', id) };
  });

  router.register('GET', '/api/employees', HR_ROLES, async ({ db, query }) => {
    const clauses = [];
    const params = [];
    if (query.status !== undefined && query.status !== '') {
      clauses.push('status = ?');
      params.push(query.status);
    }
    if (query.department !== undefined && query.department !== '') {
      const departmentId = resolveDepartmentId(db, query.department);
      if (departmentId === null) return { status: 200, body: [] };
      clauses.push('department_id = ?');
      params.push(departmentId);
    }
    const whereSql = clauses.length > 0 ? clauses.join(' AND ') : '1=1';
    return { status: 200, body: listRows(db, 'employees', whereSql, params) };
  });

  router.register('GET', '/api/employees/:id', HR_ROLES, async ({ db, params }) => {
    const row = getRow(db, 'employees', idFrom(params.id));
    if (!row) throw httpError(404, 'Employee not found');
    return { status: 200, body: row };
  });

  router.register('PATCH', '/api/employees/:id', HR_ROLES, async ({ db, params, body }) => {
    const id = idFrom(params.id);
    if (!getRow(db, 'employees', id)) throw httpError(404, 'Employee not found');
    const data = pick(body, EMPLOYEE_FIELDS);
    validateEmployeeData(data, { partial: true });
    if (Object.keys(data).length > 0) {
      withoutUniqueErrors(() => updateRow(db, 'employees', id, data));
    }
    return { status: 200, body: getRow(db, 'employees', id) };
  });

  router.register('DELETE', '/api/employees/:id', HR_ROLES, async ({ db, params }) => {
    if (!deleteRow(db, 'employees', idFrom(params.id))) {
      throw httpError(404, 'Employee not found');
    }
    return { status: 200, body: { ok: true } };
  });
}

/** Register the organisation reference lists (departments and designations). */
export function registerOrgRoutes(router) {
  router.register('GET', '/api/departments', HR_ROLES, async ({ db }) => ({
    status: 200,
    body: listRows(db, 'departments'),
  }));

  router.register('GET', '/api/designations', HR_ROLES, async ({ db }) => ({
    status: 200,
    body: listRows(db, 'designations'),
  }));
}
