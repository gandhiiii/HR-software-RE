# Biometric Attendance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a biometric attendance subsystem to `HR-software-RE` — device registry, employee-to-device-user mapping, three punch ingestion paths (CSV/TSV import, device push incl. ZKTeco ADMS, HTTP polling), a reviewable punch inbox, and commit into the existing attendance/payroll engine — plus port the biometric UI features from the reference project `F:\rea-main\tankhwapatra-clone` (device simulator, biometric serial mapping, punch logs, muster matrix) as real data-backed screens.

**Architecture:** Four new tables in the existing `SCHEMA` object, a pure parser/pairing module under `lib/calc/`, one shared ingest path that every input feeds, a single `api/biometric.js` router module following the repo's existing registration pattern, an opt-in in-process poller, and one hash-routed "Biometric" SPA screen. The reference project contributes presentation ideas only — its backend is a single unauthenticated punch insert and its "sync" is a `setTimeout` stub, so none of it is copied as code.

**Tech Stack:** Node.js v26 built-ins only (`node:sqlite`, `node:http`, `node:crypto`, `node:fs`), ES modules, `node --test`. Zero npm dependencies. React/Vite from the reference project is NOT introduced.

**Spec:** `docs/superpowers/specs/2026-11-18-biometric-attendance-design.md`

**UI reference:** `F:\rea-main\tankhwapatra-clone` (presentation only; see Task 7)

## Global Constraints

- Node.js v26, ESM (`"type": "module"`), **zero npm dependencies**, no build step.
- `HOST` defaults to `127.0.0.1`; `PORT` defaults to `3000`; both overridable by env var. Default binding must not change to `0.0.0.0`.
- All new config/review routes use explicit role array `['admin','hr']`; device push routes use `[]` with in-handler token/serial checks.
- Error statuses: 400 validation, 401 unauthenticated, 403 wrong role, 404 unknown, 405 wrong method, 409 conflict, 413 body > 1 MB.
- All 131 existing tests must remain green (`node --test`).
- New tables are added by re-running `SCHEMA` DDL in `openDatabase()`; **do not delete `data/hrms.db`** and do not alter existing table definitions (no migration framework).
- Never overwrite an existing `attendance` row from a biometric commit.
- Do not duplicate attendance derivation logic — reuse `deriveAttendance` and the extracted `recordAttendance`.
- UI wiring goes through exactly `NAV` and `SCREENS` in `public/app.js`; reuse existing `.panel/.form-grid/.btn/.data-table/.badge` classes.
- Reference-project features are ported only where they call real APIs; no decorative buttons, fake sync, or hardcoded data.

## Review Focus

| Input / condition | Expected behaviour | Pinned by test in |
| --- | --- | --- |
| ZKTeco ADMS POST with raw tab-separated ATTLOG body, no JSON content type | Parsed into punches; response is plain text `OK: <n>` | Task 5 |
| Realtime feed delivers a lone `in` punch | Stored pending, then commits as Half-day (matching manual flow); never silently dropped | Task 2, Task 4 |
| Device re-sends the same log | Deduplicated by `(device,user,timestamp,direction)`; counted as duplicate, not inserted twice | Task 2, Task 4 |
| Manual attendance already exists for employee/date | Biometric commit skips it; punches marked `ignored`/`existing_attendance`; no overwrite | Task 4 |
| Punch from a device user ID with no employee mapping | Stored `pending` with `reason='unmapped_user'`; re-resolves after mapping is added | Task 4 |
| Push request with wrong token / oversized body | 401/413 rather than 500; no unhandled rejection | Task 5 |

---

### Task 1: Biometric database schema

**Files:**
- Modify: `lib/db.js` (add four `CREATE TABLE IF NOT EXISTS` entries to `SCHEMA`)
- Test: `tests/db.test.js` (expected table-name list)

**Interfaces:**
- Produces: tables `biometric_devices`, `biometric_employee_map`, `biometric_punches`, `biometric_sync_runs` available through `TABLES` and `lib/repo.js`.

- [ ] **Step 1: Write the failing test**

