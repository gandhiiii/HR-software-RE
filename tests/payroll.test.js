import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeClient } from './helpers.js';
import { startServer } from '../server.js';
import { insertRow, listRows, getRow, updateRow } from '../lib/repo.js';
import { roundRupee, computePayslip } from '../lib/calc/payroll.js';
import { registerPayrollRoutes } from '../api/payroll.js';

const EMPLOYEE = { id: 1, basic: 30000, hra: 6000, allowances: 1000 };
const RATES = {
  workingDays: 30,
  pfRate: 12,
  pfCeiling: 15000,
  esicRate: 0.75,
  esicCeiling: 21000,
  professionalTax: 0,
  taxRate: 0,
};

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Listening server with only the payroll routes registered on top of auth. */
async function setup(role = 'hr') {
  const db = makeDb();
  const server = startServer({
    db,
    registerRoutes: (router) => registerPayrollRoutes(router),
  });
  await listen(server);
  const client = makeClient(server);
  if (role) {
    const login = await client.post('/api/auth/login', { username: role, password: 'admin123' });
    assert.equal(login.status, 200, `login as ${role} should succeed`);
  }
  return {
    db,
    server,
    client,
    close: async () => {
      await close(server);
      db.close();
    },
  };
}

async function runMonth(client, month = 1, year = 2026) {
  const res = await client.post('/api/payroll/run', { month, year });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

/** Insert an approved unpaid leave for an employee (bypassing the leave API). */
function addUnpaidLeave(db, employeeId, days, typeName = 'Unpaid', status = 'approved') {
  const type = listRows(db, 'leave_types', 'name = ?', [typeName])[0];
  assert.ok(type, `leave type ${typeName} should exist`);
  return insertRow(db, 'leave_requests', {
    employee_id: employeeId,
    leave_type_id: type.id,
    from_date: '2026-01-05',
    to_date: '2026-01-06',
    days,
    status,
  });
}

/** Insert an expense flagged for reimbursement in January 2026. */
function addFlaggedExpense(db, employeeId, amount) {
  return insertRow(db, 'expenses', {
    employee_id: employeeId,
    category: 'Travel',
    amount,
    status: 'approved',
    reimbursement_month: 1,
    reimbursement_year: 2026,
  });
}

// ---------------------------------------------------------------------------
// Pure calculation boundaries (Step 1 of the task brief)
// ---------------------------------------------------------------------------

test('roundRupee rounds to the nearest rupee and handles 0/negative safely', () => {
  assert.equal(roundRupee(187.5), 188);
  assert.equal(roundRupee(2466.67), 2467);
  assert.equal(roundRupee(142.5), 143);
  assert.equal(roundRupee(0), 0);
  assert.equal(roundRupee(Number.NaN), 0);
  assert.equal(roundRupee(-1.5), -2);
});

test('computePayslip: exact brief numbers (basic 30000, 2 unpaid days, 60 OT minutes)', () => {
  const slip = computePayslip({
    employee: EMPLOYEE,
    ...RATES,
    month: 1,
    year: 2026,
    attendance: { present_days: 20, overtime_minutes: 60 },
    approvedLeaves: [{ leave_type_name: 'Unpaid', days: 2, status: 'approved' }],
    reimbursedExpenses: [],
  });
  assert.equal(slip.employeeId, 1);
  assert.equal(slip.month, 1);
  assert.equal(slip.year, 2026);
  assert.equal(slip.overtimeMinutes, 60);
  assert.equal(slip.unpaidLeaveDays, 2);
  assert.equal(slip.presentDays, 20);
  // hourly basic = 30000/(30*8) = 125; OT = 1h * 125 * 1.5 = 187.5 -> 188
  assert.equal(slip.overtimePay, 188);
  // 12% of basic capped at 15000 => 1800
  assert.equal(slip.pf, 1800);
  // gross 37188 > 21000 ceiling => no ESIC
  assert.equal(slip.gross, 37188);
  assert.equal(slip.esic, 0);
  // (30000+6000+1000)/30 * 2 = 2466.67 -> 2467
  assert.equal(slip.unpaidLeaveDeduction, 2467);
  assert.equal(slip.deductions, 4267);
  assert.equal(slip.net, 32921);
});

test('computePayslip: ESIC applies at 0.75% when gross is within the 21000 ceiling', () => {
  const slip = computePayslip({
    employee: { id: 2, basic: 15000, hra: 3000, allowances: 1000 },
    ...RATES,
    month: 2,
    year: 2026,
  });
  assert.equal(slip.gross, 19000);
  assert.equal(slip.pf, 1800);
  // 19000 * 0.75% = 142.5 -> 143
  assert.equal(slip.esic, 143);
  assert.equal(slip.deductions, 1943);
  assert.equal(slip.net, 17057);
});

test('computePayslip: professional tax and flat income tax are charged on gross', () => {
  const slip = computePayslip({
    employee: { id: 3, basic: 10000, hra: 2000, allowances: 0 },
    ...RATES,
    professionalTax: 200,
    taxRate: 10,
  });
  assert.equal(slip.gross, 12000);
  assert.equal(slip.pf, 1200);
  assert.equal(slip.esic, 90);
  assert.equal(slip.professionalTax, 200);
  assert.equal(slip.incomeTax, 1200); // 10% of gross (no slabs)
  assert.equal(slip.deductions, 2690);
  assert.equal(slip.net, 9310);
});

test('computePayslip: unpaid days come only from approved unpaid-type leaves', () => {
  const slip = computePayslip({
    employee: EMPLOYEE,
    ...RATES,
    approvedLeaves: [
      { leave_type_name: 'Casual', days: 3, status: 'approved' },
      { leave_type_name: 'unpaid leave', days: 1, status: 'approved' },
      { leave_type_name: 'Unpaid', days: 4, status: 'pending' },
    ],
  });
  // Only the 1 approved leave whose type name contains "unpaid" is deducted.
  assert.equal(slip.unpaidLeaveDays, 1);
  assert.equal(slip.unpaidLeaveDeduction, 1233); // 37000/30 * 1 = 1233.33 -> 1233
});

test('computePayslip: flagged expenses become a reimbursement earning and PF stays capped for high basic', () => {
  const slip = computePayslip({
    employee: { id: 1, basic: 20000, hra: 0, allowances: 0 },
    ...RATES,
    reimbursedExpenses: [{ amount: 1200 }, { amount: 300.5 }],
  });
  assert.equal(slip.reimbursement, 1501); // 1200 + 300.5 = 1500.5 -> 1501
  assert.equal(slip.gross, 21501);
  assert.equal(slip.pf, 1800); // basic 20000 capped at 15000
});

test('computePayslip: derives present days and overtime from raw attendance rows', () => {
  const slip = computePayslip({
    employee: EMPLOYEE,
    ...RATES,
    attendance: [
      { status: 'Present', overtime_minutes: 60 },
      { status: 'Half-day', overtime_minutes: 30 },
      { status: 'Absent', overtime_minutes: 0 },
    ],
  });
  assert.equal(slip.presentDays, 1.5);
  assert.equal(slip.overtimeMinutes, 90);
  assert.equal(slip.overtimePay, 281); // 90/60 * 125 * 1.5 = 281.25 -> 281
});

test('computePayslip: workingDays defaults to 30 when omitted or invalid', () => {
  const a = computePayslip({ employee: { basic: 30000, hra: 0, allowances: 0 }, ...RATES, workingDays: undefined, approvedLeaves: [{ leave_type_name: 'Unpaid', days: 1 }] });
  const b = computePayslip({ employee: { basic: 30000, hra: 0, allowances: 0 }, ...RATES, workingDays: 0, approvedLeaves: [{ leave_type_name: 'Unpaid', days: 1 }] });
  assert.equal(a.unpaidLeaveDeduction, 1000);
  assert.equal(b.unpaidLeaveDeduction, 1000);
});

// ---------------------------------------------------------------------------
// Run + payslip lifecycle APIs
// ---------------------------------------------------------------------------

test('POST /api/payroll/run creates one draft slip per active employee', async () => {
  const h = await setup('hr');
  try {
    const run = await runMonth(h.client);
    assert.equal(run.month, 1);
    assert.equal(run.year, 2026);
    assert.equal(run.slips.length, 3, 'three seeded active employees');
    for (const slip of run.slips) {
      assert.equal(slip.status, 'draft');
      assert.equal(slip.basic > 0, true);
      assert.ok(slip.id);
    }
    const stored = await h.client.get('/api/payroll/slips?month=1&year=2026');
    assert.equal(stored.body.length, 3);
  } finally {
    await h.close();
  }
});

test('re-running a month updates the same draft in place and never duplicates', async () => {
  const h = await setup('hr');
  try {
    const first = await runMonth(h.client);
    const firstIds = first.slips.map((s) => s.id).sort();
    const second = await runMonth(h.client);
    const secondIds = second.slips.map((s) => s.id).sort();
    assert.deepEqual(secondIds, firstIds, 'same slip ids reused');
    assert.equal(second.slips.length, 3);
    const all = await h.client.get('/api/payroll/slips?month=1&year=2026');
    assert.equal(all.body.length, 3, 'no duplicate slips after a second run');
  } finally {
    await h.close();
  }
});

test('approved unpaid leave and flagged expenses feed the payslip; finalize marks expenses reimbursed', async () => {
  const h = await setup('hr');
  try {
    addUnpaidLeave(h.db, 1, 2);
    const expenseId = addFlaggedExpense(h.db, 1, 1200);
    const run = await runMonth(h.client);
    const slip = run.slips.find((s) => s.employee_id === 1);
    assert.equal(slip.unpaid_leave_days, 2);
    assert.equal(slip.unpaid_leave_deduction, 2467);
    assert.equal(slip.reimbursement, 1200);
    assert.equal(slip.gross, 38200);
    assert.equal(slip.net, 33933);
    assert.equal(getRow(h.db, 'expenses', expenseId).status, 'approved');

    const finalized = await h.client.post(`/api/payroll/slips/${slip.id}/finalize`, {});
    assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
    assert.equal(finalized.body.status, 'finalized');
    assert.equal(getRow(h.db, 'expenses', expenseId).status, 'reimbursed');
  } finally {
    await h.close();
  }
});

test('draft component edits recompute totals; finalized and paid slips reject edits with 409', async () => {
  const h = await setup('hr');
  try {
    const run = await runMonth(h.client);
    const slip = run.slips.find((s) => s.employee_id === 1);

    const patched = await h.client.patch(`/api/payroll/slips/${slip.id}`, { allowances: 2000 });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.allowances, 2000);
    assert.equal(patched.body.gross, 38000);
    assert.equal(patched.body.deductions, 1800);
    assert.equal(patched.body.net, 36200);

    assert.equal((await h.client.post(`/api/payroll/slips/${slip.id}/finalize`, {})).status, 200);
    const afterFinalize = await h.client.patch(`/api/payroll/slips/${slip.id}`, { basic: 1 });
    assert.equal(afterFinalize.status, 409, 'finalized slips are locked');

    const paid = await h.client.post(`/api/payroll/slips/${slip.id}/pay`, {});
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.status, 'paid');
    assert.equal((await h.client.patch(`/api/payroll/slips/${slip.id}`, { basic: 2 })).status, 409);
    assert.equal((await h.client.post(`/api/payroll/slips/${slip.id}/finalize`, {})).status, 409);
  } finally {
    await h.close();
  }
});

