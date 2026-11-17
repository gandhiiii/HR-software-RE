/**
 * Password hashing and in-memory session authentication.
 *
 * The password contract deliberately mirrors Task 1's seed helper: the salt is
 * a 32-character hex STRING that is passed to scrypt directly (NOT decoded
 * back into bytes), and the hash is the 64-byte result encoded as hex. Keeping
 * this contract here (instead of importing lib/db.js) is intentional per the
 * controller ruling; collapsing the duplicated contract is a deferred minor.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const SESSION_COOKIE = 'hrms_session';

/** Roles that may use the authenticated auth endpoints (logout, me). */
const ALL_ROLES = ['admin', 'hr', 'employee'];

/** The active sessions: token -> userId. Process-local, as required. */
const sessions = new Map();

/** Hash a password into a {salt, hash} pair compatible with the seed contract. */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, KEY_LENGTH).toString('hex');
  return { salt, hash };
}

/** Verify a password against a stored (salt, hash) pair in constant time. */
export function verifyPassword(password, salt, hash) {
  const expected = scryptSync(String(password), String(salt), KEY_LENGTH).toString('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(hash));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Create a session for a user id and return its opaque token. */
export function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, userId);
  return token;
}

/** Return the user id for a token, or null if the token is unknown. */
export function getSession(token) {
  if (!token || !sessions.has(token)) return null;
  return sessions.get(token);
}

/** Invalidate a session token (no-op for unknown tokens). */
export function destroySession(token) {
  if (token) sessions.delete(token);
}

function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/`;
}

function clearedCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    employee_id: user.employee_id,
  };
}

/**
 * Register the auth endpoints on a router.
 * - POST /api/auth/login  (public)
 * - POST /api/auth/logout (authenticated)
 * - GET  /api/auth/me     (authenticated)
 */
export function registerAuthRoutes(router) {
  router.register('POST', '/api/auth/login', [], async ({ db, body }) => {
    const username = body?.username;
    const password = body?.password;
    const row = db
      .prepare('SELECT id, username, role, employee_id, password_hash, salt FROM users WHERE username = ?')
      .get(String(username ?? ''));
    if (!row || !verifyPassword(String(password ?? ''), row.salt, row.password_hash)) {
      return { status: 401, body: { error: 'Invalid username or password' } };
    }
    const token = createSession(row.id);
    const user = publicUser(row);
    return {
      status: 200,
      body: { ...user, user },
      headers: { 'Set-Cookie': sessionCookie(token) },
    };
  });

  router.register('POST', '/api/auth/logout', ALL_ROLES, async ({ token }) => {
    destroySession(token);
    return {
      status: 200,
      body: { ok: true },
      headers: { 'Set-Cookie': clearedCookie() },
    };
  });

  router.register('GET', '/api/auth/me', ALL_ROLES, async ({ user }) => ({
    status: 200,
    body: { ...publicUser(user), user: publicUser(user) },
  }));
}

export { SESSION_COOKIE };
