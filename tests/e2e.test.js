import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeClient } from './helpers.js';
import { startServer } from '../server.js';
import { registerEmployeeRoutes, registerOrgRoutes } from '../api/employees.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * A listening production-shaped server. Static files must be served by the
 * server itself (Task 11); API routes are registered exactly as production
 * does today so the auth/role checks exercised here are the real ones.
 */
async function setup() {
  const db = makeDb();
  const server = startServer({
    db,
    registerRoutes: (router) => {
      registerEmployeeRoutes(router);
      registerOrgRoutes(router);
    },
  });
  await listen(server);
  return {
    db,
    server,
    client: makeClient(server),
    close: async () => {
      await close(server);
      db.close();
    },
  };
}

test('GET / serves the SPA shell with an #app mount point', async () => {
  const h = await setup();
  try {
    const res = await h.client.get('/');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.headers.get('content-type'), /text\/html/i);
    assert.match(res.text, /id=["']app["']/, 'shell must contain the app mount point');
    assert.match(res.text, /app\.js/, 'shell must load the SPA script');
    assert.match(res.text, /styles\.css/, 'shell must load the stylesheet');
  } finally {
    await h.close();
  }
});

test('GET /app.js and GET /styles.css return 200 with the right content types', async () => {
  const h = await setup();
  try {
    const js = await h.client.get('/app.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/i);
    assert.match(js.text, /api\/auth\/login/, 'SPA must implement the login call');

    const css = await h.client.get('/styles.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/i);
  } finally {
    await h.close();
  }
});

test('unauthenticated API calls from the UI pattern still return 401', async () => {
  const h = await setup();
  try {
    const me = await h.client.get('/api/auth/me');
    assert.equal(me.status, 401);
    assert.equal(me.body.error, 'Authentication required');

    const employees = await h.client.get('/api/employees');
    assert.equal(employees.status, 401, 'static serving must not bypass route auth');
  } finally {
    await h.close();
  }
});
