param([int]$FixturePort=9471,[string]$BinaryPath="")
# R34 spike, startup mode: no WebView2 debugging port and no WEBVIEW2_USER_DATA_FOLDER, so the
# research pane's own profile directory and a port-free environment are what get measured.
# The debug app runs the spike itself and writes artifacts/research-spike-startup.json.
# Fails if the app exits non-zero or the report says ok=false.
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$binary=if ($BinaryPath) { (Resolve-Path -LiteralPath $BinaryPath).Path } else { Join-Path $repo 'src-tauri\target\x86_64-pc-windows-msvc\debug\local-evidence-desk.exe' }
if (-not (Test-Path -LiteralPath $binary)) {throw 'Build the debug desktop app with --features research first.'}
$output=Join-Path $repo 'artifacts\research-spike-startup.json'
Remove-Item -LiteralPath $output -ErrorAction SilentlyContinue
$names='VISLEX_TEST_MODE','VISLEX_RESEARCH_MOCK_URL','VISLEX_RESEARCH_SPIKE_OUTPUT','WEBVIEW2_USER_DATA_FOLDER','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'
$saved=@{}; foreach($name in $names){ $saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process') }
$fixture=$null; $process=$null
try {
    $fixture=Start-Process -FilePath 'node' -ArgumentList @(('"'+(Join-Path $PSScriptRoot 'research-fixture-server.mjs')+'"'),$FixturePort) -WindowStyle Hidden -PassThru
    $served=$false
    for($attempt=0;$attempt -lt 30;$attempt++) {
        try {$null=Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$FixturePort/index.html"; $served=$true;break} catch {Start-Sleep -Milliseconds 200}
    }
    if(-not $served){throw 'Research fixture server did not start.'}
    Remove-Item Env:WEBVIEW2_USER_DATA_FOLDER,Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
    $env:VISLEX_TEST_MODE='1'
    $env:VISLEX_RESEARCH_MOCK_URL="http://127.0.0.1:$FixturePort/"
    $env:VISLEX_RESEARCH_SPIKE_OUTPUT=$output
    $process=Start-Process -FilePath $binary -PassThru
    if(-not $process.WaitForExit(120000)){throw 'Startup spike did not finish in 120 s.'}
    if(-not (Test-Path -LiteralPath $output)){throw 'Startup spike wrote no report.'}
    $report=Get-Content -Raw -LiteralPath $output
    $report
    if($process.ExitCode -ne 0 -or -not ($report | ConvertFrom-Json).ok){throw "Startup spike failed (exit $($process.ExitCode))."}
} finally {
    if($process -and -not $process.HasExited){Stop-Process -Id $process.Id}
    if($fixture -and -not $fixture.HasExited){Stop-Process -Id $fixture.Id}
    foreach($name in $names){ [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
}
