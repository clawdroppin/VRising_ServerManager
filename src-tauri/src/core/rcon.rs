//! Source RCON client for the V Rising server (`Rcon` block of ServerHostSettings.json, TCP).
//!
//! Packet layout (little endian): `i32 size | i32 id | i32 type | body\0 | \0`.
//!
//! Verified against v1.1.15.0: the server answers AUTH with a single AUTH_RESPONSE (id echoed,
//! -1 on a wrong password) and every command with one RESPONSE_VALUE. Commands it knows: `help`,
//! `announce <text>`, `announcerestart <minutes>`, `shutdown <message times> <message>`,
//! `cancelshutdown`, `version`, `time`, `name <text>`, `description <text>`,
//! `password <pw> | --clear` and `runcommand <console command>` (runs, but returns no output).
//! There's no player list over RCON.

use crate::error::{AppError, AppResult};
use crate::models::ServerInstance;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

const SERVERDATA_AUTH: i32 = 3;
const SERVERDATA_EXECCOMMAND: i32 = 2;
const SERVERDATA_AUTH_RESPONSE: i32 = 2;
const MAX_PACKET: i32 = 4096 * 16;

pub struct RconClient {
    stream: Option<TcpStream>,
    addr: String,
    password: String,
    next_id: i32,
}

struct Packet {
    id: i32,
    kind: i32,
    body: String,
}

/// Where the manager reaches a server's RCON: its bind address, or loopback when it binds all.
pub fn local_target(inst: &ServerInstance) -> String {
    let host = match inst.config.address.trim() {
        "" | "0.0.0.0" => "127.0.0.1",
        a => a,
    };
    format!("{host}:{}", inst.config.rcon_port)
}

impl RconClient {
    pub fn new(addr: &str, password: &str) -> Self {
        Self { stream: None, addr: addr.to_string(), password: password.to_string(), next_id: 1 }
    }

    async fn connect(&mut self) -> AppResult<()> {
        if self.password.is_empty() {
            return Err(AppError::msg("RCON has no password set."));
        }
        let stream = timeout(Duration::from_secs(3), TcpStream::connect(&self.addr))
            .await
            .map_err(|_| AppError::msg(format!("RCON: timed out connecting to {}", self.addr)))?
            .map_err(|e| AppError::msg(format!("RCON: can't connect to {} ({e}) – is RCON enabled and the server running?", self.addr)))?;
        stream.set_nodelay(true).ok();
        self.stream = Some(stream);
        let id = self.alloc_id();
        let pw = self.password.clone();
        self.write_packet(id, SERVERDATA_AUTH, &pw).await?;
        // Source servers may send an empty RESPONSE_VALUE before the AUTH_RESPONSE.
        for _ in 0..2 {
            let p = self.read_packet(Duration::from_secs(5)).await?;
            if p.kind == SERVERDATA_AUTH_RESPONSE {
                if p.id == -1 {
                    self.stream = None;
                    return Err(AppError::msg("RCON: the server rejected the password."));
                }
                return Ok(());
            }
        }
        self.stream = None;
        Err(AppError::msg("RCON: no authentication response from the server."))
    }

    fn alloc_id(&mut self) -> i32 {
        self.next_id = self.next_id.wrapping_add(1).max(1);
        self.next_id
    }

    async fn write_packet(&mut self, id: i32, kind: i32, body: &str) -> AppResult<()> {
        let stream = self.stream.as_mut().ok_or_else(|| AppError::msg("RCON: not connected"))?;
        let bytes = body.as_bytes();
        let size = (4 + 4 + bytes.len() + 2) as i32;
        let mut buf = Vec::with_capacity(size as usize + 4);
        buf.extend_from_slice(&size.to_le_bytes());
        buf.extend_from_slice(&id.to_le_bytes());
        buf.extend_from_slice(&kind.to_le_bytes());
        buf.extend_from_slice(bytes);
        buf.extend_from_slice(&[0, 0]);
        if let Err(e) = stream.write_all(&buf).await {
            self.stream = None;
            return Err(AppError::msg(format!("RCON: write failed ({e})")));
        }
        Ok(())
    }

