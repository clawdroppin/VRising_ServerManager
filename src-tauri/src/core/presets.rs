//! The user's own game-rule presets: named snapshots of a server's custom rules (the flattened
//! ServerGameSettings keys), shared by every server profile. Stored in `<app data>\rule-presets.json`.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RulePreset {
    pub name: String,
    pub created_at: i64,
    pub settings: BTreeMap<String, serde_json::Value>,
}

fn file(data_dir: &Path) -> PathBuf {
    data_dir.join("rule-presets.json")
}

pub fn list(data_dir: &Path) -> Vec<RulePreset> {
    let mut v: Vec<RulePreset> = std::fs::read(file(data_dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    v.sort_by_key(|p| p.name.to_lowercase());
    v
}

fn write(data_dir: &Path, list: &[RulePreset]) -> AppResult<()> {
    std::fs::create_dir_all(data_dir)?;
    let tmp = file(data_dir).with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(list)?)?;
    std::fs::rename(tmp, file(data_dir))?;
    Ok(())
}

/// Save (or replace) a preset by name.
pub fn save(data_dir: &Path, name: &str, settings: BTreeMap<String, serde_json::Value>, now: i64) -> AppResult<RulePreset> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 60 {
        return Err(AppError::msg("Give the preset a name (up to 60 characters)."));
    }
    let mut all = list(data_dir);
    all.retain(|p| !p.name.eq_ignore_ascii_case(name));
    let p = RulePreset { name: name.to_string(), created_at: now, settings };
    all.push(p.clone());
    write(data_dir, &all)?;
    Ok(p)
}

pub fn delete(data_dir: &Path, name: &str) -> AppResult<()> {
    let mut all = list(data_dir);
    all.retain(|p| p.name != name);
    write(data_dir, &all)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_replace_delete() {
        let d = std::env::temp_dir().join(format!("vrsm-presets-{}", uuid::Uuid::new_v4()));
        let mut s = BTreeMap::new();
        s.insert("ClanSize".to_string(), serde_json::json!(4));
        save(&d, "Duo PvP", s.clone(), 1).unwrap();
        s.insert("ClanSize".to_string(), serde_json::json!(2));
        save(&d, "duo pvp", s, 2).unwrap();
        let l = list(&d);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].settings["ClanSize"], serde_json::json!(2));
        assert!(save(&d, "  ", BTreeMap::new(), 3).is_err());
        delete(&d, "duo pvp").unwrap();
        assert!(list(&d).is_empty());
        let _ = std::fs::remove_dir_all(d);
    }
}
