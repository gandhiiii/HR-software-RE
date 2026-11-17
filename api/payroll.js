/**
 * Payroll run and payslip lifecycle routes.
 *
 * HR/admin run payroll, adjust draft components, finalize and mark slips paid;
 * employees may only view their own slips. Rates are read from `settings` on
 * every run (seeded values are the fallback) and every amount is handed to the
 * pure `computePayslip` helper, which rounds to whole rupees. All persistence
 * goes through lib/repo.js, and every route declares an explicit roles array.
 *
 * Unpaid-leave days come from approved leave requests whose TYPE NAME contains
 * "unpaid". Expense reimbursements come from approved expenses flagged for the
 * same month/year; finalizing the slip marks those expenses reimbursed.
 */
import { getRow, listRows, insertRow, updateRow } from '../lib/repo.js';
import { computePayslip, roundRupee } from '../lib/calc/payroll.js';

const HR_ROLES = ['admin', 'hr'];
const ALL_ROLES = ['admin', 'hr', 'employee'];

const DRAFT = 'draft';
const FINALIZED = 'finalized';
const PAID = 'paid';

// Accepted PATCH keys (camelCase and the stored snake_case spelling) -> column.
const COMPONENT_COLUMNS = {
  basic: 'basic',
  hra: 'hra',
  allowances: 'allowances',
  overtimePay: 'overtime_pay',
  overtime_pay: 'overtime_pay',
  reimbursement: 'reimbursement',
  pf: 'pf',
  esic: 'esic',
  professionalTax: 'professional_tax',
  professional_tax: 'professional_tax',
  incomeTax: 'income_tax',
  income_tax: 'income_tax',
  unpaidLeaveDeduction: 'unpaid_leave_deduction',
  unpaid_leave_deduction: 'unpaid_leave_deduction',
};

const EARNING_COLUMNS = ['basic', 'hra', 'allowances', 'overtime_pay', 'reimbursement'];
const DEDUCTION_COLUMNS = [
  'pf', 'esic', 'professional_tax', 'income_tax', 'unpaid_leave_deduction',
];

const CSV_COLUMNS = [
  'payslip_id', 'employee_id', 'employee_name', 'month', 'year',
  ...EARNING_COLUMNS, 'gross', ...DEDUCTION_COLUMNS, 'deductions', 'net',
  'present_days', 'unpaid_leave_days', 'overtime_minutes', 'status',
];

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function positiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

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

/** Flatten the settings table into a key -> value map (via repo helpers). */
function settingsMap(db) {
  const map = {};
  for (const row of listRows(db, 'settings')) map[row.key] = row.value;
  return map;
}

