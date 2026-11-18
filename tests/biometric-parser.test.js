import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePunchText,
  mapZktecoStatus,
  mapVerifyType,
  normalizePunch,
  pairPunches,
} from '../lib/calc/biometric.js';

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
