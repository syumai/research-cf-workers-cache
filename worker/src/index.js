// Comparison Worker for Workers Cache API vs traditional proxy cache.
//
// Paths:
//   /cache-api/<origin path>   -> cache.match/put via caches.default,
//                                 keyed by the incoming request
//   /passthrough/<origin path> -> plain fetch to the origin (no cache)
//
// Every response gets X-Workers-Cache: HIT|MISS (cache-api path) or
// PASSTHROUGH so the verify script can tell stored responses from fresh
// origin fetches. When cache.put() rejects, the reason is surfaced in
// X-Cache-Put-Error.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const segs = url.pathname.split('/');
    const mode = segs[1];
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
      return res;
    }

    if (mode !== 'cache-api') {
      return new Response('use /cache-api/ or /passthrough/', { status: 404 });
    }

    const cache = caches.default;
    // Key on the incoming request so Vary and Authorization are part of the
    // lookup semantics, the same way a shared proxy cache sees them.
    const hit = await cache.match(request);
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set('X-Workers-Cache', 'HIT');
      return res;
    }

    const upstream = await fetch(new Request(originUrl.toString(), request));
    let putError = null;
    try {
      ctx.waitUntil(cache.put(request, upstream.clone()));
    } catch (e) {
      putError = e instanceof Error ? e.message : String(e);
    }
    const res = new Response(upstream.body, upstream);
    res.headers.set('X-Workers-Cache', 'MISS');
    if (putError) {
      res.headers.set('X-Cache-Put-Error', putError);
    }
    return res;
  },
};
