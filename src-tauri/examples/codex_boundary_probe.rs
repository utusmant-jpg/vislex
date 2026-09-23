//! Synthetic-only proof that a Codex App Server cannot read outside its profile.
//! Run with: cargo run --example codex_boundary_probe -- <codex.exe> <outside-marker.txt>
#[path = "../src/codex_sandbox.rs"]
mod codex_sandbox;

use anyhow::{ensure, Result};
use serde_json::{json, Value};
use std::{io::{BufRead, BufReader, Write}, path::PathBuf, sync::mpsc, thread, time::Duration};

fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let binary = PathBuf::from(args.next().expect("codex.exe path"));
    let marker = PathBuf::from(args.next().expect("synthetic outside marker path"));
    let mode = args.next();
    let test_login = mode.as_deref() == Some(std::ffi::OsStr::new("--test-login"));
    let test_persistent = mode.as_deref() == Some(std::ffi::OsStr::new("--test-persistent"));
    ensure!(marker.is_file() && marker.is_absolute(), "Missing synthetic marker");
    let mut child = if test_persistent { codex_sandbox::spawn_subscription(&binary)? } else { codex_sandbox::spawn(&binary, test_login)? };
    let allowed = child.home.join("allowed-synthetic.txt");
    std::fs::write(&allowed, b"ALLOWED_SYNTHETIC")?;
    let (tx, rx) = mpsc::channel::<Value>();
    let stdout = child.stdout.try_clone()?;
    let stderr = child.stderr.try_clone()?;
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(std::result::Result::ok) {
            eprintln!("codex: {line}");
        }
    });
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(std::result::Result::ok) {
            if let Ok(value) = serde_json::from_str(&line) { let _ = tx.send(value); }
        }
    });
    let init = json!({"method":"initialize","id":1,"params":{"clientInfo":{"name":"vislex_synthetic_probe","title":"VisLex synthetic boundary probe","version":"0.0.0"}}});
    writeln!(child.stdin, "{init}")?;
    let result = rx.recv_timeout(Duration::from_secs(20))?;
    ensure!(result["id"] == 1 && result.get("result").is_some(), "Codex initialization failed: {result}");
    writeln!(child.stdin, "{}", json!({"method":"initialized","params":{}}))?;
    let account = json!({"method":"account/read","id":2,"params":{}});
    writeln!(child.stdin, "{account}")?;
    loop {
        let result = rx.recv_timeout(Duration::from_secs(20))?;
        if result["id"] == 2 { ensure!(result.get("result").is_some(), "Account metadata failed: {result}"); break; }
    }
    let command = json!({"method":"command/exec","id":3,"params":{
        "command":["cmd.exe","/d","/c","type",allowed.to_string_lossy()],
        "cwd":child.home,"sandboxPolicy":{"type":"externalSandbox","networkAccess":"restricted"},"timeoutMs":10000
    }});
    writeln!(child.stdin, "{command}")?;
    loop {
        let result = rx.recv_timeout(Duration::from_secs(30))?;
        if result["id"] == 3 {
            ensure!(result["result"]["stdout"].as_str().unwrap_or_default().contains("ALLOWED_SYNTHETIC"), "Codex could not read its permitted synthetic profile: {result}");
            break;
        }
    }
    let denied = json!({"method":"command/exec","id":4,"params":{
        "command":["cmd.exe","/d","/c","type",marker.to_string_lossy()],
        "cwd":child.home,"sandboxPolicy":{"type":"externalSandbox","networkAccess":"restricted"},"timeoutMs":10000
    }});
    writeln!(child.stdin, "{denied}")?;
    loop {
        let result = rx.recv_timeout(Duration::from_secs(30))?;
        if result["id"] == 4 {
            ensure!(!result["result"]["stdout"].as_str().unwrap_or_default().contains("DENIED_SYNTHETIC"), "Boundary FAILED: out-of-scope marker was read");
            println!("Boundary held: permitted profile readable; out-of-scope read denied; account/read available");
            break;
        }
    }
    if test_login {
        writeln!(child.stdin, "{}", json!({"method":"account/login/start","id":5,"params":{"type":"chatgptDeviceCode"}}))?;
        loop {
            let result = rx.recv_timeout(Duration::from_secs(45))?;
            if result["id"] == 5 {
                ensure!(result["result"]["type"] == "chatgptDeviceCode", "Device-code login unavailable: {result}");
                ensure!(result["result"]["userCode"].as_str().is_some(), "Device-code missing: {result}");
                println!("Device-code OAuth start succeeded inside the isolated AppContainer");
                break;
            }
        }
    }
    if test_persistent {
        drop(child);
        let repeated = codex_sandbox::spawn_subscription(&binary)?;
        ensure!(repeated.home == allowed.parent().unwrap(), "Persistent OAuth profile changed between launches");
        println!("Persistent AppContainer profile reused across Codex launches");
    }
    Ok(())
}
