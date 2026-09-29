param([int]$Port=9348,[int]$FixturePort=9481,[int]$ProviderPort=9373,[string]$BinaryPath="")
# R51 native mock journey: pane on the fixture's sign-in page (agent refuses), user moves on,
# search -> read -> opinion -> capture -> finish_task -> cite-check accept -> dossier export, bundle
# free of editorial strings, research page isolated, CDP never drives the research target.
# Synthetic case, loopback fixture and scripted provider only. Writes
# artifacts/native-research-acceptance.json and artifacts/native-research-acceptance.png.
# Non-default ports so it can run beside the other native journeys.
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$binary=if ($BinaryPath) { (Resolve-Path -LiteralPath $BinaryPath).Path } else { Join-Path $repo 'src-tauri\target\x86_64-pc-windows-msvc\debug\local-evidence-desk.exe' }
if (-not (Test-Path -LiteralPath $binary)) {throw 'Build the debug desktop app with --features subscription,research first.'}
$artifacts=Join-Path $repo 'artifacts'
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
$names='VISLEX_TEST_MODE','VISLEX_TEST_CASE_ROOT','VISLEX_TEST_WEBVIEW_DIR','VISLEX_TEST_PROVIDER_URL','VISLEX_RESEARCH_MOCK_URL','VISLEX_RESEARCH_PROFILE_DIR','WEBVIEW2_USER_DATA_FOLDER','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'
$saved=@{}; foreach($name in $names){ $saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process') }
# The user's real application WebView profile must be untouched by the run.
$realStorage=Join-Path $env:LOCALAPPDATA 'org.localevidencedesk.app\EBWebView\Default\Local Storage'
$realStamp={ if(Test-Path -LiteralPath $realStorage){ (Get-ChildItem -LiteralPath $realStorage -Recurse -File | Measure-Object -Property LastWriteTimeUtc -Maximum).Maximum } }
$realBefore=& $realStamp
$fixture=$null; $provider=$null; $process=$null
try {
    $fixture=Start-Process -FilePath 'node' -ArgumentList @(('"'+(Join-Path $PSScriptRoot 'research-fixture-server.mjs')+'"'),$FixturePort) -WindowStyle Hidden -PassThru
    $provider=Start-Process -FilePath 'node' -ArgumentList @(('"'+(Join-Path $PSScriptRoot 'research-provider-mock.mjs')+'"'),$ProviderPort,"http://127.0.0.1:$FixturePort",'journey') -WindowStyle Hidden -PassThru
    foreach($url in @("http://127.0.0.1:$FixturePort/signin.html","http://127.0.0.1:$ProviderPort/state")) {
        $served=$false
        for($attempt=0;$attempt -lt 30;$attempt++) { try {$null=Invoke-WebRequest -UseBasicParsing -Uri $url; $served=$true;break} catch {Start-Sleep -Milliseconds 200} }
        if(-not $served){throw "Helper server did not start: $url"}
    }
    $env:VISLEX_TEST_MODE='1'
    $env:VISLEX_TEST_CASE_ROOT=$artifacts
    $env:VISLEX_TEST_WEBVIEW_DIR=Join-Path $artifacts ('test-webview-'+[Guid]::NewGuid().ToString())
    $env:VISLEX_TEST_PROVIDER_URL="http://127.0.0.1:$ProviderPort/v1/responses"
    # The pane opens on the fixture's sign-in page, as the service bounces a signed-out user.
    $env:VISLEX_RESEARCH_MOCK_URL="http://127.0.0.1:$FixturePort/signin.html"
    $env:VISLEX_RESEARCH_PROFILE_DIR=Join-Path $artifacts ('research-acceptance-profile-'+[Guid]::NewGuid().ToString())
    Remove-Item Env:WEBVIEW2_USER_DATA_FOLDER -ErrorAction SilentlyContinue
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$Port"
    $process=Start-Process -FilePath $binary -PassThru
    $ready=$false
    for($attempt=0;$attempt -lt 40;$attempt++) { try {$null=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version"; $ready=$true;break} catch {Start-Sleep -Milliseconds 300} }
    if(-not $ready){throw 'Native WebView debugging port did not start.'}
    $output=& node (Join-Path $PSScriptRoot 'native-research-acceptance.mjs') $Port $repo $FixturePort (Join-Path $artifacts 'native-research-acceptance.png') $ProviderPort
    $exit=$LASTEXITCODE
    $result=$output | ConvertFrom-Json
    $result | Add-Member -NotePropertyName provider -NotePropertyValue (Invoke-RestMethod -Uri "http://127.0.0.1:$ProviderPort/state")
    $result | Add-Member -NotePropertyName binary -NotePropertyValue $binary
    $result | Add-Member -NotePropertyName commit -NotePropertyValue ((& git -C $repo rev-parse HEAD) -join '')
    $runtime=try { (Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version").Browser } catch { $null }
    $result | Add-Member -NotePropertyName webview2_runtime -NotePropertyValue $runtime
    $unchanged=((& $realStamp) -eq $realBefore)
    $result | Add-Member -NotePropertyName real_profile_unchanged -NotePropertyValue $unchanged
    $result | ConvertTo-Json -Depth 12 | Set-Content -Encoding utf8 (Join-Path $artifacts 'native-research-acceptance.json')
    $output
    if($exit -ne 0 -or -not $result.ok){throw ('Research acceptance journey failed: '+$result.error)}
    if(-not $unchanged){throw 'The run modified the real application WebView profile'}
    'research acceptance journey passed'
} finally {
    if($process -and -not $process.HasExited){Stop-Process -Id $process.Id}
    foreach($helper in @($fixture,$provider)){ if($helper -and -not $helper.HasExited){Stop-Process -Id $helper.Id} }
    foreach($name in $names){ [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
}
