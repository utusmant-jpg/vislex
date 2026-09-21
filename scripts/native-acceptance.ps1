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
    $script=(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'native-acceptance.js') -Raw -Encoding UTF8).Replace('__WORKSPACE__',($repo.Replace('\','/') | ConvertTo-Json -Compress))
    # Escape non-ASCII code units so Windows PowerShell's native stdin encoding cannot alter them.
    $script=[string]::Concat(($script.ToCharArray() | ForEach-Object {if([int]$_ -gt 127){'\u{0:x4}' -f [int]$_}else{[string]$_}}))
    # Start the browser daemon outside the captured pipeline so it cannot retain its stdout pipe.
    & npx --yes agent-browser --session "vislex-acceptance-$Port" --cdp $Port get title
    $output=$script | & npx --yes agent-browser --session "vislex-acceptance-$Port" --cdp $Port eval --stdin
    if($LASTEXITCODE -ne 0){throw ($output -join "`n")}
    $output | Set-Content -Encoding utf8 (Join-Path $repo 'artifacts\native-acceptance-automated.json')
    & npx --yes agent-browser --session "vislex-acceptance-$Port" --cdp $Port screenshot (Join-Path $repo 'artifacts\native-acceptance-automated.png')
    $output
} finally {
    & npx --yes agent-browser --session "vislex-acceptance-$Port" close
    if(-not $process.HasExited){Stop-Process -Id $process.Id}
    Remove-Item Env:VISLEX_TEST_MODE,Env:WEBVIEW2_USER_DATA_FOLDER,Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
}
