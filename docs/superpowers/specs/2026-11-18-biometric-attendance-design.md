# Biometric Attendance Integration — Design

Date: 2026-11-18
Status: Draft for approval
Repo: `C:\Users\AXIOMTHREED\HR-software-RE`

## Intent and why

The HRMS has no concept of a biometric/attendance machine. Today all attendance is entered
manually through `POST /api/attendance` (HR) or `POST /api/attendance/self` (employee), using
`HH:MM` strings. The user reports this gap and asks for capability "same as Tankhwa Patra
HRMS & Payroll Solution" — specifically **biometric attendance machine configuration**.

Tankhwa Patra's documented behaviour: register biometric/face/RFID devices, map device users
to employees, pull punches into attendance (which feeds payroll), and also accept offline
CSV/Excel/USB uploads. The user chose **all three** ingestion paths: offline import, device
push, and device polling.

Value: attendance stops being purely manual; punches from real machines land in a reviewable
inbox, get mapped to employees, and feed the existing attendance rule engine and payroll
without changing payroll math.

## Goals

1. Register and configure biometric machines (identity, model/type, network info, ingestion
   mode, adapter, status, sync timestamps).
2. Map each machine's user ID / biometric ID / badge number to an HRMS employee.
3. Ingest punches three ways: **offline CSV/TSV import**, **device push** (generic JSON webhook
   + ZKTeco ADMS-compatible HTTP endpoints), and **polling** (periodic HTTP fetch).
4. Deduplicate and review incoming punches; commit approved punches into `attendance` using the
   existing rule engine so payroll sees them with no changes.
5. Keep the app's conventions: Node built-ins only, zero npm dependencies, ESM, same router /
   repo / role / error / UI / test patterns.
6. Keep the default host binding safe (`127.0.0.1`); make LAN exposure an explicit opt-in.

## Non-goals

- Vendor **binary** device protocols (e.g. ZKTeco ZK protocol over TCP port 4370). Push and
  poll both use HTTP, which is what modern IP/face devices and ADMS firmware speak.
- Device-side enrolment / fingerprint or face template management (enrolment stays on the
  machine; this app only manages the ID-to-employee mapping).
- XLSX/Excel binary parsing. Import accepts CSV/TSV text only (Excel can export CSV).
- GPS / geo-fencing, mobile-app punch-in, face recognition, visitor gates.
- HTTPS/TLS, CSRF tokens, rate limiting, audit trail — existing non-goals remain.
- Changing payroll or attendance calculation rules.

## Anti-goals (what would make this a failure even if it "works")

- Breaking any of the 131 existing tests or the manual attendance flow.
- Silently exposing a push endpoint on `0.0.0.0` by default.
- Claiming "works with any biometric machine" — hardware compatibility is bounded to HTTP
  push/poll and CSV export until a specific model is tested.
- Duplicating attendance derivation logic in two places.

## Constraints

- Node v26, ESM (`"type": "module"`), no npm dependencies, no build step.
- `lib/db.js` exports a single `SCHEMA` object of `CREATE TABLE IF NOT EXISTS` statements;
  `TABLES` is derived from it and `lib/repo.js` validates every table/column against it.
- Router: `register(method, pattern, roles, handler)`; `roles: []` means public; empty-body
  methods are GET/HEAD; bodies are parsed as JSON with a 1 MB limit.
- `lib/http.js` `sendJson` already emits a raw body when a non-JSON `Content-Type` header is
  set — reusable for device-facing plain-text responses.
- `renderStatic` returns `false` for non-GET/HEAD and for `/api/*`; a missing `/iclock/*` file
  also returns `false`, so device-facing routes can live outside `/api/` without collision.
- UI: `public/app.js` wires screens through exactly two maps — `NAV` and `SCREENS`.
- Existing DB has 18 tables; `tests/db.test.js` hard-codes that list and must be updated.
- No migration framework, but `openDatabase()` re-runs all `SCHEMA` DDL at every startup, so
  **new tables are added to the existing `data/hrms.db` automatically with no data loss**.

## Approaches

Three approaches were laid out and the user chose **all three**, unified into one subsystem:

| Path | Mechanism | Tradeoff |
| --- | --- | --- |
| A — Offline import | Upload/paste device-exported CSV/TSV → parse → review → commit | Fully offline, zero deps; not real-time (manual export) |
| B — Device push | Inbound HTTP: generic JSON webhook + ZKTeco ADMS endpoints | Near-real-time; needs LAN reachability and token/serial auth |
| C — Polling | In-process `setInterval` fetches punches from a device HTTP endpoint | Near-real-time without device reconfiguration; needs a background timer |

