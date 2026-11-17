/**
 * Pure payroll calculation. No database, no I/O, no settings lookups — the API
 * resolves rates from `settings` and passes them in, so every rule here is a
 * deterministic function of its arguments and can be unit-tested on its own.
 *
 * Approved rules (India / INR / Gregorian, nearest-rupee rounding):
 *   earnings = basic + hra + allowances + overtimePay + reimbursement
 *   hourly basic   = basic / (workingDays * 8)
 *   overtime pay   = overtimeMinutes/60 * hourly basic * overtimeMultiplier
 *   PF             = pfRate% of basic, capped at `pfCeiling` of basic
 *   ESIC           = esicRate% of gross when gross <= esicCeiling, else 0
 *   professional tax = configurable flat monthly amount
 *   income tax     = taxRate% of gross (flat, no slabs)
 *   unpaid leave   = (basic + hra + allowances)/workingDays * unpaidLeaveDays
 *   deductions     = pf + esic + professionalTax + incomeTax + unpaidLeaveDeduction
 *   net            = gross - deductions
 *
 * `unpaidLeaveDays` is derived ONLY from approved leave requests whose leave
 * TYPE NAME contains "unpaid" (case-insensitive). The attendance `absent` count
 * is deliberately NOT used — see the controller ruling in contracts.md.
 */

/** Seeded default for working_days_per_month. */
const DEFAULT_WORKING_DAYS = 30;
const DEFAULT_PF_RATE = 12;
const DEFAULT_PF_CEILING = 15000;
const DEFAULT_ESIC_RATE = 0.75;
const DEFAULT_ESIC_CEILING = 21000;
const DEFAULT_OVERTIME_MULTIPLIER = 1.5;

/**
 * Round to the nearest whole rupee. A tiny epsilon nudges values that sit on a
 * binary-float representation of x.5 (e.g. 0.75% of 19000) to the intended
 * result. Non-finite input degrades to 0 rather than poisoning a whole slip.
 */
export function roundRupee(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const nudged = number + (number < 0 ? -1e-9 : 1e-9);
  const rounded = Math.round(nudged);
  return rounded === 0 ? 0 : rounded; // never surface -0
}

/** Finite non-negative number, or the supplied fallback. */
function nonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

/** Finite number (may be negative), or the fallback. */
function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Total of `amount` fields on an array of expense rows. */
function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((total, row) => total + nonNegative(row?.amount), 0);
}

/**
 * Days and overtime for one employee's attendance. Accepts either the summary
 * object produced by `GET /api/attendance/summary` or the raw attendance rows
 * for the month (a half-day counts as half a present day).
 */
function attendanceMetrics(attendance) {
  if (Array.isArray(attendance)) {
    let presentDays = 0;
    let overtimeMinutes = 0;
    for (const row of attendance) {
      if (row?.status === 'Present') presentDays += 1;
      else if (row?.status === 'Half-day') presentDays += 0.5;
      overtimeMinutes += nonNegative(row?.overtime_minutes ?? row?.overtimeMinutes);
    }
    return { presentDays: Math.round(presentDays * 100) / 100, overtimeMinutes: Math.round(overtimeMinutes) };
  }
  return {
    presentDays: nonNegative(attendance?.present_days ?? attendance?.presentDays),
    overtimeMinutes: Math.round(nonNegative(attendance?.overtime_minutes ?? attendance?.overtimeMinutes)),
  };
}

/**
 * Sum the days of approved leave requests whose type name contains "unpaid".
 * A `status` is honoured when present so callers can pass the full approved
 * list safely; a request without one is assumed approved by the caller.
 */
function unpaidLeaveDays(approvedLeaves) {
  if (!Array.isArray(approvedLeaves)) return 0;
  let days = 0;
  for (const leave of approvedLeaves) {
    const name = leave?.leave_type_name ?? leave?.leaveTypeName ?? leave?.name ?? '';
    const status = leave?.status;
    if (status !== undefined && status !== null && status !== 'approved') continue;
    if (!/unpaid/i.test(String(name))) continue;
    days += nonNegative(leave?.days);
  }
  return Math.round(days * 100) / 100;
}