test('finalized/paid slips are skipped (not overwritten) by a re-run', async () => {
  const h = await setup('hr');
  try {
    const first = await runMonth(h.client);
    const slip = first.slips.find((s) => s.employee_id === 1);
    await h.client.patch(`/api/payroll/slips/${slip.id}`, { allowances: 9999 });
    await h.client.post(`/api/payroll/slips/${slip.id}/finalize`, {});
    const second = await runMonth(h.client);
    const same = second.slips.find((s) => s.employee_id === 1);
    assert.equal(same.allowances, 9999, 'manual adjustment preserved on locked slip');
    assert.equal(same.status, 'finalized');
  } finally {
    await h.close();
  }
});

test('rates are read from settings on each run, with seeded defaults as fallback', async () => {
  const h = await setup('hr');
  try {
    // Bring employee 2 under the ESIC ceiling so the seeded 0.75% rate shows up.
    updateRow(h.db, 'employees', 2, { basic: 15000, hra: 3000, allowances: 1000 });
    const before = await runMonth(h.client);
    const first = before.slips.find((s) => s.employee_id === 2);
    assert.equal(first.gross, 19000);
    assert.equal(first.esic, 143);
    assert.equal(first.professional_tax, 0);
    assert.equal(first.income_tax, 0);

    // Edit settings and re-run: the existing draft is recomputed with new rates.
    for (const [key, value] of [['professional_tax', 200], ['income_tax_rate', 10]]) {
      const row = listRows(h.db, 'settings', 'key = ?', [key])[0];
      updateRow(h.db, 'settings', row.id, { value: String(value) });
    }
    const after = await runMonth(h.client);
    const second = after.slips.find((s) => s.employee_id === 2);
    assert.equal(second.id, first.id, 'still the same draft slip');
    assert.equal(second.professional_tax, 200);
    assert.equal(second.income_tax, 1900); // flat 10% of gross 19000
    assert.equal(second.deductions, 1800 + 143 + 200 + 1900);
    assert.equal(second.net, 19000 - second.deductions);
  } finally {
    await h.close();
  }
});

