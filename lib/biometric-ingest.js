/**
 * Shared biometric ingest, offline import and non-destructive attendance commit.
 *
 * This module owns everything that touches `biometric_punches` /
 * `biometric_sync_runs`. Parsing and pairing stay in the pure
 * `lib/calc/biometric.js` module; attendance derivation stays in the single
 * exported `recordAttendance` helper from `api/attendance.js`. Nothing here
 * reimplements either of those rule sets.
 *
 * Design rules:
 *  - Ingest never throws on a bad row: normalization/DB failures are collected
 *    in `errors` so the rest of the batch still lands.
 *  - A UNIQUE violation on `dedupe_key` is a duplicate, not an error.
 *  - Unmapped device users are stored `pending` / `reason='unmapped_user'`;
 *    they are re-resolved lazily once a mapping appears.
 *  - Commit NEVER overwrites an existing attendance row: the whole group is
 *    marked `ignored` / `existing_attendance` instead.
 *  - Bad pairs (unpaired punches) are skipped with a reason; other groups in
 *    the same batch still commit.
 */
import { listRows, insertRow, updateRow } from './repo.js';
import { normalizePunch, pairPunches } from './calc/biometric.js';
import { recordAttendance } from '../api/attendance.js';

/** SQLite-style UTC timestamp (same shape as datetime('now')). */
function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** True for a UNIQUE constraint violation, which the repo leaves untouched. */
function isUniqueViolation(error) {
  const message = String(error?.message ?? '');
  return /UNIQUE constraint failed/i.test(message) ||
    String(error?.code ?? '').startsWith('SQLITE_CONSTRAINT_UNIQUE');
}

/** Group key used to scope auto-commit to the employee/day just ingested. */
function groupKey(employeeId, date) {
  return `${employeeId ?? ''}\u0000${date}`;
}

function dateOf(punch) {
  return String(punch?.punched_at ?? '').slice(0, 10);
}

function emptyOutcome() {
  return { committed: 0, ignored: 0, skipped: 0, errors: 0 };
}

/** Write one punch's review status/reason. Missing ids (never persisted) are no-ops. */
function markPunch(db, id, status, reason) {
  if (id === undefined || id === null) return;
  updateRow(db, 'biometric_punches', id, { status, reason: reason ?? null });
}

/**
 * Map every device user id on a device to its employee id, in one query.
 */
function mappingByUser(db, deviceId) {
  const map = new Map();
  for (const mapping of listRows(db, 'biometric_employee_map', 'device_id = ?', [deviceId])) {
    map.set(String(mapping.device_user_id), mapping.employee_id);
  }
  return map;
}

/**
 * Persist one attendance group through the shared recorder, then mark its
 * punches accordingly. Mutates and returns `outcome`.
 */
function commitGroup(db, group, outcome) {
  const employeeId = group.employee_id;
  if (employeeId === null || employeeId === undefined) {
    for (const id of group.punch_ids) {
      markPunch(db, id, 'ignored', 'unmapped_user');
      outcome.skipped += 1;
    }
    return;
  }

  // Non-destructive: a manual (or earlier) attendance row wins. Never upsert.
  const existing = listRows(db, 'attendance', 'employee_id = ? AND date = ?', [
    employeeId,
    group.date,
  ]);
  if (existing.length > 0) {
    for (const id of group.punch_ids) {
      markPunch(db, id, 'ignored', 'existing_attendance');
      outcome.ignored += 1;
    }
    return;
  }

  try {
    recordAttendance(db, {
      employeeId,
      date: group.date,
      punchIn: group.punch_in,
      punchOut: group.punch_out,
    });
    for (const id of group.punch_ids) {
      markPunch(db, id, 'committed', null);
      outcome.committed += 1;
    }
  } catch (error) {
    // A bad group must not abort the rest of the batch.
    const reason = `commit_failed: ${error?.message ?? 'unknown error'}`;
    for (const id of group.punch_ids) {
      markPunch(db, id, 'ignored', reason);
      outcome.errors += 1;
    }
  }
}

/**
 * Pair and commit an in-memory set of punches.
 *
 * @param {object} db
 * @param {Array<object>} punches DB punch rows (with `id`, `employee_id`, ...).
 * @param {object} [options]
 * @param {boolean} [options.onlyCompletePairs] skip groups lacking an out punch
 * @param {Set<string>|null} [options.affectedKeys] when set, only touch these
 *   employee/day groups (used by auto-commit to leave unrelated pending data)
 * @returns {{committed:number, ignored:number, skipped:number, errors:number}}
 */
function commitPunches(db, punches, { onlyCompletePairs = false, affectedKeys = null } = {}) {
  const outcome = emptyOutcome();

  // Pair per device so two devices sharing an employee can never be merged into
  // one (employee, date) group by the pure pairing engine.
  const byDevice = new Map();
  for (const punch of punches) {
    if (!punch || punch.id === undefined || punch.id === null) continue;
    const deviceKey = String(punch.device_id);
    if (!byDevice.has(deviceKey)) byDevice.set(deviceKey, []);
    byDevice.get(deviceKey).push(punch);
  }

  for (const devicePunches of byDevice.values()) {
    const { groups, unpaired } = pairPunches(devicePunches);

    for (const { punch, reason } of unpaired) {
      const key = groupKey(punch.employee_id, dateOf(punch));
      if (affectedKeys && !affectedKeys.has(key)) continue;
      markPunch(db, punch.id, 'ignored', reason || 'unpaired');
      outcome.skipped += 1;
    }

    for (const group of groups) {
      const key = groupKey(group.employee_id, group.date);
      if (affectedKeys && !affectedKeys.has(key)) continue;
      // auto_commit is commit-on-complete-pair: a lone in keeps waiting.
      if (onlyCompletePairs && !(group.punch_in && group.punch_out)) continue;
      commitGroup(db, group, outcome);
    }
  }
  return outcome;
}

