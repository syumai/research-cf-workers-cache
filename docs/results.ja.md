# 計測結果（2026-09-23、時刻はすべて UTC）

[English](results.md) | **日本語**

両側とも同一のオリジンレスポンスを使用。`cf-cache-status` / `X-Workers-Cache`
でキャッシュレイヤを直接観測し、`origin_id` でオリジンが実際にヒットした
タイミングを確認しています。

## 挙動マトリクス

| `?case=` | Workers Cache（`/api/*`） | Cloudflare CDN（`cache-compare.*`） | Cache API（`caches.default`） |
|---|---|---|---|
| `explicit`（max-age=120） | **HIT** | **HIT** | **HIT** |
| `expires` | **HIT** | **HIT** | **HIT** |
| `heuristic`（public + LM-30分） | **~7,200s（約2時間）まで HIT、その後 EXPIRED** — 再計測：age 7,121s で最終 HIT、~7,242s で失効 | **~7,200s（約2時間）まで HIT、その後 EXPIRED** — 同一挙動：各 colo で最終 HIT は age 7,067s / 6,945s | **HIT**（277s 時点でもHIT） |
| `short`（max-age=20） | **HIT** | **HIT** | — |
| `swr`（max-age=20 + `stale-while-revalidate=120`） | **`UPDATING`** — stale を即返却しバックグラウンドで再検証。次のリクエストは新しい `origin_id` | **`UPDATING`** — CDN も同じ async SWR 挙動（revalidate 中は stale 返却、その後 HIT） | — |
| `nostore` | BYPASS | BYPASS | 返却なし |
| `private` | BYPASS | BYPASS | 返却なし |
| `set-cookie` | BYPASS | BYPASS | 返却なし（`Cache-Control` 上書きしても put は no-op） |
| `auth-public`（Authorization + `public`） | **HIT** | **HIT** | **HIT** |
| `vary`（`Vary: X-Variant`） | variant ごとに正しいエントリ（`a`→`a`、`b`→`b`） | **デフォルトでは Vary 無視** — `b`/`c` リクエストも全て `"a"` ボディを HIT。**Vary キャッシュルール追加後は正常**（`x-variant: passthrough`） | — |
| キャッシュスコープ | **tiered** — 未フェッチの colo でも HIT が返る | エッジは colo ごと — 各 colo で1回 MISS してから HIT（SEA MISS → SJC MISS → HIT） | **colo/ノードローカルのみ** — SEA のプローブは SJC に保存されたエントリに MISS |

## 確認できた違い

