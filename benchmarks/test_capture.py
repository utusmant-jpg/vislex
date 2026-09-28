from contextlib import closing
import json, sqlite3, tempfile, unittest
from pathlib import Path
from capture import capture
class CaptureTests(unittest.TestCase):
    def test_capture_refuses_running_and_restricted_sources(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'case.db'
            with closing(sqlite3.connect(path)) as db, db:
                db.executescript("CREATE TABLE tasks(id,prompt,status,answer,error,scope,created_at,updated_at); CREATE TABLE sources(id,restricted); CREATE TABLE actions(id,name,args,output,status,created_at,task_id); INSERT INTO sources VALUES('s',0); INSERT INTO tasks VALUES('t','synthetic','complete','answer','','[\"s\"]','now','now');")
            mapping=[{'incident_id':'i','repeat':1,'task_id':'t'}]
            self.assertEqual(capture(path,mapping,'synthetic')['captures'][0]['task']['answer'],'answer')
            with closing(sqlite3.connect(path)) as db, db:db.execute("INSERT INTO sources VALUES('other',1)")
            with self.assertRaises(ValueError):capture(path,mapping,'synthetic')
            with closing(sqlite3.connect(path)) as db, db:db.execute("DELETE FROM sources WHERE id='other'")
            with closing(sqlite3.connect(path)) as db, db:db.execute("UPDATE sources SET restricted=1")
            with self.assertRaises(ValueError):capture(path,mapping,'synthetic')
            with closing(sqlite3.connect(path)) as db, db:
                db.execute("UPDATE sources SET restricted=0");db.execute("UPDATE tasks SET status='running'")
            with self.assertRaises(ValueError):capture(path,mapping,'synthetic')
if __name__=='__main__':unittest.main()
