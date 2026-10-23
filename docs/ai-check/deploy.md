# デプロイ手順書と実施記録

> トークン・API キー・Access の client secret などの秘密情報はリポジトリにコミットしないでください。
> Cron Trigger は作成しません。

## 実施状況（2026-10-23、SantaSunrise の Cloudflare アカウント）

PR の作業の中で、次を **新規作成のみ**（既存の Worker・ルート・Access アプリは変更していません）で実施済みです。

| 項目                   | 内容                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| Worker                 | `mosaic-check`（`workers_dev` 無効、プレビュー URL 無効、Cron Trigger 0 件を API で確認）              |
| 公開ホスト名           | `mosaic-check.santasunrise.app`（Workers のカスタムドメイン）                                          |
| Access アプリ          | `mosaic-check`（Self-hosted、`mosaic-check.santasunrise.app` 全体）                                    |
| Access ポリシー        | Allow、Include = 本人のメールアドレス 1 件のみ。サービストークンなし                                   |
| IdP                    | One-time PIN（既存の Access アプリと同じ）                                                             |
| セッション             | 24 時間                                                                                                |
| `ACCESS_AUD`           | 作成した Access アプリの AUD タグを Worker の変数に設定                                                |
| `ACCESS_TEAM_DOMAIN`   | `santasunrise.cloudflareaccess.com`                                                                    |
| `JEV_BACKEND` / モデル | `typesafe-api` / `jev-1.14.0`                                                                          |
| `TYPESAFE_API_KEY`     | Worker のシークレット（Cloudflare API の `secret_text`）として登録。値はどこにも出力・保存していません |

### ゾーンの `*.santasunrise.app/*` ルートについて

このゾーンには、全サブドメインに Basic 認証をかける Worker（`basic-auth-worker`）が `*.santasunrise.app/*` で付いています。
そのままだと `mosaic-check.santasunrise.app` にも Basic 認証が入り、アプリが通れません。
既存の `dsh` / `comfy` と同じやり方で、**Worker なしのルート `mosaic-check.santasunrise.app/*` を 1 件追加**して対象外にしています
（より具体的なパターンが優先されるため）。Access をかける前に、Worker 自身の JSON（`{"error":"unauthorized"}`）が返り、
Basic 認証の応答が返らないことを確認済みです。

### 確認できたこと・できていないこと

- 確認済み: Access 未ログインの `GET /v1/me`・`POST /v1/detect`・`GET /auth/desktop` が、Access のログイン（302）へ飛ぶ。
  `workers.dev` は 404。Cron Trigger は 0 件。
- 確認済み: Worker のコードを、実際の TypeSafe API（Jev 1.14、`noul` + `box`）に対して実行し、検出・位置・トークン数が返る
  （Access とカスタムドメインを経由しない、箱の上での実行）。
- **未確認**: Access のログイン後に、デプロイした Worker から TypeSafe API へ届くこと（シークレット経由）。
  ログインには本人のメール宛のワンタイムコードが必要なため、自動では確認できません。次の手順 5 を本人が行ってください。

## 0. 前提（別のアカウントに作り直す場合）

- Cloudflare アカウントと、Worker を置くドメインのゾーン。
- Cloudflare Zero Trust の組織（チームドメイン例: `your-team.cloudflareaccess.com`）と IdP。
- Node.js 22 以上。`wrangler` は `worker/package.json` の devDependencies から使います。
- TypeSafe の API キー（typesafe-api バックエンドの場合）。

## 1. wrangler.toml の設定

`worker/wrangler.toml` のダミー値を置き換えます（公開リポジトリのため、`account_id` は
`CLOUDFLARE_ACCOUNT_ID` 環境変数で渡し、コミットしないでください）。

- `routes` の `pattern`（公開ホスト名）
- `ACCESS_TEAM_DOMAIN`
- `ACCESS_AUD` は手順 2 で取得してから設定します
- `JEV_BACKEND` / `JEV_MODEL`

`workers_dev = false` と `preview_urls = false` は変更しないでください。`[triggers]` は追加しないでください。

## 2. Access アプリケーションの作成

Zero Trust ダッシュボード → Access → Applications → Add an application → **Self-hosted**
（または Access API）。

