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
| `heuristic`（public + LM-30分） | **HIT、その後 ~200s で失効**（≈ LM経過時間の10%、RFC準拠） | **HIT ≥ 602s**、~16分で失効 — RFCヒューリスティックを大きく超える固定デフォルトTTL | **HIT**（277s 時点でもHIT） |
| `short`（max-age=20） | **HIT** | **HIT** | — |
| `swr`（max-age=20 + `stale-while-revalidate=120`） | **`UPDATING`** — stale を即返却しバックグラウンドで再検証。次のリクエストは新しい `origin_id` | **`UPDATING`** — CDN も async SWR に対応（revalidate 中は stale 返却、その後 HIT） | — |
| `nostore` | BYPASS | BYPASS | 返却なし |
| `private` | BYPASS | BYPASS | 返却なし |
| `set-cookie` | BYPASS | BYPASS | 返却なし（`Cache-Control` 上書きしても put は no-op） |
| `auth-public`（Authorization + `public`） | **HIT** | **HIT** | **HIT** |
| `vary`（`Vary: X-Variant`） | variant ごとに正しいエントリ（`a`→`a`、`b`→`b`） | **Vary 無視** — `b`/`c` リクエストも全て保存済み `"a"` ボディを HIT | — |
| キャッシュスコープ | **tiered** — 未フェッチの colo でも HIT が返る | エッジは colo ごと — 各 colo で1回 MISS してから HIT（SEA MISS → SJC MISS → HIT） | **colo/ノードローカルのみ** — SEA のプローブは SJC に保存されたエントリに MISS |

## 実測で確認できた主な違い

1. **`stale-while-revalidate` は両者で同一挙動。**
   Workers Cache は RFC 5861 を実装：`Cf-Cache-Status: UPDATING` — クライアントは
   stale を即座に受け取り、オリジンはバックグラウンドで再検証され、次のリクエストは
   新しい `origin_id` を受け取ります。CDN も同じ挙動でした。以前の計測で毎回
   `EXPIRED` と観測されたのは、140秒の stale 期間外をプローブしていたためです。
   stale 期間内で再計測すると、CDN は stale の `origin_id` を伴う `UPDATING` を返し、
   その後は再検証済みボディで `HIT` を返しました — Workers Cache と同一のセマンティクスです
   （参照：[2026-02-26 async SWR changelog](https://developers.cloudflare.com/changelog/post/2026-02-26-async-stale-while-revalidate/)）。

2. **ヒューリスティック鮮度は Workers Cache が RFC 準拠、CDN は非準拠。**
   `Cache-Control: public` + `Last-Modified: 現在-30分` は RFC 9111 §4.2.2 では
   ~200s の鮮度（30分の10%）になります。Workers Cache は ~60s で HIT を返し
   ~6分までに再取得 — RFC と整合。CDN は **age 602s でも HIT** を返し、
   ~16分まで再取得しませんでした — ヒューリスティックよりはるかに長い固定の
   デフォルト edge TTL を適用しており、ここではむしろ RFC より*積極的に*
   キャッシュしていることになります。

3. **カスタムヘッダの `Vary` が効くのは Workers Cache のみ。**
   `Vary: X-Variant` に対し、Workers Cache は variant ごとのエントリを保持し
   常に正しいボディ（`a`→`a`、`b`→`b`）を返しました。CDN は**カスタム Vary
   ヘッダを完全に無視**します：`a`・`b`・`c` 全てのリクエストが最初に保存された
   `"a"` ボディを HIT — キャッシュキーが `X-Variant` で分割されていません。

4. **`public` があれば両者とも `Authorization` 必須のリクエストもキャッシュ。**
   RFC 7233 §3.5 で、明示的な `public` は Authorization のデフォルト挙動を
   上書きし、両キャッシュともこれを尊重します。

5. **アーキテクチャ：tiered vs ローカル。**
   Workers Cache は、エントリを一度もフェッチしていない colo でも HIT を返しました
   （上位ティアを持つ tiered cache）。CDN 側は各エッジ colo が HIT 前に1回ずつ
   MISS しました（colo 間の HIT は観測されず）。`caches.default` は厳密に
   colo/ノードローカル — 同一 URL を SJC と SEA でフェッチすると独立した
   キャッシュになり、SEA のエントリは連続プローブの間に失われることもありました。
   多数のエッジロケーションに分散する負荷では、Cache API は N 個の小さな
   キャッシュとして振る舞います。

6. **Cache API は別プロダクト。**
   `caches.default` は Worker 側でオリジンのディレクティブを*上書き*可能 —
   `nostore`/`private` レスポンスに書き換え済み `Cache-Control` を付けて配信
   できます — ただし `Set-Cookie` ボディはヘッダに関わらず拒否され、tiered
   でもありません。Workers Cache（`cache.enabled`）は宣言的で、Worker の前段に
   自動的に入り、RFC セマンティクスに従い、`ctx.cache.purge()` も提供します —
   CDN パスから Worker 内でこれを行う手段はありません。

## 注意点・補足

- Vercel は関数がヘッダを省略すると `Cache-Control: public, max-age=0,
  must-revalidate` を自動付与します。そのため `heuristic`/`expires` ケースは
  `Cache-Control: public` を明示的に送信しています。また全レスポンスに
  `Vercel-CDN-Cache-Control: no-store` を付与し、Vercel 自身のエッジが
  介入しないようにしています。
- CDN パスのキャッシュルール：`http.request.uri.path contains "/api/"` →
  "Eligible for cache"。明示的な edge TTL は未設定 — heuristic の長い TTL は
  設定ミスではなく CDN のデフォルトです。
- CDN における `Set-Cookie` 抑止は期待される RFC 挙動であり、完全性のために
  記載しています。
- 時刻：Workers Cache の heuristic TTL は (60s, ~390s] に bracket — RFC 10%
  （~200s）と整合。CDN は age 602s で HIT、~16分で失効 — デフォルト edge TTL
  は RFC ヒューリスティックの ~3〜5倍。
