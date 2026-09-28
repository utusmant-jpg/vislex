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
#[derive(Clone,Copy,PartialEq,Eq)]
enum Priority {Interactive,Background}
#[derive(Clone,Copy)]
struct Waiter {id:u64,priority:Priority,heavy:bool}
#[derive(Default)]
struct ScheduleState {active:usize,heavy_active:bool,waiting:Vec<Waiter>,next_id:u64,interactive_streak:u8}
static SCHEDULER:std::sync::OnceLock<(std::sync::Mutex<ScheduleState>,std::sync::Condvar)>=std::sync::OnceLock::new();
fn scheduler()->&'static (std::sync::Mutex<ScheduleState>,std::sync::Condvar){SCHEDULER.get_or_init(||(std::sync::Mutex::new(ScheduleState::default()),std::sync::Condvar::new()))}
fn selected_waiter(state:&ScheduleState)->Option<u64> {
    if state.active>=2{return None;}
    let eligible=state.waiting.iter().filter(|waiter|!waiter.heavy||!state.heavy_active).collect::<Vec<_>>();
    let interactive=eligible.iter().find(|waiter|waiter.priority==Priority::Interactive);
    let background=eligible.iter().find(|waiter|waiter.priority==Priority::Background);
    if state.interactive_streak>=3 {background.or(interactive)}else{interactive.or(background)}.map(|waiter|waiter.id)
}
fn priority(kind:Option<&str>,operation:Option<&str>)->Priority {
    if operation==Some("automatic") || matches!(kind,Some("video_ocr"|"video_overview"|"full_audio"|"media_inventory")) {Priority::Background}else{Priority::Interactive}
}
struct SchedulerPermit{heavy:bool}
impl SchedulerPermit {
    fn acquire(job:&Path,priority:Priority,heavy:bool)->Result<Self> {
        let (lock,wake)=scheduler();
        let mut state=lock.lock().unwrap_or_else(|e|e.into_inner());
        state.next_id=state.next_id.wrapping_add(1);
        let id=state.next_id;
        state.waiting.push(Waiter{id,priority,heavy});
        loop {
            if job.join("cancel.request").exists() {
                state.waiting.retain(|waiter|waiter.id!=id);wake.notify_all();
                anyhow::bail!("Processing cancelled while waiting for resources");
            }
            if selected_waiter(&state)==Some(id) {
                state.waiting.retain(|waiter|waiter.id!=id);
                state.active+=1;if heavy{state.heavy_active=true;}
                if priority==Priority::Interactive{state.interactive_streak=state.interactive_streak.saturating_add(1);}else{state.interactive_streak=0;}
                wake.notify_all();
                return Ok(Self{heavy});
            }
            let (next,_)=wake.wait_timeout(state,Duration::from_millis(200)).unwrap_or_else(|error|error.into_inner());state=next;
        }
    }
}
fn available_physical_mib() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut memory=MEMORYSTATUSEX::default();
    memory.dwLength=std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    (unsafe {GlobalMemoryStatusEx(&mut memory)}!=0).then_some(memory.ullAvailPhys/(1024*1024))
}
fn serial_worker(kind: Option<&str>, physical_available_mib: Option<u64>) -> bool {
    match kind {
        // Overview is a navigation pass. Run it beside one ASR/OCR worker
        // only when enough physical memory remains for both sandboxes.
        Some("video_overview") => physical_available_mib.unwrap_or(0)<4096,
        None | Some("video_ocr"|"full_audio"|"video"|"audio"|"diarization") => true,
        _ => false,
    }
}
impl Drop for SchedulerPermit {
    fn drop(&mut self) {
        let (lock,wake)=scheduler();
        let mut state=lock.lock().unwrap_or_else(|e|e.into_inner());
        state.active-=1;if self.heavy{state.heavy_active=false;}wake.notify_all();
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
fn acl_exact(path:&Path,sid:&str,rights:&str)->Result<()> {
    let _access=ACL_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let system=std::env::var_os("SystemRoot").context("Windows SystemRoot is missing")?;
    let result=Command::new(Path::new(&system).join("System32/icacls.exe"))
        .arg(path).args(["/grant",&format!("*{sid}:({rights})"),"/Q"])
        .creation_flags(CREATE_NO_WINDOW).output()?;
    ensure!(result.status.success(),"Could not scope read-only worker input");
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
fn remove_acl_exact(path:&Path,sid:&str) {
    let _access=ACL_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    if let Some(system)=std::env::var_os("SystemRoot") {
        let _=Command::new(Path::new(&system).join("System32/icacls.exe"))
            .arg(path).args(["/remove:g",&format!("*{sid}"),"/Q"])
            .creation_flags(CREATE_NO_WINDOW).output();
    }
}
struct Grants<'a> {
    runtime: &'a Path,
    job: &'a Path,
    readonly_input: Option<&'a Path>,
    traverse:Vec<std::path::PathBuf>,
    sid: String,
}
impl Drop for Grants<'_> {
    fn drop(&mut self) {
        if let Some(input)=self.readonly_input {remove_acl_exact(input,&self.sid);}
        for path in self.traverse.iter().rev(){remove_acl_exact(path,&self.sid);}
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
    run_worker_with_readonly(executable,job,None,timeout)
}
fn update_job_heartbeat(job:&Path) {
    let manifest=std::fs::read(job.join("manifest.json")).ok().and_then(|raw|serde_json::from_slice::<serde_json::Value>(&raw).ok());
    let Some(job_id)=manifest.as_ref().and_then(|value|value["job_id"].as_str()) else{return};
    let Some(case_root)=job.parent().and_then(Path::parent) else{return};
    let Ok(db)=rusqlite::Connection::open_with_flags(case_root.join("case.sqlite3"),rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE|rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX) else{return};
    let _=db.busy_timeout(Duration::from_millis(100));
    let _=db.execute("UPDATE job_schedule SET heartbeat=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE job_id=? AND EXISTS(SELECT 1 FROM processing_jobs WHERE id=? AND status='running')",[job_id,job_id]);
}
pub fn run_worker_with_readonly(executable:&Path,job:&Path,readonly_input:Option<&Path>,timeout:Duration)->Result<()> {
    ensure!(executable.is_absolute() && executable.is_file(),"Packaged worker is unavailable");
    ensure!(job.is_absolute() && job.is_dir(),"Invalid job directory");
    // Decode/OCR/ASR workers can each approach the per-process 2 GiB limit.
    // Reserve their shared slot before a general worker slot so a waiting
    // video job does not prevent a lightweight document job from starting.
    let request=std::fs::read(job.join("request.json")).ok().and_then(|raw|serde_json::from_slice::<serde_json::Value>(&raw).ok());
    let heavy=serial_worker(request.as_ref().and_then(|value|value["kind"].as_str()),available_physical_mib());
    let class=if request.as_ref().and_then(|value|value["scheduler_priority"].as_str())==Some("background") {Priority::Background}
        else {priority(request.as_ref().and_then(|value|value["kind"].as_str()),request.as_ref().and_then(|value|value["operation"].as_str()))};
    let _permit=SchedulerPermit::acquire(job,class,heavy)?;
    let executable = executable.canonicalize()?;
    let job = job.canonicalize()?;
    let readonly_input=readonly_input.map(Path::canonicalize).transpose()?;
    if let Some(input)=readonly_input.as_ref(){ensure!(input.is_file(),"Read-only worker input is unavailable");}
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
        let traverse=readonly_input.as_ref().map(|input|{
            let common=input.ancestors().find(|ancestor|job.starts_with(ancestor)).context("Worker input is not in the job's case")?;
            let mut paths=Vec::new();
            for parent in input.parent().context("Input parent missing")?.ancestors(){paths.push(parent.to_path_buf());if parent==common{break;}}
            Ok::<_,anyhow::Error>(paths)
        }).transpose()?.unwrap_or_default();
        let _grants = Grants {
            runtime,
            job: &job,
            readonly_input:readonly_input.as_deref(),
            traverse:traverse.clone(),
            sid: sid.clone(),
        };
        acl(runtime, &sid, "RX")?;
        acl(&job, &sid, "M")?;
        for path in traverse.iter().rev(){acl_exact(path,&sid,"X")?;}
        if let Some(input)=readonly_input.as_ref(){acl_exact(input,&sid,"R")?;}
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
        let mut last_heartbeat=Instant::now();
        update_job_heartbeat(&job);
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
            if last_heartbeat.elapsed()>=Duration::from_secs(5){update_job_heartbeat(&job);last_heartbeat=Instant::now();}
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
    #[test]
    fn overview_uses_spare_memory_without_running_two_ocr_workers() {
        assert!(!super::serial_worker(Some("video_overview"),Some(6144)));
        assert!(super::serial_worker(Some("video_overview"),Some(2048)));
        assert!(super::serial_worker(Some("video_overview"),None));
        assert!(super::serial_worker(Some("full_audio"),Some(6144)));
        assert!(super::serial_worker(Some("video_ocr"),Some(6144)));
    }
    #[test]
    fn scheduler_prefers_interactive_then_serves_waiting_background() {
        let mut state=super::ScheduleState::default();
        state.waiting=vec![super::Waiter{id:1,priority:super::Priority::Background,heavy:false},super::Waiter{id:2,priority:super::Priority::Interactive,heavy:false},super::Waiter{id:3,priority:super::Priority::Background,heavy:false}];
        assert_eq!(super::selected_waiter(&state),Some(2));
        state.interactive_streak=3;assert_eq!(super::selected_waiter(&state),Some(1));
        state.heavy_active=true;state.waiting[0].heavy=true;assert_eq!(super::selected_waiter(&state),Some(3));
    }
    #[test]
    fn queued_worker_cancels_without_waiting_for_busy_permits() {
        let dir=tempfile::tempdir().unwrap();let job=dir.path().join("queued");std::fs::create_dir(&job).unwrap();
        let _a=super::SchedulerPermit::acquire(&job,super::Priority::Background,true).unwrap();
        let _b=super::SchedulerPermit::acquire(&job,super::Priority::Background,false).unwrap();
        let started=std::time::Instant::now();
        let waiting=std::thread::spawn({let job=job.clone();move ||super::SchedulerPermit::acquire(&job,super::Priority::Interactive,false)});
        std::thread::sleep(std::time::Duration::from_millis(100));
        std::fs::write(job.join("cancel.request"),b"cancel").unwrap();
        assert!(waiting.join().unwrap().is_err());
        assert!(started.elapsed()<std::time::Duration::from_secs(1));
    }
}
