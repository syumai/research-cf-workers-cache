# Measured results (2026-09-23, all times UTC)

Identical origin responses on both sides. `cf-cache-status` / `X-Workers-Cache`
observe the caching layer directly; `origin_id` proves when the origin was hit.

## Behavior matrix

| `?case=` | Workers Cache (`/api/*`) | Cloudflare CDN (`cache-compare.*`) | Cache API (`caches.default`) |
|---|---|---|---|
| `explicit` (max-age=120) | **HIT** | **HIT** | **HIT** |
| `expires` | **HIT** | **HIT** | **HIT** |
| `heuristic` (public + LM-30min) | **HIT, then expires ~200s** (≈ RFC 10% of LM age) | **HIT ≥ 602s**, expired by ~16min — fixed default TTL, far beyond RFC heuristic | **HIT** (still HIT ≥ 277s) |
| `short` (max-age=20) | **HIT** | **HIT** | — |
| `swr` (max-age=20 + `stale-while-revalidate=120`) | **`UPDATING`** — serves stale, revalidates in background; next request gets the new `origin_id` | **`EXPIRED` every request** — never serves from cache; effectively uncached | — |
| `nostore` | BYPASS | BYPASS | never served |
| `private` | BYPASS | BYPASS | never served |
| `set-cookie` | BYPASS | BYPASS | never served (put is a no-op even with overridden `Cache-Control`) |
| `auth-public` (Authorization + `public`) | **HIT** | **HIT** | **HIT** |
| `vary` (`Vary: X-Variant`) | correct per-variant entries (`a`→`a`, `b`→`b`) | **wrong variant served** (`X-Variant: b` got cached body `"a"`) | — |
| cache scope | **tiered** — a HIT was returned from an entry stored by a different colo | colo-local edge cache (entries seen in the colo that stored them) | **colo/node-local only** — probes in SEA missed entries stored in SJC |

## Key differences actually observed

1. **`stale-while-revalidate` is the decisive behavioral split.**
   Workers Cache implements RFC 5861: `Cf-Cache-Status: UPDATING` — the client
   gets the stale copy instantly while the origin is refreshed in the background,
   and the next request sees a fresh `origin_id`. The same response through the
   CDN is `EXPIRED` on **every** request — the directive makes the CDN treat the
   response as instantly stale, so it re-fetches from the origin synchronously
   every time. `max-age=20` *without* the directive caches fine on both sides,
   isolating the cause to SWR itself, not the short TTL.

2. **Heuristic freshness follows RFC on Workers Cache, not on the CDN.**
   `Cache-Control: public` + `Last-Modified: now-30min` gives ~200s freshness
   under RFC 9111 §4.2.2 (10% of 30min). Workers Cache served a HIT at ~60s and
   re-fetched by ~6min — consistent with the RFC. The CDN still served a HIT at
   **age 602s** and only re-fetched after ~16min — it applies a fixed default
   edge TTL, much longer than the heuristic, i.e. it caches *more*
   aggressively than RFC here rather than less.

3. **`Vary` on a custom header is only safe on Workers Cache.**
   With `Vary: X-Variant`, Workers Cache kept per-variant entries and always
   returned the right body. The CDN stored the variants but then served a
   `"a"` body to an `X-Variant: b` request — the cache key didn't fully
   partition on the custom header.

4. **Both layers cache `Authorization`-required requests that say `public`.**
   This surprised the "traditional proxies are conservative" intuition in both
   directions: RFC 7233 §3.5 makes an explicit `public` override the
   Authorization default, and both caches honor it.

5. **Architecture: tiered vs. local.**
   Workers Cache answered a HIT in a colo that never stored the entry
   (upper-tier tiered cache). `caches.default` is strictly colo/node-local —
   the same URL fetched from SJC and SEA produced independent caches, and
   the SEA entry was even lost between consecutive probes. For load that
   lands in many edge locations, the Cache API behaves like N small caches.

6. **The Cache API is a different product.**
   `caches.default` lets the Worker *override* origin directives — serving
   `nostore`/`private` responses with a rewritten `Cache-Control` works —
   but it still refuses `Set-Cookie` bodies regardless of headers, and it is
   not tiered. Workers Cache (`cache.enabled`) is declarative: it front-runs
   the Worker, follows RFC semantics automatically, and also exposes
   `ctx.cache.purge()` — no way to do that on the CDN path from the Worker.

## Notes & caveats

- Vercel injects `Cache-Control: public, max-age=0, must-revalidate` when a
  function omits the header; the `heuristic`/`expires` cases therefore send
  `Cache-Control: public` explicitly. `Vercel-CDN-Cache-Control: no-store` is
  set on every response so Vercel's own edge never participates.
- Cache Rule used on the CDN path: `http.request.uri.path contains "/api/"` →
  "Eligible for cache". No explicit edge TTL was set — the long heuristic TTL
  is the CDN default, not a misconfiguration.
- `Set-Cookie` suppression on the CDN is expected RFC behavior; including it
  for completeness.
- Times: heuristic TTL on Workers Cache bracketed to (60s, ~390s] — consistent
  with RFC 10% (~200s). CDN served a HIT at age 602s and expired by ~16min,
  i.e. a default edge TTL ~3-5x the RFC heuristic.