1. **カスタムヘッダの `Vary`：Workers Cache は自動、CDN は opt-in（仕様通り）。**
   `Vary: X-Variant` に対し、Workers Cache は variant ごとのエントリを保持し
   常に正しいボディ（`a`→`a`、`b`→`b`）を返しました。CDN はデフォルトでは
   `Vary` を無視します — [Cloudflare の cache ドキュメント](https://developers.cloudflare.com/cache/concepts/cache-control/)
   によれば、Cache Rules の Vary 設定・Vary for images・`Accept-Encoding`
   のいずれでもない限り「Cloudflare does not consider vary values in caching
   decisions」であり、これは意図された仕様です（`Vary: *` は常に BYPASS）。
   なお Cache Rules の Vary 設定は 2026-09-22（本計測の前日）に
   リリースされたばかりの新機能です
   （[Vary サポートのブログ](https://blog.cloudflare.com/vary-support/)）。
   実測でも両方向を確認：設定なしでは全variant（`a`・`b`・`c`）が保存済みの
   `"a"` ボディを HIT、キャッシュルールに `vary.headers.x-variant =
   passthrough` を追加後は variant ごとに正しいエントリを保持しました。
   つまり本質的な違いは*デフォルト*であり、Workers Cache は RFC 9111 に
   標準準拠するのに対し、CDN はヘッダ単位の opt-in 設定が必要です。

2. **アーキテクチャ：tiered vs ローカル。**
   Workers Cache は、エントリを一度もフェッチしていない colo でも HIT を返しました
   （上位ティアを持つ tiered cache）。CDN 側は各エッジ colo が HIT 前に1回ずつ
   MISS しました（colo 間の HIT は観測されず）。`caches.default` は厳密に
   colo/ノードローカル — 同一 URL を SJC と SEA でフェッチすると独立した
   キャッシュになり、SEA のエントリは連続プローブの間に失われることもありました。
   多数のエッジロケーションに分散する負荷では、Cache API は N 個の小さな
   キャッシュとして振る舞います。

3. **Cache API は別プロダクト。**
   `caches.default` は Worker 側でオリジンのディレクティブを*上書き*可能 —
   `nostore`/`private` レスポンスに書き換え済み `Cache-Control` を付けて配信
   できます — ただし `Set-Cookie` ボディはヘッダに関わらず拒否され、tiered
   でもありません。Workers Cache（`cache.enabled`）は宣言的で、Worker の前段に
   自動的に入り、RFC セマンティクスに従い、`ctx.cache.purge()` も提供します —
   CDN パスから Worker 内でこれを行う手段はありません。

## 両パスで同じだった挙動

- **`heuristic`（明示的鮮度なし）：同一の ~7,200s（約2時間）TTL。**
  `Cache-Control: public` + `Last-Modified: 現在-30分` に対し、*どちらの*
  キャッシュも RFC 9111 §4.2.2 のヒューリスティック鮮度（LM経過時間の10% ≈
  180s）を適用せず、どちらも ≈7,200s（約2時間）保持してから再取得しました
  — Workers Cache：age 7,121s で最終 HIT、~7,242s で `EXPIRED`。CDN エッジ：
  最終 HIT は age 7,067s（SJC）/ 6,945s（SEA）。これは明示的な鮮度
  ディレクティブがないレスポンスに対して Workers Cache のドキュメントが
  公開しているステータス別デフォルトTTL表（status 200 → 7,200s）と一致し、
  CDN のデフォルト edge TTL も同じ値です。以前の計測で示した「~200s vs
  ~16分」は TTL 失効ではなく eviction / ノード差の誤認でした。
- **`stale-while-revalidate`：同一のセマンティクス。** Workers Cache は RFC 5861
  を実装（`Cf-Cache-Status: UPDATING` — stale を即返却しバックグラウンドで再検証、
  次のリクエストは新しい `origin_id`）し、CDN も同じ挙動を示しました：140秒の
  stale 期間内で再計測すると、stale の `origin_id` を伴う `UPDATING` を返し、
  その後は再検証済みボディで `HIT` を返しました
  （参照：[2026-02-26 async SWR changelog](https://developers.cloudflare.com/changelog/post/2026-02-26-async-stale-while-revalidate/)）。
  以前の計測で毎回 `EXPIRED` と観測されたのは、stale 期間外をプローブしていた
  ための誤認でした。
- **`explicit` / `expires` / `short`：両者とも HIT** — 通常の TTL 駆動の
  キャッシュは同じ挙動です。
- **`nostore` / `private` / `set-cookie`：両者とも BYPASS** — キャッシュ不可
  ディレクティブは同じように尊重されます。
- **`auth-public`：両者とも HIT** — RFC 7233 §3.5 で、明示的な `public` は
  Authorization のデフォルト挙動を上書きし、両キャッシュともこれを尊重します。

## 注意点・補足

- Vercel は関数がヘッダを省略すると `Cache-Control: public, max-age=0,
  must-revalidate` を自動付与します。そのため `heuristic`/`expires` ケースは
  `Cache-Control: public` を明示的に送信しています。また全レスポンスに
  `Vercel-CDN-Cache-Control: no-store` を付与し、Vercel 自身のエッジが
  介入しないようにしています。
- CDN パスのキャッシュルール：`http.host eq "cache-compare.syumai.dev"` →
  `set_cache_settings`（`cache: true` で eligible。後に `vary.headers.
  x-variant = passthrough` を追加）。明示的な edge TTL は未設定 —
  ~7,200s の heuristic TTL は設定ミスではなく両パス共通のプラットフォーム
  デフォルトです。
- CDN における `Set-Cookie` 抑止は期待される RFC 挙動であり、完全性のために
  記載しています。
- heuristic TTL の計測（2026-09-23）：Workers Cache は ~06:46:18 に保存、
  age 7,121s（08:44:59）で最終 HIT、08:47:00 に `EXPIRED` → TTL ∈ (7,121,
  7,242]s。CDN エッジ：SJC は ~06:46:32 に保存、age 7,067s で最終 HIT、
  08:50:21 に `EXPIRED` → TTL ∈ (7,067, ~7,189]s。SEA は age 6,945s で最終
  HIT、08:54:22 に `EXPIRED`。いずれの bracket も 7,200s（2時間）に一致
  または直前まで到達しています。
