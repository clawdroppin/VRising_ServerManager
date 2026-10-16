//! Steam A2S queries against the server's query port. Verified against V Rising v1.1.15.0: it
//! answers A2S_INFO, A2S_PLAYER and A2S_RULES (all with a challenge) – but only while
//! `ListOnSteam` is on; an unlisted server doesn't answer at all.

use serde::Serialize;
use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::UdpSocket;

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct A2sInfo {
    pub name: String,
    pub players: u32,
    pub max_players: u32,
    pub version: String,
    /// The server has a join password.
    pub password: bool,
    pub keywords: String,
    pub ping_ms: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct A2sPlayer {
    pub name: String,
    pub score: i32,
    pub duration_secs: f32,
}

const INFO_REQ: &[u8] = b"\xff\xff\xff\xffTSource Engine Query\x00";

async fn exchange(sock: &UdpSocket, addr: SocketAddr, req: &[u8], timeout: Duration) -> Option<Vec<u8>> {
    sock.send_to(req, addr).await.ok()?;
    let mut buf = vec![0u8; 4096];
    let (n, _) = tokio::time::timeout(timeout, sock.recv_from(&mut buf)).await.ok()?.ok()?;
    buf.truncate(n);
    Some(buf)
}

/// Send `req`; if the server answers with a challenge (`A`), resend with it appended (INFO) or
/// in place of the trailing `FFFFFFFF` (PLAYER).
async fn query(addr: SocketAddr, req: &[u8], replace_tail: bool, timeout: Duration) -> Option<Vec<u8>> {
    let sock = UdpSocket::bind("0.0.0.0:0").await.ok()?;
    let r = exchange(&sock, addr, req, timeout).await?;
    if r.len() >= 9 && r[4] == b'A' {
        let mut again = if replace_tail { req[..req.len() - 4].to_vec() } else { req.to_vec() };
        again.extend_from_slice(&r[5..9]);
        return exchange(&sock, addr, &again, timeout).await;
    }
    Some(r)
}

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl Reader<'_> {
    fn u8(&mut self) -> Option<u8> {
        let v = *self.b.get(self.i)?;
        self.i += 1;
        Some(v)
    }
    fn cstr(&mut self) -> Option<String> {
        let end = self.b[self.i..].iter().position(|c| *c == 0)? + self.i;
        let s = String::from_utf8_lossy(&self.b[self.i..end]).into_owned();
        self.i = end + 1;
        Some(s)
    }
    fn take(&mut self, n: usize) -> Option<&[u8]> {
        let s = self.b.get(self.i..self.i + n)?;
        self.i += n;
        Some(s)
    }
}

pub fn parse_info(b: &[u8]) -> Option<A2sInfo> {
    if b.len() < 6 || b[4] != b'I' {
        return None;
    }
    let mut r = Reader { b, i: 6 };
    let name = r.cstr()?;
    let _map = r.cstr()?;
    let _folder = r.cstr()?;
    let _game = r.cstr()?;
    r.take(2)?; // app id
    let players = r.u8()? as u32;
    let max_players = r.u8()? as u32;
    let _bots = r.u8()?;
    let _kind = r.u8()?;
    let _env = r.u8()?;
    let password = r.u8()? == 1;
    let _vac = r.u8()?;
    let version = r.cstr()?;
    let mut keywords = String::new();
    if let Some(edf) = r.u8() {
        if edf & 0x80 != 0 {
            r.take(2)?;
        }
        if edf & 0x10 != 0 {
            r.take(8)?;
        }
        if edf & 0x40 != 0 {
            r.take(2)?;
            r.cstr()?;
        }
        if edf & 0x20 != 0 {
            keywords = r.cstr().unwrap_or_default();
        }
    }
    Some(A2sInfo { name, players, max_players, version, password, keywords, ping_ms: 0 })
}