function settingNumber(map, key, fallback) {
  const value = Number(map[key]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Resolve all rate settings once per run, falling back to the seeded values. */
function payrollRates(db) {
  const settings = settingsMap(db);
  return {
    workingDays: settingNumber(settings, 'working_days_per_month', 30),
    pfRate: settingNumber(settings, 'pf_rate', 12),
    pfCeiling: settingNumber(settings, 'pf_ceiling', 15000),
    esicRate: settingNumber(settings, 'esic_rate', 0.75),
    esicCeiling: settingNumber(settings, 'esic_ceiling', 21000),
    professionalTax: settingNumber(settings, 'professional_tax', 0),
    taxRate: settingNumber(settings, 'income_tax_rate', 0),
    overtimeMultiplier: settingNumber(settings, 'overtime_multiplier', 1.5),
  };
}

function ownEmployeeId(user) {
  const id = positiveId(user?.employee_id);
  if (id === null) throw httpError(400, 'No employee is linked to this account');
  return id;
}

function monthBounds(month, year) {
  const prefix = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { prefix, first: `${prefix}01`, last: `${prefix}${String(lastDay).padStart(2, '0')}` };
}

/** Raw attendance rows for one employee in the payroll month. */
function attendanceForMonth(db, employeeId, month, year) {
  const { prefix } = monthBounds(month, year);
  return listRows(db, 'attendance', 'employee_id = ? AND date LIKE ?', [employeeId, `${prefix}%`]);
}

/** Approved leave requests overlapping the month, enriched with the type name. */
function approvedLeavesForMonth(db, employeeId, month, year, typeNames) {
  const { first, last } = monthBounds(month, year);
  const rows = listRows(
    db,
    'leave_requests',
    `employee_id = ? AND status = 'approved' AND from_date <= ? AND to_date >= ?`,
    [employeeId, last, first],
  );
  return rows.map((row) => ({
    ...row,
    leave_type_name: typeNames.get(row.leave_type_id) ?? null,
  }));
}

/** Approved expenses flagged (by Task 7) for reimbursement in this month. */
function flaggedExpensesForMonth(db, employeeId, month, year) {
  return listRows(
    db,
    'expenses',
    `employee_id = ? AND status = 'approved' AND reimbursement_month = ? AND reimbursement_year = ?`,
    [employeeId, month, year],
  );
}

function leaveTypeNames(db) {
  return new Map(listRows(db, 'leave_types').map((type) => [type.id, type.name]));
}

/** Get or create the single payroll run row for a month. */
function upsertRun(db, month, year) {
  const existing = listRows(db, 'payroll_runs', 'month = ? AND year = ?', [month, year])[0];
  if (existing) return getRow(db, 'payroll_runs', existing.id);
  const id = insertRow(db, 'payroll_runs', { month, year, status: DRAFT });
  return getRow(db, 'payroll_runs', id);
}

/** Map a computed (camelCase) slip onto the payslips table columns. */
function computedToRow(computed, runId) {
  return {
    employee_id: computed.employeeId,
    month: computed.month,
    year: computed.year,
    run_id: runId ?? null,
    basic: computed.basic,
    hra: computed.hra,
    allowances: computed.allowances,
    overtime_pay: computed.overtimePay,
    reimbursement: computed.reimbursement,
    gross: computed.gross,
    pf: computed.pf,
    esic: computed.esic,
    professional_tax: computed.professionalTax,
    income_tax: computed.incomeTax,
    unpaid_leave_deduction: computed.unpaidLeaveDeduction,
    deductions: computed.deductions,
    net: computed.net,
    present_days: computed.presentDays,
    unpaid_leave_days: computed.unpaidLeaveDays,
    overtime_minutes: computed.overtimeMinutes,
  };
}

/**
 * Run payroll for a month. One slip per active employee; existing DRAFT slips
 * are updated in place, while FINALIZED/PAID slips are left untouched so a
 * re-run can never overwrite locked pay or create duplicates.
 */
function runPayroll(db, month, year) {
  const rates = payrollRates(db);
  const run = upsertRun(db, month, year);
  const typeNames = leaveTypeNames(db);
  const employees = listRows(db, 'employees', "status = 'active'");

  const slips = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const employee of employees) {
    const computed = computePayslip({
      employee,
      ...rates,
      month,
      year,
      employeeId: employee.id,
      attendance: attendanceForMonth(db, employee.id, month, year),
      approvedLeaves: approvedLeavesForMonth(db, employee.id, month, year, typeNames),
      reimbursedExpenses: flaggedExpensesForMonth(db, employee.id, month, year),
    });
    const values = computedToRow(computed, run.id);
    const existing = listRows(
      db,
      'payslips',
      'employee_id = ? AND month = ? AND year = ?',
      [employee.id, month, year],
    )[0];

    let slipId;
    if (existing) {
      if (existing.status !== DRAFT) {
        skipped += 1;
        slips.push(getRow(db, 'payslips', existing.id));
        continue;
      }
      updateRow(db, 'payslips', existing.id, values);
      slipId = existing.id;
      updated += 1;
    } else {
      slipId = insertRow(db, 'payslips', { ...values, status: DRAFT });
      created += 1;
    }
    slips.push(getRow(db, 'payslips', slipId));
  }

  return { status: 200, body: { month, year, runId: run.id, created, updated, skipped, slips } };
}

function getSlip(db, id, user) {
  const slip = getRow(db, 'payslips', id);
  if (!slip) throw httpError(404, 'Payslip not found');
  if (user?.role === 'employee' && slip.employee_id !== ownEmployeeId(user)) {
    throw httpError(403, 'Forbidden');
  }
  return slip;
}

function listSlips(db, user, query) {
  const clauses = [];
  const params = [];
  for (const key of ['month', 'year']) {
    if (query[key] !== undefined && query[key] !== '') {
      const value = Number(query[key]);
      const valid = Number.isInteger(value) && (key === 'month' ? value >= 1 && value <= 12 : value >= 1);
      if (!valid) throw httpError(400, 'Invalid month/year filter');
      clauses.push(`${key} = ?`);
      params.push(value);
    }
  }
  if (user?.role === 'employee') {
    clauses.push('employee_id = ?');
    params.push(ownEmployeeId(user));
  } else if (query.employeeId !== undefined && query.employeeId !== '') {
    const id = positiveId(query.employeeId);
    if (id === null) throw httpError(400, 'employeeId must be a positive integer');
    clauses.push('employee_id = ?');
    params.push(id);
  }
  return {
    status: 200,
    body: listRows(db, 'payslips', clauses.length > 0 ? clauses.join(' AND ') : '1=1', params),
  };
}

/** Edit individual components of a DRAFT slip, then recompute totals. */
function patchSlip(db, id, body) {
  const slip = getRow(db, 'payslips', id);
  if (!slip) throw httpError(404, 'Payslip not found');
  if (slip.status !== DRAFT) throw httpError(409, 'Only draft payslips can be edited');

  const updates = {};
  for (const [key, value] of Object.entries(body ?? {})) {
    const column = COMPONENT_COLUMNS[key];
    if (!column) throw httpError(400, `Unknown component: ${key}`);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw httpError(400, `${key} must be a non-negative number`);
    }
    updates[column] = roundRupee(value);
  }

  if (Object.keys(updates).length === 0) return { status: 200, body: slip };

  const merged = { ...slip, ...updates };
  const gross = roundRupee(EARNING_COLUMNS.reduce((sum, key) => sum + merged[key], 0));
  const deductions = roundRupee(DEDUCTION_COLUMNS.reduce((sum, key) => sum + merged[key], 0));
  updateRow(db, 'payslips', id, {
    ...updates,
    gross,
    deductions,
    net: roundRupee(gross - deductions),
  });
  return { status: 200, body: getRow(db, 'payslips', id) };
}

