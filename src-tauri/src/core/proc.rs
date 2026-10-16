//! Process helpers: hidden spawning, the detached server launch, graceful console shutdown,
//! priority / affinity, console-window visibility, PID discovery and port owners.

use crate::error::{AppError, AppResult};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::Path;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A tokio Command that never flashes a console window on Windows.
pub fn hidden_command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut c = tokio::process::Command::new(program);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// Run a program to completion and capture stdout+stderr as text.
pub async fn capture(program: &str, args: &[&str]) -> AppResult<(i32, String)> {
    let out = hidden_command(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| AppError::msg(format!("Failed to run {program}: {e}")))?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok((out.status.code().unwrap_or(-1), text))
}

pub async fn powershell(script: &str) -> AppResult<(i32, String)> {
    capture("powershell.exe", &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]).await
}

/// Run a PowerShell script elevated (one UAC prompt). Waits for completion and returns its output.
pub async fn powershell_elevated(script: &str, work_dir: &Path) -> AppResult<String> {
    tokio::fs::create_dir_all(work_dir).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let ps1 = work_dir.join(format!("elevated-{id}.ps1"));
    let log = work_dir.join(format!("elevated-{id}.log"));
    let wrapped = format!(
        "$ErrorActionPreference='Continue'\r\nStart-Transcript -Path '{}' | Out-Null\r\ntry {{\r\n{}\r\n}} catch {{ Write-Output (\"ERROR: \" + $_) }}\r\nStop-Transcript | Out-Null\r\n",
        log.display(),
        script
    );
    tokio::fs::write(&ps1, wrapped).await?;
    let launcher = format!(
        "try {{ $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','\"{}\"'); exit $p.ExitCode }} catch {{ Write-Output 'UAC_DECLINED'; exit 1223 }}",
        ps1.display()
    );
    let (code, out) = powershell(&launcher).await?;
    let transcript = tokio::fs::read_to_string(&log).await.unwrap_or_default();
    let _ = tokio::fs::remove_file(&ps1).await;
    let _ = tokio::fs::remove_file(&log).await;
    if code == 1223 || out.contains("UAC_DECLINED") {
        return Err(AppError::msg("Administrator permission was declined"));
    }
    Ok(transcript)
}

pub fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// True when `path` is `dir` itself or lies inside it. Plain prefix matching would accept
/// `D:\srv\ab\…` as inside `D:\srv\a`.
pub fn is_within(path: &Path, dir: &Path) -> bool {
    let (p, d) = (norm(path), norm(dir));
    !d.is_empty() && (p == d || p.starts_with(&format!("{d}\\")))
}

#[derive(Debug, Clone)]
pub struct ServerProc {
    pub pid: u32,
    pub exe: String,
}

/// Every running `VRisingServer.exe` – one scan serves all instances; each instance claims the
/// ones whose exe lives in its install folder.
pub fn scan_servers(sys: &mut System) -> Vec<ServerProc> {
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
    );
    sys.processes()
        .iter()
        .filter(|(_, p)| is_server_name(&p.name().to_string_lossy()))
        .filter_map(|(pid, p)| {
            p.exe().map(|e| ServerProc { pid: pid.as_u32(), exe: norm(e) })
        })
        .collect()
}

pub fn is_server_name(name: &str) -> bool {
    name.eq_ignore_ascii_case(crate::models::SERVER_EXE)
}

/// Processes belonging to the server installed at `install_dir`.
pub fn procs_for_install<'a>(all: &'a [ServerProc], install_dir: &Path) -> Vec<&'a ServerProc> {
    let base = format!("{}\\", norm(install_dir));
    all.iter().filter(|p| p.exe.starts_with(&base)).collect()
}

pub fn pid_alive(sys: &mut System, pid: u32) -> bool {
    let p = sysinfo::Pid::from_u32(pid);
    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[p]), true, ProcessRefreshKind::nothing());
    sys.process(p).is_some()
}