Chosen design: a **shared device registry + shared punch inbox**, with all three paths writing
the same punch rows. Path A is the baseline that always works. Path B adds compatibility with
common IP/face devices and ZKTeco ADMS firmware using only `node:http` parsing. Path C reuses
the same JSON shape as Path B and is opt-in per device.

Implications explicitly accepted by the user's "all three" choice:

1. **HOST binding** becomes configurable via `process.env.HOST`, default `127.0.0.1`. Port via
   `process.env.PORT`, default `3000`. README warns that device push/poll requires LAN binding.
2. **A background timer** exists for polling. It is started only by the production main guard
   and only for devices with `ingestion_mode='poll'`, `adapter='http_json'`, `enabled=1`.
3. **Raw request bodies** are needed for ZKTeco's tab-separated POSTs; the router gains an
   opt-in `rawBody` flag without changing default JSON behaviour.

## Design

### Data model (four new tables added to `SCHEMA` in `lib/db.js`)

`biometric_devices` — machine configuration:

| Column | Notes |
| --- | --- |
| `id` PK | |
| `name` NOT NULL | Human label |
| `vendor` NOT NULL default `generic` | `generic` \| `zkteco` |
| `model` | Free text |
| `device_type` NOT NULL default `fingerprint` | `fingerprint` \| `face` \| `rfid` \| `card` |
| `serial_number` NOT NULL UNIQUE | Device SN; used to identify ADMS push senders |
| `ip_address`, `port`, `location` | Inventory / documentation |
| `ingestion_mode` NOT NULL default `offline` | `offline` \| `push` \| `poll` |
| `adapter` NOT NULL default `generic_json` | `generic_json` \| `zkteco_adms` \| `http_json` |
| `push_token` NOT NULL UNIQUE | Generated `randomBytes(24).hex`; used in push URL |
| `push_secret_hash` | Optional bearer secret stored as combined `salt:hash` (reuse auth hashing); plaintext returned once on create/rotate |
| `poll_endpoint` | URL to fetch punches from (poll/http_json) |
| `poll_headers_json` | Optional JSON object of auth headers for polling |
| `poll_interval_seconds` NOT NULL default 60 | Floor of 30 enforced |
| `auto_commit` NOT NULL default 0 | If 1, valid punches commit immediately (admin opt-in) |
| `enabled` NOT NULL default 1 | Master switch |
| `last_seen_at`, `last_sync_at` | Status timestamps |
| `created_at`, `updated_at` | |

`biometric_employee_map` — enrolment mapping:

| Column | Notes |
| --- | --- |
| `id` PK | |
| `device_id` NOT NULL | |
| `employee_id` NOT NULL | FK by convention only (no SQL FKs in this repo) |
| `device_user_id` NOT NULL | PIN / badge / biometric ID as stored on the machine |
| `created_at` | |
| UNIQUE (`device_id`,`device_user_id`), UNIQUE (`device_id`,`employee_id`) | One ID and one employee per device |

Simplification: an employee has one ID per device. Multi-ID-per-device is deferred.

`biometric_punches` — the shared inbox:

| Column | Notes |
| --- | --- |
| `id` PK | |
| `device_id` NOT NULL | |
| `device_user_id` NOT NULL | |
| `employee_id` | Resolved from map; NULL until mapped |
| `punched_at` NOT NULL | ISO-like `YYYY-MM-DDTHH:MM:SS` in local time |
| `direction` NOT NULL | `in` \| `out` \| `break_out` \| `break_in` \| `unknown` |
| `verify_type` | `fingerprint` \| `card` \| `password` \| `face` \| `unknown` |
| `work_code`, `external_id`, `raw_payload` | Traceability |
| `source` NOT NULL | `import` \| `push` \| `poll` |
| `dedupe_key` NOT NULL UNIQUE | `deviceId|deviceUserId|punchedAt|direction` |
| `status` NOT NULL default `pending` | `pending` \| `committed` \| `rejected` \| `ignored` |
| `reason` | e.g. `unmapped_user`, `unpaired`, `duplicate` |
| `created_at` | |

`biometric_sync_runs` — audit of each import/push batch/poll:

`id`, `device_id` (nullable), `source`, `started_at`, `finished_at`, `status`
(`running`\|`ok`\|`failed`), `received`, `inserted`, `duplicates`, `rejected`, `error`, `created_at`.

Update `tests/db.test.js` expected table list from 18 to 22.

### Pure parsing / pairing logic (`lib/calc/biometric.js`)

No DB/IO, matching the other `lib/calc/*` modules:

