# AIモザイク漏れ判定 設計書

Mosaic Box Editor（Tauri デスクトップアプリ）に、Cloudflare Access でのログインと、
Workers AI の Jev モデルによるモザイク漏れ判定を追加する設計です。

| 文書                             | 内容                                       |
| -------------------------------- | ------------------------------------------ |
| この文書                         | 構成図、認証フロー、判定仕様、方式選定理由 |
| [api.md](api.md)                 | Worker API 仕様                            |
| [deploy.md](deploy.md)           | デプロイ手順書（実行は承認後）             |
| [estimate.md](estimate.md)       | 無料枠で1日に判定できる枚数の見積もり      |
| [open-issues.md](open-issues.md) | 未決事項                                   |

## 構成図

```mermaid
flowchart LR
  subgraph PC["利用者のWindows PC"]
    UI["WebView UI<br/>src/check-ui.ts"]
    Core["Rust (Tauri)<br/>auth.rs / check.rs"]
    FF["同梱 ffmpeg / ffprobe"]
    Browser["既定のブラウザ"]
    Folder[("開いたフォルダ<br/>画像・動画・boxes/・mosaic/")]
    UI -- invoke --> Core
    Core -- フレーム抽出 --> FF
    FF -- 読み取り --> Folder
    Core -- 起動 --> Browser
    Browser -- "302 → 127.0.0.1:port/callback" --> Core
  end
  subgraph CF["Cloudflare"]
    Access["Cloudflare Access<br/>self-hosted アプリ"]
    IdP["IdP<br/>(Google Workspace / OTP 等)"]
    Worker["Worker: mosaic-check<br/>worker/src/index.ts"]
    AI["Workers AI<br/>typesafe/jev-1.14.0"]
    Access -- 認証済みのみ通す --> Worker
    Access <--> IdP
    Worker -- "env.AI.run (assets=base64)" --> AI
  end
  Browser -- "/auth/desktop" --> Access
  Core -- "HTTPS + cf-access-token" --> Access
```

- 画像・フレームは Rust 側で JPEG（長辺 1024px 以下）に変換し、base64 で Worker に送ります。
  Worker は保存せず、Workers AI へそのまま渡します。
- Access のトークンは Rust プロセスのメモリだけに保持し、WebView（JS）には渡しません。
  JS が受け取るのはメールアドレスと有効期限だけです。
- Worker は Cron Trigger を持ちません（`wrangler.toml` に `[triggers]` なし）。
- Worker は Access 経由でしか到達できないよう `workers_dev = false` / `preview_urls = false` とし、
  さらに Worker 自身も `Cf-Access-Jwt-Assertion` を検証します（多層防御）。

## 認証フロー

```mermaid
sequenceDiagram
  autonumber
  participant App as アプリ (Rust)
  participant B as 既定のブラウザ
  participant A as Cloudflare Access
  participant W as Worker
  App->>App: 127.0.0.1 の空きポートで待受、state(24byte乱数)生成
  App->>B: https://API/auth/desktop?port=P&state=S を開く
  B->>A: GET /auth/desktop
  A->>B: IdP ログイン（既存セッションがあれば省略）
  B->>A: 認証完了
  A->>W: GET /auth/desktop + Cf-Access-Jwt-Assertion
  W->>W: JWT 署名・aud・iss・exp を検証、port/state を検証
  W->>B: 302 http://127.0.0.1:P/callback?state=S&token=JWT
  B->>App: GET /callback?state=S&token=JWT
  App->>App: state 一致を確認、トークンをメモリに保持
  App->>B: 「ログインしました。このタブを閉じてください」
  Note over App,W: 以後の判定
  App->>A: POST /v1/detect (cf-access-token: JWT)
  A->>W: 転送 + Cf-Access-Jwt-Assertion
  W-->>App: 判定結果 JSON
  Note over App,A: 期限切れ時は Access が 302 → アプリは AUTH_REQUIRED として再ログインを促す
```

### 方式の比較と選定理由

| 方式                                                       | 評価 | 理由                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. 既定ブラウザ + ループバック受け取り（採用）**         | ◎    | RFC 8252（ネイティブアプリの OAuth）推奨の「外部ユーザーエージェント」方式。ブラウザの既存 IdP セッション・パスワードマネージャー・パスキーがそのまま使える。追加の実行ファイル不要。Worker の小さな受け渡しエンドポイントだけで済む。 |
| B. アプリ内 WebView でログインし Cookie を読む             | △    | Google などの IdP は埋め込み WebView でのログインを拒否することがある（`disallowed_useragent`）。HttpOnly の `CF_Authorization` Cookie 取得に Tauri の Cookie API が必要で、バージョン依存が強い。                                     |
| C. `cloudflared access login` を同梱して呼ぶ               | △    | 公式手順で確実だが、約 50MB の実行ファイル追加と配布ライセンス管理が必要。トークン受け渡しの内部仕様は非公開。                                                                                                                         |
| D. サービストークン（Client ID / Secret）を exe に埋め込む | ✕    | 利用者ごとの識別ができず、秘密情報を配布物に含めることになる。                                                                                                                                                                         |
| E. Access Managed OAuth（2026-03 提供開始）                | ○    | 認可コードフロー + 127.0.0.1 リダイレクトに対応した正攻法。ただし RFC 8707 対応のクライアント実装・動的クライアント登録が必要で、PKCE の扱いがドキュメントで未確認。将来の移行先候補（[未決事項](open-issues.md)）。                   |

採用方式 A の注意点と対策:

- トークンが URL クエリでループバックに渡るため、ブラウザ履歴に残ります。宛先は `127.0.0.1` のみで
  外部へは送られませんが、Access のアプリケーションセッション時間を短め（例: 8〜24時間）にして影響を抑えます。
