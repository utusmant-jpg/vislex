param([int]$Port=9338,[int]$FixturePort=9471,[string]$BinaryPath="")
# R39 native journey: research pane commands, the per-case toggle and automatic closing,
# against the loopback fixture in debug test mode, then sign-out deleting the pane profile.
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$binary=if ($BinaryPath) { (Resolve-Path -LiteralPath $BinaryPath).Path } else { Join-Path $repo 'src-tauri\target\x86_64-pc-windows-msvc\debug\local-evidence-desk.exe' }
if (-not (Test-Path -LiteralPath $binary)) {throw 'Build the debug desktop app with --features research first.'}
$profile=Join-Path $repo ('artifacts\research-pane-profile-'+[Guid]::NewGuid().ToString())
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
    for($attempt=0;$attempt -lt 30;$attempt++) {
        try {$null=Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$FixturePort/index.html"; $served=$true;break} catch {Start-Sleep -Milliseconds 200}
    }
    if(-not $served){throw 'Research fixture server did not start.'}
    $env:VISLEX_TEST_MODE='1'
    $env:VISLEX_TEST_CASE_ROOT=Join-Path $repo 'artifacts'
    # The main window gets its own WebView profile; the user's real app profile is never used.
    $env:VISLEX_TEST_WEBVIEW_DIR=Join-Path $repo ('artifacts\test-webview-'+[Guid]::NewGuid().ToString())
    $env:VISLEX_RESEARCH_MOCK_URL="http://127.0.0.1:$FixturePort/index.html"
    $env:VISLEX_RESEARCH_PROFILE_DIR=$profile
    # No WEBVIEW2_USER_DATA_FOLDER: it would override the pane profile (R34), and sign-out must
    # delete a real profile. VISLEX_TEST_WEBVIEW_DIR isolates the main window instead.
    Remove-Item Env:WEBVIEW2_USER_DATA_FOLDER -ErrorAction SilentlyContinue
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$Port"
    $process=Start-Process -FilePath $binary -PassThru
    $ready=$false
    for($attempt=0;$attempt -lt 40;$attempt++) {
        try {$null=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version"; $ready=$true;break} catch {Start-Sleep -Milliseconds 300}
    }
    if(-not $ready){throw 'Native WebView debugging port did not start.'}
    $eval=Join-Path $PSScriptRoot 'native-cdp-eval.mjs'
    $output=& node $eval $Port (Join-Path $PSScriptRoot 'native-research-pane.js') $repo (Join-Path $repo 'artifacts\research-pane.png') $FixturePort
    if($LASTEXITCODE -ne 0){throw ($output -join "`n")}
    $output | Set-Content -Encoding utf8 (Join-Path $repo 'artifacts\research-pane.json')
    $output
    if(-not ($output | ConvertFrom-Json).ok){throw 'Research pane journey reported ok=false.'}
    if(-not (Test-Path -LiteralPath (Join-Path $profile 'EBWebView'))){throw 'The research pane did not write its own profile'}
    $signout=& node $eval $Port (Join-Path $PSScriptRoot 'native-research-signout.js') $repo (Join-Path $repo 'artifacts\research-signout.png') $FixturePort
    if($LASTEXITCODE -ne 0){throw ($signout -join "`n")}
    $signout
    if(-not ($signout | ConvertFrom-Json).ok){throw 'Sign-out reported ok=false.'}
    if(Test-Path -LiteralPath $profile){throw "Sign-out left the research profile at $profile"}
    'research pane journey and sign-out passed'
    if((& $realStamp) -ne $realBefore){throw 'The run modified the real application WebView profile'}
} finally {
    if($process -and -not $process.HasExited){Stop-Process -Id $process.Id}
    if($fixture -and -not $fixture.HasExited){Stop-Process -Id $fixture.Id}
    foreach($name in $names){ [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
}
