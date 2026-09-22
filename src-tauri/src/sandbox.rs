//! Windows AppContainer launcher. Never falls back to an unrestricted process.
//! Only trusted packaged worker code is executed. Evidence is copied into a per-job directory.
use anyhow::{ensure, Context, Result};
use std::{
    ffi::OsStr,
    os::windows::{ffi::OsStrExt, process::CommandExt},
    path::Path,
    process::Command,
    ptr::{null, null_mut},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, Isolation::*, *},
    System::{JobObjects::*, Threading::*},
};

fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(Some(0)).collect()
}
fn check(value: i32, label: &str) -> Result<()> {
    ensure!(value != 0, "{label}: {}", std::io::Error::last_os_error());
    Ok(())
}
struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_null() {
                CloseHandle(self.0);
            }
        }
    }
}
struct Profile {
    sid: PSID,
    name: Vec<u16>,
}
impl Drop for Profile {
    fn drop(&mut self) {
        unsafe {
            FreeSid(self.sid);
            DeleteAppContainerProfile(self.name.as_ptr());
        }
    }
}
struct Attributes {
    ptr: LPPROC_THREAD_ATTRIBUTE_LIST,
    _storage: Vec<usize>,
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.ptr);
        }
    }
}

fn sid_string(sid: PSID) -> Result<String> {
    unsafe {
        let mut ptr = null_mut();
        check(
            ConvertSidToStringSidW(sid, &mut ptr),
            "Format container identity",
        )?;
        let mut len = 0;
        while *ptr.add(len) != 0 {
            len += 1;
        }
        let result = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
        LocalFree(ptr as _);
        Ok(result)
    }
}
// Runtime ACL updates share the packaged directory. Serialize changes so one
// job cannot lose another job's grant during concurrent recursive ACL updates.
static ACL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static WORKER_SLOTS: (std::sync::Mutex<usize>, std::sync::Condvar) =
    (std::sync::Mutex::new(0), std::sync::Condvar::new());
static HEAVY_SLOT: (std::sync::Mutex<bool>, std::sync::Condvar) =
    (std::sync::Mutex::new(false), std::sync::Condvar::new());
