//! Where the app keeps its data.
//!
//! * **Installed**: the OS app-data folder (`%APPDATA%\com.vrisingservermanager.app`).
//! * **Portable**: when a `portable.txt` marker sits next to the executable, everything lives in a
//!   `data` folder beside it – settings, profiles, SteamCMD, default server installs, backups
//!   and the WebView2 profile – so the whole folder can be moved or put on a USB drive.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const PORTABLE_MARKER: &str = "portable.txt";

#[derive(Debug, Clone)]
pub struct DataLocation {
    pub dir: PathBuf,
    pub portable: bool,
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(Path::to_path_buf)
}

fn writable(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write-test");
    let ok = std::fs::write(&probe, b"ok").is_ok();
    let _ = std::fs::remove_file(probe);
    ok
}

pub fn resolve(app: &AppHandle) -> tauri::Result<DataLocation> {
    if let Some(exe) = exe_dir() {
        if exe.join(PORTABLE_MARKER).exists() {
            let dir = exe.join("data");
            if writable(&dir) {
                return Ok(DataLocation { dir, portable: true });
            }
            // e.g. portable build unpacked into Program Files – fall back rather than fail to start.
            eprintln!("Portable data folder {} is not writable; using app data instead", dir.display());
        }
    }
    Ok(DataLocation { dir: app.path().app_data_dir()?, portable: false })
}

/// If `path` lives under `old_base`, re-root it under `new_base` (used when a portable folder moves).
pub fn rebase(path: &Path, old_base: &Path, new_base: &Path) -> Option<PathBuf> {
    let p = path.to_string_lossy().to_lowercase().replace('/', "\\");
    let o = old_base.to_string_lossy().to_lowercase().replace('/', "\\");
    let o = o.trim_end_matches('\\');
    if p == o || p.starts_with(&format!("{o}\\")) {
        let rel = &path.to_string_lossy()[o.len()..];
        Some(PathBuf::from(format!("{}{}", new_base.display(), rel)))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rebase_paths() {
        let r = rebase(Path::new(r"E:\DWSM\data\servers\x"), Path::new(r"e:\dwsm\data"), Path::new(r"F:\Tools\DWSM\data"));
        assert_eq!(r.unwrap(), PathBuf::from(r"F:\Tools\DWSM\data\servers\x"));
        assert!(rebase(Path::new(r"D:\other"), Path::new(r"E:\DWSM\data"), Path::new(r"F:\x")).is_none());
        assert!(rebase(Path::new(r"E:\DWSM\database"), Path::new(r"E:\DWSM\data"), Path::new(r"F:\x")).is_none());
    }
}
