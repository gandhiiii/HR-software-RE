/**
 * Asset register and assignment routes.
 *
 * HR/admin maintain the register (create, list, read, update, delete) and are
 * the only roles allowed to assign or return an asset or read its history.
 *
 * An asset's `status` is derived from its assignment state and is managed only
 * through the assign/return endpoints: a newly created asset is `available`,
 * assigning it flips it to `assigned`, and returning it restores `available`.
 * Clients cannot set `status` through create/update, so the register cannot be
 * put into an inconsistent state (e.g. "assigned" with no active assignment).
 *
 * Every assignment (including repeated assign/return cycles) is recorded as a
 * row in `asset_assignments`; returning updates the open row rather than
 * deleting it, so the history endpoint always shows the full lifecycle.
 *
 * All persistence goes through lib/repo.js and every route declares an explicit
 * roles array, so neither SQL nor authorization is left implicit.
 */
import { requireFields, isIsoDate, isNonNegativeNumber } from '../lib/validate.js';
import { getRow, listRows, insertRow, updateRow, deleteRow } from '../lib/repo.js';

const HR_ROLES = ['admin', 'hr'];

// Real columns of the `assets` table. `status` is deliberately excluded: it is
// managed by assign/return, never accepted from a client payload.
const ASSET_FIELDS = ['name', 'type', 'serial', 'purchase_date', 'value'];

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * Strict positive-integer id: only real numbers or numeric strings are allowed.
 * Bare Number() would accept booleans (true -> 1), arrays ([1] -> 1) and floats,
 * which could silently land on an unrelated asset or employee.
 */
