param([int]$Port=9338,[int]$FixturePort=9471,[string]$BinaryPath="")
# R40 native journey: the Browser view through the real UI (rail button, placement over the
# slot, hiding for other views and dialogs, toolbar Back), against the loopback fixture only.
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$binary=if ($BinaryPath) { (Resolve-Path -LiteralPath $BinaryPath).Path } else { Join-Path $repo 'src-tauri\target\x86_64-pc-windows-msvc\debug\local-evidence-desk.exe' }
if (-not (Test-Path -LiteralPath $binary)) {throw 'Build the debug desktop app with --features subscription,research first.'}
$names='VISLEX_TEST_MODE','VISLEX_TEST_CASE_ROOT','VISLEX_TEST_WEBVIEW_DIR','VISLEX_RESEARCH_MOCK_URL','VISLEX_RESEARCH_PROFILE_DIR','WEBVIEW2_USER_DATA_FOLDER','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'
$saved=@{}; foreach($name in $names){ $saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process') }
# The user's real application WebView profile must be untouched by the run.
$realStorage=Join-Path $env:LOCALAPPDATA 'org.localevidencedesk.app\EBWebView\Default\Local Storage'
$realStamp={ if(Test-Path -LiteralPath $realStorage){ (Get-ChildItem -LiteralPath $realStorage -Recurse -File | Measure-Object -Property LastWriteTimeUtc -Maximum).Maximum } }
$realBefore=& $realStamp
$fixture=$null; $process=$null
try {
    $fixture=Start-Process -FilePath 'node' -ArgumentList @(('"'+(Join-Path $PSScriptRoot 'research-fixture-server.mjs')+'"'),$FixturePort) -WindowStyle Hidden -PassThru
    $served=$false
    for($attempt=0;$attempt -lt 30;$attempt++) { try {$null=Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$FixturePort/index.html"; $served=$true;break} catch {Start-Sleep -Milliseconds 200} }
    if(-not $served){throw 'Research fixture server did not start.'}
    $env:VISLEX_TEST_MODE='1'
    $env:VISLEX_TEST_CASE_ROOT=Join-Path $repo 'artifacts'
    $env:VISLEX_TEST_WEBVIEW_DIR=Join-Path $repo ('artifacts\test-webview-'+[Guid]::NewGuid().ToString())
    $env:VISLEX_RESEARCH_MOCK_URL="http://127.0.0.1:$FixturePort/index.html"
    $env:VISLEX_RESEARCH_PROFILE_DIR=Join-Path $repo ('artifacts\research-view-profile-'+[Guid]::NewGuid().ToString())
    Remove-Item Env:WEBVIEW2_USER_DATA_FOLDER -ErrorAction SilentlyContinue
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$Port"
    $process=Start-Process -FilePath $binary -PassThru
    $ready=$false
    for($attempt=0;$attempt -lt 40;$attempt++) { try {$null=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version"; $ready=$true;break} catch {Start-Sleep -Milliseconds 300} }
    if(-not $ready){throw 'Native WebView debugging port did not start.'}
    $output=& node (Join-Path $PSScriptRoot 'native-research-view.mjs') $Port $repo $FixturePort (Join-Path $repo 'artifacts\research-view.png')
    $output | Set-Content -Encoding utf8 (Join-Path $repo 'artifacts\research-view.json')
    $output
    if($LASTEXITCODE -ne 0 -or -not ($output | ConvertFrom-Json).ok){throw 'Research Browser view journey failed.'}
    if((& $realStamp) -ne $realBefore){throw 'The run modified the real application WebView profile'}
} finally {
    if($process -and -not $process.HasExited){Stop-Process -Id $process.Id}
    if($fixture -and -not $fixture.HasExited){Stop-Process -Id $fixture.Id}
    foreach($name in $names){ [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
}
