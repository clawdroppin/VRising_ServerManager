//! Worlds (save folders).
//!
//! The server keeps each world in `<data>\Saves\v4\<SaveName>\` (verified with v1.1.15.0):
//! `AutoSave_<n>.save.gz` (or `.save` with `CompressSaveFiles: false`) every `AutoSaveInterval`
//! seconds and on a clean stop, numbered upwards; `AutoSaveSmartKeep` thins out old ones. On start it
//! loads the most recent autosave (`Loaded Save:AutoSave_0.save.gz`). `SessionId.json` and
//! `StartDate.json` sit next to them. Older game versions used `v3` / `v1` folders with one
//! sub-folder per autosave; those are listed too so they can be exported or imported.
//!
//! Rolling back copies an older autosave to the next number, so it becomes the newest one and
//! nothing is overwritten.

use super::backup::copy_dir;
use crate::error::{AppError, AppResult};
use crate::models::*;
use regex::Regex;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::SystemTime;

static AUTOSAVE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^AutoSave_(\d+)(\.save(?:\.gz)?)?$").unwrap());

fn ms(t: SystemTime) -> i64 {
    chrono::DateTime::<chrono::Utc>::from(t).timestamp_millis()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSave {
    pub file: String,
    pub number: u32,
    pub size: u64,
    pub modified: i64,
    /// The one the server loads next (highest number).
    pub latest: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct World {
    pub name: String,
    /// `v4`, `v3` …
    pub version: String,
    /// The world the server loads (`SaveName`).
    pub active: bool,
    pub saves: Vec<AutoSave>,
    pub saved_at: Option<i64>,
    /// `StartDate.json` – when the world was created.
    pub start_date: Option<String>,
    /// Its own ServerGameSettings.json (worlds hosted from the game client carry one).
    pub has_settings: bool,
    pub size: u64,
    pub dir: PathBuf,
}

fn dir_size(p: &Path) -> u64 {
    walkdir::WalkDir::new(p).into_iter().flatten().filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum()
}

/// Read one world folder; None when it holds no autosaves (and isn't a fresh, empty world).
pub fn read_world(dir: &Path, version: &str, active_name: Option<&str>) -> Option<World> {
    let name = dir.file_name()?.to_string_lossy().into_owned();
    if name.starts_with('_') || name.starts_with('.') {
        return None;
    }
    let mut saves = vec![];
    let mut size = 0;
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        let Ok(meta) = e.metadata() else { continue };
        if let Some(c) = AUTOSAVE_RE.captures(&n) {
            let s = if meta.is_dir() { dir_size(&e.path()) } else { meta.len() };
            size += s;
            saves.push(AutoSave { file: n.clone(), number: c[1].parse().unwrap_or(0), size: s, modified: meta.modified().map(ms).unwrap_or(0), latest: false });
        } else if meta.is_file() {
            size += meta.len();
        }
    }
    let has_meta = dir.join("SessionId.json").exists() || dir.join("StartDate.json").exists();
    if saves.is_empty() && !has_meta {
        return None;
    }
    saves.sort_by(|a, b| b.number.cmp(&a.number));
    if let Some(first) = saves.first_mut() {
        first.latest = true;
    }
    let start_date = std::fs::read_to_string(dir.join("StartDate.json")).ok().map(|s| s.trim().trim_matches('"').to_string()).filter(|s| !s.is_empty());
    Some(World {
        active: active_name.map(|a| a.eq_ignore_ascii_case(&name)).unwrap_or(false) && version == SAVE_VERSION_DIR,
        saved_at: saves.iter().map(|s| s.modified).max(),
        has_settings: dir.join(GAME_FILE).exists(),
        start_date,
        name,
        version: version.to_string(),
        saves,
        size,
        dir: dir.to_path_buf(),
    })
}

/// Every world under a `Saves` folder (all format versions), the active one first.
pub fn scan_root(root: &Path, active_name: Option<&str>) -> Vec<World> {
    let mut out = vec![];
    let Ok(rd) = std::fs::read_dir(root) else { return out };
    for v in rd.flatten().filter(|e| e.path().is_dir()) {
        let version = v.file_name().to_string_lossy().into_owned();
        if !version.starts_with('v') {
            continue;
        }
        let Ok(worlds) = std::fs::read_dir(v.path()) else { continue };
        for w in worlds.flatten().filter(|e| e.path().is_dir()) {
            if let Some(world) = read_world(&w.path(), &version, active_name) {
                out.push(world);
            }
        }
    }
    out.sort_by(|a, b| b.active.cmp(&a.active).then(b.version.cmp(&a.version)).then(b.saved_at.cmp(&a.saved_at)));
    out
}

pub fn list(inst: &ServerInstance) -> Vec<World> {
    scan_root(&inst.saves_root(), Some(inst.config.save_name.trim()))
}

/// Worlds in any folder the user picks: a `Saves` folder, a `v4` folder or one world folder.
pub fn scan_any(dir: &Path) -> Vec<World> {
    if let Some(w) = read_world(dir, dir.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).filter(|v| v.starts_with('v')).as_deref().unwrap_or(SAVE_VERSION_DIR), None) {
        if !w.saves.is_empty() {
            return vec![w];
        }
    }
    let direct: Vec<World> = std::fs::read_dir(dir)
        .map(|rd| rd.flatten().filter(|e| e.path().is_dir()).filter_map(|e| read_world(&e.path(), SAVE_VERSION_DIR, None)).filter(|w| !w.saves.is_empty()).collect())
        .unwrap_or_default();
    if !direct.is_empty() {
        return direct;
    }
    scan_root(dir, None).into_iter().filter(|w| !w.saves.is_empty()).collect()
}

