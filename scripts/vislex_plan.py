"""Read-only implementation task navigator. Never edits state or executes task commands."""
from __future__ import annotations
import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATES = {'pending', 'in_progress', 'implemented', 'verified', 'blocked'}

def load_json(path: Path):
    if path.stat().st_size > 2_000_000:
        raise ValueError(f'Plan input exceeds 2 MB: {path.name}')
    return json.loads(path.read_text(encoding='utf-8'))

def validate(plan: dict, status: dict) -> dict:
    if plan.get('schema') != 1 or status.get('schema') != 1:
        raise ValueError('Unsupported plan/status schema')
    tasks = plan.get('tasks', [])
    if not tasks or len(tasks) > 100:
        raise ValueError('Expected 1-100 tasks')
    ids = [t['id'] for t in tasks]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate task ID')
    table = {t['id']: t for t in tasks}
    if set(status.get('tasks', {})) != set(table):
        raise ValueError('Plan/status task IDs differ')
    visiting, visited = set(), set()
    def walk(tid):
        if tid in visiting:
            raise ValueError('Cyclic task dependencies')
        if tid in visited:
            return
        visiting.add(tid)
        for dep in table[tid].get('depends_on', []):
            if dep not in table:
                raise ValueError(f'Unknown dependency {dep}')
            walk(dep)
        visiting.remove(tid)
        visited.add(tid)
    for task in tasks:
        for field in ('title', 'files', 'problem', 'changes', 'acceptance', 'tests'):
            if not task.get(field):
                raise ValueError(f'{task["id"]}: missing {field}')
        walk(task['id'])
        entry = status['tasks'][task['id']]
        if entry.get('state') not in STATES:
            raise ValueError(f'{task["id"]}: invalid state')
        if entry['state'] == 'verified':
            if not entry.get('evidence') or not entry.get('commit'):
                raise ValueError(f'{task["id"]}: verification needs evidence and commit')
            if any(status['tasks'][d]['state'] != 'verified' for d in task.get('depends_on', [])):
                raise ValueError(f'{task["id"]}: prerequisite not verified')
        if entry['state'] == 'blocked' and not entry.get('blocker'):
            raise ValueError(f'{task["id"]}: blocked state needs blocker')
    return table

def ready(plan: dict, status: dict) -> list:
    validate(plan, status)
    return [t for t in plan['tasks'] if status['tasks'][t['id']]['state'] in ('pending', 'in_progress')
            and all(status['tasks'][d]['state'] == 'verified' for d in t.get('depends_on', []))]

def git(*args):
    return subprocess.run(['git', '-C', str(ROOT), *args], check=True, capture_output=True,
                          timeout=20).stdout

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['check', 'next', 'packet', 'inventory'])
    parser.add_argument('task', nargs='?')
    args = parser.parse_args(argv)
    try:
        if args.command == 'inventory':
            # Metadata only. A tracked path is not a semantic code review.
            raw = git('ls-files', '-s', '-z')
            entries = []
            for row in raw.split(b'\0'):
                if not row:
                    continue
                meta, path = row.split(b'\t', 1)
                mode, blob, stage = meta.decode('ascii').split()
                entries.append({'path': path.decode('utf-8', errors='surrogateescape'),
                                'mode': mode, 'blob': blob, 'stage': stage, 'review': 'inventory_only'})
            print(json.dumps({'head': git('rev-parse', 'HEAD').decode().strip(),
                              'scope': 'git index metadata; working-tree changes require separate review',
                              'files': entries}, indent=2, ensure_ascii=True))
            return 0
        base = ROOT / 'docs/implementation'
        plan = load_json(base / 'NEXT-TASKS.json')
        status = load_json(base / 'NEXT-STATUS.json')
        table = validate(plan, status)
        if args.command == 'check':
            print(f'Plan structure valid: {len(table)} tasks. This does NOT verify application behavior.')
        elif args.command == 'next':
            eligible = ready(plan, status)
            for task in eligible:
                print(f'{task["id"]}: {task["title"]}')
            if not eligible:
                print('No ready tasks. Review implemented/blocked work; no automatic waiver.')
        else:
            if args.task not in table:
                raise ValueError('Choose a known task ID')
            task = table[args.task]
            print(json.dumps({'audit_base': plan['audit_base'], 'task': task,
                              'current_status': status['tasks'][args.task],
                              'prerequisites': {d: status['tasks'][d]['state'] for d in task.get('depends_on', [])},
                              'rules': 'Read relevant current source and callers; reproduce through production paths; preserve originals, permissions and review; run and record actual tests. Never treat this packet as proof a defect persists.'},
                             indent=2, ensure_ascii=False))
        return 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        print(f'Plan error: {exc}', file=sys.stderr)
        return 2

if __name__ == '__main__':
    raise SystemExit(main())
