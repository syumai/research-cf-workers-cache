# research-cf-workers-cache

**English** | [日本語](README.ja.md)

Comparison of **Cloudflare Workers Cache** (`[cache] enabled = true`, [blog post](https://blog.cloudflare.com/workers-cache/)) against a **traditional proxy cache** (Cloudflare CDN in front of a Vercel origin), plus the legacy **`caches.default` Cache API** for reference.

## Architecture

| Path | URL | Caching layer |
|------|-----|---------------|
| Workers Cache | `https://study-cf-workers-cache.syumai.workers.dev/api/*` | `[cache] enabled` tiered cache in front of the Worker |
| Cache API | `https://study-cf-workers-cache.syumai.workers.dev/cache-api/api/*` | `caches.default.match/put` inside the Worker (colo-local) |
| Cache override | `https://study-cf-workers-cache.syumai.workers.dev/cache-override/api/*` | Cache API, but `Cache-Control` replaced with `public, max-age=120` |
| Passthrough | `https://study-cf-workers-cache.syumai.workers.dev/passthrough/api/*` | none (baseline) |
| CDN proxy | `https://cache-compare.syumai.dev/api/*` | Cloudflare CDN + "eligible for cache" Cache Rule → Vercel origin |

The Vercel serverless function `vercel/api/respond.js` and `respond(request)` inside
`worker/src/index.js` return **identical responses** for the same `?case=` parameter,
so behavior differences come from the caching layer, not the origin.

## Response cases

| `?case=` | Response headers | What it exercises |
|----------|------------------|-------------------|
| `explicit` | `Cache-Control: public, max-age=120` | Normal explicit TTL |
| `expires` | `Cache-Control: public` + `Expires` (+2min) | HTTP/1.0 fallback |
| `heuristic` | `Cache-Control: public` + `Last-Modified` (now-30min) | RFC 9111 §4.2.2 heuristic freshness (≈3min) |
| `short` | `Cache-Control: public, max-age=20` | Short but normal TTL |
| `swr` | `Cache-Control: public, max-age=20, stale-while-revalidate=120` | RFC 5861 stale-while-revalidate |
| `vary` | `public, max-age=120` + `Vary: X-Variant` | Custom-header Vary |
| `nostore` | `Cache-Control: no-store` | Never cacheable |
| `private` | `Cache-Control: private, max-age=120` | Shared caches must not store |
| `set-cookie` | `public, max-age=120` + `Set-Cookie` | Cookies suppress caching |
| `auth-public` | requires `Authorization` req header → `public, max-age=120` | Authenticated but explicitly public |

Every response carries a unique `X-Origin-Id` and `origin_time`, so you can tell
exactly when the origin was actually hit.

## Reproducing

```bash
# Worker (workers.dev) — needs a Cloudflare API token with Workers Edit
cd worker && npx wrangler deploy

# Vercel origin — needs VERCEL_TOKEN
cd vercel && npx vercel deploy --prod --token $VERCEL_TOKEN

# CDN path — a Cloudflare zone with:
#   * CNAME cache-compare.<zone> → cname.vercel-dns.com (orange cloud)
#   * zone SSL mode = strict (Vercel redirects HTTP→HTTPS otherwise)
#   * a Cache Rule "eligible for cache" for the hostname

# Probe matrix
./scripts/verify.sh
```

`verify.sh` prints a hit matrix across all five paths for each case.
A HIT or UPDATING counts as served-from-cache.

## Results

See [docs/results.md](docs/results.md) ([日本語](docs/results.ja.md)) for the measured behavior matrix.
