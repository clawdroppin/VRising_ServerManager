//! SteamCMD bootstrapping and V Rising dedicated server (AppID 1829350) install / update / validate.

use super::download::{download, extract_zip};
use super::proc::hidden_command;
use crate::error::{AppError, AppResult};
use crate::models::SERVER_APP_ID;
use crate::state::TaskReporter;
use regex::Regex;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use tokio::io::AsyncReadExt;

const STEAMCMD_URL: &str = "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip";

static PROGRESS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"Update state \(0x([0-9a-fA-F]+)\) ([a-z ,]+), progress: ([0-9.]+) \((\d+) / (\d+)\)").unwrap()
});
static BUILDID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""buildid"\s+"(\d+)""#).unwrap());

pub fn exe(dir: &Path) -> PathBuf {
    dir.join("steamcmd.exe")
}

pub async fn ensure(http: &reqwest::Client, dir: &Path, r: &TaskReporter) -> AppResult<PathBuf> {
    let exe_path = exe(dir);
    if !exe_path.exists() {
        r.progress("Downloading SteamCMD", Some(0.0));
        let zip = dir.join("steamcmd.zip");
        download(http, STEAMCMD_URL, &zip, Some(r), "SteamCMD").await?;
        r.progress("Extracting SteamCMD", None);
        extract_zip(&zip, dir).await?;
        let _ = tokio::fs::remove_file(&zip).await;
    }
    // First run self-updates steamcmd; it commonly exits non-zero (e.g. 7) the first time.
    if !dir.join("steamclient.dll").exists() && !dir.join("public").exists() {
        r.progress("Bootstrapping SteamCMD (self-update)", None);
        for _ in 0..3 {
            let (code, _) = run(dir, &["+quit"], r, None).await?;
            if code == 0 {
                break;
            }
        }
    }
    Ok(exe_path)
}

