/**
 * Pure biometric punch parsing, normalization, dedupe and pairing. No database,
 * no I/O, no timers — every rule here is a deterministic function of its
 * arguments so the import/push paths can reuse it without side effects.
 *
 * Responsibilities, end to end:
 *   parsePunchText   raw text (CSV/TSV/ZKTeco ATTLOG/JSON) -> normalized rows
 *   normalizePunch   one row -> a validated, dedupe-keyed punch (or an error)
 *   mapZktecoStatus  device status code -> direction
 *   mapVerifyType    device verification code -> verification label
 *   dedupeKey        stable identity for a punch (used by the UNIQUE column)
 *   pairPunches      chronological punches -> employee/day attendance groups
 *
 * Only `parsePunchText` and `normalizePunch` surface bad input, and they do so
 * through returned `{ errors }` / `{ error }` objects rather than throwing.
 */

/** Directions understood by the pairing engine. */
const DIRECTIONS = new Set(['in', 'out', 'break_out', 'break_in', 'unknown']);

const USER_ALIASES = new Set([
  'user_id', 'userid', 'user', 'pin', 'employee_code', 'employeecode',
  'enrollment', 'enroll', 'device_user_id', 'deviceuserid', 'badge',
]);
const TIME_ALIASES = new Set([
  'timestamp', 'time', 'date_time', 'datetime', 'punch_time', 'punchtime',
  'punched_at', 'punchedat', 'transaction_time',
]);
const DIRECTION_ALIASES = new Set([
  'direction', 'status', 'in_out', 'inout', 'punch_type', 'punchtype',
]);
const VERIFY_ALIASES = new Set([
  'verify_type', 'verifytype', 'verify', 'verification_type', 'auth_type',
]);
const WORK_ALIASES = new Set(['work_code', 'workcode', 'work_code_1']);
const EXTERNAL_ALIASES = new Set(['external_id', 'externalid', 'record_id', 'recordid']);
const DATE_ALIASES = new Set(['date', 'punch_date', 'attendance_date']);

