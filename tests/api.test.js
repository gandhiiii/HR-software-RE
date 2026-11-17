import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeClient } from './helpers.js';
import { startServer } from '../server.js';
import { registerEmployeeRoutes, registerOrgRoutes } from '../api/employees.js';
import { registerExpenseRoutes } from '../api/expenses.js';
import { getRow, insertRow } from '../lib/repo.js';

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
 * Build a listening server with the Task 3 routes registered. `role` is the
 * seed account to log in as; pass null to leave the client unauthenticated.
 */
async function setup(role = 'hr') {
  const db = makeDb();
  const server = startServer({
    db,
    registerRoutes: (router) => {
      registerEmployeeRoutes(router);
      registerOrgRoutes(router);
    },
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

const NEW_EMPLOYEE = {
  code: 'EMP100',
  name: 'Nisha Rao',
  joining_date: '2026-02-28',
  basic: 50000,
  hra: 8000,
  allowances: 1500,
  department_id: 1,
  designation_id: 1,
};

async function createEmployee(client, overrides = {}) {
  const response = await client.post('/api/employees', { ...NEW_EMPLOYEE, ...overrides });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

test('hr POST /api/employees creates a row and GET /api/employees/:id returns it', async () => {
  const h = await setup('hr');
  try {
    const created = await createEmployee(h.client);
    assert.ok(Number.isInteger(created.id) && created.id > 0);
    assert.equal(created.code, 'EMP100');
    assert.equal(created.basic, 50000);
    assert.equal(created.hra, 8000);
    assert.equal(created.allowances, 1500);

    const fetched = await h.client.get(`/api/employees/${created.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.name, 'Nisha Rao');
    assert.equal(fetched.body.joining_date, '2026-02-28');
  } finally {
    await h.close();
  }
});

test('invalid joining date, negative salary and missing fields are rejected with 400', async () => {
  const h = await setup('hr');
  try {
    const badDate = await h.client.post('/api/employees', {
      ...NEW_EMPLOYEE,
      code: 'BAD_DATE',
      joining_date: '2026-02-30',
    });
    assert.equal(badDate.status, 400);
    assert.match(badDate.body.error, /joining_date/i);

    const badMoney = await h.client.post('/api/employees', {
      ...NEW_EMPLOYEE,
      code: 'BAD_MONEY',
      basic: -1,
    });
    assert.equal(badMoney.status, 400);
    assert.match(badMoney.body.error, /basic/i);

    const badHra = await h.client.post('/api/employees', {
      ...NEW_EMPLOYEE,
      code: 'BAD_HRA',
      hra: -500,
    });
    assert.equal(badHra.status, 400);

    const missing = await h.client.post('/api/employees', { name: 'No Code' });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /code/i);

    // Nothing invalid was stored: only the three seeded employees remain.
    const list = await h.client.get('/api/employees');
    assert.equal(list.body.length, 3);
  } finally {
    await h.close();
  }
});

test('PATCH /api/employees/:id updates the row, but rejects invalid money/dates', async () => {
  const h = await setup('hr');
  try {
    const created = await createEmployee(h.client);
    const patched = await h.client.patch(`/api/employees/${created.id}`, {
      name: 'Nisha Sharma',
      basic: 60000,
      joining_date: '2026-03-01',
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.name, 'Nisha Sharma');
    assert.equal(patched.body.basic, 60000);
    assert.equal(patched.body.joining_date, '2026-03-01');
    assert.equal(patched.body.hra, 8000, 'unrelated fields are preserved');

    const badPatch = await h.client.patch(`/api/employees/${created.id}`, {
      basic: -10,
      name: 'Should Not Persist',
    });
    assert.equal(badPatch.status, 400);
    assert.equal((await h.client.get(`/api/employees/${created.id}`)).body.name, 'Nisha Sharma');
  } finally {
    await h.close();
  }
});

test('employee role gets 403 on /api/employees and org lists; anonymous gets 401', async () => {
  const h = await setup('employee');
  try {
    assert.equal((await h.client.get('/api/employees')).status, 403);
    assert.equal((await h.client.get('/api/employees/1')).status, 403);
    assert.equal((await h.client.post('/api/employees', NEW_EMPLOYEE)).status, 403);
    assert.equal((await h.client.get('/api/departments')).status, 403);
  } finally {
    await h.close();
  }

  const anonymous = await setup(null);
  try {
    assert.equal((await anonymous.client.get('/api/employees')).status, 401);
  } finally {
    await anonymous.close();
  }
});

test('unknown employee id returns 404 for GET, PATCH and DELETE', async () => {
  const h = await setup('hr');
  try {
    assert.equal((await h.client.get('/api/employees/999999')).status, 404);
    assert.equal((await h.client.patch('/api/employees/999999', { name: 'Ghost' })).status, 404);
    assert.equal((await h.client.delete('/api/employees/999999')).status, 404);
  } finally {
    await h.close();
  }
});

test('GET /api/employees supports ?status= and ?department= filters', async () => {
  const h = await setup('hr');
  try {
    assert.equal((await h.client.get('/api/employees?status=active')).body.length, 3);
    assert.equal((await h.client.get('/api/employees?status=retired')).body.length, 0);

    const byDeptId = await h.client.get('/api/employees?department=1');
    assert.equal(byDeptId.body.length, 2);
    assert.ok(byDeptId.body.every((row) => row.department_id === 1));

    const byDeptName = await h.client.get('/api/employees?department=Engineering');
    assert.equal(byDeptName.body.length, 2);

    await createEmployee(h.client, {
      code: 'EMP101',
      name: 'Inactive One',
      status: 'inactive',
    });
    assert.equal((await h.client.get('/api/employees?status=inactive')).body.length, 1);
    assert.equal((await h.client.get('/api/employees?status=active')).body.length, 3);
  } finally {
    await h.close();
  }
});

test('DELETE /api/employees/:id removes the row', async () => {
  const h = await setup('hr');
  try {
    const created = await createEmployee(h.client);
    const removed = await h.client.delete(`/api/employees/${created.id}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.ok, true);
    assert.equal((await h.client.get(`/api/employees/${created.id}`)).status, 404);
  } finally {
    await h.close();
  }
});

test('status null and empty string on POST are 400, not a raw SQLite 500', async () => {
  const h = await setup('hr');
  try {
    for (const [code, status] of [
      ['BAD_STATUS_NULL', null],
      ['BAD_STATUS_EMPTY', ''],
    ]) {
      const response = await h.client.post('/api/employees', {
        ...NEW_EMPLOYEE,
        code,
        status,
      });
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.ok(response.body.error, 'a 400 must still carry an error message');
      assert.doesNotMatch(
        response.body.error,
        /no such column|has no column named|NOT NULL constraint|UNIQUE constraint|SQLITE|constraint failed/i,
      );
    }
    // Neither rejected request stored a row.
    assert.equal((await h.client.get('/api/employees')).body.length, 3);
  } finally {
    await h.close();
  }
});

test('an unknown column passed to a repo helper from a handler is a clean 400', async () => {
  const h = await setup('hr');
  try {
    // Routes may be added after listen(): the router holds a mutable list.
    h.server.router.register('POST', '/api/_bad-column', ['admin', 'hr'], async ({ db }) => {
      insertRow(db, 'employees', {
        code: 'BAD_COLUMN',
        name: 'Bad Column',
        joining_date: '2026-01-01',
        bogus_column: 'x',
      });
      return { status: 200, body: {} };
    });

    const response = await h.client.post('/api/_bad-column', {});
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.doesNotMatch(
      response.body.error,
      /no such column|has no column named|SQLITE|NOT NULL constraint/i,
    );
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Org lists
// ---------------------------------------------------------------------------

test('org routes list departments and designations for hr/admin', async () => {
  const h = await setup('hr');
  try {
    const departments = await h.client.get('/api/departments');
    assert.equal(departments.status, 200);
    assert.deepEqual(
      departments.body.map((row) => row.name).sort(),
      ['Engineering', 'Human Resources'],
    );

    const designations = await h.client.get('/api/designations');
    assert.equal(designations.status, 200);
    assert.deepEqual(
      designations.body.map((row) => row.name).sort(),
      ['HR Manager', 'Software Engineer'],
    );
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

/** Seed `employee` is linked to employee id 3; `hr` to id 2; `admin` to none. */
const EXPENSE_EMPLOYEE_ID = 3;

async function setupExpenses(role = 'hr') {
  const db = makeDb();
  const server = startServer({
    db,
    registerRoutes: (router) => {
      registerExpenseRoutes(router);
    },
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
    makeClient: () => makeClient(server),
    close: async () => {
      await close(server);
      db.close();
    },
  };
}

/** A second, independently-authenticated client against the same server. */
async function loginAs(h, role) {
  const client = h.makeClient();
  const login = await client.post('/api/auth/login', { username: role, password: 'admin123' });
  assert.equal(login.status, 200, `login as ${role} should succeed`);
  return client;
}

test('employee POST /api/expenses submits a pending 1200 claim for themselves', async () => {
  const h = await setupExpenses('employee');
  try {
    const res = await h.client.post('/api/expenses', {
      category: 'Travel',
      amount: 1200,
      receipt_note: 'Taxi to client site',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.category, 'Travel');
    assert.equal(res.body.receipt_note, 'Taxi to client site');
    assert.equal(res.body.amount, 1200);
    assert.equal(res.body.status, 'pending');
    assert.equal(res.body.employee_id, EXPENSE_EMPLOYEE_ID);
    assert.ok(Number.isInteger(res.body.id) && res.body.id > 0);

    const stored = getRow(h.db, 'expenses', res.body.id);
    assert.equal(stored.amount, 1200);
    assert.equal(stored.status, 'pending');
  } finally {
    await h.close();
  }
});

test('negative, non-numeric and missing expense amounts are rejected with 400', async () => {
  const h = await setupExpenses('employee');
  try {
    for (const amount of [-1, -0.5, 'abc', null]) {
      const res = await h.client.post('/api/expenses', { category: 'Travel', amount });
      assert.equal(res.status, 400, `amount ${JSON.stringify(amount)} → ${JSON.stringify(res.body)}`);
    }
    const missing = await h.client.post('/api/expenses', { category: 'Travel' });
    assert.equal(missing.status, 400);
    const noCategory = await h.client.post('/api/expenses', { amount: 100 });
    assert.equal(noCategory.status, 400);

    // Nothing rejected was persisted.
    assert.equal((await h.client.get('/api/expenses')).body.length, 0);
  } finally {
    await h.close();
  }
});

test('HR approves or rejects a claim; an employee cannot approve (even their own)', async () => {
  const h = await setupExpenses('employee');
  try {
    const hr = await loginAs(h, 'hr');
    const created = await h.client.post('/api/expenses', { category: 'Travel', amount: 1200 });
    assert.equal(created.status, 201);
    const id = created.body.id;

    // Decision routes are HR/admin only — an employee cannot approve their own.
    assert.equal(
      (await h.client.post(`/api/expenses/${id}/decision`, { action: 'approve' })).status,
      403,
    );

    const approved = await hr.post(`/api/expenses/${id}/decision`, { action: 'approve' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, 'approved');
    assert.ok(approved.body.decided_by > 0);
    assert.ok(approved.body.decided_at);

    // A decided claim cannot be decided again, and invalid inputs are 400/404.
    assert.equal((await hr.post(`/api/expenses/${id}/decision`, { action: 'reject' })).status, 409);
    assert.equal((await hr.post(`/api/expenses/${id}/decision`, { action: 'maybe' })).status, 400);
    assert.equal((await hr.post('/api/expenses/999999/decision', { action: 'approve' })).status, 404);

    const second = await h.client.post('/api/expenses', { category: 'Meals', amount: 500 });
    assert.equal(second.status, 201);
    const rejected = await hr.post(`/api/expenses/${second.body.id}/decision`, { action: 'reject' });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.status, 'rejected');
  } finally {
    await h.close();
  }
});

test('HR flags an approved expense with a reimbursement month/year for payroll', async () => {
  const h = await setupExpenses('hr');
  try {
    // HR submits on behalf of employee 3, approves, then flags for January 2026.
    const created = await h.client.post('/api/expenses', {
      employeeId: EXPENSE_EMPLOYEE_ID,
      category: 'Travel',
      amount: 1200,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id;
    assert.equal((await h.client.post(`/api/expenses/${id}/decision`, { action: 'approve' })).status, 200);

    const flagged = await h.client.post(`/api/expenses/${id}/flag-reimbursement`, {
      month: 1,
      year: 2026,
    });
    assert.equal(flagged.status, 200, JSON.stringify(flagged.body));
    assert.equal(flagged.body.status, 'approved');
    assert.equal(flagged.body.reimbursement_month, 1);
    assert.equal(flagged.body.reimbursement_year, 2026);

    const row = getRow(h.db, 'expenses', id);
    assert.equal(row.reimbursement_month, 1, 'flag fields persisted for Task 6 to query');
    assert.equal(row.reimbursement_year, 2026);

    // Invalid month/year, non-approved claim and unknown id are rejected.
    assert.equal(
      (await h.client.post(`/api/expenses/${id}/flag-reimbursement`, { month: 13, year: 2026 })).status,
      400,
    );
    assert.equal(
      (await h.client.post('/api/expenses/999999/flag-reimbursement', { month: 1, year: 2026 })).status,
      404,
    );
    const pendingId = (
      await h.client.post('/api/expenses', {
        employeeId: EXPENSE_EMPLOYEE_ID,
        category: 'Meals',
        amount: 300,
      })
    ).body.id;
    assert.equal(
      (await h.client.post(`/api/expenses/${pendingId}/flag-reimbursement`, { month: 1, year: 2026 })).status,
      409,
    );

    // Employees cannot flag, and admin (also HR-role) can.
    const employee = await loginAs(h, 'employee');
    assert.equal(
      (await employee.post(`/api/expenses/${id}/flag-reimbursement`, { month: 1, year: 2026 })).status,
      403,
    );
    const admin = await loginAs(h, 'admin');
    assert.equal(
      (await admin.post(`/api/expenses/${id}/flag-reimbursement`, { month: 1, year: 2026 })).status,
      200,
    );
  } finally {
    await h.close();
  }
});

test('GET /api/expenses is own-only for employees and filterable for HR', async () => {
  const h = await setupExpenses('employee');
  try {
    const hr = await loginAs(h, 'hr');
    const own = await h.client.post('/api/expenses', { category: 'Travel', amount: 1200 });
    assert.equal(own.status, 201);
    const other = await hr.post('/api/expenses', { employeeId: 1, category: 'Meals', amount: 400 });
    assert.equal(other.status, 201);

    const empList = await h.client.get('/api/expenses');
    assert.equal(empList.status, 200);
    assert.equal(empList.body.length, 1);
    assert.equal(empList.body[0].employee_id, EXPENSE_EMPLOYEE_ID);

    const hrList = await hr.get('/api/expenses');
    assert.equal(hrList.body.length, 2);

    const byEmployee = await hr.get('/api/expenses?employeeId=1');
    assert.equal(byEmployee.body.length, 1);
    assert.equal(byEmployee.body[0].employee_id, 1);

    const byStatus = await hr.get('/api/expenses?status=pending');
    assert.equal(byStatus.body.length, 2);
    assert.equal((await hr.get('/api/expenses?status=reimbursed')).body.length, 0);
    assert.equal((await hr.get('/api/expenses?employeeId=abc')).status, 400);
  } finally {
    await h.close();
  }
});
