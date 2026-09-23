---
marp: true
theme: default
paginate: true
title: Cloudflare Workers Cache vs Proxy Cache
---

# Cloudflare Workers Cache vs 従来の Proxy Cache

キャッシュポリシーの違いを実環境で検証した

- 背景: [Workers Cache blog](https://blog.cloudflare.com/workers-cache/) —
  「単純にRFCに従って積極的にキャッシュする」主張を実測で確認
- 目的: Workers Cache と Cloudflare CDN（従来型プロキシキャッシュ）で
  同一レスポンスの挙動を比較
- 参考: 従来の `caches.default`（Cache API）も併測

---

# 検証構成

| パス | キャッシュレイヤ |
|------|---------------|
| Worker `/api/*` | `[cache] enabled` の tiered cache |
| Worker `/cache-api/*` | `caches.default`（coloローカル） |
| Worker `/passthrough/*` | なし（ベースライン） |
| `cache-compare.syumai.dev` | CDN + "eligible for cache" → Vercel |

- Vercel関数とWorkerが**同一レスポンス**を返す（`?case=` 別）
- レスポンスに一意の `X-Origin-Id` を付与 → オリジン到達を正確に判定
- `cf-cache-status` / `X-Workers-Cache` で各レイヤを直接観測

---

# 検証ケース（レスポンスバリエーション）

- `explicit` / `short` / `expires`: 通常の明示TTL
- `heuristic`: `public` + `Last-Modified` のみ → RFC 9111 §4.2.2
- `swr`: `stale-while-revalidate=120`（RFC 5861）
- `vary`: `Vary: X-Variant`（カスタムヘッダ）
- `nostore` / `private` / `set-cookie`: キャッシュ不可系
- `auth-public`: `Authorization` 必須 + `public`

---

# わかったこと①：ヒューリスティック鮮度

`Cache-Control: public` + `Last-Modified: 現在-30分`（RFC鮮度 ≈200s）

| レイヤ | 実測 |
|---|---|
| Workers Cache | ~60s HIT → ~6分以内に失効（**RFC準拠**） |
| CDN | **age 602sでもHIT**、~16分で失効（固定デフォルトTTL） |

→ CDNの方がむしろRFCより**積極的に長く保持**

---

# わかったこと②：Vary（最も実質的な差）

`Vary: X-Variant` に対して

| レイヤ | 実測 |
|---|---|
| Workers Cache | variant ごとに正しく分離（`a`→`a`, `b`→`b`） |
| CDN（デフォルト） | **Varyを完全無視** — `b`/`c`要求にも`a`ボディを誤配信 |
| CDN（Varyルール追加後） | `x-variant: passthrough` で正しく分離 |

→ 差はバグではなく**仕様**。Cache Rules の Vary 機能は
[2026-09-22 リリースの新機能](https://blog.cloudflare.com/vary-support/)（計測前日！）

---

# わかったこと③：キャッシュスコープ

| レイヤ | 実測 |
|---|---|
| Workers Cache | **tiered** — 未保存のcoloからもHIT |
| CDN | エッジはcoloごと（各coloで1回MISSしてからHIT） |
| `caches.default` | **厳密にcolo/ノードローカル** — SJCで保存→SEAはMISS |

→ 複数ロケーションに分散する負荷では、Cache APIは
「N個の小さなキャッシュ」として振る舞う

---

# わかったこと④：同じだった挙動

- **SWR（`stale-while-revalidate`）**: 両者とも `UPDATING` —
  staleを即返却しバックグラウンドで再検証 → 次回 `HIT`
  （CDN側は [2026-02 からasync SWR対応](https://developers.cloudflare.com/changelog/post/2026-02-26-async-stale-while-revalidate/)）
- `explicit` / `expires` / `short`: 両者とも HIT
- `nostore` / `private` / `set-cookie`: 両者とも BYPASS
- **`auth-public`**: 両者とも Authorization必須でも `public` があれば HIT
  （RFC 7233 §3.5。従来型が保守的という直感と逆方向）

---

# まとめ

- Workers Cache は**RFCに忠実なキャッシュ**（heuristic TTL・Vary が自動）
- CDNは**デフォルトが独自**：heuristicはRFCより長く保持、Varyはopt-in
- SWR・認証publicなどの基本挙動は**両者同一**
- Cache API（`caches.default`）は別物：ヘッダ上書き可能だがcoloローカル
- 検証コード・全データ: https://github.com/syumai/research-cf-workers-cache
