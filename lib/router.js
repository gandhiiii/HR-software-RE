/**
 * A tiny, dependency-free router.
 *
 * Routes are registered with an explicit roles array. A non-empty array allows
 * only authenticated users whose role appears in it; an empty array marks the
 * route public (used only by the login endpoint). Patterns support `:param`
 * segments and query strings are parsed from req.url.
 */
import { parseCookies, readJsonBody, readTextBody, sendJson } from './http.js';
import { getSession, SESSION_COOKIE } from './auth.js';

const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

/** Compile a path pattern like `/api/employees/:id` into a regex + param names. */
function compile(pattern) {
  const names = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        names.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source}$`), names };
}

function normalizePath(pathname) {
  if (!pathname) return '/';
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function decodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function createRouter() {
  const routes = [];

  /**
   * Register a route.
   * @param {string} method HTTP method (case-insensitive)
   * @param {string} pattern path pattern with optional `:param` segments
   * @param {string[]} roles explicit allowed roles; `[]` means public
   * @param {(ctx: object) => Promise<{status:number,body:any,headers?:object}>} handler
   * @param {{rawBody?:boolean}} [options] opt-in body handling; when
   *   `rawBody` is true the body is passed as raw text instead of parsed JSON
   */
  function register(method, pattern, roles, handler, options = {}) {
    if (typeof method !== 'string' || !method) throw new TypeError('method is required');
    if (typeof pattern !== 'string' || !pattern.startsWith('/')) {
      throw new TypeError('pattern must start with "/"');
    }
    if (!Array.isArray(roles)) {
      throw new TypeError('roles must be an explicit array');
    }
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    routes.push({
      method: method.toUpperCase(),
      path: normalizePath(pattern),
      roles,
      handler,
      rawBody: options.rawBody === true,
      ...compile(normalizePath(pattern)),
    });
    return router;
  }

  /** Resolve the current user from the session cookie. */
  function resolveUser(req, db) {
    const token = parseCookies(req)[SESSION_COOKIE] ?? null;
    const userId = getSession(token);
    let user = null;
    if (userId !== null && db) {
      user =
        db
          .prepare('SELECT id, username, role, employee_id FROM users WHERE id = ?')
          .get(userId) ?? null;
    }
    return { token, user };
  }

  /** Handle one request: match, enforce auth/roles, call handler, send JSON. */
  async function handleRequest(req, res, ctx = {}) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return sendJson(res, 400, { error: 'Bad request URL' });
    }
    const pathname = normalizePath(url.pathname);
    const query = Object.fromEntries(url.searchParams.entries());

    let matched = null;
    let params = null;
    let pathMatched = false;
    for (const route of routes) {
      const match = route.regex.exec(pathname);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== (req.method ?? 'GET').toUpperCase()) continue;
      matched = route;
      params = Object.fromEntries(route.names.map((name, i) => [name, decodeParam(match[i + 1])]));
      break;
    }

    if (!matched) {
      if (pathMatched) return sendJson(res, 405, { error: 'Method not allowed' });
      return sendJson(res, 404, { error: 'Not found' });
    }

    const { db } = ctx;
    const { token, user } = resolveUser(req, db);

    if (matched.roles.length > 0) {
      if (!user) return sendJson(res, 401, { error: 'Authentication required' });
      if (!matched.roles.includes(user.role)) return sendJson(res, 403, { error: 'Forbidden' });
    }

    let body = {};
    if (!BODYLESS_METHODS.has((req.method ?? 'GET').toUpperCase())) {
      try {
        body = matched.rawBody ? await readTextBody(req) : await readJsonBody(req);
      } catch (error) {
        return sendJson(res, error.status ?? 400, { error: error.message });
      }
    }

    try {
      const result = await matched.handler({ ...ctx, user, token, params, query, body, headers: req.headers });
      if (result?.headers) {
        for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
      }
      sendJson(res, result?.status ?? 200, result?.body ?? null);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      sendJson(res, status, { error: error?.message ?? 'Internal server error' });
    }
  }

  /**
   * Public request entry point. The entire handler — including session/DB
   * lookups that happen before the route handler runs — is wrapped so that no
   * throw can escape as an unhandled promise rejection (fatal on Node 26).
   */
  async function handle(req, res, ctx = {}) {
    try {
      await handleRequest(req, res, ctx);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (res.headersSent) {
        res.end();
      } else {
        sendJson(res, status, { error: error?.message ?? 'Internal server error' });
      }
    }
  }

  const router = { register, handle };
  return router;
}