- `/auth/desktop` は `port`（1024〜65535）と `state`（16〜128文字の URL-safe 文字）を検証し、
  リダイレクト先は `http://127.0.0.1:<port>/callback` に固定です（オープンリダイレクトにしない）。
- アプリは `state` 不一致の応答を拒否し、5分でタイムアウトします。
- トークンは判定 API の URL（ログイン時に指定したオリジン）にのみ送信します。HTTPS 以外は
  `localhost` / `127.0.0.1`（`wrangler dev` 用）だけ許可します。

## 判定仕様

既存の `mosaic_check.py` の基準を踏襲します（同スクリプトはリポジトリ内・作業環境内に見つからなかったため、
依頼文の基準を仕様として実装しています。[未決事項](open-issues.md) 参照）。

- **動画**: ffprobe で長さを取得し、均等に分けた 10 区間の中央時刻（`(i + 0.5) × 長さ / 10`）から
  1 フレームずつ、計 10 フレームを抽出します。**1 フレームでも検出があればファイル全体が NG** です。
- **画像**: 1 枚を判定し、検出があれば NG です（JPG / PNG / WebP / BMP）。
- 検出なしでも、判定できなかったフレームが 1 つでもあれば **エラー**（OK とは扱わない）。
- 対象は「元の画像・動画」（開いたフォルダ、`boxes/` `mosaic/` を除く）か「書き出し済み（`mosaic/`）」を選べます。
  書き出し済みの判定が、納品物の最終チェックに相当します。
- 1 リクエスト 1 フレームで送信します（Workers Free の CPU 10ms 制限対策、失敗フレームの個別記録）。

### Jev への問い合わせ

Jev は「`state` に対する型付きの質問」に答えるモデルです。1 フレームにつき次の 2 問を 1 回の
`env.AI.run` で尋ねます（`worker/src/jev.ts`）。

| 質問               | type   | 用途                                                                 |
| ------------------ | ------ | -------------------------------------------------------------------- |
| `genitals_present` | `noul` | 修正されていない性器・肛門が見えるか（確率）。しきい値以上で検出扱い |
| `genitals_box`     | `box`  | その位置（top / bottom / left / right、0〜1）                        |

- 画像は `assets` に `{ type: "image", format: "jpeg", data_base64 }` で渡し、`state: { frame: "frame-<id>" }` から参照します。
- 画像入力・`box` は jev-1.14 の実験的機能で、`TypeSafe-Danger-Zone-Images: true` ヘッダーが必要です。
  Worker は `env.AI.run` の `extraHeaders` で付与します（Workers AI バインディングで有効かは要検証）。
- `box` 質問は 1 問につき 1 つの枠しか返さないため、**1 フレーム・1 カテゴリにつき最大 1 箇所**です。
- 「検出あり」なのに枠が壊れている場合は画面全体 `[0,0,1,1]` を枠とし、NG を OK にしない側に倒します。

### 結果表示と編集画面への連携

- ファイルごとに OK / NG / エラー、NG フレーム数、検出（ラベル・確率・時刻）を一覧表示します。
- **未モザイク疑い**: 検出枠のうち、保存済みの選択範囲（`boxes/*.json`）で 90% 以上覆われていないもの。
  覆われているものは「範囲指定済み」と表示します（判定の OK/NG 自体は変えません）。
- 「編集画面で表示」で該当動画を開き、検出フレームの時刻へシークして、
  検出枠を重ねて描画します（赤い点線 = 未モザイク疑い、白い実線 = 範囲指定済み）。
- 動画ライブラリの各行に `AI OK` / `AI NG` / `AI エラー` バッジを表示します。
- 画像は既存の編集画面（動画専用）で開けないため、判定ダイアログ内に枠付きプレビューを表示します。
- 判定結果はセッション中のみ保持し、フォルダを開き直すと消えます。

## 実装の所在

| 場所                     | 担当                                                           |
| ------------------------ | -------------------------------------------------------------- |
| `src-tauri/src/auth.rs`  | ループバック受け取り、state 検証、表示用クレーム読み取り       |
| `src-tauri/src/check.rs` | 判定対象の列挙、フレーム抽出、Worker 呼び出し、OK/NG 判定      |
| `src-tauri/src/main.rs`  | Tauri コマンド、トークンのメモリ保持                           |
| `src/check.ts`           | 保存済み範囲との重なり計算、集計、並べ替え                     |
| `src/check-ui.ts`        | 判定ダイアログ、ログイン、順次実行・中止、結果表示             |
| `src/renderer.ts`        | 編集画面での検出枠の描画                                       |
| `worker/src/index.ts`    | ルーティング、デスクトップ受け渡し、入力検証                   |
| `worker/src/access.ts`   | Access JWT の検証（JWKS 取得・キャッシュ、RS256、aud/iss/exp） |
| `worker/src/jev.ts`      | Jev 入力の組み立てと回答の正規化                               |

## テスト

- Rust: 10 フレームの時刻、1 フレームでも検出で NG、対象列挙、URL 制限、コールバック検証、
  JWT 表示クレーム、実 ffmpeg + ダミー Worker による結合テスト（`--include-ignored`）。
- Node: 範囲との重なり（矩形・投げ縄・ブラシ・消去）、集計、検出枠の描画、
  Worker の JWT 検証（実 RSA 署名）、受け渡しリダイレクト、Jev 入出力変換、入力検証。
- 実機の Cloudflare（Access / Workers AI）とは未接続です。[deploy.md](deploy.md) のスモークテストで確認します。