- `parsePunchText(text, format)` → `{ rows, errors }`. The caller declares the format
  explicitly, so there is no header-sniffing ambiguity: `csv` and `tsv` are **headered** with
  aliases (user: `user_id`,`pin`,`employee_code`,`enrollment`; timestamp: `timestamp`,`time`,
  `date_time`,`punch_time`, or separate `date`+`time`; direction: `direction`,`status`,`in_out`;
  plus `verify_type`, `work_code`). `zkteco` is **positional, headerless** ADMS ATTLOG TSV
  (`pin \t time \t status \t verify \t workcode ...`) and is used both for offline exports and
  for the ADMS POST body. `json` accepts either the `{ records: [...] }` wrapper used by generic
  push **or** a bare array of records.
- `normalizePunch(row, deviceId, source)` → validated punch or a named error. Parses
  `YYYY-MM-DD HH:MM:SS` and ISO variants into `YYYY-MM-DDTHH:MM:SS`.
- `mapZktecoStatus(code)` → 0/0-based in/out/break mapping; `255` (some firmware "normal") →
  `unknown`. `mapVerifyType(1|2|0|15)` → fingerprint/card/password/face.
- `dedupeKey(punch)` → stable key.
- `pairPunches(punches)` → group by `(employee_id, date-of-punch-in)`, sort chronologically,
  then pair. Explicit `in`/`out` directions are honoured; `unknown`/`255` punches alternate
  (first unknown of a day = in, next = out, and so on) so devices that don't report direction
  still work. A lone `in` (no later `out`) is still commit-able as a Half-day — the manual flow
  allows punch-in-only rows, and `deriveAttendance` already yields Half-day when worked minutes
  are 0. A lone `out` with no preceding `in` cannot produce an attendance row and stays
  `pending` with `reason='unpaired'`. A punch-out after midnight attaches to the date of the
  preceding in (no cross-midnight split). One attendance row per employee per day: multiple
  pairs collapse to first-in / last-out (overtime still comes from the last out).

### Path A — Offline import

`POST /api/biometric/import` with `{ deviceId, format?: 'csv'|'tsv'|'json', text, filename? }`
(raw text inside JSON, no multipart dependency). UI reads a file via `File.text()` or accepts
pasted text. Flow: parse → normalize → resolve `device_user_id` to employee via map → dedupe →
insert pending punches + a `biometric_sync_runs` row → return `{ received, inserted,
duplicates, unmapped }`. Unmapped users are stored as `pending` with `reason='unmapped_user'`
so HR can map later and re-resolve via `POST /api/biometric/punches/:id/map`.

### Path B — Push

- Generic JSON: `POST /api/biometric/push/:token` (public route, `rawBody: false`), JSON body
  `{ records: [ { userId, timestamp, status?, direction?, verifyType?, workCode? } ] }`.
  Token lookup identifies the device; optional `Authorization: Bearer <secret>` verified with
  the existing `verifyPassword`. Device must have `ingestion_mode='push'`.
- ZKTeco ADMS (registered outside `/api/`, all public with serial validation):
  - `GET /iclock/cdata?SN=<serial>&options=all` → `text/plain` options block including
    `Realtime=1`, `TransInterval=1`, `TransFlag=...`, `ServerVer`, `Encrypt=None`.
  - `POST /iclock/cdata?SN=<serial>&table=ATTLOG&Stamp=...` with raw TSV body
    `pin \t YYYY-MM-DD HH:MM:SS \t status \t verify \t workcode ...` (multiple lines) →
    ingest → respond `OK: <n>` (plain text).
  - `GET /iclock/getrequest?SN=...` → `OK` (no pending commands);
    `GET /iclock/ping?SN=...` → `OK`.
  - Serial is matched against `biometric_devices.serial_number` where
    `adapter='zkteco_adms'`. Also register `.aspx` aliases if the firmware requires them.
- Router extension: `register(method, pattern, roles, handler, { rawBody: true })`; in
  `handleRequest`, when `rawBody` is set, call a new `readTextBody(req, {limit})` from
  `lib/http.js` instead of `readJsonBody`. Default behaviour is unchanged for every existing
  route.

### Path C — Polling

- Manual: `POST /api/biometric/devices/:id/poll` (HR roles) fetches `poll_endpoint` with
  configured headers using global `fetch()`, expects the same JSON shape as generic push,
  and ingests it through the same shared function.
- Background: new `lib/biometric-poller.js` exports `createPoller({ db })` → `{ start(), stop() }`.
  `start()` creates one timer per eligible device (poll/http_json/enabled), interval
  `max(30, poll_interval_seconds)`; each tick skips if `last_sync_at` is too recent, ingests,
  updates `last_sync_at` / `last_seen_at`, and records a sync run. Errors apply exponential
  backoff capped at 15 minutes. `stop()` clears all timers.
