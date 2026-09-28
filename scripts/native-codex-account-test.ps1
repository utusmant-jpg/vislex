param(
    [Parameter(Mandatory = $true)][string]$BinaryPath,
    [int]$Port = 9477
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$binary = (Resolve-Path -LiteralPath $BinaryPath).Path
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $repo ('artifacts/codex-account-webview-' + [Guid]::NewGuid().ToString())
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
$process = Start-Process -FilePath $binary -WindowStyle Hidden -PassThru
try {
    $ready = $false
    for ($i = 0; $i -lt 80; $i++) {
        try { $null = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version"; $ready = $true; break }
        catch { Start-Sleep -Milliseconds 300 }
    }
    if (-not $ready) { throw 'Packaged Codex account WebView did not start' }
    & node (Join-Path $repo 'scripts/native-codex-account-test.mjs') $Port
    if ($LASTEXITCODE -ne 0) { throw 'Packaged Codex account test failed' }
} finally {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id }
    Remove-Item Env:WEBVIEW2_USER_DATA_FOLDER,Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
}
