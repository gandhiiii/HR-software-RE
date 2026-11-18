# HRMS — local, offline human-resources management

A single-process HRMS web app built with **Node.js built-in modules only**. No npm
dependencies, no build step, no required external services. By default it makes
no network calls and binds to **127.0.0.1:3000**, serving both a browser SPA and
a JSON API backed by a local SQLite database (`node:sqlite`). Biometric device
push and polling are optional, opt-in integrations (see below); nothing contacts
a device unless you explicitly configure and enable it.

## Requirements and startup

- Node.js **v26** (any release with a stable `node:sqlite` works; developed and
  tested on v26). No `npm install` is needed — there are no dependencies.

From this directory:

```sh
node server.js
```

Then open <http://127.0.0.1:3000/>. (`npm start` is an equivalent alias.)

On first start the app creates `data/hrms.db`, applies the schema, and seeds
reference data. Seeding only runs when the `users` table is empty, so subsequent
starts reuse existing data. New tables added in later versions (including the
biometric tables) are created automatically on the next start through
`CREATE TABLE IF NOT EXISTS`; existing rows are never dropped or rewritten, so
upgrading an existing database does not lose data. There is no destructive
migration step. Stop the server with `Ctrl+C`; SIGINT/SIGTERM close the database
cleanly and stop the optional biometric poller.

### Host and port

The bind address is controlled by two environment variables:

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `HOST`   | `127.0.0.1` | Interface to listen on. |
| `PORT`   | `3000`      | TCP port to listen on. |

```sh
HOST=127.0.0.1 PORT=3000 node server.js
```

> **LAN-exposure warning:** the defaults keep the app on loopback only. Setting
> `HOST=0.0.0.0` (or a LAN address) exposes it to other machines. This is a
> local demo with public seed passwords, in-memory sessions, no TLS, no CSRF
> token beyond `SameSite=Lax`, and no rate limiting — do **not** expose it on an
> untrusted or public network.

## Seed credentials

Three demo accounts are seeded, all with the password **`admin123`**:

| Username | Role       | Linked employee |
| -------- | ---------- | --------------- |
| `admin`  | `admin`    | none            |
| `hr`     | `hr`       | EMP002 (Priya Patel) |
| `employee` | `employee` | EMP003 (Rohan Verma) |

`admin` and `hr` can manage every module. `employee` accounts can record their
own attendance, apply for and view their own leave and expenses, see their own
tasks/payslips/reports, but cannot run payroll or change other employees' data.

## Modules and API notes

All API endpoints live under `/api/*` and speak JSON. The browser UI is served
at `/` and is purely static (`public/index.html`, `public/app.js`,
`public/styles.css`); it uses the same API with same-origin cookie credentials.

