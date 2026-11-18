/**
 * Biometric device registry and employee mapping routes.
 *
 * HR/admin maintain the device registry (create, list, read, update, delete)
 * and the map between a device's own user ids and HRMS employees. Employees
 * are never allowed to read or change either registry.
 *
 * Devices are configured for one of three ingestion modes (offline import,
 * HTTP push or polling). A freshly registered device always receives a random
 * 24-byte `push_token`, which is the only credential a push device needs for
 * the public webhook and which cannot be set by a client.
 *
 * Request bodies use camelCase keys (the convention across the API); response
 * bodies for devices are also camelCase even though the database columns are
 * snake_case. Mapping rows are returned verbatim (snake_case), matching the
 * other join-table endpoints such as `/api/assets/:id/history`.
 *
 * All persistence goes through lib/repo.js and every route declares an
 * explicit roles array, so neither SQL nor authorization is left implicit.
 */
import { randomBytes } from 'node:crypto';
import { getRow, listRows, insertRow, updateRow, deleteRow } from '../lib/repo.js';
import { verifyPassword } from '../lib/auth.js';
import { requireFields } from '../lib/validate.js';
import { parsePunchText } from '../lib/calc/biometric.js';
import {
  ingestPunches,
  resolvePunchEmployees,
  commitPending,
} from '../lib/biometric-ingest.js';

const HR_ROLES = ['admin', 'hr'];

/** Mapping of accepted camelCase request keys to real `biometric_devices` columns. */
const DEVICE_FIELDS = {
  name: 'name',
  vendor: 'vendor',
  model: 'model',
  deviceType: 'device_type',
  serialNumber: 'serial_number',
  ipAddress: 'ip_address',
  port: 'port',
  location: 'location',
  ingestionMode: 'ingestion_mode',
  adapter: 'adapter',
  pushSecretHash: 'push_secret_hash',
  pollEndpoint: 'poll_endpoint',
  pollHeadersJson: 'poll_headers_json',
  pollIntervalSeconds: 'poll_interval_seconds',
  autoCommit: 'auto_commit',
  enabled: 'enabled',
};

const DEVICE_STRING_COLUMNS = [
  'vendor', 'model', 'device_type', 'ip_address', 'location', 'ingestion_mode',
  'adapter', 'push_secret_hash', 'poll_endpoint', 'poll_headers_json',
];

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * Strict positive-integer id: only real numbers or numeric strings are allowed.
 * Bare Number() would accept booleans, arrays and floats, which could silently
 * land on an unrelated device or employee.
 */
