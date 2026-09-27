//! Codex App Server account connection. OAuth credentials remain inside the
//! restricted sidecar profile and are never returned to the desktop frontend.
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, BufReader, Read, Write},
    collections::VecDeque,
    path::Path,
    process::Command,
    sync::{mpsc, Mutex, OnceLock},
    time::{Duration, Instant},
};

static CLIENT: OnceLock<Mutex<Option<Connection>>> = OnceLock::new();
// Updated only after the pinned source, patch, and Windows package are rebuilt
// and independently checked. A stale sidecar must never enable case turns.
const SIDECAR_SHA256: &str = "E1D6B21D4D53A4ECE8F3A034DB86A7022B3FDD3F07916E53A1C032FC42781C55";

fn binary_path(directory: &Path) -> std::path::PathBuf {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("VISLEX_CODEX_BINARY") { return path.into(); }
    directory.join("codex-app-server.exe")
}

pub fn available(directory: &Path) -> bool {
    let path=binary_path(directory);
    #[cfg(debug_assertions)]
    if std::env::var_os("VISLEX_CODEX_BINARY").is_some() { return path.is_file(); }
    let Ok(mut file)=std::fs::File::open(path) else {return false};
    let mut hash=Sha256::new();
    let mut buffer=[0_u8;64*1024];
    loop {
        let Ok(count)=file.read(&mut buffer) else {return false};
        if count==0 {break;}
        hash.update(&buffer[..count]);
    }
    format!("{:X}",hash.finalize())==SIDECAR_SHA256
}

pub(crate) struct Connection {
    child: crate::codex_sandbox::CodexChild,
    events: mpsc::Receiver<Value>,
    next_id: u64,
    login: Option<LoginState>,
    case_mode: bool,
    inbox: VecDeque<Value>,
}

struct LoginState {
    id: String,
    started: Instant,
    outcome: Option<std::result::Result<(), String>>,
}

impl Connection {
    fn start(directory: &Path, case_mode: bool) -> Result<Self> {
        std::fs::create_dir_all(directory)?;
        ensure!(available(directory), "Verified Codex sidecar is unavailable");
        // In development only, the verified patched build may be supplied by
        // path. Release must load the binary shipped beside the app resources.
        let binary = binary_path(directory);
        let child = crate::codex_sandbox::spawn_subscription(&binary)
            .context("Isolated Codex runtime unavailable; subscription sign-in is disabled")?;
        let stdout = child.stdout.try_clone()?;
        let mut stderr = child.stderr.try_clone()?;
        std::thread::spawn(move || { let _ = std::io::copy(&mut stderr, &mut std::io::sink()); });
        let (tx, events) = mpsc::sync_channel(256);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(value) = serde_json::from_str::<Value>(&line) else { break };
                if tx.send(value).is_err() { break }
            }
        });
        let mut connection = Self { child, events, next_id: 1, login: None, case_mode, inbox: VecDeque::new() };
        connection.call("initialize", json!({"clientInfo":{"name":"vislex","title":"VisLex","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":case_mode}}))?;
        connection.send(json!({"method":"initialized","params":{}}))?;
        Ok(connection)
    }

    pub(crate) fn send(&mut self, value: Value) -> Result<()> {
        serde_json::to_writer(&mut self.child.stdin, &value)?;
        self.child.stdin.write_all(b"\n")?;
        self.child.stdin.flush()?;
        Ok(())
    }

    pub(crate) fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({"id":id,"method":method,"params":params}))?;
        let deadline = Instant::now() + Duration::from_secs(45);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            ensure!(!remaining.is_zero(), "Codex App Server did not respond");
            let message = self.events.recv_timeout(remaining)
                .context("Codex App Server did not respond")?;
            if message.get("method").is_some() || message["id"].as_u64() != Some(id) {
                self.handle_event(&message)?;
                continue;
            }
            if let Some(error) = message.get("error") {
                let detail = error["message"].as_str().unwrap_or("request failed");
                bail!("Codex App Server request failed: {}", detail.chars().take(300).collect::<String>());
            }
            return message.get("result").cloned().context("Codex App Server returned no result");
        }
    }

    fn handle_event(&mut self, message: &Value) -> Result<()> {
        if message["method"] == "account/login/completed" {
            if let Some(login) = &mut self.login {
                if message["params"]["loginId"].as_str() == Some(&login.id) {
                    login.outcome = Some(if message["params"]["success"] == true { Ok(()) }
                        else { Err(message["params"]["error"].as_str().unwrap_or("Sign-in failed").chars().take(300).collect()) });
                }
            }
        } else if self.case_mode {
            self.inbox.push_back(message.clone());
        } else if message.get("id").is_some() && message.get("method").is_some() {
            // Account mode must never silently drop a server request. A case
            // request is handled by the dedicated task bridge instead.
            self.send(json!({"id":message["id"],"error":{"code":-32601,"message":"Method not available in account mode"}}))?;
        }
        Ok(())
    }

    fn drain_events(&mut self) -> Result<()> {
        while let Ok(event) = self.events.try_recv() { self.handle_event(&event)?; }
        Ok(())
    }

    pub(crate) fn next_message(&mut self, timeout: Duration) -> Result<Option<Value>> {
        if let Some(message) = self.inbox.pop_front() { return Ok(Some(message)); }
        match self.events.recv_timeout(timeout) {
            Ok(message) => Ok(Some(message)),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                ensure!(self.child.wait(0)?.is_none(),"Codex App Server exited");
                Ok(None)
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => bail!("Codex App Server closed its event stream"),
        }
    }

    pub(crate) fn start_case(directory: &Path) -> Result<Self> { Self::start(directory, true) }
    pub(crate) fn home(&self) -> &Path { &self.child.home }
}

