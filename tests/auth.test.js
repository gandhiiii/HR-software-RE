import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { scryptSync } from 'node:crypto';
import { makeDb, makeClient } from './helpers.js';
import {
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  destroySession,
} from '../lib/auth.js';
import { createRouter } from '../lib/router.js';
import { startServer } from '../server.js';

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

/** A tiny request harness for exercising a router directly (no auth routes). */
async function makeHarness(router) {
  const db = makeDb();
  const server = http.createServer((req, res) => router.handle(req, res, { db }));
  await listen(server);
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, path, { cookie, body, rawBody, headers = {} } = {}) {
    const requestHeaders = { ...headers };
    if (cookie) requestHeaders.cookie = cookie;
    let payload;
    if (rawBody !== undefined) {
      payload = rawBody;
      requestHeaders['content-type'] = 'application/json';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      requestHeaders['content-type'] = 'application/json';
    }
    const res = await fetch(base + path, { method, headers: requestHeaders, body: payload });
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { code: res.status, body: json, text, res };
  }

  return {
    db,
    server,
    request,
    close: async () => {
      await close(server);
      db.close();
    },
  };
}

function sessionCookieFor(db, role) {
  const row = db.prepare('SELECT id FROM users WHERE role = ?').get(role);
  assert.ok(row, `missing seeded ${role} user`);
  return `hrms_session=${createSession(row.id)}`;
}

test('verifyPassword matches the seeded password contract', () => {
  const db = makeDb();
  try {
    const user = db
      .prepare('SELECT username, salt, password_hash FROM users WHERE username = ?')
      .get('admin');
    assert.ok(user);
    assert.equal(user.salt.length, 32);
    assert.equal(user.password_hash.length, 128);
    assert.equal(verifyPassword('admin123', user.salt, user.password_hash), true);
    assert.equal(verifyPassword('wrong', user.salt, user.password_hash), false);
    // The salt is the hex STRING passed directly to scrypt (not decoded).
    assert.equal(scryptSync('admin123', user.salt, 64).toString('hex'), user.password_hash);
  } finally {
    db.close();
  }
});

test('hashPassword produces a contract-compatible salt/hash pair', () => {
  const { salt, hash } = hashPassword('secret');
  assert.match(salt, /^[0-9a-f]{32}$/);
  assert.match(hash, /^[0-9a-f]{128}$/);
  assert.equal(scryptSync('secret', salt, 64).toString('hex'), hash);
  assert.equal(verifyPassword('secret', salt, hash), true);
  assert.equal(verifyPassword('other', salt, hash), false);
});

test('session lifecycle: create, get, destroy', () => {
  const token = createSession(42);
  assert.ok(token && typeof token === 'string');
  assert.equal(getSession(token), 42);
  assert.equal(getSession('does-not-exist'), null);
  destroySession(token);
  assert.equal(getSession(token), null);
});

test('router enforces authentication and roles (401/403/200/404)', async () => {
  const router = createRouter();
  router.register('GET', '/api/hr', ['hr', 'admin'], async () => ({ status: 200, body: { ok: true } }));
  const h = await makeHarness(router);
  try {
    // unauthenticated
    const anonymous = await h.request('GET', '/api/hr');
    assert.equal(anonymous.code, 401);
    assert.deepEqual(anonymous.body, { error: 'Authentication required' });

    // allowed role
    const adminCookie = sessionCookieFor(h.db, 'admin');
    const allowed = await h.request('GET', '/api/hr', { cookie: adminCookie });
    assert.equal(allowed.code, 200);
    assert.deepEqual(allowed.body, { ok: true });

    // wrong role
    const employeeCookie = sessionCookieFor(h.db, 'employee');
    const forbidden = await h.request('GET', '/api/hr', { cookie: employeeCookie });
    assert.equal(forbidden.code, 403);
    assert.deepEqual(forbidden.body, { error: 'Forbidden' });

    // unmatched route
    const missing = await h.request('GET', '/api/undefined', { cookie: adminCookie });
    assert.equal(missing.code, 404);
    assert.ok(missing.body.error);
  } finally {
    await h.close();
  }
});

