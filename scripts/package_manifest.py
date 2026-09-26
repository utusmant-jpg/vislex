"""Create or verify a deterministic SHA-256 inventory of a packaged VisLex folder."""
import argparse
import hashlib
import json
from pathlib import Path

MANIFEST = 'package-manifest.json'


def inventory(root):
    if not root.is_dir() or root.is_symlink():
        raise ValueError('Package root must be a real directory')
    files = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError(f'Package contains a link: {path.relative_to(root)}')
        if not path.is_file() or path.name == MANIFEST and path.parent == root:
            continue
        relative = path.relative_to(root).as_posix()
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        files[relative] = {'size': path.stat().st_size, 'sha256': digest.hexdigest()}
    if not files:
        raise ValueError('Package is empty')
    return files


def write(root, commit):
    if not commit or any(c not in '0123456789abcdef' for c in commit.lower()) or len(commit) != 40:
        raise ValueError('Commit must be a full 40-character Git SHA')
    destination = root / MANIFEST
    if destination.exists():
        raise ValueError('Manifest already exists; remove only in a fresh build directory')
    record = {'schema_version': 1, 'commit': commit.lower(), 'files': inventory(root)}
    destination.write_text(json.dumps(record, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    return record


def verify(root):
    record = json.loads((root / MANIFEST).read_text(encoding='utf-8'))
    if record.get('schema_version') != 1 or not isinstance(record.get('files'), dict):
        raise ValueError('Invalid package manifest')
    actual = inventory(root)
    if actual != record['files']:
        missing = sorted(set(record['files']) - set(actual))
        extra = sorted(set(actual) - set(record['files']))
        changed = sorted(k for k in set(actual) & set(record['files']) if actual[k] != record['files'][k])
        raise ValueError(f'Package mismatch: missing={missing}, extra={extra}, changed={changed}')
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('write', 'verify'))
    parser.add_argument('root', type=Path)
    parser.add_argument('--commit', help='Full source commit SHA, required for write')
    args = parser.parse_args()
    try:
        record = write(args.root, args.commit) if args.mode == 'write' else verify(args.root)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        parser.exit(1, f'{error}\n')
    print(f'{args.mode}: {len(record["files"])} files, commit {record["commit"]}')


if __name__ == '__main__':
    main()