fn with_client<T>(directory: &Path, operation: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
    let slot = CLIENT.get_or_init(|| Mutex::new(None));
    let mut guard = slot.lock().unwrap_or_else(|poison| poison.into_inner());
    let restart = guard.as_mut().is_none_or(|client| client.child.wait(0).ok().flatten().is_some());
    if restart { *guard = Some(Connection::start(directory, false)?); }
    operation(guard.as_mut().unwrap())
}

pub fn status(directory: &Path) -> Result<Value> {
    with_client(directory, |client| {
        client.drain_events()?;
        let result = client.call("account/read", json!({"refreshToken":false}))?;
        let account = &result["account"];
        let login = client.login.as_ref().map(|login| {
            let expired = login.started.elapsed() >= Duration::from_secs(15 * 60);
            let state = match &login.outcome { Some(Ok(())) => "complete", Some(Err(_)) => "failed", None if expired => "expired", None => "pending" };
            json!({"state":state,"error":login.outcome.as_ref().and_then(|o|o.as_ref().err()),"expires_in_seconds":if expired {0}else{(15*60_u64).saturating_sub(login.started.elapsed().as_secs())}})
        });
        Ok(json!({
            "connected": account["type"] == "chatgpt",
            "email": account["email"],
            "plan": account["planType"],
            "login": login
        }))
    })
}

pub fn isolated_home(directory:&Path)->Result<std::path::PathBuf> {
    with_client(directory,|client|Ok(client.home().to_path_buf()))
}

pub fn begin_login(directory: &Path) -> Result<Value> {
    with_client(directory, |client| {
        let result = client.call("account/login/start", json!({"type":"chatgptDeviceCode"}))?;
        let url = result["verificationUrl"].as_str().context("No ChatGPT verification URL returned")?;
        let parsed = reqwest::Url::parse(url)?;
        ensure!(parsed.scheme() == "https" && matches!(parsed.host_str(),Some("chatgpt.com" | "auth.openai.com"))
            && parsed.username().is_empty() && parsed.password().is_none() && parsed.port().is_none(),
            "Unexpected ChatGPT authorization host");
        let login_id = result["loginId"].as_str().context("No login identifier returned")?;
        let user_code = result["userCode"].as_str().context("No device code returned")?;
        client.login = Some(LoginState { id:login_id.to_owned(), started:Instant::now(), outcome:None });
        #[cfg(windows)]
        let browser_opened = std::env::var_os("SystemRoot").is_some_and(|root| {
            use std::os::windows::process::CommandExt;
            Command::new(Path::new(&root).join("System32/rundll32.exe"))
                .arg("url.dll,FileProtocolHandler").arg(url)
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .spawn().is_ok()
        });
        #[cfg(not(windows))]
        let browser_opened = false;
        Ok(json!({"login_id":login_id,"auth_url":url,"user_code":user_code,"browser_opened":browser_opened}))
    })
}

