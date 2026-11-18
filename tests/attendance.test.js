import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeClient } from './helpers.js';
import { startServer } from '../server.js';
import { deriveAttendance } from '../lib/calc/attendance.js';
import { registerAttendanceRoutes, recordAttendance } from '../api/attendance.js';
import { insertRow } from '../lib/repo.js';

const SHIFT = { start_time: '09:00', end_time: '18:00', grace_minutes: 10, weekly_off_day: 0 };

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

/** Listening server with only the attendance routes registered on top of auth. */
async function setup(role = 'hr') {
  const db = makeDb();
  const server = startServer({
    db,
    registerRoutes: (router) => registerAttendanceRoutes(router),
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

// ---------------------------------------------------------------------------
// Pure calculation boundaries (Step 1 of the task brief)
// ---------------------------------------------------------------------------

test('deriveAttendance: approved leave wins and zeroes the metrics', () => {
  const result = deriveAttendance({
    punchIn: '09:00', punchOut: '18:00', shift: SHIFT, approvedLeave: true,
  });
  assert.equal(result.status, 'Leave');
  assert.equal(result.lateMinutes, 0);
  assert.equal(result.earlyMinutes, 0);
  assert.equal(result.workedMinutes, 0);
  assert.equal(result.overtimeMinutes, 0);
});

test('deriveAttendance: holiday wins over punches', () => {
  const result = deriveAttendance({
    punchIn: '09:00', punchOut: '18:00', shift: SHIFT, holiday: true,
  });
  assert.equal(result.status, 'Holiday');
  assert.equal(result.workedMinutes, 0);
});

test('deriveAttendance: no punch-in means Absent', () => {
  const result = deriveAttendance({ punchIn: null, punchOut: null, shift: SHIFT });
  assert.equal(result.status, 'Absent');
  assert.equal(result.workedMinutes, 0);
  assert.equal(result.lateMinutes, 0);
});

test('deriveAttendance: punch-in five hours after start is Half-day', () => {
  const result = deriveAttendance({ punchIn: '14:00', punchOut: '22:00', shift: SHIFT });
  assert.equal(result.status, 'Half-day');
  assert.equal(result.lateMinutes, 300);
  assert.ok(result.workedMinutes >= 240, 'enough hours worked, but lateness forces half-day');
});

test('deriveAttendance: only three hours worked is Half-day', () => {
  const result = deriveAttendance({ punchIn: '09:00', punchOut: '12:00', shift: SHIFT });
  assert.equal(result.status, 'Half-day');
  assert.equal(result.workedMinutes, 180);
  assert.equal(result.lateMinutes, 0);
});

test('deriveAttendance: within grace and eight hours worked is Present', () => {
  const result = deriveAttendance({ punchIn: '09:05', punchOut: '17:05', shift: SHIFT });
  assert.equal(result.status, 'Present');
  assert.equal(result.workedMinutes, 480);
});

test('deriveAttendance: late and early minutes are recorded separately from the Present status', () => {
  const result = deriveAttendance({ punchIn: '09:05', punchOut: '17:05', shift: SHIFT });
  // 5 minutes late is within the 10-minute grace, so status stays Present, but
  // the lateness is still surfaced through lateMinutes.
  assert.equal(result.status, 'Present');
  assert.equal(result.lateMinutes, 5);
  // Leaving 55 minutes before shift end does not change the Present status.
  assert.equal(result.earlyMinutes, 55);
});

test('deriveAttendance: overtime is capped at 240 whole minutes', () => {
  const result = deriveAttendance({ punchIn: '09:00', punchOut: '23:59', shift: SHIFT });
  assert.equal(result.status, 'Present');
  assert.equal(result.overtimeMinutes, 240);
});

test('deriveAttendance: graceMinutes argument overrides the shift default', () => {
  const result = deriveAttendance({
    punchIn: '09:20', punchOut: '18:00', shift: SHIFT, graceMinutes: 30,
  });
  assert.equal(result.lateMinutes, 20);
  assert.equal(result.status, 'Present');
});

// ---------------------------------------------------------------------------
// Recording and reading APIs
// ---------------------------------------------------------------------------

test('POST /api/attendance records a derived row; GET filters by employee and date range', async () => {
  const h = await setup('hr');
  try {
    const created = await h.client.post('/api/attendance', {
      employeeId: 3, date: '2026-01-05', punchIn: '09:00', punchOut: '18:00',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.employee_id, 3);
    assert.equal(created.body.date, '2026-01-05');
    assert.equal(created.body.status, 'Present');
    assert.equal(created.body.worked_minutes, 540);

    const inRange = await h.client.get('/api/attendance?employeeId=3&from=2026-01-01&to=2026-01-31');
    assert.equal(inRange.status, 200);
    assert.equal(inRange.body.length, 1);
    assert.equal(inRange.body[0].status, 'Present');

    const outOfRange = await h.client.get('/api/attendance?employeeId=3&from=2026-02-01&to=2026-02-28');
    assert.equal(outOfRange.body.length, 0);
  } finally {
    await h.close();
  }
});

test('repeat POST upserts a single attendance row per employee/date', async () => {
  const h = await setup('hr');
  try {
    const body = { employeeId: 3, date: '2026-01-05', punchIn: '09:00', punchOut: '12:00' };
    const first = await h.client.post('/api/attendance', body);
    assert.equal(first.status, 201);
    assert.equal(first.body.status, 'Half-day');

    const second = await h.client.post('/api/attendance', {
      ...body, punchIn: '09:00', punchOut: '18:00',
    });
    assert.equal(second.status, 200, 'repeat record updates in place');
    assert.equal(second.body.id, first.body.id, 'same row id is reused');
    assert.equal(second.body.status, 'Present');

    const all = await h.client.get('/api/attendance?employeeId=3');
    assert.equal(all.body.length, 1, 'only one row exists for the employee/date');
  } finally {
    await h.close();
  }
});

test('POST /api/attendance rejects bad dates, bad times and unknown employees', async () => {
  const h = await setup('hr');
  try {
    assert.equal(
      (await h.client.post('/api/attendance', { employeeId: 3, date: '2026-02-30', punchIn: '09:00' })).status,
      400,
    );
    assert.equal(
      (await h.client.post('/api/attendance', { date: '2026-01-05', punchIn: '09:00' })).status,
      400,
    );
    assert.equal(
      (await h.client.post('/api/attendance', { employeeId: 3, date: '2026-01-05', punchIn: '25:00' })).status,
      400,
    );
    assert.equal(
      (await h.client.post('/api/attendance', { employeeId: 999999, date: '2026-01-05' })).status,
      404,
    );
    const all = await h.client.get('/api/attendance');
    assert.equal(all.body.length, 0, 'nothing invalid was stored');
  } finally {
    await h.close();
  }
});

test('weekly off and approved leave are derived automatically from settings/body', async () => {
  const h = await setup('hr');
  try {
    // 2026-01-04 is a Sunday, the seeded weekly_off_day (0).
    const sunday = await h.client.post('/api/attendance', {
      employeeId: 3, date: '2026-01-04', punchIn: '09:00', punchOut: '18:00',
    });
    assert.equal(sunday.status, 201);
    assert.equal(sunday.body.status, 'Holiday');

    const onLeave = await h.client.post('/api/attendance', {
      employeeId: 3, date: '2026-01-06', approvedLeave: true,
    });
    assert.equal(onLeave.status, 201);
    assert.equal(onLeave.body.status, 'Leave');
  } finally {
    await h.close();
  }
});

test('employee role records only their own attendance through /api/attendance/self', async () => {
  const h = await setup('employee'); // seeded employee_id = 3
  try {
    const self = await h.client.post('/api/attendance/self', {
      date: '2026-01-05', punchIn: '09:00', punchOut: '18:00',
    });
    assert.equal(self.status, 201, JSON.stringify(self.body));
    assert.equal(self.body.employee_id, 3, 'uses the logged-in employee id');
    assert.equal(self.body.status, 'Present');

    // A forged employeeId in the body is ignored: still own record only.
    const forged = await h.client.post('/api/attendance/self', {
      employeeId: 1, date: '2026-01-06', punchIn: '09:00', punchOut: '18:00',
    });
    assert.equal(forged.body.employee_id, 3);

    // HR-only management routes stay forbidden for the employee role.
    assert.equal((await h.client.get('/api/attendance')).status, 403);
    assert.equal((await h.client.post('/api/attendance', {
      employeeId: 3, date: '2026-01-05',
    })).status, 403);
  } finally {
    await h.close();
  }
});

test('self-recording ignores client-supplied approvedLeave, holiday and shiftId', async () => {
  const h = await setup('employee'); // seeded employee_id = 3, shift 1 (09:00-18:00, grace 10)
  try {
    // A permissive-looking alternate shift with an earlier start/end. If a
    // client could pick it, the punches below would be graded Half-day (60 min
    // late) with 60 min of overtime. It must be ignored on the self path.
    const altShiftId = insertRow(h.db, 'shifts', {
      name: 'Alternate Shift',
      start_time: '08:00',
      end_time: '17:00',
      grace_minutes: 0,
      weekly_off_day: 0,
    });

    const leave = await h.client.post('/api/attendance/self', {
      date: '2026-01-05', punchIn: '09:00', punchOut: '18:00', approvedLeave: true,
    });
    assert.equal(leave.status, 201, JSON.stringify(leave.body));
    assert.equal(leave.body.status, 'Present', 'approvedLeave flag must be ignored');
    assert.equal(leave.body.worked_minutes, 540);

    const holiday = await h.client.post('/api/attendance/self', {
      date: '2026-01-05', punchIn: '09:00', punchOut: '18:00', holiday: true,
    });
    assert.equal(holiday.status, 200, 're-record upserts the same row');
    assert.equal(holiday.body.status, 'Present', 'holiday flag must be ignored');

    const shift = await h.client.post('/api/attendance/self', {
      date: '2026-01-05', punchIn: '09:00', punchOut: '18:00', shiftId: altShiftId,
    });
    assert.equal(shift.status, 200);
    assert.equal(shift.body.status, 'Present', 'shiftId must be ignored');
    assert.equal(shift.body.late_minutes, 0, 'employee shift start must be used');
    assert.equal(shift.body.overtime_minutes, 0, 'alternate shift end must not create overtime');
    assert.equal(shift.body.worked_minutes, 540);

    // Sanity: the same alternate shift IS honoured on the HR path (same db).
    const hrClient = makeClient(h.server);
    const hrLogin = await hrClient.post('/api/auth/login', {
      username: 'hr', password: 'admin123',
    });
    assert.equal(hrLogin.status, 200);
    const hrRecord = await hrClient.post('/api/attendance', {
      employeeId: 3, date: '2026-01-05', punchIn: '09:00', punchOut: '18:00',
      shiftId: altShiftId,
    });
    assert.equal(hrRecord.body.status, 'Half-day', 'HR may still choose a shift');
    assert.equal(hrRecord.body.overtime_minutes, 60);
  } finally {
    await h.close();
  }
});

test('punchOut at or before punchIn is rejected with 400', async () => {
  const h = await setup('hr');
  try {
    const backwards = await h.client.post('/api/attendance', {
      employeeId: 3, date: '2026-01-05', punchIn: '18:00', punchOut: '09:00',
    });
    assert.equal(backwards.status, 400);
    assert.match(backwards.body.error, /punchOut/i);

    const equal = await h.client.post('/api/attendance', {
      employeeId: 3, date: '2026-01-06', punchIn: '09:00', punchOut: '09:00',
    });
    assert.equal(equal.status, 400);

    // Punch-in with NO punch-out stays valid and is still graded Half-day.
    const noOut = await h.client.post('/api/attendance', {
      employeeId: 3, date: '2026-01-07', punchIn: '09:00',
    });
    assert.equal(noOut.status, 201, JSON.stringify(noOut.body));
    assert.equal(noOut.body.status, 'Half-day');

    const all = await h.client.get('/api/attendance');
    assert.equal(all.body.length, 1, 'rejected rows were not stored');
  } finally {
    await h.close();
  }
});

test('anonymous requests to attendance routes get 401', async () => {
  const h = await setup(null);
  try {
    assert.equal((await h.client.get('/api/attendance')).status, 401);
    assert.equal((await h.client.get('/api/attendance/summary?month=1&year=2026')).status, 401);
  } finally {
    await h.close();
  }
});

test('GET /api/attendance/summary aggregates a month per employee', async () => {
  const h = await setup('hr');
  try {
    await h.client.post('/api/attendance', {
      employeeId: 3, date: '2026-01-05', punchIn: '09:00', punchOut: '18:00',
    });
    await h.client.post('/api/attendance', {
      employeeId: 3, date: '2026-01-06', punchIn: '09:30', punchOut: '12:00',
    });
    await h.client.post('/api/attendance', {
      employeeId: 2, date: '2026-01-05', punchIn: '09:00', punchOut: '18:00',
    });
    await h.client.post('/api/attendance', {
      employeeId: 3, date: '2026-02-05', punchIn: '09:00', punchOut: '18:00',
    });

    const january = await h.client.get('/api/attendance/summary?month=1&year=2026');
    assert.equal(january.status, 200);
    assert.equal(january.body.month, 1);
    assert.equal(january.body.year, 2026);
    const emp3 = january.body.employees.find((row) => row.employee_id === 3);
    assert.ok(emp3);
    assert.equal(emp3.present, 1);
    assert.equal(emp3.half_day, 1);
    assert.equal(emp3.present_days, 1.5);
    assert.equal(emp3.worked_minutes, 540 + 150);

    const february = await h.client.get('/api/attendance/summary?month=2&year=2026');
    const emp3Feb = february.body.employees.find((row) => row.employee_id === 3);
    assert.equal(emp3Feb.present, 1);
    assert.equal(emp3Feb.half_day, 0);

    assert.equal((await h.client.get('/api/attendance/summary?month=13&year=2026')).status, 400);
  } finally {
    await h.close();
  }
});

test('GET /api/shifts lists the seeded shift for all three roles', async () => {
  for (const role of ['admin', 'hr', 'employee']) {
    const h = await setup(role);
    try {
      const shifts = await h.client.get('/api/shifts');
      assert.equal(shifts.status, 200);
      assert.equal(shifts.body.length, 1);
      assert.equal(shifts.body[0].name, 'General Shift');
      assert.equal(shifts.body[0].start_time, '09:00');
    } finally {
      await h.close();
    }
  }
});

// Regression for the shared recordAttendance extraction (biometric commit reuses it).
test('recordAttendance is exported and the manual route still records Present (201)', async () => {
  assert.equal(typeof recordAttendance, 'function');
  const h = await setup('hr');
  try {
    const created = await h.client.post('/api/attendance', {
      employeeId: 3, date: '2026-03-10', punchIn: '09:00', punchOut: '18:00',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, 'Present');
  } finally {
    await h.close();
  }
});
