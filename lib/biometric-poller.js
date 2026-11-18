/**
 * Opt-in background poller for biometric devices.
 *
 * A device is polled only when it is explicitly configured for it —
 * `ingestion_mode='poll'`, `adapter='http_json'` and `enabled=1`. This module
 * never starts itself: `createPoller` simply returns `{ start, stop }`, and the
 * production main guard in `server.js` is the only caller of `start()`.
 * Tests exercise the same fetch/parse/ingest work through the manual
 * `POST /api/biometric/devices/:id/poll` route instead.
 *
 * Every tick uses the shared helpers: `parsePunchText(..., 'json')` for the
 * device response and `ingestPunches(..., 'poll')` for persistence (which also
 * records the sync run). Timers are held in-process only; nothing here writes
 * a schedule to the database.
 */
import { getRow, listRows, updateRow } from './repo.js';
import { parsePunchText } from './calc/biometric.js';
import { ingestPunches } from './biometric-ingest.js';

/** Floor for a device's configured poll interval. */
const MIN_INTERVAL_SECONDS = 30;
/** Maximum delay after repeated failures: 15 minutes. */
const MAX_BACKOFF_MS = 15 * 60 * 1000;

/** SQLite-style UTC timestamp (same shape as datetime('now')). */
function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** Parse a stored `YYYY-MM-DD HH:MM:SS` UTC timestamp into epoch ms. */
function sqlUtcToMs(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const iso = value.includes('T') ? value.trim() : `${value.trim().replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function isEligible(device) {
  return !!device &&
    device.ingestion_mode === 'poll' &&
    device.adapter === 'http_json' &&
    device.enabled === 1;
}

/**
 * Poll one device right now: fetch its endpoint, parse the JSON body, ingest
 * the punches with source `poll`, and refresh its status timestamps.
 *
 * Shared by the manual route (`api/biometric.js`) and the background timer so
 * both paths have identical behaviour. `device` is the raw snake_case DB row.
 *
 * @returns {Promise<{received:number,inserted:number,duplicates:number,
 *                    unmapped:number,errors:Array<object>}>}
 */
export async function pollDeviceOnce(db, device) {
  if (!device || device.id === undefined || device.id === null) {
    throw new TypeError('pollDeviceOnce requires a device row');
  }

  const endpoint = typeof device.poll_endpoint === 'string' ? device.poll_endpoint.trim() : '';
  if (!endpoint) throw new Error('Device has no poll_endpoint configured');

  let headers = {};
  if (device.poll_headers_json) {
    let parsed;
    try {
      parsed = JSON.parse(device.poll_headers_json);
    } catch (error) {
      throw new Error(`Invalid poll_headers_json: ${error?.message ?? error}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('poll_headers_json must be a JSON object');
    }
    // fetch requires string header values; coerce numeric/boolean config safely.
    for (const [name, value] of Object.entries(parsed)) headers[name] = String(value);
  }

  const response = await fetch(endpoint, { headers });
  if (!response.ok) {
    throw new Error(`Poll endpoint returned HTTP ${response.status}`);
  }
  const text = await response.text();
  const { rows, errors: parseErrors } = parsePunchText(text, 'json');
  const autoCommit = device.auto_commit === 1 || device.auto_commit === true;
  const result = ingestPunches(db, device, rows, 'poll', { autoCommit });
  // Surface malformed records from the device response alongside DB errors.
  result.errors = [...parseErrors, ...result.errors];

  const timestamp = nowSql();
  updateRow(db, 'biometric_devices', device.id, {
    last_sync_at: timestamp,
    last_seen_at: timestamp,
  });
  return result;
}

/**
 * Build a poller for the given database. It does NOT start any timers until
 * `start()` is called, and `stop()` is idempotent.
 *
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.db
 * @returns {{start:()=>void, stop:()=>void}}
 */
export function createPoller({ db } = {}) {
  if (!db) throw new TypeError('createPoller requires a db');

  /** deviceId -> { timer, baseMs, failures, nextDueAt, inFlight } */
  const timers = new Map();
  let started = false;

  function stopDevice(deviceId) {
    const state = timers.get(deviceId);
    if (!state) return;
    clearInterval(state.timer);
    timers.delete(deviceId);
  }

  async function tick(deviceId) {
    const state = timers.get(deviceId);
    if (!state || state.inFlight) return;

    // Re-read the row each tick: a device may have been disabled, edited or
    // deleted since start(), and a newly enabled one is not in this timer set.
    const device = getRow(db, 'biometric_devices', deviceId);
    if (!isEligible(device)) {
      stopDevice(deviceId);
      return;
    }

    const now = Date.now();
    if (now < state.nextDueAt) return; // exponential-backoff window
    const lastSync = sqlUtcToMs(device.last_sync_at);
    if (lastSync !== null && now - lastSync < state.baseMs) return; // recent manual poll

    state.inFlight = true;
    try {
      await pollDeviceOnce(db, device);
      state.failures = 0;
      state.nextDueAt = Date.now() + state.baseMs;
    } catch (error) {
      state.failures += 1;
      const backoffMs = Math.min(
        state.baseMs * 2 ** state.failures,
        MAX_BACKOFF_MS,
      );
      state.nextDueAt = Date.now() + backoffMs;
      console.error(`[biometric-poller] device ${deviceId} poll failed: ${error?.message ?? error}`);
    } finally {
      state.inFlight = false;
    }
  }

  function start() {
    if (started) return;
    started = true;

    const devices = listRows(
      db,
      'biometric_devices',
      "ingestion_mode = 'poll' AND adapter = 'http_json' AND enabled = 1",
    );
    for (const device of devices) {
      const seconds = Number(device.poll_interval_seconds);
      const baseMs = Math.max(
        MIN_INTERVAL_SECONDS,
        Number.isFinite(seconds) ? seconds : 0,
      ) * 1000;
      const state = {
        timer: null,
        baseMs,
        failures: 0,
        nextDueAt: 0,
        inFlight: false,
      };
      state.timer = setInterval(() => { void tick(device.id); }, baseMs);
      timers.set(device.id, state);
    }
  }

  function stop() {
    for (const deviceId of [...timers.keys()]) stopDevice(deviceId);
    started = false;
  }

  return { start, stop };
}
