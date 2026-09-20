$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$fixtureDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'fixtures\generated'
New-Item -ItemType Directory -Force -Path $fixtureDir | Out-Null
$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $speech.SetOutputToWaveFile((Join-Path $fixtureDir 'synthetic-speech.wav'))
    $speech.Speak('This is a synthetic test. The witness reported a blue bag near the door. The time is uncertain.')
} finally { $speech.Dispose() }