In `tests/db.test.js`, extend the hard-coded expected table list from the current 18 names to include `biometric_devices`, `biometric_employee_map`, `biometric_punches`, `biometric_sync_runs` (22 total), and add an assertion that `openDatabase({path:':memory:'})` reports `SELECT name FROM sqlite_master WHERE type='table'` containing all 22.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/db.test.js`
Expected: FAIL — expected 22 tables, got 18.

- [ ] **Step 3: Add the four tables to `SCHEMA` in `lib/db.js`**

Use the column definitions in the spec's "Data model" section verbatim. Keep `CREATED_AT` for timestamps. `biometric_punches.dedupe_key` is `TEXT NOT NULL UNIQUE`; `biometric_employee_map` has the two UNIQUE constraints from the spec. Do not add SQL foreign keys (repo convention).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/db.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/db.js tests/db.test.js
git commit -m "feat(biometric): add device, mapping, punch and sync-run tables"
```

---

### Task 2: Pure punch parsing, normalization, dedupe and pairing

**Files:**
- Create: `lib/calc/biometric.js`
- Test: `tests/biometric-parser.test.js`

**Interfaces:**
- Consumes: nothing outside this task.
- Produces (exact signatures, used by Tasks 4–5):
  - `parsePunchText(text, format)` → `{ rows, errors }`; `format` is one of `'csv' | 'tsv' | 'zkteco' | 'json'`.
  - `normalizePunch(row, deviceId, source)` → `{ punch } | { error }`; punch has `{ device_id, device_user_id, punched_at, direction, verify_type, work_code, source, external_id, raw_payload, dedupe_key }`; `punched_at` is `YYYY-MM-DDTHH:MM:SS`.
  - `mapZktecoStatus(code)` → `'in' | 'out' | 'break_out' | 'break_in' | 'unknown'` (0=in, 1=out, 2=break_out, 3=break_in, 255=unknown).
  - `mapVerifyType(code)` → `'fingerprint' | 'card' | 'password' | 'face' | 'unknown'` (1/2/0/15/unknown).
  - `dedupeKey(punch)` → `device_id|device_user_id|punched_at|direction`.
  - `pairPunches(punches)` → `{ groups, unpaired }`; groups are `{ employee_id, date, punch_in, punch_out, punch_ids }`; unpaired are `{ punch, reason }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/biometric-parser.test.js` with these cases (use `node:test` / `node:assert/strict`):

```js
test('parsePunchText csv uses header aliases and returns rows', () => {
  const { rows, errors } = parsePunchText(
    'user_id,timestamp,direction\n1042,2026-01-05 09:05:00,in\n1042,2026-01-05 18:10:00,out\n', 'csv');
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].deviceUserId, '1042');
  assert.equal(rows[0].direction, 'in');
});

test('parsePunchText zkteco positional ATTLOG has no header', () => {
  const { rows } = parsePunchText('1042\t2026-01-05 09:05:00\t0\t1\t0\n', 'zkteco');
  assert.equal(rows[0].deviceUserId, '1042');
  assert.equal(rows[0].direction, 'in');
  assert.equal(rows[0].verifyType, 'fingerprint');
});

test('parsePunchText json accepts wrapper and bare array', () => {
  assert.equal(parsePunchText('{"records":[{"userId":"1042","timestamp":"2026-01-05 09:05:00"}]}', 'json').rows.length, 1);
  assert.equal(parsePunchText('[{"userId":"1042","timestamp":"2026-01-05 09:05:00"}]', 'json').rows.length, 1);
});

test('mapZktecoStatus maps 0/1/2/3/255 and mapVerifyType maps 1/2/0/15', () => {
  assert.equal(mapZktecoStatus(0), 'in');
  assert.equal(mapZktecoStatus(1), 'out');
  assert.equal(mapZktecoStatus(2), 'break_out');
  assert.equal(mapZktecoStatus(3), 'break_in');
  assert.equal(mapZktecoStatus(255), 'unknown');
  assert.deepEqual([1, 2, 0, 15].map(mapVerifyType),
    ['fingerprint', 'card', 'password', 'face']);
});

test('normalizePunch rejects malformed timestamps', () => {
  const result = normalizePunch({ deviceUserId: '1042', punchedAt: '05/01/2026', direction: 'in' }, 1, 'import');
  assert.ok(result.error);
});
```

Then add pairing tests:

