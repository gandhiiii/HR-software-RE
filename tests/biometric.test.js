import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeClient } from './helpers.js';
import { startServer } from '../server.js';
import { registerBiometricRoutes } from '../api/biometric.js';

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
  const server = startServer({ db, registerRoutes: registerBiometricRoutes });
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
