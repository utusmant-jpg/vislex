# Development only: run `npm run desktop` with the ChatGPT-subscription route and the
# patched Codex sidecar. Debug builds honour VISLEX_CODEX_BINARY and skip the pinned
# SHA-256 check; release builds never do.
#
# Build the sidecar once with scripts/build-codex-sidecar.ps1 (the stock Codex CLI cannot
# run inside the app's AppContainer). This script copies it into the ignored
# artifacts/codex-dev folder: the app grants the sandbox access to the sidecar's folder,
# and doing that under src-tauri makes `tauri dev` see a change and restart the app.
param([string]$Binary = '', [switch]$CopyOnly)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not $Binary) { $Binary = Join-Path $repo 'src-tauri\resources\codex\codex-app-server.exe' }
if (-not (Test-Path -LiteralPath $Binary)) { throw 'Build the patched sidecar first: scripts/build-codex-sidecar.ps1' }
$dest = Join-Path $repo 'artifacts\codex-dev\app-server'
$exe = Join-Path $dest 'codex-app-server.exe'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$source = (Resolve-Path -LiteralPath $Binary).Path
if (-not (Test-Path -LiteralPath $exe) -or (Get-FileHash -LiteralPath $exe).Hash -ne (Get-FileHash -LiteralPath $source).Hash) {
    Copy-Item -LiteralPath $source -Destination $exe -Force
}
if ($CopyOnly) { return }
$env:VISLEX_CODEX_BINARY = $exe
Set-Location $repo
npm run desktop
