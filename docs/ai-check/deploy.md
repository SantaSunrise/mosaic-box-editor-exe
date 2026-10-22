# デプロイ手順書（未実行・承認後に実施）

> この PR では Cloudflare リソースを一切作成・デプロイしていません。以下は承認後に実施する手順です。
> トークン・API キー・Access の client secret などの秘密情報はリポジトリにコミットしないでください。
> Cron Trigger は作成しません。

## 0. 前提

- Cloudflare アカウントと、Worker を置くドメインのゾーン（例: `example.com`）。
- Cloudflare Zero Trust の組織（チームドメイン例: `your-team.cloudflareaccess.com`）と IdP
  （Google Workspace、One-time PIN など）。
- Node.js 22 以上。`wrangler` は `worker/package.json` の devDependencies から使います。
- 以下の値はすべて例です。実際の値に読み替えてください。

| 項目           | 例                               |
| -------------- | -------------------------------- |
| Worker 名      | `mosaic-check`                   |
| 公開ホスト名   | `mosaic-check.example.com`       |
| チームドメイン | `your-team.cloudflareaccess.com` |
| 許可する利用者 | 編集担当者のメール / グループ    |

## 1. モデル ID と画像入力の事前確認

```bash
cd worker
npm install
npx wrangler login
npx wrangler ai models --json | grep -i -o '"name": *"[^"]*jev[^"]*"'
```

- Cloudflare のモデルページ（<https://developers.cloudflare.com/ai/models/typesafe/jev/>）では ID が
  `typesafe/jev` と記載されています。`typesafe/jev-1.14.0` が使えない場合は `wrangler.toml` の
  `JEV_MODEL` を変更します（[未決事項](open-issues.md) #1）。

## 2. wrangler.toml の設定

`worker/wrangler.toml` のダミー値を置き換えます（ID 類はコミットしても秘密ではありませんが、
公開リポジトリに載せたくない場合は `CLOUDFLARE_ACCOUNT_ID` 環境変数と `--var` で渡します）。

- `account_id`（または環境変数 `CLOUDFLARE_ACCOUNT_ID`）
- `routes` の `pattern`（公開ホスト名）
- `ACCESS_TEAM_DOMAIN`
- `ACCESS_AUD` は手順 3 で取得してから設定します

`workers_dev = false` と `preview_urls = false` は変更しないでください（Access を迂回する URL を作らないため）。
`[triggers]` は追加しないでください。

## 3. Access アプリケーションの作成（ダッシュボード）

Zero Trust ダッシュボード → Access → Applications → Add an application → **Self-hosted**。

1. Application domain: `mosaic-check.example.com`、パスは空（ホスト全体を保護）。
2. Session duration: **24 hours 以下**（推奨 8〜24 時間。トークンが履歴に残る期間を短くするため）。
3. Policy: Action = Allow、Include = 編集担当者のメールアドレスまたは IdP グループ。
   サービストークン（Service Auth）は追加しません。
4. 保存後、Overview の **Application Audience (AUD) Tag** をコピーし、`ACCESS_AUD` に設定します。

## 4. デプロイ

```bash
cd worker
npm run check   # 型チェック
npm test        # 単体テスト
npx wrangler deploy
npx wrangler deployments list
```

デプロイ後、ダッシュボードの Worker → Settings → Triggers で **Cron Triggers が 0 件**であること、
Domains & Routes に `workers.dev` / Preview URL が無効であることを確認します。

## 5. スモークテスト

```bash
APP=https://mosaic-check.example.com
# Access 未ログインでは Worker に届かないこと（302 で Access のログインへ）
curl -sI "$APP/v1/me" | head -3

# cloudflared でログインしてトークンを取得（トークンは画面・ログに残さない）
cloudflared access login "$APP"
TOKEN=$(cloudflared access token -app="$APP")
curl -s -H "cf-access-token: $TOKEN" "$APP/v1/me"

# 画像入力が Workers AI バインディングで通るかの確認（安全なテスト画像を使う）
ffmpeg -v error -f lavfi -i testsrc2=size=640x360 -frames:v 1 -f image2pipe -c:v mjpeg - \
  | base64 -w0 > /tmp/frame.b64
printf '{"frames":[{"id":"0","mime":"image/jpeg","data":"%s"}]}' "$(cat /tmp/frame.b64)" > /tmp/detect.json
curl -s -H "cf-access-token: $TOKEN" -H 'content-type: application/json' \
  --data @/tmp/detect.json "$APP/v1/detect"
unset TOKEN
```

期待値: `frames[0].error` が無く、`usage.inputTokens` が 0 より大きいこと。
`"model error"` の場合は `npx wrangler tail` でエラー内容を確認します
（バインディングが `assets` や `extraHeaders` を受け付けない可能性。[未決事項](open-issues.md) #2）。

検出精度の確認は、実際の未修正素材と修正済み素材を各 20 件程度用意し、アプリから判定して
`JEV_THRESHOLD` を調整します（社内の確認環境で実施）。

## 6. アプリでの利用

1. アプリを起動し、ヘッダーの「AI判定」を押します。
2. 判定 API に `https://mosaic-check.example.com` を入力し「ログイン」。既定のブラウザで IdP にログインすると、
   ブラウザに「ログインしました」と表示され、アプリにメールアドレスと有効期限が出ます。
3. 動画フォルダを開いた状態で、対象（元の画像・動画 / 書き出し済み）を選び「判定を開始」。
4. NG の行の「編集画面で表示」で、該当フレームと検出枠を確認します。

配布 exe に既定 URL を埋め込む場合は、ビルド時に `.env`（`.env.example` を参照）へ
`VITE_CHECK_API_URL` を設定します。秘密情報ではありません。

## 7. 停止・ロールバック

- 一時停止: Access アプリのポリシーを無効化（全員拒否）するか、Worker のルートを外します。
- 削除: `npx wrangler delete mosaic-check`、Access アプリの削除。
- Worker は状態・保存データを持たないため、データの移行や削除は不要です。
