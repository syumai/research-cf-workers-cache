// Comparison Worker for Workers Cache vs traditional proxy cache.
//
// This Worker does two jobs:
//
//   /api/respond?case=X        -> serves the same case responses as the Vercel
//                                 origin. The Worker has `cache.enabled = true`
//                                 (Workers Cache), so these responses are
//                                 stored by Cloudflare's cache in front of the
//                                 Worker purely from their HTTP headers.
//   /cache-api/<origin path>   -> proxy to the Vercel origin storing via
//                                 caches.default (the Cache API)
//   /cache-override/<path>     -> same but replaces stored Cache-Control with
//                                 `public, max-age=120` — caches what the
//                                 origin forbade
//   /passthrough/<origin path> -> plain fetch to the origin (no cache)
//
// /api/respond responses carry X-Origin-Id; when Workers Cache serves a
// stored copy the id repeats and X-Worker-Runs stays 0. Proxy-path responses
// get X-Workers-Cache: HIT|MISS|PASSTHROUGH and Cache-Control: no-store so
// Workers Cache never caches them itself.

const MIN = 60 * 1000;

function respond(request) {
  const url = new URL(request.url);
  const c = url.searchParams.get('case') || 'explicit';
  const now = Date.now();
  const id = crypto.randomUUID();
  const hasAuth = Boolean(request.headers.get('authorization'));

  const headers = new Headers({
    'Content-Type': 'application/json',
    'X-Origin-Id': id,
  });

  const body = (extra) =>
    JSON.stringify({ case: c, origin_id: id, origin_time: new Date(now).toISOString(), ...extra });

  switch (c) {
    case 'explicit':
      headers.set('Cache-Control', 'public, max-age=120');
      break;
    case 'expires':
      headers.set('Cache-Control', 'public');
      headers.set('Expires', new Date(now + 2 * MIN).toUTCString());
      break;
    case 'heuristic':
      headers.set('Cache-Control', 'public');
      headers.set('Last-Modified', new Date(now - 30 * MIN).toUTCString());
      break;
    case 'short':
      // Same short max-age as swr but without the directive — isolates
      // whether a cache rejects the SWR directive or the short TTL.
      headers.set('Cache-Control', 'public, max-age=20');
      break;
    case 'swr':
      headers.set('Cache-Control', 'public, max-age=20, stale-while-revalidate=120');
      break;
    case 'vary': {
      const variant = request.headers.get('x-variant') || 'default';
      headers.set('Cache-Control', 'public, max-age=120');
      headers.set('Vary', 'X-Variant');
      return new Response(body({ variant }), { headers });
    }
    case 'nostore':
      headers.set('Cache-Control', 'no-store');
      break;
    case 'private':
      headers.set('Cache-Control', 'private, max-age=120');
      break;
    case 'set-cookie':
      headers.set('Cache-Control', 'public, max-age=120');
      headers.set('Set-Cookie', 'session=abc123; Path=/; HttpOnly');
      break;
    case 'auth-public':
      if (!hasAuth) return new Response(body({ error: 'send Authorization' }), { status: 400, headers });
      headers.set('Cache-Control', 'public, max-age=120');
      break;
    default:
      return new Response(body({ error: `unknown case: ${c}` }), { status: 400, headers });
  }
  return new Response(body(), { headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const segs = url.pathname.split('/');
    const mode = segs[1];

    // Direct origin mode: Workers Cache decides everything from headers.
    if (url.pathname.startsWith('/api/')) {
      return respond(request);
    }

    const origin = env.ORIGIN_BASE;
    if (!origin) {
      return new Response('ORIGIN_BASE is not set', { status: 500 });
    }
    const originPath = '/' + segs.slice(2).join('/');
    const originUrl = new URL(originPath + url.search, origin);

    if (mode === 'passthrough') {
      const upstream = await fetch(originUrl, request);
      const res = new Response(upstream.body, upstream);
      res.headers.set('X-Workers-Cache', 'PASSTHROUGH');
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }

    if (mode !== 'cache-api' && mode !== 'cache-override') {
      return new Response('use /api/, /cache-api/, /cache-override/ or /passthrough/', { status: 404 });
    }

    const cache = caches.default;
    const hit = await cache.match(request);
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set('X-Workers-Cache', 'HIT');
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }

    const upstream = await fetch(new Request(originUrl.toString(), request));
    let toStore = upstream.clone();
    if (mode === 'cache-override') {
      const headers = new Headers(upstream.headers);
      headers.set('Cache-Control', 'public, max-age=120');
      toStore = new Response(upstream.clone().body, {
        status: upstream.status,
        headers,
      });
    }
    let putError = null;
    try {
      await cache.put(request, toStore);
    } catch (e) {
      putError = e instanceof Error ? e.message : String(e);
    }
    const res = new Response(upstream.body, upstream);
    res.headers.set('X-Workers-Cache', 'MISS');
    res.headers.set('Cache-Control', 'no-store');
    if (putError) {
      res.headers.set('X-Cache-Put-Error', putError);
    }
    return res;
  },
};
