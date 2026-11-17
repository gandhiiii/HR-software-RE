/**
 * Expense claim submission, approval and reimbursement flagging.
 *
 * Employees submit claims and only ever see their own; HR/admin decide claims
 * and flag approved ones for a payroll month/year. The flag fields
 * (`reimbursement_month` / `reimbursement_year`) are the query surface Task 6
 * uses to turn an approved claim into a reimbursement earning, and its finalize
 * / pay steps then move those rows to `reimbursed`. Status vocabulary:
 * pending | approved | rejected | reimbursed (the last is written by payroll).
 *
 * All persistence goes through lib/repo.js and every route declares an
 * explicit roles array, so neither SQL nor authorization is left implicit.
 */
import { requireFields, isNonNegativeNumber } from '../lib/validate.js';
import { getRow, listRows, insertRow, updateRow } from '../lib/repo.js';

const HR_ROLES = ['admin', 'hr'];
const ALL_ROLES = ['admin', 'hr', 'employee'];

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function positiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Accept a finite non-negative JS number, or a numeric string that converts to
 * one. Anything else (negative, NaN, Infinity, junk text) is rejected so a bad
 * amount can never reach persistence. Zero is a valid amount.
 */
function parseAmount(value) {
  if (isNonNegativeNumber(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (isNonNegativeNumber(parsed)) return parsed;
  }
  return null;
}

/** The employee id an employee-role session is allowed to act as. */
function ownEmployeeId(user) {
  const id = positiveId(user?.employee_id);
  if (id === null) throw httpError(400, 'No employee is linked to this account');
  return id;
}

/** Validate and normalize a decision body into 'approve' or 'reject'. */
function resolveAction(body) {
  const raw = body?.action ?? body?.status;
  if (raw === 'approve' || raw === 'approved') return 'approve';
  if (raw === 'reject' || raw === 'rejected') return 'reject';
  throw httpError(400, "action must be 'approve' or 'reject'");
}

/** Validate the target payroll month/year for reimbursement flagging. */
function monthYearFrom(source) {
  const month = Number(source?.month);
  const year = Number(source?.year);
  if (
    source?.month === undefined || source?.month === '' ||
    source?.year === undefined || source?.year === '' ||
    !Number.isInteger(month) || month < 1 || month > 12 ||
    !Number.isInteger(year) || year < 1
  ) {
    throw httpError(400, 'month (1-12) and year are required');
  }
  return { month, year };
}

// ---------------------------------------------------------------------------
// Submit / list
// ---------------------------------------------------------------------------

function submitExpense(db, body, user) {
  requireFields(body, ['category', 'amount']);

  const category = typeof body.category === 'string' ? body.category.trim() : '';
  if (!category) throw httpError(400, 'category is required');

  // Reject before any write: the controller ruling covers negative and
  // non-numeric amounts explicitly.
  const amount = parseAmount(body.amount);
  if (amount === null) throw httpError(400, 'amount must be a non-negative number');

  // An employee always claims for themselves; HR/admin may submit on behalf of
  // an employee (falling back to their own linked id when present).
  let employeeId;
  if (user.role === 'employee') {
    employeeId = ownEmployeeId(user);
  } else {
    employeeId = positiveId(body.employeeId) ?? positiveId(user?.employee_id);
    if (employeeId === null) throw httpError(400, 'employeeId must be a positive integer');
  }
  if (!getRow(db, 'employees', employeeId)) throw httpError(404, 'Employee not found');

  const id = insertRow(db, 'expenses', {
    employee_id: employeeId,
    category,
    amount,
    receipt_note: body.receiptNote ?? body.receipt_note ?? null,
    status: 'pending',
  });
  return { status: 201, body: getRow(db, 'expenses', id) };
}

function listExpenses(db, user, query) {
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
    'expenses',
    clauses.length > 0 ? clauses.join(' AND ') : '1=1',
    params,
  );
  return { status: 200, body: rows };
}

// ---------------------------------------------------------------------------
// Decide (approve / reject) and flag for reimbursement
// ---------------------------------------------------------------------------

function decideExpense(db, id, body, user) {
  const action = resolveAction(body);
  if (id === null) throw httpError(400, 'Invalid expense id');

  const expense = getRow(db, 'expenses', id);
  if (!expense) throw httpError(404, 'Expense not found');
  if (expense.status !== 'pending') throw httpError(409, 'Expense has already been decided');

  updateRow(db, 'expenses', id, {
    status: action === 'approve' ? 'approved' : 'rejected',
    decided_by: user?.id ?? null,
    decided_at: new Date().toISOString(),
  });
  return { status: 200, body: getRow(db, 'expenses', id) };
}

function flagReimbursement(db, id, body) {
  const { month, year } = monthYearFrom(body);
  if (id === null) throw httpError(400, 'Invalid expense id');

  const expense = getRow(db, 'expenses', id);
  if (!expense) throw httpError(404, 'Expense not found');
  if (expense.status !== 'approved') {
    throw httpError(409, 'Only approved expenses can be flagged for reimbursement');
  }

  // Task 6 queries approved claims by these two fields; the status stays
  // 'approved' until a payslip lock/pay moves it to 'reimbursed'.
  updateRow(db, 'expenses', id, { reimbursement_month: month, reimbursement_year: year });
  return { status: 200, body: getRow(db, 'expenses', id) };
}

/** Register all expense routes. */
export function registerExpenseRoutes(router) {
  router.register('POST', '/api/expenses', ALL_ROLES, async ({ db, user, body }) =>
    submitExpense(db, body, user),
  );

  router.register('GET', '/api/expenses', ALL_ROLES, async ({ db, user, query }) =>
    listExpenses(db, user, query),
  );

  router.register('POST', '/api/expenses/:id/decision', HR_ROLES, async ({ db, user, params, body }) =>
    decideExpense(db, positiveId(params.id), body, user),
  );

  router.register('POST', '/api/expenses/:id/flag-reimbursement', HR_ROLES, async ({ db, params, body }) =>
    flagReimbursement(db, positiveId(params.id), body),
  );
}
