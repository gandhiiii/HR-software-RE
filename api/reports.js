/**
 * Reporting and dashboard routes.
 *
 * Read-only views over the tables populated by the other modules. All roles
 * may read reports, but an `employee` account is scoped to its own linked
 * employee id (via `scopeClause`) so it cannot see colleagues' payroll, leave,
 * expenses or attendance. HR/admin see organisation-wide figures.
 *
 * The payroll report deliberately reuses the payslips written by Task 6 — it
 * never recomputes payroll. Every CSV variant is produced with the shared
 * `rowsToCsv` helper, and all persistence reads go through lib/repo.js. Every
 * route declares an explicit roles array.
 */
import { getRow, listRows } from '../lib/repo.js';
import { isIsoDate } from '../lib/validate.js';
import { rowsToCsv } from '../lib/csv.js';

const ALL_ROLES = ['admin', 'hr', 'employee'];

const STATUS_COUNTS = ['present', 'half_day', 'leave', 'holiday', 'absent'];
const STATUS_KEYS = {
  Present: 'present',
  'Half-day': 'half_day',
  Leave: 'leave',
  Holiday: 'holiday',
  Absent: 'absent',
};

const ATTENDANCE_COLUMNS = [
  'employee_id', 'employee_name', ...STATUS_COUNTS, 'present_days',
  'late_minutes', 'early_minutes', 'worked_minutes', 'overtime_minutes',
];
const LEAVE_COLUMNS = [
  'employee_id', 'employee_name', 'leave_type', 'opening_balance', 'used', 'remaining',
];
const PAYROLL_MONEY_COLUMNS = [
  'basic', 'hra', 'allowances', 'overtime_pay', 'reimbursement', 'gross',
  'pf', 'esic', 'professional_tax', 'income_tax', 'unpaid_leave_deduction',
  'deductions', 'net',
];
const PAYROLL_COLUMNS = [
  'payslip_id', 'employee_id', 'employee_name', 'month', 'year',
  ...PAYROLL_MONEY_COLUMNS, 'present_days', 'unpaid_leave_days',
  'overtime_minutes', 'status',
];
const EXPENSE_COLUMNS = [
  'id', 'employee_id', 'employee_name', 'category', 'amount', 'status',
  'reimbursement_month', 'reimbursement_year',
];
const EXPENSE_STATUSES = ['pending', 'approved', 'rejected', 'reimbursed'];

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

/**
 * Build a scoping clause for employee-linked rows. `column` is always one of
 * our own literal column names — never client input — so it cannot inject SQL.
 */
function scopeClause(user, column = 'employee_id') {
  if (user?.role === 'employee') {
    const id = positiveId(user.employee_id);
    if (id === null) throw httpError(400, 'No employee is linked to this account');
    return { clause: `${column} = ?`, params: [id] };
  }
  return { clause: '1=1', params: [] };
}

/** Append an optional positive-integer id filter to a where-clause. */
function addIdFilter(query, key, column, clauses, params) {
  if (query[key] === undefined || query[key] === '') return;
  const id = positiveId(query[key]);
  if (id === null) throw httpError(400, `${key} must be a positive integer`);
  clauses.push(`${column} = ?`);
  params.push(id);
}

