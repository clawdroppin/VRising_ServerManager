//! Router port forwarding over UPnP IGD, plus NAT diagnosis (double NAT / CGNAT).

use crate::error::{AppError, AppResult};
use crate::models::ServerInstance;
use igd_next::aio::tokio::{search_gateway, Tokio};
use igd_next::aio::Gateway;
use igd_next::{PortMappingProtocol, SearchOptions};
use regex::Regex;
use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mapping {
    pub external_port: u16,
    pub internal_port: u16,
    pub internal_client: String,
    pub description: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpnpInfo {
    /// The router answered UPnP discovery.
    pub found: bool,
    pub gateway: Option<String>,
    pub router_name: Option<String>,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    /// WAN address the router reports.
    pub external_ip: Option<String>,
    /// public | private (double NAT: another router in front) | cgnat (ISP-level NAT) | unknown
    pub wan_kind: String,
    /// UDP mappings on the router (all of them – the UI filters to the server's ports).
    pub mappings: Vec<Mapping>,
    pub error: Option<String>,
}

async fn find() -> Result<Gateway<Tokio>, String> {
    let opts = SearchOptions { timeout: Some(Duration::from_secs(4)), single_search_timeout: Some(Duration::from_secs(2)), ..Default::default() };
    search_gateway(opts).await.map_err(|e| e.to_string())
}

fn tag(xml: &str, name: &str) -> Option<String> {
    Regex::new(&format!(r"<{name}>([^<]+)</{name}>")).ok()?.captures(xml).map(|c| c[1].trim().to_string())
}

/// Local address of the interface that talks to the router.
fn local_ip_towards(gw: SocketAddr) -> Option<IpAddr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect(gw).ok()?;
    s.local_addr().ok().map(|a| a.ip())
}

pub async fn probe(http: &reqwest::Client) -> UpnpInfo {
    let gw = match find().await {
        Ok(g) => g,
        Err(e) => {
            return UpnpInfo {
                found: false,
                gateway: None,
                router_name: None,
                manufacturer: None,
                model: None,
                external_ip: None,
                wan_kind: "unknown".into(),
                mappings: vec![],
                error: Some(format!("No UPnP router answered ({e}). UPnP may be turned off in the router – forward the ports manually.")),
            }
        }
    };
    let mut info = UpnpInfo {
        found: true,
        gateway: Some(gw.addr.ip().to_string()),
        router_name: None,
        manufacturer: None,
        model: None,
        external_ip: gw.get_external_ip().await.ok().map(|i| i.to_string()),
        wan_kind: "unknown".into(),
        mappings: vec![],
        error: None,
    };
    info.wan_kind = info.external_ip.as_deref().map(ip_kind).unwrap_or("unknown").to_string();
    let desc_url = if gw.root_url.starts_with("http") { gw.root_url.clone() } else { format!("http://{}{}", gw.addr, gw.root_url) };
    if let Ok(r) = http.get(&desc_url).timeout(Duration::from_secs(3)).send().await {
        if let Ok(xml) = r.text().await {
            info.router_name = tag(&xml, "friendlyName");
            info.manufacturer = tag(&xml, "manufacturer");
            info.model = tag(&xml, "modelName");
        }
    }
    for i in 0..128u32 {
        match gw.get_generic_port_mapping_entry(i).await {
            Ok(e) if e.protocol == PortMappingProtocol::UDP => info.mappings.push(Mapping {
                external_port: e.external_port,
                internal_port: e.internal_port,
                internal_client: e.internal_client,
                description: e.port_mapping_description,
                enabled: e.enabled,
            }),
            Ok(_) => {}
            Err(_) => break,
        }
    }
    info
}

pub fn server_ports(inst: &ServerInstance) -> Vec<u16> {
    inst.udp_ports()
}

/// Forward the server's UDP ports to this PC. Tries a permanent lease first, then 7 days
/// (some routers refuse infinite leases). Returns one line per port.
pub async fn map_server(inst: &ServerInstance) -> AppResult<Vec<String>> {
    let gw = find().await.map_err(|e| AppError::msg(format!("No UPnP router found ({e}). Turn on UPnP in the router or forward the ports manually.")))?;
    let local: IpAddr = match inst.config.address.trim().parse::<IpAddr>().ok().filter(|ip| !ip.is_unspecified()).ok_or(()) {
        Ok(ip) => ip,
        Err(_) => local_ip_towards(gw.addr).ok_or_else(|| AppError::msg("Couldn't work out this PC's LAN address."))?,
    };
    let mut out = vec![];
    for port in server_ports(inst) {
        let desc = format!("V Rising {} ({port})", inst.name.chars().take(24).collect::<String>());
        let addr = SocketAddr::new(local, port);
        let mut res = gw.add_port(PortMappingProtocol::UDP, port, addr, 0, &desc).await;
        if res.is_err() {
            res = gw.add_port(PortMappingProtocol::UDP, port, addr, 604_800, &desc).await;
        }
        match res {
            Ok(()) => out.push(format!("UDP {port} → {local}:{port} forwarded")),
            Err(e) => {
                return Err(AppError::msg(format!(
                    "The router refused UDP {port}: {e}. Another device may already use that port, or UPnP is restricted – forward it manually."
                )))
            }
        }
    }
    Ok(out)
}

pub async fn unmap_server(inst: &ServerInstance) -> AppResult<()> {
    let gw = find().await.map_err(|e| AppError::msg(format!("No UPnP router found ({e}).")))?;
    for port in server_ports(inst) {
        let _ = gw.remove_port(PortMappingProtocol::UDP, port).await;
    }
    Ok(())
}

/// Classify an address for NAT diagnosis.
pub fn ip_kind(ip: &str) -> &'static str {
    match ip.parse::<Ipv4Addr>() {
        Ok(v4) if v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]) => "cgnat",
        Ok(v4) if v4.is_private() || v4.is_link_local() || v4.is_loopback() => "private",
        Ok(_) => "public",
        Err(_) => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classifies_addresses() {
        assert_eq!(ip_kind("100.72.1.9"), "cgnat");
        assert_eq!(ip_kind("192.168.1.1"), "private");
        assert_eq!(ip_kind("10.0.0.2"), "private");
        assert_eq!(ip_kind("203.0.113.5"), "public");
        assert_eq!(tag("<root><friendlyName>Archer AX55</friendlyName></root>", "friendlyName").as_deref(), Some("Archer AX55"));
    }
}
