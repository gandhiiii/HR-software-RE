/**
 * Leave balance and approval workflow routes.
 *
 * Employees apply for leave and can only see their own requests/balances; the
 * HR/admin roles decide requests and see everything. All persistence goes
 * through lib/repo.js, and every balance change is computed by the pure
 * lib/calc/leave.js helper so an invalid approval cannot mutate any data.
 *
 * Approved requests expose `leave_type_name`, `from_date`, `to_date` and
 * `status`, which is the query surface Task 6 (payroll) uses to compute the
 * unpaid-leave deduction.
 */
import { requireFields, isIsoDate } from '../lib/validate.js';
import { getRow, listRows, insertRow, updateRow } from '../lib/repo.js';
import { applyLeaveDecision } from '../lib/calc/leave.js';
import { LEAVE_TYPES } from '../lib/db.js';

const HR_ROLES = ['admin', 'hr'];
const ALL_ROLES = ['admin', 'hr', 'employee'];

// Authoritative opening balances keyed by leave type name (from the seed).
// Leave types themselves carry no opening-balance column, so this map is the
// single source of truth used when provisioning new hires' balance rows.
const OPENING_BY_NAME = new Map(
  LEAVE_TYPES.map(([name, opening]) => [name.toLowerCase(), opening]),
);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function positiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Accept a number or a numeric string, but reject anything non-positive. */
function parseDays(value) {
  const days =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(days) && days > 0 ? days : null;
}

/** The employee id for an employee-role session (they cannot act for others). */
function ownEmployeeId(user) {
  const id = positiveId(user?.employee_id);
  if (id === null) throw httpError(400, 'No employee is linked to this account');
  return id;
}

/** Attach the human-readable leave type to a request/balance row. */
function withTypeName(db, row) {
  if (!row) return row;
  const type = getRow(db, 'leave_types', row.leave_type_id);
  return { ...row, leave_type_name: type?.name ?? null };
}

function getBalance(db, employeeId, leaveTypeId) {
  return (
    listRows(db, 'leave_balances', 'employee_id = ? AND leave_type_id = ?', [
      employeeId,
      leaveTypeId,
    ])[0] ?? null
  );
}

/** Any active (pending/approved) request whose date range overlaps the given one. */
function findOverlap(db, employeeId, fromDate, toDate) {
  return listRows(
    db,
    'leave_requests',
    `employee_id = ? AND status IN (?, ?) AND from_date <= ? AND to_date >= ?`,
    [employeeId, 'pending', 'approved', toDate, fromDate],
  );
}

/**
 * Only leave types whose NAME contains "unpaid" are exempt from balance checks.
 * The decision never infers this from balance values — a zero balance on a
 * normal type must still fail on overdraw.
 */
function isUnlimitedLeave(db, leaveTypeId) {
  const type = getRow(db, 'leave_types', leaveTypeId);
  return /unpaid/i.test(type?.name ?? '');
}

/**
 * Idempotently create any missing leave_balances rows for one employee from the
 * seeded opening balances. api/employees.js writes no balances for new hires,
 * so without this the whole workflow would dead-end for them: empty balance
 * lists and a 409 on every approval. Uses repo helpers only (real columns).
 */
function provisionBalances(db, employeeId) {
  if (!getRow(db, 'employees', employeeId)) return;
  for (const type of listRows(db, 'leave_types')) {
    if (getBalance(db, employeeId, type.id)) continue;
    const opening = OPENING_BY_NAME.get(String(type.name ?? '').toLowerCase()) ?? 0;
    insertRow(db, 'leave_balances', {
      employee_id: employeeId,
      leave_type_id: type.id,
      opening_balance: opening,
      used: 0,
      remaining: opening,
    });
  }
}

// ---------------------------------------------------------------------------
// Reference lists
// ---------------------------------------------------------------------------

function listBalances(db, user, query) {
  const clauses = [];
  const params = [];
  if (user.role === 'employee') {
    const ownId = ownEmployeeId(user);
    clauses.push('employee_id = ?');
    params.push(ownId);
    provisionBalances(db, ownId);
  } else if (query.employeeId !== undefined && query.employeeId !== '') {
    const id = positiveId(query.employeeId);
    if (id === null) throw httpError(400, 'employeeId must be a positive integer');
    clauses.push('employee_id = ?');
    params.push(id);
    provisionBalances(db, id);
  } else {
    // HR/admin listing everyone: bring every employee up to date first.
    for (const employee of listRows(db, 'employees')) {
      provisionBalances(db, employee.id);
    }
  }
  const rows = listRows(
    db,
    'leave_balances',
    clauses.length > 0 ? clauses.join(' AND ') : '1=1',
    params,
  );
  return { status: 200, body: rows.map((row) => withTypeName(db, row)) };
}

