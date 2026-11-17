/**
 * Attendance recording and reporting routes.
 *
 * HR/admin may record and read attendance for anyone; the employee role can
 * only use `/api/attendance/self`, which always writes the logged-in user's own
 * employee id. All persistence goes through lib/repo.js, and the status is
 * always derived by the pure lib/calc/attendance.js function.
 */
import { requireFields, isIsoDate } from '../lib/validate.js';
import { getRow, listRows, insertRow, updateRow } from '../lib/repo.js';
import { deriveAttendance } from '../lib/calc/attendance.js';

const HR_ROLES = ['admin', 'hr'];
const ALL_ROLES = ['admin', 'hr', 'employee'];
const SELF_ROLES = ['employee'];

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function isHhmm(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function positiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function monthYearFrom(query) {
  const month = Number(query.month);
  const year = Number(query.year);
  if (
    query.month === undefined || query.year === undefined ||
    !Number.isInteger(month) || month < 1 || month > 12 ||
    !Number.isInteger(year) || year < 1
  ) {
    throw httpError(400, 'month (1-12) and year are required');
  }
  return { month, year };
}

/** Flatten the settings table into a key -> value map (via repo helpers). */
function settingsMap(db) {
  const map = {};
  for (const row of listRows(db, 'settings')) map[row.key] = row.value;
  return map;
}

/**
 * Resolve the effective shift for an employee. An explicit `shiftId` on the
 * body wins; otherwise the employee's assigned shift is used; when neither
 * resolves, global settings provide a synthetic default shift.
 */
function resolveShift(db, body, employee, settings) {
  const requestedId = body.shiftId ?? body.shift_id ?? employee?.shift_id;
  const id = positiveId(requestedId);
  if (id !== null) {
    const shift = getRow(db, 'shifts', id);
    // The shift's own grace value is authoritative when one is assigned.
    if (shift) return { ...shift, grace_minutes: Number(shift.grace_minutes ?? 0) };
  }
  // No resolved shift: fall back to the global settings.
  return {
    start_time: settings.shift_start_time ?? '09:00',
    end_time: settings.shift_end_time ?? '18:00',
    grace_minutes: Number(settings.grace_minutes ?? 0),
    weekly_off_day: Number(settings.weekly_off_day ?? 0),
  };
}

/** True when the date falls on the configured weekly off day or a holiday. */
function isHoliday(db, date, settings) {
  const weeklyOff = Number(settings.weekly_off_day ?? 0);
  const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (dayOfWeek === weeklyOff) return true;
  return listRows(db, 'holidays', 'date = ?', [date]).length > 0;
}

/**
 * Validate a record request and turn it into the exact attendance column map.
 * `employeeId` is required here; the /self route injects its own before calling.
 */
function buildRecord(db, body) {
  requireFields(body, ['employeeId', 'date']);
  const employeeId = positiveId(body.employeeId);
  if (employeeId === null) throw httpError(400, 'employeeId must be a positive integer');
  if (!isIsoDate(body.date)) {
    throw httpError(400, 'date must be a valid ISO date (YYYY-MM-DD)');
  }
  if (!getRow(db, 'employees', employeeId)) throw httpError(404, 'Employee not found');

  const punchIn = body.punchIn ?? body.punch_in ?? null;
  const punchOut = body.punchOut ?? body.punch_out ?? null;
  for (const [name, value] of [['punchIn', punchIn], ['punchOut', punchOut]]) {
    if (value !== null && value !== '' && !isHhmm(value)) {
      throw httpError(400, `${name} must be a valid HH:MM time`);
    }
  }
  return { employeeId, date: body.date, punchIn: punchIn || null, punchOut: punchOut || null, body };
}

/** Insert or update the single attendance row for an (employee, date) pair. */
function upsertAttendance(db, row) {
  const existing = listRows(db, 'attendance', 'employee_id = ? AND date = ?', [
    row.employee_id,
    row.date,
  ]);
  if (existing.length > 0) {
    const id = existing[0].id;
    updateRow(db, 'attendance', id, row);
    return { status: 200, body: getRow(db, 'attendance', id) };
  }
  const id = insertRow(db, 'attendance', row);
  return { status: 201, body: getRow(db, 'attendance', id) };
}

/**
 * Validate, derive and persist one record. When `forcedEmployeeId` is supplied
 * (the /self route) it overrides any client-provided employeeId.
 */
function recordAttendance(db, body, forcedEmployeeId) {
  const effectiveBody =
    forcedEmployeeId === undefined
      ? body
      : { ...body, employeeId: forcedEmployeeId };
  const record = buildRecord(db, effectiveBody);
  const settings = settingsMap(db);
  const employee = getRow(db, 'employees', record.employeeId);
  const shift = resolveShift(db, record.body, employee, settings);
  const derived = deriveAttendance({
    punchIn: record.punchIn,
    punchOut: record.punchOut,
    shift,
    approvedLeave: body.approvedLeave === true,
    holiday: body.holiday === true || isHoliday(db, record.date, settings),
    // Grace comes from the resolved shift (which already fell back to settings).
    overtimeCapMinutes: Number(settings.overtime_cap_minutes ?? 240),
  });
  return upsertAttendance(db, {
    employee_id: record.employeeId,
    date: record.date,
    punch_in: record.punchIn,
    punch_out: record.punchOut,
    status: derived.status,
    late_minutes: derived.lateMinutes,
    early_minutes: derived.earlyMinutes,
    worked_minutes: derived.workedMinutes,
    overtime_minutes: derived.overtimeMinutes,
  });
}

/** Register all attendance and shift routes. */
export function registerAttendanceRoutes(router) {
  // Record attendance for any employee (HR/admin).
  router.register('POST', '/api/attendance', HR_ROLES, async ({ db, body }) =>
    recordAttendance(db, body),
  );

  // Employee records only their own attendance (employee id comes from session).
  router.register('POST', '/api/attendance/self', SELF_ROLES, async ({ db, user, body }) => {
    const employeeId = positiveId(user?.employee_id);
    if (employeeId === null) {
      throw httpError(400, 'No employee is linked to this account');
    }
    // Ignore any client-supplied employeeId: this route is own-record only.
    return recordAttendance(db, body, employeeId);
  });

  // List attendance, optionally filtered by ?employeeId=&from=&to=.
  router.register('GET', '/api/attendance', HR_ROLES, async ({ db, query }) => {
    const clauses = [];
    const params = [];
    if (query.employeeId !== undefined && query.employeeId !== '') {
      const id = positiveId(query.employeeId);
      if (id === null) throw httpError(400, 'employeeId must be a positive integer');
      clauses.push('employee_id = ?');
      params.push(id);
    }
    for (const [key, op] of [['from', '>='], ['to', '<=']]) {
      if (query[key] !== undefined && query[key] !== '') {
        if (!isIsoDate(query[key])) throw httpError(400, `${key} must be a valid ISO date`);
        clauses.push(`date ${op} ?`);
        params.push(query[key]);
      }
    }
    const whereSql = clauses.length > 0 ? clauses.join(' AND ') : '1=1';
    return { status: 200, body: listRows(db, 'attendance', whereSql, params) };
  });

  // Monthly per-employee summary (consumed by payroll).
  router.register('GET', '/api/attendance/summary', HR_ROLES, async ({ db, query }) => {
    const { month, year } = monthYearFrom(query);
    const prefix = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-`;
    const rows = listRows(db, 'attendance', 'date LIKE ?', [`${prefix}%`]);

    const byEmployee = new Map();
    for (const row of rows) {
      if (!byEmployee.has(row.employee_id)) {
        byEmployee.set(row.employee_id, {
          employee_id: row.employee_id,
          present: 0, half_day: 0, leave: 0, holiday: 0, absent: 0,
          late_minutes: 0, early_minutes: 0, worked_minutes: 0, overtime_minutes: 0,
          present_days: 0,
        });
      }
      const summary = byEmployee.get(row.employee_id);
      const statusKey = {
        Present: 'present', 'Half-day': 'half_day', Leave: 'leave',
        Holiday: 'holiday', Absent: 'absent',
      }[row.status];
      if (statusKey) summary[statusKey] += 1;
      summary.late_minutes += row.late_minutes || 0;
      summary.early_minutes += row.early_minutes || 0;
      summary.worked_minutes += row.worked_minutes || 0;
      summary.overtime_minutes += row.overtime_minutes || 0;
    }
    const employees = [...byEmployee.values()];
    for (const summary of employees) {
      summary.present_days = summary.present + 0.5 * summary.half_day;
    }
    const totals = employees.reduce(
      (acc, summary) => {
        for (const key of [
          'present', 'half_day', 'leave', 'holiday', 'absent', 'present_days',
          'late_minutes', 'early_minutes', 'worked_minutes', 'overtime_minutes',
        ]) {
          acc[key] += summary[key];
        }
        return acc;
      },
      {
        present: 0, half_day: 0, leave: 0, holiday: 0, absent: 0, present_days: 0,
        late_minutes: 0, early_minutes: 0, worked_minutes: 0, overtime_minutes: 0,
      },
    );
    return { status: 200, body: { month, year, totals, employees } };
  });

  // Shift reference list for the UI / self-service screen.
  router.register('GET', '/api/shifts', ALL_ROLES, async ({ db }) => ({
    status: 200,
    body: listRows(db, 'shifts'),
  }));
}