struct HeavyPermit;
impl HeavyPermit {
    fn acquire() -> Self {
        let (lock,wake)=&HEAVY_SLOT;
        let mut active=lock.lock().unwrap_or_else(|e|e.into_inner());
        while *active {active=wake.wait(active).unwrap_or_else(|e|e.into_inner());}
        *active=true;Self
    }
}
impl Drop for HeavyPermit {
    fn drop(&mut self) {
        let (lock,wake)=&HEAVY_SLOT;
        *lock.lock().unwrap_or_else(|e|e.into_inner())=false;wake.notify_one();
    }
}
struct WorkerPermit;
impl WorkerPermit {
    fn acquire() -> Self {
        let (lock, wake) = &WORKER_SLOTS;
        let mut active = lock.lock().unwrap_or_else(|e|e.into_inner());
        while *active >= 2 {active = wake.wait(active).unwrap_or_else(|e|e.into_inner());}
        *active += 1; Self
    }
}
impl Drop for WorkerPermit {
    fn drop(&mut self) {
        let (lock,wake) = &WORKER_SLOTS;
        let mut active = lock.lock().unwrap_or_else(|e|e.into_inner());
        *active -= 1; wake.notify_one();
    }
}
fn acl(path: &Path, sid: &str, rights: &str) -> Result<()> {
    let _access=ACL_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let system = std::env::var_os("SystemRoot").context("Windows SystemRoot is missing")?;
    let result = Command::new(Path::new(&system).join("System32/icacls.exe"))
        .arg(path)
        .args(["/grant", &format!("*{sid}:(OI)(CI)({rights})"), "/T", "/Q"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;
    ensure!(
        result.status.success(),
        "Could not scope worker filesystem access"
    );
    Ok(())
}
fn remove_acl(path: &Path, sid: &str) {
    let _access=ACL_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    if let Some(system) = std::env::var_os("SystemRoot") {
        let _ = Command::new(Path::new(&system).join("System32/icacls.exe"))
            .arg(path)
            .args(["/remove:g", &format!("*{sid}"), "/T", "/Q"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
}
struct Grants<'a> {
    runtime: &'a Path,
    job: &'a Path,
    sid: String,
}
impl Drop for Grants<'_> {
    fn drop(&mut self) {
        remove_acl(self.runtime, &self.sid);
        remove_acl(self.job, &self.sid);
    }
}
fn quote(arg: &str) -> String {
    let mut out = String::from("\"");
    let mut slashes = 0;
    for c in arg.chars() {
        if c == '\\' {
            slashes += 1;
        } else {
            if c == '"' {
                out.push_str(&"\\".repeat(slashes * 2 + 1));
            } else {
                out.push_str(&"\\".repeat(slashes));
            }
            slashes = 0;
            out.push(c);
        }
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}

/// Launches one packaged worker, with no network capabilities, no inherited handles,
/// 2 GiB memory, at most one process, and a wall-clock limit. Closing the Job kills it.
pub fn run_worker(executable: &Path, job: &Path, timeout: Duration) -> Result<()> {
    // Decode/OCR/ASR workers can each approach the per-process 2 GiB limit.
    // Reserve their shared slot before a general worker slot so a waiting
    // video job does not prevent a lightweight document job from starting.
    let request=std::fs::read(job.join("request.json")).ok().and_then(|raw|serde_json::from_slice::<serde_json::Value>(&raw).ok());
    let heavy=request.as_ref().is_none_or(|value| ["video_ocr","video_overview","full_audio","video","audio","diarization"].contains(&value["kind"].as_str().unwrap_or("")));
    let _heavy=heavy.then(HeavyPermit::acquire);
    let _permit=WorkerPermit::acquire();
    ensure!(
        executable.is_absolute() && executable.is_file(),
        "Packaged worker is unavailable"
    );
    ensure!(job.is_absolute() && job.is_dir(), "Invalid job directory");
    let executable = executable.canonicalize()?;
    let job = job.canonicalize()?;
    let runtime = executable.parent().context("Worker runtime missing")?;
    unsafe {
        let name = wide(format!("EvidenceDesk.Job.{}", crate::case::id()));
        let mut sid = null_mut();
        let hr = CreateAppContainerProfile(
            name.as_ptr(),
            name.as_ptr(),
            name.as_ptr(),
            null(),
            0,
            &mut sid,
        );
        ensure!(
            hr >= 0 && !sid.is_null(),
            "Cannot create AppContainer (HRESULT {hr:#x}); processing disabled"
        );
        let profile = Profile { sid, name };
        let sid = sid_string(profile.sid)?;
        // RAII revokes grants even if process creation fails.
        let _grants = Grants {
            runtime,
            job: &job,
            sid: sid.clone(),
        };
        acl(runtime, &sid, "RX")?;
        acl(&job, &sid, "M")?;
        let mut size = 0;
        InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size);
        ensure!(size > 0, "Cannot size process attributes");
        let mut storage = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
        let ptr = storage.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        check(
            InitializeProcThreadAttributeList(ptr, 1, 0, &mut size),
            "Initialize sandbox attributes",
        )?;
        let attributes = Attributes {
            ptr,
            _storage: storage,
        };
        let capabilities = SECURITY_CAPABILITIES {
            AppContainerSid: profile.sid,
            Capabilities: null_mut(),
            CapabilityCount: 0,
            Reserved: 0,
        };
        check(
            UpdateProcThreadAttribute(
                attributes.ptr,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                &capabilities as *const _ as _,
                std::mem::size_of_val(&capabilities),
                null_mut(),
                null(),
            ),
            "Set AppContainer policy",
        )?;
        let mut startup: STARTUPINFOEXW = std::mem::zeroed();
        startup.StartupInfo.cb = std::mem::size_of_val(&startup) as u32;
        startup.lpAttributeList = attributes.ptr;
        let exe_w = wide(&executable);
        let cwd_w = wide(&job);
        let mut cmd = wide(format!(
            "{} {}",
            quote(&executable.to_string_lossy()),
            quote(&job.to_string_lossy())
        ));
        // Explicit minimal environment: never inherit API keys or arbitrary Python paths.
        let system = std::env::var("SystemRoot")?;
        let vars = [
            format!("APPDATA={}", job.display()),
            format!("LOCALAPPDATA={}", job.display()),
            format!("PATH={system}\\System32"),
            "PYTHONNOUSERSITE=1".into(),
            format!("SystemRoot={system}"),
            format!("TEMP={}", job.display()),
            format!("TMP={}", job.display()),
        ];
        let environment = wide(format!("{}\0", vars.join("\0")));
        let mut process: PROCESS_INFORMATION = std::mem::zeroed();
        check(
            CreateProcessW(
                exe_w.as_ptr(),
                cmd.as_mut_ptr(),
                null(),
                null(),
                0,
                EXTENDED_STARTUPINFO_PRESENT
                    | CREATE_SUSPENDED
                    | CREATE_NO_WINDOW
                    | CREATE_UNICODE_ENVIRONMENT,
                environment.as_ptr() as _,
                cwd_w.as_ptr(),
                &startup.StartupInfo,
                &mut process,
            ),
            "Start sandboxed worker",
        )?;
        let process_handle = Handle(process.hProcess);
        let thread = Handle(process.hThread);
        let job_handle = Handle(CreateJobObjectW(null(), null()));
        if job_handle.0.is_null() {
            TerminateProcess(process_handle.0, 1);
            anyhow::bail!("Cannot create resource-limit Job");
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        limits.BasicLimitInformation.ActiveProcessLimit = 1;
        limits.ProcessMemoryLimit = 2 * 1024 * 1024 * 1024;
        if SetInformationJobObject(
            job_handle.0,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as _,
            std::mem::size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(job_handle.0, process_handle.0) == 0
        {
            TerminateProcess(process_handle.0, 1);
            anyhow::bail!("Cannot enforce worker resource limits");
        }
        ensure!(
            ResumeThread(thread.0) != u32::MAX,
            "Could not resume sandboxed worker"
        );
        let started = Instant::now();
        loop {
            ensure!(
                !job.join("cancel.request").exists(),
                "Processing cancelled; worker terminated"
            );
            let status = WaitForSingleObject(process_handle.0, 200);
            if status == WAIT_OBJECT_0 {
                break;
            }
            ensure!(status == WAIT_TIMEOUT, "Worker wait failed");
            ensure!(
                started.elapsed() < timeout,
                "Processing time limit exceeded; worker terminated"
            );
        }
        let mut exit = 0;
        check(
            GetExitCodeProcess(process_handle.0, &mut exit),
            "Read worker exit code",
        )?;
        ensure!(
            exit == 0,
            "Sandboxed worker exited with code {exit}; original remains preserved"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn quotes_windows_arguments() {
        assert_eq!(super::quote("hello world"), "\"hello world\"");
        assert_eq!(super::quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(super::quote("a\\"), "\"a\\\\\"");
    }
}