/** Resolve month/year filters, defaulting to the current UTC month. */
function monthYearFrom(query) {
  const now = new Date();
  const defaultMonth = now.getUTCMonth() + 1;
  const defaultYear = now.getUTCFullYear();
  const month = query.month === undefined || query.month === '' ? defaultMonth : Number(query.month);
  const year = query.year === undefined || query.year === '' ? defaultYear : Number(query.year);
  if (
    !Number.isInteger(month) || month < 1 || month > 12 ||
    !Number.isInteger(year) || year < 1
  ) {
    throw httpError(400, 'month (1-12) and year must be valid');
  }
  return { month, year };
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function monthPrefix(month, year) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-`;
}

function isCsv(query) {
  return String(query.format ?? '').toLowerCase() === 'csv';
}

/** A handler result that lib/http.js emits as raw CSV instead of JSON. */
function csvResult(text, filename) {
  return {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
    body: text,
  };
}

function mapNames(db, table) {
  return new Map(listRows(db, table).map((row) => [row.id, row.name]));
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function dashboard(db, user, query) {
  const date = query.date && isIsoDate(query.date) ? query.date : todayIso();
  if (query.date && !isIsoDate(query.date)) throw httpError(400, 'date must be a valid ISO date');
  const { month, year } = monthYearFrom(query);
  const scope = scopeClause(user);

  const headcount = listRows(db, 'employees', "status = 'active'").length;

  // Today's attendance, scoped to the signed-in employee when applicable.
  const attendanceRows = listRows(
    db,
    'attendance',
    `date = ? AND ${scope.clause}`,
    [date, ...scope.params],
  );
  const attendance = {
    date,
    recorded: attendanceRows.length,
    present: 0,
    half_day: 0,
    leave: 0,
    holiday: 0,
    absent: 0,
    present_days: 0,
    late_minutes: 0,
    early_minutes: 0,
    worked_minutes: 0,
    overtime_minutes: 0,
  };
  for (const row of attendanceRows) {
    const key = STATUS_KEYS[row.status];
    if (key) attendance[key] += 1;
    for (const field of ['late_minutes', 'early_minutes', 'worked_minutes', 'overtime_minutes']) {
      attendance[field] += row[field] || 0;
    }
  }
  attendance.present_days = attendance.present + 0.5 * attendance.half_day;

  const pendingLeaves = listRows(
    db,
    'leave_requests',
    `status = 'pending' AND ${scope.clause}`,
    scope.params,
  ).length;
  const pendingExpenses = listRows(
    db,
    'expenses',
    `status = 'pending' AND ${scope.clause}`,
    scope.params,
  ).length;

  // Monthly payroll cost is the sum of the payslips stored by Task 6.
  const slips = listRows(
    db,
    'payslips',
    `month = ? AND year = ? AND ${scope.clause}`,
    [month, year, ...scope.params],
  );
  const payroll = { month, year, slips: slips.length, gross: 0, deductions: 0, net: 0 };
  for (const slip of slips) {
    payroll.gross += Number(slip.gross ?? 0);
    payroll.deductions += Number(slip.deductions ?? 0);
    payroll.net += Number(slip.net ?? 0);
  }

  // Open tasks use a different owner column (`assigned_to`).
  const taskScope = scopeClause(user, 'assigned_to');
  const openTasks = listRows(
    db,
    'tasks',
    `status NOT IN ('done','cancelled') AND ${taskScope.clause}`,
    taskScope.params,
  ).length;

  // Asset utilisation is derived from open assignments, never from a stale
  // assets.status value: an asset is "in use" when a live assignment exists.
  const assignmentScope = scopeClause(user, 'employee_id');
  const openAssignments = listRows(
    db,
    'asset_assignments',
    `status = 'assigned' AND returned_at IS NULL AND ${assignmentScope.clause}`,
    assignmentScope.params,
  );
  const assignedAssetIds = new Set(openAssignments.map((row) => row.asset_id));
  const totalAssets = listRows(db, 'assets').length;
  const assignedAssets = [...assignedAssetIds].filter((id) => getRow(db, 'assets', id)).length;
  const utilizationPercent = totalAssets > 0 ? Math.round((assignedAssets / totalAssets) * 100) : 0;

  return {
    status: 200,
    body: {
      generatedAt: new Date().toISOString(),
      date,
      headcount,
      todayAttendance: attendance.present + attendance.half_day,
      attendance,
      pendingLeaves,
      pendingExpenses,
      month,
      year,
      monthlyPayrollCost: payroll.net,
      payroll,
      openTasks,
      assets: {
        total: totalAssets,
        assigned: assignedAssets,
        available: totalAssets - assignedAssets,
        utilizationPercent,
        utilizationRate: totalAssets > 0 ? assignedAssets / totalAssets : 0,
      },
      assetUtilization: utilizationPercent,
    },
  };
}

// ---------------------------------------------------------------------------
// Attendance report
// ---------------------------------------------------------------------------

function attendanceReport(db, user, query) {
  const { month, year } = monthYearFrom(query);
  const scope = scopeClause(user);
  const clauses = ['date LIKE ?', scope.clause];
  const params = [`${monthPrefix(month, year)}%`, ...scope.params];
  addIdFilter(query, 'employeeId', 'employee_id', clauses, params);
  const rows = listRows(db, 'attendance', clauses.join(' AND '), params);

  const names = mapNames(db, 'employees');
  const byEmployee = new Map();
  for (const row of rows) {
    if (!byEmployee.has(row.employee_id)) {
      byEmployee.set(row.employee_id, {
        employee_id: row.employee_id,
        employee_name: names.get(row.employee_id) ?? '',
        present: 0,
        half_day: 0,
        leave: 0,
        holiday: 0,
        absent: 0,
        present_days: 0,
        late_minutes: 0,
        early_minutes: 0,
        worked_minutes: 0,
        overtime_minutes: 0,
      });
    }
    const summary = byEmployee.get(row.employee_id);
    const key = STATUS_KEYS[row.status];
    if (key) summary[key] += 1;
    for (const field of ['late_minutes', 'early_minutes', 'worked_minutes', 'overtime_minutes']) {
      summary[field] += row[field] || 0;
    }
  }
  const employees = [...byEmployee.values()];
  for (const summary of employees) {
    summary.present_days = summary.present + 0.5 * summary.half_day;
  }
  const totals = Object.fromEntries(ATTENDANCE_COLUMNS.filter((c) => c !== 'employee_id' && c !== 'employee_name').map((c) => [c, 0]));
  for (const summary of employees) {
    for (const key of Object.keys(totals)) totals[key] += summary[key];
  }

  if (isCsv(query)) {
    return csvResult(rowsToCsv(employees, ATTENDANCE_COLUMNS), `attendance-report-${year}-${String(month).padStart(2, '0')}.csv`);
  }
  return { status: 200, body: { month, year, employees, totals } };
}

// ---------------------------------------------------------------------------
// Leave balance report
// ---------------------------------------------------------------------------

function leaveReport(db, user, query) {
  const scope = scopeClause(user);
  const clauses = [scope.clause];
  const params = [...scope.params];
  addIdFilter(query, 'employeeId', 'employee_id', clauses, params);
  addIdFilter(query, 'leaveTypeId', 'leave_type_id', clauses, params);
  const balances = listRows(db, 'leave_balances', clauses.join(' AND '), params);

  const employeeNames = mapNames(db, 'employees');
  const typeNames = mapNames(db, 'leave_types');
  const rows = balances.map((balance) => ({
    ...balance,
    employee_name: employeeNames.get(balance.employee_id) ?? '',
    leave_type: typeNames.get(balance.leave_type_id) ?? '',
  }));
  const totals = { opening_balance: 0, used: 0, remaining: 0 };
  for (const row of rows) {
    for (const key of Object.keys(totals)) totals[key] += Number(row[key] ?? 0);
  }

  if (isCsv(query)) return csvResult(rowsToCsv(rows, LEAVE_COLUMNS), 'leave-balance-report.csv');
  return { status: 200, body: { balances: rows, totals } };
}

// ---------------------------------------------------------------------------
// Payroll report (reuses Task 6 payslips)
// ---------------------------------------------------------------------------

function payrollReport(db, user, query) {
  const { month, year } = monthYearFrom(query);
  const scope = scopeClause(user);
  const clauses = ['month = ?', 'year = ?', scope.clause];
  const params = [month, year, ...scope.params];
  addIdFilter(query, 'employeeId', 'employee_id', clauses, params);
  const payslips = listRows(db, 'payslips', clauses.join(' AND '), params);

  const names = mapNames(db, 'employees');
  const slips = payslips.map((slip) => ({
    ...slip,
    payslip_id: slip.id,
    employee_name: names.get(slip.employee_id) ?? '',
  }));
  const totals = Object.fromEntries(PAYROLL_MONEY_COLUMNS.map((key) => [key, 0]));
  for (const slip of slips) {
    for (const key of PAYROLL_MONEY_COLUMNS) totals[key] += Number(slip[key] ?? 0);
  }

  if (isCsv(query)) {
    const lines = [];
    for (const slip of slips) lines.push(slip);
    const totalRow = Object.fromEntries(PAYROLL_COLUMNS.map((key) => [key, '']));
    totalRow.payslip_id = 'TOTAL';
    totalRow.month = month;
    totalRow.year = year;
    for (const key of PAYROLL_MONEY_COLUMNS) totalRow[key] = totals[key];
    lines.push(totalRow);
    const filename = `payroll-register-${year}-${String(month).padStart(2, '0')}.csv`;
    return csvResult(rowsToCsv(lines, PAYROLL_COLUMNS), filename);
  }
  return { status: 200, body: { month, year, slips, totals } };
}

// ---------------------------------------------------------------------------
// Expense report
// ---------------------------------------------------------------------------

function expenseReport(db, user, query) {
  const scope = scopeClause(user);
  const clauses = [scope.clause];
  const params = [...scope.params];
  addIdFilter(query, 'employeeId', 'employee_id', clauses, params);
  if (query.status !== undefined && query.status !== '') {
    clauses.push('status = ?');
    params.push(query.status);
  }
  const { month, year } = monthYearFrom(query);
  if (query.month !== undefined && query.month !== '' || query.year !== undefined && query.year !== '') {
    clauses.push('reimbursement_month = ?');
    clauses.push('reimbursement_year = ?');
    params.push(month, year);
  }
  const expenses = listRows(db, 'expenses', clauses.join(' AND '), params);
  const names = mapNames(db, 'employees');
  const rows = expenses.map((expense) => ({
    ...expense,
    employee_name: names.get(expense.employee_id) ?? '',
  }));

  const summary = { all: { count: rows.length, amount: 0 } };
  for (const status of EXPENSE_STATUSES) summary[status] = { count: 0, amount: 0 };
  for (const row of rows) {
    const amount = Number(row.amount ?? 0);
    summary.all.amount += amount;
    if (summary[row.status]) {
      summary[row.status].count += 1;
      summary[row.status].amount += amount;
    }
  }

  if (isCsv(query)) return csvResult(rowsToCsv(rows, EXPENSE_COLUMNS), 'expense-report.csv');
  return { status: 200, body: { expenses: rows, summary } };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register all reporting routes (JSON plus `?format=csv` / `.csv` variants). */
export function registerReportRoutes(router) {
  router.register('GET', '/api/reports/dashboard', ALL_ROLES, async ({ db, user, query }) =>
    dashboard(db, user, query),
  );

  const reports = [
    ['attendance', attendanceReport],
    ['leave', leaveReport],
    ['payroll', payrollReport],
    ['expenses', expenseReport],
  ];
  for (const [name, handler] of reports) {
    router.register('GET', `/api/reports/${name}`, ALL_ROLES, async (ctx) =>
      handler(ctx.db, ctx.user, ctx.query),
    );
    // Alias so callers may request `/api/reports/<name>.csv` directly as well.
    router.register('GET', `/api/reports/${name}.csv`, ALL_ROLES, async (ctx) =>
      handler(ctx.db, ctx.user, { ...ctx.query, format: 'csv' }),
    );
  }
}