/** `YYYY-MM-DD HH:MM:SS` (seconds optional), ISO `T`, fractional seconds and offsets. */
const TIMESTAMP_RE =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+)(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/i;

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

function formatLocal(date) {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Offset suffix -> milliseconds east of UTC. */
function offsetMs(token) {
  if (!token || /^z$/i.test(token)) return 0;
  const compact = token.replace(':', '');
  const sign = compact[0] === '-' ? -1 : 1;
  return sign * (Number(compact.slice(1, 3)) * 60 + Number(compact.slice(3, 5))) * 60_000;
}

/**
 * Parse a device timestamp into a local wall-clock `YYYY-MM-DDTHH:MM:SS`.
 * Returns null for anything malformed so callers can degrade gracefully.
 * Wall-clock values are preserved verbatim; only an explicit offset/`Z` causes
 * a conversion (device logs are normally already in the site's local time).
 */
function parseTimestamp(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : formatLocal(value);
  }
  if (typeof value !== 'string') return null;

  const match = TIMESTAMP_RE.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 ||
      hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  const wallClockUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(wallClockUtc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day) {
    return null; // e.g. 2026-02-30
  }

  if (match[7]) {
    return formatLocal(new Date(wallClockUtc - offsetMs(match[7])));
  }
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

/**
 * Map a ZKTeco ATTLOG status code to a direction. Textual directions pass
 * through (so already-mapped rows are idempotent); 255/"unknown" stay unknown.
 */
export function mapZktecoStatus(code) {
  if (typeof code === 'string') {
    const text = code.trim();
    if (/^[+-]?\d+$/.test(text)) return mapZktecoStatus(Number(text));
    const lower = text.toLowerCase().replace(/[\s-]+/g, '_');
    return DIRECTIONS.has(lower) ? lower : 'unknown';
  }
  switch (code) {
    case 0: return 'in';
    case 1: return 'out';
    case 2: return 'break_out';
    case 3: return 'break_in';
    default: return 'unknown'; // includes firmware's 255 == "normal"
  }
}

/** Map a verification code (1/2/0/15) to its label; textual labels pass through. */
export function mapVerifyType(code) {
  if (typeof code === 'string') {
    const text = code.trim();
    if (/^[+-]?\d+$/.test(text)) return mapVerifyType(Number(text));
    const lower = text.toLowerCase().replace(/[\s-]+/g, '_');
    return ['fingerprint', 'card', 'password', 'face', 'unknown'].includes(lower)
      ? lower
      : 'unknown';
  }
  switch (code) {
    case 1: return 'fingerprint';
    case 2: return 'card';
    case 0: return 'password';
    case 15: return 'face';
    default: return 'unknown';
  }
}

/** Normalize a textual direction / numeric status into one of DIRECTIONS. */
function toDirection(value) {
  if (value === null || value === undefined) return 'unknown';
  if (typeof value === 'number') return mapZktecoStatus(value);
  const text = String(value).trim();
  if (/^[+-]?\d+$/.test(text)) return mapZktecoStatus(Number(text));
  const lower = text.toLowerCase().replace(/[\s-]+/g, '_');
  if (lower === 'check_in' || lower === 'checkin' || lower === 'i') return 'in';
  if (lower === 'check_out' || lower === 'checkout' || lower === 'o') return 'out';
  return DIRECTIONS.has(lower) ? lower : 'unknown';
}

function isIn(direction) {
  return direction === 'in' || direction === 'break_in';
}

/** Stable identity used by `biometric_punches.dedupe_key` (UNIQUE). */
export function dedupeKey(punch) {
  const p = punch || {};
  const at = parseTimestamp(p.punched_at ?? p.punchedAt);
  return [
    p.device_id ?? p.deviceId,
    p.device_user_id ?? p.deviceUserId,
    at ?? p.punched_at ?? p.punchedAt,
    p.direction,
  ].map((value) => value === null || value === undefined ? '' : String(value)).join('|');
}

/**
 * Split delimiter-separated text, honouring double-quoted cells (with `""`
 * escapes) and CRLF/LF/CR terminators. Blank lines are dropped.
 */
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => {
    endField();
    if (row.some((cell) => cell !== '')) rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"' && field.trim() === '') {
      field = ''; quoted = true; i += 1; continue;
    }
    if (ch === delimiter) { endField(); i += 1; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRow(); i += 1; continue;
    }
    field += ch; i += 1;
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

function headerKey(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** First non-blank value among the supplied aliases, or null. */
function pick(record, ...keys) {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

/** Map an arbitrary record (headered row or JSON object) to canonical row keys. */
function recordToRow(record) {
  const keys = Object.keys(record);
  const find = (aliases) => keys.find((key) => aliases.has(headerKey(key)));

  const userKey = find(USER_ALIASES);
  const timeKey = find(TIME_ALIASES);
  const directionKey = find(DIRECTION_ALIASES);
  const verifyKey = find(VERIFY_ALIASES);
  const workKey = find(WORK_ALIASES);
  const externalKey = find(EXTERNAL_ALIASES);
  const dateKey = find(DATE_ALIASES);

  let punchedAt = timeKey ? record[timeKey] : null;
  if (dateKey) {
    // `date` + `time` is a supported pair; `time` alone must never win over it.
    const timeOnlyKey = timeKey && headerKey(timeKey) === 'time'
      ? timeKey
      : keys.find((key) => headerKey(key) === 'time');
    if (timeOnlyKey && !isBlank(record[timeOnlyKey])) {
      punchedAt = `${record[dateKey]} ${record[timeOnlyKey]}`;
    }
  }

  return {
    deviceUserId: userKey ? record[userKey] : null,
    punchedAt: isBlank(punchedAt) ? null : punchedAt,
    direction: toDirection(directionKey ? record[directionKey] : null),
    verifyType: mapVerifyType(verifyKey ? record[verifyKey] : null),
    workCode: workKey ? record[workKey] : null,
    externalId: externalKey ? record[externalKey] : null,
  };
}

function pushStructuralRow(row, line, raw, rows, errors) {
  if (isBlank(row.deviceUserId)) {
    errors.push({ line, message: 'Missing device user id', raw });
    return;
  }
  if (isBlank(row.punchedAt)) {
    errors.push({ line, message: 'Missing timestamp', raw });
    return;
  }
  rows.push(row);
}

function parseHeadered(text, delimiter) {
  const table = parseDelimited(text, delimiter);
  if (table.length === 0) return { rows: [], errors: [] };
  const header = table[0];
  const rows = [];
  const errors = [];
  for (let i = 1; i < table.length; i += 1) {
    const cells = table[i];
    if (cells.length === 1 && cells[0].trim() === '') continue;
    const record = {};
    header.forEach((name, index) => { record[name] = cells[index]; });
    pushStructuralRow(recordToRow(record), i + 1, record, rows, errors);
  }
  return { rows, errors };
}

/** Headerless, positional ADMS ATTLOG: pin, time, status, verify, workcode... */
function parseZkteco(text) {
  const rows = [];
  const errors = [];
  String(text).split(/\r\n|\n|\r/).forEach((line, index) => {
    if (line.trim() === '') return;
    const fields = line.split('\t').map((field) => field.trim());
    if (fields.length < 2 || isBlank(fields[0]) || isBlank(fields[1])) {
      errors.push({
        line: index + 1,
        message: 'ATTLOG row needs at least pin and timestamp fields',
        raw: line,
      });
      return;
    }
    rows.push({
      deviceUserId: fields[0],
      punchedAt: fields[1],
      direction: mapZktecoStatus(fields[2]),
      verifyType: mapVerifyType(fields[3]),
      workCode: isBlank(fields[4]) ? null : fields[4],
      externalId: null,
    });
  });
  return { rows, errors };
}

function parseJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { rows: [], errors: [{ message: `Invalid JSON: ${error.message}` }] };
  }

  let records;
  if (Array.isArray(data)) {
    records = data;
  } else if (data && typeof data === 'object') {
    records = data.records ?? data.data ?? data.punches ?? null;
    if (!Array.isArray(records)) {
      const looksLikeRecord = ['userId', 'user_id', 'pin', 'deviceUserId', 'device_user_id']
        .some((key) => !isBlank(data[key]));
      records = looksLikeRecord ? [data] : [];
    }
  } else {
    records = [];
  }

  const rows = [];
  const errors = [];
  records.forEach((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      errors.push({ line: index + 1, message: 'Punch record must be an object', raw: record });
      return;
    }
    pushStructuralRow(recordToRow(record), index + 1, record, rows, errors);
  });
  return { rows, errors };
}

/**
 * Parse raw punch text. The caller declares the format; there is deliberately
 * no header sniffing. Bad rows are reported in `errors` rather than thrown.
 *
 * @param {string} text
 * @param {'csv'|'tsv'|'zkteco'|'json'} format
 * @returns {{rows:Array<object>, errors:Array<object>}}
 */
export function parsePunchText(text, format) {
  const input = typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text);
  switch (String(format ?? '').toLowerCase()) {
    case 'csv': return parseHeadered(input, ',');
    case 'tsv': return parseHeadered(input, '\t');
    case 'zkteco': return parseZkteco(input);
    case 'json': return parseJson(input);
    default: return { rows: [], errors: [{ message: `Unsupported punch format: ${format}` }] };
  }
}

