//! Server lifecycle: launch line, config sync, start / stop / restart / update.
//!
//! Every lifecycle operation for one server runs under `AppState::op_lock(id)` so a scheduled
//! restart, a crash restart and a button click can never interleave.

use super::{backup, config, proc, rcon, steamcmd};
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::state::{manager_log, notify, notify_kind, now_ms, AppState, TaskReporter};
use std::time::Duration;
use tauri::AppHandle;

/// Split a free-form argument string, keeping "quoted values" together.
pub fn split_args(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut in_q = false;
    for c in s.chars() {
        match c {
            '"' => {
                in_q = !in_q;
                cur.push(c);
            }
            c if c.is_whitespace() && !in_q => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Command-line arguments after the exe: where the data folder and the log go (absolute, so the
/// working folder never matters), then whatever the user adds. Everything else – name, ports,
/// passwords – comes from ServerHostSettings.json (the command line is visible to every process on
/// the PC, so passwords never go there).
pub fn build_args(inst: &ServerInstance) -> Vec<String> {
    let mut v = vec![
        "-persistentDataPath".to_string(),
        format!("\"{}\"", inst.data_dir().display()),
        "-logFile".to_string(),
        format!("\"{}\"", inst.log_path().display()),
    ];
    v.extend(split_args(&inst.launch.extra_args));
    v
}

pub fn launch_line(inst: &ServerInstance) -> String {
    format!("\"{}\" {}", inst.server_exe().display(), build_args(inst).join(" "))
}

/// The server overwrites its log on every start: keep the previous one in `logs\backup` (last 20).
fn rotate_log(inst: &ServerInstance) {
    let log = inst.log_path();
    let Ok(meta) = std::fs::metadata(&log) else { return };
    if meta.len() == 0 {
        return;
    }
    let dir = inst.logs_dir().join("backup");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let stamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S");
    let _ = std::fs::rename(&log, dir.join(format!("VRisingServer_{stamp}.log")));
    if let Ok(rd) = std::fs::read_dir(&dir) {
        let mut v: Vec<_> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().map(|x| x == "log").unwrap_or(false)).collect();
        v.sort();
        let n = v.len();
        for p in v.into_iter().take(n.saturating_sub(20)) {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// PIDs of this server's running processes and the main PID.
pub fn running_pids(inst: &ServerInstance) -> (Vec<u32>, Option<u32>) {
    let mut sys = sysinfo::System::new();
    let all = proc::scan_servers(&mut sys);
    let mine = proc::procs_for_install(&all, &inst.install_dir);
    (mine.iter().map(|p| p.pid).collect(), mine.first().map(|p| p.pid))
}

/// Run an RCON command on a server. Every command uses its own connection, closed right after:
/// the server's shutdown waits for open RCON clients, so a connection kept open would make a
/// graceful stop hang after the world is saved (verified – the process only exited once killed).
pub async fn rcon_exec(state: &AppState, inst: &ServerInstance, command: &str) -> AppResult<String> {
    if !inst.config.rcon_enabled {
        return Err(AppError::msg("RCON is turned off for this server – enable it under Server Settings (it applies at the next start)."));
    }
    let mut client = rcon::RconClient::new(&rcon::local_target(inst), &inst.config.rcon_password);
    let res = client.exec(command).await.and_then(rcon::check_reply);
    drop(client);
    state.with_runtime(&inst.id, |r| r.rcon_ok = Some(res.is_ok())).await;
    res
}

/// Warn the players over RCON and wait before a disruptive action. Returns false when the
/// countdown was cancelled (Cancel in the UI clears `Runtime::countdown`).
pub async fn countdown(state: &AppState, app: &AppHandle, id: &str, action: &str, mins: u32) -> bool {
    let Ok(inst) = state.instance(id).await else { return false };
    let until = now_ms() + mins as i64 * 60_000;
    state.with_runtime(id, |r| r.countdown = Some((action.to_string(), until))).await;
    state.emit_status(app, id).await;
    let say = |m: u32| format!("announcerestart {m}");
    if let Err(e) = rcon_exec(state, &inst, &say(mins)).await {
        manager_log(app, id, format!("Couldn't warn players over RCON ({e}) – waiting anyway."));
    } else {
        manager_log(app, id, format!("Players warned: {action} in {mins} minute(s)."));
    }
    let mut last_min = mins;
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let still = state.with_runtime(id, |r| r.countdown.as_ref().map(|(_, u)| *u == until).unwrap_or(false)).await;
        if !still {
            // Cancelled in the UI – or the server stopped / crashed meanwhile (nobody to tell).
            if running_pids(&inst).1.is_some() {
                manager_log(app, id, format!("The {action} countdown was cancelled."));
                let _ = rcon_exec(state, &inst, &format!("announce The {action} was cancelled.")).await;
            } else {
                manager_log(app, id, format!("The {action} countdown ended – the server is no longer running."));
            }
            state.emit_status(app, id).await;
            return false;
        }
        let left = until - now_ms();
        if left <= 0 {
            break;
        }
        let m = ((left + 59_999) / 60_000) as u32;
        if m < last_min && (m == 1 || m == 5 || m == 10) {
            let _ = rcon_exec(state, &inst, &say(m)).await;
        }
        last_min = m;
    }
    state.with_runtime(id, |r| r.countdown = None).await;
    true
}

pub fn validate_for_start(inst: &ServerInstance) -> AppResult<Vec<String>> {
    config::ensure_valid(&inst.config)?;
    Ok(config::validate(&inst.config).into_iter().filter(|i| i.level == "warn").map(|i| i.message).collect())
}

pub async fn start(state: &AppState, app: &AppHandle, id: &str) -> AppResult<()> {
    let lock = state.op_lock(id).await;
    let _g = lock.lock().await;
    start_locked(state, app, id).await
}

async fn start_locked(state: &AppState, app: &AppHandle, id: &str) -> AppResult<()> {
    let inst = state.instance(id).await?;
    if !inst.is_installed() {
        return Err(AppError::msg("Server files are not installed yet. Click Install first."));
    }
    if let (_, Some(pid)) = running_pids(&inst) {
        state
            .with_runtime(id, |r| {
                r.pid = Some(pid);
                r.state = Some(ServerState::Running);
                r.started_at.get_or_insert(now_ms());
            })
            .await;
        state.emit_status(app, id).await;
        return Ok(());
    }
    for w in validate_for_start(&inst)? {
        manager_log(app, id, format!("Note: {w}"));
    }

    // Another program (or another server) on one of the ports.
    let (udp, tcp) = tokio::join!(proc::udp_port_owners(), proc::tcp_listen_owners());
    let busy = inst.udp_ports().into_iter().filter_map(|p| udp.get(&p).map(|pid| ("UDP", p, *pid))).chain(inst.tcp_ports().into_iter().filter_map(|p| tcp.get(&p).map(|pid| ("TCP", p, *pid)))).next();
    if let Some((proto, port, pid)) = busy {
        let mut sys = sysinfo::System::new();
        let name = proc::process_name(&mut sys, pid).unwrap_or_else(|| "another program".into());
        return Err(AppError::msg(format!("{proto} port {port} is already in use by {name} (PID {pid}). Pick different ports under Server Settings.")));
    }

    if inst.automation.update_on_start {
        state.set_busy(app, id, Some("Checking for updates")).await;
        let res = update_files(state, app, &inst, false).await;
        state.set_busy(app, id, None).await;
        if let Err(e) = res {
            notify(app, id, "warn", format!("Update before start failed, starting anyway: {e}"));
        }
    }

    config::sync(&inst)?;
    std::fs::create_dir_all(inst.saves_dir()).ok();
    std::fs::create_dir_all(inst.logs_dir()).ok();
    let args = build_args(&inst);
    let exe = inst.server_exe();
    // The server truncates its log at start: keep the old one and tail the new file from the top.
    rotate_log(&inst);
    let pid = proc::spawn_server(&exe, &args, !inst.launch.show_console, &inst.launch.priority)?;
    if !inst.launch.affinity.is_empty() {
        let _ = proc::apply_priority_affinity(pid, &inst.launch.priority, &inst.launch.affinity);
    }
    state
        .with_runtime(id, |r| {
            r.pid = Some(pid);
            r.state = Some(ServerState::Starting);
            r.started_at = Some(now_ms());
            r.ready_at = None;
            r.intentional_stop = false;
            r.pending_restart = false;
            r.restart_at = None;
            r.online.clear();
            r.query_players = None;
            r.log_offset = 0;
            r.log_partial.clear();
            r.log_sig = None;
            r.console_hidden = !inst.launch.show_console;
            r.log_ready = false;
            r.fatal = None;
            r.game_version = None;
            r.days_running = None;
            r.rcon_ok = None;
            r.players_by_endpoint.clear();
            r.steam_id = None;
            r.public_ip = None;
            r.last_exit_code = None;
            r.empty_since = None;
            r.waiting_empty = None;
        })
        .await;
    manager_log(app, id, format!("Launching {} (PID {pid}) {}", exe.file_name().unwrap_or_default().to_string_lossy(), args.join(" ")));
    state.history.event(Some(id), "info", "lifecycle", "Server starting");
    if inst.launch.upnp {
        let (app2, i2) = (app.clone(), inst.clone());
        tauri::async_runtime::spawn(async move {
            match super::upnp::map_server(&i2).await {
                Ok(lines) => manager_log(&app2, &i2.id, format!("UPnP: {}", lines.join(", "))),
                Err(e) => notify(&app2, &i2.id, "warn", format!("UPnP port forwarding failed: {e}")),
            }
        });
    }
    state.emit_status(app, id).await;
    Ok(())
}

/// Graceful stop: Ctrl+Break to the server console (it saves the world and exits – verified:
/// "SaveOnExit() - Saving the world on exit!" … "Finished saving"), then force-kill on timeout.
pub async fn stop(state: &AppState, app: &AppHandle, id: &str, force: bool) -> AppResult<()> {
    let lock = state.op_lock(id).await;
    let _g = lock.lock().await;
    stop_locked(state, app, id, force).await
}

async fn stop_locked(state: &AppState, app: &AppHandle, id: &str, force: bool) -> AppResult<()> {
    let inst = state.instance(id).await?;
    let (pids, main) = running_pids(&inst);
    let Some(main) = main else {
        state
            .with_runtime(id, |r| {
                r.pid = None;
                r.state = Some(ServerState::Stopped);
                r.restart_at = None;
                r.online.clear();
            })
            .await;
        state.emit_status(app, id).await;
        return Ok(());
    };
    state
        .with_runtime(id, |r| {
            r.intentional_stop = true;
            r.restart_at = None;
            r.state = Some(ServerState::Stopping);
            // A pending warned restart/stop must not bring the server back after this stop.
            r.countdown = None;
            r.waiting_empty = None;
        })
        .await;
    state.emit_status(app, id).await;

    let timeout = inst.automation.stop_timeout_secs.clamp(5, 900) as u64;
    let mut exited = false;
    if !force {
        manager_log(app, id, "Asking the server to save and shut down…");
        if proc::request_graceful_exit(main).await {
            let mut sys = sysinfo::System::new();
            for _ in 0..timeout * 2 {
                tokio::time::sleep(Duration::from_millis(500)).await;
                if !pids.iter().any(|p| proc::pid_alive(&mut sys, *p)) {
                    exited = true;
                    break;
                }
            }
            if !exited {
                manager_log(app, id, format!("Server did not exit within {timeout}s – forcing it to close."));
                notify(app, id, "warn", format!("{} didn't shut down within {timeout}s and was force-closed.", inst.name));
            }
        } else {
            manager_log(app, id, "Couldn't reach the server console – forcing it to close.");
        }
    }
    if !exited {
        for p in &pids {
            let _ = proc::kill_tree(*p).await;
        }
        tokio::time::sleep(Duration::from_millis(600)).await;
    }
    state
        .with_runtime(id, |r| {
            r.pid = None;
            r.state = Some(ServerState::Stopped);
            r.started_at = None;
            r.ready_at = None;
            r.online.clear();
            r.query_players = None;
            r.pending_restart = false;
            r.waiting_empty = None;
            r.rcon_ok = None;
        })
        .await;
    state.history.sessions_close_all(id, now_ms());
    manager_log(app, id, if exited { "Server saved and stopped." } else { "Server process terminated." });
    notify_kind(app, id, "info", "lifecycle", if exited { format!("{} stopped", inst.name) } else { format!("{} was force-stopped", inst.name) });
    state.emit_status(app, id).await;

    if inst.automation.backup_on_stop && inst.saves_dir().exists() {
        state.set_busy(app, id, Some("Backing up")).await;
        let res = backup::create(state, &inst, "After stop", "auto").await;
        state.set_busy(app, id, None).await;
        match res {
            Ok(b) => {
                state.with_runtime(id, |r| r.last_backup = b.created_at).await;
                let _ = tauri::Emitter::emit(app, "backup-created", &b);
            }
            Err(e) => notify(app, id, "warn", format!("Backup after stop failed: {e}")),
        }
    }
    Ok(())
}

pub async fn restart(state: &AppState, app: &AppHandle, id: &str, update: bool) -> AppResult<()> {
    let lock = state.op_lock(id).await;
    let _g = lock.lock().await;
    let inst = state.instance(id).await?;
    state
        .with_runtime(id, |r| {
            r.state = Some(ServerState::Restarting);
            r.crash_loop = false;
        })
        .await;
    state.emit_status(app, id).await;
    stop_locked(state, app, id, false).await?;
    if update {
        state.with_runtime(id, |r| r.state = Some(ServerState::Updating)).await;
        state.emit_status(app, id).await;
        let res = update_files(state, app, &inst, false).await;
        state.with_runtime(id, |r| r.state = Some(ServerState::Stopped)).await;
        if let Err(e) = res {
            notify(app, id, "error", format!("Update failed, restarting on the current build: {e}"));
        }
    }
    start_locked(state, app, id).await
}

/// SteamCMD install/update of one server's files (caller decides about stopping first).
pub async fn update_files(state: &AppState, app: &AppHandle, inst: &ServerInstance, validate: bool) -> AppResult<()> {
    let title = if !inst.is_installed() {
        format!("Installing {}", inst.name)
    } else if validate {
        format!("Validating {}", inst.name)
    } else {
        format!("Updating {}", inst.name)
    };
    let r = TaskReporter::new(app, "steamcmd", &title, Some(&inst.id));
    let cancel = state.register_cancel(&r.task_id).await;
    let steam_dir = state.steamcmd_dir().await;
    let before = steamcmd::local_build(&inst.install_dir);
    let res = {
        let _steam = state.steam_lock.lock().await;
        steamcmd::app_update(&state.http, &steam_dir, &inst.install_dir, &inst.branch, &inst.branch_password, validate, &r, cancel).await
    };
    state.cancels.lock().await.remove(&r.task_id);
    match res {
        Ok(()) => {
            let build = steamcmd::local_build(&inst.install_dir);
            state.with_runtime(&inst.id, |rt| rt.installed_build = build.clone()).await;
            if let Some(b) = &build {
                state.history.build(&inst.id, b, &inst.branch);
            }
            // Write the profile's config so settings can be edited before the first start.
            let _ = config::sync(inst);
            let b = build.clone().unwrap_or_else(|| "?".into());
            r.done(&format!("{} – build {b}", title.replace("ing ", "ed ")));
            if before.is_some() && before != build {
                state.history.event(Some(&inst.id), "success", "update", &format!("Updated to build {b}"));
            }
            Ok(())
        }
        Err(e) => {
            r.fail(&e.to_string());
            Err(e)
        }
    }
}

/// Full update job: stops the server if needed (with a backup), updates, restarts if it was up.
pub async fn update_job(state: &AppState, app: &AppHandle, id: &str, validate: bool) -> AppResult<()> {
    let lock = state.op_lock(id).await;
    let _g = lock.lock().await;
    let inst = state.instance(id).await?;
    let (_, main) = running_pids(&inst);
    let was_running = main.is_some();
    if was_running {
        manager_log(app, id, "Stopping the server to update it…");
        stop_locked(state, app, id, false).await?;
    }
    // stop_locked already backs up when "backup on stop" is on; otherwise honour "before update".
    if inst.automation.backup_before_update && !(was_running && inst.automation.backup_on_stop) && inst.saves_dir().exists() {
        if let Ok(b) = backup::create(state, &inst, "Before update", "auto").await {
            state.with_runtime(id, |r| r.last_backup = b.created_at).await;
        }
    }
    state.with_runtime(id, |r| r.state = Some(if inst.is_installed() { ServerState::Updating } else { ServerState::Installing })).await;
    state.emit_status(app, id).await;
    let res = update_files(state, app, &inst, validate).await;
    state.with_runtime(id, |r| r.state = None).await;
    state.emit_status(app, id).await;
    res?;
    if was_running {
        start_locked(state, app, id).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_point_at_data_and_log() {
        let mut inst = ServerInstance { install_dir: std::path::PathBuf::from(r"D:\vr\s1"), ..Default::default() };
        assert_eq!(
            build_args(&inst),
            vec!["-persistentDataPath", "\"D:\\vr\\s1\\save-data\"", "-logFile", "\"D:\\vr\\s1\\logs\\VRisingServer.log\""]
        );
        inst.launch.extra_args = "-foo \"bar baz\"".into();
        assert_eq!(build_args(&inst)[4..], ["-foo".to_string(), "\"bar baz\"".to_string()]);
        assert!(launch_line(&inst).starts_with("\"D:\\vr\\s1\\VRisingServer.exe\" -persistentDataPath"));
    }

    #[test]
    fn log_rotation_keeps_previous_session() {
        let dir = std::env::temp_dir().join(format!("vrsm-log-{}", uuid::Uuid::new_v4()));
        let inst = ServerInstance { install_dir: dir.clone(), ..Default::default() };
        std::fs::create_dir_all(inst.logs_dir()).unwrap();
        std::fs::write(inst.log_path(), "old session").unwrap();
        rotate_log(&inst);
        assert!(!inst.log_path().exists());
        assert_eq!(std::fs::read_dir(inst.logs_dir().join("backup")).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }
}