pub fn parse_players(b: &[u8]) -> Option<Vec<A2sPlayer>> {
    if b.len() < 6 || b[4] != b'D' {
        return None;
    }
    let mut r = Reader { b, i: 6 };
    let mut out = vec![];
    for _ in 0..b[5] {
        let _idx = r.u8()?;
        let name = r.cstr()?;
        let score = i32::from_le_bytes(r.take(4)?.try_into().ok()?);
        let duration_secs = f32::from_le_bytes(r.take(4)?.try_into().ok()?);
        out.push(A2sPlayer { name, score, duration_secs });
    }
    Some(out)
}

/// A2S_RULES: key/value pairs (`days-runningv2`, `blood-bound-enabled`, `settings0` …).
pub fn parse_rules(b: &[u8]) -> Option<std::collections::BTreeMap<String, String>> {
    if b.len() < 7 || b[4] != b'E' {
        return None;
    }
    let n = u16::from_le_bytes([b[5], b[6]]);
    let mut r = Reader { b, i: 7 };
    let mut out = std::collections::BTreeMap::new();
    for _ in 0..n {
        let (Some(k), Some(v)) = (r.cstr(), r.cstr()) else { break };
        out.insert(k, v);
    }
    Some(out)
}

pub async fn rules(addr: SocketAddr, timeout: Duration) -> Option<std::collections::BTreeMap<String, String>> {
    let b = query(addr, b"\xff\xff\xff\xffV\xff\xff\xff\xff", true, timeout).await?;
    parse_rules(&b)
}

pub async fn info(addr: SocketAddr, timeout: Duration) -> Option<A2sInfo> {
    let t0 = std::time::Instant::now();
    let b = query(addr, INFO_REQ, false, timeout).await?;
    let mut i = parse_info(&b)?;
    i.ping_ms = t0.elapsed().as_millis() as u32;
    Some(i)
}

pub async fn players(addr: SocketAddr, timeout: Duration) -> Option<Vec<A2sPlayer>> {
    let b = query(addr, b"\xff\xff\xff\xffU\xff\xff\xff\xff", true, timeout).await?;
    parse_players(&b)
}

/// Where to query a server on this PC: its bind address, or loopback when it binds all interfaces.
pub fn local_addr(ip: &str, port: u16) -> SocketAddr {
    let ip = ip.trim();
    let host: std::net::IpAddr = if ip.is_empty() || ip == "0.0.0.0" { [127, 0, 0, 1].into() } else { ip.parse().unwrap_or([127, 0, 0, 1].into()) };
    SocketAddr::new(host, port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_replies() {
        // Captured from VRisingServer.exe v1.1.15.0 with ListOnSteam on.
        let b = b"\xff\xff\xff\xffI\x11VRSM Test\x00VRisingWorld\x00V Rising\x002d99ed23-fafd-45fc-a7c5-dcc8dc3e8783\x00\x00\x00\x00(\x00dw\x00\x010.0.0.1\x00\xb1\x94&\x00<\xf1W\xc7\xca@\x01pvp,cs4,hc,ded,dif_no\x00\xbey\x18\x00\x00\x00\x00\x00";
        let i = parse_info(b).unwrap();
        assert_eq!(i.name, "VRSM Test");
        assert_eq!((i.players, i.max_players), (0, 40));
        assert!(!i.password);
        assert_eq!(i.keywords, "pvp,cs4,hc,ded,dif_no");
        let r = parse_rules(b"\xff\xff\xff\xffE\x02\x00blood-bound-enabled\x00True\x00days-runningv2\x000\x00").unwrap();
        assert_eq!(r["days-runningv2"], "0");
        assert_eq!(r["blood-bound-enabled"], "True");
        assert_eq!(parse_players(b"\xff\xff\xff\xffD\x00").unwrap(), vec![]);
        let p = parse_players(b"\xff\xff\xff\xffD\x01\x00Bob\x00\x00\x00\x00\x00\x00\x00\x20\x41").unwrap();
        assert_eq!(p[0].name, "Bob");
        assert_eq!(p[0].duration_secs, 10.0);
    }
}
