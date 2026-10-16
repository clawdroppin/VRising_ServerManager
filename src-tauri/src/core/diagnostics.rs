//! Health checks for one server, each with an optional one-click fix the UI can trigger.

use super::{config, network, proc, steamcmd};
use crate::models::*;
use crate::state::AppState;

fn check(id: &str, title: &str, level: &str, detail: impl Into<String>, fix: &str) -> DiagCheck {
    DiagCheck { id: id.into(), title: title.into(), level: level.into(), detail: detail.into(), fix: fix.into() }
}

pub async fn run(state: &AppState, inst: &ServerInstance) -> Vec<DiagCheck> {
    let mut out = vec![];
    let installed = inst.is_installed();

    // Files
    if installed {
        out.push(check("install", "Server files", "ok", format!("{}", inst.server_exe().display()), ""));
        match steamcmd::manifest_state_flags(&inst.install_dir) {
            Some(4) | None => {}
            Some(f) => out.push(check(
                "manifest",
                "Interrupted update",
                "warn",
                format!("Steam reports state flags {f} – a download was interrupted. Validate the files."),
                "validate",
            )),
        }
    } else {
        out.push(check("install", "Server files", "error", "The dedicated server isn't installed in this folder yet.", "install"));
    }

    // Settings files on disk
    for (id, file, path) in [("hostfile", HOST_FILE, inst.host_path()), ("gamefile", GAME_FILE, inst.game_path())] {
        match config::read_doc(&path) {
            Ok(doc) if doc.is_empty() => out.push(check(id, file, "info", "Not created yet – the server uses its built-in defaults until the manager writes it on the next start.", "")),
            Ok(_) => out.push(check(id, file, "ok", "The file parses as valid JSON.", "")),
            Err(e) => out.push(check(id, file, "error", format!("{e} The server would fall back to defaults or refuse to start."), "config")),
        }
    }

    // Settings (validation)
    let issues = config::validate(&inst.config);
    let errors: Vec<&config::Issue> = issues.iter().filter(|i| i.level == "error").collect();
    let warns: Vec<&config::Issue> = issues.iter().filter(|i| i.level == "warn").collect();
    if !errors.is_empty() {
        out.push(check("settings", "Server settings", "error", errors.iter().map(|i| i.message.as_str()).collect::<Vec<_>>().join("\n"), "settings"));
    } else if !warns.is_empty() {
        out.push(check("settings", "Server settings", "warn", warns.iter().map(|i| i.message.as_str()).collect::<Vec<_>>().join("\n"), "settings"));
    } else {
        out.push(check("settings", "Server settings", "ok", "Everything the manager can check looks right.", ""));
    }
    if inst.config.password.is_empty() && inst.config.list_on_steam {
        out.push(check("password", "Open server", "info", "No join password – anyone who finds the server in the list can join. Set one under Server Settings for a private server.", "settings"));
    }

    // Admins
    let admins = config::read_list(&inst.admin_path());
    if admins.is_empty() {
        out.push(check("admins", "Admins", "info", "Nobody is an admin yet. Add your SteamID64 under Admins & Bans, then type `adminauth` in the in-game console.", "admins"));
    } else {
        out.push(check("admins", "Admins", "ok", format!("{} admin(s) in adminlist.txt.", admins.len()), ""));
    }

    // Ports
    let instances = state.instances.read().await.clone();
    let mut mine: Vec<u16> = inst.udp_ports();
    mine.extend(inst.tcp_ports());
    let clash: Vec<String> = instances
        .iter()
        .filter(|o| o.id != inst.id)
        .filter(|o| o.udp_ports().iter().chain(o.tcp_ports().iter()).any(|p| mine.contains(p)))
        .map(|o| o.name.clone())
        .collect();
    if !clash.is_empty() {
        out.push(check("ports", "Port conflict", "error", format!("Ports overlap with: {}. Only one of them can run at a time.", clash.join(", ")), "ports"));
    }
    let (pids, _) = super::server::running_pids(inst);
    let (udp, tcp) = tokio::join!(proc::udp_port_owners(), proc::tcp_listen_owners());
    let busy = inst
        .udp_ports()
        .into_iter()
        .filter_map(|p| udp.get(&p).filter(|o| !pids.contains(o)).map(|o| ("UDP", p, *o)))
        .chain(inst.tcp_ports().into_iter().filter_map(|p| tcp.get(&p).filter(|o| !pids.contains(o)).map(|o| ("TCP", p, *o))))
        .next();
    if let Some((proto, port, pid)) = busy {
        let mut sys = sysinfo::System::new();
        let name = proc::process_name(&mut sys, pid).unwrap_or_default();
        out.push(check("portbusy", "Port in use", "error", format!("{proto} {port} is held by {name} (PID {pid}). Pick other ports."), "ports"));
    } else if clash.is_empty() {
        out.push(check(
            "ports",
            "Ports",
            "ok",
            format!("UDP {} (game) and {} (query) are available{}.", inst.config.port, inst.config.query_port, if pids.is_empty() { "" } else { " (used by this server)" }),
            "",
        ));
    }

    // RCON
    if inst.config.rcon_enabled {
        if pids.is_empty() {
            out.push(check("rcon", "RCON", "info", format!("Enabled on TCP {} – it answers once the server runs.", inst.config.rcon_port), ""));
        } else {
            match super::server::rcon_exec(state, inst, "version").await {
                Ok(v) => out.push(check("rcon", "RCON", "ok", format!("Answering on TCP {} ({v}). Announcements and restart warnings work.", inst.config.rcon_port), "")),
                Err(e) => out.push(check("rcon", "RCON", "warn", format!("{e} RCON settings apply at the next start."), "rcon")),
            }
        }
    } else {
        out.push(check("rcon", "RCON", "info", "Off – turn it on for in-game announcements and restart warnings.", "rcon"));
    }

    // Firewall
    let fw = network::firewall_state(inst).await;
    if !fw.blocked_by.is_empty() {
        out.push(check(
            "firewall",
            "Windows Firewall is blocking the server",
            "error",
            format!("Inbound Block rule(s) “{}” exist for VRisingServer.exe – usually from dismissing Windows’ “allow access?” prompt. Block beats Allow.", fw.blocked_by.join("”, “")),
            "firewall",
        ));
    } else if fw.ports_ok || fw.program_rule {
        out.push(check("firewall", "Windows Firewall", "ok", "An inbound rule allows the server.", ""));
    } else {
        out.push(check("firewall", "Windows Firewall", "warn", "No inbound rule for this server – players outside your PC may not reach it.", "firewall"));
    }

    // Memory (measured: ~2.6 GB for an empty fresh world; grows with castles and players)
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let total_gb = sys.total_memory() as f64 / 1_073_741_824.0;
    let need = if inst.config.max_connected_users > 40 { 16.0 } else { 8.0 };
    if total_gb < need {
        out.push(check("ram", "Memory", "warn", format!("{need:.0} GB recommended for {} players; this PC has {total_gb:.1} GB.", inst.config.max_connected_users), ""));
    } else {
        out.push(check("ram", "Memory", "ok", format!("{total_gb:.1} GB installed – {need:.0} GB recommended for {} players.", inst.config.max_connected_users), ""));
    }

    // Disk
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let dir = proc::norm(&inst.install_dir);
    if let Some(d) = disks.iter().filter(|d| dir.starts_with(&proc::norm(d.mount_point()))).max_by_key(|d| d.mount_point().as_os_str().len()) {
        let free = d.available_space() as f64 / 1_073_741_824.0;
        let lvl = if free < 3.0 { "error" } else if free < 10.0 { "warn" } else { "ok" };
        out.push(check("disk", "Disk space", lvl, format!("{free:.1} GB free on {} (the server needs ~2 GB plus ~7 MB per autosave).", d.mount_point().display()), ""));
    }

    // Updates
    let (installed_b, latest_b, public_ip) = state.with_runtime(&inst.id, |r| (r.installed_build.clone(), r.latest_build.clone(), r.public_ip.clone())).await;
    if let (Some(i), Some(l)) = (&installed_b, &latest_b) {
        if i != l {
            out.push(check("update", "Server version", "warn", format!("Build {i} is installed but {l} is live – players on the new game version can't join until you update."), "update"));
        } else {
            out.push(check("update", "Server version", "ok", format!("Up to date (build {i})."), ""));
        }
    }

    // Steam master list – what the in-game server browser shows.
    if !pids.is_empty() && inst.config.list_on_steam {
        let ip = match public_ip {
            Some(ip) => Some(ip),
            None => network::public_ip(&state.http).await,
        };
        if let Some(ip) = ip {
            match network::steam_listing(&state.http, &ip).await {
                Ok(list) if list.iter().any(|s| s.gameport == inst.config.port || s.gameport == inst.config.query_port) => {
                    out.push(check("listing", "Steam server list", "ok", format!("Listed at {ip} – players can find “{}” in the server browser.", inst.config.name), ""))
                }
                Ok(_) => out.push(check(
                    "listing",
                    "Steam server list",
                    "warn",
                    format!("Steam has no V Rising server at {ip}:{} yet. It can take a minute after start; if it stays missing, check the firewall and router (Port Forwarding).", inst.config.port),
                    "ports",
                )),
                Err(e) => out.push(check("listing", "Steam server list", "info", format!("Couldn't ask Steam: {e}"), "")),
            }
        }
    } else if !inst.config.list_on_steam {
        out.push(check("listing", "Steam server list", "info", "Not listed on Steam – players join by IP (Direct Connect) and the live player count comes from the log only.", "settings"));
    }

    // Last log
    if let Ok(text) = std::fs::read_to_string(inst.log_path()) {
        let bad: Vec<&str> = text
            .lines()
            .filter(|l| l.contains("Exiting!") || l.contains("Address already in use") || l.starts_with("Error parsing ServerHostSettings") || l.contains("Unhandled exception"))
            .take(3)
            .collect();
        if !bad.is_empty() {
            out.push(check("log", "Errors in the last log", "error", bad.join("\n"), "log"));
        }
    }
    out
}
