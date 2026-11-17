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

const HOST = '127.0.0.1';
const PORT = 3000;

/**
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.db database from lib/db.js
 * @param {number} [options.port=3000] default port (used by the main guard)
 * @param {string} [options.host='127.0.0.1'] default host
 * @param {(router: object) => void} [options.registerRoutes] hook for later
 *   tasks to add their own routes to the same router
 * @returns {import('node:http').Server} an http.Server that is not yet listening
 */
export function startServer({ db, port = PORT, host = HOST, registerRoutes } = {}) {
  if (!db) throw new TypeError('startServer requires a db');

  const router = createRouter();
  registerAuthRoutes(router);
  if (typeof registerRoutes === 'function') registerRoutes(router);

  const server = http.createServer((req, res) => router.handle(req, res, { db }));
  server.bindAddress = { port, host };
  // Exposed so later tasks can register additional routes onto a live server.
  server.router = router;
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const db = openDatabase();
  const server = startServer({ db });
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