pub async fn kill_tree(pid: u32) -> AppResult<()> {
    let pid_s = pid.to_string();
    let (code, out) = capture("taskkill.exe", &["/PID", &pid_s, "/T", "/F"]).await?;
    if code != 0 && !out.to_lowercase().contains("not found") {
        return Err(AppError::msg(format!("taskkill failed: {}", out.trim())));
    }
    Ok(())
}

/// UDP port -> owning PID, parsed from one `netstat -ano -p UDP` call.
pub async fn udp_port_owners() -> HashMap<u16, u32> {
    let mut map = HashMap::new();
    let Ok((_, out)) = capture("netstat.exe", &["-ano", "-p", "UDP"]).await else { return map };
    for l in out.lines() {
        let cols: Vec<&str> = l.split_whitespace().collect();
        if cols.len() < 4 || !cols[0].eq_ignore_ascii_case("UDP") {
            continue;
        }
        let Some(port) = cols[1].rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) else { continue };
        if let Some(pid) = cols.last().and_then(|p| p.parse::<u32>().ok()) {
            map.entry(port).or_insert(pid);
        }
    }
    map
}

/// Listening TCP port -> owning PID, parsed from one `netstat -ano -p TCP` call.
pub async fn tcp_listen_owners() -> HashMap<u16, u32> {
    let mut map = HashMap::new();
    let Ok((_, out)) = capture("netstat.exe", &["-ano", "-p", "TCP"]).await else { return map };
    for l in out.lines() {
        let cols: Vec<&str> = l.split_whitespace().collect();
        if cols.len() < 5 || !cols[0].eq_ignore_ascii_case("TCP") || !cols[3].eq_ignore_ascii_case("LISTENING") {
            continue;
        }
        let Some(port) = cols[1].rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) else { continue };
        if let Some(pid) = cols.last().and_then(|p| p.parse::<u32>().ok()) {
            map.entry(port).or_insert(pid);
        }
    }
    map
}

pub fn process_name(sys: &mut System, pid: u32) -> Option<String> {
    let p = sysinfo::Pid::from_u32(pid);
    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[p]), false, ProcessRefreshKind::nothing());
    sys.process(p).map(|p| p.name().to_string_lossy().into_owned())
}

pub fn priority_class(name: &str) -> u32 {
    match name {
        "idle" => 0x40,
        "belowNormal" => 0x4000,
        "aboveNormal" => 0x8000,
        "high" => 0x80,
        _ => 0x20,
    }
}

/// Launch the server fully detached from the manager (it keeps running if the manager closes).
/// Returns the PID. The server is a console program: it always gets a console of its own
/// (CREATE_NEW_CONSOLE – never the manager's, or a console break would hit both), started hidden
/// when `hidden` is set.
#[cfg(windows)]
pub fn spawn_server(exe: &Path, args: &[String], hidden: bool, priority: &str) -> AppResult<u32> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{CreateProcessW, PROCESS_INFORMATION, STARTF_USESHOWWINDOW, STARTUPINFOW};

    let mut cmdline = format!("\"{}\"", exe.display());
    for a in args {
        cmdline.push(' ');
        cmdline.push_str(a);
    }
    let mut cmd_w: Vec<u16> = OsStr::new(&cmdline).encode_wide().chain(Some(0)).collect();
    let cwd = exe.parent().unwrap_or(Path::new("."));
    let cwd_w: Vec<u16> = cwd.as_os_str().encode_wide().chain(Some(0)).collect();
    let exe_w: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();

    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    const CREATE_DEFAULT_ERROR_MODE: u32 = 0x0400_0000;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    let base_flags = CREATE_NEW_CONSOLE | CREATE_DEFAULT_ERROR_MODE | priority_class(priority);
    for flags in [base_flags | CREATE_BREAKAWAY_FROM_JOB, base_flags] {
        // SAFETY: plain Win32 call with properly NUL-terminated wide strings that outlive the call.
        unsafe {
            let mut si: STARTUPINFOW = std::mem::zeroed();
            si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            si.dwFlags = STARTF_USESHOWWINDOW;
            // SW_HIDE (0) or SW_SHOWMINNOACTIVE (7) for the new console window.
            si.wShowWindow = if hidden { 0 } else { 7 };
            let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
            let ok = CreateProcessW(
                exe_w.as_ptr(),
                cmd_w.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                flags,
                std::ptr::null(),
                cwd_w.as_ptr(),
                &si,
                &mut pi,
            );
            if ok != 0 {
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
                return Ok(pi.dwProcessId);
            }
        }
    }
    Err(AppError::msg(format!("Failed to launch server: {}", std::io::Error::last_os_error())))
}

