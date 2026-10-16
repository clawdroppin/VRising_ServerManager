//! Zip backups, restore, retention and portable server packs (`.vrising`).
//!
//! A backup is a point-in-time snapshot: for every world the newest autosave plus its metadata
//! (`Saves/<v>/<world>/…` – the older rolling autosaves already live in the world folder), and the
//! `Settings` folder (both JSON files and the admin/ban lists, `Settings/…`).

use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::state::{now_ms, AppState};
use std::io::{Read, Write};
use std::path::Path;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;

const MANIFEST: &str = "backup.json";

fn opts() -> SimpleFileOptions {
    SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).compression_level(Some(6))
}

/// Add every file under `dir` to the zip below `prefix/`. Files are read fully first so a save
/// the server is writing at that moment never ends up half-copied mid-stream.
fn add_dir<W: Write + std::io::Seek>(zip: &mut zip::ZipWriter<W>, dir: &Path, prefix: &str, skip: &[&str]) -> AppResult<u32> {
    let mut n = 0;
    if !dir.exists() {
        return Ok(0);
    }
    for e in WalkDir::new(dir).into_iter().flatten() {
        if !e.file_type().is_file() {
            continue;
        }
        let rel = e.path().strip_prefix(dir).unwrap_or(e.path());
        let rel_s = rel.to_string_lossy().replace('\\', "/");
        if skip.iter().any(|s| rel_s.starts_with(s)) {
            continue;
        }
        let mut buf = vec![];
        if std::fs::File::open(e.path()).and_then(|mut f| f.read_to_end(&mut buf)).is_err() {
            continue; // locked file – skip rather than fail the whole backup
        }
        zip.start_file(format!("{prefix}/{rel_s}"), opts())?;
        zip.write_all(&buf)?;
        n += 1;
    }
    Ok(n)
}

fn add_file<W: Write + std::io::Seek>(zip: &mut zip::ZipWriter<W>, path: &Path, name: &str) -> AppResult<u32> {
    let Ok(buf) = std::fs::read(path) else { return Ok(0) };
    zip.start_file(name, opts())?;
    zip.write_all(&buf)?;
    Ok(1)
}

/// `Settings/` – the files directly in the settings folder (not the config history).
fn add_settings<W: Write + std::io::Seek>(zip: &mut zip::ZipWriter<W>, inst: &ServerInstance) -> AppResult<u32> {
    let Ok(rd) = std::fs::read_dir(inst.settings_dir()) else { return Ok(0) };
    let mut n = 0;
    for e in rd.flatten().filter(|e| e.path().is_file()) {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.ends_with(".json") || name.ends_with(".txt") {
            n += add_file(zip, &e.path(), &format!("Settings/{name}"))?;
        }
    }
    Ok(n)
}

/// `Saves/<v>/<world>/…`: every world's metadata files and its newest autosave.
fn add_worlds<W: Write + std::io::Seek>(zip: &mut zip::ZipWriter<W>, inst: &ServerInstance, only_latest: bool) -> AppResult<u32> {
    let mut n = 0;
    for w in super::worlds::list(inst) {
        let prefix = format!("Saves/{}/{}", w.version, w.name);
        let keep: Vec<String> = if only_latest { w.saves.first().map(|s| s.file.clone()).into_iter().collect() } else { w.saves.iter().map(|s| s.file.clone()).collect() };
        let Ok(rd) = std::fs::read_dir(&w.dir) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let is_save = w.saves.iter().any(|s| s.file == name);
            if is_save && !keep.contains(&name) || name.starts_with('.') {
                continue;
            }
            if e.path().is_dir() {
                n += add_dir(zip, &e.path(), &format!("{prefix}/{name}"), &[])?;
            } else {
                n += add_file(zip, &e.path(), &format!("{prefix}/{name}"))?;
            }
        }
    }
    Ok(n)
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    label: String,
    kind: String,
    created_at: i64,
    server_name: String,
    files: u32,
}

pub async fn create(state: &AppState, inst: &ServerInstance, label: &str, kind: &str) -> AppResult<BackupInfo> {
    let dir = state.backup_dir(inst).await;
    let inst = inst.clone();
    let label = label.to_string();
    let kind = kind.to_string();
    tokio::task::spawn_blocking(move || {
        let info = create_blocking(&inst, &dir, &label, &kind)?;
        prune(&dir, inst.automation.backup_keep);
        Ok(info)
    })
    .await
    .map_err(|e| AppError::msg(e.to_string()))?
}

