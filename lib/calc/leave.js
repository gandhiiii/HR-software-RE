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
 * on failure. Leave types seeded with no balance at all (the Unpaid type has an
 * opening_balance of 0 and a remaining of 0) are deliberately NOT constrained:
 * their approval still increments `used`, and `remaining` goes negative to
 * record days taken without pay.
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
 * @returns {{used:number, remaining:number}} the recomputed balance figures
 * @throws {Error} with `status` 400 for bad input, 409 for an overdrawn approval
 */
export function applyLeaveDecision({ balance, days, action } = {}) {
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
    // A balance-backed leave type cannot be overdrawn. A type with no balance
    // configured at all (opening and remaining both zero, e.g. Unpaid) is not
    // constrained so it can still be approved and fed into payroll.
    const balanceBacked = opening > 0 || remaining > 0;
    if (balanceBacked && days > remaining) {
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
