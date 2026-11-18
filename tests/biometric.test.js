import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeClient } from './helpers.js';
import { startServer } from '../server.js';
import { registerBiometricRoutes } from '../api/biometric.js';
import { registerAttendanceRoutes } from '../api/attendance.js';

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

/** Listening server with only the biometric routes registered on top of auth. */
async function setup(role = 'hr') {
  const db = makeDb();
  const server = startServer({
    db,
    registerRoutes: (router) => {
      registerBiometricRoutes(router);
      registerAttendanceRoutes(router);
    },
  });
  await listen(server);
  const client = makeClient(server);
  if (role) assert.equal((await client.post('/api/auth/login', { username: role, password: 'admin123' })).status, 200);
  return { db, server, client, close: async () => { await close(server); db.close(); } };
}

// ---------------------------------------------------------------------------
// Device registry and employee mapping
// ---------------------------------------------------------------------------

test('POST /api/biometric/devices registers a device with a generated push token', async () => {
  const h = await setup();
  try {
    const res = await h.client.post('/api/biometric/devices', {
      name: 'Front Gate', serialNumber: 'SN-001', vendor: 'zkteco',
      model: 'F22', deviceType: 'fingerprint', ingestionMode: 'offline', adapter: 'zkteco_adms',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.pushToken, /^[0-9a-f]{48}$/);
    assert.equal(res.body.serialNumber, 'SN-001');
  } finally { await h.close(); }
});

test('device routes enforce roles and uniqueness', async () => {
  const h = await setup();
  try {
    const first = await h.client.post('/api/biometric/devices', { name: 'A', serialNumber: 'SN-002' });
    assert.equal(first.status, 201);
    assert.equal((await h.client.post('/api/biometric/devices', { name: 'B', serialNumber: 'SN-002' })).status, 409);
  } finally { await h.close(); }
  const emp = await setup('employee');
  try { assert.equal((await emp.client.get('/api/biometric/devices')).status, 403); } finally { await emp.close(); }
  const anon = await setup(null);
  try { assert.equal((await anon.client.get('/api/biometric/devices')).status, 401); } finally { await anon.close(); }
});

test('mappings add, list and remove employee-to-device-user links', async () => {
  const h = await setup();
  try {
    const device = (await h.client.post('/api/biometric/devices', { name: 'Gate', serialNumber: 'SN-003' })).body;
    const added = await h.client.post(`/api/biometric/devices/${device.id}/mappings`, { employeeId: 3, deviceUserId: '1042' });
    assert.equal(added.status, 201);
    const list = await h.client.get(`/api/biometric/devices/${device.id}/mappings`);
    assert.equal(list.body[0].employee_id, 3);
    assert.equal((await h.client.delete(`/api/biometric/devices/${device.id}/mappings/${added.body.id}`)).status, 200);
  } finally { await h.close(); }
});

// ---------------------------------------------------------------------------
// Ingest, offline import, review and commit
// ---------------------------------------------------------------------------

test('import dedupes, stores unmapped punches, and commit writes attendance', async () => {
  const h = await setup();
  try {
    const device = (await h.client.post('/api/biometric/devices', { name: 'Gate', serialNumber: 'SN-004' })).body;
    await h.client.post(`/api/biometric/devices/${device.id}/mappings`, { employeeId: 3, deviceUserId: '1042' });
    const csv = 'user_id,timestamp,direction\n1042,2026-01-05 09:05:00,in\n1042,2026-01-05 18:10:00,out\n';
    const first = await h.client.post('/api/biometric/import', { deviceId: device.id, format: 'csv', text: csv });
    assert.equal(first.status, 201);
    assert.equal(first.body.inserted, 2);
    const again = await h.client.post('/api/biometric/import', { deviceId: device.id, format: 'csv', text: csv });
    assert.equal(again.body.duplicates, 2);
    assert.equal(again.body.inserted, 0);
    const committed = await h.client.post('/api/biometric/punches/commit', { deviceId: device.id });
    assert.equal(committed.body.committed, 2);
    const att = await h.client.get('/api/attendance?employeeId=3&from=2026-01-05&to=2026-01-05');
    assert.equal(att.body.length, 1);
    assert.equal(att.body[0].status, 'Present');
  } finally { await h.close(); }
});

test('unmapped punches stay pending and re-resolve after mapping', async () => {
  const h = await setup();
  try {
    const device = (await h.client.post('/api/biometric/devices', { name: 'Gate', serialNumber: 'SN-005' })).body;
    const imported = await h.client.post('/api/biometric/import', {
      deviceId: device.id, format: 'csv', text: 'user_id,timestamp,direction\n9999,2026-01-07 09:00:00,in\n',
    });
    assert.equal(imported.body.unmapped, 1);
    const pending = await h.client.get(`/api/biometric/punches?deviceId=${device.id}&status=pending`);
    assert.equal(pending.body[0].reason, 'unmapped_user');
    await h.client.post(`/api/biometric/devices/${device.id}/mappings`, { employeeId: 3, deviceUserId: '9999' });
    const mapped = await h.client.post(`/api/biometric/punches/${pending.body[0].id}/map`, { employeeId: 3 });
    assert.equal(mapped.status, 200);
    assert.equal(mapped.body.employee_id, 3);
  } finally { await h.close(); }
});

test('commit never overwrites existing manual attendance', async () => {
  const h = await setup();
  try {
    await h.client.post('/api/attendance', { employeeId: 3, date: '2026-01-08', punchIn: '09:00', punchOut: '17:00' });
    const device = (await h.client.post('/api/biometric/devices', { name: 'Gate', serialNumber: 'SN-006' })).body;
    await h.client.post(`/api/biometric/devices/${device.id}/mappings`, { employeeId: 3, deviceUserId: '1042' });
    await h.client.post('/api/biometric/import', {
      deviceId: device.id, format: 'csv', text: 'user_id,timestamp,direction\n1042,2026-01-08 09:05:00,in\n1042,2026-01-08 18:00:00,out\n',
    });
    const result = (await h.client.post('/api/biometric/punches/commit', { deviceId: device.id })).body;
    assert.equal(result.ignored, 2);
    const att = await h.client.get('/api/attendance?employeeId=3&from=2026-01-08&to=2026-01-08');
    assert.equal(att.body[0].punch_in, '09:00');
  } finally { await h.close(); }
});

test('a lone in punch commits as Half-day', async () => {
  const h = await setup();
  try {
    const device = (await h.client.post('/api/biometric/devices', { name: 'Gate', serialNumber: 'SN-007' })).body;
    await h.client.post(`/api/biometric/devices/${device.id}/mappings`, { employeeId: 3, deviceUserId: '1042' });
    await h.client.post('/api/biometric/import', { deviceId: device.id, format: 'csv', text: 'user_id,timestamp,direction\n1042,2026-01-09 09:00:00,in\n' });
    assert.equal((await h.client.post('/api/biometric/punches/commit', { deviceId: device.id })).body.committed, 1);
    const att = await h.client.get('/api/attendance?employeeId=3&from=2026-01-09&to=2026-01-09');
    assert.equal(att.body[0].status, 'Half-day');
  } finally { await h.close(); }
});
