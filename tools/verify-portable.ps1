$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$version = (Get-Content "$projectDir/package.json" -Raw | ConvertFrom-Json).version
$name = "Mosaic-Box-Editor-v$version-windows-x64"
$archive = Join-Path $projectDir "release/$name.zip"
$expected = (Get-Content "$archive.sha256" -Raw).Split(' ')[0]
if ((Get-FileHash -LiteralPath $archive).Hash -ne $expected) { throw 'ZIP checksum mismatch.' }
$build = & cargo test --manifest-path "$projectDir/src-tauri/Cargo.toml" --release --lib --no-run --message-format=json
if ($LASTEXITCODE -ne 0) { throw 'Test build failed.' }
$testBinary = $build | ForEach-Object { $_ | ConvertFrom-Json } |
    Where-Object { $_.reason -eq 'compiler-artifact' -and $_.profile.test -and $_.executable } |
    Select-Object -Last 1 -ExpandProperty executable
if (!$testBinary) { throw 'No test executable produced.' }
$verificationDir = Join-Path $projectDir ".cache/verify-$([Guid]::NewGuid().ToString('N'))"
Expand-Archive -LiteralPath $archive -DestinationPath $verificationDir
$packageDir = Join-Path $verificationDir $name
Copy-Item -LiteralPath $testBinary -Destination "$packageDir/verify.exe"
$bytes = [IO.File]::ReadAllBytes("$packageDir/mosaic-box-editor.exe")
$peOffset = [BitConverter]::ToInt32($bytes, 60)
if ([BitConverter]::ToUInt16($bytes, $peOffset + 92) -ne 2) { throw 'EXE is not a Windows GUI executable.' }
$previousPath = $env:Path
try {
    $env:Path = "$env:SystemRoot/System32;$env:SystemRoot"
    Push-Location $env:TEMP
    try {
        & "$packageDir/verify.exe" --include-ignored
        if ($LASTEXITCODE -ne 0) { throw 'Portable export verification failed.' }
    } finally { Pop-Location }
} finally {
    $env:Path = $previousPath
    Remove-Item -LiteralPath "$packageDir/verify.exe"
}
Write-Output "Verified extracted ZIP, GUI subsystem and actual export without FFmpeg on PATH: $packageDir"
