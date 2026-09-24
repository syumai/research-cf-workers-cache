# Measured results (2026-09-23, all times UTC)

**English** | [日本語](results.ja.md)

Identical origin responses on both sides. `cf-cache-status` / `X-Workers-Cache`
observe the caching layer directly; `origin_id` proves when the origin was hit.

## Behavior matrix

| `?case=` | Workers Cache (`/api/*`) | Cloudflare CDN (`cache-compare.*`) | Cache API (`caches.default`) |
|---|---|---|---|
| `explicit` (max-age=120) | **HIT** | **HIT** | **HIT** |
| `expires` | **HIT** | **HIT** | **HIT** |
| `heuristic` (public + LM-30min) | **HIT until ~7,200s (~2h), then EXPIRED** — re-measured; last HIT at age 7,121s, expired at ~7,242s | **HIT until ~7,200s (~2h), then EXPIRED** — same behavior: edge colos last HIT at ages 7,067s / 6,945s | **HIT** (still HIT ≥ 277s) |
| `short` (max-age=20) | **HIT** | **HIT** | — |
| `swr` (max-age=20 + `stale-while-revalidate=120`) | **`UPDATING`** — serves stale, revalidates in background; next request gets the new `origin_id` | **`UPDATING`** — same async-SWR behavior (stale served while revalidating, then HIT) | — |
| `nostore` | BYPASS | BYPASS | never served |
| `private` | BYPASS | BYPASS | never served |
| `set-cookie` | BYPASS | BYPASS | never served (put is a no-op even with overridden `Cache-Control`) |
| `auth-public` (Authorization + `public`) | **HIT** | **HIT** | **HIT** |
| `vary` (`Vary: X-Variant`) | correct per-variant entries (`a`→`a`, `b`→`b`) | **Vary ignored by default** — `b`/`c` requests all HIT the stored `"a"` body; **correct after adding a Vary cache rule** (`x-variant: passthrough`) | — |
| cache scope | **tiered** — a HIT was returned in a colo that never fetched | edge per-colo — each colo missed once before HITting (SEA MISS → SJC MISS → HITs) | **colo/node-local only** — probes in SEA missed entries stored in SJC |

## Differences observed

1. **`Vary` on a custom header: automatic on Workers Cache, opt-in on the
   CDN (by design).** With `Vary: X-Variant`, Workers Cache kept per-variant
   entries and always returned the right body (`a`→`a`, `b`→`b`). The CDN
   ignores `Vary` by default — per the [Cloudflare cache docs](https://developers.cloudflare.com/cache/concepts/cache-control/):
   "Cloudflare does not consider vary values in caching decisions" unless you
   configure the Cache Rules Vary setting, Vary for images, or the header is
   `Accept-Encoding` (and `Vary: *` always bypasses). This is intended spec,
   not a bug — and it is brand new: the Cache Rules Vary setting only shipped
   on 2026-09-22, the day before this measurement
   ([Vary support blog post](https://blog.cloudflare.com/vary-support/)).
   Empirically confirmed both ways: without the setting every
   request variant (`a`, `b`, `c`) HIT the stored `"a"` body; after adding
   `vary.headers.x-variant = passthrough` to the cache rule, the CDN kept
   correct per-variant entries. The real difference is therefore *defaults*:
   Workers Cache follows RFC 9111 out of the box, the CDN needs per-header
   opt-in configuration.

2. **Architecture: tiered vs. local.**
   Workers Cache answered a HIT in a colo that never stored the entry
   (upper-tier tiered cache). On the CDN path each edge colo missed once
   before hitting (no cross-colo HIT observed). `caches.default` is strictly
   colo/node-local — the same URL fetched from SJC and SEA produced
   independent caches, and the SEA entry was even lost between consecutive
   probes. For load that lands in many edge locations, the Cache API behaves
   like N small caches.

3. **The Cache API is a different product.**
   `caches.default` lets the Worker *override* origin directives — serving
   `nostore`/`private` responses with a rewritten `Cache-Control` works —
   but it still refuses `Set-Cookie` bodies regardless of headers, and it is
   not tiered. Workers Cache (`cache.enabled`) is declarative: it front-runs
   the Worker, follows RFC semantics automatically, and also exposes
   `ctx.cache.purge()` — no way to do that on the CDN path from the Worker.

## Same behavior on both paths

- **`heuristic` (no explicit freshness): the same ~7,200s (~2h) TTL.** With
  `Cache-Control: public` + `Last-Modified: now-30min`, *neither* cache applied
  RFC 9111 §4.2.2 heuristic freshness (10% of the LM age ≈ 180s). Both held the
  entry for ≈7,200s (~2h) before re-fetching — Workers Cache: last HIT at age
  7,121s, `EXPIRED` at ~7,242s; CDN edges: last HITs at ages 7,067s (SJC) and
  6,945s (SEA). This matches Cloudflare's per-status default TTL table
  (status 200 → 7,200s), which the [Workers Cache docs](https://developers.cloudflare.com/cache/)
  publish for responses without explicit freshness — the CDN edge TTL default
  is the same value. An earlier measurement that suggested "~200s vs ~16min"
  was eviction / node variance, not TTL expiry.
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
  the ~7,200s heuristic TTL is the platform default on both paths, not a
  misconfiguration.
- `Set-Cookie` suppression on the CDN is expected RFC behavior; including it
  for completeness.
- Heuristic TTL measurement (2026-09-23): Workers Cache entry stored ~06:46:18,
  last HIT at age 7,121s (08:44:59), `EXPIRED` at 08:47:00 → TTL ∈ (7,121,
  7,242]s. CDN edges: SJC stored ~06:46:32, last HIT at age 7,067s,
  `EXPIRED` at 08:50:21 → TTL ∈ (7,067, ~7,189]s; SEA last HIT at age 6,945s,
  `EXPIRED` at 08:54:22. All brackets sit at or just under 7,200s (2h).