/**
 * Compute every stored component of a single payslip.
 *
 * @param {object}  params
 * @param {object}  [params.employee]            {id, basic, hra, allowances}
 * @param {number}  [params.workingDays=30]
 * @param {number}  [params.pfRate=12]           percentage of basic
 * @param {number}  [params.pfCeiling=15000]     cap on the basic used for PF
 * @param {number}  [params.esicRate=0.75]       percentage of gross
 * @param {number}  [params.esicCeiling=21000]   gross above this pays no ESIC
 * @param {number}  [params.professionalTax=0]   flat monthly amount
 * @param {number}  [params.taxRate=0]           flat percentage of gross
 * @param {number}  [params.overtimeMultiplier=1.5]
 * @param {object|Array} [params.attendance]     summary object or raw rows
 * @param {Array}   [params.approvedLeaves]      leave requests (with type name)
 * @param {Array}   [params.reimbursedExpenses]  expense rows flagged for payroll
 * @param {number}  [params.month]
 * @param {number}  [params.year]
 * @param {number}  [params.employeeId]
 * @returns {object} all payslip components, rounded to whole rupees
 */
export function computePayslip({
  employee = {},
  workingDays = DEFAULT_WORKING_DAYS,
  pfRate = DEFAULT_PF_RATE,
  pfCeiling = DEFAULT_PF_CEILING,
  esicRate = DEFAULT_ESIC_RATE,
  esicCeiling = DEFAULT_ESIC_CEILING,
  professionalTax = 0,
  taxRate = 0,
  overtimeMultiplier = DEFAULT_OVERTIME_MULTIPLIER,
  attendance = null,
  approvedLeaves = [],
  reimbursedExpenses = [],
  month = null,
  year = null,
  employeeId = null,
} = {}) {
  const days = nonNegative(workingDays, DEFAULT_WORKING_DAYS) || DEFAULT_WORKING_DAYS;
  const multiplier = nonNegative(overtimeMultiplier, DEFAULT_OVERTIME_MULTIPLIER) || DEFAULT_OVERTIME_MULTIPLIER;

  const basic = roundRupee(nonNegative(employee?.basic));
  const hra = roundRupee(nonNegative(employee?.hra));
  const allowances = roundRupee(nonNegative(employee?.allowances));

  const { presentDays, overtimeMinutes } = attendanceMetrics(attendance);
  const hourlyBasic = basic / (days * 8);
  const overtimePay = roundRupee((overtimeMinutes / 60) * hourlyBasic * multiplier);
  const reimbursement = roundRupee(sumAmounts(reimbursedExpenses));

  const gross = roundRupee(basic + hra + allowances + overtimePay + reimbursement);

  const pf = roundRupee((Math.min(basic, nonNegative(pfCeiling)) * nonNegative(pfRate)) / 100);
  const esic = gross <= nonNegative(esicCeiling, Infinity)
    ? roundRupee((gross * nonNegative(esicRate)) / 100)
    : 0;
  const professionalTaxValue = roundRupee(nonNegative(professionalTax));
  // This simplified regime has no slabs or exemptions: the whole gross is the
  // "taxable gross" the flat rate applies to.
  const incomeTax = roundRupee((gross * nonNegative(taxRate)) / 100);

  const unpaidDays = unpaidLeaveDays(approvedLeaves);
  const unpaidLeaveDeduction = roundRupee(
    ((basic + hra + allowances) / days) * unpaidDays,
  );

  const deductions = roundRupee(
    pf + esic + professionalTaxValue + incomeTax + unpaidLeaveDeduction,
  );
  const net = roundRupee(gross - deductions);

  return {
    employeeId: employeeId ?? employee?.id ?? null,
    month,
    year,
    basic,
    hra,
    allowances,
    overtimePay,
    reimbursement,
    gross,
    pf,
    esic,
    professionalTax: professionalTaxValue,
    incomeTax,
    unpaidLeaveDeduction,
    deductions,
    net,
    presentDays,
    unpaidLeaveDays: unpaidDays,
    overtimeMinutes,
  };
}