#[cfg(not(windows))]
pub fn spawn_server(exe: &Path, args: &[String], _hidden: bool, _priority: &str) -> AppResult<u32> {
    let child = std::process::Command::new(exe)
        .args(args)
        .current_dir(exe.parent().unwrap_or(Path::new(".")))
        .spawn()
        .map_err(|e| AppError::msg(format!("Failed to launch server: {e}")))?;
    Ok(child.id())
}

/// Apply priority class and CPU affinity to a running process (works live).
#[cfg(windows)]
pub fn apply_priority_affinity(pid: u32, priority: &str, affinity: &[u32]) -> AppResult<()> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, SetPriorityClass, SetProcessAffinityMask, PROCESS_SET_INFORMATION, PROCESS_QUERY_INFORMATION};
    // SAFETY: handle is checked and closed; masks are plain integers.
    unsafe {
        let h = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_INFORMATION, 0, pid);
        if h.is_null() {
            return Err(AppError::msg(format!("Cannot open process {pid}: {}", std::io::Error::last_os_error())));
        }
        SetPriorityClass(h, priority_class(priority));
        if !affinity.is_empty() {
            let mask: usize = affinity.iter().filter(|c| **c < usize::BITS).fold(0usize, |m, c| m | (1usize << c));
            if mask != 0 {
                SetProcessAffinityMask(h, mask);
            }
        }
        CloseHandle(h);
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn apply_priority_affinity(_pid: u32, _priority: &str, _affinity: &[u32]) -> AppResult<()> {
    Ok(())
}

/// Show or hide every console window owned by `pids`. Returns how many windows were found.
#[cfg(windows)]
pub fn set_console_visible(pids: &[u32], visible: bool) -> usize {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetClassNameW, GetWindowThreadProcessId, ShowWindow};

    struct Ctx {
        pids: Vec<u32>,
        found: Vec<HWND>,
    }
    unsafe extern "system" fn cb(hwnd: HWND, lp: LPARAM) -> i32 {
        // SAFETY: lp is the &mut Ctx passed below, valid for the duration of EnumWindows.
        let ctx = &mut *(lp as *mut Ctx);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if ctx.pids.contains(&pid) {
            let mut buf = [0u16; 64];
            let n = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            let class = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
            if class == "ConsoleWindowClass" {
                ctx.found.push(hwnd);
            }
        }
        1
    }
    let mut ctx = Ctx { pids: pids.to_vec(), found: vec![] };
    // SAFETY: callback only touches ctx through the pointer we hand it.
    unsafe {
        EnumWindows(Some(cb), &mut ctx as *mut Ctx as LPARAM);
        for h in &ctx.found {
            ShowWindow(*h, if visible { 4 } else { 0 });
        }
    }
    ctx.found.len()
}

#[cfg(not(windows))]
pub fn set_console_visible(_pids: &[u32], _visible: bool) -> usize {
    0
}

/// Ask a server to save and shut down (it treats a console break as an exit request). Runs our
/// own exe in helper mode so the manager never attaches to a foreign console. Returns false when
/// the server has no console to signal.
pub async fn request_graceful_exit(pid: u32) -> bool {
    let Ok(me) = std::env::current_exe() else { return false };
    let mut cmd = tokio::process::Command::new(me);
    cmd.arg("--send-ctrl-c").arg(pid.to_string());
    #[cfg(windows)]
    cmd.creation_flags(0x0000_0008); // DETACHED_PROCESS: helper starts with no console of its own
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    match cmd.status().await {
        Ok(s) => s.code() == Some(0),
        Err(_) => false,
    }
}

