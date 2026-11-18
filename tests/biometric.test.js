import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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

test('unmapped punches stay pending and re-resolve immediately after mapping', async () => {
  const h = await setup();
  try {
    const device = (await h.client.post('/api/biometric/devices', { name: 'Gate', serialNumber: 'SN-005' })).body;
    const imported = await h.client.post('/api/biometric/import', {
      deviceId: device.id, format: 'csv', text: 'user_id,timestamp,direction\n9999,2026-01-07 09:00:00,in\n',
    });
    assert.equal(imported.body.unmapped, 1);
    const pending = await h.client.get(`/api/biometric/punches?deviceId=${device.id}&status=pending`);
    assert.equal(pending.body[0].reason, 'unmapped_user');
    assert.equal(pending.body[0].employee_id, null);

    // Adding a mapping re-resolves the punch lazily — no explicit /map needed.
    await h.client.post(`/api/biometric/devices/${device.id}/mappings`, { employeeId: 3, deviceUserId: '9999' });
    const resolved = await h.client.get(`/api/biometric/punches?deviceId=${device.id}&status=pending`);
    assert.equal(resolved.body.length, 1);
    assert.equal(resolved.body[0].employee_id, 3, 'mapping must resolve the punch immediately');
    assert.equal(resolved.body[0].reason, null, 'stale unmapped_user reason must be cleared');
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

test('auto_commit commits complete pairs and leaves lone punches pending until paired', async () => {
  const h = await setup();
  try {
    const device = (await h.client.post('/api/biometric/devices', {
      name: 'Auto Gate', serialNumber: 'SN-008', autoCommit: 1,
    })).body;
    await h.client.post(`/api/biometric/devices/${device.id}/mappings`, { employeeId: 3, deviceUserId: '1042' });

    // A complete in+out pair commits immediately on import.
    const paired = await h.client.post('/api/biometric/import', {
      deviceId: device.id, format: 'csv',
      text: 'user_id,timestamp,direction\n1042,2026-02-10 09:05:00,in\n1042,2026-02-10 18:10:00,out\n',
    });
    assert.equal(paired.body.inserted, 2);
    const committed = await h.client.get(`/api/biometric/punches?deviceId=${device.id}&status=committed`);
    assert.equal(committed.body.length, 2);
    const firstAtt = await h.client.get('/api/attendance?employeeId=3&from=2026-02-10&to=2026-02-10');
    assert.equal(firstAtt.body.length, 1);
    assert.equal(firstAtt.body[0].status, 'Present');

    // A lone in stays pending and writes no attendance row.
    const lone = await h.client.post('/api/biometric/import', {
      deviceId: device.id, format: 'csv',
      text: 'user_id,timestamp,direction\n1042,2026-02-11 09:00:00,in\n',
    });
    assert.equal(lone.body.inserted, 1);
    const pending = await h.client.get(`/api/biometric/punches?deviceId=${device.id}&status=pending`);
    assert.equal(pending.body.length, 1);
    const noAtt = await h.client.get('/api/attendance?employeeId=3&from=2026-02-11&to=2026-02-11');
    assert.equal(noAtt.body.length, 0);

    // Arriving out completes the earlier lone in; both punches commit now.
    const out = await h.client.post('/api/biometric/import', {
      deviceId: device.id, format: 'csv',
      text: 'user_id,timestamp,direction\n1042,2026-02-11 18:00:00,out\n',
    });
    assert.equal(out.body.inserted, 1);
    const nowCommitted = await h.client.get(`/api/biometric/punches?deviceId=${device.id}&status=committed`);
    assert.equal(nowCommitted.body.length, 4);
    assert.equal((await h.client.get(`/api/biometric/punches?deviceId=${device.id}&status=pending`)).body.length, 0);
    const secondAtt = await h.client.get('/api/attendance?employeeId=3&from=2026-02-11&to=2026-02-11');
    assert.equal(secondAtt.body.length, 1);
    assert.equal(secondAtt.body[0].status, 'Present');
  } finally { await h.close(); }
});

test('auto_commit keeps unmapped pairs pending so they re-resolve after mapping', async () => {
  const h = await setup();
  try {
    const device = (await h.client.post('/api/biometric/devices', {
      name: 'Auto Gate', serialNumber: 'SN-009', autoCommit: 1,
    })).body;
    await h.client.post('/api/biometric/import', {
      deviceId: device.id, format: 'csv',
      text: 'user_id,timestamp,direction\n8888,2026-02-20 09:00:00,in\n8888,2026-02-20 18:00:00,out\n',
    });

    // A complete but unmapped pair must NOT be auto-committed or marked ignored.
    const pending = await h.client.get(`/api/biometric/punches?deviceId=${device.id}&status=pending`);
    assert.equal(pending.body.length, 2);
    assert.ok(pending.body.every((punch) => punch.reason === 'unmapped_user'));
    const noAtt = await h.client.get('/api/attendance?employeeId=3&from=2026-02-20&to=2026-02-20');
    assert.equal(noAtt.body.length, 0);

    // Once mapped, the pending punches re-resolve and a later commit writes attendance.
    await h.client.post(`/api/biometric/devices/${device.id}/mappings`, { employeeId: 3, deviceUserId: '8888' });
    const resolved = await h.client.get(`/api/biometric/punches?deviceId=${device.id}&status=pending`);
    assert.equal(resolved.body.length, 2);
    assert.ok(resolved.body.every((punch) => punch.employee_id === 3 && punch.reason === null));

    await h.client.post('/api/biometric/punches/commit', { deviceId: device.id });
    const att = await h.client.get('/api/attendance?employeeId=3&from=2026-02-20&to=2026-02-20');
    assert.equal(att.body.length, 1);
    assert.equal(att.body[0].status, 'Present');
  } finally { await h.close(); }
});

test('auto_commit keeps a lone OUT pending until a later IN pairs and commits it', async () => {
  const h = await setup();
  try {
    const device = (await h.client.post('/api/biometric/devices', {
      name: 'Auto Gate', serialNumber: 'SN-010', autoCommit: 1,
    })).body;
    await h.client.post(`/api/biometric/devices/${device.id}/mappings`, { employeeId: 3, deviceUserId: '1042' });

    // The lone OUT must not be permanently ignored: a later IN can still pair.
    const out = await h.client.post('/api/biometric/import', {
      deviceId: device.id, format: 'csv',
      text: 'user_id,timestamp,direction\n1042,2026-03-03 18:00:00,out\n',
    });
    assert.equal(out.body.inserted, 1);
    const afterOut = await h.client.get(`/api/biometric/punches?deviceId=${device.id}&status=pending`);
    assert.equal(afterOut.body.length, 1, 'lone OUT must stay pending');
    assert.equal(afterOut.body[0].direction, 'out');
    assert.equal(afterOut.body[0].reason, 'unpaired');
    assert.equal(afterOut.body[0].status, 'pending');
    assert.equal((await h.client.get('/api/attendance?employeeId=3&from=2026-03-03&to=2026-03-03')).body.length, 0);

    const incoming = await h.client.post('/api/biometric/import', {
      deviceId: device.id, format: 'csv',
      text: 'user_id,timestamp,direction\n1042,2026-03-03 09:00:00,in\n',
    });
    assert.equal(incoming.body.inserted, 1);
    const committed = await h.client.get(`/api/biometric/punches?deviceId=${device.id}&status=committed`);
    assert.equal(committed.body.length, 2, 'both punches must commit once paired');
    assert.equal((await h.client.get(`/api/biometric/punches?deviceId=${device.id}&status=pending`)).body.length, 0);
    const att = await h.client.get('/api/attendance?employeeId=3&from=2026-03-03&to=2026-03-03');
    assert.equal(att.body.length, 1);
    assert.equal(att.body[0].status, 'Present');
  } finally { await h.close(); }
});

test('manual commit keeps unmapped punches pending with a reason', async () => {
  const h = await setup();
  try {
    const device = (await h.client.post('/api/biometric/devices', { name: 'Gate', serialNumber: 'SN-011' })).body;
    await h.client.post('/api/biometric/import', {
      deviceId: device.id, format: 'csv',
      text: 'user_id,timestamp,direction\n7777,2026-03-02 09:00:00,in\n7777,2026-03-02 18:00:00,out\n',
    });
    const result = (await h.client.post('/api/biometric/punches/commit', { deviceId: device.id })).body;
    assert.equal(result.committed, 0, 'unmapped punches must never be committed');
    const pending = await h.client.get(`/api/biometric/punches?deviceId=${device.id}&status=pending`);
    assert.equal(pending.body.length, 2, 'manual commit must not silently discard unmapped punches');
    assert.ok(pending.body.every((p) => p.reason === 'unmapped_user' && p.employee_id === null));
  } finally { await h.close(); }
});

// ---------------------------------------------------------------------------
// Push paths: generic JSON webhook and ZKTeco ADMS
// ---------------------------------------------------------------------------

test('generic push authenticates by token and ingests a JSON batch', async () => {
  const h = await setup('hr');
  try {
    const device = (await h.client.post('/api/biometric/devices', {
      name: 'Push Gate', serialNumber: 'SN-PUSH', ingestionMode: 'push', adapter: 'generic_json',
    })).body;
    await h.client.post(`/api/biometric/devices/${device.id}/mappings`, { employeeId: 3, deviceUserId: '1042' });
    await h.client.post('/api/auth/logout'); // push needs no session
    assert.equal((await h.client.post('/api/biometric/push/wrong-token', { records: [] })).status, 401);
    const ok = await h.client.post(`/api/biometric/push/${device.pushToken}`, {
      records: [{ userId: '1042', timestamp: '2026-01-10 09:05:00', direction: 'in' }],
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.inserted, 1);
  } finally { await h.close(); }
});

test('ZKTeco ADMS registration returns options text and ATTLOG POST returns OK: n', async () => {
  const h = await setup('hr');
  try {
    const device = (await h.client.post('/api/biometric/devices', {
      name: 'ADMS', serialNumber: 'SN-ADMS', ingestionMode: 'push', adapter: 'zkteco_adms',
    })).body;
    await h.client.post(`/api/biometric/devices/${device.id}/mappings`, { employeeId: 3, deviceUserId: '1042' });
    await h.client.post('/api/auth/logout');
    const reg = await h.client.get('/iclock/cdata?SN=SN-ADMS&options=all');
    assert.equal(reg.status, 200);
    assert.match(reg.text, /GET OPTIONS/);
    assert.match(reg.text, /Realtime=1/);
    assert.match(reg.text, /TransInterval=1/);
    assert.match(reg.text, /TransFlag=1/);
    assert.match(reg.text, /ServerVer=/);
    assert.match(reg.text, /Encrypt=None/);
    const push = await h.client.postRaw('/iclock/cdata?SN=SN-ADMS&table=ATTLOG',
      '1042\t2026-01-10 09:05:00\t0\t1\t0\n', 'text/plain');
    assert.equal(push.status, 200);
    assert.equal(push.text, 'OK: 1');
  } finally { await h.close(); }
});

test('oversized push body returns 413 and malformed JSON returns 400', async () => {
  const h = await setup('hr');
  try {
    const device = (await h.client.post('/api/biometric/devices', {
      name: 'Limits', serialNumber: 'SN-LIMIT', ingestionMode: 'push',
    })).body;
    const url = `/api/biometric/push/${device.pushToken}`;
    assert.equal((await h.client.postRaw(url, 'x'.repeat(1024 * 1024 + 1), 'application/json')).status, 413);
    assert.equal((await h.client.postRaw(url, 'not json', 'application/json')).status, 400);
  } finally { await h.close(); }
});

// ---------------------------------------------------------------------------
// Public push endpoints: device guards and bearer secrets (table-driven)
// ---------------------------------------------------------------------------

/** Register a push device with a unique serial for a table-driven case. */
async function createGuardDevice(h, index, overrides = {}) {
  const res = await h.client.post('/api/biometric/devices', {
    name: `Guard ${index}`,
    serialNumber: `SN-GUARD-${index}`,
    ingestionMode: 'push',
    adapter: 'generic_json',
    ...overrides,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

/** Rotate a bearer secret and return its one-time plaintext. */
async function rotateSecret(h, device) {
  const res = await h.client.patch(`/api/biometric/devices/${device.id}`, { rotateSecret: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.pushSecret, /^[0-9a-f]{48}$/);
  return res.body.pushSecret;
}

test('generic push: enabled/mode guard, token and bearer secret (table-driven)', async (t) => {
  // Devices are provisioned with the HR session; the push endpoint itself is
  // public and ignores any session cookie it happens to receive.
  const h = await setup('hr');
  try {
    const cases = [
      { name: 'valid push device is accepted', status: 200 },
      { name: 'disabled device is rejected', overrides: { enabled: 0 }, status: 403 },
      { name: 'wrong ingestion mode is rejected', overrides: { ingestionMode: 'offline' }, status: 403 },
      { name: 'wrong/unknown token is rejected', token: 'unknown-token', status: 401 },
      { name: 'missing bearer is rejected when a secret is set', withSecret: true, status: 401 },
      { name: 'invalid bearer is rejected', withSecret: true, bearer: 'wrong-secret', status: 401 },
      { name: 'valid bearer is accepted', withSecret: true, bearerFromSecret: true, status: 200 },
    ];
    let index = 0;
    for (const c of cases) {
      await t.test(c.name, async () => {
        index += 1;
        let device = null;
        let secret = null;
        if (!c.token) {
          device = await createGuardDevice(h, index, c.overrides ?? {});
          if (c.withSecret) {
            secret = await rotateSecret(h, device);
            const stored = (await h.client.get(`/api/biometric/devices/${device.id}`)).body.pushSecretHash;
            assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{128}$/, 'storage must be salt:hash');
            assert.notEqual(stored, secret);
          }
        }
        const headers = {};
        if (c.bearerFromSecret) headers.Authorization = `Bearer ${secret}`;
        else if (c.bearer) headers.Authorization = `Bearer ${c.bearer}`;
        const res = await h.client.post(`/api/biometric/push/${c.token ?? device.pushToken}`, {
          records: [{ userId: '1042', timestamp: '2026-04-01 09:05:00', direction: 'in' }],
        }, { headers });
        assert.equal(res.status, c.status, `${c.name}: ${JSON.stringify(res.body)}`);
        if (c.status === 200) assert.equal(res.body.inserted, 1);
      });
    }
  } finally { await h.close(); }
});

test('ADMS: enabled/adapter guard, serial, bearer secret and raw-body limit (table-driven)', async (t) => {
  // Devices are provisioned with the HR session; the ADMS endpoints are public.
  const h = await setup('hr');
  try {
    const cases = [
      { name: 'valid ADMS device is accepted', status: 200 },
      { name: 'disabled ADMS device is rejected', overrides: { enabled: 0 }, status: 403 },
      { name: 'wrong adapter is rejected', overrides: { adapter: 'generic_json' }, status: 403 },
      { name: 'wrong/unknown serial is rejected', serial: 'SN-NO-SUCH-DEVICE', status: 401 },
      { name: 'invalid bearer is rejected', withSecret: true, bearer: 'wrong-secret', status: 401 },
      { name: 'valid bearer is accepted', withSecret: true, bearerFromSecret: true, status: 200 },
    ];
    let index = 0;
    for (const c of cases) {
      await t.test(c.name, async () => {
        index += 1;
        let serial = c.serial;
        let secret = null;
        if (!serial) {
          const device = await createGuardDevice(h, index, { adapter: 'zkteco_adms', ...(c.overrides ?? {}) });
          serial = device.serialNumber;
          if (c.withSecret) secret = await rotateSecret(h, device);
        }
        const headers = {};
        if (c.bearerFromSecret) headers.Authorization = `Bearer ${secret}`;
        else if (c.bearer) headers.Authorization = `Bearer ${c.bearer}`;
        const res = await h.client.get(`/iclock/cdata?SN=${serial}&options=all`, { headers });
        assert.equal(res.status, c.status, `${c.name}: ${JSON.stringify(res.body)}`);
        if (c.status === 200) assert.match(res.text, /Realtime=1/);
      });
    }
    await t.test('oversized raw ATTLOG body is rejected with 413', async () => {
      index += 1;
      const device = await createGuardDevice(h, index, { adapter: 'zkteco_adms' });
      const res = await h.client.postRaw(`/iclock/cdata?SN=${device.serialNumber}&table=ATTLOG`,
        'x'.repeat(1024 * 1024 + 1), 'text/plain');
      assert.equal(res.status, 413);
    });
  } finally { await h.close(); }
});

test('pushSecretHash is not client-settable; rotation stores salt:hash and returns plaintext once', async () => {
  const h = await setup();
  try {
    const created = await h.client.post('/api/biometric/devices', {
      name: 'Secret Gate', serialNumber: 'SN-SECRET', ingestionMode: 'push',
      pushSecretHash: 'client-supplied-raw-hash',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.pushSecretHash, null, 'clients cannot seed the secret hash');
    assert.equal(created.body.pushSecret, undefined);

    const rotated = await h.client.patch(`/api/biometric/devices/${created.body.id}`, { rotateSecret: true });
    assert.equal(rotated.status, 200);
    assert.match(rotated.body.pushSecret, /^[0-9a-f]{48}$/);
    assert.match(rotated.body.pushSecretHash, /^[0-9a-f]{32}:[0-9a-f]{128}$/);

    const reread = await h.client.get(`/api/biometric/devices/${created.body.id}`);
    assert.equal(reread.body.pushSecret, undefined, 'plaintext must not be returned again');
    assert.equal(reread.body.pushSecretHash, rotated.body.pushSecretHash);
  } finally { await h.close(); }
});

// ---------------------------------------------------------------------------
// Polling: manual fetch from a mock device endpoint
// ---------------------------------------------------------------------------

test('manual poll fetches punches from a mock device HTTP endpoint', async () => {
  // start a local http.createServer returning {"records":[...]} on /punches
  const mockServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      records: [{ userId: '1042', timestamp: '2026-01-05 09:05:00', direction: 'in' }],
    }));
  });
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const mockPort = mockServer.address().port;
  const h = await setup();
  try {
    const device = (await h.client.post('/api/biometric/devices', {
      name: 'Poll Device', serialNumber: 'SN-POLL', ingestionMode: 'poll',
      adapter: 'http_json', pollEndpoint: `http://127.0.0.1:${mockPort}/punches`,
    })).body;
    await h.client.post(`/api/biometric/devices/${device.id}/mappings`, { employeeId: 3, deviceUserId: '1042' });
    const res = await h.client.post(`/api/biometric/devices/${device.id}/poll`);
    assert.equal(res.status, 200);
    assert.equal(res.body.inserted, 1);
  } finally { await h.close(); await new Promise((resolve) => mockServer.close(resolve)); }
});