```js
test('pairPunches pairs explicit directions and alternates unknown status 255', () => {
  const base = { employee_id: 3, device_id: 1, direction: 'in', punched_at: '2026-01-05T09:05:00' };
  const punches = [
    { ...base, id: 1 },
    { ...base, id: 2, direction: 'unknown', punched_at: '2026-01-05T18:10:00' },
  ];
  const { groups, unpaired } = pairPunches(punches);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].punch_in, '09:05');
  assert.equal(groups[0].punch_out, '18:10');
  assert.equal(unpaired.length, 0);
});

test('pairPunches keeps lone in commit-able and flags lone out as unpaired', () => {
  const loneIn = pairPunches([{ id: 1, employee_id: 3, device_id: 1, direction: 'in', punched_at: '2026-01-06T09:00:00' }]);
  assert.equal(loneIn.groups.length, 1);
  assert.equal(loneIn.groups[0].punch_out, null);
  const loneOut = pairPunches([{ id: 2, employee_id: 3, device_id: 1, direction: 'out', punched_at: '2026-01-06T18:00:00' }]);
  assert.equal(loneOut.groups.length, 0);
  assert.equal(loneOut.unpaired[0].reason, 'unpaired');
});

test('pairPunches attaches post-midnight out to the in date', () => {
  const { groups } = pairPunches([
    { id: 1, employee_id: 3, device_id: 1, direction: 'in', punched_at: '2026-01-05T23:30:00' },
    { id: 2, employee_id: 3, device_id: 1, direction: 'out', punched_at: '2026-01-06T01:30:00' },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].date, '2026-01-05');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/biometric-parser.test.js`
Expected: FAIL — `Cannot find module '../lib/calc/biometric.js'`.

- [ ] **Step 3: Implement `lib/calc/biometric.js`**

Follow the existing pure-module style of `lib/calc/attendance.js` (no DB/IO, no `status` errors except through returned objects). CSV/TSV parsing must handle quoted cells and CRLF; `zkteco` is positional tab-splitting with at least 2 fields. Timestamp parsing accepts `YYYY-MM-DD HH:MM:SS` and ISO variants and emits local `YYYY-MM-DDTHH:MM:SS`. Pairing rule: sort by `punched_at`; explicit directions honoured; `unknown` alternates in/out; out-after-midnight attaches to the in date; multiple pairs per day collapse to first in / last out; lone in produces a group with `punch_out: null`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/biometric-parser.test.js`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/calc/biometric.js tests/biometric-parser.test.js
git commit -m "feat(biometric): add pure punch parser, dedupe and pairing engine"
```

---

### Task 3: Device registry and employee mapping API

**Files:**
- Create: `api/biometric.js`
- Modify: `server.js` (import + `registerAllRoutes`)
- Test: `tests/biometric.test.js` (new file, `makeDb` / `startServer` / `makeClient` pattern from `tests/attendance.test.js`)

**Interfaces:**
- Consumes: tables from Task 1; `insertRow/getRow/listRows/updateRow/deleteRow` from `lib/repo.js`; `randomBytes` from `node:crypto`.
- Produces: `registerBiometricRoutes(router)` exported from `api/biometric.js`; routes `GET/POST /api/biometric/devices`, `GET/PATCH/DELETE /api/biometric/devices/:id`, `GET/POST /api/biometric/devices/:id/mappings`, `DELETE /api/biometric/devices/:id/mappings/:mappingId`.

- [ ] **Step 1: Write the failing tests**

Create `tests/biometric.test.js` with the standard harness:

```js
async function setup(role = 'hr') {
  const db = makeDb();
  const server = startServer({ db, registerRoutes: registerBiometricRoutes });
  await listen(server);
  const client = makeClient(server);
  if (role) assert.equal((await client.post('/api/auth/login', { username: role, password: 'admin123' })).status, 200);
  return { db, server, client, close: async () => { await close(server); db.close(); } };
}
```

Add tests:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/biometric.test.js`
Expected: FAIL — `Cannot find module '../api/biometric.js'`.

- [ ] **Step 3: Implement device/mapping routes in `api/biometric.js`**

Follow `api/assets.js` conventions exactly: top doc comment, `HR_ROLES`, local `httpError(status,msg)`, validation helpers, domain functions returning `{status, body}`, one registration function with only `router.register` calls. Map camelCase request bodies to snake_case DB columns. Generate `push_token` with `randomBytes(24).toString('hex')`. Catch UNIQUE violations from `repo.js` as 409. In `server.js`, import `registerBiometricRoutes` and add it as the 11th entry of `registerAllRoutes`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/biometric.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add api/biometric.js server.js tests/biometric.test.js
git commit -m "feat(biometric): device registry and employee mapping API"
```

---

### Task 4: Shared ingest, offline import, review and commit