/**
 * Ingest parsed rows for one device.
 *
 * @param {object} db
 * @param {object} device a `biometric_devices` row (uses `id`, `auto_commit`)
 * @param {Array<object>} rows canonical rows from `parsePunchText`
 * @param {string} source e.g. 'import' | 'push' | 'poll'
 * @param {object} [options]
 * @param {boolean} [options.autoCommit] commit complete pairs immediately
 * @returns {{received:number, inserted:number, duplicates:number,
 *            unmapped:number, errors:Array<object>}}
 */
export function ingestPunches(db, device, rows, source, { autoCommit = false } = {}) {
  const result = { received: 0, inserted: 0, duplicates: 0, unmapped: 0, errors: [] };
  const input = Array.isArray(rows) ? rows : [];
  result.received = input.length;

  const mappings = mappingByUser(db, device.id);
  const insertedPunches = [];

  for (const row of input) {
    const normalized = normalizePunch(row, device.id, source);
    if (normalized.error || !normalized.punch) {
      result.errors.push({
        message: normalized.error?.message ?? 'Normalization failed',
        raw: row,
      });
      continue;
    }
    const punch = normalized.punch;
    const employeeId = mappings.get(punch.device_user_id) ?? null;

    try {
      const id = insertRow(db, 'biometric_punches', {
        ...punch,
        employee_id: employeeId,
        status: 'pending',
        reason: employeeId === null ? 'unmapped_user' : null,
      });
      insertedPunches.push({ ...punch, id, employee_id: employeeId });
      result.inserted += 1;
      if (employeeId === null) result.unmapped += 1;
    } catch (error) {
      if (isUniqueViolation(error)) {
        result.duplicates += 1;
      } else {
        result.errors.push({ message: error?.message ?? 'Insert failed', raw: row });
      }
    }
  }

  // One sync-run record per ingest, even for an empty or fully duplicate batch.
  const startedAt = nowSql();
  try {
    insertRow(db, 'biometric_sync_runs', {
      device_id: device.id,
      source,
      started_at: startedAt,
      finished_at: nowSql(),
      status: 'completed',
      received: result.received,
      inserted: result.inserted,
      duplicates: result.duplicates,
      rejected: result.errors.length,
      error: null,
    });
  } catch (error) {
    result.errors.push({ message: `sync-run write failed: ${error?.message ?? 'unknown'}` });
  }

  if (autoCommit && insertedPunches.length > 0) {
    const affectedKeys = new Set(
      insertedPunches.map((punch) => groupKey(punch.employee_id, dateOf(punch))),
    );
    // Include all pending punches on the device so a previously lone in can be
    // completed by an out in this batch — but only commit the affected groups.
    const pending = listRows(db, 'biometric_punches',
      "device_id = ? AND status = 'pending'", [device.id]);
    commitPunches(db, pending, { onlyCompletePairs: true, affectedKeys });
  }

  return result;
}

/**
 * Re-resolve pending, unmapped punches on a device after mappings change.
 *
 * @returns {{resolved:number}}
 */
export function resolvePunchEmployees(db, deviceId) {
  const mappings = mappingByUser(db, deviceId);
  const pending = listRows(
    db,
    'biometric_punches',
    "device_id = ? AND status = 'pending' AND (employee_id IS NULL OR reason = 'unmapped_user')",
    [deviceId],
  );
  let resolved = 0;
  for (const punch of pending) {
    const employeeId = mappings.get(String(punch.device_user_id));
    if (employeeId === undefined || employeeId === null) continue;
    updateRow(db, 'biometric_punches', punch.id, {
      employee_id: employeeId,
      status: 'pending',
      reason: null,
    });
    resolved += 1;
  }
  return { resolved };
}

/**
 * Review and commit pending punches into attendance.
 *
 * Supported filters (all optional): `deviceId`, `employeeId`, `date`,
 * `status` (default `pending`), `punchIds`, `onlyCompletePairs`, `affectedKeys`.
 *
 * @returns {{committed:number, ignored:number, skipped:number, errors:number}}
 */
export function commitPending(db, filters = {}) {
  const {
    deviceId,
    employeeId,
    date,
    status = 'pending',
    punchIds,
    onlyCompletePairs = false,
    affectedKeys = null,
  } = filters;

  const clauses = ['status = ?'];
  const params = [status];
  if (deviceId !== undefined && deviceId !== null && deviceId !== '') {
    clauses.push('device_id = ?');
    params.push(deviceId);
  }
  if (employeeId !== undefined && employeeId !== null && employeeId !== '') {
    clauses.push('employee_id = ?');
    params.push(employeeId);
  }
  if (date !== undefined && date !== null && date !== '') {
    clauses.push('substr(punched_at, 1, 10) = ?');
    params.push(date);
  }
  if (Array.isArray(punchIds)) {
    if (punchIds.length === 0) return emptyOutcome();
    clauses.push(`id IN (${punchIds.map(() => '?').join(', ')})`);
    params.push(...punchIds);
  }

  const punches = listRows(db, 'biometric_punches', clauses.join(' AND '), params);
  return commitPunches(db, punches, { onlyCompletePairs, affectedKeys });
}
