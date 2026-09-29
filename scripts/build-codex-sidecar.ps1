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
# The reverse check is expected to fail on a fresh checkout. Windows PowerShell 5.1
# turns redirected native stderr into a terminating error under 'Stop', so relax it here.
$ErrorActionPreference = 'Continue'
git -C $Checkout apply --reverse --check $patch 2>$null
$alreadyApplied = $LASTEXITCODE -eq 0
$ErrorActionPreference = 'Stop'
if (-not $alreadyApplied) {
    git -C $Checkout apply --check $patch
    if ($LASTEXITCODE -ne 0) { throw 'Pinned Codex patch does not apply cleanly' }
    git -C $Checkout apply $patch
    if ($LASTEXITCODE -ne 0) { throw 'Pinned Codex patch failed' }
}
$env:RUSTUP_TOOLCHAIN = '1.98.1-x86_64-pc-windows-msvc'
$env:CARGO_PROFILE_RELEASE_LTO = 'false'
$env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = '16'
$env:CARGO_PROFILE_RELEASE_DEBUG = '0'
$env:CARGO_PROFILE_RELEASE_OPT_LEVEL = '2'
$env:CARGO_BUILD_JOBS = '4'
cargo build --locked --release -p codex-app-server --bin codex-app-server --target x86_64-pc-windows-msvc --manifest-path (Join-Path $Checkout 'codex-rs/Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw 'Pinned Codex build failed' }
$source = Join-Path $Checkout 'codex-rs/target/x86_64-pc-windows-msvc/release/codex-app-server.exe'
$target = Join-Path $root 'src-tauri/resources/codex'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -LiteralPath $source -Destination (Join-Path $target 'codex-app-server.exe') -Force
Copy-Item -LiteralPath (Join-Path $Checkout 'LICENSE') -Destination (Join-Path $target 'LICENSE') -Force
Copy-Item -LiteralPath (Join-Path $Checkout 'NOTICE') -Destination (Join-Path $target 'NOTICE') -Force
Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $target 'codex-app-server.exe')