    async fn read_packet(&mut self, wait: Duration) -> AppResult<Packet> {
        let stream = self.stream.as_mut().ok_or_else(|| AppError::msg("RCON: not connected"))?;
        let res: std::io::Result<Packet> = timeout(wait, async {
            let size = stream.read_i32_le().await?;
            if !(10..=MAX_PACKET).contains(&size) {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "bad packet size"));
            }
            let mut buf = vec![0u8; size as usize];
            stream.read_exact(&mut buf).await?;
            let id = i32::from_le_bytes(buf[0..4].try_into().unwrap());
            let kind = i32::from_le_bytes(buf[4..8].try_into().unwrap());
            let body_bytes = &buf[8..buf.len().saturating_sub(2)];
            Ok(Packet { id, kind, body: String::from_utf8_lossy(body_bytes).into_owned() })
        })
        .await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "timed out"))
        .and_then(|r| r);
        match res {
            Ok(p) => Ok(p),
            Err(e) => {
                self.stream = None;
                Err(AppError::msg(format!("RCON: read failed ({e})")))
            }
        }
    }

    /// Execute a command, reconnecting once if the connection was dropped (the server closes idle
    /// connections after `TimeoutSeconds`).
    pub async fn exec(&mut self, command: &str) -> AppResult<String> {
        let mut last = None;
        for _ in 0..2 {
            if self.stream.is_none() {
                self.connect().await?;
            }
            match self.exec_once(command).await {
                Ok(s) => return Ok(s),
                Err(e) => {
                    self.stream = None;
                    last = Some(e);
                }
            }
        }
        Err(last.unwrap_or_else(|| AppError::msg("RCON failed")))
    }

    async fn exec_once(&mut self, command: &str) -> AppResult<String> {
        let id = self.alloc_id();
        self.write_packet(id, SERVERDATA_EXECCOMMAND, command).await?;
        let mut out = String::new();
        loop {
            let p = self.read_packet(Duration::from_secs(10)).await?;
            if p.id == id {
                out.push_str(&p.body);
                break;
            }
        }
        // Drain multi-packet responses that arrive back-to-back.
        while out.len() >= 4000 {
            match self.read_packet(Duration::from_millis(150)).await {
                Ok(p) if p.id == id => out.push_str(&p.body),
                _ => break,
            }
        }
        Ok(out.replace("\r\n", "\n").trim_end().to_string())
    }
}

/// `announce` text can't span lines; keep it one short line.
pub fn clean_message(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(240).collect()
}

/// One argument for commands that take exactly one (`name`, `description`, `password`): the
/// server splits on spaces unless the value is quoted (verified – `name A B` answers "error: too
/// many arguments"). None when the value itself contains a quote.
pub fn quote_arg(s: &str) -> Option<String> {
    let v = clean_message(s);
    (!v.contains('"')).then(|| format!("\"{v}\""))
}

/// The server answers a malformed command with usage text that starts with `error:` (still a
/// normal RESPONSE_VALUE) – turn that into an error.
pub fn check_reply(reply: String) -> AppResult<String> {
    match reply.trim_start().strip_prefix("error:") {
        Some(rest) => Err(AppError::msg(format!("The server refused the command: {}", rest.split_whitespace().collect::<Vec<_>>().join(" ")))),
        None => Ok(reply),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn quoting_and_error_replies() {
        assert_eq!(quote_arg("  My   Server ").as_deref(), Some("\"My Server\""));
        assert_eq!(quote_arg("bad\"pw"), None);
        assert!(check_reply("error: too many arguments\n\n usage: name <name>".into()).is_err());
        assert_eq!(check_reply("new server name set".into()).unwrap(), "new server name set");
    }

    async fn read(s: &mut TcpStream) -> (i32, i32, String) {
        let n = s.read_i32_le().await.unwrap();
        let mut b = vec![0u8; n as usize];
        s.read_exact(&mut b).await.unwrap();
        (i32::from_le_bytes(b[0..4].try_into().unwrap()), i32::from_le_bytes(b[4..8].try_into().unwrap()), String::from_utf8_lossy(&b[8..b.len() - 2]).into_owned())
    }

    async fn write(s: &mut TcpStream, id: i32, kind: i32, body: &str) {
        let mut buf = vec![];
        buf.extend_from_slice(&((10 + body.len()) as i32).to_le_bytes());
        buf.extend_from_slice(&id.to_le_bytes());
        buf.extend_from_slice(&kind.to_le_bytes());
        buf.extend_from_slice(body.as_bytes());
        buf.extend_from_slice(&[0, 0]);
        s.write_all(&buf).await.unwrap();
    }

    /// Behaves like the V Rising server: one AUTH_RESPONSE, one reply per command.
    #[tokio::test]
    async fn talks_to_a_v_rising_style_server() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap().to_string();
        tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let (id, kind, pw) = read(&mut s).await;
            assert_eq!(kind, 3);
            write(&mut s, if pw == "good" { id } else { -1 }, 2, "").await;
            loop {
                let (id, _, cmd) = read(&mut s).await;
                let reply = if cmd == "version" { "v1.1.15.0-r101082-b2 (202609071358)".to_string() } else { format!("Invalid command \"{cmd}\"") };
                write(&mut s, id, 0, &reply).await;
            }
        });
        let mut c = RconClient::new(&addr, "good");
        assert_eq!(c.exec("version").await.unwrap(), "v1.1.15.0-r101082-b2 (202609071358)");
        assert!(c.exec("listusers").await.unwrap().starts_with("Invalid command"));
    }

    #[tokio::test]
    async fn wrong_password_is_reported() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap().to_string();
        tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let (_, _, _) = read(&mut s).await;
            write(&mut s, -1, 2, "").await;
        });
        let mut c = RconClient::new(&addr, "bad");
        assert!(c.exec("version").await.unwrap_err().to_string().contains("rejected the password"));
    }

    #[test]
    fn messages_are_one_line() {
        assert_eq!(clean_message("Restart\n in  5\tminutes"), "Restart in 5 minutes");
    }
}
