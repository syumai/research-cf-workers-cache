// Origin endpoint shared by both cache paths.
// Each `case` returns the same JSON body shape with different cache-related
// response headers so cache behavior can be observed from X-Origin-Id:
// when a cache serves a stored response, the origin_id stops changing.
const { randomUUID } = require('crypto');

const MIN = 60 * 1000;

module.exports = function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const c = url.searchParams.get('case') || 'explicit';
  const now = Date.now();
  const id = randomUUID();
  const hasAuth = Boolean(req.headers.authorization);

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Origin-Id', id);

  switch (c) {
    case 'explicit':
      // Explicit freshness: a traditional shared cache and the Workers
      // Cache API should both store and serve this for 2 minutes.
      res.setHeader('Cache-Control', 'public, max-age=120');
      break;
    case 'expires':
      // Explicit freshness via Expires instead of Cache-Control.
      res.setHeader('Expires', new Date(now + 2 * MIN).toUTCString());
      break;
    case 'heuristic':
      // No explicit freshness. RFC 7234 4.2.2 allows a cache to apply
      // heuristic freshness (10% of time since Last-Modified = 3 min here).
      // Traditional proxies generally do NOT cache this; the Workers Cache
      // API is documented to follow RFC semantics aggressively.
      res.setHeader('Last-Modified', new Date(now - 30 * MIN).toUTCString());
      break;
    case 'nostore':
      res.setHeader('Cache-Control', 'no-store');
      break;
    case 'private':
      // Shared caches must not store private responses (RFC 7234 3.2).
      res.setHeader('Cache-Control', 'private, max-age=120');
      break;
    case 'set-cookie':
      // RFC permits storing; many CDNs refuse by default.
      res.setHeader('Cache-Control', 'public, max-age=120');
      res.setHeader('Set-Cookie', 'session=abc123; Path=/; HttpOnly');
      break;
    case 'auth-public': {
      // Response to an authenticated request. RFC 7234 3.2 permits a shared
      // cache to store it because the response is marked public.
      if (!hasAuth) {
        res.status(400).json({ error: 'send an Authorization header' });
        return;
      }
      res.setHeader('Cache-Control', 'public, max-age=120');
      break;
    }
    case 'auth-none': {
      // Authenticated request without a directive permitting shared storage:
      // shared caches must not store it.
      if (!hasAuth) {
        res.status(400).json({ error: 'send an Authorization header' });
        return;
      }
      res.setHeader('Last-Modified', new Date(now - 30 * MIN).toUTCString());
      break;
    }
    default:
      res.status(400).json({ error: `unknown case: ${c}` });
      return;
  }

  res.status(200).json({
    case: c,
    origin_id: id,
    origin_time: new Date(now).toISOString(),
  });
};
