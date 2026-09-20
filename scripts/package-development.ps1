param([string]$OutputName = 'VisLex 0.2.1')
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputName) -or $OutputName.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or $OutputName -in @('.', '..')) { throw 'OutputName must be one folder name.' }
$destination = Join-Path (Join-Path $repo 'artifacts') $OutputName
$binary = Join-Path $repo 'src-tauri\target\x86_64-pc-windows-msvc\debug\local-evidence-desk.exe'
if (-not (Test-Path -LiteralPath $binary)) { throw 'Build with npm exec tauri build -- --debug --features desktop --no-bundle first.' }
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item -LiteralPath $binary -Destination (Join-Path $destination 'VisLex.exe')
$resources = Join-Path $destination 'resources\worker'
New-Item -ItemType Directory -Force -Path $resources | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'src-tauri\resources\worker\evidence-worker') -Destination $resources -Recurse -Force
foreach ($name in @('README.md','LICENSE','THIRD_PARTY_NOTICES.md')) { Copy-Item -LiteralPath (Join-Path $repo $name) -Destination $destination }
Copy-Item -LiteralPath (Join-Path $repo 'docs') -Destination $destination -Recurse -Force
$notices = Join-Path $destination 'notices'
New-Item -ItemType Directory -Force -Path $notices | Out-Null
Get-ChildItem -LiteralPath (Join-Path $repo '.venv-worker\Lib\site-packages') -Directory -Filter '*.dist-info' | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $notices -Recurse -Force }
Copy-Item -LiteralPath (Join-Path $repo 'workers\model-manifest.json') -Destination $notices
Write-Output $destination