/// A world name that's also a safe folder name.
pub fn check_name(name: &str) -> AppResult<&str> {
    let n = name.trim();
    if n.is_empty() || n.len() > 64 || n.starts_with('.') || n.starts_with('_') || n.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
        return Err(AppError::msg(format!("“{n}” can't be used as a world name – it becomes a folder name.")));
    }
    Ok(n)
}

fn world_path(inst: &ServerInstance, version: &str, name: &str) -> AppResult<PathBuf> {
    let name = check_name(name)?;
    if !version.starts_with('v') || version.len() > 4 || version.contains(['\\', '/', '.']) {
        return Err(AppError::msg("Invalid save version"));
    }
    let p = inst.saves_root().join(version).join(name);
    if !p.is_dir() {
        return Err(AppError::msg(format!("World “{name}” wasn't found.")));
    }
    Ok(p)
}

/// A free world name based on `base` (`base`, `base-2` …).
pub fn unique_name(inst: &ServerInstance, base: &str) -> String {
    let base = base.trim();
    let mut n = base.to_string();
    let mut i = 2;
    while inst.saves_dir().join(&n).exists() {
        n = format!("{base}-{i}");
        i += 1;
    }
    n
}

/// Move a folder into `Saves\_quarantine` (recoverable). Returns where it went.
pub fn quarantine_dir(inst: &ServerInstance, dir: &Path, label: &str) -> AppResult<Option<PathBuf>> {
    if !dir.exists() {
        return Ok(None);
    }
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let name = dir.file_name().unwrap_or_default().to_string_lossy();
    let q = inst.saves_root().join("_quarantine").join(format!("{stamp}-{label}-{name}"));
    std::fs::create_dir_all(q.parent().unwrap())?;
    if std::fs::rename(dir, &q).is_err() {
        // Something holds a handle on the folder itself (an Explorer window, a sync tool, an
        // antivirus scan, an IDE's file watcher): moving what's inside still works.
        move_contents(dir, &q)?;
        let _ = std::fs::remove_dir(dir);
    }
    Ok(Some(q))
}

/// Move every entry of `from` into `to` (renames; a sub-folder that can't be renamed is moved
/// entry by entry the same way).
fn move_contents(from: &Path, to: &Path) -> AppResult<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)?.flatten() {
        let target = to.join(e.file_name());
        if std::fs::rename(e.path(), &target).is_err() {
            if e.path().is_dir() {
                move_contents(&e.path(), &target)?;
                let _ = std::fs::remove_dir(e.path());
            } else {
                std::fs::copy(e.path(), &target)?;
                std::fs::remove_file(e.path())?;
            }
        }
    }
    Ok(())
}

