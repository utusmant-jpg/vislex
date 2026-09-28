param([int]$Port=9395,[string]$BinaryPath='')
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$binary=if($BinaryPath){(Resolve-Path -LiteralPath $BinaryPath).Path}else{Join-Path $repo 'src-tauri\target\x86_64-pc-windows-msvc\debug\local-evidence-desk.exe'}
if(-not (Test-Path -LiteralPath $binary)){throw 'Build the debug desktop app first.'}
$fixture=Join-Path $repo 'artifacts\large-1g.bin'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $fixture) | Out-Null
if(-not (Test-Path -LiteralPath $fixture)){
    $buffer=New-Object byte[] (8MB)
    $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($buffer)
    $rng.Dispose()
    $stream=[System.IO.File]::Open($fixture,[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::Write,[System.IO.FileShare]::None)
    try {for($i=0;$i -lt 128;$i++){$stream.Write($buffer,0,$buffer.Length)}} finally {$stream.Dispose()}
}
if((Get-Item -LiteralPath $fixture).Length -ne 1GB){throw 'Synthetic large fixture has an unexpected size.'}
$diskBefore=(Get-PSDrive -Name C).Free
$env:VISLEX_TEST_MODE='1'
$env:VISLEX_TEST_CASE_ROOT = Join-Path $repo 'artifacts'
$env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $repo ('artifacts\large-webview-'+[Guid]::NewGuid().ToString())
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$Port"
$process=Start-Process -FilePath $binary -WindowStyle Hidden -PassThru
$monitor=Start-Job -ArgumentList $process.Id -ScriptBlock {
    param($appPid)
    $peakMain=0L
    $peakTree=0L
    while($true){
        $app=Get-Process -Id $appPid -ErrorAction SilentlyContinue
        if(-not $app){break}
        if($app.PrivateMemorySize64 -gt $peakMain){$peakMain=$app.PrivateMemorySize64}
        $ids=@($appPid)
        $frontier=@($appPid)
        for($depth=0;$depth -lt 4 -and $frontier.Count;$depth++){
            $next=@()
            foreach($parent in $frontier){
                $children=Get-CimInstance Win32_Process -Filter "ParentProcessId=$parent" -ErrorAction SilentlyContinue
                foreach($child in $children){$next+= [int]$child.ProcessId}
            }
            $ids+= $next
            $frontier=$next
        }
        $total=0L
        foreach($id in ($ids | Select-Object -Unique)){
            $candidate=Get-Process -Id $id -ErrorAction SilentlyContinue
            if($candidate){$total+=[long]$candidate.PrivateMemorySize64}
        }
        if($total -gt $peakTree){$peakTree=$total}
        Start-Sleep -Milliseconds 500
    }
    [pscustomobject]@{Main=$peakMain;Tree=$peakTree}
}
$nativeResult=$null
$peakMain=0L
$peakTree=0L
try {
    $ready=$false
    for($attempt=0;$attempt -lt 60;$attempt++){
        try{$null=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version";$ready=$true;break}catch{Start-Sleep -Milliseconds 300}
    }
    if(-not $ready){throw 'Native WebView debugging port did not start.'}
    $output=& node (Join-Path $PSScriptRoot 'native-cdp-eval.mjs') $Port (Join-Path $PSScriptRoot 'native-large-session.js') $repo (Join-Path $repo 'artifacts\native-large-session.png')
    if($LASTEXITCODE -ne 0){throw ($output -join "`n")}
    $result=$output | ConvertFrom-Json
    if($result.native_error){throw $result.native_error}
    $diskAfter=(Get-PSDrive -Name C).Free
    $result | Add-Member -NotePropertyName disk_bytes_consumed_after_fixture -NotePropertyValue ($diskBefore-$diskAfter)
    $nativeResult=$result
} finally {
    if(-not $process.HasExited){Stop-Process -Id $process.Id}
    $sample=Receive-Job -Job $monitor -Wait -ErrorAction SilentlyContinue | Select-Object -First 1
    if($sample){$peakMain=[long]$sample.Main;$peakTree=[long]$sample.Tree}
    Remove-Job -Job $monitor -Force -ErrorAction SilentlyContinue
    Remove-Item Env:VISLEX_TEST_MODE, Env:VISLEX_TEST_CASE_ROOT,Env:WEBVIEW2_USER_DATA_FOLDER,Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
}
if($nativeResult){
    $nativeResult | Add-Member -NotePropertyName peak_app_private_bytes -NotePropertyValue $peakMain
    $nativeResult | Add-Member -NotePropertyName peak_process_tree_private_bytes -NotePropertyValue $peakTree
    $nativeResult | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $repo 'artifacts\native-large-session.json')
    $nativeResult | ConvertTo-Json -Depth 8
}
