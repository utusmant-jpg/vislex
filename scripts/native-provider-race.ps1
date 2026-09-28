param([int]$Port=9363,[int]$MockPort=9362,[string]$BinaryPath="")
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$binary=if ($BinaryPath) {(Resolve-Path -LiteralPath $BinaryPath).Path} else {Join-Path $repo 'src-tauri\target\x86_64-pc-windows-msvc\debug\local-evidence-desk.exe'}
if (-not (Test-Path -LiteralPath $binary)) {throw 'Build the debug desktop app first.'}
if ($binary -match '[\\/]release[\\/]') {throw 'The synthetic provider endpoint is enabled only in debug builds. Use the debug executable.'}
try {$null=Invoke-WebRequest -Uri 'http://127.0.0.1:1420/' -TimeoutSec 2 -UseBasicParsing} catch {throw 'Start npm run dev before the debug provider race; its WebView requires the Vite page at 127.0.0.1:1420.'}
$mockScript=Join-Path $PSScriptRoot 'native-provider-mock.mjs'
$mock=Start-Process -FilePath (Get-Command node).Source -ArgumentList @("`"$mockScript`"","$MockPort") -WindowStyle Hidden -PassThru
try {
    $ready=$false
    for($attempt=0;$attempt -lt 60;$attempt++) {
        try {$null=Invoke-RestMethod -Uri "http://127.0.0.1:$MockPort/state";$ready=$true;break} catch {Start-Sleep -Milliseconds 100}
    }
    if(-not $ready){throw 'Synthetic provider server did not start.'}
    $env:VISLEX_TEST_MODE='1'
    $env:VISLEX_TEST_PROVIDER_URL="http://127.0.0.1:$MockPort/v1/responses"
    $env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $repo ('artifacts\provider-race-webview-'+[Guid]::NewGuid().ToString())
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$Port"
    $app=Start-Process -FilePath $binary -WindowStyle Hidden -PassThru
    try {
        $ready=$false
        for($attempt=0;$attempt -lt 100;$attempt++) {
            try {$null=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version";$ready=$true;break} catch {Start-Sleep -Milliseconds 100}
        }
        if(-not $ready){throw 'Native WebView debugging port did not start.'}
        $output=& node (Join-Path $PSScriptRoot 'native-cdp-eval.mjs') $Port (Join-Path $PSScriptRoot 'native-provider-race.js') $repo (Join-Path $repo 'artifacts\native-provider-race.png') $MockPort
        if($LASTEXITCODE -ne 0){throw ($output -join "`n")}
        $result=$output | ConvertFrom-Json
        if($result.native_error){throw $result.native_error}
        $requests=Invoke-RestMethod -Uri "http://127.0.0.1:$MockPort/state"
        if($requests.requests -ne 2 -or $requests.held -ne 0){throw "Expected two completed synthetic provider deliveries, got $($requests | ConvertTo-Json -Compress). Journey: $($output -join ' ')"}
        $output | Set-Content -Encoding utf8 (Join-Path $repo 'artifacts\native-provider-race.json')
        $output
    } finally {
        if(-not $app.HasExited){Stop-Process -Id $app.Id}
        Remove-Item Env:VISLEX_TEST_MODE,Env:VISLEX_TEST_PROVIDER_URL,Env:WEBVIEW2_USER_DATA_FOLDER,Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
    }
} finally {
    if(-not $mock.HasExited){Stop-Process -Id $mock.Id}
}
