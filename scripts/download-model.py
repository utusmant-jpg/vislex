"""Pinned build-time models; never downloads from the offline application."""
import argparse, hashlib, json, os
from pathlib import Path
os.environ['HF_HUB_DISABLE_XET'] = '1'
from huggingface_hub import snapshot_download
parser=argparse.ArgumentParser()
parser.add_argument('--model',choices=['tiny','small','minilm'],default='tiny')
name=parser.parse_args().model
root=Path(__file__).resolve().parent.parent/'workers'
pin=json.loads((root/{'tiny':'model-manifest.json','small':'small-model-manifest.json','minilm':'embedding-model-manifest.json'}[name]).read_text(encoding='utf-8-sig'))
target=root/'models'/name
def verified():
    return all((target/f).is_file() and hashlib.sha256((target/f).read_bytes()).hexdigest()==h for f,h in pin['sha256'].items())
if not verified():
    snapshot_download(pin['repository'],revision=pin['revision'],local_dir=target,token=False,allow_patterns=list(pin['sha256']))
if not verified():
    raise RuntimeError('Model does not match committed hashes')
(target/'model-manifest.json').write_text(json.dumps(pin,indent=2),encoding='utf-8')
print(f'{name} pinned model verified.')
