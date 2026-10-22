# Worker API 仕様

ベース URL: Access で保護したカスタムドメイン（例: `https://mosaic-check.example.com`）。
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

フレーム（静止画）の未モザイク箇所を判定します。アプリは 1 リクエスト 1 フレームで送ります。

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

### Workers AI への入力（1 フレームごと）

```js
await env.AI.run(
  env.JEV_MODEL, // "typesafe/jev-1.14.0"
  {
    state: { frame: "frame-3" },
    assets: {
      "frame-3": { type: "image", format: "jpeg", data_base64: "<base64>" },
    },
    questions: {
      genitals_present: { type: "noul", instructions: "Does `frame` show ..." },
      genitals_box: { type: "box", instructions: "the uncensored ..." },
    },
  },
  { extraHeaders: { "TypeSafe-Danger-Zone-Images": "true" } },
);
```

### レスポンス

```json
{
  "model": "typesafe/jev-1.14.0",
  "frames": [
    {
      "id": "3",
      "detections": [
        {
          "label": "性器",
          "score": 0.93,
          "box": [0.49, 0.11, 0.83, 0.51],
          "boxConfidence": 0.94
        }
      ]
    }
  ],
  "usage": { "inputTokens": 756 }
}
```

| フィールド                   | 内容                                                                       |
| ---------------------------- | -------------------------------------------------------------------------- |
| `detections`                 | `noul` 確率が `JEV_THRESHOLD`（既定 0.5）以上のカテゴリ。空なら検出なし    |
| `detections[].score`         | `noul` の確率（0〜1）                                                      |
| `detections[].box`           | 正規化座標 `[x0, y0, x1, y1]`（左上原点）。選択範囲の JSON と同じ座標系    |
| `detections[].boxConfidence` | `box` 回答の confidence（ある場合）                                        |
| `frames[].error`             | モデル呼び出し失敗時に `"model error"`。アプリはそのフレームを判定不能扱い |
| `usage.inputTokens`          | Jev が返した入力トークンの合計。無料枠見積もりの実測に使う                 |

## 環境変数（`worker/wrangler.toml` の `[vars]`）

| 名前                 | 例                               | 内容                                            |
| -------------------- | -------------------------------- | ----------------------------------------------- |
| `ACCESS_TEAM_DOMAIN` | `your-team.cloudflareaccess.com` | Zero Trust のチームドメイン                     |
| `ACCESS_AUD`         | 64 桁の16進                      | Access アプリの Application Audience (AUD) タグ |
| `JEV_MODEL`          | `typesafe/jev-1.14.0`            | 呼び出すモデル ID                               |
| `JEV_THRESHOLD`      | `0.5`                            | 検出とみなす `noul` 確率                        |
| `JEV_IMAGE_HEADER`   | `true`                           | `false` で画像用ヘッダーを付けない              |

いずれも秘密情報ではありません（AUD タグは JWT 検証用の公開値）。
バインディング `AI`（Workers AI）が必要です。Cron Trigger はありません。