1. Application domain: 公開ホスト名、パスは空（ホスト全体を保護）。
2. Session duration: **24 hours 以下**。
3. Policy: Action = Allow、Include = 利用者のメールアドレスまたは IdP グループ。サービストークンは追加しません。
4. 保存後、Overview の **Application Audience (AUD) Tag** を `ACCESS_AUD` に設定します。

### 利用者（チーム）を増やすとき

Access アプリ `mosaic-check` のポリシー `mosaic-check-owner-only` の Include に、メールアドレス（または既存のグループ
`aigaming-users`）を追加します。ダッシュボードの Zero Trust → Access → Applications → mosaic-check → Policies で編集できます。
Worker 側の変更は不要です（JWT の `aud` はアプリ単位のため）。

## 3. シークレットの登録とデプロイ

```bash
cd worker
npm install
npx wrangler secret put TYPESAFE_API_KEY   # 入力プロンプトに貼り付ける。コマンドラインに値を書かない
npm run check
npm test
npx wrangler deploy
```

デプロイ後、ダッシュボードの Worker → Settings → Triggers で **Cron Triggers が 0 件**であること、
`workers.dev` / Preview URL が無効であることを確認します。

## 4. 未ログインでの確認

```bash
APP=https://mosaic-check.santasunrise.app
curl -sI "$APP/v1/me" | head -3   # 302 で Access のログインへ
```

## 5. ログイン後のスモークテスト（本人が実施）

1. アプリを起動し、動画フォルダを開いて、ヘッダーの「局部モザイク確認」→「ログインして確認を開始」。
   既定のブラウザで Cloudflare のログイン（メールのワンタイムコード）を行うと、アプリにメールアドレスと有効期限が出ます。
2. 画像 1 枚だけのフォルダなどで確認を実行し、結果が「エラー」にならないこと、入力トークンが 0 でないことを見ます。
   エラーの場合、行に `model error (TypeSafe API HTTP 401)` のようにステータスが出ます
   （401 はキー、429 はレート制限、400 は画像サイズなど）。詳細は Worker のログ（ダッシュボードの Observability）で確認します。

コマンドラインで試す場合（トークンは画面・ログに残さない）:

```bash
cloudflared access login "$APP"
TOKEN=$(cloudflared access token -app="$APP")
curl -s -H "cf-access-token: $TOKEN" "$APP/v1/me"
unset TOKEN
```

検出精度の確認は、実際の未修正素材と修正済み素材を各 20 件程度用意し、アプリから判定して
`JEV_THRESHOLD` やアプリ側の NG しきい値（0.8）を調整します。

## 6. アプリでの利用

1. アプリを起動し、動画フォルダを開いた状態で、ヘッダーの「局部モザイク確認」を押します。
2. 未ログインなら「ログインして確認を開始」でブラウザの Cloudflare ログインに進みます（API の URL の入力は不要です。
   既定は `https://mosaic-check.santasunrise.app`。別の Worker に向けたビルドは `VITE_CHECK_API_URL` で指定します）。
3. 対象（元の画像・動画 / 書き出し済み）を選んで「確認を開始」。
4. NG（または要確認）の行の「編集画面で表示」で該当フレームと検出枠を確認し、「編集画面で候補を見る」で水色の「モザイク候補」を確認します。
   候補を採用する場合だけ、ツールバーの「候補を範囲に追加」を押します。

## 7. workers-ai への切り替え（チームの許可が出たら）

`JEV_BACKEND` を `workers-ai`、`JEV_MODEL` を `typesafe/jev-1.14.0` にして再デプロイします（`AI` バインディングは設定済み）。
Workers AI のバインディングで画像入力・`box` が通るか、無料枠が適用されるかは未検証のため、手順 5 のスモークテストを再実施してください。
不要になった `TYPESAFE_API_KEY` は `npx wrangler secret delete TYPESAFE_API_KEY` で削除します。

## 8. 停止・ロールバック

- 一時停止: Access アプリのポリシーを無効化（全員拒否）するか、Worker のカスタムドメインを外します。
- 削除: `npx wrangler delete mosaic-check`、Access アプリの削除、追加した Worker なしルートの削除。
- Worker は状態・保存データを持たないため、データの移行や削除は不要です。
