$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath "$PSScriptRoot/ffmpeg.json" -Raw | ConvertFrom-Json
$resourceDir = Join-Path $projectDir 'src-tauri/resources'
$cacheDir = Join-Path $projectDir '.cache'

function Test-Binaries($directory) {
    foreach ($entry in $manifest.binaries.PSObject.Properties) {
        $file = Join-Path $directory $entry.Name
        if (!(Test-Path -LiteralPath $file)) { return $false }
        if ((Get-FileHash -LiteralPath $file).Hash -ne $entry.Value) { return $false }
    }
    return $true
}

if ((Test-Binaries "$resourceDir/bin") -and (Test-Path "$resourceDir/licenses/ffmpeg/LICENSE")) {
    Write-Output "FFmpeg $($manifest.version) is already installed and verified."
    exit 0
}

New-Item -ItemType Directory -Force $cacheDir,"$resourceDir/bin","$resourceDir/licenses/ffmpeg" | Out-Null
$archive = Join-Path $cacheDir "ffmpeg-$($manifest.version).zip"
if (!(Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -Uri $manifest.url -OutFile $archive -UseBasicParsing
}
if ((Get-FileHash -LiteralPath $archive).Hash -ne $manifest.archiveSha256) {
    throw "FFmpeg archive checksum mismatch. Remove $archive and retry."
}

# Extract only the two tools and their original notices, never ffplay or arbitrary paths.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    foreach ($name in @('bin/ffmpeg.exe', 'bin/ffprobe.exe', 'LICENSE', 'README.txt')) {
        $entry = $zip.GetEntry("$($manifest.directory)/$name")
        if (!$entry) { throw "Missing archive entry: $name" }
        $destination = if ($name.StartsWith('bin/')) { "$resourceDir/$name" } else { "$resourceDir/licenses/ffmpeg/$name" }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
    }
} finally { $zip.Dispose() }
if (!(Test-Binaries "$resourceDir/bin")) { throw 'Extracted FFmpeg binary checksum mismatch.' }
Write-Output "FFmpeg $($manifest.version) installed and verified."