function positiveId(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
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

/** SQLite-style UTC timestamp (datetime('now') produces the same shape). */
function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** Resolve an asset id from a path param, or throw 400/404. */
function getAssetOr404(db, rawId) {
  const id = positiveId(rawId);
  if (id === null) throw httpError(400, 'Asset id must be a positive integer');
  const asset = getRow(db, 'assets', id);
  if (!asset) throw httpError(404, 'Asset not found');
  return { id, asset };
}

/** Validate an employee id and confirm the employee exists. */
function resolveEmployeeId(value) {
  const id = positiveId(value);
  if (id === null) throw httpError(400, 'employeeId must be a positive integer');
  return id;
}

function assertEmployeeExists(db, id) {
  if (!getRow(db, 'employees', id)) throw httpError(404, 'Employee not found');
}

function validateAssetData(data, { partial = false } = {}) {
  if (!partial) requireFields(data, ['name']);
  if (data.name !== undefined && (typeof data.name !== 'string' || data.name.trim() === '')) {
    throw httpError(400, 'name must be a non-empty string');
  }
  for (const field of ['type', 'serial']) {
    if (data[field] !== undefined && data[field] !== null && typeof data[field] !== 'string') {
      throw httpError(400, `${field} must be a string`);
    }
  }
  if (data.purchase_date !== undefined && data.purchase_date !== null && !isIsoDate(data.purchase_date)) {
    throw httpError(400, 'purchase_date must be a valid ISO date (YYYY-MM-DD)');
  }
  if (data.value !== undefined && !isNonNegativeNumber(data.value)) {
    throw httpError(400, 'value must be a non-negative number');
  }
}

// ---------------------------------------------------------------------------
// Register CRUD
// ---------------------------------------------------------------------------

function createAsset(db, body) {
  requireFields(body, ['name']);
  const data = pick(body, ASSET_FIELDS);
  validateAssetData(data);

  const id = insertRow(db, 'assets', {
    name: data.name.trim(),
    type: data.type ?? null,
    serial: data.serial ?? null,
    purchase_date: data.purchase_date ?? null,
    value: data.value ?? 0,
    status: 'available',
  });
  return { status: 201, body: getRow(db, 'assets', id) };
}

function listAssets(db, query) {
  const clauses = [];
  const params = [];
  if (query.status !== undefined && query.status !== '') {
    clauses.push('status = ?');
    params.push(query.status);
  }
  if (query.type !== undefined && query.type !== '') {
    clauses.push('type = ?');
    params.push(query.type);
  }
  const rows = listRows(db, 'assets', clauses.length > 0 ? clauses.join(' AND ') : '1=1', params);
  return { status: 200, body: rows };
}

function updateAsset(db, rawId, body) {
  const { id } = getAssetOr404(db, rawId);
  // Status is excluded on purpose — only assign/return may change it.
  const data = pick(body, ASSET_FIELDS);
  validateAssetData(data, { partial: true });
  if (data.name !== undefined) data.name = data.name.trim();
  if (Object.keys(data).length > 0) updateRow(db, 'assets', id, data);
  return { status: 200, body: getRow(db, 'assets', id) };
}

function deleteAsset(db, rawId) {
  const { id } = getAssetOr404(db, rawId);
  // asset_assignments has no FK / ON DELETE CASCADE, so remove history first to
  // avoid orphaned rows that could never be reached through the asset again.
  for (const assignment of listRows(db, 'asset_assignments', 'asset_id = ?', [id])) {
    deleteRow(db, 'asset_assignments', assignment.id);
  }
  deleteRow(db, 'assets', id);
  return { status: 200, body: { ok: true } };
}

// ---------------------------------------------------------------------------
// Assignment lifecycle
// ---------------------------------------------------------------------------

function assignAsset(db, rawId, body) {
  const { id, asset } = getAssetOr404(db, rawId);
  if (asset.status !== 'available') {
    throw httpError(409, 'Asset is not available for assignment');
  }

  // Accept `employeeId` (the convention used by the other API modules) with an
  // `employee_id` alias for convenience.
  const supplied = body?.employeeId ?? body?.employee_id;
  const employeeId = resolveEmployeeId(supplied);
  assertEmployeeExists(db, employeeId);

  const assignmentId = insertRow(db, 'asset_assignments', {
    asset_id: id,
    employee_id: employeeId,
    assigned_at: nowSql(),
    status: 'assigned',
  });
  updateRow(db, 'assets', id, { status: 'assigned' });
  return { status: 201, body: getRow(db, 'asset_assignments', assignmentId) };
}

function returnAsset(db, rawId) {
  const { id, asset } = getAssetOr404(db, rawId);
  if (asset.status !== 'assigned') {
    throw httpError(409, 'Asset is not currently assigned');
  }

  const active = listRows(db, 'asset_assignments', 'asset_id = ? AND status = ?', [id, 'assigned']);
  if (active.length === 0) {
    throw httpError(409, 'No active assignment to return');
  }
  // There is normally a single open assignment; choose the newest defensively.
  const assignment = active[active.length - 1];

  updateRow(db, 'asset_assignments', assignment.id, {
    status: 'returned',
    returned_at: nowSql(),
  });
  updateRow(db, 'assets', id, { status: 'available' });
  return { status: 200, body: getRow(db, 'asset_assignments', assignment.id) };
}

function assetHistory(db, rawId) {
  const { id } = getAssetOr404(db, rawId);
  const rows = listRows(db, 'asset_assignments', 'asset_id = ?', [id]);
  // listRows has no ORDER BY; id is insertion order, so sort newest-first for a
  // useful history view.
  rows.sort((a, b) => b.id - a.id);
  return { status: 200, body: rows };
}

/** Register all asset routes. */
export function registerAssetRoutes(router) {
  router.register('POST', '/api/assets', HR_ROLES, async ({ db, body }) => createAsset(db, body));

  router.register('GET', '/api/assets', HR_ROLES, async ({ db, query }) => listAssets(db, query));

  router.register('GET', '/api/assets/:id', HR_ROLES, async ({ db, params }) => {
    const { asset } = getAssetOr404(db, params.id);
    return { status: 200, body: asset };
  });

  router.register('PATCH', '/api/assets/:id', HR_ROLES, async ({ db, params, body }) =>
    updateAsset(db, params.id, body),
  );

  router.register('DELETE', '/api/assets/:id', HR_ROLES, async ({ db, params }) =>
    deleteAsset(db, params.id),
  );

  router.register('POST', '/api/assets/:id/assign', HR_ROLES, async ({ db, params, body }) =>
    assignAsset(db, params.id, body),
  );

  router.register('POST', '/api/assets/:id/return', HR_ROLES, async ({ db, params }) =>
    returnAsset(db, params.id),
  );

  router.register('GET', '/api/assets/:id/history', HR_ROLES, async ({ db, params }) =>
    assetHistory(db, params.id),
  );
}
