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
  // Keep Vercel's own edge from storing anything: the only caches under
  // test are the Workers Cache API and the front proxy cache.
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');

  switch (c) {
    case 'explicit':
      // Explicit freshness: a traditional shared cache and the Workers
      // Cache API should both store and serve this for 2 minutes.
      res.setHeader('Cache-Control', 'public, max-age=120');
      break;
    case 'expires':
      // Explicit freshness via Expires (+2min). `public` is also sent so
      // Vercel does not inject its default `max-age=0` Cache-Control, which
      // would otherwise take precedence over Expires.
      res.setHeader('Cache-Control', 'public');
      res.setHeader('Expires', new Date(now + 2 * MIN).toUTCString());
      break;
    case 'heuristic':
      // No explicit freshness, only Last-Modified (30 min ago). Vercel injects
      // `Cache-Control: max-age=0` when the header is absent entirely, so the
      // case sends a bare `public` (marks the response shared-cacheable but
      // gives no freshness). RFC 7234 4.2.2 then allows a cache to apply
      // heuristic freshness: 10% of (Date - Last-Modified) = 3 min here.
      // Traditional proxies generally do NOT cache this; the Workers Cache
      // API is documented to follow RFC semantics aggressively.
      res.setHeader('Cache-Control', 'public');
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
    case 'short':
      // Same short max-age as swr but without the directive — isolates
      // whether a cache rejects the SWR directive or the short TTL.
      res.setHeader('Cache-Control', 'public, max-age=20');
      break;
    case 'swr':
      // max-age=20s, then serve-stale up to 120s while revalidating in the
      // background. Freshness-aware caches should return the stale copy with
      // an UPDATING-style status rather than fetching synchronously.
      res.setHeader('Cache-Control', 'public, max-age=20, stale-while-revalidate=120');
      break;
    case 'vary': {
      // Two variants keyed by the X-Variant request header.
      const variant = req.headers['x-variant'] || 'default';
      res.setHeader('Cache-Control', 'public, max-age=120');
      res.setHeader('Vary', 'X-Variant');
      return res.status(200).json({
        case: c,
        variant,
        origin_id: id,
        origin_time: new Date(now).toISOString(),
      });
    }
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
