//! Secrets at rest: Windows DPAPI (current-user scope).
//!
//! Profiles and settings are held in memory in plain text; only the JSON written to disk carries
//! `dpapi:<base64>` values. A value that can't be decrypted (portable folder moved to another
//! PC/account) comes back empty and is reported, so the UI can ask for it again instead of the
//! app failing to load.
//!
//! The secrets are the join password, the RCON password, the optional Steam branch password and
//! the app-level webhook URL. (The server itself needs them in plain text in
//! ServerHostSettings.json – that file is the server's, not the manager's.)

use crate::models::{AppSettings, ServerInstance};
use base64::Engine;

const PREFIX: &str = "dpapi:";

#[cfg(windows)]
fn protect(plain: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    // SAFETY: input blob points into `plain` for the duration of the call; the output buffer is
    // allocated by the OS and released with LocalFree after copying.
    unsafe {
        let input = CRYPT_INTEGER_BLOB { cbData: plain.len() as u32, pbData: plain.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let desc: Vec<u16> = "VRSM secret\0".encode_utf16().collect();
        if CryptProtectData(&input, desc.as_ptr(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0x1 /* UI_FORBIDDEN */, &mut out) == 0 {
            return None;
        }
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as _);
        Some(v)
    }
}

#[cfg(windows)]
fn unprotect(cipher: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    // SAFETY: as above.
    unsafe {
        let input = CRYPT_INTEGER_BLOB { cbData: cipher.len() as u32, pbData: cipher.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        if CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0x1, &mut out) == 0 {
            return None;
        }
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as _);
        Some(v)
    }
}

#[cfg(not(windows))]
fn protect(plain: &[u8]) -> Option<Vec<u8>> {
    Some(plain.to_vec())
}
#[cfg(not(windows))]
fn unprotect(cipher: &[u8]) -> Option<Vec<u8>> {
    Some(cipher.to_vec())
}

/// Encrypt for disk. Empty stays empty; already-encrypted values pass through.
pub fn seal(plain: &str) -> String {
    if plain.is_empty() || plain.starts_with(PREFIX) {
        return plain.to_string();
    }
    match protect(plain.as_bytes()) {
        Some(c) => format!("{PREFIX}{}", base64::engine::general_purpose::STANDARD.encode(c)),
        // DPAPI unavailable (very unusual) – keep the value rather than lose it.
        None => plain.to_string(),
    }
}

/// Decrypt from disk. Plain values (hand-edited files, imports) are accepted as-is.
/// Returns `None` when the value is encrypted but can't be decrypted on this account/PC.
pub fn open(stored: &str) -> Option<String> {
    let Some(b64) = stored.strip_prefix(PREFIX) else { return Some(stored.to_string()) };
    let cipher = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    let plain = unprotect(&cipher)?;
    String::from_utf8(plain).ok()
}

fn open_field(v: &mut String, lost: &mut Vec<String>, what: &str) {
    match open(v) {
        Some(p) => *v = p,
        None => {
            lost.push(what.to_string());
            v.clear();
        }
    }
}

/// Seal every secret in a profile for writing to disk.
pub fn seal_instance(i: &ServerInstance) -> ServerInstance {
    let mut s = i.clone();
    s.config.password = seal(&s.config.password);
    s.config.rcon_password = seal(&s.config.rcon_password);
    s.branch_password = seal(&s.branch_password);
    s
}

/// Decrypt in place; returns the names of secrets that could not be recovered.
pub fn open_instance(i: &mut ServerInstance) -> Vec<String> {
    let mut lost = vec![];
    let n = i.name.clone();
    open_field(&mut i.config.password, &mut lost, &format!("{n}: join password"));
    open_field(&mut i.config.rcon_password, &mut lost, &format!("{n}: RCON password"));
    open_field(&mut i.branch_password, &mut lost, &format!("{n}: branch password"));
    lost
}

pub fn seal_settings(s: &AppSettings) -> AppSettings {
    let mut c = s.clone();
    c.webhook_url = seal(&c.webhook_url);
    c
}

pub fn open_settings(s: &mut AppSettings) -> Vec<String> {
    let mut lost = vec![];
    open_field(&mut s.webhook_url, &mut lost, "Webhook URL");
    lost
}

/// A strong random password (RCON, generated join passwords) (uppercase/lowercase/digits, no ambiguous chars).
pub fn random_password(len: usize) -> String {
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    let mut out = String::with_capacity(len);
    while out.len() < len {
        for b in uuid::Uuid::new_v4().as_bytes() {
            if out.len() >= len {
                break;
            }
            // 248 = 56 * 4.4 → reject the tail to keep the distribution uniform.
            if (*b as usize) < CHARS.len() * (256 / CHARS.len()) {
                out.push(CHARS[*b as usize % CHARS.len()] as char);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let s = seal("hunter2");
        assert!(s.starts_with(PREFIX));
        assert_ne!(s, "hunter2");
        assert_eq!(open(&s).as_deref(), Some("hunter2"));
        assert_eq!(seal(""), "");
        assert_eq!(open("plain").as_deref(), Some("plain"));
        assert_eq!(seal(&s), s, "sealing twice is a no-op");
        assert!(open("dpapi:AAAA").is_none());
    }

    #[test]
    fn passwords_are_random_and_clean() {
        let a = random_password(24);
        let b = random_password(24);
        assert_eq!(a.len(), 24);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() && !"0O1lI".contains(c)));
    }
}