- `server.js`: main guard calls `poller.start()` after `server.listen`; `shutdown()` calls
  `poller.stop()` before `server.close`. Tests never start the poller; they use the manual
  poll endpoint against a local mock HTTP server.

### Punch → attendance integration

Refactor `api/attendance.js` to export a reusable `recordAttendance(db, payload)` that contains
the existing validation, holiday/leave handling, `deriveAttendance` call, and upsert. Both
`POST /api/attendance` and the new biometric commit call it — no duplicated rule engine.

`POST /api/biometric/punches/commit` (HR roles), optional filters `{ deviceId, employeeId, from, to }`:
select `pending`, `employee_id IS NOT NULL`, pair punches per employee/date, and call
`recordAttendance` with derived `punchIn`/`punchOut`. Success → mark punches `committed`;
unpaired punches stay `pending` with `reason='unpaired'`. Payroll needs no changes because it
reads `attendance` rows.

Commit is **non-destructive and non-atomic per pair**: if an `attendance` row already exists for
an employee/date (e.g. entered manually), that pair is skipped and its punches are marked
`ignored` with `reason='existing_attendance'` — HR data is never silently overwritten. A bad
pair (unknown employee, backwards times) is skipped with a recorded reason; the rest of the
batch still commits. The response reports counts per outcome.

`auto_commit=1` means **commit-on-complete-pair**: the shared ingest path attempts a commit for
the affected `(employee,date)` groups, but commits a day only once it has both an in and an out.
Lone punches remain `pending` and are committed when their complement arrives (possibly in a
later push/poll batch). This avoids writing wrong attendance from realtime single-punch feeds.

### API surface (all config/review endpoints `['admin','hr']`)

| Method | Path | Purpose |
| --- | --- | --- |
| GET, POST | `/api/biometric/devices` | List / register devices |
| GET, PATCH, DELETE | `/api/biometric/devices/:id` | Detail / edit / remove |
| POST | `/api/biometric/devices/:id/poll` | Manual poll run |
| GET, POST | `/api/biometric/devices/:id/mappings` | List / add employee mapping |
| DELETE | `/api/biometric/devices/:id/mappings/:mappingId` | Remove mapping |
| POST | `/api/biometric/import` | CSV/TSV/JSON import |
| GET | `/api/biometric/punches` | Filters: device, employee, status, from, to |
| POST | `/api/biometric/punches/:id/map` | Assign employee to unmapped punch |
| POST | `/api/biometric/punches/:id/reject` | Reject a punch |
| POST | `/api/biometric/punches/commit` | Commit pending punches to attendance |
| GET | `/api/biometric/sync-runs` | Sync history |
| POST | `/api/biometric/push/:token` | Public generic JSON device push |
| GET, POST | `/iclock/cdata`, `/iclock/getrequest`, `/iclock/ping` | Public ZKTeco ADMS |

### Security model

- All configuration, mapping, import, review, and commit routes use `HR_ROLES`. Employees get
  403; unauthenticated gets 401 via the router.
- Push endpoints are router-public (`roles: []`) because machines have no session; they are
  protected in-handler by unguessable `push_token` (generic) and serial number + optional
  bearer secret (ADMS). Tokens/secrets are generated server-side and shown only in the device
  detail UI.
- Body size limit (1 MB) is reused. No rate limiting (existing non-goal) — README will warn
  that push/poll must be restricted to a trusted LAN.
- Default `HOST=127.0.0.1` unchanged; LAN exposure only via explicit `HOST=0.0.0.0`.

### UI (`public/app.js`, `public/styles.css`)

One nav item `biometric` (glyph `◉`, `HR_ROLES`) plus `SCREENS.biometric = screenBiometric`.
A single screen with internal tabs (local state, no new routes):

- **Devices** — `dataTable` of registered machines with status/last sync; `createForm` modal for
  name, vendor, model, type, serial, IP, port, location, ingestion mode, adapter, poll endpoint,
  interval, enabled. Actions: "Copy push URL" (shows
  `http://<host>:<port>/api/biometric/push/<token>`), "Test/Poll now", edit, delete.
- **Mappings** — per-device table of `device_user_id → employee` using `selectControl` from
  `GET /api/employees`; add/remove.
- **Punches** — review queue filtered by device/employee/status/date; shows derived direction,
  mapped employee, source, status; row actions Map / Reject; "Commit pending" button.
- **Import** — device select, file input + textarea, format select, preview of parsed rows,
  "Import", then sync summary toast.
- **Sync log** — `dataTable` of `biometric_sync_runs`.