fn create_blocking(inst: &ServerInstance, dir: &Path, label: &str, kind: &str) -> AppResult<BackupInfo> {
    std::fs::create_dir_all(dir)?;
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S");
    let path = dir.join(format!("{stamp}_{kind}.zip"));
    let tmp = path.with_extension("zip.part");
    let file = std::fs::File::create(&tmp)?;
    let mut zip = zip::ZipWriter::new(file);
    let mut files = add_worlds(&mut zip, inst, true)?;
    files += add_settings(&mut zip, inst)?;
    let created_at = now_ms();
    let m = Manifest { label: label.to_string(), kind: kind.to_string(), created_at, server_name: inst.name.clone(), files };
    zip.start_file(MANIFEST, opts())?;
    zip.write_all(&serde_json::to_vec_pretty(&m)?)?;
    zip.finish()?;
    std::fs::rename(&tmp, &path)?;
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(BackupInfo {
        name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        path,
        size,
        created_at,
        label: label.to_string(),
        kind: kind.to_string(),
        files,
    })
}

fn read_manifest(path: &Path) -> Option<Manifest> {
    let f = std::fs::File::open(path).ok()?;
    let mut z = zip::ZipArchive::new(f).ok()?;
    let mut e = z.by_name(MANIFEST).ok()?;
    let mut s = String::new();
    e.read_to_string(&mut s).ok()?;
    serde_json::from_str(&s).ok()
}

pub fn list(dir: &Path) -> Vec<BackupInfo> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut out: Vec<BackupInfo> = rd
        .flatten()
        .filter(|e| e.path().extension().map(|x| x.eq_ignore_ascii_case("zip")).unwrap_or(false))
        .map(|e| {
            let path = e.path();
            let meta = e.metadata().ok();
            let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let mtime = meta
                .and_then(|m| m.modified().ok())
                .map(|t| chrono::DateTime::<chrono::Utc>::from(t).timestamp_millis())
                .unwrap_or(0);
            let m = read_manifest(&path);
            BackupInfo {
                name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                size,
                created_at: m.as_ref().map(|m| m.created_at).unwrap_or(mtime),
                label: m.as_ref().map(|m| m.label.clone()).unwrap_or_else(|| "Imported".into()),
                kind: m.as_ref().map(|m| m.kind.clone()).unwrap_or_else(|| "manual".into()),
                files: m.as_ref().map(|m| m.files).unwrap_or(0),
                path,
            }
        })
        .collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

