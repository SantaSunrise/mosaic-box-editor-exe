# Windowsリリース手順

## 準備

1. `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` のバージョンを揃える。
2. `pnpm install` とCargoでlockfileを更新し、`CHANGELOG.md` とREADMEを更新する。
3. README記載の型・整形・テストを実行する。
4. `pnpm setup:ffmpeg`、`pnpm tauri build --no-bundle`、`pnpm package:portable` を実行する。

配布ZIPにはアプリ、ffmpeg、ffprobe、使い方、MITと依存コンポーネントのライセンスが入ります。
パッケージスクリプトはバージョンの一致とFFmpegのSHA256を検証し、ZIPの隣にSHA256ファイルを生成します。
FFmpegの更新時は `tools/ffmpeg.json` と元のライセンス・ビルド情報・ソース参照先を一緒に更新してください。

## 動作確認

`pwsh -NoProfile -File tools/verify-portable.ps1` でZIPのチェックサム、GUI用EXE、
展開後の実動画書き出しを検証します。検証はFFmpegを含まないPATHと別の作業ディレクトリで実行されます。
展開した検証用フォルダはGit対象外の `.cache/` に残ります。

- 空の画面からフォルダを選択／ドロップし、動画が一覧に並ぶこと。
- 各選択ツールと消去、保存、ズーム、速度・表示切り替え。
- 個別・一括書き出し、出力済みの除外、中止、エラー表示。
- ZIPを別フォルダに展開し、ffmpegを含まないPATHと別の作業ディレクトリで実動画を書き出せること。
- 起動時と書き出し時にコンソールウィンドウが出ないこと。

## GitHubへの登録

バージョンに合わせて以下のファイル名とタグを変更します。既存タグを上書きしないでください。

```powershell
git tag -a v0.0.1 -m "Mosaic Box Editor v0.0.1"
git push origin main
git push origin v0.0.1
gh release create v0.0.1 release/Mosaic-Box-Editor-v0.0.1-windows-x64.zip release/Mosaic-Box-Editor-v0.0.1-windows-x64.zip.sha256 --verify-tag --title "Mosaic Box Editor v0.0.1" --notes-file docs/releases/v0.0.1.md
```

Windows CIはmainへのpushとPRで実行されます。配布物の公開は上記コマンドで行います。
