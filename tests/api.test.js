import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeClient } from './helpers.js';
import { startServer } from '../server.js';
import { registerEmployeeRoutes, registerOrgRoutes } from '../api/employees.js';
import { insertRow } from '../lib/repo.js';

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
