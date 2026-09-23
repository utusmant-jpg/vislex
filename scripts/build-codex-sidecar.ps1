param([string]$Checkout = "")
$ErrorActionPreference = 'Stop'
$commit = '985cf47a4eb6084b2ff6b30ebdb1216acda85bb4'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Checkout) { $Checkout = Join-Path $root 'artifacts/openai-codex-fork' }
if (-not (Test-Path -LiteralPath (Join-Path $Checkout '.git'))) {
    git clone --filter=blob:none https://github.com/openai/codex.git $Checkout
    if ($LASTEXITCODE -ne 0) { throw 'Codex source clone failed' }
    git -C $Checkout checkout --detach $commit
    if ($LASTEXITCODE -ne 0) { throw 'Pinned Codex commit unavailable' }
}
$head = (git -C $Checkout rev-parse HEAD).Trim()
if ($head -ne $commit) { throw "Codex checkout must be at pinned commit $commit; found $head" }
$patch = Join-Path $root 'patches/codex-appcontainer-windows.patch'
git -C $Checkout apply --reverse --check $patch 2>$null
if ($LASTEXITCODE -ne 0) {
    git -C $Checkout apply --check $patch
    if ($LASTEXITCODE -ne 0) { throw 'Pinned Codex patch does not apply cleanly' }
    git -C $Checkout apply $patch
    if ($LASTEXITCODE -ne 0) { throw 'Pinned Codex patch failed' }
}
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
cargo build --release -p codex-cli --bin codex --target x86_64-pc-windows-msvc --manifest-path (Join-Path $Checkout 'codex-rs/Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw 'Pinned Codex build failed' }
$source = Join-Path $Checkout 'codex-rs/target/x86_64-pc-windows-msvc/release/codex.exe'
$target = Join-Path $root 'src-tauri/resources/codex'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -LiteralPath $source -Destination (Join-Path $target 'codex.exe') -Force
Copy-Item -LiteralPath (Join-Path $Checkout 'LICENSE') -Destination (Join-Path $target 'LICENSE') -Force
Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $target 'codex.exe')
