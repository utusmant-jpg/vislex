$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$workerEnv = Join-Path $repo '.venv-worker'
if (-not (Test-Path -LiteralPath $workerEnv)) { python -m venv $workerEnv }
$python = Join-Path $workerEnv 'Scripts\python.exe'
& $python -m pip install --disable-pip-version-check -r (Join-Path $repo 'workers\requirements.lock.txt')
if ($LASTEXITCODE -ne 0) { throw 'Worker dependency installation failed' }
& $python (Join-Path $repo 'scripts\download-model.py')
if ($LASTEXITCODE -ne 0) { throw 'Local transcription model installation failed' }
foreach ($model in @('small','minilm')) { & $python (Join-Path $repo 'scripts\download-model.py') --model $model; if ($LASTEXITCODE -ne 0) { throw "$model verification failed" } }
& $python (Join-Path $repo 'scripts\download-diarization.py')
if ($LASTEXITCODE -ne 0) { throw 'Diarization model verification failed' }
& $python -m PyInstaller --noconfirm --clean --onedir --name evidence-worker --add-data ((Join-Path $repo 'workers\models') + ';models') --collect-all scenedetect --collect-all sherpa_onnx --collect-data reportlab --collect-data faster_whisper --collect-all rapidocr_onnxruntime --distpath (Join-Path $repo 'src-tauri\resources\worker') --workpath (Join-Path $repo 'artifacts\worker-build') --specpath (Join-Path $repo 'artifacts') (Join-Path $repo 'workers\worker.py')
if ($LASTEXITCODE -ne 0) { throw 'Worker packaging failed' }
