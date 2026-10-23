# Worker API 仕様

ベース URL: Access で保護したカスタムドメイン（アプリの既定値は `https://mosaic-check.santasunrise.app`）。
実装: `worker/src/index.ts`。

## 共通

- すべてのエンドポイントは Cloudflare Access の背後にあります。Access を通過したリクエストには
  `Cf-Access-Jwt-Assertion` ヘッダーが付き、Worker はこれを検証します
  （署名 RS256・`aud` = `ACCESS_AUD`・`iss` = `https://<ACCESS_TEAM_DOMAIN>`・`exp`/`nbf`）。
  検証に失敗すると `401 {"error":"unauthorized"}`。
- アプリからの呼び出しは `cf-access-token: <Access アプリケーショントークン>` ヘッダーで認証します。
  トークンが無効・期限切れの場合、Access が Worker に届く前にログインページへの `302` または
  `401/403` を返します。アプリはこれらを `AUTH_REQUIRED` として扱い、再ログインを促します。
- 応答は `application/json; charset=utf-8`、`Cache-Control: no-store`。
- Worker は画像・トークンを保存・ログ出力しません。

## GET /auth/desktop

デスクトップアプリへのトークン受け渡し。アプリが既定のブラウザで開きます。

| クエリ  | 必須 | 内容                                                         |
| ------- | ---- | ------------------------------------------------------------ |
| `port`  | ○    | アプリが待ち受けるループバックのポート（1024〜65535 の整数） |
| `state` | ○    | アプリが生成した乱数（`[A-Za-z0-9_-]{16,128}`）              |

- 成功: `302 Found`、`Location: http://127.0.0.1:<port>/callback?state=<state>&token=<JWT>`、
  `Referrer-Policy: no-referrer`。
- 失敗: `400 {"error":"invalid port or state"}`。

## GET /v1/me

ログイン確認用。

```json
{ "email": "editor@example.com", "exp": 1893456000 }
```

## POST /v1/detect

フレーム（静止画）の未モザイク箇所を判定します。呼び出し先の Jev は `JEV_BACKEND` で決まります。アプリは 1 リクエスト 1 フレームで送ります。

### リクエスト

```json
{
  "frames": [{ "id": "3", "mime": "image/jpeg", "data": "<base64>" }]
}
```

| フィールド      | 制約                                                                          |
| --------------- | ----------------------------------------------------------------------------- |
| `frames`        | 1〜10 件                                                                      |
| `frames[].id`   | `[A-Za-z0-9_-]{1,16}`。アプリは動画内のフレーム番号（0〜9）を使う             |
| `frames[].mime` | `image/jpeg` または `image/png`                                               |
| `frames[].data` | 標準 base64（パディング可）、最大 4,000,000 文字。アプリは長辺 1024px の JPEG |

検証に失敗すると `400 {"error":"..."}`。

### Jev への入力（1 フレームごと）

`typesafe-api`（既定）は `POST https://api.typesafe.ai/v1/systemone` に次を送ります。
`Authorization: Bearer <TYPESAFE_API_KEY>` と `TypeSafe-Danger-Zone-Images: true` ヘッダーを付けます。

```js
{
  model: "jev-1.14.0", // JEV_MODEL
  state: { frame: "img-frame-3" },
  assets: {
    "img-frame-3": { type: "image", format: "jpg", data_base64: "<base64>" },
  },
  questions: {
    genitals_present: { type: "noul", instructions: "This is a frame from an adult video. Are uncensored genitals ..." },
    genitals_box: { type: "box", instructions: "the uncensored genitals (penis or vulva) in `frame` that ..." },
  },
}
```

`workers-ai` は同じ内容（`model` を除く、`format` は `jpeg`）を `env.AI.run(JEV_MODEL, input, { extraHeaders })` に渡します。
どちらも `{ answers, usage }` を返し、以降の処理は共通です。

### レスポンス

```json
{
  "model": "jev-1.14.0",
  "backend": "typesafe-api",
  "frames": [
    {
      "id": "3",
      "detections": [
        {
          "label": "性器",
          "score": 0.93,
          "box": [0.49, 0.11, 0.83, 0.51],
          "located": true,
          "boxConfidence": 0.94
        }
      ]
    }
  ],
  "usage": { "inputTokens": 756 }
}
```

| フィールド                   | 内容                                                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detections`                 | `noul` 確率が `JEV_THRESHOLD`（既定 0.5）以上のカテゴリ。空なら検出なし                                                                                                |
| `detections[].score`         | `noul` の確率（0〜1）                                                                                                                                                  |
| `detections[].box`           | 正規化座標 `[x0, y0, x1, y1]`（左上原点）。選択範囲の JSON と同じ座標系                                                                                                |
| `detections[].located`       | `false` は、モデルが使える枠を返さず `box` が画面全体の代わり。モザイク候補には使わない                                                                                |
| `detections[].boxConfidence` | `box` 回答の confidence（ある場合）                                                                                                                                    |
| `frames[].error`             | モデル呼び出し失敗時に `"model error"`（TypeSafe API の失敗は `"model error (TypeSafe API HTTP 429)"` のようにステータスだけ付く）。アプリはそのフレームを判定不能扱い |
| `usage.inputTokens`          | Jev が返した入力トークンの合計。費用の実測に使う                                                                                                                       |
| `backend`                    | 実際に使った呼び出し先                                                                                                                                                 |

## 環境変数（`worker/wrangler.toml` の `[vars]` とシークレット）

| 名前                 | 例                               | 内容                                                                                      |
| -------------------- | -------------------------------- | ----------------------------------------------------------------------------------------- |
| `ACCESS_TEAM_DOMAIN` | `your-team.cloudflareaccess.com` | Zero Trust のチームドメイン                                                               |
| `ACCESS_AUD`         | 64 桁の16進                      | Access アプリの Application Audience (AUD) タグ                                           |
| `JEV_BACKEND`        | `typesafe-api`                   | `typesafe-api`（既定）または `workers-ai`。未知の値は 500                                 |
| `JEV_MODEL`          | `jev-1.14.0`                     | typesafe-api は `jev-1.14.0` / `jev-1.13.0`、workers-ai は `typesafe/jev-1.14.0`          |
| `JEV_THRESHOLD`      | `0.5`                            | 検出として返す `noul` 確率の下限（アプリは 0.8 以上を NG、それ未満を要確認と扱う）        |
| `JEV_IMAGE_HEADER`   | `true`                           | workers-ai のみ。`false` で画像用ヘッダーを付けない                                       |
| `TYPESAFE_API_URL`   | （未設定）                       | 任意。既定は `https://api.typesafe.ai/v1/systemone`                                       |
| `TYPESAFE_API_KEY`   | **シークレット**                 | typesafe-api の API キー。`wrangler secret put` か Cloudflare API の `secret_text` で登録 |

`TYPESAFE_API_KEY` 以外は秘密情報ではありません（AUD タグは JWT 検証用の公開値）。
キー未設定の typesafe-api は、各フレームを「エラー」にします（OK にはしません）。
バインディング `AI`（Workers AI）は workers-ai バックエンドのときだけ使います。Cron Trigger はありません。

### workers-ai に切り替えるとき

チームの許可が出たら、コード変更なしで、`JEV_BACKEND = "workers-ai"` と `JEV_MODEL = "typesafe/jev-1.14.0"` に変更します。
Workers AI 経由の画像入力・`box`・無料枠の適用は未検証です（[open-issues.md](open-issues.md)）。
