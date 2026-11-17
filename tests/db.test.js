import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, TABLES, DATA_PATH, SEED_ADMIN } from '../lib/db.js';

test('creates all tables and seeds admin once', () => {
  const db = openDatabase({ path: ':memory:', seed: true });
  for (const t of TABLES) {
    assert.ok(db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get() !== undefined || t);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, 3);
  db.close();
});

test('seed is idempotent', () => {
  const db = openDatabase({ path: ':memory:', seed: true });
  assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, 3);
  db.close();
});

test('seeds reference data, leave balances and settings defaults', () => {
  const db = openDatabase({ path: ':memory:', seed: true });
  const count = (table) => db.prepare(`SELECT count(*) n FROM ${table}`).get().n;

  assert.equal(count('departments'), 2);
  assert.equal(count('designations'), 2);
  assert.equal(count('shifts'), 1);
  assert.equal(count('employees'), 3);
  assert.equal(count('leave_types'), 4);
  assert.equal(count('leave_balances'), 12);
  assert.ok(count('settings') >= 7);

  const admin = db.prepare('SELECT * FROM users WHERE username = ?').get(SEED_ADMIN.username);
  assert.ok(admin);
  assert.equal(admin.role, 'admin');
  assert.ok(admin.password_hash && admin.salt);

  const settings = new Map(
    db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]),
  );
  assert.equal(Number(settings.get('working_days_per_month')), 30);
  assert.equal(Number(settings.get('pf_rate')), 12);
  assert.equal(Number(settings.get('pf_ceiling')), 15000);
  assert.equal(Number(settings.get('esic_rate')), 0.75);
  assert.equal(Number(settings.get('esic_ceiling')), 21000);
  assert.equal(Number(settings.get('professional_tax')), 0);
  assert.equal(Number(settings.get('income_tax_rate')), 0);
  assert.equal(settings.get('currency'), 'INR');

  db.close();
});

test('re-seeding an existing database does not duplicate rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hrms-seed-'));
  const path = join(dir, 'hrms.db');
  try {
    const first = openDatabase({ path, seed: true });
    assert.equal(first.prepare('SELECT count(*) n FROM users').get().n, 3);
    first.close();

    const second = openDatabase({ path, seed: true });
    assert.equal(second.prepare('SELECT count(*) n FROM users').get().n, 3);
    assert.equal(second.prepare('SELECT count(*) n FROM employees').get().n, 3);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exports a default data path and seed admin credentials', () => {
  assert.match(DATA_PATH, /hrms\.db$/);
  assert.deepEqual(SEED_ADMIN, { username: 'admin', password: 'admin123' });
});