pub fn cancel_login(directory: &Path, login_id: &str) -> Result<()> {
    ensure!(!login_id.is_empty() && login_id.len() <= 128, "Invalid login identifier");
    with_client(directory, |client| { client.call("account/login/cancel", json!({"loginId":login_id}))?; client.login = None; Ok(()) })
}

pub fn logout(directory: &Path) -> Result<()> {
    with_client(directory, |client| { client.call("account/logout", json!({}))?; client.login = None; Ok(()) })
}

pub fn models(directory: &Path) -> Result<Value> {
    with_client(directory, |client| {
        let account = client.call("account/read", json!({"refreshToken":false}))?;
        ensure!(account["account"]["type"] == "chatgpt", "Sign in with ChatGPT first");
        let mut cursor: Option<String> = None;
        let mut models = Vec::new();
        for _ in 0..20 {
            let mut params = json!({"limit":100,"includeHidden":false});
            if let Some(value) = &cursor { params["cursor"] = json!(value); }
            let page = client.call("model/list", params)?;
            models.extend(parse_models(&page)?);
            cursor = page["nextCursor"].as_str().map(str::to_owned);
            if cursor.is_none() { return Ok(json!(models)); }
        }
        bail!("Codex model catalogue exceeded pagination limit")
    })
}

fn parse_models(page: &Value) -> Result<Vec<Value>> {
    let entries = page["data"].as_array().context("Invalid Codex model catalogue")?;
    let mut models = Vec::new();
    for entry in entries {
        if entry["hidden"] == true { continue; }
        let Some(id) = entry["model"].as_str().or_else(|| entry["id"].as_str()) else { continue };
        if crate::providers::validate_model(id).is_err() { continue; }
        let efforts: Vec<String> = entry["supportedReasoningEfforts"].as_array().into_iter().flatten()
            .filter_map(|v| v["reasoningEffort"].as_str())
            .filter(|v| matches!(*v,"none"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"|"ultra"))
            .map(str::to_owned).collect();
        let default = entry["defaultReasoningEffort"].as_str().filter(|v| efforts.iter().any(|e| e == v));
        models.push(json!({"id":id,"name":entry["displayName"].as_str().unwrap_or(id),"efforts":efforts,"default_effort":default,"input_modalities":entry["inputModalities"]}));
    }
    Ok(models)
}

pub fn limits(directory: &Path) -> Result<Value> {
    with_client(directory, |client| {
        let account = client.call("account/read", json!({"refreshToken":false}))?;
        ensure!(account["account"]["type"] == "chatgpt", "Sign in with ChatGPT first");
        client.call("account/rateLimits/read", json!({}))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalogue_preserves_only_account_returned_efforts() {
        let page=json!({"data":[
            {"id":"model-a","model":"model-a","displayName":"A","supportedReasoningEfforts":[{"reasoningEffort":"medium"},{"reasoningEffort":"max"}],"defaultReasoningEffort":"max"},
            {"id":"hidden-model","hidden":true,"supportedReasoningEfforts":[{"reasoningEffort":"high"}]}
        ]});
        let models=parse_models(&page).unwrap();
        assert_eq!(models.len(),1);
        assert_eq!(models[0]["efforts"],json!(["medium","max"]));
        assert_eq!(models[0]["default_effort"],"max");
        assert!(parse_models(&json!({"unexpected":[]})).is_err());
    }

    #[test]
    #[ignore = "Requires the official Codex CLI; account-only synthetic protocol probe"]
    fn account_read_protocol_smoke() {
        let home=tempfile::tempdir().unwrap();
        let account=status(home.path()).unwrap();
        assert_eq!(account["connected"],false);
    }
}
