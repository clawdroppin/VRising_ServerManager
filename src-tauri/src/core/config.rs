//! `ServerHostSettings.json` + `ServerGameSettings.json`: lossless read-modify-write, the admin and
//! ban lists, and validation.
//!
//! Both files live in `<persistentDataPath>\Settings`. A missing file falls back to the copy the
//! server ships in `VRisingServer_Data\StreamingAssets\Settings` (verified: the server reads that
//! one when the data folder has none), so new files start from that template. The manager never
//! writes a whole file from the profile – it loads the current document, replaces only the keys the
//! profile owns and keeps everything else (keys added by future game versions, arrays like
//! `VBloodUnitSettings`) in their original order.
//!
//! Gameplay rules are handled as flattened `Dotted.Path` keys, so nested blocks like
//! `GameTimeModifiers.DayDurationInSeconds` edit in place. A value keeps the number type the file
//! had (integer fields stay integers; the server's JSON reader is strict about those).
//!
//! `adminlist.txt` / `banlist.txt` hold one SteamID64 per line and are reloaded by the running
//! server within seconds (verified: `[FileUserList] Content:` in the log), so they're edited live.

use crate::error::{AppError, AppResult};
use crate::models::*;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Read a file as an ordered JSON object (empty object when missing).
pub fn read_doc(path: &Path) -> AppResult<Map<String, Value>> {
    let text = match std::fs::read(path) {
        Ok(b) => String::from_utf8_lossy(&b).trim_start_matches('\u{feff}').to_string(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(e) => return Err(e.into()),
    };
    if text.trim().is_empty() {
        return Ok(Map::new());
    }
    parse_doc(&text).map_err(|e| AppError::msg(format!("{} {e}", path.display())))
}

pub fn parse_doc(text: &str) -> Result<Map<String, Value>, String> {
    match serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Err("isn't a JSON object.".into()),
        Err(e) => Err(format!("has a JSON error at line {}, column {}: {e}", e.line(), e.column())),
    }
}

/// The file the server reads: the data folder's copy, or the shipped template when there is none.
pub fn read_effective(path: &Path, template: &Path) -> AppResult<Map<String, Value>> {
    if path.exists() {
        read_doc(path)
    } else {
        read_doc(template)
    }
}

/// Serialize like the server's own files: two-space indentation, trailing newline.
pub fn to_text(doc: &Map<String, Value>) -> String {
    let mut s = serde_json::to_string_pretty(&Value::Object(doc.clone())).unwrap_or_default();
    s.push('\n');
    s
}

/// Write with a rolling history (`Settings\_config-history\<stem>.<stamp>.json`, last 30 per file).
pub fn write_text(path: &Path, text: &str) -> AppResult<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
        if let Ok(old) = std::fs::read(path) {
            if !old.is_empty() && old != text.as_bytes() {
                let hist = history_dir(path);
                std::fs::create_dir_all(&hist)?;
                let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                let ext = path.extension().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "json".into());
                let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S%.3f");
                let _ = std::fs::write(hist.join(format!("{stem}.{stamp}.{ext}")), &old);
                prune_history(&hist, &stem, 30);
            }
        }
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn history_dir(path: &Path) -> PathBuf {
    path.parent().unwrap_or(Path::new(".")).join("_config-history")
}

fn prune_history(dir: &Path, stem: &str, keep: usize) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let prefix = format!("{stem}.");
    let mut v: Vec<_> = rd.flatten().map(|e| e.path()).filter(|p| p.file_name().map(|n| n.to_string_lossy().starts_with(&prefix)).unwrap_or(false)).collect();
    v.sort();
    let n = v.len();
    for p in v.into_iter().take(n.saturating_sub(keep)) {
        let _ = std::fs::remove_file(p);
    }
}

fn set(doc: &mut Map<String, Value>, k: &str, v: Value) {
    if let Some(slot) = doc.get_mut(k) {
        *slot = v;
    } else {
        doc.insert(k.to_string(), v);
    }
}

fn sub<'a>(doc: &'a mut Map<String, Value>, k: &str) -> &'a mut Map<String, Value> {
    if !doc.get(k).map(|v| v.is_object()).unwrap_or(false) {
        set(doc, k, Value::Object(Map::new()));
    }
    doc.get_mut(k).and_then(|v| v.as_object_mut()).expect("object")
}

// ------------------------------------------------------------------------------ host settings

