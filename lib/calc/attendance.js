/**
 * Pure attendance calculation. No database, no I/O, no settings lookups — just
 * minute arithmetic on `HH:MM` strings so the rules can be tested and reused
 * (payroll consumes the resulting minutes) without side effects.
 *
 * Rule order (first match wins):
 *   approved leave -> Leave; holiday / weekly off -> Holiday; no punch-in ->
 *   Absent; punch-in after shift start + grace, or under four hours worked ->
 *   Half-day; otherwise -> Present.
 *
 * Lateness and early-out are surfaced through their own minute fields so the
 * status can stay `Present` (a small lateness inside the grace period, or an
 * early exit, does not change the day's status).
 */

/** Default raw overtime ceiling; callers may override via `overtimeCapMinutes`. */
const OVERTIME_CAP_MINUTES = 240;

/** Minutes below which a worked day counts as a half-day (4 hours). */
const HALF_DAY_THRESHOLD = 240;

/**
 * Parse an `HH:MM` clock string into whole minutes since midnight.
 * Returns null for anything that is not a well-formed 24-hour time, so callers
 * can treat missing/garbage punches as "no punch".
 */
function toMinutes(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Derive the attendance result for a single employee-day.
 *
 * @param {object}  params
 * @param {?string} params.punchIn           punch-in `HH:MM` (or null => Absent)
 * @param {?string} params.punchOut          punch-out `HH:MM`
 * @param {object}  params.shift            {start_time, end_time, grace_minutes}
 * @param {boolean} [params.approvedLeave=false]
 * @param {boolean} [params.holiday=false]   weekly off or a declared holiday
 * @param {number}  [params.graceMinutes]    overrides shift.grace_minutes
 * @param {number}  [params.overtimeCapMinutes=240]
 * @returns {{status:string, lateMinutes:number, earlyMinutes:number,
 *            workedMinutes:number, overtimeMinutes:number}}
 */
export function deriveAttendance({
  punchIn,
  punchOut,
  shift,
  approvedLeave = false,
  holiday = false,
  graceMinutes,
  overtimeCapMinutes = OVERTIME_CAP_MINUTES,
} = {}) {
  const zeroed = {
    lateMinutes: 0,
    earlyMinutes: 0,
    workedMinutes: 0,
    overtimeMinutes: 0,
  };

  if (approvedLeave) return { status: 'Leave', ...zeroed };
  if (holiday) return { status: 'Holiday', ...zeroed };

  const inMinutes = toMinutes(punchIn);
  if (inMinutes === null) return { status: 'Absent', ...zeroed };

  const outMinutes = toMinutes(punchOut);
  const startMinutes = toMinutes(shift?.start_time);
  const endMinutes = toMinutes(shift?.end_time);
  const cap = Number.isFinite(overtimeCapMinutes)
    ? overtimeCapMinutes
    : OVERTIME_CAP_MINUTES;
  const grace = Number.isFinite(graceMinutes)
    ? graceMinutes
    : Number(shift?.grace_minutes) || 0;

  const workedMinutes =
    outMinutes === null ? 0 : Math.max(0, outMinutes - inMinutes);
  const lateMinutes =
    startMinutes === null ? 0 : Math.max(0, inMinutes - startMinutes);
  const earlyMinutes =
    outMinutes === null || endMinutes === null
      ? 0
      : Math.max(0, endMinutes - outMinutes);
  const overtimeMinutes =
    outMinutes === null || endMinutes === null
      ? 0
      : Math.min(cap, Math.max(0, outMinutes - endMinutes));

  // Lateness beyond the grace window forces a half-day even when enough hours
  // were worked; so does putting in fewer than four hours.
  const status =
    lateMinutes > grace || workedMinutes < HALF_DAY_THRESHOLD
      ? 'Half-day'
      : 'Present';

  return { status, lateMinutes, earlyMinutes, workedMinutes, overtimeMinutes };
}