test('router exposes params and query to handlers', async () => {
  const router = createRouter();
  router.register('GET', '/api/items/:id', ['admin'], async ({ params, query, user }) => ({
    status: 200,
    body: { id: params.id, q: query.q, role: user.role },
  }));
  const h = await makeHarness(router);
  try {
    const res = await h.request('GET', '/api/items/7?q=hello', {
      cookie: sessionCookieFor(h.db, 'admin'),
    });
    assert.equal(res.code, 200);
    assert.deepEqual(res.body, { id: '7', q: 'hello', role: 'admin' });
  } finally {
    await h.close();
  }
});

test('login sets a cookie, /me and /logout work, wrong password is 401', async () => {
  const db = makeDb();
  const server = startServer({ db });
  await listen(server);
  const client = makeClient(server);
  try {
    const login = await client.post('/api/auth/login', {
      username: 'admin',
      password: 'admin123',
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.ok(cookie && /hrms_session=/.test(cookie), 'expected a Set-Cookie header');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Path=\//);
    assert.equal(login.body.user.role, 'admin');

    const me = await client.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.username, 'admin');

    const logout = await client.post('/api/auth/logout');
    assert.equal(logout.status, 200);
    assert.equal(client.cookies.has('hrms_session'), false);

    const afterLogout = await client.get('/api/auth/me');
    assert.equal(afterLogout.status, 401);

    const bad = await client.post('/api/auth/login', {
      username: 'admin',
      password: 'not-the-password',
    });
    assert.equal(bad.status, 401);
    assert.ok(bad.body.error);
  } finally {
    await close(server);
    db.close();
  }
});

test('all three seeded roles can log in with admin123', async () => {
  const db = makeDb();
  const server = startServer({ db });
  await listen(server);
  const client = makeClient(server);
  try {
    for (const role of ['admin', 'hr', 'employee']) {
      const res = await client.post('/api/auth/login', { username: role, password: 'admin123' });
      assert.equal(res.status, 200, `${role} should be able to log in`);
      assert.equal(res.body.user.role, role);
    }
  } finally {
    await close(server);
    db.close();
  }
});

test('later tasks can register routes via the hook or onto server.router', async () => {
  const db = makeDb();
  const server = startServer({
    db,
    registerRoutes: (router) =>
      router.register('GET', '/api/hook', ['employee'], async () => ({ status: 200, body: { via: 'hook' } })),
  });
  server.router.register('GET', '/api/late', ['employee'], async () => ({ status: 200, body: { via: 'late' } }));
  await listen(server);
  const client = makeClient(server);
  try {
    const login = await client.post('/api/auth/login', { username: 'employee', password: 'admin123' });
    assert.equal(login.status, 200);
    const hooked = await client.get('/api/hook');
    assert.equal(hooked.status, 200);
    assert.deepEqual(hooked.body, { via: 'hook' });
    const late = await client.get('/api/late');
    assert.equal(late.status, 200);
    assert.deepEqual(late.body, { via: 'late' });
  } finally {
    await close(server);
    db.close();
  }
});

test('readJsonBody cap and handler errors return {error} with the right status', async () => {
  const router = createRouter();
  router.register('POST', '/api/echo', ['admin'], async ({ body }) => ({
    status: 200,
    body: { received: body },
  }));
  router.register('GET', '/api/boom', ['admin'], async () => {
    const error = new Error('kaboom');
    error.status = 422;
    throw error;
  });
  const h = await makeHarness(router);
  const cookie = sessionCookieFor(h.db, 'admin');
  try {
    const ok = await h.request('POST', '/api/echo', { cookie, body: { x: 1 } });
    assert.equal(ok.code, 200);
    assert.deepEqual(ok.body.received, { x: 1 });

    const invalid = await h.request('POST', '/api/echo', { cookie, rawBody: '{bad json' });
    assert.equal(invalid.code, 400);
    assert.deepEqual(invalid.body, { error: 'Invalid JSON body' });

    const oversized = await h.request('POST', '/api/echo', {
      cookie,
      rawBody: 'x'.repeat(1024 * 1024 + 1),
    });
    assert.equal(oversized.code, 413);
    assert.match(oversized.body.error, /too large/i);

    const boom = await h.request('GET', '/api/boom', { cookie });
    assert.equal(boom.code, 422);
    assert.deepEqual(boom.body, { error: 'kaboom' });
  } finally {
    await h.close();
  }
});
