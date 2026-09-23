# Measured results (2026-09-23, all times UTC)

**English** | [日本語](results.ja.md)

Identical origin responses on both sides. `cf-cache-status` / `X-Workers-Cache`
observe the caching layer directly; `origin_id` proves when the origin was hit.

## Behavior matrix

| `?case=` | Workers Cache (`/api/*`) | Cloudflare CDN (`cache-compare.*`) | Cache API (`caches.default`) |
|---|---|---|---|
| `explicit` (max-age=120) | **HIT** | **HIT** | **HIT** |
| `expires` | **HIT** | **HIT** | **HIT** |
| `heuristic` (public + LM-30min) | **HIT, then expires ~200s** (≈ RFC 10% of LM age) | **HIT ≥ 602s**, expired by ~16min — fixed default TTL, far beyond RFC heuristic | **HIT** (still HIT ≥ 277s) |
| `short` (max-age=20) | **HIT** | **HIT** | — |
| `swr` (max-age=20 + `stale-while-revalidate=120`) | **`UPDATING`** — serves stale, revalidates in background; next request gets the new `origin_id` | **`UPDATING`** — same async-SWR behavior (stale served while revalidating, then HIT) | — |
| `nostore` | BYPASS | BYPASS | never served |
| `private` | BYPASS | BYPASS | never served |
| `set-cookie` | BYPASS | BYPASS | never served (put is a no-op even with overridden `Cache-Control`) |
| `auth-public` (Authorization + `public`) | **HIT** | **HIT** | **HIT** |
| `vary` (`Vary: X-Variant`) | correct per-variant entries (`a`→`a`, `b`→`b`) | **Vary ignored by default** — `b`/`c` requests all HIT the stored `"a"` body; **correct after adding a Vary cache rule** (`x-variant: passthrough`) | — |
| cache scope | **tiered** — a HIT was returned in a colo that never fetched | edge per-colo — each colo missed once before HITting (SEA MISS → SJC MISS → HITs) | **colo/node-local only** — probes in SEA missed entries stored in SJC |

## Differences observed

1. **Heuristic freshness: RFC on Workers Cache, fixed default on the CDN.**
   `Cache-Control: public` + `Last-Modified: now-30min` gives ~200s freshness
   under RFC 9111 §4.2.2 (10% of 30min). Workers Cache served a HIT at ~60s and
   re-fetched by ~6min — consistent with the RFC. The CDN still served a HIT at
   **age 602s** and only re-fetched after ~16min — it applies a fixed default
   edge TTL, much longer than the heuristic, i.e. it caches *more*
   aggressively than RFC here rather than less.

2. **`Vary` on a custom header: automatic on Workers Cache, opt-in on the
   CDN (by design).** With `Vary: X-Variant`, Workers Cache kept per-variant
   entries and always returned the right body (`a`→`a`, `b`→`b`). The CDN
   ignores `Vary` by default — per the [Cloudflare cache docs](https://developers.cloudflare.com/cache/concepts/cache-control/):
   "Cloudflare does not consider vary values in caching decisions" unless you
   configure the Cache Rules Vary setting, Vary for images, or the header is
   `Accept-Encoding` (and `Vary: *` always bypasses). This is intended spec,
   not a bug. Empirically confirmed both ways: without the setting every
   request variant (`a`, `b`, `c`) HIT the stored `"a"` body; after adding
   `vary.headers.x-variant = passthrough` to the cache rule, the CDN kept
   correct per-variant entries. The real difference is therefore *defaults*:
   Workers Cache follows RFC 9111 out of the box, the CDN needs per-header
   opt-in configuration.

3. **Architecture: tiered vs. local.**
   Workers Cache answered a HIT in a colo that never stored the entry
   (upper-tier tiered cache). On the CDN path each edge colo missed once
   before hitting (no cross-colo HIT observed). `caches.default` is strictly
   colo/node-local — the same URL fetched from SJC and SEA produced
   independent caches, and the SEA entry was even lost between consecutive
   probes. For load that lands in many edge locations, the Cache API behaves
   like N small caches.

4. **The Cache API is a different product.**
   `caches.default` lets the Worker *override* origin directives — serving
   `nostore`/`private` responses with a rewritten `Cache-Control` works —
   but it still refuses `Set-Cookie` bodies regardless of headers, and it is
   not tiered. Workers Cache (`cache.enabled`) is declarative: it front-runs
   the Worker, follows RFC semantics automatically, and also exposes
   `ctx.cache.purge()` — no way to do that on the CDN path from the Worker.

## Same behavior on both paths

- **`stale-while-revalidate`: identical semantics.** Workers Cache implements
  RFC 5861 (`Cf-Cache-Status: UPDATING` — stale served instantly, background
  revalidation, next request gets the new `origin_id`), and the CDN does the
  same: re-probed inside the 140s stale window it returned `UPDATING` with the
  stale `origin_id`, then `HIT` with the revalidated body
  (cf. [2026-02-26 async SWR changelog](https://developers.cloudflare.com/changelog/post/2026-02-26-async-stale-while-revalidate/)).
  An earlier run that observed `EXPIRED` on every request was an artifact of
  probing outside the stale window.
- **`explicit` / `expires` / `short`: HIT on both** — normal TTL-driven
  caching works the same.
- **`nostore` / `private` / `set-cookie`: BYPASS on both** — uncacheable
  directives are respected identically.
- **`auth-public`: HIT on both** — RFC 7233 §3.5 makes an explicit `public`
  override the Authorization default, and both caches honor it.

## Notes & caveats

- Vercel injects `Cache-Control: public, max-age=0, must-revalidate` when a
  function omits the header; the `heuristic`/`expires` cases therefore send
  `Cache-Control: public` explicitly. `Vercel-CDN-Cache-Control: no-store` is
  set on every response so Vercel's own edge never participates.
- Cache Rule used on the CDN path: `http.host eq "cache-compare.syumai.dev"` →
  `set_cache_settings` with `cache: true` (eligible for cache; later extended
  with `vary.headers.x-variant = passthrough`). No explicit edge TTL was set —
  the long heuristic TTL is the CDN default, not a misconfiguration.
- `Set-Cookie` suppression on the CDN is expected RFC behavior; including it
  for completeness.
- Times: heuristic TTL on Workers Cache bracketed to (60s, ~390s] — consistent
  with RFC 10% (~200s). CDN served a HIT at age 602s and expired by ~16min,
  i.e. a default edge TTL ~3-5x the RFC heuristic.