| Module | Source | What it provides |
| ------ | ------ | ---------------- |
| Auth & sessions | `lib/auth.js` | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` |
| Employees & org | `api/employees.js` | Employee CRUD (`/api/employees`), `GET /api/departments`, `GET /api/designations` |
| Attendance | `api/attendance.js` | Record/list attendance, `/api/attendance/summary`, `/api/attendance/self`, `GET /api/shifts` |
| Leave | `api/leave.js` | Leave types/balances, `/api/leave/requests`, approve/reject decisions |
| Payroll | `api/payroll.js` | `/api/payroll/run`, payslip list/detail/edit/finalize/pay, `/api/payroll/register.csv` |
| Expenses | `api/expenses.js` | Submit/list expenses, approve/reject, flag for reimbursement |
| Tasks | `api/tasks.js` | Task CRUD, assignment, status changes, comments |
| Assets | `api/assets.js` | Asset register CRUD, assign/return, assignment history |
| Reports | `api/reports.js` | Dashboard + attendance/leave/payroll/expense reports (JSON or CSV) |
| Settings | `api/settings.js` | 18-key settings map, holiday CRUD |
| Biometric | `api/biometric.js` | Device registry + employee mapping, punch import/push/poll, review & commit to attendance, sync history |

API conventions:

- Authentication is a process-local, `HttpOnly` + `SameSite=Lax` session cookie
  named `hrms_session`. There are no API keys or tokens in config.
- Every route declares an explicit role allow-list; unauthenticated calls return
  **401**, wrong-role calls **403**, unknown paths **404**, wrong methods **405**.
- Validation errors are **400**; duplicate/conflict conditions (e.g. duplicate
  employee code, overdraw leave approval, assigning an unavailable asset) are
  **409**. Request bodies over 1 MB are **413**.
- Responses are JSON except CSV exports. Request a report with `?format=csv` or
  the `.csv` alias (e.g. `/api/reports/payroll.csv`), or use
  `/api/payroll/register.csv`; these return `text/csv` with a
  `Content-Disposition: attachment` header.
- CSV output follows RFC 4180 (CRLF lines, quoted/escaped cells) and guards
  against spreadsheet formula injection.
- The app uses the local system clock/timezone for "today" and stores ISO dates
  (`YYYY-MM-DD`). Payroll does **not** recompute on read — reports read the
  payslips stored by a payroll run.

### Biometric endpoints

Biometric routes are restricted to HR roles (`admin`, `hr`) unless noted. Devices
are configured with an `ingestionMode` of `offline` (manual import), `push`
(device-initiated HTTP) or `poll` (server-initiated HTTP); each device gets a
random `pushToken` that is the credential for its push webhook.

**HR configuration and review**

| Endpoint | Purpose |
| -------- | ------- |
| `GET /api/biometric/devices`, `POST /api/biometric/devices` | List / register devices |
| `GET, PATCH, DELETE /api/biometric/devices/:id` | Read / update / remove a device |
| `GET, POST /api/biometric/devices/:id/mappings` | List / add device-user ↔ employee mappings |
| `DELETE /api/biometric/devices/:id/mappings/:mappingId` | Remove a mapping |
| `POST /api/biometric/devices/:id/poll` | Fetch and ingest one device's JSON batch now |
| `POST /api/biometric/import` | Import offline punch text (`format`: `csv`, `tsv`, `zkteco` or `json`) |
| `GET /api/biometric/punches`, `POST /api/biometric/punches/commit` | Review queue / commit pending pairs to attendance |
| `POST /api/biometric/punches/:id/map`, `.../:id/reject` | Manually map or reject a punch |
| `GET /api/biometric/sync-runs` | Ingest history (received/inserted/duplicates/rejected) |

**Device-facing (public) endpoints** authenticate in-handler, not via the session
cookie:

- `POST /api/biometric/push/:token` — generic JSON push webhook; the URL token is
  the credential, with an optional `Bearer` secret on the device.
- `GET/POST /iclock/cdata`, `GET /iclock/getrequest`, `GET /iclock/ping` — ZKTeco
  ADMS **text-over-HTTP** endpoints (plain-text replies, headerless tab-separated
  ATTLOG rows on POST). These implement the ADMS HTTP protocol only; the vendor's
  proprietary binary protocol (direct TCP/4370) is **not** supported.

Ingest is idempotent (punches are deduped by device + user + timestamp +
direction) and non-destructive: committing never overwrites an existing
attendance row. When a device has `autoCommit` enabled, complete pairs are
committed as they arrive; otherwise punches wait in a review queue. Committed
days flow into the normal attendance/payroll pipeline — no separate pay logic.

## Calculation rules (India / INR / Gregorian)

All money is in INR, rounded to the nearest whole rupee at write time. Defaults
live in the `settings` table and are read on every payroll run; they can be
changed through `PATCH /api/settings`.

Earnings and deductions for a payslip:

```
earnings = basic + hra + allowances + overtimePay + reimbursement
hourly basic = basic / (workingDays * 8)
overtimePay  = (overtimeMinutes / 60) * hourly basic * overtimeMultiplier
PF           = pfRate% of basic, capped at pfCeiling of basic
ESIC         = esicRate% of gross when gross <= esicCeiling, otherwise 0
professional tax = flat monthly amount
income tax   = taxRate% of gross (flat rate; no slabs or exemptions)
unpaid leave = (basic + hra + allowances) / workingDays * unpaidLeaveDays
deductions   = PF + ESIC + professional tax + income tax + unpaid leave
net          = gross - deductions
```

Seeded defaults: `working_days_per_month = 30`, `pf_rate = 12`,
`pf_ceiling = 15000`, `esic_rate = 0.75`, `esic_ceiling = 21000`,
`professional_tax = 0`, `income_tax_rate = 0`, `overtime_cap_minutes = 240`,
`overtime_multiplier = 1.5`.

Attendance is derived by a pure rule engine, first match wins:
**Leave → Holiday/weekly-off → Absent (no punch-in) → Half-day → Present**.
A day is a half-day when punch-in is later than shift start + grace (default
`grace_minutes = 10`) or fewer than 240 minutes were worked. Overtime is
`min(240, max(0, punchOut - shiftEnd))` with the default shift `09:00–18:00` and
a Sunday weekly off (`weekly_off_day = 0`). One row is stored per employee per
date. Self-service attendance ignores any client-supplied employee id, leave /
holiday flags, and shift id.

Leave approval debits the balance, rejection restores it, and an overdraw is
rejected with 409. Only approved leave whose **type name contains "unpaid"**
becomes unpaid days in payroll; attendance "absent" days do **not** reduce pay.

Payroll writes one draft slip per active employee per month; re-running updates
existing drafts only (never finalized/paid slips, never duplicates). Finalizing
or paying a slip moves that month's flagged, approved expenses to `reimbursed`.

## What works

- Complete CRUD/workflow API for all modules listed above, wired into the
  production `node server.js` entry point via `registerAllRoutes()` in
  `server.js`.
- Responsive, hash-routed browser SPA with role-aware navigation for every
  module; no external assets or fonts.
- Cookie-based login/logout, explicit role checks, clean validation/error
  statuses, and CSV exports with formula-injection protection.
- Local SQLite persistence with deterministic seed data; process-local
  sessions; no network access required in the default configuration.
- Opt-in biometric device integration: registry and mappings, offline/push/poll
  ingest with dedupe, a review queue, and non-destructive commit into attendance.
- `tests/e2e.test.js` walks the entire application from login through every
  module — including a biometric device → import → commit → payroll path — to
  CSV export against the same wiring production uses.

## Explicit non-goals / known limits

- **Local, single-user demo only.** No multi-tenancy, no HTTPS/TLS, no CSRF
  token beyond `SameSite=Lax`, no rate limiting, no audit trail, and no
  production hardening.
- **Sessions are in memory** and are lost on server restart; there is no "remember
  me", password reset, or account self-service. The three seeded passwords are
  deliberately public demo credentials.
- **Simplified statutory math.** Flat income-tax rate with no slabs, rebates,
  TDS, or exemptions; PF/ESIC use the flat rules above; no gratuity, professional
  tax slabs, or state-specific variations. This is not payroll-compliance software.
- **No built-in third-party integrations:** no email/SMS notifications, no
  bank/payment gateway, no file/document uploads or receipt storage, and no
  Aadhaar/PAN handling. The only device integration is the optional biometric
  feature, and its push and polling modes are strictly opt-in — a device must be
  explicitly configured and enabled before the app ever contacts or accepts data
  from it. No external service is required.
- **No database migrations framework.** All tables (including the biometric
  ones) are created with `CREATE TABLE IF NOT EXISTS`, so new tables are added to
  an existing `data/hrms.db` on the next start without data loss. Altering the
  columns of an existing table is not automated and may still require manual
  intervention or a fresh database.
- **No general background job scheduler.** Attendance, leave, reminders and
  payroll are driven explicitly through the API/UI. The sole exception is the
  biometric poller: an in-process timer started only in the production entry
  point, and only for devices explicitly configured with `ingestionMode='poll'`
  and `enabled=1`. API tests do not start it; there are no persisted schedules.
- Dependencies are intentionally limited to Node.js built-ins; there is no build
  step, bundler, transpiler, or TypeScript.

### Known simplifications

- **Biometric pairing is first-in / last-out.** Per device, an employee's
  punches for a day are collapsed into a single attendance day using the first
  in and the last out. Break-in/break-out codes are treated like in/out, a lone
  in still counts as a present day with no punch-out, and an out just after
  midnight attaches to the preceding day's group. Unmapped punches stay pending
  until a mapping exists, and commit never overwrites an attendance row that was
  already recorded manually.
- **ZKTeco status `255` is treated as "unknown direction".** Firmware uses `255`
  for a "normal" punch without a reliable in/out flag, so the pairing engine
  infers direction from context (alternating in/out) instead of trusting the
  code. Only the ADMS **text-over-HTTP** protocol is implemented; the vendor's
  binary TCP/4370 protocol is explicitly deferred and not supported.
- **Cross-month leave is not prorated.** Payroll counts the full `days` value of
  every approved unpaid-leave request that overlaps the payroll month. A single
  request spanning two months therefore contributes its full day count to each
  month's unpaid-leave deduction rather than being split between them.
- **The CSV formula guard also protects values starting with `-`.** The shared
  CSV writer prefixes any cell beginning with `=`, `+`, `-`, `@`, tab or CR with
  an apostrophe to neutralise spreadsheet formula injection. Since `-` is on
  that list, a negative numeric value is exported as text (for example `'-500`)
  rather than as a spreadsheet number.

## Tests

From this directory:

```sh
node --test
```

The suite covers database/seed, validation, repository helpers, auth and
router behaviour, every API module (including the biometric parser, ingest and
routes), static UI serving, and the full end-to-end walkthrough. The e2e test
uses fresh in-memory databases and ephemeral ports, so it never touches
`data/hrms.db` or port 3000, and it does not start the background poller.

### Browser acceptance check

The UI was also verified in a real headless Chrome (CDP) against a live
`node server.js`: the login screen rendered with `#app` populated and a login
form, signing in navigated to `#/dashboard`, and the dashboard rendered its
full sidebar and live KPI cards. No uncaught page errors occurred. The only
console messages were the browser's note for the expected unauthenticated
`GET /api/auth/me` probe (a handled 401 that selects the login screen) and a
Chrome advisory suggesting an `autocomplete` attribute on the password input;
neither is a runtime error. Screenshots and console/CDP evidence IDs are
recorded in `.superpowers/sdd/hrms-plan/task-12-report.md`.