test('GET /api/payroll/slips filters by month/year/employeeId', async () => {
  const h = await setup('hr');
  try {
    await runMonth(h.client, 1, 2026);
    await runMonth(h.client, 2, 2026);
    assert.equal((await h.client.get('/api/payroll/slips?month=1&year=2026')).body.length, 3);
    assert.equal((await h.client.get('/api/payroll/slips?month=2&year=2026')).body.length, 3);
    assert.equal((await h.client.get('/api/payroll/slips?month=3&year=2026')).body.length, 0);
    const one = await h.client.get('/api/payroll/slips?month=1&year=2026&employeeId=2');
    assert.equal(one.body.length, 1);
    assert.equal(one.body[0].employee_id, 2);
    const byId = await h.client.get(`/api/payroll/slips/${one.body[0].id}`);
    assert.equal(byId.status, 200);
    assert.equal(byId.body.employee_id, 2);
    assert.equal((await h.client.get('/api/payroll/slips/999999')).status, 404);
  } finally {
    await h.close();
  }
});

test('employee role sees only own payslips and cannot run or edit payroll', async () => {
  const h = await setup('hr');
  try {
    await runMonth(h.client);
    const slips = (await h.client.get('/api/payroll/slips?month=1&year=2026')).body;
    const ownId = slips.find((s) => s.employee_id === 3).id;
    const otherId = slips.find((s) => s.employee_id === 1).id;

    const employeeClient = makeClient(h.server);
    const login = await employeeClient.post('/api/auth/login', { username: 'employee', password: 'admin123' });
    assert.equal(login.status, 200);

    const own = await employeeClient.get('/api/payroll/slips?month=1&year=2026');
    assert.equal(own.body.length, 1, 'only own slips are returned');
    assert.equal(own.body[0].employee_id, 3);
    assert.equal((await employeeClient.get(`/api/payroll/slips/${ownId}`)).status, 200);
    assert.equal((await employeeClient.get(`/api/payroll/slips/${otherId}`)).status, 403);
    assert.equal((await employeeClient.post('/api/payroll/run', { month: 1, year: 2026 })).status, 403);
    assert.equal((await employeeClient.patch(`/api/payroll/slips/${ownId}`, { basic: 1 })).status, 403);
    assert.equal((await employeeClient.post(`/api/payroll/slips/${ownId}/finalize`, {})).status, 403);
    assert.equal((await employeeClient.get('/api/payroll/register.csv?month=1&year=2026')).status, 403);
  } finally {
    await h.close();
  }
});

