import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeClient } from './helpers.js';
import { startServer } from '../server.js';
import { registerEmployeeRoutes, registerOrgRoutes } from '../api/employees.js';
import { registerExpenseRoutes } from '../api/expenses.js';
import { getRow, insertRow } from '../lib/repo.js';
import { hashPassword } from '../lib/auth.js';

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

test('an explicitly invalid employeeId on submit is 400 (submit agrees with list)', async () => {
  const h = await setupExpenses('hr');
  try {
    // An explicitly supplied id must be a positive integer. Silently falling
    // back to the caller's own id would misattribute the claim and hide the
    // bad input, while GET already 400s the same values.
    for (const employeeId of ['abc', 0, -1, true, [1], null]) {
      const res = await h.client.post('/api/expenses', {
        employeeId,
        category: 'Travel',
        amount: 1200,
      });
      assert.equal(
        res.status,
        400,
        `employeeId ${JSON.stringify(employeeId)} → ${JSON.stringify(res.body)}`,
      );
      assert.match(res.body.error, /employeeId/i);
    }
    assert.equal((await h.client.get('/api/expenses')).body.length, 0);

    // Valid numeric and numeric-string ids still work for HR/admin.
    const numeric = await h.client.post('/api/expenses', {
      employeeId: 1,
      category: 'Travel',
      amount: 100,
    });
    assert.equal(numeric.status, 201, JSON.stringify(numeric.body));
    assert.equal(numeric.body.employee_id, 1);

    const asString = await h.client.post('/api/expenses', {
      employeeId: '3',
      category: 'Meals',
      amount: 200,
    });
    assert.equal(asString.status, 201, JSON.stringify(asString.body));
    assert.equal(asString.body.employee_id, 3);

    // Omitting employeeId still falls back to the caller's own linked employee.
    const fallback = await h.client.post('/api/expenses', { category: 'Travel', amount: 50 });
    assert.equal(fallback.status, 201, JSON.stringify(fallback.body));
    assert.equal(fallback.body.employee_id, 2);

    assert.equal((await h.client.get('/api/expenses')).body.length, 3);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** Seed ids: the `employee` account is linked to employee id 3. */
const TASK_ASSIGNEE_EMPLOYEE_ID = 3;

async function setupTasks(role = 'hr') {
  // Dynamic import keeps the other API tests loadable during RED, while the
  // tasks module does not exist yet. Only the task tests should fail before
  // the module is implemented.
  const { registerTaskRoutes } = await import('../api/tasks.js');
  const db = makeDb();
  const server = startServer({
    db,
    registerRoutes: (router) => {
      registerTaskRoutes(router);
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

/** Add a fresh employee-role user linked to a different employee and log in. */
async function loginAsOtherEmployee(h, username, employeeId) {
  const { salt, hash } = hashPassword('admin123');
  insertRow(h.db, 'users', {
    username,
    password_hash: hash,
    salt,
    role: 'employee',
    employee_id: employeeId,
  });
  const client = h.makeClient();
  const login = await client.post('/api/auth/login', { username, password: 'admin123' });
  assert.equal(login.status, 200, `login as ${username} should succeed`);
  return client;
}

async function createTask(client, overrides = {}) {
  const res = await client.post('/api/tasks', {
    title: 'Quarterly report',
    description: 'Prepare the Q1 report',
    assigned_to: TASK_ASSIGNEE_EMPLOYEE_ID,
    due_date: '2099-06-30',
    priority: 'high',
    ...overrides,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test('HR assigns a task; the assignee sees it via ?mine=1 and can change its status', async () => {
  const h = await setupTasks('hr');
  try {
    const created = await createTask(h.client);
    assert.ok(Number.isInteger(created.id) && created.id > 0);
    assert.equal(created.status, 'open');
    assert.equal(created.priority, 'high');
    assert.equal(created.assigned_to, TASK_ASSIGNEE_EMPLOYEE_ID);
    assert.ok(created.assigned_by > 0, 'the creator is recorded');
    assert.equal(created.overdue, false);
    assert.equal(getRow(h.db, 'tasks', created.id).assigned_to, TASK_ASSIGNEE_EMPLOYEE_ID);

    const employee = await loginAs(h, 'employee');
    const mine = await employee.get('/api/tasks?mine=1');
    assert.equal(mine.status, 200);
    assert.equal(mine.body.length, 1);
    assert.equal(mine.body[0].id, created.id);

    const ownList = await employee.get('/api/tasks');
    assert.equal(ownList.body.length, 1, 'employees only ever see their own tasks');
    assert.equal(ownList.body[0].id, created.id);

    const changed = await employee.patch(`/api/tasks/${created.id}`, { status: 'in_progress' });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.status, 'in_progress');
    assert.equal(getRow(h.db, 'tasks', created.id).status, 'in_progress');

    // An assignee may change status, but not the task's other fields.
    const forbiddenField = await employee.patch(`/api/tasks/${created.id}`, { assigned_to: 1 });
    assert.equal(forbiddenField.status, 403, 'assignees may only change status');
    assert.equal(getRow(h.db, 'tasks', created.id).assigned_to, TASK_ASSIGNEE_EMPLOYEE_ID);
  } finally {
    await h.close();
  }
});

test('only the assignee may change task status; a non-assignee employee gets 403', async () => {
  const h = await setupTasks('hr');
  try {
    const created = await createTask(h.client);
    const other = await loginAsOtherEmployee(h, 'employee2', 1);

    const forbidden = await other.patch(`/api/tasks/${created.id}`, { status: 'done' });
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
    assert.equal(getRow(h.db, 'tasks', created.id).status, 'open', 'status is unchanged');

    // The real assignee can still transition the task.
    const employee = await loginAs(h, 'employee');
    assert.equal(
      (await employee.patch(`/api/tasks/${created.id}`, { status: 'done' })).status,
      200,
    );
  } finally {
    await h.close();
  }
});

test('invalid due_date is rejected with 400 on create and update', async () => {
  const h = await setupTasks('hr');
  try {
    const bad = await h.client.post('/api/tasks', {
      title: 'Bad date task',
      assigned_to: TASK_ASSIGNEE_EMPLOYEE_ID,
      due_date: '2026-02-30',
    });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.match(bad.body.error, /due_date/i);

    const created = await createTask(h.client);
    const badPatch = await h.client.patch(`/api/tasks/${created.id}`, { due_date: '2026-13-40' });
    assert.equal(badPatch.status, 400);
    assert.equal(getRow(h.db, 'tasks', created.id).due_date, '2099-06-30', 'bad patch not stored');

    // A valid leap day is accepted and a missing due_date is allowed.
    const leap = await h.client.post('/api/tasks', {
      title: 'Leap day',
      assigned_to: TASK_ASSIGNEE_EMPLOYEE_ID,
      due_date: '2024-02-29',
    });
    assert.equal(leap.status, 201, JSON.stringify(leap.body));
    const noDue = await createTask(h.client, { due_date: null });
    assert.equal(noDue.due_date, null);
  } finally {
    await h.close();
  }
});

test('overdue is computed from due_date and suppressed for terminal statuses', async () => {
  const h = await setupTasks('hr');
  try {
    const overdue = await createTask(h.client, {
      title: 'Late open',
      due_date: '2020-01-01',
      status: 'open',
    });
    assert.equal(overdue.overdue, true, 'past-due open task is overdue');

    const done = await createTask(h.client, {
      title: 'Late done',
      due_date: '2020-01-01',
      status: 'done',
    });
    assert.equal(done.overdue, false, 'a completed task is never overdue');

    const cancelled = await createTask(h.client, {
      title: 'Late cancelled',
      due_date: '2020-01-01',
      status: 'cancelled',
    });
    assert.equal(cancelled.overdue, false, 'a cancelled task is never overdue');

    const future = await createTask(h.client, { title: 'Future', due_date: '2099-01-01' });
    assert.equal(future.overdue, false);

    const noDue = await createTask(h.client, { title: 'No due date', due_date: null });
    assert.equal(noDue.overdue, false);

    const list = await h.client.get('/api/tasks');
    const byId = Object.fromEntries(list.body.map((t) => [t.id, t]));
    assert.equal(byId[overdue.id].overdue, true);
    assert.equal(byId[done.id].overdue, false);
    assert.equal(byId[cancelled.id].overdue, false);
    assert.equal(byId[future.id].overdue, false);
    assert.equal(byId[noDue.id].overdue, false);

    const fetched = await h.client.get(`/api/tasks/${overdue.id}`);
    assert.equal(fetched.body.overdue, true, 'overdue is present on GET :id too');
  } finally {
    await h.close();
  }
});

test('comments can be added to and listed on a task', async () => {
  const h = await setupTasks('hr');
  try {
    const created = await createTask(h.client);
    const employee = await loginAs(h, 'employee');

    const empty = await employee.post(`/api/tasks/${created.id}/comments`, { comment: '   ' });
    assert.equal(empty.status, 400);

    const added = await employee.post(`/api/tasks/${created.id}/comments`, {
      comment: 'Started today',
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.comment, 'Started today');
    assert.equal(added.body.user_id, 3, 'comment is attributed to the signed-in user');
    assert.equal(added.body.task_id, created.id);

    const listed = await employee.get(`/api/tasks/${created.id}/comments`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 1);
    assert.equal(listed.body[0].comment, 'Started today');
    assert.ok(listed.body[0].created_at);

    assert.equal(
      (await h.client.post('/api/tasks/999999/comments', { comment: 'x' })).status,
      404,
    );
    assert.equal((await h.client.get('/api/tasks/999999/comments')).status, 404);
  } finally {
    await h.close();
  }
});

test('task CRUD, role enforcement and anonymous access', async () => {
  const h = await setupTasks('hr');
  try {
    const created = await createTask(h.client, { priority: 'low' });
    assert.equal((await h.client.get(`/api/tasks/${created.id}`)).body.title, 'Quarterly report');

    const patched = await h.client.patch(`/api/tasks/${created.id}`, {
      title: 'Renamed',
      priority: 'urgent',
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.title, 'Renamed');
    assert.equal(patched.body.priority, 'urgent');
    assert.equal(patched.body.description, 'Prepare the Q1 report', 'unrelated fields preserved');

    const admin = await loginAs(h, 'admin');
    assert.equal(
      (await admin.post('/api/tasks', { title: 'Admin task', assigned_to: 3 })).status,
      201,
    );

    const employee = await loginAs(h, 'employee');
    assert.equal(
      (await employee.post('/api/tasks', { title: 'Nope', assigned_to: 3 })).status,
      403,
      'only HR/admin may create tasks',
    );
    assert.equal((await employee.delete(`/api/tasks/${created.id}`)).status, 403);

    assert.equal((await h.client.delete(`/api/tasks/${created.id}`)).status, 200);
    assert.equal((await h.client.get(`/api/tasks/${created.id}`)).status, 404);
    assert.equal((await h.client.patch('/api/tasks/999999', { status: 'done' })).status, 404);
    assert.equal((await h.client.delete('/api/tasks/999999')).status, 404);
  } finally {
    await h.close();
  }

  const anonymous = await setupTasks(null);
  try {
    assert.equal((await anonymous.client.get('/api/tasks')).status, 401);
    assert.equal((await anonymous.client.post('/api/tasks', { title: 'x' })).status, 401);
  } finally {
    await anonymous.close();
  }
});

test('an employee with no linked employee id cannot view or status-change an unassigned task', async () => {
  const h = await setupTasks('hr');
  try {
    // tasks.assigned_to is nullable; create an unassigned task via the repo
    // helper. A raw null !== null comparison would let an unlinked employee
    // account read it and advance its status.
    const taskId = insertRow(h.db, 'tasks', {
      title: 'Unassigned',
      assigned_to: null,
      assigned_by: 2,
      status: 'open',
    });
    const unlinked = await loginAsOtherEmployee(h, 'employee_unlinked', null);

    // normalize through ownEmployeeId → coherent 400 for an unlinked account.
    assert.equal((await unlinked.get('/api/tasks')).status, 400);
    assert.equal((await unlinked.get(`/api/tasks/${taskId}`)).status, 400);
    assert.equal((await unlinked.get(`/api/tasks/${taskId}/comments`)).status, 400);
    assert.equal(
      (await unlinked.patch(`/api/tasks/${taskId}`, { status: 'done' })).status,
      400,
    );
    assert.equal(getRow(h.db, 'tasks', taskId).status, 'open', 'status unchanged');
  } finally {
    await h.close();
  }
});

test('deleting a task removes its comments but leaves other tasks comments intact', async () => {
  const h = await setupTasks('hr');
  try {
    const created = await createTask(h.client);
    const employee = await loginAs(h, 'employee');
    const first = await employee.post(`/api/tasks/${created.id}/comments`, { comment: 'First' });
    const second = await h.client.post(`/api/tasks/${created.id}/comments`, { comment: 'Second' });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal((await h.client.get(`/api/tasks/${created.id}/comments`)).body.length, 2);

    const other = await createTask(h.client, { title: 'Other task' });
    const kept = await h.client.post(`/api/tasks/${other.id}/comments`, { comment: 'Keep me' });
    assert.equal(kept.status, 201);

    assert.equal((await h.client.delete(`/api/tasks/${created.id}`)).status, 200);
    assert.equal(getRow(h.db, 'tasks', created.id), null, 'task deleted');
    assert.equal(getRow(h.db, 'task_comments', first.body.id), null, 'first comment removed');
    assert.equal(getRow(h.db, 'task_comments', second.body.id), null, 'second comment removed');
    assert.notEqual(getRow(h.db, 'task_comments', kept.body.id), null, 'other task comment kept');

    // Deleting a task with no comments still works; unknown ids still 404.
    assert.equal((await h.client.delete(`/api/tasks/${other.id}`)).status, 200);
    assert.equal((await h.client.delete('/api/tasks/999999')).status, 404);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/** Seed `employee` is linked to employee id 3; `hr` to id 2; `admin` to none. */
const ASSET_EMPLOYEE_ID = 3;

async function setupAssets(role = 'hr') {
  // Dynamic import keeps the other API tests loadable during RED, while the
  // assets module does not exist yet. Only the asset tests should fail first.
  const { registerAssetRoutes } = await import('../api/assets.js');
  const db = makeDb();
  const server = startServer({
    db,
    registerRoutes: (router) => {
      registerAssetRoutes(router);
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

async function createAsset(client, overrides = {}) {
  const res = await client.post('/api/assets', {
    name: 'ThinkPad X1',
    type: 'Laptop',
    serial: 'SN-1001',
    purchase_date: '2026-01-10',
    value: 85000,
    ...overrides,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test('HR creates an asset with available status and reads it back', async () => {
  const h = await setupAssets('hr');
  try {
    const created = await createAsset(h.client);
    assert.ok(Number.isInteger(created.id) && created.id > 0);
    assert.equal(created.name, 'ThinkPad X1');
    assert.equal(created.serial, 'SN-1001');
    assert.equal(created.value, 85000);
    assert.equal(created.status, 'available', 'a new asset starts available');

    const list = await h.client.get('/api/assets');
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].id, created.id);

    const fetched = await h.client.get(`/api/assets/${created.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.name, 'ThinkPad X1');
    assert.equal(getRow(h.db, 'assets', created.id).status, 'available');

    // Optional columns may be omitted; value defaults to 0 and type/serial to null.
    const minimal = await h.client.post('/api/assets', { name: 'Mouse' });
    assert.equal(minimal.status, 201, JSON.stringify(minimal.body));
    assert.equal(minimal.body.value, 0);
    assert.equal(minimal.body.type, null);
    assert.equal(minimal.body.status, 'available');
  } finally {
    await h.close();
  }
});

test('assigning an asset flips availability to assigned, return restores available, history is recorded', async () => {
  const h = await setupAssets('hr');
  try {
    const asset = await createAsset(h.client);

    const assigned = await h.client.post(`/api/assets/${asset.id}/assign`, {
      employeeId: ASSET_EMPLOYEE_ID,
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    assert.equal(assigned.body.asset_id, asset.id);
    assert.equal(assigned.body.employee_id, ASSET_EMPLOYEE_ID);
    assert.equal(assigned.body.status, 'assigned');
    assert.ok(assigned.body.assigned_at, 'assignment timestamp is recorded');
    assert.equal(assigned.body.returned_at, null);

    assert.equal((await h.client.get(`/api/assets/${asset.id}`)).body.status, 'assigned');
    assert.equal(getRow(h.db, 'assets', asset.id).status, 'assigned');
    assert.equal(getRow(h.db, 'asset_assignments', assigned.body.id).status, 'assigned');

    const history = await h.client.get(`/api/assets/${asset.id}/history`);
    assert.equal(history.status, 200);
    assert.equal(history.body.length, 1);
    assert.equal(history.body[0].id, assigned.body.id);

    const returned = await h.client.post(`/api/assets/${asset.id}/return`, {});
    assert.equal(returned.status, 200, JSON.stringify(returned.body));
    assert.equal(returned.body.status, 'returned');
    assert.ok(returned.body.returned_at, 'return timestamp is recorded');

    assert.equal((await h.client.get(`/api/assets/${asset.id}`)).body.status, 'available');
    assert.equal(getRow(h.db, 'assets', asset.id).status, 'available');
    assert.equal(getRow(h.db, 'asset_assignments', assigned.body.id).status, 'returned');

    const historyAfter = await h.client.get(`/api/assets/${asset.id}/history`);
    assert.equal(historyAfter.body.length, 1, 'returning does not erase history');
    assert.equal(historyAfter.body[0].status, 'returned');
    assert.ok(historyAfter.body[0].returned_at);

    // Re-assigning after a return creates a second, separate history row.
    const second = await h.client.post(`/api/assets/${asset.id}/assign`, { employeeId: 1 });
    assert.equal(second.status, 201);
    const fullHistory = await h.client.get(`/api/assets/${asset.id}/history`);
    assert.equal(fullHistory.body.length, 2);
    assert.deepEqual(
      fullHistory.body.map((row) => row.status),
      ['assigned', 'returned'],
      'newest assignment is listed first',
    );
  } finally {
    await h.close();
  }
});

test('assigning an unavailable asset returns 409 and records no extra assignment', async () => {
  const h = await setupAssets('hr');
  try {
    const asset = await createAsset(h.client);
    const first = await h.client.post(`/api/assets/${asset.id}/assign`, {
      employeeId: ASSET_EMPLOYEE_ID,
    });
    assert.equal(first.status, 201);

    const conflict = await h.client.post(`/api/assets/${asset.id}/assign`, { employeeId: 1 });
    assert.equal(conflict.status, 409, 'a second assignment is rejected');
    assert.match(conflict.body.error, /availab/i);
    assert.equal((await h.client.get(`/api/assets/${asset.id}/history`)).body.length, 1);
    assert.equal(getRow(h.db, 'assets', asset.id).status, 'assigned', 'status is unchanged');

    await h.client.post(`/api/assets/${asset.id}/return`, {});
    const returnAgain = await h.client.post(`/api/assets/${asset.id}/return`, {});
    assert.equal(returnAgain.status, 409, 'returning an unassigned asset is a conflict');
    assert.equal((await h.client.get(`/api/assets/${asset.id}/history`)).body.length, 1);

    // Unknown asset / employee are 404; a bad employee id leaves the asset available.
    assert.equal((await h.client.post('/api/assets/999999/assign', { employeeId: 1 })).status, 404);
    assert.equal(
      (await h.client.post(`/api/assets/${asset.id}/assign`, { employeeId: 999999 })).status,
      404,
    );
    assert.equal(getRow(h.db, 'assets', asset.id).status, 'available', 'failed assign did not flip status');
  } finally {
    await h.close();
  }
});

test('asset PATCH, DELETE and filters behave; invalid fields are 400', async () => {
  const h = await setupAssets('hr');
  try {
    const asset = await createAsset(h.client);

    const patched = await h.client.patch(`/api/assets/${asset.id}`, {
      name: 'ThinkPad X1 Gen 2',
      value: 90000,
      purchase_date: '2026-02-28',
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.name, 'ThinkPad X1 Gen 2');
    assert.equal(patched.body.value, 90000);
    assert.equal(patched.body.type, 'Laptop', 'unrelated fields are preserved');

    for (const overrides of [
      { purchase_date: '2026-02-30' },
      { value: -1 },
      { name: '   ' },
      { type: { nope: true } },
    ]) {
      const bad = await h.client.patch(`/api/assets/${asset.id}`, overrides);
      assert.equal(bad.status, 400, JSON.stringify(overrides));
    }
    assert.equal(getRow(h.db, 'assets', asset.id).name, 'ThinkPad X1 Gen 2', 'bad patches not stored');

    const monitor = await createAsset(h.client, {
      name: 'Dell Monitor',
      type: 'Monitor',
      serial: 'SN-2002',
      value: 15000,
    });
    assert.equal((await h.client.get('/api/assets?type=Monitor')).body.length, 1);
    assert.equal((await h.client.get('/api/assets?status=available')).body.length, 2);
    assert.equal((await h.client.get('/api/assets?status=assigned')).body.length, 0);

    assert.equal((await h.client.get('/api/assets/999999')).status, 404);
    assert.equal((await h.client.patch('/api/assets/999999', { name: 'Ghost' })).status, 404);
    assert.equal((await h.client.delete('/api/assets/999999')).status, 404);
    assert.equal((await h.client.get('/api/assets/999999/history')).status, 404);

    const assignment = await h.client.post(`/api/assets/${asset.id}/assign`, { employeeId: 1 });
    assert.equal(assignment.status, 201);
    assert.equal((await h.client.delete(`/api/assets/${asset.id}`)).status, 200);
    assert.equal(getRow(h.db, 'assets', asset.id), null, 'asset deleted');
    assert.equal(getRow(h.db, 'asset_assignments', assignment.body.id), null, 'history cleaned up');
    assert.equal((await h.client.get(`/api/assets/${asset.id}`)).status, 404);
    assert.ok(getRow(h.db, 'assets', monitor.id), 'other assets are untouched');
  } finally {
    await h.close();
  }
});

test('asset routes enforce roles: employee gets 403, anonymous gets 401', async () => {
  const h = await setupAssets('employee');
  try {
    const hr = h.makeClient();
    const hrLogin = await hr.post('/api/auth/login', { username: 'hr', password: 'admin123' });
    assert.equal(hrLogin.status, 200);
    const asset = await createAsset(hr);
    assert.equal((await h.client.get('/api/assets')).status, 403);
    assert.equal((await h.client.post('/api/assets', { name: 'Nope' })).status, 403);
    assert.equal((await h.client.get(`/api/assets/${asset.id}`)).status, 403);
    assert.equal((await h.client.patch(`/api/assets/${asset.id}`, { name: 'Nope' })).status, 403);
    assert.equal((await h.client.delete(`/api/assets/${asset.id}`)).status, 403);
    assert.equal((await h.client.post(`/api/assets/${asset.id}/assign`, { employeeId: 1 })).status, 403);
    assert.equal((await h.client.post(`/api/assets/${asset.id}/return`, {})).status, 403);
    assert.equal((await h.client.get(`/api/assets/${asset.id}/history`)).status, 403);
  } finally {
    await h.close();
  }

  const anonymous = await setupAssets(null);
  try {
    assert.equal((await anonymous.client.get('/api/assets')).status, 401);
    assert.equal((await anonymous.client.post('/api/assets', { name: 'Nope' })).status, 401);
    assert.equal((await anonymous.client.get('/api/assets/1/history')).status, 401);
  } finally {
    await anonymous.close();
  }
});

test('strict ids on asset assign reject type-confused employee ids and malformed asset ids', async () => {
  const h = await setupAssets('hr');
  try {
    const asset = await createAsset(h.client);
    for (const employeeId of ['abc', 0, -1, true, [1], null, 1.5]) {
      const res = await h.client.post(`/api/assets/${asset.id}/assign`, { employeeId });
      assert.equal(res.status, 400, `employeeId ${JSON.stringify(employeeId)} → ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, /employeeId/i);
    }
    assert.equal(getRow(h.db, 'assets', asset.id).status, 'available', 'nothing was assigned');

    // Numeric strings are still accepted, and path ids are strict too.
    const ok = await h.client.post(`/api/assets/${asset.id}/assign`, { employeeId: '3' });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.employee_id, ASSET_EMPLOYEE_ID);
    assert.equal((await h.client.get('/api/assets/abc/history')).status, 400);
    assert.equal((await h.client.post('/api/assets/1.5/return', {})).status, 400);
    assert.equal((await h.client.post('/api/assets/true/assign', { employeeId: 1 })).status, 400);
  } finally {
    await h.close();
  }
});
