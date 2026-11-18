import { openDatabase } from '../lib/db.js';

/** A fresh seeded in-memory database for isolated tests. */
export function makeDb() {
  return openDatabase({ path: ':memory:', seed: true });
}

/**
 * A small fetch client bound to a listening HTTP server. It keeps a cookie jar
 * so login/session flows can be exercised like a browser.
 */
export function makeClient(server) {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('makeClient expects a listening server with a TCP port');
  }
  const base = `http://127.0.0.1:${address.port}`;
  const cookies = new Map();

  function cookieHeader() {
    return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async function request(method, path, options = {}) {
    const { body, headers = {}, raw = false, contentType } = options;
    const requestHeaders = { ...headers };
    if (body !== undefined) requestHeaders['content-type'] = contentType ?? 'application/json';
    const cookie = cookieHeader();
    if (cookie) requestHeaders.cookie = cookie;

    const res = await fetch(base + path, {
      method,
      headers: requestHeaders,
      body: body !== undefined ? (raw ? body : JSON.stringify(body)) : undefined,
      redirect: 'manual',
    });

    for (const setCookie of res.headers.getSetCookie?.() ?? []) {
      const [pair] = setCookie.split(';');
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const expired = /expires=thu, 01 jan 1970/i.test(setCookie) || value === '';
      if (expired) cookies.delete(name);
      else cookies.set(name, value);
    }

    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, headers: res.headers, body: json, text };
  }

  return {
    request,
    get: (path, options) => request('GET', path, options),
    post: (path, body, options) => request('POST', path, { ...options, body }),
    postRaw: (path, body, contentType) => request('POST', path, { body, raw: true, contentType }),
    put: (path, body, options) => request('PUT', path, { ...options, body }),
    patch: (path, body, options) => request('PATCH', path, { ...options, body }),
    delete: (path, options) => request('DELETE', path, options),
    cookies,
  };
}
