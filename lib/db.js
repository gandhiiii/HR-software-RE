import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to the on-disk SQLite database. */
export const DATA_PATH = fileURLToPath(new URL('../data/hrms.db', import.meta.url));

/** Credentials for the seeded administrator account. */
export const SEED_ADMIN = { username: 'admin', password: 'admin123' };

const CREATED_AT = "TEXT NOT NULL DEFAULT (datetime('now'))";

// Single source of truth: TABLES is derived from the schema so the two can never drift.
const SCHEMA = {
  users: `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL,
    employee_id INTEGER,
    created_at ${CREATED_AT}
  )`,
  departments: `CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at ${CREATED_AT}
  )`,
  designations: `CREATE TABLE IF NOT EXISTS designations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at ${CREATED_AT}
  )`,
  shifts: `CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    grace_minutes INTEGER NOT NULL DEFAULT 0,
    weekly_off_day INTEGER NOT NULL DEFAULT 0,
    created_at ${CREATED_AT}
  )`,
  employees: `CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    department_id INTEGER,
    designation_id INTEGER,
    shift_id INTEGER,
    joining_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    basic REAL NOT NULL DEFAULT 0,
    hra REAL NOT NULL DEFAULT 0,
    allowances REAL NOT NULL DEFAULT 0,
    bank_account TEXT,
    created_at ${CREATED_AT}
  )`,
  attendance: `CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    punch_in TEXT,
    punch_out TEXT,
    status TEXT,
    late_minutes INTEGER NOT NULL DEFAULT 0,
    early_minutes INTEGER NOT NULL DEFAULT 0,
    worked_minutes INTEGER NOT NULL DEFAULT 0,
    overtime_minutes INTEGER NOT NULL DEFAULT 0,
    created_at ${CREATED_AT},
    UNIQUE (employee_id, date)
  )`,
  leave_types: `CREATE TABLE IF NOT EXISTS leave_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at ${CREATED_AT}
  )`,
  leave_balances: `CREATE TABLE IF NOT EXISTS leave_balances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    leave_type_id INTEGER NOT NULL,
    opening_balance REAL NOT NULL DEFAULT 0,
    used REAL NOT NULL DEFAULT 0,
    remaining REAL NOT NULL DEFAULT 0,
    created_at ${CREATED_AT},
    UNIQUE (employee_id, leave_type_id)
  )`,
  leave_requests: `CREATE TABLE IF NOT EXISTS leave_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    leave_type_id INTEGER NOT NULL,
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    days REAL NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    decided_by INTEGER,
    decided_at TEXT,
    created_at ${CREATED_AT}
  )`,
  payroll_runs: `CREATE TABLE IF NOT EXISTS payroll_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month INTEGER NOT NULL,
    year INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at ${CREATED_AT},
    UNIQUE (month, year)
  )`,
  payslips: `CREATE TABLE IF NOT EXISTS payslips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    month INTEGER NOT NULL,
    year INTEGER NOT NULL,
    run_id INTEGER,
    basic REAL NOT NULL DEFAULT 0,
    hra REAL NOT NULL DEFAULT 0,
    allowances REAL NOT NULL DEFAULT 0,
    overtime_pay REAL NOT NULL DEFAULT 0,
    reimbursement REAL NOT NULL DEFAULT 0,
    gross REAL NOT NULL DEFAULT 0,
    pf REAL NOT NULL DEFAULT 0,
    esic REAL NOT NULL DEFAULT 0,
    professional_tax REAL NOT NULL DEFAULT 0,
    income_tax REAL NOT NULL DEFAULT 0,
    unpaid_leave_deduction REAL NOT NULL DEFAULT 0,
    deductions REAL NOT NULL DEFAULT 0,
    net REAL NOT NULL DEFAULT 0,
    present_days REAL NOT NULL DEFAULT 0,
    unpaid_leave_days REAL NOT NULL DEFAULT 0,
    overtime_minutes INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at ${CREATED_AT},
    UNIQUE (employee_id, month, year)
  )`,
  expenses: `CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    receipt_note TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    reimbursement_month INTEGER,
    reimbursement_year INTEGER,
    decided_by INTEGER,
    decided_at TEXT,
    created_at ${CREATED_AT}
  )`,
  tasks: `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    assigned_to INTEGER,
    assigned_by INTEGER,
    due_date TEXT,
    priority TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'open',
    created_at ${CREATED_AT}
  )`,
  task_comments: `CREATE TABLE IF NOT EXISTS task_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    comment TEXT NOT NULL,
    created_at ${CREATED_AT}
  )`,
  assets: `CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT,
    serial TEXT,
    purchase_date TEXT,
    value REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'available',
    created_at ${CREATED_AT}
  )`,
  asset_assignments: `CREATE TABLE IF NOT EXISTS asset_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL,
    employee_id INTEGER NOT NULL,
    assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
    returned_at TEXT,
    status TEXT NOT NULL DEFAULT 'assigned',
    created_at ${CREATED_AT}
  )`,
  holidays: `CREATE TABLE IF NOT EXISTS holidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    name TEXT,
    created_at ${CREATED_AT}
  )`,
  settings: `CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    created_at ${CREATED_AT}
  )`,
  biometric_devices: `CREATE TABLE IF NOT EXISTS biometric_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    vendor TEXT NOT NULL DEFAULT 'generic',
    model TEXT,
    device_type TEXT NOT NULL DEFAULT 'fingerprint',
    serial_number TEXT NOT NULL UNIQUE,
    ip_address TEXT,
    port INTEGER,
    location TEXT,
    ingestion_mode TEXT NOT NULL DEFAULT 'offline',
    adapter TEXT NOT NULL DEFAULT 'generic_json',
    push_token TEXT NOT NULL UNIQUE,
    push_secret_hash TEXT,
    poll_endpoint TEXT,
    poll_headers_json TEXT,
    poll_interval_seconds INTEGER NOT NULL DEFAULT 60,
    auto_commit INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_seen_at TEXT,
    last_sync_at TEXT,
    created_at ${CREATED_AT},
    updated_at ${CREATED_AT}
  )`,
  biometric_employee_map: `CREATE TABLE IF NOT EXISTS biometric_employee_map (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    employee_id INTEGER NOT NULL,
    device_user_id TEXT NOT NULL,
    created_at ${CREATED_AT},
    UNIQUE (device_id, device_user_id),
    UNIQUE (device_id, employee_id)
  )`,
  biometric_punches: `CREATE TABLE IF NOT EXISTS biometric_punches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    device_user_id TEXT NOT NULL,
    employee_id INTEGER,
    punched_at TEXT NOT NULL,
    direction TEXT NOT NULL,
    verify_type TEXT,
    work_code TEXT,
    external_id TEXT,
    raw_payload TEXT,
    source TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    reason TEXT,
    created_at ${CREATED_AT}
  )`,
  biometric_sync_runs: `CREATE TABLE IF NOT EXISTS biometric_sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER,
    source TEXT NOT NULL,
    started_at ${CREATED_AT},
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    received INTEGER NOT NULL DEFAULT 0,
    inserted INTEGER NOT NULL DEFAULT 0,
    duplicates INTEGER NOT NULL DEFAULT 0,
    rejected INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at ${CREATED_AT}
  )`,
};