/// Make an older autosave the one the server loads next: copy it to the next number up.
pub fn restore_autosave(inst: &ServerInstance, version: &str, name: &str, number: u32) -> AppResult<String> {
    let dir = world_path(inst, version, name)?;
    let world = read_world(&dir, version, None).ok_or_else(|| AppError::msg("That world has no autosaves."))?;
    let src = world.saves.iter().find(|s| s.number == number).ok_or_else(|| AppError::msg("That autosave doesn't exist any more."))?;
    let top = world.saves.first().map(|s| s.number).unwrap_or(0);
    if src.number == top {
        return Ok(src.file.clone());
    }
    let suffix = src.file.strip_prefix(&format!("AutoSave_{}", src.number)).unwrap_or("");
    let target = format!("AutoSave_{}{suffix}", top + 1);
    let from = dir.join(&src.file);
    if from.is_dir() {
        copy_dir(&from, &dir.join(&target))?;
    } else {
        // read + write (not fs::copy) so the copy gets a fresh modified time too.
        let bytes = std::fs::read(&from)?;
        std::fs::write(dir.join(&target), bytes)?;
    }
    Ok(target)
}

/// Copy a world in from another folder (a game client's save, an old server) under a free name.
/// Its ServerGameSettings.json comes along inside the world folder; `adopt_settings` also copies
/// it over the server's own.
pub fn import(inst: &ServerInstance, src: &Path, name: &str, adopt_settings: bool) -> AppResult<(String, usize)> {
    let name = check_name(name)?;
    let world = read_world(src, SAVE_VERSION_DIR, None).filter(|w| !w.saves.is_empty()).ok_or_else(|| AppError::msg("That folder doesn't contain V Rising autosaves (AutoSave_N files)."))?;
    if src.parent().map(|p| super::proc::norm(p) == super::proc::norm(&inst.saves_dir())).unwrap_or(false) {
        return Err(AppError::msg("That world is already on this server."));
    }
    let target_name = unique_name(inst, name);
    let dest = inst.saves_dir().join(&target_name);
    let n = copy_dir(src, &dest)?;
    if adopt_settings && world.has_settings {
        std::fs::create_dir_all(inst.settings_dir())?;
        let text = std::fs::read_to_string(src.join(GAME_FILE))?;
        super::config::parse_doc(&text).map_err(|e| AppError::msg(format!("The world's {GAME_FILE} {e}")))?;
        super::config::write_text(&inst.game_path(), text.trim_start_matches('\u{feff}'))?;
    }
    Ok((target_name, n))
}

/// Copy a world on this server under a new name (to branch off a season, test a change …).
pub fn duplicate(inst: &ServerInstance, version: &str, name: &str, new_name: &str) -> AppResult<String> {
    let src = world_path(inst, version, name)?;
    let target = unique_name(inst, check_name(new_name)?);
    copy_dir(&src, &inst.saves_dir().join(&target))?;
    Ok(target)
}