/// Put the profile-owned keys into ServerHostSettings.json, keeping key order and all other keys.
pub fn apply_host(doc: &mut Map<String, Value>, c: &ServerConfig) {
    set(doc, "Name", c.name.trim().into());
    set(doc, "Description", c.description.clone().into());
    set(doc, "Port", c.port.into());
    set(doc, "QueryPort", c.query_port.into());
    let addr = c.address.trim();
    if !addr.is_empty() {
        set(doc, "Address", addr.into());
    } else if doc.contains_key("Address") {
        set(doc, "Address", Value::Null);
    }
    set(doc, "MaxConnectedUsers", c.max_connected_users.clamp(1, MAX_USERS).into());
    set(doc, "MaxConnectedAdmins", c.max_connected_admins.into());
    set(doc, "ServerFps", c.server_fps.clamp(10, 120).into());
    set(doc, "SaveName", c.save_name.trim().into());
    set(doc, "Password", c.password.clone().into());
    set(doc, "Secure", c.secure.into());
    set(doc, "ListOnSteam", c.list_on_steam.into());
    set(doc, "ListOnEOS", c.list_on_eos.into());
    set(doc, "LanMode", c.lan_mode.into());
    set(doc, "HideIPAddress", c.hide_ip_address.into());
    set(doc, "AutoSaveCount", c.auto_save_count.max(1).into());
    set(doc, "AutoSaveInterval", c.auto_save_interval.max(30).into());
    set(doc, "CompressSaveFiles", c.compress_save_files.into());
    set(doc, "GameSettingsPreset", c.game_settings_preset.trim().into());
    set(doc, "GameDifficultyPreset", c.game_difficulty_preset.trim().into());
    set(doc, "AdminOnlyDebugEvents", c.admin_only_debug_events.into());
    set(doc, "DisableDebugEvents", c.disable_debug_events.into());
    let api = sub(doc, "API");
    set(api, "Enabled", c.api_enabled.into());
    set(api, "BindPort", c.api_port.into());
    let rcon = sub(doc, "Rcon");
    set(rcon, "Enabled", c.rcon_enabled.into());
    set(rcon, "Port", c.rcon_port.into());
    set(rcon, "Password", c.rcon_password.clone().into());
}

/// Read the profile-owned keys out of ServerHostSettings.json. Missing keys keep the profile's value.
pub fn read_host(doc: &Map<String, Value>, c: &mut ServerConfig) {
    let s = |d: &Map<String, Value>, k: &str| d.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
    let b = |d: &Map<String, Value>, k: &str| d.get(k).and_then(|v| v.as_bool());
    let n = |d: &Map<String, Value>, k: &str| d.get(k).and_then(|v| v.as_f64()).filter(|f| *f >= 0.0).map(|f| f as u64);
    if let Some(v) = s(doc, "Name") {
        c.name = v;
    }
    if let Some(v) = s(doc, "Description") {
        c.description = v;
    }
    match doc.get("Address") {
        Some(Value::String(v)) => c.address = v.clone(),
        Some(Value::Null) => c.address.clear(),
        _ => {}
    }
    if let Some(v) = n(doc, "Port") {
        c.port = v.min(65535) as u16;
    }
    if let Some(v) = n(doc, "QueryPort") {
        c.query_port = v.min(65535) as u16;
    }
    if let Some(v) = n(doc, "MaxConnectedUsers") {
        c.max_connected_users = v as u32;
    }
    if let Some(v) = n(doc, "MaxConnectedAdmins") {
        c.max_connected_admins = v as u32;
    }
    if let Some(v) = n(doc, "ServerFps") {
        c.server_fps = v as u32;
    }
    if let Some(v) = s(doc, "SaveName") {
        c.save_name = v;
    }
    if let Some(v) = s(doc, "Password") {
        c.password = v;
    }
    if let Some(v) = b(doc, "Secure") {
        c.secure = v;
    }
    if let Some(v) = b(doc, "ListOnSteam") {
        c.list_on_steam = v;
    }
    if let Some(v) = b(doc, "ListOnEOS") {
        c.list_on_eos = v;
    }
    if let Some(v) = b(doc, "LanMode") {
        c.lan_mode = v;
    }
    if let Some(v) = b(doc, "HideIPAddress") {
        c.hide_ip_address = v;
    }
    if let Some(v) = n(doc, "AutoSaveCount") {
        c.auto_save_count = v as u32;
    }
    if let Some(v) = n(doc, "AutoSaveInterval") {
        c.auto_save_interval = v as u32;
    }
    if let Some(v) = b(doc, "CompressSaveFiles") {
        c.compress_save_files = v;
    }
    if let Some(v) = s(doc, "GameSettingsPreset") {
        c.game_settings_preset = v;
    }
    if let Some(v) = s(doc, "GameDifficultyPreset") {
        c.game_difficulty_preset = v;
    }
    if let Some(v) = b(doc, "AdminOnlyDebugEvents") {
        c.admin_only_debug_events = v;
    }
    if let Some(v) = b(doc, "DisableDebugEvents") {
        c.disable_debug_events = v;
    }
    if let Some(Value::Object(api)) = doc.get("API") {
        if let Some(v) = b(api, "Enabled") {
            c.api_enabled = v;
        }
        if let Some(v) = n(api, "BindPort") {
            c.api_port = v.min(65535) as u16;
        }
    }
    if let Some(Value::Object(r)) = doc.get("Rcon") {
        if let Some(v) = b(r, "Enabled") {
            c.rcon_enabled = v;
        }
        if let Some(v) = n(r, "Port") {
            c.rcon_port = v.min(65535) as u16;
        }
        if let Some(v) = s(r, "Password") {
            c.rcon_password = v;
        }
    }
}

