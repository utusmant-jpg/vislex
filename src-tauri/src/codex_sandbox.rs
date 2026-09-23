//! AppContainer boundary for a subscription-backed Codex App Server.
//! The child receives only its private profile, its executable, and stdio pipes.
//! Never pass a case path or original evidence handle to this process.
#![cfg(windows)]

use anyhow::{ensure, Context, Result};
use std::{
    ffi::OsStr,
    fs::File,
    os::windows::{ffi::OsStrExt, io::FromRawHandle, process::CommandExt},
    path::{Path, PathBuf},
    process::Command,
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, Isolation::*, *},
    System::{JobObjects::*, Threading::*},
};

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreatePipe(read: *mut HANDLE, write: *mut HANDLE, attributes: *const SECURITY_ATTRIBUTES, size: u32) -> i32;
}
#[link(name = "userenv")]
unsafe extern "system" {
    fn GetAppContainerFolderPath(sid: *const u16, path: *mut *mut u16) -> i32;
    fn DeriveAppContainerSidFromAppContainerName(name: *const u16, sid: *mut PSID) -> i32;
}
#[link(name = "ole32")]
unsafe extern "system" { fn CoTaskMemFree(memory: *const core::ffi::c_void); }

fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}
fn checked(ok: i32, label: &str) -> Result<()> {
    ensure!(ok != 0, "{label}: {}", std::io::Error::last_os_error());
    Ok(())
}
struct Owned(HANDLE);
// The handle is owned exclusively and may be closed from another thread.
unsafe impl Send for Owned {}
impl Owned {
    fn take(&mut self) -> HANDLE { std::mem::replace(&mut self.0, null_mut()) }
}
impl Drop for Owned {
    fn drop(&mut self) { unsafe { if !self.0.is_null() { CloseHandle(self.0); } } }
}
struct Profile { name: Vec<u16>, sid: PSID, persistent: bool }
// The SID allocation has a single owner; only Drop uses its raw pointer.
unsafe impl Send for Profile {}
impl Drop for Profile {
    fn drop(&mut self) { unsafe { FreeSid(self.sid); if !self.persistent { DeleteAppContainerProfile(self.name.as_ptr()); } } }
}
struct Attributes { ptr: LPPROC_THREAD_ATTRIBUTE_LIST, _storage: Vec<usize> }
impl Drop for Attributes {
    fn drop(&mut self) { unsafe { DeleteProcThreadAttributeList(self.ptr); } }
}
fn pipe() -> Result<(Owned, Owned)> {
    unsafe {
        let security = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: null_mut(), bInheritHandle: 1 };
        let (mut read, mut write) = (null_mut(), null_mut());
        checked(CreatePipe(&mut read, &mut write, &security, 0), "Create Codex stdio pipe")?;
        Ok((Owned(read), Owned(write)))
    }
}
fn sid_string(sid: PSID) -> Result<String> {
    unsafe {
        let mut value = null_mut();
        checked(ConvertSidToStringSidW(sid, &mut value), "Format Codex AppContainer SID")?;
        let mut length = 0;
        while *value.add(length) != 0 { length += 1; }
        let result = String::from_utf16_lossy(std::slice::from_raw_parts(value, length));
        LocalFree(value as _);
        Ok(result)
    }
}
fn acl(path: &Path, sid: &str, rights: &str, remove: bool) -> Result<()> {
    let system = std::env::var_os("SystemRoot").context("SystemRoot missing")?;
    let mut command = Command::new(Path::new(&system).join("System32/icacls.exe"));
    command.arg(path);
    if remove { command.args(["/remove:g", &format!("*{sid}"), "/T", "/Q"]); }
    else { command.args(["/grant", &format!("*{sid}:(OI)(CI)({rights})"), "/T", "/Q"]); }
    let result = command.creation_flags(CREATE_NO_WINDOW).output()?;
    ensure!(result.status.success(), "Could not scope Codex AppContainer ACL: {}", String::from_utf8_lossy(&result.stderr));
    Ok(())
}
fn package_traverse(path: &Path, sid: &str, remove: bool) -> Result<()> {
    let system = std::env::var_os("SystemRoot").context("SystemRoot missing")?;
    let mut command = Command::new(Path::new(&system).join("System32/icacls.exe"));
    command.arg(path);
    if remove { command.args(["/remove:g", &format!("*{sid}"), "/Q"]); }
    else { command.args(["/grant", &format!("*{sid}:(X)"), "/Q"]); }
    let result = command.creation_flags(CREATE_NO_WINDOW).output()?;
    ensure!(result.status.success(), "Could not scope Codex package traversal");
    Ok(())
}
struct Grants {
    runtime: PathBuf,
    private_home: PathBuf,
    package_root: PathBuf,
    sid: String,
    runtime_granted: bool,
    home_granted: bool,
    package_granted: bool,
}
impl Drop for Grants {
    fn drop(&mut self) {
        if self.package_granted { let _ = package_traverse(&self.package_root, &self.sid, true); }
        if self.home_granted { let _ = acl(&self.private_home, &self.sid, "M", true); }
        if self.runtime_granted { let _ = acl(&self.runtime, &self.sid, "RX", true); }
    }
}