function safeStringify(value) {
  try { return JSON.stringify(value); } catch { return null; }
}

/**
 * Validate one parsed row into a punch ready for `biometric_punches`.
 * Returns `{ error }` (never throws) when the user id or timestamp is bad.
 *
 * @param {object} row canonical row from `parsePunchText` (camelCase aliases accepted)
 * @param {number|string} deviceId
 * @param {string} source e.g. 'import' | 'push' | 'poll'
 * @returns {{punch:object}|{error:{message:string}}}
 */
export function normalizePunch(row, deviceId, source) {
  const record = row && typeof row === 'object' ? row : {};
  const deviceUserId = pick(record, 'deviceUserId', 'device_user_id', 'userId', 'user_id', 'pin');
  const rawTime = pick(record, 'punchedAt', 'punched_at', 'timestamp', 'punch_time');
  const punchedAt = parseTimestamp(rawTime);

  if (isBlank(deviceUserId)) return { error: { message: 'Missing device user id' } };
  if (!punchedAt) return { error: { message: `Invalid timestamp: ${String(rawTime)}` } };

  const punch = {
    device_id: deviceId ?? null,
    device_user_id: String(deviceUserId).trim(),
    punched_at: punchedAt,
    direction: toDirection(pick(record, 'direction', 'status', 'in_out')),
    verify_type: mapVerifyType(pick(record, 'verifyType', 'verify_type', 'verify')),
    work_code: null,
    source: isBlank(source) ? 'import' : String(source),
    external_id: null,
    raw_payload: safeStringify(record),
    dedupe_key: '',
  };
  const workCode = pick(record, 'workCode', 'work_code');
  const externalId = pick(record, 'externalId', 'external_id');
  if (!isBlank(workCode)) punch.work_code = String(workCode).trim();
  if (!isBlank(externalId)) punch.external_id = String(externalId).trim();
  punch.dedupe_key = dedupeKey(punch);
  return { punch };
}