/// Rename a world folder. The caller points `SaveName` at the new name when it was the active one.
pub fn rename(inst: &ServerInstance, version: &str, name: &str, new_name: &str) -> AppResult<String> {
    let src = world_path(inst, version, name)?;
    let new_name = check_name(new_name)?;
    if new_name == name.trim() {
        return Ok(new_name.to_string());
    }
    let dest = src.parent().unwrap_or(&src).join(new_name);
    // Case-only renames are fine on Windows; anything else must not exist yet.
    if dest.exists() && !new_name.eq_ignore_ascii_case(name.trim()) {
        return Err(AppError::msg(format!("A world called “{new_name}” already exists.")));
    }
    std::fs::rename(&src, &dest).map_err(|e| AppError::msg(format!("Couldn't rename the world folder ({e}) – close anything that has it open.")))?;
    Ok(new_name.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCheck {
    pub file: String,
    pub number: u32,
    pub ok: bool,
    /// Uncompressed size (what the server loads).
    pub bytes: u64,
    pub error: Option<String>,
}

/// Test every autosave of a world: `.save.gz` files are decompressed completely (gzip checks its
/// CRC), so a save cut off by a crash or a full disk shows up before the server tries to load it.
pub fn check_saves(inst: &ServerInstance, version: &str, name: &str) -> AppResult<Vec<SaveCheck>> {
    let dir = world_path(inst, version, name)?;
    let world = read_world(&dir, version, None).ok_or_else(|| AppError::msg("That world has no autosaves."))?;
    Ok(world.saves.iter().map(|s| check_save(&dir.join(&s.file), &s.file, s.number)).collect())
}

fn check_save(path: &Path, file: &str, number: u32) -> SaveCheck {
    let mut c = SaveCheck { file: file.to_string(), number, ok: true, bytes: 0, error: None };
    if path.is_dir() {
        // Old (v1/v3) layout: a folder of files – only check that it isn't empty.
        c.bytes = dir_size(path);
    } else if file.ends_with(".gz") {
        let res = std::fs::File::open(path).and_then(|f| std::io::copy(&mut flate2::read::MultiGzDecoder::new(std::io::BufReader::new(f)), &mut std::io::sink()));
        match res {
            Ok(n) => c.bytes = n,
            Err(e) => c.error = Some(format!("damaged ({e})")),
        }
    } else {
        c.bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    }
    if c.error.is_none() && c.bytes == 0 {
        c.error = Some("empty".into());
    }
    c.ok = c.error.is_none();
    c
}

pub fn remove(inst: &ServerInstance, version: &str, name: &str) -> AppResult<Option<PathBuf>> {
    let dir = world_path(inst, version, name)?;
    quarantine_dir(inst, &dir, "deleted")
}

/// Quarantine the active world so the next start generates a brand-new one under the same name.
pub fn reset(inst: &ServerInstance) -> AppResult<Option<PathBuf>> {
    quarantine_dir(inst, &inst.world_dir(), "world-reset")
}

/// Copy a world folder out (to keep, share or load in another server).
pub fn export(inst: &ServerInstance, version: &str, name: &str, dest: &Path) -> AppResult<usize> {
    let src = world_path(inst, version, name)?;
    let target = dest.join(src.file_name().unwrap_or_default());
    if target.exists() {
        return Err(AppError::msg(format!("{} already exists.", target.display())));
    }
    copy_dir(&src, &target)
}

// ---------------------------------------------------------------------------------------------
// Worlds of the V Rising game on this PC (private / local games hosted from the client).

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalWorld {
    pub world: World,
    /// "Local saves" or "Cloud saves (<account>)"
    pub source: String,
}

/// Worlds in `%USERPROFILE%\AppData\LocalLow\Stunlock Studios\VRising\Saves\<v>\<id>` and
/// `…\CloudSaves\<v>\<steam id>\<id>` (layout from community docs – not verified on a PC with the
/// game installed).
pub fn local_worlds() -> Vec<LocalWorld> {
    let mut out = vec![];
    let Some(home) = std::env::var_os("USERPROFILE").map(PathBuf::from) else { return out };
    let base = home.join("AppData").join("LocalLow").join("Stunlock Studios").join("VRising");
    for w in scan_root(&base.join("Saves"), None) {
        if !w.saves.is_empty() {
            out.push(LocalWorld { world: w, source: "Local saves".into() });
        }
    }
    if let Ok(rd) = std::fs::read_dir(base.join("CloudSaves")) {
        for v in rd.flatten().filter(|e| e.path().is_dir()) {
            let Ok(accts) = std::fs::read_dir(v.path()) else { continue };
            for acct in accts.flatten().filter(|e| e.path().is_dir()) {
                let Ok(ws) = std::fs::read_dir(acct.path()) else { continue };
                for w in ws.flatten().filter(|e| e.path().is_dir()) {
                    if let Some(world) = read_world(&w.path(), &v.file_name().to_string_lossy(), None).filter(|w| !w.saves.is_empty()) {
                        out.push(LocalWorld { world, source: format!("Cloud saves ({})", acct.file_name().to_string_lossy()) });
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| b.world.saved_at.cmp(&a.world.saved_at));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inst() -> ServerInstance {
        let d = std::env::temp_dir().join(format!("vrsm-worlds-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        ServerInstance { install_dir: d, ..Default::default() }
    }

    #[test]
    fn checks_and_renames_worlds() {
        use std::io::Write;
        let i = inst();
        let w = i.world_dir();
        std::fs::create_dir_all(&w).unwrap();
        let mut gz = flate2::write::GzEncoder::new(vec![], flate2::Compression::fast());
        gz.write_all(&[7u8; 5000]).unwrap();
        let good = gz.finish().unwrap();
        std::fs::write(w.join("AutoSave_1.save.gz"), &good).unwrap();
        std::fs::write(w.join("AutoSave_2.save.gz"), &good[..good.len() / 2]).unwrap(); // cut off
        let c = check_saves(&i, "v4", "world1").unwrap();
        assert_eq!((c[0].number, c[0].ok), (2, false));
        assert_eq!((c[1].number, c[1].ok, c[1].bytes), (1, true, 5000));
        std::fs::create_dir_all(i.saves_dir().join("taken")).unwrap();
        assert!(rename(&i, "v4", "world1", "taken").is_err());
        assert!(rename(&i, "v4", "world1", "bad/name").is_err());
        assert_eq!(rename(&i, "v4", "world1", "Season 2").unwrap(), "Season 2");
        assert!(i.saves_dir().join("Season 2").join("AutoSave_1.save.gz").exists());
        let _ = std::fs::remove_dir_all(&i.install_dir);
    }

    #[test]
    fn scans_worlds_and_rolls_back() {
        let i = inst();
        let w = i.world_dir();
        std::fs::create_dir_all(&w).unwrap();
        std::fs::write(w.join("AutoSave_0.save.gz"), b"zero").unwrap();
        std::fs::write(w.join("AutoSave_3.save.gz"), b"three").unwrap();
        std::fs::write(w.join("StartDate.json"), b"10/15/2026").unwrap();
        std::fs::write(w.join("SessionId.json"), b"2d99ed23").unwrap();
        std::fs::create_dir_all(i.saves_dir().join("other").join(".TEMP")).unwrap();
        std::fs::write(i.saves_dir().join("other").join("AutoSave_7.save"), b"x").unwrap();
        let ws = list(&i);
        assert_eq!(ws.len(), 2);
        assert!(ws[0].active);
        assert_eq!(ws[0].name, "world1");
        assert_eq!(ws[0].saves[0].number, 3);
        assert!(ws[0].saves[0].latest);
        assert_eq!(ws[0].start_date.as_deref(), Some("10/15/2026"));
        assert_eq!(restore_autosave(&i, "v4", "world1", 0).unwrap(), "AutoSave_4.save.gz");
        assert_eq!(std::fs::read(w.join("AutoSave_4.save.gz")).unwrap(), b"zero");
        assert!(w.join("AutoSave_0.save.gz").exists(), "nothing is overwritten");
        assert!(restore_autosave(&i, "v4", "../x", 0).is_err());
        let _ = std::fs::remove_dir_all(&i.install_dir);
    }

    #[test]
    fn import_duplicate_remove() {
        let i = inst();
        let src = i.install_dir.join("from-game").join("a1b2c3");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("AutoSave_12.save.gz"), b"mine").unwrap();
        std::fs::write(src.join(GAME_FILE), b"{\"ClanSize\": 2}").unwrap();
        assert_eq!(scan_any(&src).len(), 1);
        assert_eq!(scan_any(src.parent().unwrap()).len(), 1);
        let (name, n) = import(&i, &src, "My World", true).unwrap();
        assert_eq!((name.as_str(), n), ("My World", 2));
        assert!(std::fs::read_to_string(i.game_path()).unwrap().contains("ClanSize"));
        let (again, _) = import(&i, &src, "My World", false).unwrap();
        assert_eq!(again, "My World-2");
        assert_eq!(duplicate(&i, "v4", "My World", "Season 2").unwrap(), "Season 2");
        assert!(remove(&i, "v4", "Season 2").unwrap().unwrap().to_string_lossy().contains("_quarantine"));
        assert!(!i.saves_dir().join("Season 2").exists());
        let _ = std::fs::remove_dir_all(&i.install_dir);
    }
}
