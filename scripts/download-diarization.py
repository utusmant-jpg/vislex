"""Install and verify public, pinned diarization model assets at build time."""
import hashlib,io,json,tarfile,urllib.request
from pathlib import Path
root=Path(__file__).resolve().parent.parent/'workers'
pin=json.loads((root/'diarization-model-manifest.json').read_text(encoding='utf-8'))
target=root/'models'/'diarization';target.mkdir(parents=True,exist_ok=True)
def verified():return all((target/n).is_file() and hashlib.sha256((target/n).read_bytes()).hexdigest()==h for n,h in pin['sha256'].items())
if not verified():
 for name,entry in pin['archives'].items():
  data=urllib.request.urlopen(entry['url'],timeout=90).read()
  if hashlib.sha256(data).hexdigest()!=entry['sha256']:raise ValueError('Model archive hash mismatch')
  if name.endswith('.bz2'):
   with tarfile.open(fileobj=io.BytesIO(data),mode='r:bz2') as archive:
    for member in archive.getmembers():
     basename=Path(member.name).name
     if member.isfile() and basename in pin['sha256']:(target/basename).write_bytes(archive.extractfile(member).read())
  else:(target/name).write_bytes(data)
if not verified():raise ValueError('Diarization model hash mismatch')
print('Pinned diarization models verified')
