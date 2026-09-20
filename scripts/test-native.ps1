param([int]$Port = 9223)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
& npm.cmd exec --yes --package=agent-browser -- agent-browser connect $Port
if ($LASTEXITCODE -ne 0) { throw 'Launch the development app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 first.' }
$rootJson = ConvertTo-Json -Compress $repo
$script = 'window.__smokeRoot=' + $rootJson + ';' + (Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'native-smoke.js'))
$script | & npm.cmd exec --yes --package=agent-browser -- agent-browser eval --stdin
if ($LASTEXITCODE -ne 0) { throw 'Native synthetic smoke test failed' }
