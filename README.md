# HRMS — local, offline human-resources management

A single-process HRMS web app built with **Node.js built-in modules only**. No npm
dependencies, no build step, no external services, no network calls. The server
binds to **127.0.0.1:3000** and serves both a browser SPA and a JSON API backed
by a local SQLite database (`node:sqlite`).

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
starts reuse existing data. Stop the server with `Ctrl+C`; SIGINT/SIGTERM close
the database cleanly. Override the port/host only by editing `PORT`/`HOST` in
`server.js` (the default is fixed at `127.0.0.1:3000`).

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
  sessions; no network access required.
- `tests/e2e.test.js` walks the entire application from login through every
  module to CSV export against the same wiring production uses.

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
- **No integrations:** no email/SMS notifications, no bank/payment gateway, no
  file/document uploads or receipt storage, no Aadhaar/PAN handling, and no
  external services of any kind.
- **No database migrations or upgrade path.** The schema is created with
  `CREATE TABLE IF NOT EXISTS`; changing it requires a fresh `data/hrms.db`.
- **No background jobs or scheduler.** Attendance, reminders, and payroll are
  driven explicitly through the API/UI.
- Dependencies are intentionally limited to Node.js built-ins; there is no build
  step, bundler, transpiler, or TypeScript.

## Tests

From this directory:

```sh
node --test
```

The suite covers database/seed, validation, repository helpers, auth and
router behaviour, every API module, static UI serving, and the full end-to-end
walkthrough. All tests use fresh in-memory databases and ephemeral ports, so
they never touch `data/hrms.db` or port 3000.

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