// ------------------------------------------------------------------------------ game settings

/// Every scalar leaf of a document as `Dotted.Path` → value (arrays are left to the file).
pub fn flatten(doc: &Map<String, Value>) -> BTreeMap<String, Value> {
    fn walk(prefix: &str, m: &Map<String, Value>, out: &mut BTreeMap<String, Value>) {
        for (k, v) in m {
            let key = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
            match v {
                Value::Object(o) => walk(&key, o, out),
                Value::Array(_) => {}
                other => {
                    out.insert(key, other.clone());
                }
            }
        }
    }
    let mut out = BTreeMap::new();
    walk("", doc, &mut out);
    out
}

/// A new value in the number type of the old one: integer fields stay integers (rounded), float
/// fields are written as floats. Non-numbers pass through.
fn coerce_like(old: Option<&Value>, new: &Value) -> Value {
    match (old, new.as_f64()) {
        (Some(o), Some(f)) if o.is_i64() || o.is_u64() => Value::from(f.round() as i64),
        (Some(o), Some(f)) if o.is_f64() => serde_json::Number::from_f64(f).map(Value::Number).unwrap_or_else(|| new.clone()),
        _ => new.clone(),
    }
}

/// Set flattened keys into a document, creating nested objects as needed.
pub fn apply_game(doc: &mut Map<String, Value>, values: &BTreeMap<String, Value>) {
    for (path, v) in values {
        let parts: Vec<&str> = path.split('.').filter(|p| !p.is_empty()).collect();
        let Some((last, parents)) = parts.split_last() else { continue };
        let mut cur = &mut *doc;
        for p in parents {
            cur = sub(cur, p);
        }
        let nv = coerce_like(cur.get(*last), v);
        set(cur, last, nv);
    }
}

// ----------------------------------------------------------------------------------- the pair

pub fn host_template(inst: &ServerInstance) -> PathBuf {
    inst.default_settings_dir().join(HOST_FILE)
}

pub fn game_template(inst: &ServerInstance) -> PathBuf {
    inst.default_settings_dir().join(GAME_FILE)
}

/// Pull everything the profile owns out of the files the server would read.
pub fn read_files_into(inst: &ServerInstance, c: &mut ServerConfig) -> AppResult<bool> {
    let host = inst.host_path();
    let game = inst.game_path();
    let mut any = false;
    if host.exists() || host_template(inst).exists() {
        read_host(&read_effective(&host, &host_template(inst))?, c);
        any |= host.exists();
    }
    if game.exists() || game_template(inst).exists() {
        let flat = flatten(&read_effective(&game, &game_template(inst))?);
        if !flat.is_empty() {
            c.game_settings = flat;
        }
        any |= game.exists();
    }
    Ok(any)
}

/// Re-read the profile-owned values of a server from its settings files.
pub fn reload(inst: &mut ServerInstance) -> AppResult<bool> {
    let probe = inst.clone();
    read_files_into(&probe, &mut inst.config)
}

fn write_if_changed(path: &Path, text: &str) -> AppResult<()> {
    if std::fs::read_to_string(path).ok().as_deref().map(|t| t.trim_start_matches('\u{feff}')) != Some(text) {
        write_text(path, text)?;
    }
    Ok(())
}