test('GET /api/payroll/register.csv returns a CSV register with a totals row', async () => {
  const h = await setup('hr');
  try {
    await runMonth(h.client);
    const res = await h.client.get('/api/payroll/register.csv?month=1&year=2026');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.headers.get('content-type'), /text\/csv/);
    const lines = res.text.trim().split(/\r?\n/);
    assert.match(lines[0], /employee_id/);
    assert.match(lines[0], /gross/);
    assert.equal(lines.length, 5, 'header + 3 employees + total');
    assert.match(lines[4], /^TOTAL/);
    assert.match(res.text, /Aarav Sharma/);
  } finally {
    await h.close();
  }
});

test('validation: bad month/year, unknown employee id and anonymous access', async () => {
  const h = await setup('hr');
  try {
    assert.equal((await h.client.post('/api/payroll/run', { month: 13, year: 2026 })).status, 400);
    assert.equal((await h.client.post('/api/payroll/run', { month: 1 })).status, 400);
    assert.equal((await h.client.get('/api/payroll/register.csv')).status, 400);
    assert.equal((await h.client.get('/api/payroll/slips?month=abc&year=2026')).status, 400);

    const anon = makeClient(h.server);
    assert.equal((await anon.get('/api/payroll/slips')).status, 401);
    assert.equal((await anon.post('/api/payroll/run', { month: 1, year: 2026 })).status, 401);
  } finally {
    await h.close();
  }
});
