import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.js';
import { requireFields, isIsoDate, isNonNegativeNumber } from '../lib/validate.js';
import { insertRow, getRow, listRows, updateRow, deleteRow } from '../lib/repo.js';

// ---------------------------------------------------------------------------
// lib/validate.js
// ---------------------------------------------------------------------------

test('requireFields passes when every field is present and non-empty', () => {
  assert.equal(requireFields({ code: 'E1', name: 'Asha' }, ['code', 'name']), true);
});

test('requireFields throws a 400 error naming missing or blank fields', () => {
  assert.throws(
    () => requireFields({ code: '', name: 'Asha' }, ['code', 'name', 'joining_date']),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /code/);
      assert.match(error.message, /joining_date/);
      return true;
    },
  );
});

test('isIsoDate accepts real Gregorian dates, including leap days', () => {
  for (const value of ['2024-02-29', '2000-02-29', '2026-02-28', '2026-01-01', '2026-12-31']) {
    assert.equal(isIsoDate(value), true, `expected ${value} to be a valid ISO date`);
  }
});

test('isIsoDate rejects 2026-02-30 and other impossible or malformed dates', () => {
  for (const value of [
    '2026-02-30', // the brief's explicit case: February has 28 days in 2026
    '2025-02-29', // non-leap year
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '01-01-2026',
    '2026-1-1',
    '',
    null,
    undefined,
    20260101,
  ]) {
    assert.equal(isIsoDate(value), false, `expected ${String(value)} to be rejected`);
  }
});

test('isNonNegativeNumber accepts zero and positive finite numbers', () => {
  assert.equal(isNonNegativeNumber(0), true);
  assert.equal(isNonNegativeNumber(15000.5), true);
  assert.equal(isNonNegativeNumber(30000), true);
});

test('isNonNegativeNumber rejects negative salary and non-numbers', () => {
  for (const value of [-1, -0.01, NaN, Infinity, -Infinity, '30000', '', null, undefined, {}, true]) {
    assert.equal(isNonNegativeNumber(value), false, `expected ${String(value)} to be rejected`);
  }
});

// ---------------------------------------------------------------------------
// lib/repo.js
// ---------------------------------------------------------------------------

test('repo helpers round-trip a row through insert/get/list/update/delete', () => {
  const db = makeDb();
  try {
    const id = insertRow(db, 'departments', { name: 'Finance' });
    assert.ok(Number.isInteger(id) && id > 0, 'insertRow must return the new integer id');

    assert.equal(getRow(db, 'departments', id)?.name, 'Finance');

    const rows = listRows(db, 'departments', 'name = ?', ['Finance']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Finance');

    assert.equal(updateRow(db, 'departments', id, { name: 'Finance & Ops' }), true);
    assert.equal(getRow(db, 'departments', id)?.name, 'Finance & Ops');

    assert.equal(deleteRow(db, 'departments', id), true);
    assert.equal(getRow(db, 'departments', id), null);
    assert.equal(deleteRow(db, 'departments', id), false, 'deleting a missing row is a no-op');
  } finally {
    db.close();
  }
});

test('listRows defaults to all rows and returns [] when nothing matches', () => {
  const db = makeDb();
  try {
    assert.equal(listRows(db, 'departments').length, 2, 'seed creates two departments');
    assert.deepEqual(listRows(db, 'departments', 'name = ?', ['Not A Department']), []);
  } finally {
    db.close();
  }
});

test('insertRow writes undefined values as SQL NULL', () => {
  const db = makeDb();
  try {
    const id = insertRow(db, 'employees', {
      code: 'EREPO',
      name: 'Repo Tester',
      joining_date: '2026-01-01',
      email: undefined,
    });
    assert.equal(getRow(db, 'employees', id)?.email, null);
  } finally {
    db.close();
  }
});

test('repo helpers reject table names outside the whitelist', () => {
  const db = makeDb();
  try {
    const injected = 'departments; DROP TABLE employees';
    assert.throws(() => getRow(db, injected, 1), /Unknown table/);
    assert.throws(() => insertRow(db, injected, { name: 'x' }), /Unknown table/);
    assert.throws(() => listRows(db, injected), /Unknown table/);
    assert.throws(() => updateRow(db, injected, 1, { name: 'x' }), /Unknown table/);
    assert.throws(() => deleteRow(db, injected, 1), /Unknown table/);
    assert.throws(() => getRow(db, '__proto__', 1), /Unknown table/);
  } finally {
    db.close();
  }
});

test('repo helpers reject unknown columns with a 400 and no raw SQLite text', () => {
  const db = makeDb();
  try {
    const assertClean400 = (error) => {
      assert.equal(error.status, 400);
      assert.doesNotMatch(
        error.message,
        /no such column|has no column named|SQLITE|NOT NULL constraint/i,
      );
      return true;
    };
    assert.throws(
      () =>
        insertRow(db, 'employees', {
          code: 'EUNKNOWN',
          name: 'Unknown Column',
          joining_date: '2026-01-01',
          bogus_column: 'x',
        }),
      assertClean400,
    );
    assert.throws(
      () => updateRow(db, 'employees', 1, { bogus_column: 'x' }),
      assertClean400,
    );

    // A valid insert still works after the rejected attempts.
    const id = insertRow(db, 'employees', {
      code: 'EGOOD',
      name: 'Good Row',
      joining_date: '2026-01-01',
    });
    assert.ok(id > 0);
  } finally {
    db.close();
  }
});

test('repo helpers map NOT NULL violations and typo filters to 400 without SQL text', () => {
  const db = makeDb();
  try {
    assert.throws(
      () =>
        insertRow(db, 'employees', {
          code: 'ENULLSTATUS',
          name: 'Null Status',
          joining_date: '2026-01-01',
          status: null,
        }),
      (error) => {
        assert.equal(error.status, 400);
        assert.doesNotMatch(
          error.message,
          /NOT NULL constraint|SQLITE|no such column|has no column named/i,
        );
        return true;
      },
    );
    assert.throws(
      () => listRows(db, 'employees', 'bogus_column = ?', [1]),
      (error) => {
        assert.equal(error.status, 400);
        assert.doesNotMatch(error.message, /no such column|has no column named|SQLITE/i);
        return true;
      },
    );
  } finally {
    db.close();
  }
});