**Files:**
- Create: `lib/biometric-ingest.js`
- Modify: `api/biometric.js` (add import/review/commit/sync-run routes)
- Modify: `api/attendance.js` (extract and export `recordAttendance(db, payload)`; existing route calls it)
- Test: `tests/biometric.test.js`, `tests/attendance.test.js` (regression assertion that manual attendance still works)

**Interfaces:**
- Consumes: `parsePunchText`, `normalizePunch`, `dedupeKey`, `pairPunches` from Task 2; `deriveAttendance` from `lib/calc/attendance.js`.
- Produces:
  - `ingestPunches(db, device, rows, source, { autoCommit })` → `{ received, inserted, duplicates, unmapped, errors }`; writes a `biometric_sync_runs` row.
  - `resolvePunchEmployees(db, deviceId)` → `{ resolved }`.
  - `commitPending(db, filters)` → `{ committed, ignored, skipped, errors }`.
  - `recordAttendance(db, payload)` exported from `api/attendance.js`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/biometric.test.js`:

```js
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
```

Add to `tests/attendance.test.js`: one assertion that a manual `POST /api/attendance` still returns 201 and `status:'Present'` after the refactor (existing test already does this; keep it green).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/biometric.test.js tests/attendance.test.js`
Expected: FAIL — unknown routes `/api/biometric/import` → 404.

- [ ] **Step 3: Implement ingest and commit**

In `lib/biometric-ingest.js`: `ingestPunches` calls `normalizePunch`, resolves `deviceUserId` through `biometric_employee_map`, inserts via `insertRow` catching the `dedupe_key` UNIQUE as a duplicate, stores `reason='unmapped_user'` when unresolved, and always writes one `biometric_sync_runs` row. `commitPending` groups with `pairPunches`, skips employee/date pairs that already have an `attendance` row, calls `recordAttendance`, marks punches `committed`/`ignored` with reasons, and returns outcome counts. With `autoCommit`, call `commitPending` for affected groups only when a full in+out pair exists.

In `api/attendance.js`: move the body of the existing HR manual-create handler into `export function recordAttendance(db, payload)` returning the created/updated attendance row; the route calls it and returns 201. Do not change validation or `deriveAttendance` usage.

In `api/biometric.js`: add `POST /api/biometric/import`, `GET /api/biometric/punches`, `POST /api/biometric/punches/:id/map`, `POST /api/biometric/punches/:id/reject`, `POST /api/biometric/punches/commit`, `GET /api/biometric/sync-runs` using the same conventions as Task 3.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/biometric.test.js tests/attendance.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/biometric-ingest.js api/biometric.js api/attendance.js tests/biometric.test.js tests/attendance.test.js
git commit -m "feat(biometric): import, punch review and non-destructive attendance commit"
```

---

### Task 5: Push paths — generic JSON webhook and ZKTeco ADMS

**Files:**
- Modify: `lib/http.js` (add `readTextBody`)
- Modify: `lib/router.js` (5th registration argument `{ rawBody: true }`)
- Modify: `api/biometric.js` (push routes)
- Test: `tests/biometric.test.js`

**Interfaces:**
- Consumes: `ingestPunches` from Task 4; `parsePunchText` from Task 2.
- Produces: `POST /api/biometric/push/:token`, `GET/POST /iclock/cdata`, `GET /iclock/getrequest`, `GET /iclock/ping`; `readTextBody(req,{limit})` from `lib/http.js`; router `register(method, pattern, roles, handler, options)`.

- [ ] **Step 1: Write the failing tests**

```js
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
    assert.match(reg.text, /Realtime=1/);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/biometric.test.js`
Expected: FAIL — 404 on `/iclock/cdata` and no token rejection logic.

- [ ] **Step 3: Implement raw body support and push routes**

In `tests/helpers.js`, add `postRaw(path, body, contentType)` by extending `request(method, path, { body, headers, raw })`: when `raw` is true, send `body` verbatim (do not `JSON.stringify`) while keeping the existing cookie-jar handling, and set `content-type` to the supplied value.

In `lib/http.js`, add `readTextBody(req,{limit = MAX_BODY_BYTES})` mirroring `readJsonBody` but returning the raw string and applying the same 413 drain behaviour.

In `lib/router.js`, accept an optional fifth argument `options = {}` in `register`, store `rawBody: options.rawBody === true`, and in `handleRequest` call `readTextBody` instead of `readJsonBody` when the matched route has `rawBody`. Leave all 131 existing routes unchanged.

In `api/biometric.js`:
- `POST /api/biometric/push/:token` — public, token lookup; optional bearer secret verified with `verifyPassword(secret, salt, hash)` where `push_secret_hash` stores `salt:hash`; call `ingestPunches(..., 'push', {autoCommit})`; return `{received, inserted}`.
- ZKTeco routes — public, match `serial_number`; `GET /iclock/cdata` returns a plain-text options block via `headers: {'Content-Type':'text/plain; charset=utf-8'}`; `POST /iclock/cdata` uses `rawBody:true`, `parsePunchText(body,'zkteco')`, `ingestPunches(...,'push')`, and returns plain text `OK: <inserted>`. `GET /iclock/getrequest` and `/iclock/ping` return `OK`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/biometric.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/http.js lib/router.js api/biometric.js tests/helpers.js tests/biometric.test.js
git commit -m "feat(biometric): generic push webhook and ZKTeco ADMS endpoints"
```

