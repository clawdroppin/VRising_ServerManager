//! Firewall rules, IP addresses, port availability.

use super::proc;
use crate::error::AppResult;
use crate::models::*;
use serde::Serialize;
use std::path::Path;

pub fn rule_name(inst: &ServerInstance) -> String {
    format!("V Rising Server ({})", &inst.id[..8.min(inst.id.len())])
}

fn ports(inst: &ServerInstance) -> Vec<u16> {
    inst.udp_ports()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirewallState {
    pub rule_exists: bool,
    pub ports_ok: bool,
    pub rule_ports: String,
    /// An enabled inbound Allow rule for the server executable exists.
    pub program_rule: bool,
    /// Enabled inbound Block rules for the executable – Windows creates these when its "allow
    /// access?" prompt is dismissed, and Block always beats Allow.
    pub blocked_by: Vec<String>,
}

fn ps_quote(s: &str) -> String {
    s.replace('\'', "''")
}

/// Inspect inbound rules without elevation.
pub async fn firewall_state(inst: &ServerInstance) -> FirewallState {
    let name = ps_quote(&rule_name(inst));
    let exe = ps_quote(&inst.server_exe().display().to_string());
    let script = format!(
        "$r = Get-NetFirewallRule -DisplayName '{name}' -ErrorAction SilentlyContinue | Where-Object {{ $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' }};          if ($r) {{ 'PORTS:' + (($r | Get-NetFirewallPortFilter | Where-Object {{ $_.Protocol -eq 'UDP' }} | ForEach-Object {{ $_.LocalPort }}) -join ',') }} else {{ 'PORTS:NONE' }};          Get-NetFirewallApplicationFilter -Program '{exe}' -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object {{ $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' }} | ForEach-Object {{ $_.Action.ToString() + ':' + $_.DisplayName }}"
    );
    let out = proc::powershell(&script).await.map(|(_, o)| o).unwrap_or_default();
    let ports_line = out.lines().find_map(|l| l.trim().strip_prefix("PORTS:")).unwrap_or("NONE").trim().to_string();
    let exists = ports_line != "NONE" && !ports_line.is_empty();
    let listed: Vec<String> = ports_line.split([',', ' ']).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let ports_ok = exists && ports(inst).iter().all(|p| listed.iter().any(|l| l == &p.to_string() || l == "Any"));
    let program_rule = out.lines().any(|l| l.trim().starts_with("Allow:"));
    let mut blocked_by: Vec<String> = out.lines().filter_map(|l| l.trim().strip_prefix("Block:").map(|n| n.to_string())).collect();
    blocked_by.dedup();
    FirewallState { rule_exists: exists, ports_ok, rule_ports: if exists { ports_line } else { String::new() }, program_rule, blocked_by }
}

/// Create (or replace) inbound UDP rules for this server's game and query ports and remove Block
/// rules Windows added for the executable – one UAC prompt. RCON/API (TCP) are deliberately not
/// opened: they're for this PC; open them yourself if you administer remotely.
pub async fn add_firewall_rules(inst: &ServerInstance, work_dir: &Path) -> AppResult<String> {
    let name = ps_quote(&rule_name(inst));
    let ports = ports(inst).iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");
    let exe = ps_quote(&inst.server_exe().display().to_string());
    let script = format!(
        "Get-NetFirewallApplicationFilter -Program '{exe}' -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object {{ $_.Action -eq 'Block' }} | Remove-NetFirewallRule -ErrorAction SilentlyContinue
         Remove-NetFirewallRule -DisplayName '{name}' -ErrorAction SilentlyContinue
         New-NetFirewallRule -DisplayName '{name}' -Direction Inbound -Protocol UDP -LocalPort {ports} -Action Allow -Profile Any | Out-Null
         New-NetFirewallRule -DisplayName '{name}' -Direction Inbound -Program '{exe}' -Protocol UDP -Action Allow -Profile Any | Out-Null
         Write-Output 'RULES_OK'"
    );
    let out = proc::powershell_elevated(&script, work_dir).await?;
    Ok(out)
}

pub async fn remove_firewall_rules(inst: &ServerInstance, work_dir: &Path) -> AppResult<()> {
    let name = ps_quote(&rule_name(inst));
    proc::powershell_elevated(&format!("Remove-NetFirewallRule -DisplayName '{name}' -ErrorAction SilentlyContinue"), work_dir).await?;
    Ok(())
}

pub async fn public_ip(http: &reqwest::Client) -> Option<String> {
    for url in ["https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com"] {
        if let Ok(r) = http.get(url).timeout(std::time::Duration::from_secs(5)).send().await {
            if let Ok(t) = r.text().await {
                let t = t.trim().to_string();
                if t.parse::<std::net::IpAddr>().is_ok() {
                    return Some(t);
                }
            }
        }
    }
    None
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalIp {
    pub interface: String,
    pub ip: String,
}

pub fn local_ips() -> Vec<LocalIp> {
    let nets = sysinfo::Networks::new_with_refreshed_list();
    let mut out = vec![];
    for (name, data) in nets.iter() {
        for ip in data.ip_networks() {
            if let std::net::IpAddr::V4(v4) = ip.addr {
                if !v4.is_loopback() && !v4.is_link_local() {
                    out.push(LocalIp { interface: name.clone(), ip: v4.to_string() });
                }
            }
        }
    }
    out.sort_by(|a, b| a.ip.cmp(&b.ip));
    out
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortSet {
    pub port: u16,
    pub query_port: u16,
    pub rcon_port: u16,
}

/// Next free ports: game/query 9876/9877, then 9886/9887 … (steps of 10 keep the server's
/// FallbackPort 9878 free), RCON 25575, 25576 …, unused by other profiles and other programs.
pub async fn suggest_ports(instances: &[ServerInstance], exclude_id: Option<&str>) -> PortSet {
    let (udp, tcp) = tokio::join!(proc::udp_port_owners(), proc::tcp_listen_owners());
    let others: Vec<&ServerInstance> = instances.iter().filter(|i| Some(i.id.as_str()) != exclude_id).collect();
    let used_udp: Vec<u16> = others.iter().flat_map(|i| i.udp_ports()).collect();
    let used_tcp: Vec<u16> = others.iter().flat_map(|i| [i.config.rcon_port, i.config.api_port]).collect();
    pick_ports(|p| !used_udp.contains(&p) && !udp.contains_key(&p), |p| !used_tcp.contains(&p) && !tcp.contains_key(&p))
}

fn pick_ports(udp_free: impl Fn(u16) -> bool, tcp_free: impl Fn(u16) -> bool) -> PortSet {
    let port = (0..60u16).map(|i| DEFAULT_GAME_PORT + i * 10).find(|p| udp_free(*p) && udp_free(p + 1)).unwrap_or(DEFAULT_GAME_PORT);
    let rcon_port = (DEFAULT_RCON_PORT..DEFAULT_RCON_PORT + 200).find(|p| tcp_free(*p)).unwrap_or(DEFAULT_RCON_PORT);
    PortSet { port, query_port: port + 1, rcon_port }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamListing {
    pub addr: String,
    pub gameport: u16,
    pub appid: u32,
    pub steamid: String,
}

/// Servers Steam's master list has registered at a public IP (no API key needed). This is what
/// the in-game Join list is built from, so "listed" = players can find the server by name.
pub async fn steam_listing(http: &reqwest::Client, public_ip: &str) -> AppResult<Vec<SteamListing>> {
    let url = format!("https://api.steampowered.com/ISteamApps/GetServersAtAddress/v1/?addr={public_ip}");
    let v: serde_json::Value = http.get(url).timeout(std::time::Duration::from_secs(8)).send().await?.json().await?;
    let mut out = vec![];
    for s in v["response"]["servers"].as_array().cloned().unwrap_or_default() {
        if s["appid"].as_u64() != Some(GAME_APP_ID as u64) {
            continue;
        }
        out.push(SteamListing {
            addr: s["addr"].as_str().unwrap_or_default().to_string(),
            gameport: s["gameport"].as_u64().unwrap_or(0) as u16,
            appid: GAME_APP_ID,
            steamid: s["steamid"].as_str().unwrap_or_default().to_string(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ports_step_past_used_ones() {
        assert_eq!(pick_ports(|_| true, |_| true), PortSet { port: 9876, query_port: 9877, rcon_port: 25575 });
        let p = pick_ports(|p| p != 9877, |p| p != 25575);
        assert_eq!(p, PortSet { port: 9886, query_port: 9887, rcon_port: 25576 });
    }
}

/// The router this PC sends internet traffic to (IPv4 default route), from `route print`.
pub async fn default_gateway() -> Option<String> {
    let (_, out) = proc::capture("route.exe", &["print", "-4", "0.0.0.0"]).await.ok()?;
    out.lines().find_map(|l| {
        let c: Vec<&str> = l.split_whitespace().collect();
        (c.len() >= 5 && c[0] == "0.0.0.0" && c[1] == "0.0.0.0" && c[2].parse::<std::net::Ipv4Addr>().is_ok()).then(|| c[2].to_string())
    })
}