/** Mark the month's flagged expenses reimbursed when a slip is locked/paid. */
function markExpensesReimbursed(db, slip) {
  for (const expense of flaggedExpensesForMonth(db, slip.employee_id, slip.month, slip.year)) {
    updateRow(db, 'expenses', expense.id, { status: 'reimbursed' });
  }
}

/**
 * A flagged expense may only become "reimbursed" once a payslip actually funds
 * it: the reimbursement component is written by a payroll RUN. Locking a slip
 * after flagging an expense without re-running would otherwise mark the claim
 * reimbursed while the slip still shows zero reimbursement — the employee never
 * receives the money, silently. Check before any write so a rejected guard
 * leaves both the slip and the expenses exactly as they were.
 *
 * For a FINALIZED slip the originally funded expenses were already moved to
 * "reimbursed" at finalize time, so any still-approved flagged expense appeared
 * afterwards and is unfunded; none may be marked here.
 */
function assertExpensesFunded(db, slip) {
  const flagged = flaggedExpensesForMonth(db, slip.employee_id, slip.month, slip.year);
  const outstanding = roundRupee(
    flagged.reduce((total, expense) => total + Number(expense.amount ?? 0), 0),
  );
  if (slip.status === DRAFT) {
    const funded = roundRupee(Number(slip.reimbursement ?? 0));
    if (outstanding !== funded) {
      throw httpError(
        409,
        `Flagged expenses (${outstanding}) are not included in this payslip's reimbursement (${funded}); re-run payroll before finalizing or paying`,
      );
    }
  } else if (outstanding !== 0) {
    throw httpError(
      409,
      `New expenses (${outstanding}) were flagged after this payslip was finalized; re-run payroll before paying`,
    );
  }
}

