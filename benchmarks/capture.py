"""Capture completed local VisLex task outputs for independent benchmark adjudication.
Read-only SQLite access; no provider requests, credentials or automatic scoring.
"""
from contextlib import closing
import argparse, hashlib, json, sqlite3
from pathlib import Path
from datetime import datetime, timezone

def capture(database, mapping, configuration):
    uri=database.resolve().as_uri()+'?mode=ro'
    with closing(sqlite3.connect(uri,uri=True)) as db:
        db.row_factory=sqlite3.Row
        db.execute('BEGIN')
        captured=[]
        for item in mapping:
            task=db.execute('SELECT id,prompt,status,answer,error,scope,created_at,updated_at FROM tasks WHERE id=?',(item['task_id'],)).fetchone()
            if task is None or task['status'] in ('running','queued'):
                raise ValueError('Every mapped task must exist and be stopped')
            scope=json.loads(task['scope'])
            for source in scope:
                permission=db.execute('SELECT restricted FROM sources WHERE id=?',(source,)).fetchone()
                if permission is None or permission[0]: raise ValueError('Restricted or missing source prevents benchmark export')
            receipts=[dict(r) for r in db.execute('SELECT id,name,args,output,status,created_at FROM actions WHERE task_id=? ORDER BY created_at,rowid',(task['id'],))]
            captured.append({'incident_id':item['incident_id'],'repeat':item['repeat'],'task':dict(task),'receipts':receipts,'answer_sha256':hashlib.sha256(task['answer'].encode()).hexdigest(),'adjudication':'pending; do not score until independent review'})
        return {'schema_version':1,'captured_at':datetime.now(timezone.utc).isoformat(),'configuration':configuration,'captures':captured,'note':'Contains authorized case text. Not a redacted disclosure package. Cost and review effort must be measured separately; reserved budget is not billed cost.'}

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('database',type=Path);p.add_argument('mapping',type=Path);p.add_argument('--configuration',required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    result=capture(a.database,json.loads(a.mapping.read_text(encoding='utf-8-sig')),a.configuration)
    with a.output.open('x',encoding='utf-8') as f: json.dump(result,f,indent=2)
    print(f'Captured {len(result["captures"])} runs for adjudication; no quality score inferred.')
if __name__=='__main__':main()
