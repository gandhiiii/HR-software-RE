import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeClient } from './helpers.js';
import { startServer } from '../server.js';
import { applyLeaveDecision } from '../lib/calc/leave.js';
import { registerLeaveRoutes } from '../api/leave.js';

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

/** Listening server with only the leave routes registered on top of auth. */
async function setup(role = 'hr') {
  const db = makeDb();
  const server = startServer({
    db,
    registerRoutes: (router) => registerLeaveRoutes(router),
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

function balanceOf(body, leaveTypeId) {
  return body.find((row) => row.leave_type_id === leaveTypeId);
}

// ---------------------------------------------------------------------------
// Pure calculation boundaries (Step 1 of the task brief)
// ---------------------------------------------------------------------------

test('applyLeaveDecision: approving 3 days from balance 10 yields used 3/remaining 7', () => {
  const result = applyLeaveDecision({
    balance: { opening_balance: 10, used: 0, remaining: 10 },
    days: 3,
    action: 'approve',
  });
  assert.deepEqual(result, { used: 3, remaining: 7 });
});

test('applyLeaveDecision: approving 12 days from balance 10 throws (beyond balance)', () => {
  assert.throws(
    () =>
      applyLeaveDecision({
        balance: { opening_balance: 10, used: 0, remaining: 10 },
        days: 12,
        action: 'approve',
      }),
    (error) => error.status === 409 || error.status === 400,
    'over-balance approval throws a 4xx',
  );
});

test('applyLeaveDecision: rejecting an approved request of 3 days restores used to 0', () => {
  const result = applyLeaveDecision({
    balance: { opening_balance: 10, used: 3, remaining: 7 },
    days: 3,
    action: 'reject',
  });
  assert.deepEqual(result, { used: 0, remaining: 10 });
});

test('applyLeaveDecision: rejects invalid action and non-positive days', () => {
  const balance = { opening_balance: 10, used: 0, remaining: 10 };
  assert.throws(() => applyLeaveDecision({ balance, days: 1, action: 'maybe' }));
  assert.throws(() => applyLeaveDecision({ balance, days: 0, action: 'approve' }));
  assert.throws(() => applyLeaveDecision({ balance, days: -1, action: 'approve' }));
  assert.throws(() => applyLeaveDecision({ balance, days: 'three', action: 'approve' }));
});

test('applyLeaveDecision: a zero-opening balance (Unpaid) is not constrained', () => {
  const result = applyLeaveDecision({
    balance: { opening_balance: 0, used: 0, remaining: 0 },
    days: 3,
    action: 'approve',
  });
  assert.equal(result.used, 3);
  assert.equal(result.remaining, -3, 'negative remaining records days taken without pay');
});

// ---------------------------------------------------------------------------
// Reference endpoints
// ---------------------------------------------------------------------------

test('GET /api/leave/types lists the four seeded leave types for all roles', async () => {
  for (const role of ['admin', 'hr', 'employee']) {
    const h = await setup(role);
    try {
      const types = await h.client.get('/api/leave/types');
      assert.equal(types.status, 200);
      assert.equal(types.body.length, 4);
      assert.deepEqual(
        types.body.map((row) => row.name).sort(),
        ['Casual', 'Earned', 'Sick', 'Unpaid'],
      );
    } finally {
      await h.close();
    }
  }
});

test('GET /api/leave/balances scopes employees to own, HR to all, with type names', async () => {
  const h = await setup('employee'); // seeded employee_id = 3
  try {
    const own = await h.client.get('/api/leave/balances');
    assert.equal(own.status, 200);
    assert.equal(own.body.length, 4, 'employee sees only their own 4 balances');
    assert.ok(own.body.every((row) => row.employee_id === 3));
    assert.ok(own.body.every((row) => typeof row.leave_type_name === 'string'));
    assert.equal(balanceOf(own.body, 1).leave_type_name, 'Casual');
    assert.equal(balanceOf(own.body, 1).opening_balance, 12);
  } finally {
    await h.close();
  }

  const hr = await setup('hr');
  try {
    const all = await hr.client.get('/api/leave/balances');
    assert.equal(all.status, 200);
    assert.equal(all.body.length, 12, 'HR sees all 3 employees x 4 types');
    const filtered = await hr.client.get('/api/leave/balances?employeeId=2');
    assert.equal(filtered.body.length, 4);
    assert.ok(filtered.body.every((row) => row.employee_id === 2));
  } finally {
    await hr.close();
  }
});

// ---------------------------------------------------------------------------
// Apply / list
// ---------------------------------------------------------------------------

test('POST /api/leave/requests creates a pending request for the employee', async () => {
  const h = await setup('employee');
  try {
    const created = await h.client.post('/api/leave/requests', {
      leaveTypeId: 1,
      fromDate: '2026-03-02',
      toDate: '2026-03-04',
      days: 3,
      reason: 'family event',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.employee_id, 3, 'employee id comes from the session');
    assert.equal(created.body.leave_type_id, 1);
    assert.equal(created.body.leave_type_name, 'Casual');
    assert.equal(created.body.from_date, '2026-03-02');
    assert.equal(created.body.to_date, '2026-03-04');
    assert.equal(created.body.days, 3);
    assert.equal(created.body.reason, 'family event');
    assert.equal(created.body.status, 'pending');

    const balances = await h.client.get('/api/leave/balances');
    assert.equal(balanceOf(balances.body, 1).used, 0, 'applying does not touch the balance');

    const list = await h.client.get('/api/leave/requests');
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].id, created.body.id);
  } finally {
    await h.close();
  }
});

test('HR may apply on behalf of an employee; a forged employee id is ignored for employee role', async () => {
  const h = await setup('hr');
  try {
    const onBehalf = await h.client.post('/api/leave/requests', {
      employeeId: 2, leaveTypeId: 3, fromDate: '2026-03-10', toDate: '2026-03-10', days: 1,
    });
    assert.equal(onBehalf.status, 201, JSON.stringify(onBehalf.body));
    assert.equal(onBehalf.body.employee_id, 2);

    const employeeClient = makeClient(h.server);
    assert.equal(
      (await employeeClient.post('/api/auth/login', { username: 'employee', password: 'admin123' })).status,
      200,
    );
    const forged = await employeeClient.post('/api/leave/requests', {
      employeeId: 1, leaveTypeId: 1, fromDate: '2026-03-12', toDate: '2026-03-12', days: 1,
    });
    assert.equal(forged.status, 201);
    assert.equal(forged.body.employee_id, 3, 'employee cannot apply for someone else');

    const all = await h.client.get('/api/leave/requests');
    assert.equal(all.body.length, 2, 'HR sees all requests');
    const own = await employeeClient.get('/api/leave/requests');
    assert.equal(own.body.length, 1, 'employee sees only own request');
  } finally {
    await h.close();
  }
});

test('overlapping leave requests for the same employee are rejected', async () => {
  const h = await setup('employee'); // employee 3
  try {
    const first = await h.client.post('/api/leave/requests', {
      leaveTypeId: 1, fromDate: '2026-06-01', toDate: '2026-06-05', days: 5,
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const overlapping = await h.client.post('/api/leave/requests', {
      leaveTypeId: 2, fromDate: '2026-06-04', toDate: '2026-06-08', days: 5,
    });
    assert.equal(overlapping.status, 409, JSON.stringify(overlapping.body));

    const adjacent = await h.client.post('/api/leave/requests', {
      leaveTypeId: 2, fromDate: '2026-06-06', toDate: '2026-06-08', days: 3,
    });
    assert.equal(adjacent.status, 201, 'a touching-but-disjoint range is allowed');

    // Same dates for a DIFFERENT employee are fine (overlap is per-employee).
    const hrClient = makeClient(h.server);
    assert.equal(
      (await hrClient.post('/api/auth/login', { username: 'hr', password: 'admin123' })).status,
      200,
    );
    const otherEmployee = await hrClient.post('/api/leave/requests', {
      employeeId: 2, leaveTypeId: 1, fromDate: '2026-06-02', toDate: '2026-06-04', days: 3,
    });
    assert.equal(otherEmployee.status, 201, JSON.stringify(otherEmployee.body));
  } finally {
    await h.close();
  }
});

test('POST /api/leave/requests validates dates, days and leave type', async () => {
  const h = await setup('hr');
  try {
    assert.equal((await h.client.post('/api/leave/requests', {
      employeeId: 3, leaveTypeId: 1, fromDate: '2026-02-30', toDate: '2026-03-01', days: 1,
    })).status, 400, 'invalid ISO date');
    assert.equal((await h.client.post('/api/leave/requests', {
      employeeId: 3, leaveTypeId: 1, fromDate: '2026-03-05', toDate: '2026-03-01', days: 1,
    })).status, 400, 'to before from');
    assert.equal((await h.client.post('/api/leave/requests', {
      employeeId: 3, leaveTypeId: 1, fromDate: '2026-03-01', toDate: '2026-03-01', days: 0,
    })).status, 400, 'non-positive days');
    assert.equal((await h.client.post('/api/leave/requests', {
      employeeId: 3, leaveTypeId: 999, fromDate: '2026-03-01', toDate: '2026-03-01', days: 1,
    })).status, 404, 'unknown leave type');
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Decisions and balance recomputation
// ---------------------------------------------------------------------------

test('approve deducts the balance and records decision metadata', async () => {
  const h = await setup('hr');
  try {
    const applied = await h.client.post('/api/leave/requests', {
      employeeId: 3, leaveTypeId: 1, fromDate: '2026-03-02', toDate: '2026-03-04', days: 3,
    });
    assert.equal(applied.status, 201);
    const id = applied.body.id;

    const approved = await h.client.post(`/api/leave/requests/${id}/decision`, { action: 'approve' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, 'approved');
    assert.ok(approved.body.decided_by, 'decided_by is set from the session user');
    assert.ok(approved.body.decided_at, 'decided_at is set');
    assert.equal(approved.body.balance.used, 3);
    assert.equal(approved.body.balance.remaining, 9); // Casual opening is 12

    const balances = await h.client.get('/api/leave/balances?employeeId=3');
    const casual = balanceOf(balances.body, 1);
    assert.equal(casual.used, 3);
    assert.equal(casual.remaining, 9);
  } finally {
    await h.close();
  }
});

test('approving beyond the balance fails with 409 and leaves data unchanged', async () => {
  const h = await setup('hr');
  try {
    const applied = await h.client.post('/api/leave/requests', {
      employeeId: 3, leaveTypeId: 1, fromDate: '2026-03-01', toDate: '2026-03-20', days: 20,
    });
    assert.equal(applied.status, 201, JSON.stringify(applied.body));
    const id = applied.body.id;

    const balancesBefore = (await h.client.get('/api/leave/balances?employeeId=3')).body;

    const decision = await h.client.post(`/api/leave/requests/${id}/decision`, { action: 'approve' });
    assert.equal(decision.status, 409, JSON.stringify(decision.body));

    const balancesAfter = (await h.client.get('/api/leave/balances?employeeId=3')).body;
    assert.deepEqual(balancesAfter, balancesBefore, 'no balance was mutated');

    const requests = await h.client.get('/api/leave/requests?employeeId=3');
    assert.equal(requests.body[0].status, 'pending', 'request stays pending after a failed approval');
  } finally {
    await h.close();
  }
});

test('rejecting an approved request restores the days to the balance', async () => {
  const h = await setup('hr');
  try {
    const applied = await h.client.post('/api/leave/requests', {
      employeeId: 3, leaveTypeId: 2, fromDate: '2026-04-06', toDate: '2026-04-08', days: 3,
    });
    const id = applied.body.id;
    const approved = await h.client.post(`/api/leave/requests/${id}/decision`, { action: 'approve' });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.balance.used, 3, 'Sick balance debited on approval');

    const rejected = await h.client.post(`/api/leave/requests/${id}/decision`, { action: 'reject' });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.status, 'rejected');
    assert.equal(rejected.body.balance.used, 0, 'days restored');
    assert.equal(rejected.body.balance.remaining, 10, 'Sick opening is 10');
  } finally {
    await h.close();
  }
});

test('rejecting a pending request does not change balances', async () => {
  const h = await setup('hr');
  try {
    const applied = await h.client.post('/api/leave/requests', {
      employeeId: 3, leaveTypeId: 1, fromDate: '2026-04-06', toDate: '2026-04-07', days: 2,
    });
    const id = applied.body.id;
    const rejected = await h.client.post(`/api/leave/requests/${id}/decision`, { action: 'reject' });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.status, 'rejected');
    assert.equal(rejected.body.balance.used, 0, 'nothing had been debited');
    assert.equal(rejected.body.balance.remaining, 12);

    const again = await h.client.post(`/api/leave/requests/${id}/decision`, { action: 'approve' });
    assert.equal(again.status, 409, 'a decided request cannot be re-decided');
  } finally {
    await h.close();
  }
});

test('approved unpaid leave is queryable with type name and dates for payroll', async () => {
  const h = await setup('hr');
  try {
    const applied = await h.client.post('/api/leave/requests', {
      employeeId: 3, leaveTypeId: 4, fromDate: '2026-05-11', toDate: '2026-05-12', days: 2,
      reason: 'personal',
    });
    assert.equal(applied.status, 201, JSON.stringify(applied.body));
    assert.equal(applied.body.leave_type_name, 'Unpaid');
    const id = applied.body.id;

    const approved = await h.client.post(`/api/leave/requests/${id}/decision`, { action: 'approve' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, 'approved', 'unpaid leave can be approved past a zero balance');

    // This is the shape Task 6 (payroll) will consume for unpaid deductions.
    const approvedUnpaid = (await h.client.get('/api/leave/requests?status=approved')).body;
    const row = approvedUnpaid.find((entry) => entry.id === id);
    assert.ok(row);
    assert.equal(row.leave_type_name, 'Unpaid');
    assert.equal(row.from_date, '2026-05-11');
    assert.equal(row.to_date, '2026-05-12');
    assert.equal(row.days, 2);
    assert.equal(row.status, 'approved');
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Auth / validation of decision route
// ---------------------------------------------------------------------------

test('role enforcement: only HR/admin decide; employees and anonymous callers are blocked', async () => {
  const employee = await setup('employee');
  try {
    const own = await employee.client.get('/api/leave/requests');
    assert.equal(own.status, 200);
    assert.ok(own.body.every((row) => row.employee_id === 3));
    assert.equal(
      (await employee.client.post('/api/leave/requests/1/decision', { action: 'approve' })).status,
      403,
      'employee cannot approve',
    );
  } finally {
    await employee.close();
  }

  const anonymous = await setup(null);
  try {
    assert.equal((await anonymous.client.get('/api/leave/requests')).status, 401);
    assert.equal((await anonymous.client.get('/api/leave/balances')).status, 401);
    assert.equal((await anonymous.client.get('/api/leave/types')).status, 401);
  } finally {
    await anonymous.close();
  }
});

test('decision route validates id and action', async () => {
  const h = await setup('hr');
  try {
    assert.equal((await h.client.post('/api/leave/requests/9999/decision', { action: 'approve' })).status, 404);
    const applied = await h.client.post('/api/leave/requests', {
      employeeId: 3, leaveTypeId: 1, fromDate: '2026-07-01', toDate: '2026-07-01', days: 1,
    });
    const id = applied.body.id;
    assert.equal(
      (await h.client.post(`/api/leave/requests/${id}/decision`, { action: 'maybe' })).status,
      400,
      'unknown action',
    );
  } finally {
    await h.close();
  }
});
