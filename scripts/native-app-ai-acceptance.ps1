param([string]$BinaryPath = '', [int]$Port = 9353)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$binary = if ($BinaryPath) { (Resolve-Path -LiteralPath $BinaryPath).Path } else { Join-Path $repo 'src-tauri\target\x86_64-pc-windows-msvc\debug\local-evidence-desk.exe' }
if (-not (Test-Path -LiteralPath $binary)) { throw 'Build the debug desktop executable first.' }
$runId = [Guid]::NewGuid().ToString('N')
$casePath = Join-Path $repo "artifacts\app-ai-$runId.ledcase"
$profile = Join-Path $repo "artifacts\app-ai-webview-$runId"
$defaultsPath = Join-Path $repo "artifacts\app-ai-defaults-$runId.json"
$env:VISLEX_TEST_MODE = '1'
$env:VISLEX_TEST_CASE_ROOT = Join-Path $repo 'artifacts'
$env:VISLEX_TEST_AI_DEFAULTS_PATH = $defaultsPath
$env:WEBVIEW2_USER_DATA_FOLDER = $profile
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
$process = Start-Process -FilePath $binary -WindowStyle Hidden -PassThru
try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        try { $null = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version"; $ready = $true; break } catch { Start-Sleep -Milliseconds 300 }
    }
    if (-not $ready) { throw 'Native WebView did not start.' }
    & node (Join-Path $PSScriptRoot 'native-app-ai-cdp.mjs') $Port $casePath
    if ($LASTEXITCODE -ne 0) { throw 'Native app AI acceptance failed.' }
} finally {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id }
    Remove-Item Env:VISLEX_TEST_MODE, Env:VISLEX_TEST_CASE_ROOT, Env:VISLEX_TEST_AI_DEFAULTS_PATH, Env:WEBVIEW2_USER_DATA_FOLDER, Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
}
