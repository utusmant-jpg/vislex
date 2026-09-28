param([switch]$IncludePackagedWorker)
$ErrorActionPreference = 'Stop'
$v4Root = Split-Path -Parent $PSScriptRoot
$v4Output = Join-Path $v4Root ('artifacts/v4-verification-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $v4Output -Force | Out-Null
$v4Checks = @(
    @{ Name = 'frontend-build'; Command = 'npm.cmd'; Arguments = @('run','build') },
    @{ Name = 'frontend-tests'; Command = 'npm.cmd'; Arguments = @('test') },
    @{ Name = 'desktop-check'; Command = 'cargo'; Arguments = @('check','--manifest-path','src-tauri/Cargo.toml','--features','desktop') },
    @{ Name = 'webview-lockstep'; Command = 'node'; Arguments = @('scripts/check-webview-lockstep.mjs') },
    @{ Name = 'research-desktop-check'; Command = 'cargo'; Arguments = @('check','--manifest-path','src-tauri/Cargo.toml','--features','research') },
    @{ Name = 'research-release-check'; Command = 'cargo'; Arguments = @('check','--release','--manifest-path','src-tauri/Cargo.toml','--features','research') },
    @{ Name = 'rust-tests'; Command = 'cargo'; Arguments = @('test','--manifest-path','src-tauri/Cargo.toml') },
    @{ Name = 'sound-tests'; Command = (Join-Path $v4Root '.venv-worker/Scripts/python.exe'); Arguments = @('-m','unittest','discover','-s','workers','-p','test_sound_events.py') },
    @{ Name = 'worker-result-tests'; Command = (Join-Path $v4Root '.venv-worker/Scripts/python.exe'); Arguments = @('-m','unittest','discover','-s','workers','-p','test_result_safety.py') },
    @{ Name = 'document-format-tests'; Command = (Join-Path $v4Root '.venv-worker/Scripts/python.exe'); Arguments = @('-m','unittest','discover','-s','workers','-p','test_document_formats.py') },
    @{ Name = 'video-discovery-tests'; Command = (Join-Path $v4Root '.venv-worker/Scripts/python.exe'); Arguments = @('-m','unittest','discover','-s','workers','-p','test_video_discovery.py') },
    @{ Name = 'benchmark-tests'; Command = (Join-Path $v4Root '.venv-worker/Scripts/python.exe'); Arguments = @('-m','unittest','discover','-s','benchmarks','-p','test_*.py') }
)
if ($IncludePackagedWorker) {
    $v4Checks += @{ Name = 'packaged-worker'; Command = 'cargo'; Arguments = @('test','--manifest-path','src-tauri/Cargo.toml','--test','sandbox','--','--include-ignored') }
}
$v4Results = @()
Push-Location $v4Root
try {
    foreach ($v4Check in $v4Checks) {
        $v4Start = Get-Date
        Write-Host ('Running ' + $v4Check.Name)
        $v4Log = Join-Path $v4Output ($v4Check.Name + '.log')
        try {
            & $v4Check.Command @($v4Check.Arguments) *> $v4Log
            $v4Exit = $LASTEXITCODE
        } catch {
            $_ | Out-File -FilePath $v4Log -Append
            $v4Exit = 1
        }
        $v4Results += [ordered]@{ name = $v4Check.Name; exit_code = $v4Exit; passed = ($v4Exit -eq 0); elapsed_seconds = ((Get-Date) - $v4Start).TotalSeconds; log = $v4Log }
    }
    [ordered]@{
        completed_at = (Get-Date).ToUniversalTime().ToString('o')
        scope = 'Synthetic regression checks. No live-provider, capacity, accuracy, or competitive certification.'
        checks = $v4Results
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $v4Output 'results.json') -Encoding utf8
} finally { Pop-Location }
Write-Host ('Results: ' + $v4Output)
if ($v4Results | Where-Object { -not $_.passed }) { exit 1 }