export const TABLES = Object.keys(SCHEMA);

const DEFAULT_SETTINGS = [
  ['company_name', 'HRMS Demo'],
  ['currency', 'INR'],
  ['locale', 'en-IN'],
  ['date_format', 'YYYY-MM-DD'],
  ['calendar', 'Gregorian'],
  ['working_days_per_month', '30'],
  ['pf_rate', '12'],
  ['pf_ceiling', '15000'],
  ['esic_rate', '0.75'],
  ['esic_ceiling', '21000'],
  ['professional_tax', '0'],
  ['income_tax_rate', '0'],
  ['overtime_cap_minutes', '240'],
  ['overtime_multiplier', '1.5'],
  ['shift_start_time', '09:00'],
  ['shift_end_time', '18:00'],
  ['grace_minutes', '10'],
  ['weekly_off_day', '0'],
];

// Authoritative opening balances per leave type. Exported so the leave API can
// provision balance rows for employees created after seeding (which write no
// balances themselves) without duplicating these values.
export const LEAVE_TYPES = [
  ['Casual', 12],
  ['Sick', 10],
  ['Earned', 15],
  ['Unpaid', 0],
];

// Seed accounts are demo credentials for a local-only tool: all three use the
// documented default password. `salt` is the hex text passed directly to
// scryptSync (not decoded back into bytes); `hash` is the 64-byte result in hex.
function hashForSeed(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function seedIfEmpty(db) {
  if (db.prepare('SELECT count(*) n FROM users').get().n > 0) return false;

  db.exec('BEGIN');
  try {
    const run = (sql, ...params) => db.prepare(sql).run(...params);

    const departmentIds = [
      run('INSERT INTO departments (name) VALUES (?)', 'Engineering').lastInsertRowid,
      run('INSERT INTO departments (name) VALUES (?)', 'Human Resources').lastInsertRowid,
    ];
    const designationIds = [
      run('INSERT INTO designations (name) VALUES (?)', 'Software Engineer').lastInsertRowid,
      run('INSERT INTO designations (name) VALUES (?)', 'HR Manager').lastInsertRowid,
    ];
    const shiftId = run(
      'INSERT INTO shifts (name, start_time, end_time, grace_minutes, weekly_off_day) VALUES (?, ?, ?, ?, ?)',
      'General Shift', '09:00', '18:00', 10, 0,
    ).lastInsertRowid;

    const employees = [
      ['EMP001', 'Aarav Sharma', 'aarav@example.com', '+91 90000 00001', departmentIds[0], designationIds[0], '2024-01-15', 30000, 6000, 1000, 'XXXXXX1234'],
      ['EMP002', 'Priya Patel', 'priya@example.com', '+91 90000 00002', departmentIds[1], designationIds[1], '2024-02-01', 25000, 5000, 800, 'XXXXXX5678'],
      ['EMP003', 'Rohan Verma', 'rohan@example.com', '+91 90000 00003', departmentIds[0], designationIds[0], '2024-03-10', 30000, 6000, 1000, 'XXXXXX9012'],
    ];
    const employeeIds = employees.map((e) =>
      run(
        `INSERT INTO employees
           (code, name, email, phone, department_id, designation_id, shift_id,
            joining_date, status, basic, hra, allowances, bank_account)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        e[0], e[1], e[2], e[3], e[4], e[5], shiftId, e[6], e[7], e[8], e[9], e[10],
      ).lastInsertRowid,
    );

    for (const [username, role, employeeId] of [
      [SEED_ADMIN.username, 'admin', null],
      ['hr', 'hr', employeeIds[1]],
      ['employee', 'employee', employeeIds[2]],
    ]) {
      const { salt, hash } = hashForSeed(SEED_ADMIN.password);
      run(
        'INSERT INTO users (username, password_hash, salt, role, employee_id) VALUES (?, ?, ?, ?, ?)',
        username, hash, salt, role, employeeId,
      );
    }

    const leaveTypeIds = LEAVE_TYPES.map(([name]) =>
      run('INSERT INTO leave_types (name) VALUES (?)', name).lastInsertRowid,
    );
    for (const employeeId of employeeIds) {
      LEAVE_TYPES.forEach(([, opening], index) => {
        run(
          `INSERT INTO leave_balances
             (employee_id, leave_type_id, opening_balance, used, remaining)
           VALUES (?, ?, ?, 0, ?)`,
          employeeId, leaveTypeIds[index], opening, opening,
        );
      });
    }

    for (const [key, value] of DEFAULT_SETTINGS) {
      run('INSERT INTO settings (key, value) VALUES (?, ?)', key, value);
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return true;
}

/**
 * Open (or create) a SQLite database, ensure the schema exists and optionally
 * seed it. Seeding is skipped whenever the `users` table already has rows.
 */
export function openDatabase({ path = DATA_PATH, seed: doSeed = true } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  for (const ddl of Object.values(SCHEMA)) db.exec(ddl);
  if (doSeed) seedIfEmpty(db);
  return db;
}