/// Write the profile into both settings files (creating them from the shipped templates).
pub fn sync(inst: &ServerInstance) -> AppResult<()> {
    let mut host = read_effective(&inst.host_path(), &host_template(inst))?;
    apply_host(&mut host, &inst.config);
    write_if_changed(&inst.host_path(), &to_text(&host))?;
    if !inst.config.game_settings.is_empty() || inst.game_path().exists() {
        let mut game = read_effective(&inst.game_path(), &game_template(inst))?;
        apply_game(&mut game, &inst.config.game_settings);
        write_if_changed(&inst.game_path(), &to_text(&game))?;
    }
    for f in [inst.admin_path(), inst.ban_path()] {
        if !f.exists() {
            std::fs::write(&f, "")?;
        }
    }
    Ok(())
}

/// Preset names shipped with the installed server (file names without `.json`).
pub fn list_presets(dir: &Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut v: Vec<String> = rd
        .flatten()
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            n.strip_suffix(".json").map(|s| s.to_string())
        })
        .collect();
    v.sort();
    v
}

// ---------------------------------------------------------------------------- admin / ban lists

/// A SteamID64: 17 digits starting with 7656.
pub fn is_steam_id(s: &str) -> bool {
    s.len() == 17 && s.starts_with("7656") && s.chars().all(|c| c.is_ascii_digit())
}

/// The ids in a list file (blank lines and anything that isn't an id are skipped).
pub fn read_list(path: &Path) -> Vec<String> {
    let text = std::fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    let mut out: Vec<String> = vec![];
    for l in text.lines() {
        let t = l.trim().trim_start_matches('\u{feff}');
        if is_steam_id(t) && !out.iter().any(|x| x == t) {
            out.push(t.to_string());
        }
    }
    out
}

/// Add or remove one id. Returns true when the file changed.
pub fn edit_list(path: &Path, id: &str, add: bool) -> AppResult<bool> {
    let id = id.trim();
    if !is_steam_id(id) {
        return Err(AppError::msg(format!("“{id}” isn't a SteamID64 (17 digits starting with 7656).")));
    }
    let mut list = read_list(path);
    let had = list.iter().any(|x| x == id);
    if add == had {
        return Ok(false);
    }
    if add {
        list.push(id.to_string());
    } else {
        list.retain(|x| x != id);
    }
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    let mut text = list.join("\n");
    if !text.is_empty() {
        text.push('\n');
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)?;
    Ok(true)
}

// ---------------------------------------------------------------------------------- validation

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// error = the server would refuse or misbehave; warn = allowed but probably unintended.
    pub level: String,
    pub message: String,
}

fn issue(level: &str, m: impl Into<String>) -> Issue {
    Issue { level: level.into(), message: m.into() }
}

const BAD_NAME_CHARS: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|'];

pub fn validate(c: &ServerConfig) -> Vec<Issue> {
    let mut out = vec![];
    if c.name.trim().is_empty() {
        out.push(issue("error", "The server needs a name."));
    }
    let save = c.save_name.trim();
    if save.is_empty() {
        out.push(issue("error", "The world needs a save name."));
    } else if save.contains(BAD_NAME_CHARS) || save.starts_with('.') || save.len() > 64 {
        out.push(issue("error", format!("“{save}” can't be used as a save name – it becomes a folder, so avoid \\ / : * ? \" < > |.")));
    }
    let addr = c.address.trim();
    if !addr.is_empty() && addr.parse::<std::net::Ipv4Addr>().is_err() {
        out.push(issue("error", format!("“{addr}” isn't a valid IPv4 bind address (leave it empty for all interfaces).")));
    }
    for (label, p) in [("game", c.port), ("query", c.query_port)] {
        if p < 1024 {
            out.push(issue("error", format!("Pick a {label} port of 1024 or higher.")));
        }
    }
    if c.port == c.query_port {
        out.push(issue("error", "The game and query ports must be different."));
    }
    if c.rcon_enabled {
        if c.rcon_port < 1024 {
            out.push(issue("error", "Pick an RCON port of 1024 or higher."));
        }
        if c.rcon_password.trim().is_empty() {
            out.push(issue("error", "RCON needs a password – anyone who reaches the port could otherwise control the server."));
        } else if c.rcon_password.chars().count() < 8 {
            out.push(issue("warn", "The RCON password is short – use at least 8 characters."));
        }
    }
    if c.api_enabled && c.api_port < 1024 {
        out.push(issue("error", "Pick an API port of 1024 or higher."));
    }
    let tcp: Vec<u16> = [(c.rcon_enabled, c.rcon_port), (c.api_enabled, c.api_port)].iter().filter(|(on, _)| *on).map(|(_, p)| *p).collect();
    if tcp.len() == 2 && tcp[0] == tcp[1] {
        out.push(issue("error", "RCON and the API can't share a port."));
    }
    if !(1..=MAX_USERS).contains(&c.max_connected_users) {
        out.push(issue("error", format!("Max players must be between 1 and {MAX_USERS}.")));
    }
    if !(10..=120).contains(&c.server_fps) {
        out.push(issue("error", "Server FPS must be between 10 and 120 (30 is the default)."));
    } else if c.server_fps > 60 {
        out.push(issue("warn", "Server FPS above 60 costs a lot of CPU for little gain."));
    }
    if c.auto_save_count == 0 {
        out.push(issue("error", "Keep at least one autosave."));
    }
    if c.auto_save_interval < 30 {
        out.push(issue("error", "Autosave interval must be 30 seconds or more."));
    }
    if !c.password.is_empty() && c.password.chars().count() < 4 {
        out.push(issue("warn", "The join password is very short."));
    }
    if c.lan_mode && c.list_on_steam {
        out.push(issue("warn", "LAN mode is on – players outside your network can't join even though the server is listed."));
    }
    if !c.game_settings_preset.trim().is_empty() {
        out.push(issue("info", format!("Preset “{}” is active – the server ignores your custom gameplay settings while it's set.", c.game_settings_preset.trim())));
    }
    out
}

