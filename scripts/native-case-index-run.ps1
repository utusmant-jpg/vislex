param([Parameter(Mandatory=$true)][string]$CasePath,[int]$Port=9383,[int]$MockPort=9382,[int]$MaxMinutes=240,[string]$BinaryPath='')
# Measure the bounded case-index pipeline on a COPY of a real case with the
# synthetic provider. Never point this at an original case: analysis writes to it.
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$binary=if($BinaryPath){(Resolve-Path -LiteralPath $BinaryPath).Path}else{Join-Path $repo 'src-tauri\target\x86_64-pc-windows-msvc\debug\local-evidence-desk.exe'}
if(-not(Test-Path -LiteralPath $binary)){throw 'Build the debug desktop executable first.'}
if($binary -match '[\\/]release[\\/]'){throw 'Synthetic provider runs require a debug executable.'}
$case=(Resolve-Path -LiteralPath $CasePath).Path
$runId=[Guid]::NewGuid().ToString('N')
$out=Join-Path $repo "artifacts\case-index-run-$runId"
New-Item -ItemType Directory -Force $out | Out-Null
$mock=Start-Process -FilePath (Get-Command node).Source -ArgumentList @("`"$(Join-Path $PSScriptRoot 'native-case-index-mock.mjs')`"","$MockPort") -WindowStyle Hidden -PassThru
try {
    for($i=0;$i -lt 80;$i++){try{$null=Invoke-RestMethod -Uri "http://127.0.0.1:$MockPort/state";break}catch{Start-Sleep -Milliseconds 150}}
    $env:VISLEX_TEST_MODE='1'
    $env:VISLEX_TEST_CASE_ROOT=Split-Path -Parent $case
    $env:VISLEX_TEST_ANALYSIS_AUTORUN='1'
    $env:VISLEX_TEST_PROVIDER_URL="http://127.0.0.1:$MockPort/v1/responses"
    $env:VISLEX_TEST_AI_DEFAULTS_PATH=Join-Path $out 'defaults.json'
    $env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $out 'webview'
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$Port"
    $app=Start-Process -FilePath $binary -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $out 'app.out.log') -RedirectStandardError (Join-Path $out 'app.err.log')
    try {
        for($i=0;$i -lt 200;$i++){try{$null=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version";break}catch{Start-Sleep -Milliseconds 150}}
        & node (Join-Path $PSScriptRoot 'native-case-index-cdp.mjs') $Port ($case -replace '\\','/') $MockPort (Join-Path $out 'result.json') $MaxMinutes
        if($LASTEXITCODE -ne 0){throw "Case-index run failed (see $out)"}
    } finally {
        if(-not $app.HasExited){Stop-Process -Id $app.Id}
        Remove-Item Env:VISLEX_TEST_MODE,Env:VISLEX_TEST_CASE_ROOT,Env:VISLEX_TEST_ANALYSIS_AUTORUN,Env:VISLEX_TEST_PROVIDER_URL,Env:VISLEX_TEST_AI_DEFAULTS_PATH,Env:WEBVIEW2_USER_DATA_FOLDER,Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
    }
} finally {if(-not $mock.HasExited){Stop-Process -Id $mock.Id}}
