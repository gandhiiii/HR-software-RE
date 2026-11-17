/**
 * Pure leave-balance calculation. No database, no I/O — just the arithmetic
 * that turns an approval/rejection decision into a new `{used, remaining}`
 * pair for one leave-balance row. Payroll (Task 6) does not consume this module
 * directly; it reads the approved leave requests this workflow persists.
 *
 * The `balance` argument is a leave_balances row:
 *   { opening_balance, used, remaining }
 *
 * Rules:
 *   approve -> used += days, remaining = opening_balance - used
 *   reject  -> used -= days (clamped at 0), remaining = opening_balance - used
 *
 * An approval that would exceed the available balance throws a 409 and leaves
 * the caller nothing to persist — the API relies on this to keep data unchanged
 * on failure. The only escape from that guard is an EXPLICIT `unlimited` flag,
 * which the API derives from the leave type's name (types containing "unpaid").
 * Balances are never inspected to decide which types are unlimited: a zero
 * opening/zero remaining balance on a normal type still fails on overdraw, and
 * only the seeded Unpaid type is flagged unlimited. An unlimited approval still
 * increments `used`, and `remaining` goes negative to record days without pay.
 */

/** Round away floating-point drift (e.g. 0.1 + 0.2) but keep integers exact. */
function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

function finiteNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * Apply an approve/reject decision to a leave balance.
 *
 * @param {object} params
 * @param {{opening_balance:number, used:number, remaining:number}} params.balance
 * @param {number} params.days          days the decision concerns (> 0)
 * @param {'approve'|'reject'} params.action
 * @param {boolean} [params.unlimited=false] skip the balance guard; derived by
 *   the API from a leave type name containing "unpaid", never from balance values
 * @returns {{used:number, remaining:number}} the recomputed balance figures
 * @throws {Error} with `status` 400 for bad input, 409 for an overdrawn approval
 */
export function applyLeaveDecision({ balance, days, action, unlimited = false } = {}) {
  if (action !== 'approve' && action !== 'reject') {
    throw httpError(400, "action must be 'approve' or 'reject'");
  }
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
    throw httpError(400, 'days must be a positive number');
  }

  const opening = finiteNumber(balance?.opening_balance);
  const used = finiteNumber(balance?.used);
  const remaining = finiteNumber(balance?.remaining, opening - used);

  let newUsed;
  if (action === 'approve') {
    // Only an explicit signal (unpaid leave type) bypasses the guard. Whether a
    // balance happens to be zero is irrelevant: a normal type with no remaining
    // days must still fail here rather than silently becoming unlimited.
    if (!unlimited && days > remaining) {
      throw httpError(409, 'Insufficient leave balance');
    }
    newUsed = used + days;
  } else {
    // Rejecting an approval returns the days; clamp so inconsistent data can
    // never drive `used` below zero.
    newUsed = Math.max(0, used - days);
  }

  return {
    used: round(newUsed),
    remaining: round(opening - newUsed),
  };
}
