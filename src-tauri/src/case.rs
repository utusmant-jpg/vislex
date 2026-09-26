use anyhow::{bail, ensure, Context, Result};
use chrono::Utc;
use fs2::FileExt;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use uuid::Uuid;

pub fn id() -> String {
    Uuid::new_v4().to_string()
}
pub fn now() -> String {
    Utc::now().to_rfc3339()
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn file_hash(path: &Path) -> Result<String> {
    let mut f = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 1024 * 128];
    loop {
        let n = f.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
/// Cached INTERACTIVE hash for immutable case content (R07).
/// Originals and published artifacts are content-addressed and set read-only, so
/// (canonical path, length, mtime) identifies bytes already verified this session;
/// any replacement or in-place change alters length or mtime and forces a fresh
/// full hash. Keeps playback ranges, citation validation and cache reuse from
/// re-hashing multi-gigabyte originals on every request. This is a browsing
/// optimization, NOT strong verification: an in-place edit that preserves both
/// length and mtime evades it. Protected publication and explicit user
/// verification use `file_hash_strong`/`verify_source_strong` instead.
type InteractiveCache = std::collections::HashMap<PathBuf, (u64, std::time::SystemTime, String)>;
fn interactive_cache() -> &'static std::sync::Mutex<InteractiveCache> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<InteractiveCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(InteractiveCache::new()))
}

pub fn file_hash_cached(path: &Path) -> Result<String> {
    let metadata = fs::metadata(path)?;
    let modified = metadata.modified()?;
    let key = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if let Ok(guard) = interactive_cache().lock() {
        if let Some((len, stamp, hash)) = guard.get(&key) {
            if *len == metadata.len() && *stamp == modified {
                return Ok(hash.clone());
            }
        }
    }
    let hash = file_hash(path)?;
    if let Ok(mut guard) = interactive_cache().lock() {
        if guard.len() >= 4096 {
            guard.clear();
        }
        guard.insert(key, (metadata.len(), modified, hash.clone()));
    }
    Ok(hash)
}

/// Strong verification hash: always reads and hashes the full bytes, ignoring
/// and refreshing the shared interactive cache so later interactive reads see
/// the verified truth. Tamper-evident against same-length, mtime-preserving
/// in-place edits that the interactive cache cannot detect.
pub fn file_hash_strong(path: &Path) -> Result<String> {
    let hash = file_hash(path)?;
    let metadata = fs::metadata(path)?;
    let modified = metadata.modified()?;
    let key = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if let Ok(mut guard) = interactive_cache().lock() {
        guard.insert(key, (metadata.len(), modified, hash.clone()));
    }
    Ok(hash)
}

/// Clear the interactive hash cache. Called when a case is opened so cached
/// results never outlive the case session they were computed in.
pub fn clear_file_hash_cache() {
    if let Ok(mut guard) = interactive_cache().lock() {
        guard.clear();
    }
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Source {
    pub id: String,
    pub name: String,
    pub sha256: String,
    pub size: u64,
    pub mime: String,
    pub kind: String,
    pub status: String,
    pub restricted: bool,
    pub occurrences: i64,
    pub created_at: String,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Record {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub content: String,
    pub revision: i64,
    pub actor: String,
    pub review: String,
    pub protected: bool,
    pub stale: bool,
    pub updated_at: String,
    pub dependencies: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Settings {
    pub offline: bool,
    pub allow_text: bool,
    pub allow_images: bool,
    pub model: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            offline: true,
            allow_text: false,
            allow_images: false,
            model: String::new(),
        }
    }
}

pub struct Case {
    pub root: PathBuf,
    pub db: Connection,
    _lock: File,
}

const SCHEMA: &str = r#"
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,name TEXT NOT NULL,sha256 TEXT NOT NULL UNIQUE,size INTEGER NOT NULL,mime TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,restricted INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS occurrences(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),original_path TEXT NOT NULL,production TEXT NOT NULL,batch_id TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY,path TEXT NOT NULL,batch_id TEXT NOT NULL,status TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS extracts(source_id TEXT PRIMARY KEY REFERENCES sources(id),text TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,method TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(source_id UNINDEXED,name,text);
CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL,content TEXT NOT NULL,revision INTEGER NOT NULL,actor TEXT NOT NULL,review TEXT NOT NULL,protected INTEGER NOT NULL DEFAULT 0,stale INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,dependencies TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY,record_id TEXT NOT NULL REFERENCES records(id),revision INTEGER NOT NULL,content TEXT NOT NULL,title TEXT NOT NULL,actor TEXT NOT NULL,review TEXT NOT NULL,reason TEXT NOT NULL,task_id TEXT,dependencies TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(record_id,revision));
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,prompt TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,scope TEXT NOT NULL,edit_scope TEXT NOT NULL,budget REAL NOT NULL,reserved REAL NOT NULL DEFAULT 0,spent REAL NOT NULL DEFAULT 0,step INTEGER NOT NULL DEFAULT 0,history TEXT NOT NULL DEFAULT '[]',answer TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',generation INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),name TEXT NOT NULL,input TEXT NOT NULL,output TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS transmissions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),payload_hash TEXT NOT NULL,model TEXT NOT NULL,source_ids TEXT NOT NULL,reserved REAL NOT NULL,actual REAL,status TEXT NOT NULL,usage TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,previous_hash TEXT NOT NULL,hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS processing_jobs(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),kind TEXT NOT NULL,status TEXT NOT NULL,result TEXT NOT NULL,error TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),sha256 TEXT NOT NULL,mime TEXT NOT NULL,path TEXT NOT NULL,metadata TEXT NOT NULL,created_at TEXT NOT NULL);
PRAGMA user_version=2;
"#;

pub fn validate_local_root(path: &Path) -> Result<()> {
    ensure!(path.is_absolute(), "Choose an absolute local path");
    let raw = path.to_string_lossy().to_lowercase();
    let raw = raw.strip_prefix(r"\\?\").filter(|p|p.as_bytes().get(1)==Some(&b':') && p.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)).unwrap_or(&raw);
    ensure!(
        !raw.starts_with("\\\\") && !raw.starts_with("//"),
        "Network case locations are not supported"
    );
    for part in path.components() {
        let name = part.as_os_str().to_string_lossy().to_lowercase();
        ensure!(
            !name.starts_with("onedrive") && name != "dropbox" && name != "google drive",
            "Use a local folder outside synchronized storage"
        );
    }
    Ok(())
}

impl Case {
    pub fn create(root: &Path, name: &str) -> Result<Self> {
        clear_file_hash_cache();
        validate_local_root(root)?;
        ensure!(
            !name.trim().is_empty() && name.len() <= 200,
            "Enter a case name (up to 200 characters)"
        );
        ensure!(
            !root.exists() || root.read_dir()?.next().is_none(),
            "Create a case in an empty folder"
        );
        fs::create_dir_all(root)?;
        let mut c = Self::connect(root, true)?;
        c.set_meta("id", &id())?;
        c.set_meta("name", name.trim())?;
        c.set_meta("generation", "0")?;
        c.set_meta("settings", &serde_json::to_string(&Settings::default())?)?;
        c.audit("case_created", json!({"name":name}))?;
        Ok(c)
    }
    pub fn open(root: &Path) -> Result<Self> {
        clear_file_hash_cache();
        validate_local_root(root)?;
        ensure!(
            root.join("case.sqlite3").is_file(),
            "No case database found"
        );
        let c = Self::connect(root, false)?;
        ensure!(c.meta("id")?.is_some(), "Not an Evidence Desk case");
        c.db.execute("UPDATE tasks SET status='paused',error='Application stopped. Review activity before resuming.' WHERE status='running'", [])?;
        Ok(c)
    }
    fn connect(root: &Path, create: bool) -> Result<Self> {
        let root = root.canonicalize()?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("case.lock"))?;
        lock.try_lock_exclusive()
            .context("This case is already open in another instance")?;
        for dir in ["originals", "working", "staging", "artifacts"] {
            fs::create_dir_all(root.join(dir))?;
        }
        let db = Connection::open(root.join("case.sqlite3"))?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
        ensure!(version <= 7, "This case requires a newer application");
        if create {
            db.execute_batch(SCHEMA)?;
        } else {
            ensure!(version >= 1, "Unsupported case schema");
            db.execute_batch("PRAGMA foreign_keys=ON;")?;
            if version == 1 {
                db.backup(
                    rusqlite::DatabaseName::Main,
                    root.join("pre-migration-v1.sqlite3"),
                    None,
                )?;
                db.execute_batch("BEGIN; CREATE TABLE processing_jobs(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),kind TEXT NOT NULL,status TEXT NOT NULL,result TEXT NOT NULL,error TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TABLE artifacts(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),sha256 TEXT NOT NULL,mime TEXT NOT NULL,path TEXT NOT NULL,metadata TEXT NOT NULL,created_at TEXT NOT NULL); PRAGMA user_version=2; COMMIT;")?;
            }
        }
        if !create && version < 3 {
            db.backup(rusqlite::DatabaseName::Main, root.join("pre-migration-v2.sqlite3"), None)?;
        }
        db.execute_batch("CREATE TABLE IF NOT EXISTS conversation_tasks(task_id TEXT PRIMARY KEY REFERENCES tasks(id),conversation_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS hidden_conversations(id TEXT PRIMARY KEY); CREATE INDEX IF NOT EXISTS conversation_lookup ON conversation_tasks(conversation_id); CREATE INDEX IF NOT EXISTS tasks_created_id ON tasks(created_at DESC,id DESC); CREATE INDEX IF NOT EXISTS sources_created_id ON sources(created_at DESC,id DESC); CREATE INDEX IF NOT EXISTS records_updated_id ON records(updated_at DESC,id DESC); CREATE INDEX IF NOT EXISTS processing_jobs_source_kind ON processing_jobs(source_id,kind);")?;
        if version < 5 {
            if !create {
                let snapshot = if version < 4 { "pre-migration-v3.sqlite3" } else { "pre-migration-v4.sqlite3" };
                db.backup(rusqlite::DatabaseName::Main, root.join(snapshot), None)?;
            }
            crate::evidence::migrate(&db)?;
        }
        if version < 6 {
            // Immutable extraction revision history (schema 6). The extracts row
            // remains the single ACTIVE extraction for compatibility; every
            // publication appends a revision row first.
            if !create && version >= 2 {
                db.backup(rusqlite::DatabaseName::Main, root.join("pre-migration-v5.sqlite3"), None)?;
            }
            db.execute_batch(
                "BEGIN;
                CREATE TABLE IF NOT EXISTS extract_revisions(source_id TEXT NOT NULL REFERENCES sources(id),revision INTEGER NOT NULL,text TEXT NOT NULL,method TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(source_id,revision));
                INSERT OR IGNORE INTO extract_revisions(source_id,revision,text,method,created_at)
                    SELECT e.source_id,e.revision,e.text,e.method,s.created_at FROM extracts e JOIN sources s ON s.id=e.source_id;
                PRAGMA user_version=6;
                COMMIT;",
            )?;
        }
        if version < 7 {
            if !create && version >= 6 {db.backup(rusqlite::DatabaseName::Main,root.join("pre-migration-v6.sqlite3"),None)?;}
            db.execute_batch("BEGIN;
                CREATE TABLE IF NOT EXISTS job_schedule(
                    job_id TEXT PRIMARY KEY REFERENCES processing_jobs(id),
                    priority TEXT NOT NULL CHECK(priority IN ('interactive','background')),
                    attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt>=0),
                    input_revision TEXT NOT NULL,
                    dependency_job TEXT,
                    heartbeat TEXT,
                    cancel_reason TEXT,
                    updated_at TEXT NOT NULL
                );
                INSERT OR IGNORE INTO job_schedule(job_id,priority,attempt,input_revision,dependency_job,heartbeat,cancel_reason,updated_at)
                    SELECT j.id,CASE WHEN j.kind IN ('auto_prepare','full_audio','video_ocr_index','video_overview_index','video_ocr','video_overview','media_inventory') THEN 'background' ELSE 'interactive' END,
                        CASE WHEN j.status='queued' THEN 0 ELSE 1 END,s.sha256,NULL,CASE WHEN j.status='running' THEN j.created_at ELSE NULL END,
                        CASE WHEN j.status='cancelled' THEN substr(j.error,1,500) ELSE NULL END,j.created_at
                    FROM processing_jobs j JOIN sources s ON s.id=j.source_id;
                CREATE INDEX IF NOT EXISTS job_schedule_priority ON job_schedule(priority,updated_at,job_id);
                CREATE INDEX IF NOT EXISTS job_schedule_heartbeat ON job_schedule(heartbeat) WHERE heartbeat IS NOT NULL;
                CREATE TRIGGER IF NOT EXISTS job_schedule_insert AFTER INSERT ON processing_jobs BEGIN
                    INSERT INTO job_schedule(job_id,priority,attempt,input_revision,dependency_job,heartbeat,cancel_reason,updated_at)
                    VALUES(NEW.id,CASE WHEN NEW.kind IN ('auto_prepare','full_audio','video_ocr_index','video_overview_index','video_ocr','video_overview','media_inventory') THEN 'background' ELSE 'interactive' END,
                        CASE WHEN NEW.status='running' THEN 1 ELSE 0 END,(SELECT sha256 FROM sources WHERE id=NEW.source_id),NULL,
                        CASE WHEN NEW.status='running' THEN NEW.created_at ELSE NULL END,NULL,NEW.created_at);
                END;
                CREATE TRIGGER IF NOT EXISTS job_schedule_status AFTER UPDATE OF status ON processing_jobs BEGIN
                    UPDATE job_schedule SET attempt=attempt+CASE WHEN NEW.status='running' AND OLD.status<>'running' THEN 1 ELSE 0 END,
                        heartbeat=CASE WHEN NEW.status='running' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
                        cancel_reason=CASE WHEN NEW.status='cancelled' THEN substr(NEW.error,1,500) WHEN NEW.status IN ('queued','running') THEN NULL ELSE cancel_reason END,
                        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE job_id=NEW.id;
                END;
                PRAGMA user_version=7; COMMIT;")?;
        }
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY;",
        )?;
        db.execute("UPDATE processing_jobs SET status='interrupted',error='Application stopped during processing; retry explicitly' WHERE status='running'",[])?;
        let c = Self {
            root,
            db,
            _lock: lock,
        };
        c.verify_audit()?;
        Ok(c)
    }
    pub fn meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .db
            .query_row("SELECT value FROM meta WHERE key=?", [key], |r| r.get(0))
            .optional()?)
    }
    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.db.execute(
            "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
    pub fn generation(&self) -> Result<i64> {
        Ok(self
            .meta("generation")?
            .unwrap_or_else(|| "0".into())
            .parse()?)
    }
    pub fn settings(&self) -> Result<Settings> {
        Ok(serde_json::from_str(
            &self.meta("settings")?.context("Missing case settings")?,
        )?)
    }
    pub fn save_settings(&mut self, settings: Settings) -> Result<()> {
        ensure!(settings.model.len() <= 120, "Invalid model identifier");
        self.set_meta("settings", &serde_json::to_string(&settings)?)?;
        self.audit("policy_changed", serde_json::to_value(settings)?)?;
        Ok(())
    }
    pub fn audit(&mut self, event: &str, data: Value) -> Result<()> {
        let previous: String = self
            .db
            .query_row(
                "SELECT hash FROM audit ORDER BY seq DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or_default();
        let at = now();
        let data = data.to_string();
        let hash = digest(format!("{previous}\n{event}\n{at}\n{data}").as_bytes());
        self.db.execute(
            "INSERT INTO audit(event,data,created_at,previous_hash,hash) VALUES(?,?,?,?,?)",
            params![event, data, at, previous, hash],
        )?;
        Ok(())
    }
    pub fn verify_audit(&self) -> Result<()> {
        let mut stmt = self
            .db
            .prepare("SELECT event,data,created_at,previous_hash,hash FROM audit ORDER BY seq")?;
        let mut rows = stmt.query([])?;
        let mut last = String::new();
        while let Some(r) = rows.next()? {
            let event: String = r.get(0)?;
            let data: String = r.get(1)?;
            let at: String = r.get(2)?;
            let previous: String = r.get(3)?;
            let hash: String = r.get(4)?;
            ensure!(
                previous == last
                    && digest(format!("{previous}\n{event}\n{at}\n{data}").as_bytes()) == hash,
                "Audit history integrity check failed"
            );
            last = hash;
        }
        Ok(())
    }
    pub fn sources(&self) -> Result<Vec<Source>> {
        let mut stmt=self.db.prepare("SELECT s.id,s.name,s.sha256,s.size,s.mime,s.kind,s.status,s.restricted,(SELECT count(*) FROM occurrences o WHERE o.source_id=s.id),s.created_at FROM sources s ORDER BY s.created_at DESC")?;
        let rows = stmt.query_map([], |r| {
            Ok(Source {
                id: r.get(0)?,
                name: r.get(1)?,
                sha256: r.get(2)?,
                size: r.get(3)?,
                mime: r.get(4)?,
                kind: r.get(5)?,
                status: r.get(6)?,
                restricted: r.get(7)?,
                occurrences: r.get(8)?,
                created_at: r.get(9)?,
            })
        })?;
        let mut sources = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        for source in &mut sources {
            normalize_document_status(source);
            if !["audio", "video"].contains(&source.kind.as_str()) { continue; }
            let completed: Option<String> = self.db.query_row("SELECT result FROM processing_jobs WHERE source_id=? AND kind='full_audio' AND status='complete' ORDER BY created_at DESC LIMIT 1", [&source.id], |r| r.get(0)).optional()?;
            if let Some(result) = completed {
                let result: Value = serde_json::from_str(&result).unwrap_or(Value::Null);
                let record_exists = result["record_id"].as_str().is_some_and(|id| self.db.query_row("SELECT EXISTS(SELECT 1 FROM records WHERE id=?)", [id], |r| r.get::<_,bool>(0)).unwrap_or(false));
                source.status = if result["metadata"]["no_audio_tracks"] == true {
                    "no audio tracks · visual review pending".into()
                } else if record_exists {
                    "text transcribed · all audio tracks · unreviewed".into()
                } else { "transcript record missing · needs attention".into() };
            }
        }
        Ok(sources)
    }
    pub fn source(&self, source_id: &str) -> Result<Source> {
        let mut source = self.db.query_row(
            "SELECT s.id,s.name,s.sha256,s.size,s.mime,s.kind,s.status,s.restricted,(SELECT count(*) FROM occurrences o WHERE o.source_id=s.id),s.created_at FROM sources s WHERE s.id=?",
            [source_id], |r| Ok(Source { id:r.get(0)?, name:r.get(1)?, sha256:r.get(2)?, size:r.get(3)?, mime:r.get(4)?, kind:r.get(5)?, status:r.get(6)?, restricted:r.get(7)?, occurrences:r.get(8)?, created_at:r.get(9)? })
        ).optional()?.context("Source not found in this case")?;
        if ["audio", "video"].contains(&source.kind.as_str()) {
            let result: Option<String> = self.db.query_row("SELECT result FROM processing_jobs WHERE source_id=? AND kind='full_audio' AND status='complete' ORDER BY created_at DESC LIMIT 1", [source_id], |r| r.get(0)).optional()?;
            if let Some(result) = result {
                let result: Value = serde_json::from_str(&result).unwrap_or(Value::Null);
                let exists = result["record_id"].as_str().is_some_and(|id| self.db.query_row("SELECT EXISTS(SELECT 1 FROM records WHERE id=?)", [id], |r| r.get::<_,bool>(0)).unwrap_or(false));
                source.status = if result["metadata"]["no_audio_tracks"] == true { "no audio tracks · visual review pending" } else if exists { "text transcribed · all audio tracks · unreviewed" } else { "transcript record missing · needs attention" }.into();
            }
        }
        normalize_document_status(&mut source);
        Ok(source)
    }
    pub fn source_page(&self,before:Option<(&str,&str)>)->Result<Value> {
        let mut stmt=self.db.prepare("SELECT s.id,s.name,s.sha256,s.size,s.mime,s.kind,s.status,s.restricted,(SELECT count(*) FROM occurrences o WHERE o.source_id=s.id),s.created_at,j.result,EXISTS(SELECT 1 FROM records r WHERE r.id=json_extract(j.result,'$.record_id')) FROM sources s LEFT JOIN processing_jobs j ON j.rowid=(SELECT rowid FROM processing_jobs WHERE source_id=s.id AND kind='full_audio' AND status='complete' ORDER BY rowid DESC LIMIT 1) WHERE (?1 IS NULL OR s.created_at<?1 OR (s.created_at=?1 AND s.id<?2)) ORDER BY s.created_at DESC,s.id DESC LIMIT 51")?;
        let mut sources=stmt.query_map(params![before.map(|value|value.0),before.map(|value|value.1)],|r| {
            let mut source=Source{id:r.get(0)?,name:r.get(1)?,sha256:r.get(2)?,size:r.get(3)?,mime:r.get(4)?,kind:r.get(5)?,status:r.get(6)?,restricted:r.get(7)?,occurrences:r.get(8)?,created_at:r.get(9)?};
            if let Some(raw)=r.get::<_,Option<String>>(10)? {
                let result=serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null);
                source.status=if result["metadata"]["no_audio_tracks"]==true {"no audio tracks · visual review pending"} else if r.get::<_,bool>(11)? {"text transcribed · all audio tracks · unreviewed"} else {"transcript record missing · needs attention"}.into();
            }
            normalize_document_status(&mut source);
            Ok(source)
        })?.collect::<std::result::Result<Vec<_>,_>>()?;
        let more=sources.len()>50;sources.truncate(50);
        let next_cursor=if more {sources.last().map(|source|json!({"created_at":source.created_at,"id":source.id}))}else{None};
        Ok(json!({"sources":sources,"next_cursor":next_cursor}))
    }
    pub fn source_path(&self, source_id: &str) -> Result<PathBuf> {
        let s = self.source(source_id)?;
        ensure!(
            s.sha256.len() == 64 && s.sha256.chars().all(|c| c.is_ascii_hexdigit()),
            "Invalid source hash"
        );
        let root = self.root.join("originals").canonicalize()?;
        let path = root
            .join(&s.sha256)
            .canonicalize()
            .context("Original is missing")?;
        ensure!(
            path.starts_with(&root),
            "Original path escaped case storage"
        );
        Ok(path)
    }
    /// Interactive verification: may reuse a session hash keyed by path, size
    /// and mtime. Fast for browsing and citations; not tamper-proof against
    /// same-size, mtime-preserving edits.
    pub fn verify_source(&self, source_id: &str) -> Result<PathBuf> {
        let s = self.source(source_id)?;
        let path = self.source_path(source_id)?;
        ensure!(
            file_hash_cached(&path)? == s.sha256,
            "Original bytes changed: integrity check failed"
        );
        Ok(path)
    }
    /// Strong verification: full fresh byte hash, never the interactive cache.
    /// Used by explicit user verification and every protected publication path
    /// (export, backup, artifact reuse, direct-media transmission).
    pub fn verify_source_strong(&self, source_id: &str) -> Result<PathBuf> {
        let s = self.source(source_id)?;
        let path = self.source_path(source_id)?;
        ensure!(
            file_hash_strong(&path)? == s.sha256,
            "Original bytes changed: strong integrity check failed"
        );
        Ok(path)
    }
    /// Append an immutable extraction revision. Never activates or reindexes.
    pub fn record_extract_revision(&self, source_id: &str, text: &str, method: &str) -> Result<i64> {
        let revision: i64 = self.db.query_row(
            "SELECT COALESCE(MAX(revision),0)+1 FROM extract_revisions WHERE source_id=?",
            [source_id],
            |r| r.get(0),
        )?;
        self.db.execute(
            "INSERT INTO extract_revisions VALUES(?,?,?,?,?)",
            params![source_id, revision, text, method, now()],
        )?;
        Ok(revision)
    }
    /// Record a new immutable extraction revision and optionally make it the
    /// ACTIVE searchable extraction (the extracts row plus both FTS indexes).
    /// Activation bumps the case generation and marks dependent records stale so
    /// downstream work cannot silently rely on the previous wording. Returns the
    /// new revision number; callers decide supersession policy.
    pub fn publish_extract(&mut self, source_id: &str, text: &str, method: &str, activate: bool) -> Result<i64> {
        let name = self.source(source_id)?.name;
        let revision = self.record_extract_revision(source_id, text, method)?;
        if activate {
            let tx = self.db.savepoint()?;
            tx.execute(
                "INSERT INTO extracts(source_id,text,revision,method) VALUES(?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET text=excluded.text,revision=excluded.revision,method=excluded.method",
                params![source_id, text, revision, method],
            )?;
            tx.execute("DELETE FROM source_fts WHERE source_id=?", [source_id])?;
            tx.execute("INSERT INTO source_fts(source_id,name,text) VALUES(?,?,?)", params![source_id, name, text])?;
            tx.execute("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='generation'", [])?;
            tx.execute("UPDATE records SET stale=1 WHERE actor<>'processor' OR kind<>'transcript'", [])?;
            tx.commit()?;
        }
        Ok(revision)
    }
    /// Immutable extraction history for a source, newest first.
    pub fn extract_history(&self, source_id: &str) -> Result<Value> {
        self.source(source_id)?;
        let mut stmt = self.db.prepare(
            "SELECT revision,method,created_at,length(text) FROM extract_revisions WHERE source_id=? ORDER BY revision DESC",
        )?;
        let rows = stmt.query_map([source_id], |r| {
            Ok(json!({"revision":r.get::<_,i64>(0)?,"method":r.get::<_,String>(1)?,"created_at":r.get::<_,String>(2)?,"characters":r.get::<_,i64>(3)?}))
        })?;
        let revisions = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        let active: Option<i64> = self.db.query_row("SELECT revision FROM extracts WHERE source_id=?", [source_id], |r| r.get(0)).optional()?;
        Ok(json!({"source_id":source_id,"active_revision":active,"revisions":revisions}))
    }
    /// Read lines of a historical extraction revision (immutable wording).
    pub fn read_text_revision(&self, source_id: &str, revision: i64, start: usize, count: usize) -> Result<Value> {
        self.source(source_id)?;
        let text: String = self.db.query_row(
            "SELECT text FROM extract_revisions WHERE source_id=? AND revision=?",
            params![source_id, revision],
            |r| r.get(0),
        ).optional()?.context("Unknown extraction revision")?;
        ensure!(start >= 1 && count > 0 && count <= 200, "Request 1–200 lines starting at line 1 or later");
        let lines: Vec<_> = text.lines().collect();
        ensure!(start <= lines.len().max(1), "Line outside revision");
        let end = (start - 1 + count).min(lines.len());
        // Same long-line bound and truncation reporting as the active-text read
        // path, so a pathological single-line revision cannot balloon payloads.
        let window = &lines[start - 1..end];
        Ok(json!({"source_id":source_id,"revision":revision,"start":start,"end":end,"total_lines":lines.len(),"text":window.iter().map(|s|s.chars().take(2000).collect::<String>()).collect::<Vec<_>>().join("\n"),"historical":true,"truncated_long_lines":window.iter().any(|s|s.chars().count()>2000),"locator":format!("evidence:{source_id}#R{revision}L{start}-L{end}")}))
    }
    pub fn import_files(&mut self, paths: &[String], production: &str) -> Result<Value> {
        ensure!(
            paths.len() <= 10000,
            "Import at most 10,000 files per batch"
        );
        let batch = id();
        let mut result = Vec::new();
        for path in paths {
            let item = self.import_one(Path::new(path), production, &batch);
            let (status, detail) = match &item {
                Ok(v) => ("imported", v.to_string()),
                Err(e) => ("failed", e.to_string()),
            };
            self.db.execute(
                "INSERT INTO imports VALUES(?,?,?,?,?,?)",
                params![id(), path, batch, status, detail, now()],
            )?;
            result.push(json!({"path":path,"status":status,"detail":item.unwrap_or_else(|e|json!({"error":e.to_string()}))}));
        }
        self.audit("import_batch", json!({"batch":batch,"items":result}))?;
        Ok(json!({"batch":batch,"items":result}))
    }
    fn import_one(&mut self, path: &Path, production: &str, batch: &str) -> Result<Value> {
        let prepared=prepare_import(&self.root,path)?;
        self.publish_import(prepared,production,batch)
    }
    pub fn publish_import(&mut self,prepared:PreparedImport,production:&str,batch:&str)->Result<Value> {
        let PreparedImport {path,stage,size,name,sha}=prepared;
        ensure!(stage.parent()==Some(self.root.join("staging").as_path()),"Import belongs to a different case");
        let existing: Option<String> = self
            .db
            .query_row("SELECT id FROM sources WHERE sha256=?", [&sha], |r| {
                r.get(0)
            })
            .optional()?;
        let duplicate = existing.is_some();
        let source_id = existing.unwrap_or_else(id);
        if !duplicate {
            let mut head = [0u8; 8192];
            let mut f = File::open(&stage)?;
            let n = f.read(&mut head)?;
            let ext = path
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            let mime = infer::get(&head[..n])
                .map(|v| v.mime_type().to_owned())
                .unwrap_or_else(|| {
                    if ["txt", "md", "csv", "json", "log", "vtt", "srt"].contains(&ext.as_str()) {
                        "text/plain".into()
                    } else {
                        "application/octet-stream".into()
                    }
                });
            let kind = if mime.starts_with("image/") {
                "image"
            } else if mime.starts_with("video/") {
                "video"
            } else if mime.starts_with("audio/") {
                "audio"
            } else if mime == "application/pdf" {
                "pdf"
            } else if mime == "text/plain" {
                "text"
            } else {
                "other"
            };
            let text = if kind == "text" && size <= 10 * 1024 * 1024 {
                fs::read_to_string(&stage).ok()
            } else {
                None
            };
            let status = if text.is_some() {
                "text indexed"
            } else if ["image", "video", "audio", "pdf"].contains(&kind) || ["docx","xlsx","pptx","odt"].contains(&ext.as_str()) {
                "viewer available · extraction pending"
            } else {
                "unsupported · preserved"
            };
            let target = self.root.join("originals").join(&sha);
            if target.exists() {
                ensure!(
                    file_hash(&target)? == sha,
                    "Existing artifact failed integrity check"
                );
                fs::remove_file(&stage)?;
            } else {
                fs::rename(&stage, &target)?;
            }
            let mut permissions = fs::metadata(&target)?.permissions();
            permissions.set_readonly(true);
            fs::set_permissions(&target, permissions)?;
            let tx = self.db.transaction()?;
            tx.execute("INSERT INTO sources(id,name,sha256,size,mime,kind,status,created_at) VALUES(?,?,?,?,?,?,?,?)",params![source_id,name,sha,size,mime,kind,status,now()])?;
            if let Some(text) = &text {
                tx.execute(
                    "INSERT INTO extracts(source_id,text,method) VALUES(?,?,'UTF-8 native text')",
                    params![source_id, text],
                )?;
                tx.execute(
                    "INSERT INTO extract_revisions VALUES(?,?,?,?,?)",
                    params![source_id, 1, text, "UTF-8 native text", now()],
                )?;
            }
            tx.execute(
                "INSERT INTO source_fts(source_id,name,text) VALUES(?,?,?)",
                params![source_id, name, text.unwrap_or_default()],
            )?;
            tx.execute(
                "UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='generation'",
                [],
            )?;
            tx.execute("UPDATE records SET stale=1 WHERE actor<>'processor' OR kind<>'transcript'", [])?;
            tx.commit()?;
        } else {
            fs::remove_file(&stage)?;
        }
        self.db.execute(
            "INSERT INTO occurrences VALUES(?,?,?,?,?,?)",
            params![
                id(),
                source_id,
                path.to_string_lossy(),
                production,
                batch,
                now()
            ],
        )?;
        Ok(json!({"source_id":source_id,"duplicate":duplicate,"sha256":sha}))
    }
    pub fn set_restricted(&mut self, source_id: &str, restricted: bool) -> Result<()> {
        self.source(source_id)?;
        if restricted {
            crate::processing::invalidate_source_lease(&self.root,source_id);
            let mut query=self.db.prepare("SELECT id FROM processing_jobs WHERE source_id=? AND status='running'")?;
            let active=query.query_map([source_id],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
            drop(query);
            for job in active {let _=crate::processing::cancel(self,&job);}
        }
        self.db.execute(
            "UPDATE sources SET restricted=? WHERE id=?",
            params![restricted, source_id],
        )?;
        let key=format!("source_policy_epoch:{source_id}");
        let epoch=self.meta(&key)?.and_then(|raw|raw.parse::<u64>().ok()).unwrap_or(0).saturating_add(1);
        self.set_meta(&key,&epoch.to_string())?;
        self.db.execute("UPDATE records SET stale=1 WHERE actor<>'processor' OR kind<>'transcript'", [])?;
        self.audit(
            "source_restriction",
            json!({"source":source_id,"restricted":restricted}),
        )
    }
    pub fn read_text(&self, source_id: &str, start: usize, count: usize) -> Result<Value> {
        self.verify_source(source_id)?;
        let (text, revision): (String, i64) = self
            .db
            .query_row(
                "SELECT text,revision FROM extracts WHERE source_id=?",
                [source_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .context("No text extraction exists. Source is preserved; processing is pending.")?;
        ensure!(
            start >= 1 && count > 0 && count <= 200,
            "Request 1–200 lines starting at line 1 or later"
        );
        let lines: Vec<_> = text.lines().collect();
        ensure!(start <= lines.len().max(1), "Line outside source");
        let end = (start - 1 + count).min(lines.len());
        Ok(
            json!({"source_id":source_id,"revision":revision,"start":start,"end":end,"total_lines":lines.len(),"text":lines[start-1..end].iter().map(|s|s.chars().take(2000).collect::<String>()).collect::<Vec<_>>().join("\n"),"locator":format!("evidence:{source_id}#R{revision}L{start}-L{end}"),"truncated_long_lines":lines[start-1..end].iter().any(|s|s.chars().count()>2000)}),
        )
    }
    pub fn search(&self, query: &str, offset: usize) -> Result<Value> {
        ensure!(query.len() <= 1000, "Search query too long");
        if query.trim().is_empty() {
            return Ok(json!({"results":[],"total":0}));
        }
        // Quote terms so raw punctuation and FTS operators cannot break the MATCH query.
        let query = query.split_whitespace().take(12).map(|t| format!("\"{}\"", t.replace('"', "\"\""))).collect::<Vec<_>>().join(" OR ");
        let mut stmt=self.db.prepare("SELECT source_id,name,snippet(source_fts,2,'[',']',' … ',24),bm25(source_fts) FROM source_fts WHERE source_fts MATCH ? ORDER BY bm25(source_fts) LIMIT 51 OFFSET ?")?;
        let rows=stmt.query_map(params![query,offset],|r|Ok(json!({"source_id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"excerpt":r.get::<_,String>(2)?,"score":r.get::<_,f64>(3)?})))?;
        let mut results: Vec<_> = rows.collect::<std::result::Result<_, _>>()?;
        let more = results.len() > 50;
        results.truncate(50);
        Ok(
            json!({"results":results,"next_offset":if more {Some(offset+50)}else{None},"scope":"Native text and filenames only; unprocessed media is not searched"}),
        )
    }
    pub fn records(&self) -> Result<Vec<Record>> {
        let mut stmt=self.db.prepare("SELECT id,title,kind,content,revision,actor,review,protected,stale,updated_at,dependencies FROM records ORDER BY updated_at DESC")?;
        let rows = stmt.query_map([], |r| {
            Ok(Record {
                id: r.get(0)?,
                title: r.get(1)?,
                kind: r.get(2)?,
                content: r.get(3)?,
                revision: r.get(4)?,
                actor: r.get(5)?,
                review: r.get(6)?,
                protected: r.get(7)?,
                stale: if r.get::<_,String>(5)?=="processor" && r.get::<_,String>(2)?=="transcript" { false } else { r.get(8)? },
                updated_at: r.get(9)?,
                dependencies: serde_json::from_str(&r.get::<_, String>(10)?).unwrap_or_default(),
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn record_summaries(&self) -> Result<Vec<Value>> {
        let mut stmt=self.db.prepare("SELECT id,title,kind,revision,actor,review,protected,stale,updated_at,dependencies FROM records ORDER BY updated_at DESC,id DESC")?;
        let rows=stmt.query_map([],|r|{
            let kind:String=r.get(2)?;let actor:String=r.get(4)?;
            Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"kind":kind,"revision":r.get::<_,i64>(3)?,"actor":actor,"review":r.get::<_,String>(5)?,"protected":r.get::<_,bool>(6)?,"stale":if actor=="processor"&&kind=="transcript"{false}else{r.get::<_,bool>(7)?},"updated_at":r.get::<_,String>(8)?,"dependencies":serde_json::from_str::<Value>(&r.get::<_,String>(9)?).unwrap_or(json!([]))}))
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>,_>>()?)
    }
    pub fn record_page(&self,before:Option<(&str,&str)>)->Result<Value> {
        let mut stmt=self.db.prepare("SELECT id,title,kind,revision,actor,review,protected,stale,updated_at,dependencies FROM records WHERE (?1 IS NULL OR updated_at<?1 OR (updated_at=?1 AND id<?2)) ORDER BY updated_at DESC,id DESC LIMIT 51")?;
        let mut records=stmt.query_map(params![before.map(|value|value.0),before.map(|value|value.1)],|r|{
            let kind:String=r.get(2)?;let actor:String=r.get(4)?;
            Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"kind":kind,"revision":r.get::<_,i64>(3)?,"actor":actor,"review":r.get::<_,String>(5)?,"protected":r.get::<_,bool>(6)?,"stale":if actor=="processor"&&kind=="transcript"{false}else{r.get::<_,bool>(7)?},"updated_at":r.get::<_,String>(8)?,"dependencies":serde_json::from_str::<Value>(&r.get::<_,String>(9)?).unwrap_or(json!([]))}))
        })?.collect::<std::result::Result<Vec<_>,_>>()?;
        let more=records.len()>50;records.truncate(50);
        let next_cursor=if more {records.last().map(|record|json!({"updated_at":record["updated_at"],"id":record["id"]}))}else{None};
        Ok(json!({"records":records,"next_cursor":next_cursor}))
    }
    pub fn record_summary(&self,id:&str)->Result<Value> {
        let mut stmt=self.db.prepare("SELECT id,title,kind,revision,actor,review,protected,stale,updated_at,dependencies FROM records WHERE id=?")?;
        stmt.query_row([id],|r|{
            let kind:String=r.get(2)?;let actor:String=r.get(4)?;
            Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"kind":kind,"revision":r.get::<_,i64>(3)?,"actor":actor,"review":r.get::<_,String>(5)?,"protected":r.get::<_,bool>(6)?,"stale":if actor=="processor"&&kind=="transcript"{false}else{r.get::<_,bool>(7)?},"updated_at":r.get::<_,String>(8)?,"dependencies":serde_json::from_str::<Value>(&r.get::<_,String>(9)?).unwrap_or(json!([]))}))
        }).map_err(Into::into)
    }
    pub fn record(&self, record_id: &str) -> Result<Record> {
        self.db
            .query_row(
                "SELECT id,title,kind,content,revision,actor,review,protected,stale,updated_at,dependencies FROM records WHERE id=?",
                [record_id],
                |r| {
                    let actor: String = r.get(5)?;
                    let kind: String = r.get(2)?;
                    let processor_transcript = actor=="processor" && kind=="transcript";
                    Ok(Record {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        kind,
                        content: r.get(3)?,
                        revision: r.get(4)?,
                        actor,
                        review: r.get(6)?,
                        protected: r.get(7)?,
                        stale: if processor_transcript { false } else { r.get(8)? },
                        updated_at: r.get(9)?,
                        dependencies: serde_json::from_str(&r.get::<_, String>(10)?).unwrap_or_default(),
                    })
                },
            )
            .optional()?
            .context("Working record not found")
    }
    #[allow(clippy::too_many_arguments)]
    pub fn write_record(
        &mut self,
        record_id: Option<&str>,
        base: i64,
        title: &str,
        kind: &str,
        content: &str,
        actor: &str,
        reason: &str,
        task: Option<&str>,
        dependencies: Vec<String>,
    ) -> Result<Record> {
        ensure!(
            !title.trim().is_empty() && title.len() <= 200,
            "Title is required (up to 200 characters)"
        );
        ensure!(
            content.len() <= 1024 * 1024,
            "Working files are limited to 1 MiB"
        );
        ensure!(
            [
                "note",
                "report",
                "claim",
                "event",
                "person",
                "issue",
                "transcript",
                "clock",
                "script"
            ]
            .contains(&kind),
            "Unknown record kind"
        );
        ensure!(!reason.trim().is_empty(), "A change reason is required");
        for d in &dependencies {
            self.source(d)?;
        }
        let previous = record_id.map(|i| self.record(i)).transpose()?;
        if let Some(r) = &previous {
            ensure!(
                r.revision == base,
                "This file changed. Reload before saving."
            );
            ensure!(
                !r.protected || actor == "human",
                "This record is protected from agent edits"
            );
            ensure!(r.kind == kind, "Record kind cannot change");
        } else {
            ensure!(base == 0, "New records require base revision 0");
        }
        let record_id = previous.as_ref().map(|r| r.id.clone()).unwrap_or_else(id);
        let revision = base + 1;
        let at = now();
        let deps = serde_json::to_string(&dependencies)?;
        let tx = self.db.savepoint()?;
        tx.execute("INSERT INTO records(id,title,kind,content,revision,actor,review,updated_at,dependencies) VALUES(?,?,?,?,?,?,'unreviewed',?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,revision=excluded.revision,actor=excluded.actor,review='unreviewed',stale=0,updated_at=excluded.updated_at,dependencies=excluded.dependencies",params![record_id,title,kind,content,revision,actor,at,deps])?;
        tx.execute(
            "INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            params![
                id(),
                record_id,
                revision,
                content,
                title,
                actor,
                "unreviewed",
                reason,
                task,
                deps,
                at
            ],
        )?;
        tx.execute("UPDATE records SET stale=1 WHERE (actor<>'processor' OR kind<>'transcript') AND id<>?", [&record_id])?;
        tx.commit()?;
        self.audit("record_revision",json!({"record":record_id,"revision":revision,"actor":actor,"reason":reason,"task":task}))?;
        self.record(&record_id)
    }
    pub fn review_record(
        &mut self,
        record_id: &str,
        revision: i64,
        protect: Option<bool>,
    ) -> Result<()> {
        let r = self.record(record_id)?;
        ensure!(
            r.revision == revision,
            "Record changed; review the latest revision"
        );
        if let Some(protected) = protect {
            self.db.execute(
                "UPDATE records SET protected=? WHERE id=?",
                params![protected, record_id],
            )?;
        } else {
            ensure!(
                !r.stale,
                "Recheck stale content and save a new revision before review"
            );
            self.db.execute(
                "UPDATE records SET review='human-reviewed' WHERE id=?",
                [record_id],
            )?;
            self.db.execute(
                "UPDATE revisions SET review='human-reviewed' WHERE record_id=? AND revision=?",
                params![record_id, revision],
            )?;
        }
        self.audit(
            "review_decision",
            json!({"record":record_id,"revision":revision,"protected":protect}),
        )
    }
    pub fn rollback(&mut self, record_id: &str, target: i64, base: i64) -> Result<Record> {
        let current = self.record(record_id)?;
        let (title, content, deps): (String, String, String) = self.db.query_row(
            "SELECT title,content,dependencies FROM revisions WHERE record_id=? AND revision=?",
            params![record_id, target],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        self.write_record(
            Some(record_id),
            base,
            &title,
            &current.kind,
            &content,
            "human",
            &format!("Restore revision {target}"),
            None,
            serde_json::from_str(&deps)?,
        )
    }
    pub fn revisions(&self, record_id: &str) -> Result<Value> {
        let mut stmt=self.db.prepare("SELECT revision,content,title,actor,review,reason,task_id,created_at FROM revisions WHERE record_id=? ORDER BY revision DESC")?;
        let rows=stmt.query_map([record_id],|r|Ok(json!({"revision":r.get::<_,i64>(0)?,"content":r.get::<_,String>(1)?,"title":r.get::<_,String>(2)?,"actor":r.get::<_,String>(3)?,"review":r.get::<_,String>(4)?,"reason":r.get::<_,String>(5)?,"task_id":r.get::<_,Option<String>>(6)?,"created_at":r.get::<_,String>(7)?})))?;
        Ok(json!(rows.collect::<std::result::Result<Vec<_>, _>>()?))
    }
    pub fn delete_conversation(&mut self, conversation: &str, deleted: bool) -> Result<()> {
        let (total,running):(i64,i64)=self.db.query_row("SELECT count(*),COALESCE(SUM(status='running'),0) FROM tasks WHERE COALESCE((SELECT conversation_id FROM conversation_tasks WHERE task_id=tasks.id),id)=?",[conversation],|r|Ok((r.get(0)?,r.get(1)?)))?;
        ensure!(total>0,"Conversation not found");
        ensure!(running==0,"Stop the active reply before deleting this chat");
        if deleted {self.db.execute("INSERT OR IGNORE INTO hidden_conversations VALUES(?)",[conversation])?;}else{self.db.execute("DELETE FROM hidden_conversations WHERE id=?",[conversation])?;}
        self.audit("conversation_visibility",json!({"conversation":conversation,"deleted":deleted}))?;
        Ok(())
    }
    pub fn rename(&mut self, kind: &str, target: &str, name: &str) -> Result<()> {
        let name = name.trim();
        ensure!(!name.is_empty() && name.chars().count() <= 240 && !name.chars().any(char::is_control), "Enter a name of 1–240 characters");
        match kind {
            "case" => self.set_meta("name", name)?,
            "source" => {
                let source = self.source(target)?;
                let extension = Path::new(&source.name).extension().and_then(|e|e.to_str());
                let name = match extension {
                    Some(ext) if !name.to_lowercase().ends_with(&format!(".{}",ext.to_lowercase())) => format!("{name}.{ext}"),
                    _ => name.to_string(),
                };
                ensure!(self.db.execute("UPDATE sources SET name=? WHERE id=?", params![name,target])? == 1, "Source not found");
                self.db.execute("UPDATE source_fts SET name=? WHERE source_id=?", params![name,target])?;
                self.db.execute("UPDATE passage_fts SET title=? WHERE kind='source' AND object_id=?", params![name,target])?;
            },
            "chat" => {
                let exists: bool = self.db.query_row("SELECT EXISTS(SELECT 1 FROM tasks WHERE COALESCE((SELECT conversation_id FROM conversation_tasks WHERE task_id=tasks.id),id)=?)", [target], |r| r.get(0))?;
                ensure!(exists, "Chat not found");
                self.set_meta(&format!("chat_title:{target}"), name)?;
            },
            _ => anyhow::bail!("Unsupported rename target"),
        }
        self.audit("display_name_changed", json!({"kind":kind,"target":target,"name":name}))?;
        Ok(())
    }
    pub fn storage_usage(&self) -> Result<Value> {
        fn bytes(root: &Path) -> Result<u64> {
            let mut total = 0;
            let mut directories = vec![root.to_path_buf()];
            while let Some(directory) = directories.pop() {
                for entry in fs::read_dir(directory)? {
                    let entry = entry?;
                    let metadata = fs::symlink_metadata(entry.path())?;
                    #[cfg(windows)]
                    { use std::os::windows::fs::MetadataExt; if metadata.file_attributes() & 0x400 != 0 { continue; } }
                    if metadata.file_type().is_symlink() { continue; }
                    if metadata.is_dir() { directories.push(entry.path()); }
                    else if metadata.is_file() { total += metadata.len(); }
                }
            }
            Ok(total)
        }
        Ok(json!({"originals":bytes(&self.root.join("originals"))?,"staging":bytes(&self.root.join("staging"))?,"artifacts":bytes(&self.root.join("artifacts"))?,"working":bytes(&self.root.join("working"))?}))
    }
    /// Reclaim only abandoned root-level import copies with a verified managed original.
    /// Unknown staging files and all job directories are retained.
    pub fn reclaim_staging(&mut self) -> Result<Value> {
        let active: i64 = self.db.query_row("SELECT (SELECT count(*) FROM tasks WHERE status='running') + (SELECT count(*) FROM processing_jobs WHERE status IN ('queued','running'))", [], |r|r.get(0))?;
        ensure!(active == 0, "Stop active tasks and finish or cancel queued jobs before cleanup");
        let staging = self.root.join("staging").canonicalize()?;
        ensure!(staging.starts_with(&self.root), "Staging escaped case storage");
        let mut reclaimed = 0u64;
        let mut files = Vec::new();
        for entry in fs::read_dir(&staging)? {
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            if !metadata.is_file() || metadata.file_type().is_symlink() || uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_err() { continue; }
            #[cfg(windows)]
            { use std::os::windows::fs::MetadataExt; if metadata.file_attributes() & 0x400 != 0 { continue; } }
            let path = entry.path().canonicalize()?;
            ensure!(path.parent() == Some(staging.as_path()), "Staged file escaped storage");
            let hash = file_hash(&path)?;
            let source: Option<String> = self.db.query_row("SELECT id FROM sources WHERE sha256=?", [&hash], |r|r.get(0)).optional()?;
            if let Some(source) = source {
                self.verify_source(&source)?;
                let mut permissions = metadata.permissions();
                permissions.set_readonly(false);
                fs::set_permissions(&path, permissions)?;
                fs::remove_file(&path)?;
                reclaimed += metadata.len();
                files.push(json!({"file":entry.file_name().to_string_lossy(),"source_id":source,"sha256":hash}));
            }
        }
        // Terminal jobs (complete or cancelled) no longer offer recovery through
        // resume() and their staged copies are dead weight; reclaim their private
        // directories. Failed and interrupted jobs are retained for explicit resume.
        let terminal_jobs: Vec<String> = {
            let mut stmt=self.db.prepare("SELECT id FROM processing_jobs WHERE status IN ('complete','cancelled')")?;
            let rows=stmt.query_map([],|r|r.get(0))?;
            rows.collect::<std::result::Result<Vec<_>,_>>()?
        };
        let mut directories = Vec::new();
        for job_id in terminal_jobs {
            let Some(relative)=self.meta(&format!("processing_staging:{job_id}"))? else { continue };
            if !safe_relative(Path::new(&relative)) { continue; }
            let (Ok(path),Ok(staging_root))=(self.root.join(&relative).canonicalize(),self.root.join("staging").canonicalize()) else { continue; };
            if !path.starts_with(staging_root) { continue; }
            let Ok(metadata)=fs::symlink_metadata(&path) else { continue; };
            if !metadata.is_dir() || metadata.file_type().is_symlink() { continue; }
            let mut directory_bytes = 0u64;
            let mut stack = vec![path.clone()];
            while let Some(directory) = stack.pop() {
                for entry in fs::read_dir(&directory)? {
                    let entry = entry?;
                    let entry_metadata = fs::symlink_metadata(entry.path())?;
                    if entry_metadata.is_dir() { stack.push(entry.path()); }
                    else if entry_metadata.is_file() { directory_bytes += entry_metadata.len(); }
                }
            }
            fs::remove_dir_all(&path)?;
            self.db.execute("DELETE FROM meta WHERE key=?", params![format!("processing_staging:{job_id}")])?;
            reclaimed += directory_bytes;
            directories.push(json!({"job":job_id,"directory":relative,"bytes":directory_bytes}));
        }
        let receipt = json!({"reclaimed_bytes":reclaimed,"files":files,"job_directories":directories});
        self.audit("verified_staging_duplicates_reclaimed",receipt.clone())?;
        Ok(receipt)
    }
    pub fn import_folder(&mut self, folder: &Path, production: &str) -> Result<Value> {
        let (paths,skipped)=folder_paths(&self.root,folder)?;
        let mut receipt = self.import_files(&paths, production)?;
        receipt["skipped"] = json!(skipped);
        Ok(receipt)
    }
    pub fn task_page(&self,before:Option<(&str,&str)>)->Result<Value> {
        let mut stmt=self.db.prepare("SELECT t.id,substr(t.prompt,1,500),t.mode,t.status,t.step,substr(t.answer,1,200),substr(t.error,1,300),t.generation,t.created_at,(SELECT COALESCE(SUM(json_extract(usage,'$.input_tokens')),0) FROM transmissions WHERE task_id=t.id),(SELECT COALESCE(SUM(json_extract(usage,'$.output_tokens')),0) FROM transmissions WHERE task_id=t.id),COALESCE(ct.conversation_id,t.id),length(t.answer)>200,m.value FROM tasks t LEFT JOIN conversation_tasks ct ON ct.task_id=t.id LEFT JOIN meta m ON m.key='chat_title:'||COALESCE(ct.conversation_id,t.id) WHERE t.id NOT IN (SELECT task_id FROM agent_assignments) AND COALESCE(ct.conversation_id,t.id) NOT IN (SELECT id FROM hidden_conversations) AND (?1 IS NULL OR t.created_at<?1 OR (t.created_at=?1 AND t.id<?2)) ORDER BY t.created_at DESC,t.id DESC LIMIT 51")?;
        let mut tasks=stmt.query_map(params![before.map(|value|value.0),before.map(|value|value.1)],|r|Ok(json!({"id":r.get::<_,String>(0)?,"prompt":r.get::<_,String>(1)?,"mode":r.get::<_,String>(2)?,"status":r.get::<_,String>(3)?,"step":r.get::<_,i64>(4)?,"answer":r.get::<_,String>(5)?,"error":r.get::<_,String>(6)?,"generation":r.get::<_,i64>(7)?,"created_at":r.get::<_,String>(8)?,"input_tokens":r.get::<_,i64>(9)?,"output_tokens":r.get::<_,i64>(10)?,"conversation_id":r.get::<_,String>(11)?,"answer_truncated":r.get::<_,bool>(12)?,"title":r.get::<_,Option<String>>(13)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let more=tasks.len()>50;tasks.truncate(50);
        let next_cursor=if more {tasks.last().map(|task|json!({"created_at":task["created_at"],"id":task["id"]}))}else{None};
        Ok(json!({"tasks":tasks,"next_cursor":next_cursor}))
    }
    pub fn conversation_detail(&self,conversation:&str,before:Option<(&str,&str)>)->Result<Value> {
        ensure!(!self.db.query_row("SELECT EXISTS(SELECT 1 FROM hidden_conversations WHERE id=?)",[conversation],|r|r.get::<_,bool>(0))?,"Conversation is hidden");
        let mut stmt=self.db.prepare("SELECT t.id,t.prompt,t.mode,t.status,t.step,t.answer,t.error,t.generation,t.created_at,(SELECT COALESCE(SUM(json_extract(usage,'$.input_tokens')),0) FROM transmissions WHERE task_id=t.id),(SELECT COALESCE(SUM(json_extract(usage,'$.output_tokens')),0) FROM transmissions WHERE task_id=t.id) FROM tasks t LEFT JOIN conversation_tasks ct ON ct.task_id=t.id WHERE COALESCE(ct.conversation_id,t.id)=?1 AND t.id NOT IN (SELECT task_id FROM agent_assignments) AND (?2 IS NULL OR t.created_at<?2 OR (t.created_at=?2 AND t.id<?3)) ORDER BY t.created_at DESC,t.id DESC LIMIT 51")?;
        let mut tasks=stmt.query_map(params![conversation,before.map(|value|value.0),before.map(|value|value.1)],|r|Ok(json!({"id":r.get::<_,String>(0)?,"prompt":r.get::<_,String>(1)?,"mode":r.get::<_,String>(2)?,"status":r.get::<_,String>(3)?,"step":r.get::<_,i64>(4)?,"answer":r.get::<_,String>(5)?,"error":r.get::<_,String>(6)?,"generation":r.get::<_,i64>(7)?,"created_at":r.get::<_,String>(8)?,"input_tokens":r.get::<_,i64>(9)?,"output_tokens":r.get::<_,i64>(10)?,"conversation_id":conversation})))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let has_older=tasks.len()>50;tasks.truncate(50);
        for task in &mut tasks {task["progress"]=serde_json::to_value(crate::review_progress::load(self,task["id"].as_str().unwrap_or_default())?)?;task["title"]=json!(self.meta(&format!("chat_title:{conversation}"))?);}
        let next_cursor=if has_older {tasks.last().map(|task|json!({"created_at":task["created_at"],"id":task["id"]}))}else{None};
        Ok(json!({"tasks":tasks,"has_older":has_older,"next_cursor":next_cursor}))
    }
    pub fn case_summary(&self)->Result<Value> {
        let (source_count,record_count,task_count,job_count):(i64,i64,i64,i64)=self.db.query_row("SELECT (SELECT count(*) FROM sources),(SELECT count(*) FROM records),(SELECT count(*) FROM tasks),(SELECT count(*) FROM processing_jobs)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
        let audit_seq:i64=self.db.query_row("SELECT COALESCE(MAX(seq),0) FROM audit",[],|r|r.get(0))?;
        let action_rowid:i64=self.db.query_row("SELECT COALESCE(MAX(rowid),0) FROM actions",[],|r|r.get(0))?;
        let transmission_rowid:i64=self.db.query_row("SELECT COALESCE(MAX(rowid),0) FROM transmissions",[],|r|r.get(0))?;
        let task_update:String=self.db.query_row("SELECT COALESCE(MAX(updated_at),'') FROM tasks",[],|r|r.get(0))?;
        let (tasks_running,tasks_paused,tasks_complete):(i64,i64,i64)=self.db.query_row("SELECT COALESCE(SUM(status='running'),0),COALESCE(SUM(status='paused'),0),COALESCE(SUM(status='complete'),0) FROM tasks",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        let (queued,running,failed,complete):(i64,i64,i64,i64)=self.db.query_row("SELECT COALESCE(SUM(status='queued'),0),COALESCE(SUM(status='running'),0),COALESCE(SUM(status IN ('failed','interrupted')),0),COALESCE(SUM(status='complete'),0) FROM processing_jobs",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
        let source_bytes:i64=self.db.query_row("SELECT COALESCE(SUM(size),0) FROM sources",[],|r|r.get(0))?;
        let jobs_attention:i64=self.db.query_row("SELECT count(*) FROM processing_jobs j WHERE j.status IN ('failed','interrupted') AND NOT EXISTS(SELECT 1 FROM processing_jobs newer WHERE newer.source_id=j.source_id AND newer.kind=j.kind AND newer.rowid>j.rowid) AND NOT EXISTS(SELECT 1 FROM processing_jobs parent WHERE parent.source_id=j.source_id AND parent.kind IN ('video_ocr_index','video_overview_index') AND (json_extract(parent.result,'$.active_job')=j.id OR json_extract(parent.result,'$.last_failed_job')=j.id))",[],|r|r.get(0))?;
        let viewer_request=self.meta("viewer_request")?.map(|value|digest(value.as_bytes()));
        Ok(json!({"case_id":self.meta("id")?,"generation":self.generation()?,"audit_seq":audit_seq,"action_rowid":action_rowid,"transmission_rowid":transmission_rowid,"viewer_request_hash":viewer_request,"task_update":task_update,"tasks_running":tasks_running,"tasks_paused":tasks_paused,"tasks_complete":tasks_complete,"source_count":source_count,"source_bytes":source_bytes,"record_count":record_count,"task_count":task_count,"job_count":job_count,"jobs_queued":queued,"jobs_running":running,"jobs_failed":failed,"jobs_attention":jobs_attention,"jobs_complete":complete,"chat_pause":crate::automatic::chat_pause_reason(self)?}))
    }
    pub fn job_page(&self,before:Option<i64>)->Result<Value> {
        let mut stmt=self.db.prepare("SELECT j.id,j.source_id,s.name,j.kind,j.status,substr(j.error,1,500),j.created_at,(EXISTS(SELECT 1 FROM processing_jobs newer WHERE newer.source_id=j.source_id AND newer.kind=j.kind AND newer.rowid>j.rowid) OR EXISTS(SELECT 1 FROM processing_jobs parent JOIN processing_jobs newer ON newer.source_id=parent.source_id AND newer.kind=parent.kind AND newer.rowid>parent.rowid WHERE parent.source_id=j.source_id AND parent.kind IN ('video_ocr_index','video_overview_index') AND (json_extract(parent.result,'$.active_job')=j.id OR json_extract(parent.result,'$.last_failed_job')=j.id))),(SELECT parent.id FROM processing_jobs parent WHERE parent.source_id=j.source_id AND parent.kind IN ('video_ocr_index','video_overview_index') AND (json_extract(parent.result,'$.active_job')=j.id OR json_extract(parent.result,'$.last_failed_job')=j.id) ORDER BY parent.rowid DESC LIMIT 1),j.rowid FROM processing_jobs j JOIN sources s ON s.id=j.source_id WHERE (?1 IS NULL OR j.rowid<?1) ORDER BY j.rowid DESC LIMIT 51")?;
        let mut jobs=stmt.query_map([before],|r|Ok(json!({"id":r.get::<_,String>(0)?,"source_id":r.get::<_,String>(1)?,"name":r.get::<_,String>(2)?,"kind":r.get::<_,String>(3)?,"status":r.get::<_,String>(4)?,"error":r.get::<_,String>(5)?,"created_at":r.get::<_,String>(6)?,"superseded":r.get::<_,bool>(7)?,"parent_run_id":r.get::<_,Option<String>>(8)?,"cursor":r.get::<_,i64>(9)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let more=jobs.len()>50;jobs.truncate(50);
        let next_cursor=if more {jobs.last().and_then(|job|job["cursor"].as_i64())}else{None};
        for job in &mut jobs {job.as_object_mut().unwrap().remove("cursor");}
        Ok(json!({"jobs":jobs,"next_cursor":next_cursor}))
    }
    pub fn job_progress(&self,job_id:&str)->Result<Value> {
        uuid::Uuid::parse_str(job_id)?;
        let (kind,status,result,priority,attempt,heartbeat):(String,String,String,String,i64,Option<String>)=self.db.query_row(
            "SELECT j.kind,j.status,j.result,s.priority,s.attempt,s.heartbeat FROM processing_jobs j JOIN job_schedule s ON s.job_id=j.id WHERE j.id=?",
            [job_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)))?;
        let progress=if ["video_ocr_index","video_overview_index"].contains(&kind.as_str()) {
            let state:Value=serde_json::from_str(&result)?;
            json!({"unit":"seconds indexed","completed":state["next_start"]})
        } else if kind=="full_audio" {
            let path=self.root.join("staging").join(format!("transcript-{job_id}")).join("progress.json");
            let within_staging=path.canonicalize().ok().zip(self.root.join("staging").canonicalize().ok()).is_some_and(|(file,staging)|file.starts_with(staging));
            if within_staging && path.metadata().is_ok_and(|metadata|metadata.len()<=65536) && fs::symlink_metadata(&path).is_ok_and(|metadata|!metadata.file_type().is_symlink()) {
                fs::read(&path).ok().and_then(|raw|serde_json::from_slice::<Value>(&raw).ok()).map(|value|json!({"unit":"seconds processed","completed":value["processed_seconds"],"total":value["estimated_seconds"],"segments":value["segments"],"track":value["track_number"],"tracks":value["track_count"]})).unwrap_or(Value::Null)
            }else{Value::Null}
        }else{Value::Null};
        Ok(json!({"job_id":job_id,"kind":kind,"status":status,"priority":priority,"attempt":attempt,"heartbeat":heartbeat,"progress":progress}))
    }
    pub fn attention_job_page(&self,before:Option<i64>)->Result<Value> {
        let mut stmt=self.db.prepare("SELECT j.id,j.source_id,s.name,j.kind,j.status,substr(j.error,1,500),j.created_at,j.rowid FROM processing_jobs j JOIN sources s ON s.id=j.source_id WHERE j.status IN ('failed','interrupted') AND (?1 IS NULL OR j.rowid<?1) AND NOT EXISTS(SELECT 1 FROM processing_jobs newer WHERE newer.source_id=j.source_id AND newer.kind=j.kind AND newer.rowid>j.rowid) AND NOT EXISTS(SELECT 1 FROM processing_jobs parent WHERE parent.source_id=j.source_id AND parent.kind IN ('video_ocr_index','video_overview_index') AND (json_extract(parent.result,'$.active_job')=j.id OR json_extract(parent.result,'$.last_failed_job')=j.id)) ORDER BY j.rowid DESC LIMIT 51")?;
        let mut jobs=stmt.query_map([before],|r|Ok(json!({"id":r.get::<_,String>(0)?,"source_id":r.get::<_,String>(1)?,"name":r.get::<_,String>(2)?,"kind":r.get::<_,String>(3)?,"status":r.get::<_,String>(4)?,"error":r.get::<_,String>(5)?,"created_at":r.get::<_,String>(6)?,"superseded":false,"parent_run_id":Value::Null,"cursor":r.get::<_,i64>(7)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let more=jobs.len()>50;jobs.truncate(50);
        let next_cursor=if more {jobs.last().and_then(|job|job["cursor"].as_i64())}else{None};
        for job in &mut jobs {job.as_object_mut().unwrap().remove("cursor");}
        Ok(json!({"jobs":jobs,"next_cursor":next_cursor}))
    }
    pub fn snapshot(&self) -> Result<Value> {
        let tasks=self.task_page(None)?["tasks"].clone();
        let job_page=self.job_page(None)?;
        let attention_page=self.attention_job_page(None)?;
        let source_page=self.source_page(None)?;
        let record_page=self.record_page(None)?;
        let jobs=job_page["jobs"].clone();
        let mut issues = self.db.prepare("SELECT a.task_id,a.name,a.output,COUNT(*),(SELECT last.id FROM actions last WHERE last.status='failed' AND last.task_id=a.task_id AND last.name=a.name AND last.output=a.output ORDER BY last.rowid DESC LIMIT 1),MAX(a.created_at) FROM actions a WHERE a.status='failed' GROUP BY a.task_id,a.name,a.output ORDER BY MAX(a.rowid) DESC LIMIT 100")?;
        let issues = issues.query_map([], |r| {let output=serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(Value::Null);Ok(json!({"task_id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"error":output["error"].as_str().unwrap_or("Tool failed; open the receipt for details"),"count":r.get::<_,i64>(3)?,"latest_receipt":r.get::<_,String>(4)?,"created_at":r.get::<_,String>(5)?}))})?.collect::<std::result::Result<Vec<_>,_>>()?;
        Ok(
            json!({"automatic_analysis":crate::automatic::status(self)?,"ai_config":crate::providers::load(self)?,"jobs":jobs,"job_next_cursor":job_page["next_cursor"],"attention_jobs":attention_page["jobs"],"attention_next_cursor":attention_page["next_cursor"],"issues":issues,"id":self.meta("id")?,"name":self.meta("name")?,"root":self.root,"generation":self.generation()?,"sources":source_page["sources"],"source_next_cursor":source_page["next_cursor"],"records":record_page["records"],"record_next_cursor":record_page["next_cursor"],"counts":self.case_summary()?,"settings":self.settings()?,"tasks":tasks,"viewer_request":self.meta("viewer_request")?.and_then(|v|serde_json::from_str::<Value>(&v).ok())}),
        )
    }
    pub fn actions(&self, task: &str) -> Result<Value> {
        let mut stmt=self.db.prepare("SELECT id,name,input,output,status,created_at FROM actions WHERE task_id=? ORDER BY created_at")?;
        let rows=stmt.query_map([task],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"input":r.get::<_,String>(2)?,"output":r.get::<_,String>(3)?,"status":r.get::<_,String>(4)?,"created_at":r.get::<_,String>(5)?})))?;
        Ok(json!(rows.collect::<std::result::Result<Vec<_>, _>>()?))
    }
    pub fn issue_history(&self, receipt: &str, offset: u64) -> Result<Value> {
        let (task,name,output):(String,String,String)=self.db.query_row(
            "SELECT task_id,name,output FROM actions WHERE id=? AND status='failed'",
            [receipt],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))
        )?;
        let mut stmt=self.db.prepare("SELECT id,created_at FROM actions WHERE task_id=? AND name=? AND output=? AND status='failed' ORDER BY rowid DESC LIMIT 51 OFFSET ?")?;
        let mut rows=stmt.query_map(rusqlite::params![task,name,output,offset.min(i64::MAX as u64) as i64],|r|Ok(json!({"id":r.get::<_,String>(0)?,"created_at":r.get::<_,String>(1)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let more=rows.len()>50;rows.truncate(50);
        Ok(json!({"receipts":rows,"next_offset":if more{Some(offset+50)}else{None}}))
    }
    pub fn validate_citation(&self, citation: &str) -> Result<Value> {
        let rest = citation
            .strip_prefix("evidence:")
            .context("Citation must start with evidence:")?;
        let (source_id, loc) = rest
            .split_once('#')
            .context("Citation requires an exact locator")?;
        let s = self.source(source_id)?;
        // Which immutable extraction revision the line bounds resolve against.
        // `R<rev>L a-b` pins the revision; bare `L a-b` is the legacy/active-text
        // form (a navigation address whose meaning moves with the active row).
        let mut revision_binding = "active-text";
        let mut pinned_revision: Option<i64> = None;
        if let Some(artifact_id) = loc.strip_prefix("artifact:") {
            let (owner, _, _, _) = crate::processing::artifact(self, artifact_id)?;
            ensure!(owner == source_id, "Artifact belongs to another source");
        } else if loc == "media" {
            ensure!(["audio","video"].contains(&s.kind.as_str()),"Source is not media");self.verify_source(source_id)?;
        } else if loc == "image" {
            ensure!(s.kind == "image", "Source is not an image");
            self.verify_source(source_id)?;
        } else if let Some(lines) = loc.strip_prefix('R') {
            let (rev, rest) = lines.split_once('L').context("Use R2L1-L3 syntax")?;
            let rev = canonical_locator_number(rev).context("Use R2L1-L3 syntax")?;
            ensure!(rev >= 1, "Invalid extraction revision");
            let (a, b) = rest.split_once("-L").context("Use R2L1-L3 syntax")?;
            let a = canonical_locator_number(a).context("Use R2L1-L3 syntax")? as usize;
            let b = canonical_locator_number(b).context("Use R2L1-L3 syntax")? as usize;
            ensure!(b >= a && b - a < 200, "Invalid line interval");
            // Pinned citations verify the original bytes exactly like the
            // legacy form does; the wording itself is checked against the
            // immutable revision below.
            self.verify_source(source_id)?;
            let result = self.read_text_revision(source_id, rev as i64, a, b - a + 1)?;
            ensure!(
                result["end"].as_u64() == Some(b as u64),
                "Citation extends beyond extraction revision"
            );
            revision_binding = "pinned";
            pinned_revision = Some(rev as i64);
        } else if let Some(lines) = loc.strip_prefix('L') {
            let (a, b) = lines.split_once("-L").context("Use L1-L3 syntax")?;
            let a: usize = a.parse()?;
            let b: usize = b.parse()?;
            ensure!(b >= a && b - a < 200, "Invalid line interval");
            let result = self.read_text(source_id, a, b - a + 1)?;
            ensure!(
                result["end"].as_u64() == Some(b as u64),
                "Citation extends beyond source"
            );
            pinned_revision = result["revision"].as_i64();
        } else {
            bail!("This locator type is not implemented yet");
        }
        Ok(
            json!({"valid":true,"source_id":source_id,"name":s.name,"citation":citation,"revision":pinned_revision,"revision_binding":revision_binding,"support":"Locator verified; evidentiary support requires review"}),
        )
    }
    pub fn export_record(&mut self, record_id: &str, destination: &Path) -> Result<()> {
        let r = self.record(record_id)?;
        ensure!(!destination.exists(), "Choose a new export filename");
        ensure!(
            !destination
                .parent()
                .context("No parent")?
                .canonicalize()?
                .starts_with(&self.root),
            "Export outside the active case"
        );
        for dep in &r.dependencies {
            ensure!(
                !self.source(dep)?.restricted,
                "Export blocked: restricted source dependency"
            );
        }
        let ext = destination
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        let body = if ext == "json" {
            serde_json::to_string_pretty(
                &json!({"format_version":1,"record":r,"exported_at":now(),"status":"DRAFT — no disclosure sanitization"}),
            )?
        } else {
            ensure!(ext == "md" || ext == "txt", "Use .md, .txt, or .json");
            format!("# {}\n\nDRAFT · {} · revision {} · stale: {}\n\n{}\n\nExported {}. Evidence links require this case. Not a sanitized disclosure package.\n",r.title,r.review,r.revision,r.stale,r.content,now())
        };
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        file.write_all(body.as_bytes())?;
        file.sync_all()?;
        self.audit(
            "draft_export",
            json!({"record":record_id,"revision":r.revision,"hash":digest(body.as_bytes())}),
        )
    }
    pub fn export_record_at_revision(&mut self, record_id: &str, expected_revision: i64, destination: &Path) -> Result<()> {
        ensure!(self.record(record_id)?.revision == expected_revision, "Record changed since export was selected; refresh and try again");
        self.export_record(record_id, destination)
    }
}

/// Permanently delete an entire case folder after explicit confirmation.
/// Fails closed unless the folder is a real case database, the confirmation
/// repeats the case name, and the exclusive case lock is free — so a case open
/// in this or another instance can never be removed underneath a live session
/// (the caller closes the open case first). Read-only attributes on preserved
/// originals are cleared during the removal walk; reparse points and symlinks
/// are unlinked, never traversed.
pub fn delete_case(root: &Path, confirm: &str) -> Result<Value> {
    ensure!(root.is_absolute(), "Choose an absolute local path");
    ensure!(root.is_dir(), "Case folder not found");
    ensure!(
        root.join("case.sqlite3").is_file(),
        "No case database found; this is not a case folder"
    );
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join("case.lock"))?;
    lock.try_lock_exclusive().context(
        "This case is open in another window. Close it there before deleting.",
    )?;
    let db = Connection::open(root.join("case.sqlite3"))?;
    let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
    ensure!(version <= 7, "This case requires a newer application");
    let name: String = db
        .query_row("SELECT value FROM meta WHERE key='name'", [], |r| r.get(0))
        .optional()
        .map_err(|_| anyhow::anyhow!("Not an Evidence Desk case"))?
        .context("Not an Evidence Desk case")?;
    let sources: i64 = db.query_row("SELECT count(*) FROM sources", [], |r| r.get(0))?;
    let records: i64 = db.query_row("SELECT count(*) FROM records", [], |r| r.get(0))?;
    drop(db);
    ensure!(
        confirm.trim().eq_ignore_ascii_case(name.trim()),
        "Type the case name exactly to confirm deletion"
    );
    // Clear the read-only flag on content-addressed originals so removal can
    // proceed. Reparse points are skipped here and unlink — never follow —
    // inside remove_dir_all.
    let mut bytes = 0u64;
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            #[cfg(windows)]
            { use std::os::windows::fs::MetadataExt; if metadata.file_attributes() & 0x400 != 0 { continue; } }
            if metadata.file_type().is_symlink() { continue; }
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                bytes += metadata.len();
                let mut permissions = metadata.permissions();
                permissions.set_readonly(false);
                let _ = fs::set_permissions(entry.path(), permissions);
            }
        }
    }
    fs::remove_dir_all(root).context(
        "Case folder could not be fully removed; close any program using these files and retry",
    )?;
    Ok(json!({"deleted":true,"name":name,"sources":sources,"records":records,"bytes":bytes}))
}

pub fn safe_relative(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path.components().all(|c| matches!(c, Component::Normal(_)))
        && !path.to_string_lossy().contains(':')
        && !path.to_string_lossy().contains('\\')
}

/// Canonical nonnegative integer for serialized citation locators: ASCII digits
/// only, no sign and no leading zeros, so one location has exactly one spelling
/// on both the Rust and TypeScript grammars.
pub fn canonical_locator_number(text: &str) -> Option<u64> {
    if text.is_empty()
        || text.len() > 18
        || !text.bytes().all(|b| b.is_ascii_digit())
        || text.starts_with('0')
    {
        return None;
    }
    text.parse().ok()
}

/// Prepared outside the database writer lock. Fields remain private to the importer.
pub struct PreparedImport {path:PathBuf,stage:PathBuf,size:u64,name:String,sha:String}
impl PreparedImport {
    /// Trusted-adapter ingest: stage already-verified in-memory bytes for the case
    /// publisher. Only adapters that themselves produced these bytes from a validated
    /// external source (public-authority retrieval) may use this constructor; it never
    /// accepts an external filesystem path, so the user-facing guard against importing
    /// files from inside the active case is not bypassed.
    pub fn from_verified_bytes(root:&Path,bytes:&[u8],name:&str,origin:&str)->Result<Self> {
        let stage=root.join("staging").join(id());
        let staged=(||->Result<()>{
            let mut file=OpenOptions::new().write(true).create_new(true).open(&stage)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            Ok(())
        })();
        if let Err(e)=staged {let _=fs::remove_file(&stage);return Err(e);}
        Ok(Self{path:PathBuf::from(origin),stage,size:bytes.len() as u64,name:name.into(),sha:digest(bytes)})
    }
    /// Remove the staged copy if publication did not consume it.
    pub fn discard(&self) { let _=fs::remove_file(&self.stage); }
}
pub fn prepare_import(root:&Path,path:&Path)->Result<PreparedImport> {
        ensure!(
            !fs::symlink_metadata(path)?.file_type().is_symlink(),
            "Symbolic-link imports are not supported"
        );
        let path = path.canonicalize()?;
        ensure!(
            path.is_file(),
            "Select individual files; directory import is not yet supported"
        );
        ensure!(
            !path.starts_with(root),
            "Do not import case internals"
        );
        let size = path.metadata()?.len();
        let name = path
            .file_name()
            .context("Missing filename")?
            .to_string_lossy()
            .into_owned();
        let stage = root.join("staging").join(id());
        let copied = (|| -> Result<String> {
            let mut input = File::open(&path)?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&stage)?;
            std::io::copy(&mut input, &mut output)?;
            output.sync_all()?;
            let hash = file_hash(&stage)?;
            ensure!(
                stage.metadata()?.len() == size && file_hash(&path)? == hash,
                "Source changed while copying; retry import"
            );
            Ok(hash)
        })();
        let sha = match copied {
            Ok(s) => s,
            Err(e) => {
                let _ = fs::remove_file(&stage);
                return Err(e);
            }
        };
    Ok(PreparedImport {path,stage,size,name,sha})
}
pub fn folder_paths(case_root:&Path,folder:&Path)->Result<(Vec<String>,Vec<Value>)> {
        ensure!(folder.is_dir(), "Choose an existing folder");
        let root = folder.canonicalize()?;
        ensure!(!root.starts_with(case_root) && !root.join("case.sqlite3").exists(), "Do not import case internals");
        let mut pending = vec![root];
        let mut paths = Vec::new();
        let mut skipped = Vec::new();
        let mut visited = std::collections::HashSet::new();
        while let Some(dir) = pending.pop() {
            let resolved = dir.canonicalize()?;
            if resolved.starts_with(case_root) || !visited.insert(resolved) || dir.join("case.sqlite3").exists() || dir.extension().is_some_and(|e| e.eq_ignore_ascii_case("ledcase")) {
                skipped.push(json!({"path":dir,"reason":"case folder or repeated directory"})); continue;
            }
            for entry in fs::read_dir(&dir)? {
                let entry = entry?;
                let metadata = fs::symlink_metadata(entry.path())?;
                #[cfg(windows)]
                let link = { use std::os::windows::fs::MetadataExt; metadata.file_attributes() & 0x400 != 0 };
                #[cfg(not(windows))]
                let link = metadata.file_type().is_symlink();
                if link { skipped.push(json!({"path":entry.path(),"reason":"link or reparse point"})); }
                else if metadata.is_dir() { pending.push(entry.path()); }
                else if metadata.is_file() { paths.push(entry.path().to_string_lossy().into_owned()); }
                ensure!(paths.len() <= 10000, "Folder exceeds 10,000 files; import smaller productions");
            }
        }
        paths.sort();
    Ok((paths,skipped))
}

fn normalize_document_status(source:&mut Source) {
    let ext=Path::new(&source.name).extension().and_then(|e|e.to_str()).unwrap_or("").to_ascii_lowercase();
    if source.status=="unsupported · preserved" && ["docx","xlsx","pptx","odt"].contains(&ext.as_str()) {
        source.status="document preview available · extraction pending".into();
    }
}
