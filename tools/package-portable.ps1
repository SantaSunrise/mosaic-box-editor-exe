$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$resourceDir = Join-Path $projectDir 'src-tauri/resources'
$version = (Get-Content "$projectDir/package.json" -Raw | ConvertFrom-Json).version
$tauriVersion = (Get-Content "$projectDir/src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json).version
$exe = Join-Path $projectDir 'src-tauri/target/release/mosaic-box-editor.exe'
if (!(Test-Path -LiteralPath $exe)) { throw 'Build the release application first.' }
$exeVersion = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
if ($version -ne $tauriVersion -or $exeVersion -ne $version) {
    throw "Version mismatch: package=$version, tauri=$tauriVersion, exe=$exeVersion. Rebuild first."
}
$manifest = Get-Content -LiteralPath "$PSScriptRoot/ffmpeg.json" -Raw | ConvertFrom-Json
foreach ($entry in $manifest.binaries.PSObject.Properties) {
    $file = Join-Path "$resourceDir/bin" $entry.Name
    if (!(Test-Path -LiteralPath $file) -or (Get-FileHash -LiteralPath $file).Hash -ne $entry.Value) {
        throw "Missing or unexpected $($entry.Name). Run pnpm setup:ffmpeg first."
    }
}

$releaseDir = [IO.Path]::GetFullPath((Join-Path $projectDir 'release'))
$packageName = "Mosaic-Box-Editor-v$version-windows-x64"
if ($packageName -notmatch '^Mosaic-Box-Editor-v[0-9]+\.[0-9]+\.[0-9]+-windows-x64$') { throw 'Invalid package version.' }
$packageDir = [IO.Path]::GetFullPath((Join-Path $releaseDir $packageName))
if (![StringComparer]::OrdinalIgnoreCase.Equals((Split-Path -Parent $packageDir), $releaseDir)) { throw 'Invalid package destination.' }
# Only this verified, generated version folder can be replaced; other release files stay intact.
if (Test-Path -LiteralPath $packageDir) { Remove-Item -LiteralPath $packageDir -Recurse -Force }
New-Item -ItemType Directory -Force $packageDir | Out-Null
Copy-Item -LiteralPath $exe -Destination $packageDir
Copy-Item -LiteralPath "$resourceDir/bin","$resourceDir/licenses" -Destination $packageDir -Recurse
Copy-Item -LiteralPath "$projectDir/LICENSE","$projectDir/THIRD_PARTY_NOTICES.md" -Destination $packageDir
& node "$PSScriptRoot/collect-licenses.mjs" "$packageDir/licenses/dependencies"
if ($LASTEXITCODE -ne 0) { throw 'Could not collect dependency licenses.' }
@"
Mosaic Box Editor v$version

mosaic-box-editor.exe を開いてください。
動画が入っているフォルダを選び、範囲を指定して書き出します。
出力は選んだフォルダ内の mosaic、選択範囲は boxes に保存されます。

ffmpeg / ffprobe は同梱済みです。別途インストールは不要です。
移動するときは bin と licenses を含むこのフォルダ全体を移動してください。
Windows 10 / 11（x64）と WebView2 Runtime が必要です。

使い方: https://github.com/SantaSunrise/mosaic-box-editor-exe
本体: MIT（LICENSE） / 同梱ツール: licenses と THIRD_PARTY_NOTICES.md を参照
"@ | Set-Content -LiteralPath "$packageDir/はじめに.txt" -Encoding utf8
Copy-Item -LiteralPath "$PSScriptRoot/ffmpeg.json" -Destination "$packageDir/licenses/ffmpeg/checksums.json"
$archive = Join-Path $releaseDir "$packageName.zip"
Compress-Archive -LiteralPath $packageDir -DestinationPath $archive -Force
$checksum = (Get-FileHash -LiteralPath $archive).Hash.ToLowerInvariant()
"$checksum  $packageName.zip" | Set-Content -LiteralPath "$archive.sha256" -Encoding ascii
Write-Output $archive
