# Mosaic Box Editor

ローカル動画にモザイクを付ける、Windows向けのデスクトップアプリです。
動画フォルダを開き、矩形・投げ縄・ブラシで範囲を指定して書き出せます。
編集・書き出しはすべてPC内で行います。外部へ送信するのは、任意の「局部モザイク確認」を実行したときの
抽出フレーム（画像）だけです。

![Mosaic Box Editor](docs/screenshot.png)

## ダウンロード

[Releases](https://github.com/SantaSunrise/mosaic-box-editor-exe/releases) から
`Mosaic-Box-Editor-v0.0.2-windows-x64.zip` をダウンロードし、**ZIP全体を展開**して
`mosaic-box-editor.exe` を開いてください。

- 対象: Windows 10 / 11、x64。
- ffmpeg・ffprobeは同梱済みです。インストールやPATH設定は不要です。
- 表示には [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) を使用します。未導入のPCではインストールしてください。
- 移動するときは、`bin`・`licenses` を含むフォルダ全体を移動してください。
- 署名なしのポータブル版です。インストーラー・自動更新は含みません。

## 使い方

1. **動画が入ったフォルダを選ぶ**  
   「動画フォルダを開く」を押すか、空の編集画面にフォルダをドロップします。
   MP4・MOV・WebMがサブフォルダも含めて左側に並びます。
2. **モザイク範囲を指定する**  
   動画を選び、矩形・投げ縄・ブラシで範囲を追加・消去します。範囲は自動保存されます。
   「前の範囲を引き継ぐ」を有効にすると、未設定の動画に直前の範囲をコピーできます。
3. **動画を書き出す**  
   「モザイク動画を書き出す」で、選んだフォルダ内の `mosaic` にMP4を保存します。
   「まとめて書き出す」は、範囲が保存済みで、出力ファイルがまだない動画が対象です。

```text
選んだフォルダ/
├── clip.mp4                 元動画（変更しません）
├── scene/another.mov
├── boxes/                   選択範囲のJSON（自動保存）
│   ├── clip.json
│   └── scene/another.json
└── mosaic/                  モザイク済みMP4
    ├── clip.mp4
    └── scene/another.mp4
```

| 一覧の状態 | 意味                                         |
| ---------- | -------------------------------------------- |
| 未設定     | 保存された範囲がありません                   |
| 設定済み   | 範囲は保存済みで、まだ出力していません       |
| 出力済み   | モザイク動画を書き出しています               |
| 更新あり   | 元動画または範囲が、出力後に更新されています |

「更新あり」は一括書き出しに含めません。動画を開いて個別に再出力してください。
個別の書き出しでは、同じ保存先の出力を置き換えます。

## 局部モザイク確認（AIによるモザイク漏れチェック）

フォルダを開いた状態でヘッダーの「局部モザイク確認」を押すと、Cloudflare Accessでログインし
（未ログインならボタンから案内します）、フォルダ内の画像・動画に修正漏れがないかをAI（Jevモデル）で確認できます。

- 動画は均等な10フレーム、画像は1枚を判定します。確率80%以上の検出が1フレームでもあればNG、50〜80%は要確認です。
- 対象は「元の画像・動画」か「書き出し済み（`mosaic`）」を選べます。
- 保存済みの範囲の外にある検出は「未モザイク疑い」として表示します。
- 「編集画面で表示」で該当フレームへ移動し、検出枠を重ねて表示します。
- NGの動画は、NGのフレームの検出枠をすべて包む1つの矩形を「モザイク候補」として水色の破線で表示します。要確認の動画は、要確認以上（50%以上）で位置が取れたフレームの枠をすべて包む矩形を「モザイク候補（要確認）」として表示します。
  「候補を範囲に追加」を押したときだけ範囲に追加され、既存の範囲は自動では変わりません。
- 動画ライブラリに「AI NG」「AI要確認」「AI OK」の絞り込みと件数を追加しました。選ぶと状態の絞り込み（未設定など）より優先され、判定結果がまだないときは0件です。
- ログインは既定のブラウザで行います。判定APIのURLの入力は不要です（既定は社内のWorker。変更は管理者向けの `VITE_CHECK_API_URL`）。

設計・API・デプロイ手順・無料枠の見積もりは [docs/ai-check](docs/ai-check/README.md) を参照してください。

## 編集操作

- ループ再生は、裏で先頭を準備したプレイヤーへ交代して、先頭へのシーク待ちを減らします。ループONの間だけ2つ目の動画を読み込みます。

- 選択範囲／モザイクのプレビュー切り替え。
- 再生速度: ×0.50 / ×0.75 / ×1.00 / ×1.50 / ×2.00（プレビューのみ）。
- ホイールでマウス位置を中心に拡大縮小。中ボタンドラッグで移動。「全体表示」でリセット。
- 範囲表示は5色、濃さは3段階。表示設定は書き出すモザイクには影響しません。
- ブラシの太さ調整中は、中央の円で画面上の大きさを確認できます。

| キー        | 操作                               |
| ----------- | ---------------------------------- |
| Space       | 再生／一時停止                     |
| R / L / B   | 矩形／投げ縄／ブラシ               |
| A / E       | 範囲の追加／消去                   |
| M           | 選択範囲／モザイク表示             |
| Ctrl+S      | 範囲を保存                         |
| Ctrl+Z      | 直前の範囲操作を戻す               |
| ← / →       | 約1フレーム戻る／進む（30fps換算） |
| Shift+← / → | 約1秒戻る／進む                    |

## 制限

- ループ時は追加のメモリ・デコーダーを使用します。先読みが間に合わない場合は通常の先頭シークに戻ります。動画や再生環境によって、映像・音声のつなぎ目が完全になくなるとは限りません。

- 範囲は動画全体に共通です。対象の自動追跡・キーフレーム編集はありません。
- 書き出しはH.264 / AACのMP4です。利用可能なGPUエンコーダーを順番に試し、利用できなければCPUに切り替えます。
- プレビューの対応コーデックはWebView2に依存します。拡張子が対応していても再生できない動画があります。
- 一括書き出しの中止は、処理中の1本が終わってから反映されます。
- 同じサブフォルダに拡張子だけが異なる同名動画を置くと保存先が重なります。元動画の名前を分けてください。

## 開発

このリポジトリはTauri版のみを管理します。旧ブラウザ版やPythonツールは含みません。

必要な環境:

- Windows x64、PowerShell 7、Node.js 22.18以上、pnpm 11.25.0。
- Rust stable（MSVC）、Visual Studio Build Toolsの「C++によるデスクトップ開発」。
- WebView2 Runtime。初回の依存関係とFFmpeg取得時はインターネット接続が必要です。

```powershell
pnpm install --frozen-lockfile
pnpm setup:ffmpeg
pnpm tauri dev
```

`setup:ffmpeg` は固定バージョンのアーカイブと実行ファイルのSHA256を照合します。
大きな実行ファイルはGitに含めず、配布ZIPに同梱します。
`pnpm dev` は画面だけの確認用です。フォルダ操作・保存・書き出しには `pnpm tauri dev` を使います。

```powershell
pnpm check
pnpm test
pnpm format:check
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --lib -- --include-ignored
```

```powershell
pnpm tauri build --no-bundle
pnpm package:portable
```

配布物は `release/` に生成されます。[開発ガイド](CONTRIBUTING.md) と
[リリース手順](docs/releasing.md) も参照してください。

## 構成

| 場所                                            | 担当                                              |
| ----------------------------------------------- | ------------------------------------------------- |
| `src/main.ts`                                   | 編集状態・イベント・Tauri呼び出し                 |
| `src/ui/`                                       | 画面テンプレート・アイコン                        |
| `src/renderer.ts`                               | 範囲・モザイクのプレビュー描画                    |
| `src/viewport.ts`                               | ズーム・パンの座標計算                            |
| `src/library.ts` / `src-tauri/src/thumbnail.rs` | 一覧のサムネイル（遅延生成・同時3本）・フォルダ名 |
| `src/batch-export.ts`                           | 一括書き出しの順次実行・中止・エラー集計          |
| `src/types.ts` / `src/appearance.ts`            | 共通のデータ型・表示設定                          |
| `src-tauri/src/project.rs`                      | 一覧・範囲の保存と削除                            |
| `src-tauri/src/mask.rs`                         | 書き出し用のマスク生成                            |
| `src-tauri/src/media.rs`                        | FFmpegの解決・動画情報取得・書き出し              |
| `src-tauri/src/auth.rs` / `check.rs`            | AI判定のログイン・フレーム抽出・API呼出           |
| `src/check.ts` / `src/check-ui.ts`              | AI判定の集計・判定ダイアログ                      |
| `worker/`                                       | AI判定API（Cloudflare Worker）                    |
| `tools/`                                        | テスト・FFmpeg取得・配布物作成                    |

## ライセンス

アプリ本体は [MIT](LICENSE) です。
同梱FFmpegはGyanの9.0.1 full static build（GPLv3）で、独立したプロセスとして呼び出します。
第三者コンポーネントにはそれぞれのライセンスが適用されます。
配布物の `licenses/` と [第三者ライセンス情報](THIRD_PARTY_NOTICES.md) を参照してください。
