param([string]$BinaryPath = '', [int]$Port = 9341)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$binary = if ($BinaryPath) { (Resolve-Path -LiteralPath $BinaryPath).Path } else { Join-Path $repo 'artifacts\VisLex 0.3.0-dev20\VisLex.exe' }
if (-not (Test-Path -LiteralPath $binary)) { throw 'The packaged VisLex binary is missing.' }
$casePath = Join-Path $repo ('artifacts\consent-acceptance-' + [Guid]::NewGuid().ToString('N') + '.ledcase')
$profile = Join-Path $repo ('artifacts\consent-webview-' + [Guid]::NewGuid().ToString('N'))
$defaults = Join-Path $env:APPDATA 'org.localevidencedesk.app\ai-defaults.json'
$hadDefaults = Test-Path -LiteralPath $defaults
$savedDefaults = if ($hadDefaults) { [IO.File]::ReadAllBytes($defaults) } else { $null }
try {
    foreach ($phase in @(1, 2, 3)) {
        $env:WEBVIEW2_USER_DATA_FOLDER = $profile
        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
        Remove-Item Env:VISLEX_TEST_MODE -ErrorAction SilentlyContinue
        $process = Start-Process -FilePath $binary -WindowStyle Hidden -PassThru
        try {
            $ready = $false
            for ($attempt = 0; $attempt -lt 40; $attempt++) {
                try { $null = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version"; $ready = $true; break } catch { Start-Sleep -Milliseconds 300 }
            }
            if (-not $ready) { throw 'Native WebView did not start.' }
            & node (Join-Path $PSScriptRoot 'native-consent-cdp.mjs') $Port $casePath $phase
            if ($LASTEXITCODE -ne 0) { throw 'Native consent acceptance failed.' }
        } finally {
            if (-not $process.HasExited) { Stop-Process -Id $process.Id }
            Start-Sleep -Milliseconds 500
        }
    }
} finally {
    if ($hadDefaults) {
        [IO.File]::WriteAllBytes($defaults, $savedDefaults)
    } elseif (Test-Path -LiteralPath $defaults) {
        Remove-Item -LiteralPath $defaults -Force
    }
    Remove-Item Env:WEBVIEW2_USER_DATA_FOLDER, Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
}