function positiveId(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** SQLite-style UTC timestamp (datetime('now') produces the same shape). */
function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** Resolve a device id from a path param, or throw 400/404. Returns the raw row. */
function getDeviceOr404(db, rawId) {
  const id = positiveId(rawId);
  if (id === null) throw httpError(400, 'Device id must be a positive integer');
  const device = getRow(db, 'biometric_devices', id);
  if (!device) throw httpError(404, 'Device not found');
  return { id, device };
}

/** Resolve an employee id and confirm the employee exists. */
function resolveEmployeeId(value) {
  const id = positiveId(value);
  if (id === null) throw httpError(400, 'employeeId must be a positive integer');
  return id;
}

function assertEmployeeExists(db, id) {
  if (!getRow(db, 'employees', id)) throw httpError(404, 'Employee not found');
}

/** True for a SQLite UNIQUE violation, which the router would otherwise 500. */
function isUniqueViolation(error) {
  const message = String(error?.message ?? '');
  return /UNIQUE constraint failed/i.test(message) ||
    String(error?.code ?? '').startsWith('SQLITE_CONSTRAINT_UNIQUE');
}

/** Translate a UNIQUE violation into a 409; rethrow everything else untouched. */
function rethrowConflict(error, message) {
  if (isUniqueViolation(error)) throw httpError(409, message);
  throw error;
}

/** Pick known camelCase device fields and rename them to DB columns. */
function pickDeviceColumns(body) {
  const result = {};
  for (const [key, column] of Object.entries(DEVICE_FIELDS)) {
    if (body && Object.prototype.hasOwnProperty.call(body, key)) {
      result[column] = body[key];
    }
  }
  return result;
}

/** Booleans are not valid SQLite bind values; store them as 0/1 integers. */
function normalizeFlag(value) {
  if (value === true) return 1;
  if (value === false) return 0;
  return value;
}

function normalizeDeviceData(data) {
  const result = {};
  for (const [column, value] of Object.entries(data)) {
    result[column] = column === 'auto_commit' || column === 'enabled'
      ? normalizeFlag(value)
      : value;
  }
  return result;
}

function validateDeviceData(data, { partial = false } = {}) {
  for (const column of ['name', 'serial_number']) {
    if (data[column] === undefined && partial) continue;
    if (typeof data[column] !== 'string' || data[column].trim() === '') {
      throw httpError(400, column === 'name'
        ? 'name must be a non-empty string'
        : 'serialNumber must be a non-empty string');
    }
  }
  for (const column of DEVICE_STRING_COLUMNS) {
    if (data[column] !== undefined && data[column] !== null && typeof data[column] !== 'string') {
      throw httpError(400, `${column} must be a string`);
    }
  }
  if (data.port !== undefined && data.port !== null &&
      !(Number.isInteger(data.port) && data.port > 0 && data.port <= 65535)) {
    throw httpError(400, 'port must be an integer between 1 and 65535');
  }
  if (data.poll_interval_seconds !== undefined && data.poll_interval_seconds !== null &&
      !(Number.isInteger(data.poll_interval_seconds) && data.poll_interval_seconds >= 0)) {
    throw httpError(400, 'pollIntervalSeconds must be a non-negative integer');
  }
  for (const column of ['auto_commit', 'enabled']) {
    if (data[column] !== undefined && data[column] !== null &&
        data[column] !== 0 && data[column] !== 1) {
      throw httpError(400, `${column} must be 0 or 1`);
    }
  }
}

/** Render a device row with camelCase keys for API consumers. */
function presentDevice(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    vendor: row.vendor,
    model: row.model,
    deviceType: row.device_type,
    serialNumber: row.serial_number,
    ipAddress: row.ip_address,
    port: row.port,
    location: row.location,
    ingestionMode: row.ingestion_mode,
    adapter: row.adapter,
    pushToken: row.push_token,
    pushSecretHash: row.push_secret_hash,
    pollEndpoint: row.poll_endpoint,
    pollHeadersJson: row.poll_headers_json,
    pollIntervalSeconds: row.poll_interval_seconds,
    autoCommit: row.auto_commit,
    enabled: row.enabled,
    lastSeenAt: row.last_seen_at,
    lastSyncAt: row.last_sync_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Device registry
// ---------------------------------------------------------------------------

function listDevices(db) {
  const rows = listRows(db, 'biometric_devices', '1=1');
  return { status: 200, body: rows.map(presentDevice) };
}

function createDevice(db, body) {
  requireFields(body, ['name', 'serialNumber']);
  const data = normalizeDeviceData(pickDeviceColumns(body));
  validateDeviceData(data);

  let id;
  try {
    id = insertRow(db, 'biometric_devices', {
      name: data.name.trim(),
      serial_number: data.serial_number.trim(),
      vendor: data.vendor ?? 'generic',
      model: data.model ?? null,
      device_type: data.device_type ?? 'fingerprint',
      ip_address: data.ip_address ?? null,
      port: data.port ?? null,
      location: data.location ?? null,
      ingestion_mode: data.ingestion_mode ?? 'offline',
      adapter: data.adapter ?? 'generic_json',
      push_token: randomBytes(24).toString('hex'),
      push_secret_hash: data.push_secret_hash ?? null,
      poll_endpoint: data.poll_endpoint ?? null,
      poll_headers_json: data.poll_headers_json ?? null,
      poll_interval_seconds: data.poll_interval_seconds ?? 60,
      auto_commit: data.auto_commit ?? 0,
      enabled: data.enabled ?? 1,
    });
  } catch (error) {
    rethrowConflict(error, 'A device with this serial number already exists');
  }
  return { status: 201, body: presentDevice(getRow(db, 'biometric_devices', id)) };
}

function getDevice(db, rawId) {
  const { device } = getDeviceOr404(db, rawId);
  return { status: 200, body: presentDevice(device) };
}

function updateDevice(db, rawId, body) {
  const { id } = getDeviceOr404(db, rawId);
  const data = normalizeDeviceData(pickDeviceColumns(body));
  validateDeviceData(data, { partial: true });
  if (data.name !== undefined) data.name = data.name.trim();
  if (data.serial_number !== undefined) data.serial_number = data.serial_number.trim();
  if (Object.keys(data).length > 0) {
    try {
      updateRow(db, 'biometric_devices', id, { ...data, updated_at: nowSql() });
    } catch (error) {
      rethrowConflict(error, 'A device with this serial number already exists');
    }
  }
  return { status: 200, body: presentDevice(getRow(db, 'biometric_devices', id)) };
}

function deleteDevice(db, rawId) {
  const { id } = getDeviceOr404(db, rawId);
  // No FK cascade exists, so remove mappings first to avoid orphaned rows.
  for (const mapping of listRows(db, 'biometric_employee_map', 'device_id = ?', [id])) {
    deleteRow(db, 'biometric_employee_map', mapping.id);
  }
  deleteRow(db, 'biometric_devices', id);
  return { status: 200, body: { ok: true } };
}

// ---------------------------------------------------------------------------
// Employee-to-device-user mappings
// ---------------------------------------------------------------------------

function listMappings(db, rawId) {
  const { id } = getDeviceOr404(db, rawId);
  const rows = listRows(db, 'biometric_employee_map', 'device_id = ?', [id]);
  return { status: 200, body: rows };
}

function addMapping(db, rawId, body) {
  const { id: deviceId } = getDeviceOr404(db, rawId);
  requireFields(body, ['employeeId', 'deviceUserId']);
  const employeeId = resolveEmployeeId(body.employeeId);
  assertEmployeeExists(db, employeeId);

  let deviceUserId = body.deviceUserId;
  if (typeof deviceUserId === 'number' && Number.isFinite(deviceUserId)) {
    deviceUserId = String(deviceUserId);
  }
  if (typeof deviceUserId !== 'string' || deviceUserId.trim() === '') {
    throw httpError(400, 'deviceUserId must be a non-empty string');
  }

  let mappingId;
  try {
    mappingId = insertRow(db, 'biometric_employee_map', {
      device_id: deviceId,
      employee_id: employeeId,
      device_user_id: deviceUserId.trim(),
    });
  } catch (error) {
    rethrowConflict(error, 'Device user or employee is already mapped on this device');
  }
  // Any punches that arrived before the mapping existed can now be resolved.
  resolvePunchEmployees(db, deviceId);
  return { status: 201, body: getRow(db, 'biometric_employee_map', mappingId) };
}

function deleteMapping(db, rawId, rawMappingId) {
  const { id: deviceId } = getDeviceOr404(db, rawId);
  const mappingId = positiveId(rawMappingId);
  if (mappingId === null) throw httpError(400, 'Mapping id must be a positive integer');
  const mapping = getRow(db, 'biometric_employee_map', mappingId);
  if (!mapping || mapping.device_id !== deviceId) throw httpError(404, 'Mapping not found');
  deleteRow(db, 'biometric_employee_map', mappingId);
  return { status: 200, body: { ok: true } };
}

// ---------------------------------------------------------------------------
// Ingest (offline import), punch review and attendance commit
// ---------------------------------------------------------------------------

const PUNCH_FORMATS = new Set(['csv', 'tsv', 'zkteco', 'json']);

/** Resolve a punch id from a path param, or throw 400/404. */
function getPunchOr404(db, rawId) {
  const id = positiveId(rawId);
  if (id === null) throw httpError(400, 'Punch id must be a positive integer');
  const punch = getRow(db, 'biometric_punches', id);
  if (!punch) throw httpError(404, 'Punch not found');
  return { id, punch };
}

/** Offline import: parse text, ingest rows, and record the sync run. */
function importPunches(db, body) {
  requireFields(body, ['deviceId', 'format', 'text']);
  const { device } = getDeviceOr404(db, body.deviceId);
  const format = String(body.format).toLowerCase();
  if (!PUNCH_FORMATS.has(format)) throw httpError(400, `Unsupported punch format: ${body.format}`);
  if (typeof body.text !== 'string') throw httpError(400, 'text must be a string');

  const { rows, errors: parseErrors } = parsePunchText(body.text, format);
  const autoCommit = device.auto_commit === 1 || device.auto_commit === true;
  const result = ingestPunches(db, device, rows, 'import', { autoCommit });
  // Surface parse-time rejections alongside normalization/DB errors.
  result.errors = [...parseErrors, ...result.errors];
  return { status: 201, body: result };
}

/** List stored punches, optionally filtered by device, status and employee. */
function listPunches(db, query) {
  const clauses = [];
  const params = [];
  if (query.deviceId !== undefined && query.deviceId !== '') {
    const id = positiveId(query.deviceId);
    if (id === null) throw httpError(400, 'deviceId must be a positive integer');
    clauses.push('device_id = ?');
    params.push(id);
  }
  if (query.status !== undefined && query.status !== '') {
    if (typeof query.status !== 'string') throw httpError(400, 'status must be a string');
    clauses.push('status = ?');
    params.push(query.status);
  }
  if (query.employeeId !== undefined && query.employeeId !== '') {
    const id = positiveId(query.employeeId);
    if (id === null) throw httpError(400, 'employeeId must be a positive integer');
    clauses.push('employee_id = ?');
    params.push(id);
  }
  const whereSql = clauses.length > 0 ? clauses.join(' AND ') : '1=1';
  return { status: 200, body: listRows(db, 'biometric_punches', whereSql, params) };
}

/** Manually assign an employee to a reviewed punch (also clears the reason). */
function mapPunch(db, rawId, body) {
  const { id } = getPunchOr404(db, rawId);
  requireFields(body, ['employeeId']);
  const employeeId = resolveEmployeeId(body.employeeId);
  assertEmployeeExists(db, employeeId);
  updateRow(db, 'biometric_punches', id, {
    employee_id: employeeId,
    status: 'pending',
    reason: null,
  });
  return { status: 200, body: getRow(db, 'biometric_punches', id) };
}

/** Reject a punch so it is never considered for commit. */
function rejectPunch(db, rawId, body) {
  const { id } = getPunchOr404(db, rawId);
  const reason = typeof body?.reason === 'string' && body.reason.trim()
    ? body.reason.trim()
    : 'rejected';
  updateRow(db, 'biometric_punches', id, { status: 'ignored', reason });
  return { status: 200, body: getRow(db, 'biometric_punches', id) };
}

/** Review-and-commit entry point. */
function commitPunches(db, body) {
  requireFields(body, ['deviceId']);
  const { id: deviceId } = getDeviceOr404(db, body.deviceId);
  return { status: 200, body: commitPending(db, { deviceId }) };
}

/** List sync-run history, optionally for one device. */
function listSyncRuns(db, query) {
  const clauses = [];
  const params = [];
  if (query.deviceId !== undefined && query.deviceId !== '') {
    const id = positiveId(query.deviceId);
    if (id === null) throw httpError(400, 'deviceId must be a positive integer');
    clauses.push('device_id = ?');
    params.push(id);
  }
  const whereSql = clauses.length > 0 ? clauses.join(' AND ') : '1=1';
  return { status: 200, body: listRows(db, 'biometric_sync_runs', whereSql, params) };
}

// ---------------------------------------------------------------------------
// Device-facing push paths (public, authenticated in-handler)
// ---------------------------------------------------------------------------

/** Plain-text response header shared by every ZKTeco ADMS reply. */
const ADMS_TEXT_HEADER = { 'Content-Type': 'text/plain; charset=utf-8' };

/** Look up a device by its unguessable push token (null when absent). */
function deviceByPushToken(db, token) {
  if (typeof token !== 'string' || token === '') return null;
  return listRows(db, 'biometric_devices', 'push_token = ?', [token])[0] ?? null;
}

/** Look up a device by the serial number a ZKTeco device reports as `SN`. */
function deviceBySerial(db, serial) {
  if (typeof serial !== 'string' || serial === '') return null;
  return listRows(db, 'biometric_devices', 'serial_number = ?', [serial])[0] ?? null;
}

/** Extract a bearer secret from an Authorization header, or null. */
function bearerSecret(headers) {
  const header = headers?.authorization ?? headers?.Authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * A device without a stored secret needs no bearer token; one with a secret
 * MUST present a matching `Bearer` token. `push_secret_hash` is `salt:hash`.
 */
function verifyDeviceSecret(device, headers) {
  const stored = device.push_secret_hash;
  if (stored === null || stored === undefined || stored === '') return true;
  const secret = bearerSecret(headers);
  if (secret === null) return false;
  const separator = stored.indexOf(':');
  if (separator <= 0 || separator === stored.length - 1) return false;
  return verifyPassword(secret, stored.slice(0, separator), stored.slice(separator + 1));
}

function deviceAutoCommit(device) {
  return device.auto_commit === 1 || device.auto_commit === true;
}

/** Generic JSON webhook: the token in the URL is the credential. */
function pushJsonBatch(db, token, body, headers) {
  const device = deviceByPushToken(db, token);
  if (!device || !verifyDeviceSecret(device, headers)) throw httpError(401, 'Invalid push token');
  const { rows } = parsePunchText(JSON.stringify(body ?? {}), 'json');
  const result = ingestPunches(db, device, rows, 'push', { autoCommit: deviceAutoCommit(device) });
  return { status: 200, body: { received: result.received, inserted: result.inserted } };
}

/** Resolve + authenticate the device behind an ADMS serial number. */
function admsDevice(db, query, headers) {
  const device = deviceBySerial(db, query?.SN);
  if (!device || !verifyDeviceSecret(device, headers)) {
    throw httpError(401, 'Invalid device serial number');
  }
  return device;
}

/** ADMS devices poll this endpoint for their configuration on startup. */
function admsOptions(db, query, headers) {
  admsDevice(db, query, headers);
  return { status: 200, body: 'GET OPTIONS\nRealtime=1\n', headers: ADMS_TEXT_HEADER };
}

/** Headerless, tab-separated ATTLOG rows: acknowledge with `OK: <inserted>`. */
function admsAttLog(db, query, body, headers) {
  const device = admsDevice(db, query, headers);
  const { rows } = parsePunchText(body, 'zkteco');
  const result = ingestPunches(db, device, rows, 'push', { autoCommit: deviceAutoCommit(device) });
  return { status: 200, body: `OK: ${result.inserted}`, headers: ADMS_TEXT_HEADER };
}

/** Maintenance replies from the ADMS handshake are plain-text `OK`. */
function admsOk() {
  return { status: 200, body: 'OK', headers: ADMS_TEXT_HEADER };
}

/** Register all biometric routes. */
export function registerBiometricRoutes(router) {
  router.register('GET', '/api/biometric/devices', HR_ROLES, async ({ db }) => listDevices(db));

  router.register('POST', '/api/biometric/devices', HR_ROLES, async ({ db, body }) =>
    createDevice(db, body),
  );

  router.register('GET', '/api/biometric/devices/:id', HR_ROLES, async ({ db, params }) =>
    getDevice(db, params.id),
  );

  router.register('PATCH', '/api/biometric/devices/:id', HR_ROLES, async ({ db, params, body }) =>
    updateDevice(db, params.id, body),
  );

  router.register('DELETE', '/api/biometric/devices/:id', HR_ROLES, async ({ db, params }) =>
    deleteDevice(db, params.id),
  );

  router.register('GET', '/api/biometric/devices/:id/mappings', HR_ROLES, async ({ db, params }) =>
    listMappings(db, params.id),
  );

  router.register('POST', '/api/biometric/devices/:id/mappings', HR_ROLES, async ({ db, params, body }) =>
    addMapping(db, params.id, body),
  );

  router.register('DELETE', '/api/biometric/devices/:id/mappings/:mappingId', HR_ROLES, async ({ db, params }) =>
    deleteMapping(db, params.id, params.mappingId),
  );

  // Offline import + sync-run history.
  router.register('POST', '/api/biometric/import', HR_ROLES, async ({ db, body }) =>
    importPunches(db, body),
  );
  router.register('GET', '/api/biometric/sync-runs', HR_ROLES, async ({ db, query }) =>
    listSyncRuns(db, query),
  );

  // Punch review queue. `commit` is registered before the :id routes for clarity.
  router.register('GET', '/api/biometric/punches', HR_ROLES, async ({ db, query }) =>
    listPunches(db, query),
  );
  router.register('POST', '/api/biometric/punches/commit', HR_ROLES, async ({ db, body }) =>
    commitPunches(db, body),
  );
  router.register('POST', '/api/biometric/punches/:id/map', HR_ROLES, async ({ db, params, body }) =>
    mapPunch(db, params.id, body),
  );
  router.register('POST', '/api/biometric/punches/:id/reject', HR_ROLES, async ({ db, params, body }) =>
    rejectPunch(db, params.id, body),
  );

  // Public device-facing push paths. They authenticate in-handler (never via
  // the session middleware) and are therefore registered with `roles: []`.
  router.register('POST', '/api/biometric/push/:token', [], async ({ db, params, body, headers }) =>
    pushJsonBatch(db, params.token, body, headers),
  );

  // ZKTeco ADMS protocol. Replies are plain text, not JSON, and the ATTLOG POST
  // opts into the router's raw-body handling so tab-separated rows survive.
  router.register('GET', '/iclock/cdata', [], async ({ db, query, headers }) =>
    admsOptions(db, query, headers),
  );
  router.register('POST', '/iclock/cdata', [], async ({ db, query, body, headers }) =>
    admsAttLog(db, query, body, headers), { rawBody: true });
  router.register('GET', '/iclock/getrequest', [], async () => admsOk());
  router.register('GET', '/iclock/ping', [], async () => admsOk());
}