Reuse `.panel`, `.form-grid`, `.btn`, `.data-table`, `.badge`; add badge tone rules for the new
statuses if colouring is desired.

### Tests

- New `tests/biometric-parser.test.js`: pure parser/normalizer/dedupe/pairing/status-mapping
  tests for CSV, TSV, ZKTeco ATTLOG, and generic JSON, including malformed rows and
  `255`/`unknown` status.
- New `tests/biometric.test.js`: follow `tests/attendance.test.js` exactly — `makeDb()`,
  `startServer({ db, registerRoutes: registerBiometricRoutes })`, `makeClient`, ephemeral port.
  Cover device CRUD, mappings, import, unmapped re-resolution, reject/commit → attendance row,
  generic push (valid/invalid token/secret), ZKTeco ADMS registration + ATTLOG POST response
  `OK: n`, manual poll against a local mock `http.createServer`, and 401/403/404/405 rules.
- Update `tests/db.test.js` table count/list (18 → 22).
- Extend `tests/e2e.test.js` with one sequential scenario: register device → map employee →
  import punches → commit → assert attendance row → run payroll → assert payslip reflects it.
- Keep all existing tests green (`node --test`, currently 131 passing).

### Compatibility and rollout

- Adding the four tables is safe on the existing `data/hrms.db`: `openDatabase()` re-executes all
  `SCHEMA` DDL on startup, so they appear on next start; no existing rows change and no DB
  deletion is required (deleting would be needed only if we later *altered* an existing table).
- The feature is inert until a device is configured; default modes are offline/manual and
  polling starts for no device by default.
- README updates: new module row in the modules table; endpoint notes; `HOST`/`PORT` env
  variables and LAN warning; revise "no background jobs/scheduler" and "no integrations"
  non-goals to say polling/push are opt-in; add the first-in/last-out simplification and the
  ZKTeco status `255` caveat.

## Builder-check resolutions (decisions made — open to correction)

An independent reviewer flagged five ambiguities. They were resolved as builder calls, each
consistent with the existing app; the user can override any of them before implementation.

1. **Pairing and lone punches.** Pair chronologically per employee/date; honour explicit
   in/out, alternate `unknown`/`255` punches; a lone `in` commits as Half-day (matching the
   manual flow); a lone `out` stays `pending` as `unpaired`; post-midnight outs attach to the
   in-date. Rationale: devices vary in direction reporting, and the manual flow already
   supports punch-in-only rows.
2. **`auto_commit`.** Commit a day only when both in and out are present (commit-on-complete-
   pair); lone punches wait in the inbox. Rationale: realtime feeds deliver one punch at a time.
3. **Conflicts and partial failure.** Existing attendance rows are never overwritten (mark
   punches `ignored`/`existing_attendance`); bad pairs are skipped, not fatal; the rest of the
   batch commits. Rationale: protect HR-entered data.
4. **Bearer secret storage.** No separate salt column: `push_secret_hash` stores `salt:hash`
   using the existing scrypt helper; plaintext is returned exactly once on create/rotate via
   `PATCH /api/biometric/devices/:id` (`{ rotateSecret: true }`). The token is the primary
   credential for generic push; serial + optional secret for ADMS.
5. **Parser input contract.** `format` is explicit: `csv`/`tsv` = headered, `zkteco` =
   positional headerless ATTLOG TSV, `json` = `{records:[...]}` or bare array. Rationale:
   removes header-sniffing ambiguity and keeps ADMS compatible.

## What's left to the builder (explicitly deferred)

- Vendor binary protocol adapters (ZKTeco TCP/4370, proprietary face-device SDKs) — requires a
  specific device model and likely a dependency, which is out of scope here.
- XLSX parsing, other vendor CSV column layouts found in the wild.
- Device-side enrolment, face template upload, and remote configuration.
- HTTPS/TLS termination and reverse-proxy setup for LAN exposure.
- Automatic commit policies beyond the per-device `auto_commit` flag; multi-ID-per-employee
  mapping; splitting multiple daily punch pairs into multiple attendance rows.

## Rough size and sequencing

This is a **project** (not a small change), estimated at roughly 3–4 new API modules' worth of
work plus infrastructure. Suggested order:

1. DB schema + pure parser/pairing module + parser tests.
2. Device registry + mapping API + UI scaffolding; update `db.test.js`.
3. Offline import + review/commit + `recordAttendance` refactor + attendance tests.
4. Push: router raw-body support + generic JSON + ZKTeco ADMS.
5. Poller + `server.js` wiring + HOST/PORT env + README.
6. E2E scenario + full `node --test` verification.