pub struct CodexChild {
    pub stdin: File,
    pub stdout: File,
    pub stderr: File,
    pub home: PathBuf,
    process: Owned,
    job: Owned,
    _profile: Profile,
    _grants: Grants,
}
impl CodexChild {
    pub fn wait(&self, millis: u32) -> Result<Option<u32>> {
        unsafe {
            let status = WaitForSingleObject(self.process.0, millis);
            if status == WAIT_TIMEOUT { return Ok(None); }
            ensure!(status == WAIT_OBJECT_0, "Codex process wait failed");
            let mut exit = 0;
            checked(GetExitCodeProcess(self.process.0, &mut exit), "Codex process exit")?;
            Ok(Some(exit))
        }
    }
}
impl Drop for CodexChild {
    fn drop(&mut self) {
        // Job close stops any descendants before grants and profile are removed.
        unsafe { if !self.job.0.is_null() { TerminateJobObject(self.job.0, 1); } }
    }
}

/// Starts the pinned Codex binary with a private CODEX_HOME. The parent owns
/// all pipes and must terminate the child on case/session changes. In-app
/// evidence is available only through a separate grant-checked tool broker.
pub fn spawn(executable: &Path, internet: bool) -> Result<CodexChild> {
    spawn_with_profile(executable, internet, None)
}

/// Stable profile keeps the user's Codex OAuth tokens between VisLex launches.
/// It contains no case path or evidence. Sign-out is handled by App Server.
pub fn spawn_subscription(executable: &Path) -> Result<CodexChild> {
    spawn_with_profile(executable, true, Some("VisLex.Codex.Subscription"))
}

