import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeClient } from './helpers.js';
import { startServer, registerAllRoutes } from '../server.js';

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

/**
 * A listening, production-shaped server. Static files are served by the server
 * itself and every API module is registered through `registerAllRoutes` — the
 * exact helper the `node server.js` main guard uses — so these tests exercise
 * the real auth/role checks and the real production wiring.
 */
async function setup() {
  const db = makeDb();
  const server = startServer({ db, registerRoutes: registerAllRoutes });
  await listen(server);
  return {
    db,
    server,
    client: makeClient(server),
    close: async () => {
      await close(server);
      db.close();
    },
  };
}

test('GET / serves the SPA shell with an #app mount point', async () => {
  const h = await setup();
  try {
    const res = await h.client.get('/');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.headers.get('content-type'), /text\/html/i);
    assert.match(res.text, /id=["']app["']/, 'shell must contain the app mount point');
    assert.match(res.text, /app\.js/, 'shell must load the SPA script');
    assert.match(res.text, /styles\.css/, 'shell must load the stylesheet');
  } finally {
    await h.close();
  }
});

test('GET /app.js and GET /styles.css return 200 with the right content types', async () => {
  const h = await setup();
  try {
    const js = await h.client.get('/app.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/i);
    assert.match(js.text, /api\/auth\/login/, 'SPA must implement the login call');

    const css = await h.client.get('/styles.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/i);
  } finally {
    await h.close();
  }
});

test('unauthenticated API calls from the UI pattern still return 401', async () => {
  const h = await setup();
  try {
    const me = await h.client.get('/api/auth/me');
    assert.equal(me.status, 401);
    assert.equal(me.body.error, 'Authentication required');

    const employees = await h.client.get('/api/employees');
    assert.equal(employees.status, 401, 'static serving must not bypass route auth');
  } finally {
    await h.close();
  }
});

/**
 * Full end-to-end walkthrough over the complete production wiring:
 * login -> employee -> attendance -> leave -> payroll -> payslip -> expense ->
 * task -> asset -> CSV report. Every step asserts status codes and key values,
 * and the cross-module links (attendance/leave/expense into payroll, payroll
 * into expenses and CSV reports) are checked explicitly.
 */
test('end-to-end walkthrough exercises every module through the production server', async () => {
  const MONTH = 1;
  const YEAR = 2026;
  const EMP_CODE = 'E2E-001';
  const BASIC = 20000;
  const HRA = 4000;
  const ALLOWANCES = 1000;
  const EXPENSE_AMOUNT = 500;

  const h = await setup();
  try {
    const { client } = h;

    // --- 1. Login as admin -------------------------------------------------
    const login = await client.post('/api/auth/login', { username: 'admin', password: 'admin123' });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.equal(login.body.role, 'admin');
    assert.equal(login.body.user.username, 'admin');
    assert.ok(
      login.headers.get('set-cookie')?.includes('hrms_session='),
      'a successful login must set the session cookie',
    );
    const me = await client.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.username, 'admin');

    // --- 2. Create an employee ---------------------------------------------
    const created = await client.post('/api/employees', {
      code: EMP_CODE,
      name: 'E2E Walkthrough User',
      joining_date: '2025-01-01',
      status: 'active',
      basic: BASIC,
      hra: HRA,
      allowances: ALLOWANCES,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.code, EMP_CODE);
    assert.equal(created.body.status, 'active');
    assert.equal(created.body.basic, BASIC);
    assert.equal(created.body.hra, HRA);
    assert.equal(created.body.allowances, ALLOWANCES);
    const empId = created.body.id;
    assert.ok(Number.isInteger(empId) && empId > 0, 'created employee needs a positive id');

    // --- 3. Record attendance (a normal day and an overtime day) -----------
    const day1 = await client.post('/api/attendance', {
      employeeId: empId, date: '2026-01-05', punchIn: '09:00', punchOut: '18:00',
    });
    assert.equal(day1.status, 201, JSON.stringify(day1.body));
    assert.equal(day1.body.status, 'Present');
    assert.equal(day1.body.worked_minutes, 540);
    assert.equal(day1.body.overtime_minutes, 0);

    const day2 = await client.post('/api/attendance', {
      employeeId: empId, date: '2026-01-06', punchIn: '09:00', punchOut: '20:00',
    });
    assert.equal(day2.status, 201, JSON.stringify(day2.body));
    assert.equal(day2.body.status, 'Present');
    assert.equal(day2.body.overtime_minutes, 120);

    const attendance = await client.get(
      `/api/attendance?employeeId=${empId}&from=2026-01-01&to=2026-01-31`,
    );
    assert.equal(attendance.status, 200);
    assert.equal(attendance.body.length, 2);

    // --- 4. Apply and approve leave (Unpaid feeds the payroll deduction) ---
    const types = await client.get('/api/leave/types');
    assert.equal(types.status, 200);
    const unpaidType = types.body.find((t) => /unpaid/i.test(t.name));
    assert.ok(unpaidType, 'the seeded Unpaid leave type must exist');

    const applied = await client.post('/api/leave/requests', {
      leaveTypeId: unpaidType.id,
      employeeId: empId,
      fromDate: '2026-01-07',
      toDate: '2026-01-07',
      days: 1,
      reason: 'E2E unpaid leave',
    });
    assert.equal(applied.status, 201, JSON.stringify(applied.body));
    assert.equal(applied.body.status, 'pending');
    assert.equal(applied.body.leave_type_name, unpaidType.name);
    const leaveId = applied.body.id;

    const approved = await client.post(`/api/leave/requests/${leaveId}/decision`, { action: 'approve' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, 'approved');
    assert.equal(approved.body.balance.used, 1);
    assert.equal(approved.body.balance.remaining, -1, 'unpaid leave may drive the balance negative');

    const balances = await client.get(`/api/leave/balances?employeeId=${empId}`);
    assert.equal(balances.status, 200);
    assert.equal(balances.body.length, 4, 'all seeded leave types are provisioned for a new hire');

    // --- 5. Run payroll for the month --------------------------------------
    const run1 = await client.post('/api/payroll/run', { month: MONTH, year: YEAR });
    assert.equal(run1.status, 200, JSON.stringify(run1.body));
    assert.equal(run1.body.created, 4, 'one slip per active employee (3 seeded + 1 new)');
    const slip1 = run1.body.slips.find((s) => s.employee_id === empId);
    assert.ok(slip1, 'payroll must produce a slip for the new employee');
    assert.equal(slip1.status, 'draft');
    assert.equal(slip1.present_days, 2);
    assert.equal(slip1.overtime_minutes, 120);
    assert.equal(slip1.overtime_pay, 250);
    assert.equal(slip1.unpaid_leave_days, 1);
    assert.equal(slip1.unpaid_leave_deduction, 833);
    assert.equal(slip1.reimbursement, 0);
    assert.equal(slip1.pf, 1800, 'PF is 12% of basic, capped at the 15000 ceiling');
    assert.equal(slip1.esic, 0, 'gross above the 21000 ceiling attracts no ESIC');
    assert.equal(slip1.gross, 25250);
    assert.equal(slip1.net, 22617);

    // --- 6. View the payslip ------------------------------------------------
    const slipView = await client.get(`/api/payroll/slips/${slip1.id}`);
    assert.equal(slipView.status, 200);
    assert.equal(slipView.body.employee_id, empId);
    assert.equal(slipView.body.net, slip1.net);
    const slipList = await client.get(`/api/payroll/slips?month=${MONTH}&year=${YEAR}&employeeId=${empId}`);
    assert.equal(slipList.status, 200);
    assert.equal(slipList.body.length, 1);

    // --- 7. Submit, approve and flag an expense; pick it up in payroll -----
    const submitted = await client.post('/api/expenses', {
      employeeId: empId,
      category: 'Travel',
      amount: EXPENSE_AMOUNT,
      receiptNote: 'E2E taxi receipt',
    });
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    assert.equal(submitted.body.status, 'pending');
    assert.equal(submitted.body.amount, EXPENSE_AMOUNT);
    const expenseId = submitted.body.id;

    const expenseApproved = await client.post(`/api/expenses/${expenseId}/decision`, { action: 'approve' });
    assert.equal(expenseApproved.status, 200, JSON.stringify(expenseApproved.body));
    assert.equal(expenseApproved.body.status, 'approved');

    const flagged = await client.post(`/api/expenses/${expenseId}/flag-reimbursement`, {
      month: MONTH, year: YEAR,
    });
    assert.equal(flagged.status, 200, JSON.stringify(flagged.body));
    assert.equal(flagged.body.reimbursement_month, MONTH);
    assert.equal(flagged.body.reimbursement_year, YEAR);
    assert.equal(flagged.body.status, 'approved');

    // Re-running payroll refreshes drafts in place (no duplicates) and folds
    // the flagged expense into the payslip as a reimbursement earning.
    const run2 = await client.post('/api/payroll/run', { month: MONTH, year: YEAR });
    assert.equal(run2.status, 200, JSON.stringify(run2.body));
    assert.equal(run2.body.created, 0);
    assert.equal(run2.body.updated, 4);
    const slip2 = run2.body.slips.find((s) => s.employee_id === empId);
    assert.equal(slip2.id, slip1.id, 'a re-run must update the draft, not duplicate it');
    assert.equal(slip2.reimbursement, EXPENSE_AMOUNT);
    assert.equal(slip2.gross, 25750);
    assert.equal(slip2.net, 23117);

    // Finalize and pay the slip: finalization moves flagged expenses to
    // "reimbursed", closing the expense -> payroll loop.
    const finalized = await client.post(`/api/payroll/slips/${slip1.id}/finalize`, {});
    assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
    assert.equal(finalized.body.status, 'finalized');
    const paid = await client.post(`/api/payroll/slips/${slip1.id}/pay`, {});
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.status, 'paid');
    const expensesAfterPay = await client.get(`/api/expenses?employeeId=${empId}`);
    assert.equal(expensesAfterPay.status, 200);
    assert.equal(expensesAfterPay.body.find((e) => e.id === expenseId).status, 'reimbursed');

    // --- 8. Create and complete a task -------------------------------------
    const task = await client.post('/api/tasks', {
      title: 'E2E onboarding checklist',
      assigned_to: empId,
      priority: 'high',
      due_date: '2026-12-31',
    });
    assert.equal(task.status, 201, JSON.stringify(task.body));
    assert.equal(task.body.status, 'open');
    assert.equal(task.body.assigned_to, empId);
    const taskId = task.body.id;
    const completed = await client.patch(`/api/tasks/${taskId}`, { status: 'done' });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.status, 'done');

    // --- 9. Assign and return an asset -------------------------------------
    const asset = await client.post('/api/assets', {
      name: 'E2E Laptop', type: 'laptop', serial: 'E2E-SN-1', value: 75000,
    });
    assert.equal(asset.status, 201, JSON.stringify(asset.body));
    assert.equal(asset.body.status, 'available');
    const assetId = asset.body.id;

    const assigned = await client.post(`/api/assets/${assetId}/assign`, { employeeId: empId });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    assert.equal(assigned.body.status, 'assigned');
    assert.equal(assigned.body.employee_id, empId);
    const assetWhileAssigned = await client.get(`/api/assets/${assetId}`);
    assert.equal(assetWhileAssigned.body.status, 'assigned');

    const returned = await client.post(`/api/assets/${assetId}/return`, {});
    assert.equal(returned.status, 200, JSON.stringify(returned.body));
    assert.equal(returned.body.status, 'returned');
    assert.ok(returned.body.returned_at, 'returning an asset must stamp returned_at');
    const history = await client.get(`/api/assets/${assetId}/history`);
    assert.equal(history.status, 200);
    assert.equal(history.body.length, 1);
    assert.equal(history.body[0].status, 'returned');
    const assetAfterReturn = await client.get(`/api/assets/${assetId}`);
    assert.equal(assetAfterReturn.body.status, 'available');

    // --- 10. Fetch reports (JSON dashboard + CSV exports) ------------------
    const dashboard = await client.get(`/api/reports/dashboard?month=${MONTH}&year=${YEAR}`);
    assert.equal(dashboard.status, 200, JSON.stringify(dashboard.body));
    assert.equal(dashboard.body.headcount, 4);
    assert.equal(dashboard.body.payroll.slips, 4);

    const csv = await client.get(`/api/reports/payroll?month=${MONTH}&year=${YEAR}&format=csv`);
    assert.equal(csv.status, 200, csv.text);
    assert.match(csv.headers.get('content-type'), /text\/csv/i);
    assert.match(csv.headers.get('content-disposition'), /attachment/i);
    assert.match(csv.text, /payslip_id/, 'CSV must include a header row');
    assert.ok(csv.text.includes(String(empId)), 'CSV must include the new employee');
    assert.match(csv.text, /TOTAL/, 'CSV must include a totals row');

    const aliasCsv = await client.get(`/api/reports/attendance.csv?month=${MONTH}&year=${YEAR}`);
    assert.equal(aliasCsv.status, 200, aliasCsv.text);
    assert.match(aliasCsv.headers.get('content-type'), /text\/csv/i);
    assert.match(aliasCsv.text, /employee_id/);

    // --- Logout closes the session -----------------------------------------
    const logout = await client.post('/api/auth/logout', {});
    assert.equal(logout.status, 200);
    const afterLogout = await client.get('/api/auth/me');
    assert.equal(afterLogout.status, 401);
  } finally {
    await h.close();
  }
});