/// Keep the newest `keep` automatic backups; manual ones are never pruned.
pub fn prune(dir: &Path, keep: u32) -> u32 {
    if keep == 0 {
        return 0;
    }
    let autos: Vec<BackupInfo> = list(dir).into_iter().filter(|b| b.kind != "manual").collect();
    let mut removed = 0;
    for b in autos.iter().skip(keep as usize) {
        if std::fs::remove_file(&b.path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Copy a folder recursively. Returns the number of files copied.
pub fn copy_dir(src: &Path, dest: &Path) -> AppResult<usize> {
    let mut n = 0;
    for e in WalkDir::new(src).into_iter().flatten() {
        let rel = e.path().strip_prefix(src).unwrap_or(e.path());
        let out = dest.join(rel);
        if e.file_type().is_dir() {
            std::fs::create_dir_all(&out)?;
        } else if e.file_type().is_file() {
            if let Some(p) = out.parent() {
                std::fs::create_dir_all(p)?;
            }
            std::fs::copy(e.path(), &out)?;
            n += 1;
        }
    }
    Ok(n)
}

fn extract_prefix(zip_path: &Path, prefix: &str, dest: &Path) -> AppResult<u32> {
    let f = std::fs::File::open(zip_path)?;
    let mut z = zip::ZipArchive::new(f)?;
    let mut n = 0;
    for i in 0..z.len() {
        let mut e = z.by_index(i)?;
        let Some(name) = e.enclosed_name() else { continue };
        let name_s = name.to_string_lossy().replace('\\', "/");
        let Some(rel) = name_s.strip_prefix(&format!("{prefix}/")) else { continue };
        if rel.is_empty() || e.is_dir() {
            continue;
        }
        let out = dest.join(rel);
        if let Some(p) = out.parent() {
            std::fs::create_dir_all(p)?;
        }
        let mut w = std::fs::File::create(&out)?;
        std::io::copy(&mut e, &mut w)?;
        n += 1;
    }
    Ok(n)
}

/// World folders (`<v>/<name>`) contained in a backup or pack.
fn zip_worlds(zip_path: &Path) -> Vec<String> {
    let Ok(f) = std::fs::File::open(zip_path) else { return vec![] };
    let Ok(z) = zip::ZipArchive::new(f) else { return vec![] };
    let mut out: Vec<String> = vec![];
    for n in z.file_names().flatten() {
        let parts: Vec<&str> = n.split('/').collect();
        if parts.len() >= 4 && parts[0] == "Saves" {
            let w = format!("{}/{}", parts[1], parts[2]);
            if !out.contains(&w) {
                out.push(w);
            }
        }
    }
    out
}

/// Restore a backup into a stopped server. Each world in the backup replaces the world of the same
/// name (which is quarantined first); other worlds stay. Settings (when asked for) go through the
/// config history like any other edit.
pub fn restore(inst: &ServerInstance, zip_path: &Path, include_config: bool) -> AppResult<u32> {
    for w in zip_worlds(zip_path) {
        let dir = inst.saves_root().join(w.replace('/', "\\"));
        super::worlds::quarantine_dir(inst, &dir, "before-restore")?;
    }
    let root = inst.saves_root();
    std::fs::create_dir_all(&root)?;
    let mut n = extract_prefix(zip_path, "Saves", &root)?;
    if include_config {
        n += restore_settings(zip_path, inst)?;
    }
    Ok(n)
}

/// Write the `Settings/` files of a zip into the server's settings folder.
fn restore_settings(zip_path: &Path, inst: &ServerInstance) -> AppResult<u32> {
    let f = std::fs::File::open(zip_path)?;
    let mut z = zip::ZipArchive::new(f)?;
    let dir = inst.settings_dir();
    std::fs::create_dir_all(&dir)?;
    let mut n = 0;
    for i in 0..z.len() {
        let mut e = z.by_index(i)?;
        let name = e.name().map(|c| c.into_owned()).unwrap_or_default();
        let Some(file) = name.strip_prefix("Settings/") else { continue };
        if file.is_empty() || file.contains('/') || file.contains('\\') || e.is_dir() {
            continue;
        }
        let mut s = String::new();
        e.read_to_string(&mut s)?;
        super::config::write_text(&dir.join(file), &s)?;
        n += 1;
    }
    Ok(n)
}

// ---------------------------------------------------------------------------------------------
// Server packs (.vrising): a zip with manifest.json + Settings/ + optional Saves/.

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackOptions {
    pub include_saves: bool,
    pub include_secrets: bool,
}

pub fn export_pack(inst: &ServerInstance, dest: &Path, o: &PackOptions) -> AppResult<()> {
    let mut profile = inst.clone();
    if !o.include_secrets {
        profile.config.password.clear();
        profile.config.rcon_password.clear();
        profile.branch_password.clear();
    }
    let tmp = dest.with_extension("part");
    let file = std::fs::File::create(&tmp)?;
    let mut zip = zip::ZipWriter::new(file);
    let mut settings = add_settings_except(&mut zip, inst, if o.include_secrets { &[] } else { &[HOST_FILE] })?;
    // Without secrets the pack's host settings must not carry the passwords either.
    if !o.include_secrets {
        let mut doc = super::config::read_effective(&inst.host_path(), &super::config::host_template(inst))?;
        super::config::apply_host(&mut doc, &profile.config);
        zip.start_file(format!("Settings/{HOST_FILE}"), opts())?;
        zip.write_all(super::config::to_text(&doc).as_bytes())?;
        settings += 1;
    }
    let has_saves = if o.include_saves { add_worlds(&mut zip, inst, false)? > 0 } else { false };
    let m = PackManifest {
        format: 1,
        app_version: env!("CARGO_PKG_VERSION").into(),
        exported_at: now_ms(),
        instance: profile,
        has_saves,
        has_config: settings > 0,
        includes_secrets: o.include_secrets,
    };
    zip.start_file("manifest.json", opts())?;
    zip.write_all(&serde_json::to_vec_pretty(&m)?)?;
    zip.finish()?;
    if dest.exists() {
        std::fs::remove_file(dest)?;
    }
    std::fs::rename(&tmp, dest)?;
    Ok(())
}

fn add_settings_except<W: Write + std::io::Seek>(zip: &mut zip::ZipWriter<W>, inst: &ServerInstance, skip: &[&str]) -> AppResult<u32> {
    let Ok(rd) = std::fs::read_dir(inst.settings_dir()) else { return Ok(0) };
    let mut n = 0;
    for e in rd.flatten().filter(|e| e.path().is_file()) {
        let name = e.file_name().to_string_lossy().into_owned();
        if (name.ends_with(".json") || name.ends_with(".txt")) && !skip.contains(&name.as_str()) {
            n += add_file(zip, &e.path(), &format!("Settings/{name}"))?;
        }
    }
    Ok(n)
}

pub fn read_pack(path: &Path) -> AppResult<PackManifest> {
    let f = std::fs::File::open(path)?;
    let mut z = zip::ZipArchive::new(f).map_err(|_| AppError::msg("That file isn't a V Rising server pack."))?;
    let mut e = z.by_name("manifest.json").map_err(|_| AppError::msg("The pack has no manifest.json – not a server pack."))?;
    let mut s = String::new();
    e.read_to_string(&mut s)?;
    Ok(serde_json::from_str(&s)?)
}

/// Unpack the settings (and saves) of a pack into a (new) server's folders.
pub fn unpack_into(path: &Path, inst: &ServerInstance) -> AppResult<()> {
    std::fs::create_dir_all(&inst.install_dir)?;
    restore_settings(path, inst)?;
    if !zip_worlds(path).is_empty() {
        let root = inst.saves_root();
        std::fs::create_dir_all(&root)?;
        extract_prefix(path, "Saves", &root)?;
    }
    Ok(())
}

/// Read every entry of a backup (the zip checks each CRC) and decompress the autosaves inside –
/// proves it can be restored and that the worlds in it load.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResult {
    pub ok: bool,
    pub files: u32,
    /// `<version>/<world>` of every world in the backup.
    pub worlds: Vec<String>,
    pub has_settings: bool,
    pub bytes: u64,
    pub error: Option<String>,
}

pub fn verify(zip_path: &Path) -> AppResult<VerifyResult> {
    let f = std::fs::File::open(zip_path)?;
    let mut z = zip::ZipArchive::new(f)?;
    let mut out = VerifyResult { ok: true, files: 0, worlds: vec![], has_settings: false, bytes: 0, error: None };
    for i in 0..z.len() {
        let mut e = z.by_index(i)?;
        if e.is_dir() {
            continue;
        }
        let name = e.name().map(|n| n.to_string()).unwrap_or_default();
        let parts: Vec<&str> = name.split('/').collect();
        let autosave = parts.len() == 4 && parts[0] == "Saves" && parts[3].starts_with("AutoSave_");
        // Reading to the end makes the zip crate check the entry's CRC32; autosaves are also
        // gunzipped, which catches a save that was already damaged when it was backed up.
        let res = if autosave && parts[3].ends_with(".gz") {
            std::io::copy(&mut flate2::read::MultiGzDecoder::new(&mut e), &mut std::io::sink())
        } else {
            std::io::copy(&mut e, &mut std::io::sink())
        };
        match res {
            Ok(n) => out.bytes += n,
            Err(err) => {
                out.ok = false;
                out.error = Some(format!("{name}: {err}"));
                break;
            }
        }
        out.files += 1;
        if autosave {
            let w = format!("{}/{}", parts[1], parts[2]);
            if !out.worlds.contains(&w) {
                out.worlds.push(w);
            }
        }
        if name == format!("Settings/{HOST_FILE}") {
            out.has_settings = true;
        }
    }
    if out.ok && out.worlds.is_empty() && !out.has_settings {
        out.ok = false;
        out.error = Some("The backup contains neither worlds nor settings.".into());
    }
    Ok(out)
}

pub fn folder_size(dir: &Path) -> u64 {
    WalkDir::new(dir).into_iter().flatten().filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_restore_round_trip() {
        let root = std::env::temp_dir().join(format!("vrsm-bk-{}", uuid::Uuid::new_v4()));
        let inst = ServerInstance { install_dir: root.join("srv"), ..Default::default() };
        let w = inst.world_dir();
        std::fs::create_dir_all(&w).unwrap();
        std::fs::create_dir_all(inst.settings_dir()).unwrap();
        std::fs::write(w.join("AutoSave_1.save.gz"), b"old").unwrap();
        std::fs::write(w.join("AutoSave_2.save.gz"), b"world-v1").unwrap();
        std::fs::write(w.join("StartDate.json"), b"10/15/2026").unwrap();
        std::fs::write(inst.host_path(), br#"{"Name": "A"}"#).unwrap();
        std::fs::write(inst.admin_path(), b"76561197960287930\n").unwrap();
        let b = create_blocking(&inst, &root.join("bk"), "test", "manual").unwrap();
        assert_eq!(b.files, 4, "newest autosave + StartDate + 2 settings files");
        std::fs::write(w.join("AutoSave_3.save.gz"), b"world-v2").unwrap();
        std::fs::write(inst.host_path(), br#"{"Name": "B"}"#).unwrap();
        restore(&inst, &b.path, true).unwrap();
        assert_eq!(std::fs::read(w.join("AutoSave_2.save.gz")).unwrap(), b"world-v1");
        assert!(!w.join("AutoSave_3.save.gz").exists(), "the world was replaced");
        assert!(std::fs::read_to_string(inst.host_path()).unwrap().contains("\"A\""));
        assert!(inst.saves_root().join("_quarantine").exists());
        // The test "autosaves" aren't gzip data: verify must call that damaged.
        let v = verify(&b.path).unwrap();
        assert!(!v.ok && v.error.as_deref().unwrap_or("").contains("AutoSave_2"), "{v:?}");
        let listed = list(&root.join("bk"));
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].label, "test");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn verify_reads_worlds_and_settings() {
        use std::io::Write;
        let root = std::env::temp_dir().join(format!("vrsm-verify-{}", uuid::Uuid::new_v4()));
        let inst = ServerInstance { install_dir: root.join("srv"), ..Default::default() };
        std::fs::create_dir_all(inst.world_dir()).unwrap();
        std::fs::create_dir_all(inst.settings_dir()).unwrap();
        let mut gz = flate2::write::GzEncoder::new(vec![], flate2::Compression::fast());
        gz.write_all(b"castle").unwrap();
        std::fs::write(inst.world_dir().join("AutoSave_5.save.gz"), gz.finish().unwrap()).unwrap();
        std::fs::write(inst.host_path(), br#"{"Name": "A"}"#).unwrap();
        let b = create_blocking(&inst, &root.join("bk"), "t", "manual").unwrap();
        let v = verify(&b.path).unwrap();
        assert!(v.ok && v.has_settings, "{v:?}");
        assert_eq!(v.worlds, vec!["v4/world1".to_string()]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn packs_strip_secrets() {
        let root = std::env::temp_dir().join(format!("vrsm-pack-{}", uuid::Uuid::new_v4()));
        let mut inst = ServerInstance { install_dir: root.join("srv"), ..Default::default() };
        inst.config.password = "join-pw".into();
        inst.config.rcon_password = "rcon-pw-123".into();
        std::fs::create_dir_all(inst.settings_dir()).unwrap();
        std::fs::write(inst.host_path(), br#"{"Name": "A", "Password": "join-pw", "Rcon": {"Password": "rcon-pw-123"}}"#).unwrap();
        let p = root.join("x.vrising");
        export_pack(&inst, &p, &PackOptions { include_saves: true, include_secrets: false }).unwrap();
        let m = read_pack(&p).unwrap();
        assert!(m.instance.config.rcon_password.is_empty());
        let other = ServerInstance { install_dir: root.join("b"), ..Default::default() };
        unpack_into(&p, &other).unwrap();
        let host = std::fs::read_to_string(other.host_path()).unwrap();
        assert!(!host.contains("join-pw") && !host.contains("rcon-pw-123"), "{host}");
        let _ = std::fs::remove_dir_all(root);
    }
}