fn spawn_with_profile(executable: &Path, internet: bool, stable_name: Option<&str>) -> Result<CodexChild> {
    ensure!(executable.is_absolute() && executable.is_file(), "Codex executable missing");
    let executable = executable.canonicalize()?;
    let runtime = executable.parent().context("Codex runtime directory missing")?.to_path_buf();
    unsafe {
        let name = wide(stable_name.map(str::to_owned).unwrap_or_else(|| format!("VisLex.Codex.{}", uuid::Uuid::new_v4())));
        let mut profile_sid = null_mut();
        let hr = CreateAppContainerProfile(name.as_ptr(), name.as_ptr(), name.as_ptr(), null(), 0, &mut profile_sid);
        if hr == 0x8007_00B7_u32 as i32 && stable_name.is_some() {
            let derive = DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut profile_sid);
            ensure!(derive >= 0 && !profile_sid.is_null(), "Find existing Codex AppContainer failed: {derive:#x}");
        } else {
        ensure!(hr >= 0 && !profile_sid.is_null(), "Create Codex AppContainer failed: {hr:#x}");
        }
        let profile = Profile { name, sid: profile_sid, persistent: stable_name.is_some() };
        let sid = sid_string(profile.sid)?;
        let mut package_path = null_mut();
        let folder_result = GetAppContainerFolderPath(wide(&sid).as_ptr(), &mut package_path);
        ensure!(folder_result >= 0 && !package_path.is_null(), "Locate Codex AppContainer folder failed: {folder_result:#x}");
        let mut length = 0;
        while *package_path.add(length) != 0 { length += 1; }
        let private_home = PathBuf::from(String::from_utf16_lossy(std::slice::from_raw_parts(package_path, length)));
        CoTaskMemFree(package_path as _);
        std::fs::create_dir_all(&private_home)?;
        let package_root = private_home.parent().context("AppContainer package root missing")?.to_path_buf();
        let mut grants = Grants { runtime: runtime.clone(), private_home: private_home.clone(), package_root, sid: sid.clone(), runtime_granted: false, home_granted: false, package_granted: false };
        acl(&runtime, &sid, "RX", false)?;
        grants.runtime_granted = true;
        package_traverse(&grants.package_root, &sid, false)?;
        grants.package_granted = true;
        acl(&private_home, &sid, "M", false)?;
        grants.home_granted = true;
        let (stdin_read, mut stdin_write) = pipe()?;
        let (mut stdout_read, stdout_write) = pipe()?;
        let (mut stderr_read, stderr_write) = pipe()?;
        checked(SetHandleInformation(stdin_write.0, HANDLE_FLAG_INHERIT, 0), "Protect parent stdin")?;
        checked(SetHandleInformation(stdout_read.0, HANDLE_FLAG_INHERIT, 0), "Protect parent stdout")?;
        checked(SetHandleInformation(stderr_read.0, HANDLE_FLAG_INHERIT, 0), "Protect parent stderr")?;
        let child_handles = [stdin_read.0, stdout_write.0, stderr_write.0];
        let mut capability_sid: PSID = null_mut();
        if internet {
            checked(ConvertStringSidToSidW(wide("S-1-15-3-1").as_ptr(), &mut capability_sid), "Internet capability SID")?;
        }
        let mut capability = SID_AND_ATTRIBUTES { Sid: capability_sid, Attributes: 0x0000_0004 }; // SE_GROUP_ENABLED
        let capabilities = SECURITY_CAPABILITIES {
            AppContainerSid: profile.sid,
            Capabilities: if internet { &mut capability } else { null_mut() },
            CapabilityCount: u32::from(internet),
            Reserved: 0,
        };
        let mut size = 0;
        InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut size);
        ensure!(size > 0, "Codex process attribute sizing failed");
        let mut storage = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
        let ptr = storage.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        checked(InitializeProcThreadAttributeList(ptr, 2, 0, &mut size), "Initialize Codex process attributes")?;
        let attributes = Attributes { ptr, _storage: storage };
        checked(UpdateProcThreadAttribute(attributes.ptr, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize, &capabilities as *const _ as _, std::mem::size_of_val(&capabilities), null_mut(), null()), "Set Codex AppContainer policy")?;
        checked(UpdateProcThreadAttribute(attributes.ptr, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, child_handles.as_ptr() as _, std::mem::size_of_val(&child_handles), null_mut(), null()), "Restrict Codex inherited handles")?;
        let mut startup: STARTUPINFOEXW = std::mem::zeroed();
        startup.StartupInfo.cb = std::mem::size_of_val(&startup) as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = stdin_read.0;
        startup.StartupInfo.hStdOutput = stdout_write.0;
        startup.StartupInfo.hStdError = stderr_write.0;
        startup.lpAttributeList = attributes.ptr;
        let binary = wide(&executable);
        let mut command = wide(format!("\"{}\" app-server --listen stdio://", executable.display()));
        let system = std::env::var("SystemRoot")?;
        let vars = [
            format!("APPDATA={}", private_home.display()),
            format!("CODEX_HOME={}", private_home.display()),
            format!("LOCALAPPDATA={}", std::env::var("LOCALAPPDATA")?),
            format!("PATH={system}\\System32"),
            format!("SystemRoot={system}"),
            format!("TEMP={}", std::env::var("TEMP")?),
            format!("TMP={}", std::env::var("TMP")?),
            format!("USERPROFILE={}", private_home.display()),
            format!("HOME={}", private_home.display()),
            format!("HOMEDRIVE={}", private_home.display().to_string().chars().take(2).collect::<String>()),
            format!("HOMEPATH={}", private_home.display().to_string().chars().skip(2).collect::<String>()),
        ];
        let environment = wide(format!("{}\0", vars.join("\0")));
        let mut info: PROCESS_INFORMATION = std::mem::zeroed();
        let started = CreateProcessW(binary.as_ptr(), command.as_mut_ptr(), null(), null(), 1,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
            environment.as_ptr() as _, wide(&private_home).as_ptr(), &startup.StartupInfo, &mut info);
        if !capability_sid.is_null() { LocalFree(capability_sid as _); }
        checked(started, "Start isolated Codex App Server")?;
        let process = Owned(info.hProcess);
        let thread = Owned(info.hThread);
        let job = Owned(CreateJobObjectW(null(), null()));
        ensure!(!job.0.is_null(), "Create Codex process job failed");
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        limits.BasicLimitInformation.ActiveProcessLimit = 8;
        limits.ProcessMemoryLimit = 2 * 1024 * 1024 * 1024;
        checked(SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, &limits as *const _ as _, std::mem::size_of_val(&limits) as u32), "Set Codex process limits")?;
        checked(AssignProcessToJobObject(job.0, process.0), "Assign Codex process job")?;
        ensure!(ResumeThread(thread.0) != u32::MAX, "Resume isolated Codex App Server failed");
        drop(thread);
        drop(stdin_read);
        drop(stdout_write);
        drop(stderr_write);
        Ok(CodexChild {
            stdin: File::from_raw_handle(stdin_write.take()),
            stdout: File::from_raw_handle(stdout_read.take()),
            stderr: File::from_raw_handle(stderr_read.take()),
            home: private_home,
            process, job, _grants: grants, _profile: profile,
        })
    }
}