---

### Task 6: Polling, server wiring and host/port configuration

**Files:**
- Create: `lib/biometric-poller.js`
- Modify: `server.js` (env host/port, poller lifecycle)
- Modify: `api/biometric.js` (manual poll route)
- Test: `tests/biometric.test.js`

**Interfaces:**
- Consumes: `ingestPunches` from Task 4; `parsePunchText` from Task 2.
- Produces: `createPoller({ db })` → `{ start(), stop() }`; `POST /api/biometric/devices/:id/poll`.

- [ ] **Step 1: Write the failing tests**

```js
test('manual poll fetches punches from a mock device HTTP endpoint', async () => {
  // start a local http.createServer returning {"records":[...]} on /punches
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
  } finally { await h.close(); mockServer.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/biometric.test.js`
Expected: FAIL — 404 on `/poll`.

- [ ] **Step 3: Implement poller and wiring**

`createPoller({db})`: `start()` creates one `setInterval` per device with `ingestion_mode='poll'`, `adapter='http_json'`, `enabled=1`; interval `max(30, poll_interval_seconds) * 1000`; each tick `fetch(poll_endpoint, {headers: JSON.parse(poll_headers_json||'{}')})`, parse JSON with `parsePunchText(text,'json')`, call `ingestPunches(...,'poll')`, update `last_sync_at`/`last_seen_at`, back off on errors up to 15 minutes; `stop()` clears all timers. Never start automatically in tests.

`server.js`: `const HOST = process.env.HOST || '127.0.0.1'; const PORT = Number(process.env.PORT || 3000);` keep the startup log and `bindAddress` metadata consistent. In the main guard call `poller.start()` after `server.listen`, and `poller.stop()` in `shutdown()` before `server.close`. Add the manual poll route in `api/biometric.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/biometric.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/biometric-poller.js server.js api/biometric.js tests/biometric.test.js
git commit -m "feat(biometric): opt-in device polling with server lifecycle wiring"
```

---

### Task 7: Biometric SPA screen and ported reference UI

