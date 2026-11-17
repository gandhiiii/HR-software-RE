/**
 * Small, dependency-free validation helpers shared by the API modules.
 *
 * The predicates (`isIsoDate`, `isNonNegativeNumber`) return booleans so
 * callers decide how to reject a value. `requireFields` is the enforcing
 * variant: it throws an Error carrying `status = 400`, which the router turns
 * into a `{error: ...}` response, so a handler cannot forget to check it.
 */

/**
 * Assert that `data` contains every named field with a usable value.
 * A field is missing when it is undefined/null, or a blank/whitespace string.
 *
 * @returns {true} when all fields are present
 * @throws {Error} with `status: 400` naming the missing fields
 */
export function requireFields(data, fields) {
  const source = data && typeof data === 'object' ? data : {};
  const missing = fields.filter((field) => {
    const value = source[field];
    return (
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '')
    );
  });
  if (missing.length > 0) {
    throw Object.assign(
      new Error(`Missing required field(s): ${missing.join(', ')}`),
      { status: 400 },
    );
  }
  return true;
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Strict Gregorian `YYYY-MM-DD` check. Parsing the components ourselves (rather
 * than relying on `new Date`) is deliberate: `new Date('2026-02-30')` silently
 * normalises to 2 March, which would store an invalid date.
 */
export function isIsoDate(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;

  const maxDay = DAYS_IN_MONTH[month - 1] + (month === 2 && isLeapYear(year) ? 1 : 0);
  return day >= 1 && day <= maxDay;
}

/** True only for a finite, non-negative JavaScript number (money, hours, etc.). */
export function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
