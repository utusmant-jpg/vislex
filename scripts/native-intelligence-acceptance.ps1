param([int]$Port=9373,[int]$MockPort=9372,[string]$BinaryPath='')
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$binary=if($BinaryPath){(Resolve-Path -LiteralPath $BinaryPath).Path}else{Join-Path $repo 'src-tauri\target\x86_64-pc-windows-msvc\debug\local-evidence-desk.exe'}
if(-not(Test-Path -LiteralPath $binary)){throw 'Build the debug desktop executable first.'}
if($binary -match '[\\/]release[\\/]'){throw 'Synthetic provider tests require a debug executable.'}
$runId=[Guid]::NewGuid().ToString('N')
$mockScript=Join-Path $PSScriptRoot 'native-intelligence-mock.mjs'
$mock=Start-Process -FilePath (Get-Command node).Source -ArgumentList @("`"$mockScript`"","$MockPort") -WindowStyle Hidden -PassThru
try {
    $ready=$false
    for($i=0;$i -lt 80;$i++){try{$null=Invoke-RestMethod -Uri "http://127.0.0.1:$MockPort/state";$ready=$true;break}catch{Start-Sleep -Milliseconds 150}}
    if(-not $ready){throw 'Synthetic provider did not start.'}
    $env:VISLEX_TEST_MODE='1'
    $env:VISLEX_TEST_CASE_ROOT=Join-Path $repo 'artifacts'
    $env:VISLEX_TEST_ANALYSIS_AUTORUN='1'
    $env:VISLEX_TEST_PROVIDER_URL="http://127.0.0.1:$MockPort/v1/responses"
    $env:VISLEX_TEST_AI_DEFAULTS_PATH=Join-Path $repo "artifacts\intelligence-defaults-$runId.json"
    $env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $repo "artifacts\intelligence-webview-$runId"
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$Port"
    $app=Start-Process -FilePath $binary -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $repo "artifacts\intelligence-app-$runId.out.log") -RedirectStandardError (Join-Path $repo "artifacts\intelligence-app-$runId.err.log")
    try {
        $ready=$false
        for($i=0;$i -lt 120;$i++){try{$null=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version";$ready=$true;break}catch{Start-Sleep -Milliseconds 150}}
        if(-not $ready){throw 'Native WebView did not start.'}
        $output=& node (Join-Path $PSScriptRoot 'native-intelligence-cdp.mjs') $Port $repo $MockPort
        if($LASTEXITCODE -ne 0){throw ($output -join "`n")}
        $result=$output | ConvertFrom-Json
        if($result.native_error){throw $result.native_error}
        $output | Set-Content -Encoding utf8 (Join-Path $repo 'artifacts\native-intelligence-acceptance.json')
        $output
    } finally {
        if(-not $app.HasExited){Stop-Process -Id $app.Id}
        Remove-Item Env:VISLEX_TEST_MODE,Env:VISLEX_TEST_CASE_ROOT,Env:VISLEX_TEST_ANALYSIS_AUTORUN,Env:VISLEX_TEST_PROVIDER_URL,Env:VISLEX_TEST_AI_DEFAULTS_PATH,Env:WEBVIEW2_USER_DATA_FOLDER,Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
    }
} finally {if(-not $mock.HasExited){Stop-Process -Id $mock.Id}}
