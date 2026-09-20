"""Build-time model installation. Never invoked by the offline application."""
import hashlib
import json
import os
from pathlib import Path
os.environ['HF_HUB_DISABLE_XET'] = '1'
from huggingface_hub import snapshot_download

target = Path(__file__).resolve().parent.parent / 'workers' / 'models' / 'tiny'
target.mkdir(parents=True, exist_ok=True)
manifest = target / 'model-manifest.json'
if manifest.exists():
    record = json.loads(manifest.read_text())
    if all((target / filename).is_file() and hashlib.sha256((target / filename).read_bytes()).hexdigest() == expected for filename, expected in record['sha256'].items()):
        print('Tiny transcription model already verified.')
        raise SystemExit(0)
pin = json.loads((target.parent.parent / 'model-manifest.json').read_text(encoding='utf-8-sig'))
repo = pin['repository']
revision = pin['revision']
snapshot_download(repo, revision=revision, local_dir=target, token=False, allow_patterns=['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt', 'preprocessor_config.json', 'README.md'])
hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in target.iterdir() if p.is_file() and p.name != manifest.name}
if any(hashes.get(filename) != expected for filename, expected in pin['sha256'].items()):
    raise RuntimeError('Downloaded model does not match the committed manifest')
manifest.write_text(json.dumps({'repository': repo, 'revision': revision, 'sha256': hashes, 'purpose': 'Local CPU transcription, tiny multilingual model; machine output requires review'}, indent=2), encoding='utf-8')
print('Pinned model downloaded and checksummed.')
