param([int]$Port=9338,[string]$BinaryPath="")
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$binary=if ($BinaryPath) { (Resolve-Path -LiteralPath $BinaryPath).Path } else { Join-Path $repo 'src-tauri\target\x86_64-pc-windows-msvc\debug\local-evidence-desk.exe' }
if (-not (Test-Path -LiteralPath $binary)) {throw 'Build the debug desktop app first.'}
$env:VISLEX_TEST_MODE='1'
$env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $repo ('artifacts\acceptance-webview-'+[Guid]::NewGuid().ToString())
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$Port"
$process=Start-Process -FilePath $binary -WindowStyle Hidden -PassThru
try {
    $ready=$false
    for($attempt=0;$attempt -lt 30;$attempt++) {
        try {$null=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version"; $ready=$true;break} catch {Start-Sleep -Milliseconds 300}
    }
    if(-not $ready){throw 'Native WebView debugging port did not start.'}
    $output=& node (Join-Path $PSScriptRoot 'native-cdp-eval.mjs') $Port (Join-Path $PSScriptRoot 'native-acceptance.js') $repo (Join-Path $repo 'artifacts\native-acceptance-automated.png')
    if($LASTEXITCODE -ne 0){throw ($output -join "`n")}
    $output | Set-Content -Encoding utf8 (Join-Path $repo 'artifacts\native-acceptance-automated.json')
    $output
} finally {
    if(-not $process.HasExited){Stop-Process -Id $process.Id}
    Remove-Item Env:VISLEX_TEST_MODE,Env:WEBVIEW2_USER_DATA_FOLDER,Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
}
