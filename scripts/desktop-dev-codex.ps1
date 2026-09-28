# Development only: run the desktop app with the ChatGPT-subscription route. Debug builds
# honour VISLEX_CODEX_BINARY and skip the SHA-256 check; release builds never do.
#
# -Binary <path>  Use a patched codex-app-server.exe, for example the one built by
#                 scripts/build-codex-sidecar.ps1 (artifacts/openai-codex-fork/.../release).
#                 This is the path that works: the app runs Codex inside an AppContainer and
#                 needs patches/codex-appcontainer-windows.patch.
# (no -Binary)    Copy the stock Codex CLI (npm install -g @openai/codex) into the ignored
#                 artifacts/codex-dev folder. NOTE: the stock CLI exits inside the AppContainer
#                 ("failed to canonicalize CODEX_HOME ... Access is denied"), so sign-in will
#                 not work with it; this mode only proves the route is wired up.
param([string]$Binary = '', [switch]$CopyOnly)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$dest = Join-Path $repo 'artifacts\codex-dev'
$exe = if ($Binary) { (Resolve-Path -LiteralPath $Binary).Path } else { Join-Path $dest 'bin\codex.exe' }
if (-not $Binary -and -not (Test-Path -LiteralPath $exe)) {
    $global = (& npm root -g).Trim()
    $vendor = Get-ChildItem -Path (Join-Path $global '@openai\codex\node_modules\@openai\codex-win32-*\vendor\*') -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $vendor) { throw 'Install the Codex CLI first: npm install -g @openai/codex' }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    foreach ($item in 'bin', 'codex-path', 'codex-package.json') {
        Copy-Item -LiteralPath (Join-Path $vendor.FullName $item) -Destination $dest -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $dest 'codex-resources') | Out-Null
    foreach ($item in 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe') {
        Copy-Item -LiteralPath (Join-Path $vendor.FullName "codex-resources\$item") -Destination (Join-Path $dest 'codex-resources') -Force
    }
}
if ($CopyOnly) { return }
$env:VISLEX_CODEX_BINARY = $exe
Set-Location $repo
npm run desktop