function finalizeSlip(db, id) {
  const slip = getRow(db, 'payslips', id);
  if (!slip) throw httpError(404, 'Payslip not found');
  if (slip.status !== DRAFT) throw httpError(409, 'Only draft payslips can be finalized');
  assertExpensesFunded(db, slip);
  updateRow(db, 'payslips', id, { status: FINALIZED });
  markExpensesReimbursed(db, slip);
  return { status: 200, body: getRow(db, 'payslips', id) };
}

function paySlip(db, id) {
  const slip = getRow(db, 'payslips', id);
  if (!slip) throw httpError(404, 'Payslip not found');
  if (slip.status === PAID) throw httpError(409, 'Payslip is already marked paid');
  assertExpensesFunded(db, slip);
  updateRow(db, 'payslips', id, { status: PAID });
  markExpensesReimbursed(db, slip);
  return { status: 200, body: getRow(db, 'payslips', id) };
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Monthly payroll register as CSV, with one totals row. */
function registerCsv(db, month, year) {
  const slips = listRows(db, 'payslips', 'month = ? AND year = ?', [month, year]);
  const moneyColumns = [...EARNING_COLUMNS, 'gross', ...DEDUCTION_COLUMNS, 'deductions', 'net'];
  const totals = Object.fromEntries(moneyColumns.map((key) => [key, 0]));
  const lines = [CSV_COLUMNS.join(',')];

  for (const slip of slips) {
    const employee = getRow(db, 'employees', slip.employee_id);
    const row = { ...slip, payslip_id: slip.id, employee_name: employee?.name ?? '' };
    lines.push(CSV_COLUMNS.map((key) => csvCell(row[key])).join(','));
    for (const key of moneyColumns) totals[key] += Number(slip[key] ?? 0);
  }

  const totalRow = Object.fromEntries(CSV_COLUMNS.map((key) => [key, '']));
  totalRow.payslip_id = 'TOTAL';
  totalRow.month = month;
  totalRow.year = year;
  for (const key of moneyColumns) totalRow[key] = roundRupee(totals[key]);
  lines.push(CSV_COLUMNS.map((key) => csvCell(totalRow[key])).join(','));

  return `${lines.join('\r\n')}\r\n`;
}

/** Register all payroll routes. */
export function registerPayrollRoutes(router) {
  router.register('POST', '/api/payroll/run', HR_ROLES, async ({ db, body }) => {
    const { month, year } = monthYearFrom(body);
    return runPayroll(db, month, year);
  });

  router.register('GET', '/api/payroll/slips', ALL_ROLES, async ({ db, user, query }) =>
    listSlips(db, user, query),
  );

  router.register('GET', '/api/payroll/slips/:id', ALL_ROLES, async ({ db, user, params }) => ({
    status: 200,
    body: getSlip(db, positiveId(params.id), user),
  }));

  router.register('PATCH', '/api/payroll/slips/:id', HR_ROLES, async ({ db, params, body }) =>
    patchSlip(db, positiveId(params.id), body),
  );

  router.register('POST', '/api/payroll/slips/:id/finalize', HR_ROLES, async ({ db, params }) =>
    finalizeSlip(db, positiveId(params.id)),
  );

  router.register('POST', '/api/payroll/slips/:id/pay', HR_ROLES, async ({ db, params }) =>
    paySlip(db, positiveId(params.id)),
  );

  router.register('GET', '/api/payroll/register.csv', HR_ROLES, async ({ db, query }) => {
    const { month, year } = monthYearFrom(query);
    const filename = `payroll-register-${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}.csv`;
    return {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
      body: registerCsv(db, month, year),
    };
  });
}
