param([int]$Port=9338,[int]$FixturePort=9471,[int]$ProviderPort=9363,[string]$BinaryPath="",[ValidateSet('agent','westlaw')][string]$Mode='agent')
# R44 native journey: a real chat task drives the research pane through the agent loop, with a
# scripted synthetic provider and the loopback fixture. No real site, provider or case is used.
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$binary=if ($BinaryPath) { (Resolve-Path -LiteralPath $BinaryPath).Path } else { Join-Path $repo 'src-tauri\target\x86_64-pc-windows-msvc\debug\local-evidence-desk.exe' }
if (-not (Test-Path -LiteralPath $binary)) {throw 'Build the debug desktop app with --features research first.'}
$names='VISLEX_TEST_MODE','VISLEX_TEST_CASE_ROOT','VISLEX_TEST_WEBVIEW_DIR','VISLEX_TEST_PROVIDER_URL','VISLEX_RESEARCH_MOCK_URL','VISLEX_RESEARCH_PROFILE_DIR','WEBVIEW2_USER_DATA_FOLDER','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'
$saved=@{}; foreach($name in $names){ $saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process') }
$realStorage=Join-Path $env:LOCALAPPDATA 'org.localevidencedesk.app\EBWebView\Default\Local Storage'
$realStamp={ if(Test-Path -LiteralPath $realStorage){ (Get-ChildItem -LiteralPath $realStorage -Recurse -File | Measure-Object -Property LastWriteTimeUtc -Maximum).Maximum } }
$realBefore=& $realStamp
$fixture=$null; $provider=$null; $process=$null
try {
    $fixture=Start-Process -FilePath 'node' -ArgumentList @(('"'+(Join-Path $PSScriptRoot 'research-fixture-server.mjs')+'"'),$FixturePort) -WindowStyle Hidden -PassThru
    $provider=Start-Process -FilePath 'node' -ArgumentList @(('"'+(Join-Path $PSScriptRoot 'research-provider-mock.mjs')+'"'),$ProviderPort,"http://127.0.0.1:$FixturePort",$Mode) -WindowStyle Hidden -PassThru
    foreach($url in @("http://127.0.0.1:$FixturePort/index.html","http://127.0.0.1:$ProviderPort/state")) {
        $served=$false
        for($attempt=0;$attempt -lt 30;$attempt++) { try {$null=Invoke-WebRequest -UseBasicParsing -Uri $url; $served=$true;break} catch {Start-Sleep -Milliseconds 200} }
        if(-not $served){throw "Helper server did not start: $url"}
    }
    $env:VISLEX_TEST_MODE='1'
    $env:VISLEX_TEST_CASE_ROOT=Join-Path $repo 'artifacts'
    $env:VISLEX_TEST_WEBVIEW_DIR=Join-Path $repo ('artifacts\test-webview-'+[Guid]::NewGuid().ToString())
    $env:VISLEX_TEST_PROVIDER_URL="http://127.0.0.1:$ProviderPort/v1/responses"
    $env:VISLEX_RESEARCH_MOCK_URL="http://127.0.0.1:$FixturePort/index.html"
    $env:VISLEX_RESEARCH_PROFILE_DIR=Join-Path $repo ('artifacts\research-agent-profile-'+[Guid]::NewGuid().ToString())
    Remove-Item Env:WEBVIEW2_USER_DATA_FOLDER -ErrorAction SilentlyContinue
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$Port"
    $process=Start-Process -FilePath $binary -PassThru
    $ready=$false
    for($attempt=0;$attempt -lt 40;$attempt++) { try {$null=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version"; $ready=$true;break} catch {Start-Sleep -Milliseconds 300} }
    if(-not $ready){throw 'Native WebView debugging port did not start.'}
    $output=& node (Join-Path $PSScriptRoot 'native-cdp-eval.mjs') $Port (Join-Path $PSScriptRoot 'native-research-agent.js') $repo (Join-Path $repo 'artifacts\research-agent.png') $FixturePort
    if($LASTEXITCODE -ne 0){throw ($output -join "`n")}
    $output | Set-Content -Encoding utf8 (Join-Path $repo 'artifacts\research-agent.json')
    (Invoke-RestMethod -Uri "http://127.0.0.1:$ProviderPort/state") | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $repo 'artifacts\research-agent-provider.json')
    $output
    if(-not ($output | ConvertFrom-Json).ok){throw 'Research agent journey reported ok=false.'}
    if((& $realStamp) -ne $realBefore){throw 'The run modified the real application WebView profile'}
    'research agent journey passed'
} finally {
    if($process -and -not $process.HasExited){Stop-Process -Id $process.Id}
    foreach($helper in @($fixture,$provider)){ if($helper -and -not $helper.HasExited){Stop-Process -Id $helper.Id} }
    foreach($name in $names){ [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
}
