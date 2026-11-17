/** Small HTTP helpers shared by the router and the server. Node built-ins only. */

/** Maximum accepted JSON request body size (1 MB). */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Write a JSON response. `status` is the HTTP status code. */
export function sendJson(res, status, body) {
  const data = JSON.stringify(body === undefined ? null : body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(data));
  res.end(data);
}

/**
 * Read and JSON-parse a request body.
 *
 * Rejects with an Error carrying a numeric `status` for invalid JSON (400) or
 * for bodies larger than 1 MB (413). An empty body resolves to `{}` so POST
 * handlers can always treat `body` as an object.
 */
export function readJsonBody(req, { limit = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        return; // keep draining the socket so a clean 413 can be sent.
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      if (tooLarge) {
        const error = new Error('Request body too large');
        error.status = 413;
        return fail(error);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        const parsed = JSON.parse(text);
        // Handlers expect an object; wrap any other JSON value defensively.
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        const error = new Error('Invalid JSON body');
        error.status = 400;
        fail(error);
      }
    });
    req.on('aborted', () => fail(Object.assign(new Error('Request aborted'), { status: 400 })));
    req.on('error', (error) => fail(error));
  });
}

/** Parse a Cookie header into a plain object of name -> value. */
export function parseCookies(req) {
  const header = req.headers?.cookie;
  const cookies = {};
  if (typeof header !== 'string' || !header) return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}