function listRequests(db, user, query) {
  const clauses = [];
  const params = [];
  if (user.role === 'employee') {
    clauses.push('employee_id = ?');
    params.push(ownEmployeeId(user));
  } else if (query.employeeId !== undefined && query.employeeId !== '') {
    const id = positiveId(query.employeeId);
    if (id === null) throw httpError(400, 'employeeId must be a positive integer');
    clauses.push('employee_id = ?');
    params.push(id);
  }
  if (query.status !== undefined && query.status !== '') {
    clauses.push('status = ?');
    params.push(query.status);
  }
  const rows = listRows(
    db,
    'leave_requests',
    clauses.length > 0 ? clauses.join(' AND ') : '1=1',
    params,
  );
  return { status: 200, body: rows.map((row) => withTypeName(db, row)) };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function applyLeave(db, body, user) {
  requireFields(body, ['leaveTypeId', 'fromDate', 'toDate', 'days']);

  const leaveTypeId = positiveId(body.leaveTypeId);
  if (leaveTypeId === null) throw httpError(400, 'leaveTypeId must be a positive integer');
  if (!getRow(db, 'leave_types', leaveTypeId)) throw httpError(404, 'Leave type not found');

  if (!isIsoDate(body.fromDate) || !isIsoDate(body.toDate)) {
    throw httpError(400, 'fromDate and toDate must be valid ISO dates (YYYY-MM-DD)');
  }
  if (body.toDate < body.fromDate) {
    throw httpError(400, 'toDate must not be before fromDate');
  }

  const days = parseDays(body.days);
  if (days === null) throw httpError(400, 'days must be a positive number');

  // Employee role always uses the id from the session; HR/admin may apply on
  // behalf of a specific employee.
  const employeeId =
    user.role === 'employee' ? ownEmployeeId(user) : positiveId(body.employeeId);
  if (employeeId === null) throw httpError(400, 'employeeId must be a positive integer');
  if (!getRow(db, 'employees', employeeId)) throw httpError(404, 'Employee not found');
  // A new hire may apply before ever listing balances; ensure rows exist.
  provisionBalances(db, employeeId);

  if (findOverlap(db, employeeId, body.fromDate, body.toDate).length > 0) {
    throw httpError(409, 'Overlapping leave request exists for this employee');
  }

  const id = insertRow(db, 'leave_requests', {
    employee_id: employeeId,
    leave_type_id: leaveTypeId,
    from_date: body.fromDate,
    to_date: body.toDate,
    days,
    reason: body.reason ?? null,
    status: 'pending',
  });
  return { status: 201, body: withTypeName(db, getRow(db, 'leave_requests', id)) };
}

// ---------------------------------------------------------------------------
// Decide (approve / reject) with balance recomputation
// ---------------------------------------------------------------------------

function decide(db, id, action, user) {
  if (id === null) throw httpError(400, 'Invalid leave request id');
  if (action !== 'approve' && action !== 'reject') {
    throw httpError(400, "action must be 'approve' or 'reject'");
  }

  const request = getRow(db, 'leave_requests', id);
  if (!request) throw httpError(404, 'Leave request not found');
  if (request.status === 'rejected') throw httpError(409, 'Request has already been rejected');
  if (request.status === 'approved' && action === 'approve') {
    throw httpError(409, 'Request is already approved');
  }

  // Valid transitions:
  //   pending  + approve -> deduct days from the balance
  //   pending  + reject  -> no balance change (nothing was ever debited)
  //   approved + reject  -> restore the debited days to the balance
  const shouldDeduct = request.status === 'pending' && action === 'approve';
  const shouldRestore = request.status === 'approved' && action === 'reject';

  let computed = null;
  let balanceRow = null;
  if (shouldDeduct || shouldRestore) {
    // Provision on decision too, for requests created before provisioning
    // existed (or inserted directly). Idempotent for already-provisioned hires.
    provisionBalances(db, request.employee_id);
    balanceRow = getBalance(db, request.employee_id, request.leave_type_id);
    if (!balanceRow) throw httpError(409, 'No leave balance is configured for this leave type');
    // May throw a 409 for an overdrawn approval — before any write happens.
    computed = applyLeaveDecision({
      balance: balanceRow,
      days: Number(request.days),
      action: shouldRestore ? 'reject' : 'approve',
      unlimited: isUnlimitedLeave(db, request.leave_type_id),
    });
  }

  updateRow(db, 'leave_requests', id, {
    status: action === 'approve' ? 'approved' : 'rejected',
    decided_by: user?.id ?? null,
    decided_at: new Date().toISOString(),
  });
  if (computed) updateRow(db, 'leave_balances', balanceRow.id, computed);

  const updated = getRow(db, 'leave_requests', id);
  const currentBalance = getBalance(db, request.employee_id, request.leave_type_id);
  return { status: 200, body: { ...withTypeName(db, updated), balance: currentBalance } };
}

/** Register all leave routes. */
export function registerLeaveRoutes(router) {
  router.register('GET', '/api/leave/types', ALL_ROLES, async ({ db }) => ({
    status: 200,
    body: listRows(db, 'leave_types'),
  }));

  router.register('GET', '/api/leave/balances', ALL_ROLES, async ({ db, user, query }) =>
    listBalances(db, user, query),
  );

  router.register('POST', '/api/leave/requests', ALL_ROLES, async ({ db, user, body }) =>
    applyLeave(db, body, user),
  );

  router.register('GET', '/api/leave/requests', ALL_ROLES, async ({ db, user, query }) =>
    listRequests(db, user, query),
  );

  router.register('POST', '/api/leave/requests/:id/decision', HR_ROLES, async ({ db, user, params, body }) =>
    decide(db, positiveId(params.id), body.action, user),
  );
}