function nextDay(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

/**
 * Pair chronological punches into one group per employee/day.
 *
 * Explicit directions are honoured; a missing/`unknown` direction is resolved
 * from context (out when an in is open, otherwise in), which makes 255-only
 * devices alternate in/out naturally. An out after midnight attaches to the
 * preceding in's date. Several pairs in a day collapse to first in / last out.
 * A lone in is still a valid group (`punch_out: null`); a lone out is unpaired.
 *
 * @param {Array<object>} punches
 * @returns {{groups:Array<object>, unpaired:Array<{punch:object, reason:string}>}}
 */
export function pairPunches(punches) {
  const list = Array.isArray(punches) ? punches.filter((punch) => punch && typeof punch === 'object') : [];
  const sorted = list
    .map((punch, index) => {
      const parsed = parseTimestamp(punch.punched_at ?? punch.punchedAt);
      return { punch, index, at: parsed ?? '9999-12-31T23:59:59', valid: parsed !== null };
    })
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.index - b.index))
    .map((entry) => ({
      punch: entry.punch,
      at: entry.at,
      time: entry.at.slice(11, 16),
      valid: entry.valid,
    }));

  const groups = [];
  const groupsByKey = new Map();
  const unpaired = [];
  const openByEmployee = new Map();
  const lastGroupByEmployee = new Map();

  for (const { punch, at, time, valid } of sorted) {
    if (!valid) {
      unpaired.push({ punch, reason: 'invalid_timestamp' });
      continue;
    }
    const date = at.slice(0, 10);
    const employeeKey = String(
      punch.employee_id ?? punch.employeeId ?? punch.device_id ?? punch.deviceUserId ?? '',
    );
    const employeeId = punch.employee_id ?? punch.employeeId ?? null;
    const addId = (group) => {
      if (punch.id !== undefined && punch.id !== null) group.punch_ids.push(punch.id);
    };

    let direction = toDirection(punch.direction);
    if (direction === 'unknown') {
      direction = openByEmployee.has(employeeKey) ? 'out' : 'in';
    }

    if (isIn(direction)) {
      const open = openByEmployee.get(employeeKey);
      // A second in on the same day belongs to the same collapsed group: keep
      // the first in but still record the extra punch id.
      if (open && open.date === date) {
        addId(open.group);
        continue;
      }
      const key = `${employeeKey}\u0000${date}`;
      let group = groupsByKey.get(key);
      if (!group) {
        group = { employee_id: employeeId, date, punch_in: time, punch_out: null, punch_ids: [] };
        groupsByKey.set(key, group);
        groups.push(group);
      }
      addId(group);
      openByEmployee.set(employeeKey, { date, group });
      lastGroupByEmployee.set(employeeKey, group);
      continue;
    }

    // out / break_out: close the open in if there is one; otherwise a trailing
    // out can extend the most recent group on the same (or following) date.
    const open = openByEmployee.get(employeeKey);
    let group = null;
    if (open) {
      group = open.group;
      openByEmployee.delete(employeeKey);
    } else {
      const last = lastGroupByEmployee.get(employeeKey);
      if (last && (last.date === date || nextDay(last.date) === date)) group = last;
    }
    if (!group) {
      unpaired.push({ punch, reason: 'unpaired' });
      continue;
    }
    group.punch_out = time; // chronological order makes this the last out
    addId(group);
  }

  return { groups, unpaired };
}
