/**
 * Dependency-free static file serving for the browser UI.
 *
 * The HTTP entry point tries `renderStatic` before handing a request to the
 * JSON router. Only safe, in-tree GET/HEAD requests for files under `public/`
 * are served here; everything under `/api` (and anything else) still goes
 * through the router so authentication, roles and error shapes are unchanged.
 *
 * Exported so later wiring (Task 12) can reuse the exact same helper instead of
 * reimplementing path sanitation and MIME handling.
 */
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Default public directory, resolved relative to this module (never cwd). */
export const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Resolve a request pathname to an absolute file inside `publicDir`.
 * Returns `null` for traversal attempts, null bytes, or paths that escape the
 * public root. `/` maps to `index.html`.
 */
export function resolveStaticPath(pathname, publicDir = PUBLIC_DIR) {
  if (typeof pathname !== 'string' || pathname.includes('\0')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const root = resolve(publicDir);
  const full = resolve(root, relative);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

/**
 * Try to serve a static request.
 *
 * @returns {Promise<boolean>} true when the response was completed here, false
 *   when the caller should continue to the JSON router.
 */
export async function renderStatic(req, res, { publicDir = PUBLIC_DIR } = {}) {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;

  let url;
  try {
    url = new URL(req.url ?? '/', 'http://127.0.0.1');
  } catch {
    return false;
  }
  // API traffic always belongs to the router, even for a GET.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return false;

  const full = resolveStaticPath(url.pathname, publicDir);
  if (!full) return false;

  let data;
  try {
    data = await readFile(full);
  } catch {
    // Missing file (or a directory) is not an error here: let the router
    // produce its normal 404 so error shapes stay consistent.
    return false;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', MIME_TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Content-Length', data.length);
  res.end(method === 'HEAD' ? undefined : data);
  return true;
}