/// Helper-mode body (see main.rs): attach to the target console and raise Ctrl+Break.
///
/// Ctrl+Break rather than Ctrl+C: a process inherits "ignore Ctrl+C" from whoever launched it
/// (verified – a server started from a shell that ignores Ctrl+C swallowed it), while Ctrl+Break
/// is always delivered. V Rising handles both the same way (verified): `GameBootstrap.OnApplicationQuit()`,
/// `SaveOnExit() - Saving the world on exit!`, a fresh `AutoSave_N` and a clean exit within seconds.
#[cfg(windows)]
pub fn send_ctrl_c(pid: u32) -> i32 {
    use windows_sys::Win32::System::Console::{AttachConsole, FreeConsole, GenerateConsoleCtrlEvent, SetConsoleCtrlHandler, CTRL_BREAK_EVENT};
    unsafe extern "system" fn swallow(_: u32) -> i32 {
        1
    }
    // SAFETY: straightforward console API sequence in a short-lived helper process.
    unsafe {
        FreeConsole();
        if AttachConsole(pid) == 0 {
            return 3;
        }
        // Don't let the event kill this helper.
        SetConsoleCtrlHandler(Some(swallow), 1);
        let ok = GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, 0);
        std::thread::sleep(std::time::Duration::from_millis(400));
        FreeConsole();
        if ok != 0 {
            0
        } else {
            4
        }
    }
}

#[cfg(not(windows))]
pub fn send_ctrl_c(_pid: u32) -> i32 {
    5
}

/// Fast pre-check (no WMI): is any WebView2 process running whose parent has exited?
pub fn orphan_webview_suspected() -> bool {
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    sys.processes().values().any(|p| {
        if !p.name().to_string_lossy().eq_ignore_ascii_case("msedgewebview2.exe") {
            return false;
        }
        match p.parent().map(|pp| sys.process(pp)) {
            Some(None) => true,
            // PID reuse: a "parent" that started after its child is someone else.
            Some(Some(parent)) => parent.start_time() > p.start_time(),
            None => false,
        }
    })
}

/// WebView2 browser processes left behind by a previous manager run (hard kill / crash) keep the
/// browser profile locked and window creation fails with "The requested resource is in use".
/// The single-instance plugin guarantees no other manager is running, so any embedded WebView
/// tagged with our exe name whose parent process is gone is an orphan. Uses WMI because the
/// command line of WebView2 processes isn't readable otherwise. Returns how many were killed.
pub fn kill_orphaned_webviews() -> usize {
    let Ok(me) = std::env::current_exe() else { return 0 };
    let exe_name = me.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let script = format!(
        "$n=0; Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Where-Object {{ $_.CommandLine -like '*--embedded-browser-webview*' -and $_.CommandLine -like '*--webview-exe-name={exe}*' -and -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) }} | ForEach-Object {{ taskkill.exe /PID $_.ProcessId /T /F | Out-Null; $n++ }}; $n",
        exe = exe_name.replace('\'', "''")
    );
    let mut c = std::process::Command::new("powershell.exe");
    c.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c.output().ok().and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn install_matching_is_prefix_safe() {
        let all = vec![
            ServerProc { pid: 1, exe: norm(Path::new(r"D:\srv\a\VRisingServer.exe")) },
            ServerProc { pid: 2, exe: norm(Path::new(r"D:\srv\ab\VRisingServer.exe")) },
        ];
        let mine = procs_for_install(&all, Path::new(r"D:\srv\a\"));
        assert_eq!(mine.iter().map(|p| p.pid).collect::<Vec<_>>(), vec![1]);
        assert!(is_server_name("vrisingserver.exe"));
    }

    #[test]
    fn within_is_component_safe() {
        assert!(is_within(Path::new(r"D:\srv\a\Backups\x.zip"), Path::new(r"d:\SRV\a")));
        assert!(!is_within(Path::new(r"D:\srv\ab\x.zip"), Path::new(r"D:\srv\a")));
        assert!(is_within(Path::new(r"D:\srv\a"), Path::new(r"D:\srv\a\")));
    }
}