pub fn ensure_valid(c: &ServerConfig) -> AppResult<()> {
    let errs: Vec<String> = validate(c).into_iter().filter(|i| i.level == "error").map(|i| i.message).collect();
    if errs.is_empty() {
        Ok(())
    } else {
        Err(AppError::msg(format!("This configuration can't be used: {}", errs.join(" "))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Abridged ServerHostSettings.json as shipped with v1.1.15.0.
    const HOST: &str = "\u{feff}{\n  \"Name\": \"V Rising Server\",\n  \"Description\": \"\",\n  \"Port\": 9876,\n  \"QueryPort\": 9877,\n  \"MaxConnectedUsers\": 40,\n  \"MaxConnectedAdmins\": 4,\n  \"ServerFps\": 30,\n  \"SaveName\": \"world1\",\n  \"Password\": \"\",\n  \"Secure\": true,\n  \"ListOnSteam\": false,\n  \"ListOnEOS\": false,\n  \"AutoSaveCount\": 20,\n  \"AutoSaveInterval\": 120,\n  \"CompressSaveFiles\": true,\n  \"GameSettingsPreset\": \"\",\n  \"GameDifficultyPreset\": \"\",\n  \"AdminOnlyDebugEvents\": true,\n  \"DisableDebugEvents\": false,\n  \"API\": {\n    \"Enabled\": false\n  },\n  \"Rcon\": {\n    \"Enabled\": false,\n    \"Port\": 25575,\n    \"Password\": \"\"\n  },\n  \"FutureKey\": 7\n}";

    const GAME: &str = "{\n  \"GameModeType\": \"PvP\",\n  \"ClanSize\": 4,\n  \"SunDamageModifier\": 1.0,\n  \"VBloodUnitSettings\": [],\n  \"GameTimeModifiers\": {\n    \"DayDurationInSeconds\": 1080.0,\n    \"DayStartHour\": 9\n  }\n}";

    #[test]
    fn host_round_trip_keeps_unknown_keys() {
        let doc = parse_doc(HOST).unwrap();
        let mut c = ServerConfig::default();
        read_host(&doc, &mut c);
        assert_eq!(c.port, 9876);
        assert!(!c.list_on_steam);
        assert!(!c.rcon_enabled);
        c.name = "Dracula's Den".into();
        c.rcon_enabled = true;
        c.rcon_password = "s3cret-pass".into();
        c.max_connected_users = 10;
        let mut out = doc.clone();
        apply_host(&mut out, &c);
        let text = to_text(&out);
        assert!(text.starts_with("{\n  \"Name\": \"Dracula's Den\""));
        assert!(text.contains("\"MaxConnectedUsers\": 10"));
        assert!(text.contains("\"Password\": \"s3cret-pass\""));
        assert!(text.contains("\"BindPort\": 9090"));
        let keys: Vec<&String> = out.keys().collect();
        let pos = |k: &str| keys.iter().position(|x| x.as_str() == k).unwrap();
        assert!(pos("Rcon") < pos("FutureKey") && pos("FutureKey") < pos("LanMode"), "existing order kept, unknown keys kept, new keys appended");
        let mut back = ServerConfig::default();
        read_host(&out, &mut back);
        assert_eq!(back.name, c.name);
        assert!(back.rcon_enabled);
    }

    #[test]
    fn game_settings_flatten_and_keep_number_types() {
        let doc = parse_doc(GAME).unwrap();
        let flat = flatten(&doc);
        assert_eq!(flat["GameTimeModifiers.DayDurationInSeconds"], serde_json::json!(1080.0));
        assert!(!flat.contains_key("VBloodUnitSettings"), "arrays stay with the file");
        let mut changes = BTreeMap::new();
        changes.insert("ClanSize".to_string(), serde_json::json!(2.0)); // from a JS slider
        changes.insert("SunDamageModifier".to_string(), serde_json::json!(1));
        changes.insert("GameTimeModifiers.DayStartHour".to_string(), serde_json::json!(8));
        changes.insert("CastleStatModifiers_Global.CastleLimit".to_string(), serde_json::json!(3));
        let mut out = doc.clone();
        apply_game(&mut out, &changes);
        let text = to_text(&out);
        assert!(text.contains("\"ClanSize\": 2,"), "integer field stays integer: {text}");
        assert!(text.contains("\"SunDamageModifier\": 1.0"), "float field stays float");
        assert!(text.contains("\"DayStartHour\": 8"));
        assert!(text.contains("\"CastleLimit\": 3"), "missing nested keys are created");
        assert!(text.contains("\"VBloodUnitSettings\": []"));
    }

    #[test]
    fn sync_uses_shipped_templates() {
        let dir = std::env::temp_dir().join(format!("vrsm-cfg-{}", uuid::Uuid::new_v4()));
        let inst = ServerInstance { install_dir: dir.clone(), ..Default::default() };
        std::fs::create_dir_all(inst.default_settings_dir()).unwrap();
        std::fs::write(host_template(&inst), HOST).unwrap();
        std::fs::write(game_template(&inst), GAME).unwrap();
        let mut probe = ServerConfig::default();
        read_files_into(&inst, &mut probe).unwrap();
        assert_eq!(probe.game_settings["ClanSize"], serde_json::json!(4));
        let mut inst = inst;
        inst.config = probe;
        inst.config.rcon_password = "abcdefgh1".into();
        inst.config.game_settings.insert("ClanSize".into(), serde_json::json!(3));
        sync(&inst).unwrap();
        let host = std::fs::read_to_string(inst.host_path()).unwrap();
        assert!(host.contains("FutureKey"));
        assert!(host.contains("abcdefgh1"));
        assert!(std::fs::read_to_string(inst.game_path()).unwrap().contains("\"ClanSize\": 3"));
        assert!(inst.admin_path().exists() && inst.ban_path().exists());
        // A second sync with a change keeps a history copy.
        inst.config.name = "Renamed".into();
        sync(&inst).unwrap();
        assert!(history_dir(&inst.host_path()).read_dir().unwrap().next().is_some());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn lists_edit_and_ignore_junk() {
        let dir = std::env::temp_dir().join(format!("vrsm-list-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(ADMIN_FILE);
        std::fs::write(&p, "\u{feff}76561197960287930\n# comment\n\n76561197960287930\n").unwrap();
        assert_eq!(read_list(&p), vec!["76561197960287930".to_string()]);
        assert!(edit_list(&p, "76561198000000001", true).unwrap());
        assert!(!edit_list(&p, "76561198000000001", true).unwrap());
        assert!(edit_list(&p, "76561197960287930", false).unwrap());
        assert_eq!(read_list(&p), vec!["76561198000000001".to_string()]);
        assert!(edit_list(&p, "12345", true).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn validation_catches_real_problems() {
        let mut c = ServerConfig { rcon_password: "long-enough-pw".into(), ..Default::default() };
        assert!(validate(&c).iter().all(|i| i.level != "error"));
        c.query_port = c.port;
        assert!(validate(&c).iter().any(|i| i.message.contains("must be different")));
        c.query_port = 9877;
        c.rcon_password.clear();
        assert!(validate(&c).iter().any(|i| i.message.contains("RCON needs a password")));
        c.rcon_enabled = false;
        c.save_name = "a/b".into();
        assert!(validate(&c).iter().any(|i| i.message.contains("save name")));
        c.save_name = "world1".into();
        c.address = "not-an-ip".into();
        assert!(ensure_valid(&c).is_err());
    }
}