**Files:**
- Modify: `public/app.js` (`NAV`, `SCREENS`, `screenBiometric`, employee form additions)
- Modify: `public/styles.css` (badge tones / device-simulator styles)
- Test: `tests/e2e.test.js` (add UI shell assertion for the new screen's static markup if applicable; API coverage is in Task 8)

**Interfaces:**
- Consumes: all routes from Tasks 3–6.
- Produces: hash route `#/biometric` with tabs `devices | mappings | punches | import | logs | simulator`, plus biometric mapping fields in the employee create/edit form.

- [ ] **Step 1: Write the failing test**

In `tests/e2e.test.js`, add an assertion that navigating to `#/biometric` as `admin` serves the SPA shell and that `GET /api/biometric/devices` returns 200 with the admin session (API-level screen wiring check; the SPA itself has no DOM test harness in this repo).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/e2e.test.js`
Expected: FAIL — 404 on `/api/biometric/devices` when production wiring (`registerAllRoutes`) is used unless Task 3 already wired it; expected new assertion fails.

- [ ] **Step 3: Implement the UI**

In `public/app.js`:
- Add `{ key: 'biometric', label: 'Biometric', glyph: '◉', roles: HR_ROLES }` to `NAV` and `biometric: screenBiometric` to `SCREENS`.
- Implement `async function screenBiometric()` using existing `screen()`, `panel()`, `dataTable()`, `createForm()`, `openModal()`, `toast()`, `api()` helpers. Tabs are local state (no new hash routes):
  - **Devices**: table + create/edit modal with all config fields from the spec; actions "Copy push URL", "Poll now", delete.
  - **Mappings**: device select, table of `device_user_id → employee`, add/remove.
  - **Punches**: filterable review queue; Map / Reject row actions; "Commit pending" button.
  - **Import**: device select, format select, file input read with `File.text()` + textarea, preview parsed rows via a server-side preview or local count, Import button, sync summary toast.
  - **Logs**: `dataTable` of sync runs.
  - **Simulator**: ported from `DeviceSimulatorView.jsx` — a hardware-style panel that calls `POST /api/biometric/push/:token` with a real JSON punch (`userId`, `timestamp`, `direction`) for a selected mapped employee and shows the server response. No fake `setTimeout` sync, no confetti, no hardcoded stats.
- In the employee create/edit form, add "Attendance source" radios (Mobile / Biometric / Both), a device select, and a "Biometric code" input. Persist these through `biometric_employee_map` (device + device user ID) rather than adding columns to `employees` — no migration needed.
- Port the muster matrix look from `AttendanceView.jsx` as a real monthly grid backed by `GET /api/attendance` (status P/A/HD/L/WO/H derived from existing attendance rows and approved leave/holidays), shown in the existing Attendance screen or as a sub-tab of Biometric.

In `public/styles.css`, add badge tone rules for `pending`, `committed`, `ignored`, `rejected` and minimal simulator styling reusing existing panels/buttons.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/e2e.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/app.js public/styles.css tests/e2e.test.js
git commit -m "feat(biometric): device config UI, punch review, simulator and mapping fields"
```

---

### Task 8: End-to-end verification and documentation

**Files:**
- Modify: `tests/e2e.test.js` (extend the sequential walkthrough)
- Modify: `README.md`
- Test: full suite

**Interfaces:**
- Consumes: every route from Tasks 3–6 through `registerAllRoutes`.

- [ ] **Step 1: Write the failing e2e scenario**

Extend the existing single walkthrough in `tests/e2e.test.js` with a final block:

```js
// after existing payroll steps
const device = await client.post('/api/biometric/devices', { name: 'E2E Gate', serialNumber: 'SN-E2E', ingestionMode: 'offline', adapter: 'zkteco_adms' });
assert.equal(device.status, 201);
const mapping = await client.post(`/api/biometric/devices/${device.body.id}/mappings`, { employeeId: empId, deviceUserId: '9001' });
assert.equal(mapping.status, 201);
const imported = await client.post('/api/biometric/import', {
  deviceId: device.body.id, format: 'zkteco', text: '9001\t2026-02-03 09:00:00\t0\t1\t0\n9001\t2026-02-03 18:00:00\t1\t1\t0\n',
});
assert.equal(imported.body.inserted, 2);
const committed = await client.post('/api/biometric/punches/commit', { deviceId: device.body.id });
assert.equal(committed.body.committed, 2);
// run payroll for that month and assert the payslip exists / present days counted
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/e2e.test.js`
Expected: FAIL if any earlier wiring is incomplete.

- [ ] **Step 3: Implement any missing wiring (if needed)**

Only add what the failing e2e exposes (usually a missing `registerAllRoutes` entry). Do not add new behaviour here.

- [ ] **Step 4: Update README.md**

Add: the Biometric row to the modules table; endpoint summary; `HOST`/`PORT` env vars and a LAN-exposure warning; revise "no background jobs/scheduler" and "no integrations" to say polling/push are opt-in; document the first-in/last-out and ZKTeco `255` simplifications; note that new tables are added to an existing DB on next start without data loss. Do not claim vendor binary-protocol support.

- [ ] **Step 5: Verify everything**

Run: `node --test`
Expected: all tests pass, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e.test.js README.md
git commit -m "docs+test: biometric e2e walkthrough and README updates"
```

---

## Self-review notes

- **Spec coverage:** device registry (T3), mapping (T3), offline import (T4), push generic (T5), push ZKTeco ADMS (T5), polling (T6), review/inbox (T4), commit + payroll integration (T4/T8), security/token/secret (T3/T5), host binding (T6), UI + ported reference features (T7), tests + README (T8). Builder-check resolutions are pinned in T2 (pairing/lone punch), T4 (auto-commit, conflicts, unmapped), T5 (parser contract, secret storage).
- No spec requirement was left without a task.
