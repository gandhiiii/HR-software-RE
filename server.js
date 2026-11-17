/**
 * HRMS HTTP entry point.
 *
 * `startServer` wires the router, auth endpoints and a database into an
 * http.Server. It does NOT bind a port: callers (tests) typically listen on
 * port 0 themselves. When this module is run directly (`node server.js`) the
 * main guard below binds the configured 127.0.0.1:3000 address.
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { openDatabase } from './lib/db.js';
import { createRouter } from './lib/router.js';
import { registerAuthRoutes } from './lib/auth.js';
import { sendJson } from './lib/http.js';
import { renderStatic } from './lib/static.js';
import { registerEmployeeRoutes, registerOrgRoutes } from './api/employees.js';
import { registerAttendanceRoutes } from './api/attendance.js';
import { registerLeaveRoutes } from './api/leave.js';
import { registerPayrollRoutes } from './api/payroll.js';
import { registerExpenseRoutes } from './api/expenses.js';
import { registerTaskRoutes } from './api/tasks.js';
import { registerAssetRoutes } from './api/assets.js';
import { registerReportRoutes } from './api/reports.js';
import { registerSettingsRoutes } from './api/settings.js';

const HOST = '127.0.0.1';
const PORT = 3000;

/**
 * Register every feature module on a router. Auth routes are registered inside
 * `startServer` itself, so this covers the remaining API modules only. The
 * `node server.js` main guard and the end-to-end test share this one helper, so
 * production wiring and tested wiring cannot drift apart. Tests that need a
 * narrower surface can still pass their own `registerRoutes` hook to
 * `startServer` — that hook is additive and remains fully supported.
 */
export function registerAllRoutes(router) {
  registerEmployeeRoutes(router);
  registerOrgRoutes(router);
  registerAttendanceRoutes(router);
  registerLeaveRoutes(router);
  registerPayrollRoutes(router);
  registerExpenseRoutes(router);
  registerTaskRoutes(router);
  registerAssetRoutes(router);
  registerReportRoutes(router);
  registerSettingsRoutes(router);
}

/**
 * Build the HRMS server. IMPORTANT: this function does NOT listen on a port.
 * Callers must call `server.listen(...)` themselves — API tests use
 * `server.listen(0)` so `makeClient` can pick an ephemeral port. `port` and
 * `host` are metadata only: they are stored on `server.bindAddress` for the
 * CLI main guard below, which is what satisfies the one-command `node server.js`
 * start. They never trigger a listen call inside this function.
 *
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.db database from lib/db.js
 * @param {number} [options.port=3000] metadata port (used by the CLI main guard)
 * @param {string} [options.host='127.0.0.1'] metadata host (CLI main guard)
 * @param {(router: object) => void} [options.registerRoutes] hook for later
 *   tasks to add their own routes to the same router
 * @returns {import('node:http').Server} an http.Server that is NOT listening;
 *   its `bindAddress` is `{port, host}` metadata and `router` is the live router
 */
export function startServer({ db, port = PORT, host = HOST, registerRoutes } = {}) {
  if (!db) throw new TypeError('startServer requires a db');

  const router = createRouter();
  registerAuthRoutes(router);
  if (typeof registerRoutes === 'function') registerRoutes(router);

  const server = http.createServer(async (req, res) => {
    // Static UI files are served first (Task 11). Anything not handled here —
    // every /api/* route, unknown paths, and non-GET/HEAD requests — falls
    // through to the JSON router unchanged, so auth and role checks are intact.
    try {
      if (await renderStatic(req, res)) return;
      await router.handle(req, res, { db });
    } catch (error) {
      // Defensive backstop: router.handle already converts throws to JSON 500s.
      if (res.headersSent) return res.end();
      sendJson(res, 500, { error: error?.message ?? 'Internal server error' });
    }
  });
  server.bindAddress = { port, host };
  // Exposed so later tasks can register additional routes onto a live server.
  server.router = router;
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const db = openDatabase();
  // The production entry point registers the complete application: auth plus
  // every feature module via registerAllRoutes (see above).
  const server = startServer({ db, registerRoutes: registerAllRoutes });
  const { port, host } = server.bindAddress;
  server.listen(port, host, () => {
    console.log(`HRMS listening on http://${host}:${port}`);
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
