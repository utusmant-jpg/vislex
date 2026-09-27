param(
    [Parameter(Mandatory = $true)][string]$BinaryPath,
    [switch]$DeviceCode,
    [switch]$PersistentProfile
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$binary = (Resolve-Path -LiteralPath $BinaryPath).Path
$fixture = Join-Path $root 'artifacts/synthetic-codex-boundary.ledcase'
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
$marker = Join-Path $fixture 'original.bin'
if (-not (Test-Path -LiteralPath $marker)) {
    [System.IO.File]::WriteAllText($marker, 'DENIED_SYNTHETIC')
}
if ([System.IO.File]::ReadAllText($marker) -ne 'DENIED_SYNTHETIC') {
    throw 'Synthetic deny marker has unexpected contents; no case data may be used'
}
if (Test-Path -LiteralPath (Join-Path $fixture 'unauthorized-write.txt')) {
    throw 'An unauthorized-write fixture already exists; inspect it before rerunning'
}
$extra = @()
if ($DeviceCode) { $extra = @('--test-login') }
if ($PersistentProfile) { $extra = @('--test-persistent') }
cargo run --locked --manifest-path (Join-Path $root 'src-tauri/Cargo.toml') --example codex_boundary_probe -- $binary $marker @extra
if ($LASTEXITCODE -ne 0) { throw 'Codex boundary probe failed' }
