# study-cf-workers-cache

[English](README.md) | **日本語**

**Cloudflare Workers Cache**（`[cache] enabled = true`、[ブログ記事](https://blog.cloudflare.com/workers-cache/)）と、**従来のプロキシキャッシュ**（Vercel オリジン前段の Cloudflare CDN）の比較検証。参考として従来の **`caches.default` Cache API** も併記しています。

## 構成

| パス | URL | キャッシュレイヤ |
|------|-----|---------------|
| Workers Cache | `https://study-cf-workers-cache.syumai.workers.dev/api/*` | `[cache] enabled` のtiered cache（Worker の前段） |
| Cache API | `https://study-cf-workers-cache.syumai.workers.dev/cache-api/api/*` | Worker 内の `caches.default.match/put`（colo ローカル） |
| Cache override | `https://study-cf-workers-cache.syumai.workers.dev/cache-override/api/*` | Cache API（`Cache-Control` を `public, max-age=120` に書き換え） |
| Passthrough | `https://study-cf-workers-cache.syumai.workers.dev/passthrough/api/*` | なし（ベースライン） |
| CDN proxy | `https://cache-compare.syumai.dev/api/*` | Cloudflare CDN + "eligible for cache" キャッシュルール → Vercel オリジン |

Vercel のサーバーレス関数 `vercel/api/respond.js` と `worker/src/index.js` 内の
`respond(request)` は、同じ `?case=` パラメータに対して**完全に同じレスポンス**を返します。
そのため挙動の違いはオリジンではなくキャッシュレイヤに起因します。

## レスポンスケース

| `?case=` | レスポンスヘッダ | 検証内容 |
|----------|------------------|-------------------|
| `explicit` | `Cache-Control: public, max-age=120` | 通常の明示的 TTL |
| `expires` | `Cache-Control: public` + `Expires`（+2分） | HTTP/1.0 フォールバック |
| `heuristic` | `Cache-Control: public` + `Last-Modified`（現在-30分） | RFC 9111 §4.2.2 ヒューリスティック鮮度（≈3分） |
| `short` | `Cache-Control: public, max-age=20` | 短いが通常の TTL |
| `swr` | `Cache-Control: public, max-age=20, stale-while-revalidate=120` | RFC 5861 stale-while-revalidate |
| `vary` | `public, max-age=120` + `Vary: X-Variant` | カスタムヘッダによる Vary |
| `nostore` | `Cache-Control: no-store` | キャッシュ不可 |
| `private` | `Cache-Control: private, max-age=120` | 共有キャッシュは保存不可 |
| `set-cookie` | `public, max-age=120` + `Set-Cookie` | Cookie によるキャッシュ抑止 |
| `auth-public` | `Authorization` リクエストヘッダ必須 → `public, max-age=120` | 認証付きだが明示的に public |

全レスポンスに一意の `X-Origin-Id` と `origin_time` が付くため、
実際にオリジンがヒットしたタイミングを正確に判定できます。

## 再現手順

```bash
# Worker (workers.dev) — Workers Edit 権限を持つ Cloudflare API トークンが必要
cd worker && npx wrangler deploy

# Vercel オリジン — VERCEL_TOKEN が必要
cd vercel && npx vercel deploy --prod --token $VERCEL_TOKEN

# CDN パス — 以下の設定を持つ Cloudflare ゾーン:
#   * CNAME cache-compare.<zone> → cname.vercel-dns.com（オレンジクラウド）
#   * ゾーン SSL モード = strict（でなければ Vercel が HTTP→HTTPS リダイレクト）
#   * 該当ホスト名への "eligible for cache" キャッシュルール

# プローブマトリクス
./scripts/verify.sh
```

`verify.sh` は各ケースについて5つのパス横断のヒットマトリクスを出力します。
HIT または UPDATING を「キャッシュから配信」としてカウントします。

## 結果

計測済みの挙動マトリクスは [docs/results.md](docs/results.md)
（[日本語版](docs/results.ja.md)）を参照してください。