/// Run steamcmd with arguments, streaming every line to the UI log and reporting progress.
pub async fn run(
    dir: &Path,
    args: &[&str],
    r: &TaskReporter,
    cancel: Option<Arc<AtomicBool>>,
) -> AppResult<(i32, String)> {
    let mut cmd = hidden_command(exe(dir));
    cmd.args(args)
        .current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::msg(format!("Failed to launch SteamCMD: {e}")))?;
    let mut stdout = child.stdout.take().unwrap();
    let mut transcript = String::new();
    let mut buf = [0u8; 4096];
    let mut pending = String::new();
    loop {
        if cancel.as_ref().map(|c| c.load(Ordering::Relaxed)).unwrap_or(false) {
            let _ = child.kill().await;
            return Err(AppError::msg("Cancelled"));
        }
        let read = tokio::time::timeout(std::time::Duration::from_millis(500), stdout.read(&mut buf)).await;
        let n = match read {
            Err(_) => continue, // timeout – loop to check cancellation
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => n,
            Ok(Err(e)) => return Err(e.into()),
        };
        pending.push_str(&String::from_utf8_lossy(&buf[..n]));
        while let Some(pos) = pending.find(['\n', '\r']) {
            let line: String = pending.drain(..=pos).collect();
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            transcript.push_str(line);
            transcript.push('\n');
            r.log(line);
            if let Some(c) = PROGRESS_RE.captures(line) {
                let phase = c[2].trim().to_string();
                let pct: f64 = c[3].parse().unwrap_or(0.0);
                let done: f64 = c[4].parse().unwrap_or(0.0);
                let total: f64 = c[5].parse().unwrap_or(0.0);
                if total <= 0.0 {
                    continue;
                }
                r.progress(
                    &format!(
                        "{} – {:.1}% ({:.2} / {:.2} GB)",
                        capitalize(&phase),
                        pct,
                        done / 1e9,
                        total / 1e9
                    ),
                    Some(pct / 100.0),
                );
            } else if line.contains("Logging in") || line.contains("Waiting for") || line.contains("Checking for available update") {
                r.progress(line, None);
            }
        }
    }
    let status = child.wait().await?;
    Ok((status.code().unwrap_or(-1), transcript))
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// Install, update or validate the dedicated server into `install_dir`.
pub async fn app_update(
    http: &reqwest::Client,
    steam_dir: &Path,
    install_dir: &Path,
    branch: &str,
    branch_password: &str,
    validate: bool,
    r: &TaskReporter,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    if !install_dir.is_absolute() {
        return Err(AppError::msg(format!("Install folder {} is not a full path", install_dir.display())));
    }
    ensure(http, steam_dir, r).await?;
    tokio::fs::create_dir_all(install_dir).await?;
    let dir_s = install_dir.to_string_lossy().to_string();
    let app = SERVER_APP_ID.to_string();
    let mut args = vec!["+force_install_dir", dir_s.as_str(), "+login", "anonymous", "+app_update", app.as_str()];
    let branch = branch.trim();
    if !branch.is_empty() && !branch.eq_ignore_ascii_case("public") {
        args.push("-beta");
        args.push(branch);
        if !branch_password.is_empty() {
            args.push("-betapassword");
            args.push(branch_password);
        }
    }
    if validate {
        args.push("validate");
    }
    args.push("+quit");
    let mut last_err = String::new();
    for attempt in 1..=4 {
        r.progress(
            &format!("{} server files (attempt {attempt})", if validate { "Validating" } else { "Downloading" }),
            None,
        );
        let (code, out) = run(steam_dir, &args, r, Some(cancel.clone())).await?;
        let success = out.contains(&format!("Success! App '{app}'")) || (code == 0 && !out.contains("Error!"));
        if success {
            return Ok(());
        }
        last_err = out
            .lines()
            .rev()
            .find(|l| l.contains("Error!") || l.contains("ERROR"))
            .unwrap_or("SteamCMD exited unexpectedly")
            .trim()
            .to_string();
        if let Some(fatal) = explain_fatal(&last_err) {
            return Err(AppError::msg(fatal));
        }
        // 0x602 / 0x6 / timeouts are transient – SteamCMD resumes where it left off.
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    Err(AppError::msg(format!("SteamCMD failed after 4 attempts: {}", explain(&last_err))))
}

/// Errors that will never succeed on retry.
fn explain_fatal(err: &str) -> Option<String> {
    let e = err.to_lowercase();
    if e.contains("0x202") || e.contains("not enough disk space") || e.contains("disk write failure") {
        return Some(format!("Not enough free disk space or the folder is not writable ({err})"));
    }
    if e.contains("no subscription") {
        return Some(format!(
            "Steam refused the download ({err}). The dedicated server is AppID {SERVER_APP_ID}; if this persists Steam may be having an outage."
        ));
    }
    if e.contains("invalid platform") {
        return Some(format!("Steam reports the server isn't available for this platform ({err})"));
    }
    None
}

/// Plain-language hints for transient errors.
fn explain(err: &str) -> String {
    let e = err.to_lowercase();
    let hint = if e.contains("missing configuration") {
        "SteamCMD's app cache is stale – try again, or delete the appcache folder inside the SteamCMD directory"
    } else if e.contains("0x602") || e.contains("0x6") || e.contains("timeout") || e.contains("no connection") {
        "network interruption while downloading – check your connection and retry (progress is kept)"
    } else if e.contains("0x402") || e.contains("0x412") {
        "Steam's content servers are busy – retry in a few minutes"
    } else if e.contains("file locked") || e.contains("access is denied") {
        "a file is locked – make sure the server isn't running and no other program has the folder open"
    } else {
        "see the SteamCMD lines in the Console tab for details"
    };
    format!("{err} – {hint}")
}

pub fn local_build(install_dir: &Path) -> Option<String> {
    let manifest = install_dir.join("steamapps").join(format!("appmanifest_{SERVER_APP_ID}.acf"));
    let text = std::fs::read_to_string(manifest).ok()?;
    BUILDID_RE.captures(&text).map(|c| c[1].to_string())
}

/// Manifest `StateFlags` other than 4 (fully installed) indicate an interrupted update.
pub fn manifest_state_flags(install_dir: &Path) -> Option<u32> {
    let manifest = install_dir.join("steamapps").join(format!("appmanifest_{SERVER_APP_ID}.acf"));
    let text = std::fs::read_to_string(manifest).ok()?;
    let re = Regex::new(r#""StateFlags"\s+"(\d+)""#).ok()?;
    re.captures(&text).and_then(|c| c[1].parse().ok())
}

/// Live build of a branch from api.steamcmd.net (a public mirror of Steam's app info). Seconds
/// faster than starting SteamCMD and needs no SteamCMD lock; `None` on any problem.
pub async fn latest_build_web(http: &reqwest::Client, branch: &str) -> Option<String> {
    let branch = if branch.trim().is_empty() { "public" } else { branch.trim() };
    let v: serde_json::Value = http
        .get(format!("https://api.steamcmd.net/v1/info/{SERVER_APP_ID}"))
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    v["data"][SERVER_APP_ID.to_string()]["depots"]["branches"][branch]["buildid"].as_str().map(|s| s.to_string())
}

pub async fn latest_build(http: &reqwest::Client, steam_dir: &Path, branch: &str, r: &TaskReporter) -> AppResult<Option<String>> {
    ensure(http, steam_dir, r).await?;
    let app = SERVER_APP_ID.to_string();
    let (_, out) = run(
        steam_dir,
        &["+login", "anonymous", "+app_info_update", "1", "+app_info_print", app.as_str(), "+quit"],
        r,
        None,
    )
    .await?;
    Ok(parse_branch_build(&out, branch))
}

/// The first buildid after the branch key inside the "branches" block.
pub fn parse_branch_build(out: &str, branch: &str) -> Option<String> {
    let branch = if branch.trim().is_empty() { "public" } else { branch.trim() };
    let start = out.find("\"branches\"").unwrap_or(0);
    let key = format!("\"{branch}\"");
    let idx = out[start..].find(&key).map(|i| start + i)?;
    BUILDID_RE.captures(&out[idx..]).map(|c| c[1].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn branch_build_parsing() {
        let out = "\"depots\"\n{\n\"branches\"\n{\n\"public\"\n{\n\"buildid\"\t\t\"111\"\n}\n\"beta\"\n{\n\"buildid\"\t\t\"222\"\n}\n}\n}";
        assert_eq!(parse_branch_build(out, "public").as_deref(), Some("111"));
        assert_eq!(parse_branch_build(out, "").as_deref(), Some("111"));
        assert_eq!(parse_branch_build(out, "beta").as_deref(), Some("222"));
        assert_eq!(parse_branch_build(out, "nope"), None);
    }
}

/// V Rising dedicated-server installs made by the Steam client (Library → Tools).
pub async fn find_steam_client_installs() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = vec![];
    if let Ok((_, out)) = super::proc::capture("reg.exe", &["query", r"HKCU\Software\Valve\Steam", "/v", "SteamPath"]).await {
        if let Some(l) = out.lines().find(|l| l.contains("SteamPath")) {
            if let Some(p) = l.split("REG_SZ").nth(1) {
                roots.push(PathBuf::from(p.trim().replace('/', "\\")));
            }
        }
    }
    roots.push(PathBuf::from(r"C:\Program Files (x86)\Steam"));
    let path_re = Regex::new(r#""path"\s+"([^"]+)""#).unwrap();
    let mut libs: Vec<PathBuf> = vec![];
    for r in &roots {
        libs.push(r.clone());
        if let Ok(t) = std::fs::read_to_string(r.join("steamapps").join("libraryfolders.vdf")) {
            for c in path_re.captures_iter(&t) {
                libs.push(PathBuf::from(c[1].replace("\\\\", "\\")));
            }
        }
    }
    let dir_re = Regex::new(r#""installdir"\s+"([^"]+)""#).unwrap();
    let mut out: Vec<PathBuf> = vec![];
    for lib in libs {
        let acf = lib.join("steamapps").join(format!("appmanifest_{SERVER_APP_ID}.acf"));
        if let Ok(t) = std::fs::read_to_string(&acf) {
            if let Some(c) = dir_re.captures(&t) {
                let p = lib.join("steamapps").join("common").join(&c[1]);
                if p.exists() && !out.iter().any(|o| super::proc::norm(o) == super::proc::norm(&p)) {
                    out.push(p);
                }
            }
        }
    }
    out
}
