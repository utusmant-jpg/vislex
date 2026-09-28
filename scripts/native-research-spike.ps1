param([int]$Port=9338,[int]$FixturePort=9471,[string]$BinaryPath="")
# R34 spike, port mode: launches the debug app in test mode with the research pane limited to a
# loopback fixture, runs the in-process DevTools measurements through the main webview and
# writes artifacts/research-spike.json. Fails if the spike reports ok=false.
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$binary=if ($BinaryPath) { (Resolve-Path -LiteralPath $BinaryPath).Path } else { Join-Path $repo 'src-tauri\target\x86_64-pc-windows-msvc\debug\local-evidence-desk.exe' }
if (-not (Test-Path -LiteralPath $binary)) {throw 'Build the debug desktop app with --features research first.'}
$names='VISLEX_TEST_MODE','VISLEX_TEST_CASE_ROOT','VISLEX_RESEARCH_MOCK_URL','WEBVIEW2_USER_DATA_FOLDER','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'
$saved=@{}; foreach($name in $names){ $saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process') }
$fixture=$null; $process=$null
try {
    $fixture=Start-Process -FilePath 'node' -ArgumentList @(('"'+(Join-Path $PSScriptRoot 'research-fixture-server.mjs')+'"'),$FixturePort) -WindowStyle Hidden -PassThru
    $served=$false
    for($attempt=0;$attempt -lt 30;$attempt++) {
        try {$null=Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$FixturePort/index.html"; $served=$true;break} catch {Start-Sleep -Milliseconds 200}
    }
    if(-not $served){throw 'Research fixture server did not start.'}
    $env:VISLEX_TEST_MODE='1'
    $env:VISLEX_TEST_CASE_ROOT=Join-Path $repo 'artifacts'
    $env:VISLEX_RESEARCH_MOCK_URL="http://127.0.0.1:$FixturePort/"
    $env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $repo ('artifacts\research-spike-webview-'+[Guid]::NewGuid().ToString())
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$Port"
    $process=Start-Process -FilePath $binary -PassThru
    $ready=$false
    for($attempt=0;$attempt -lt 40;$attempt++) {
        try {$null=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version"; $ready=$true;break} catch {Start-Sleep -Milliseconds 300}
    }
    if(-not $ready){throw 'Native WebView debugging port did not start.'}
    $output=& node (Join-Path $PSScriptRoot 'native-cdp-eval.mjs') $Port (Join-Path $PSScriptRoot 'native-research-spike.js') $repo (Join-Path $repo 'artifacts\research-spike.png') $FixturePort
    if($LASTEXITCODE -ne 0){throw ($output -join "`n")}
    $output | Set-Content -Encoding utf8 (Join-Path $repo 'artifacts\research-spike.json')
    $output
    if(-not ($output | ConvertFrom-Json).ok){throw 'Research spike reported ok=false.'}
} finally {
    if($process -and -not $process.HasExited){Stop-Process -Id $process.Id}
    if($fixture -and -not $fixture.HasExited){Stop-Process -Id $fixture.Id}
    foreach($name in $names){ [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
}
