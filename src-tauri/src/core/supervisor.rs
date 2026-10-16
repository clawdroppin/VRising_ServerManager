//! The single background loop: process tracking (incl. servers started outside the manager),
//! state transitions, crash detection & auto-restart, telemetry (live + per-minute history), log
//! tail + player detection, A2S polling, schedules, interval backups, update checks, idle stop and
//! resource-limit restarts.

use super::{a2s, backup, server, steamcmd};
use crate::core::history::MetricRow;
use crate::models::*;
use crate::state::{manager_log, notify, notify_kind, now_ms, AppState, TaskReporter};
use chrono::{Datelike, Local, NaiveTime, TimeZone, Timelike};
use regex::Regex;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};
use sysinfo::{Networks, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Emitter, Manager};

// Log lines, verified against VRisingServer.exe v1.1.15.0 (Steam build 25169871) – see the tests.
static READY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[Server\] Startup Completed").unwrap());
static VERSION_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Bootstrap - Boot Time: .*?Version: VRisingServer v(\S+)").unwrap());
static STEAMID_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Successfully logged in with the SteamGameServer API\. SteamID: (\d+)").unwrap());
static PUBLIC_IP_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"OnPolicyResponse - Public IP: ([0-9.]+)").unwrap());
static SAVED_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"PersistenceV2 - Finished Saving to '([^']+)'").unwrap());
static SHUTDOWN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"GameBootstrap\.OnApplicationQuit\(\)").unwrap());
static LISTS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[FileUserList\] Content:").unwrap());
// Player lines from the server's format strings (global-metadata.dat): "User '{0}' '{1}',
// approvedUserIndex: {2}, Character: '{3}' connected as ID '{4},{5}', Entity '{6},{7}'." and
// "User '{0}' disconnected. approvedUserIndex: {1} Reason: {2} {3}" – {0} is the network endpoint
// (`{Steam 7656…}`), {1} the SteamID64. Not yet seen with a real client.
static JOIN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"User '(.+?)' '(\d*)', approvedUserIndex: \d+, Character: '(.*?)' connected as ID").unwrap());
static LEAVE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"User '(.+?)' disconnected\. approvedUserIndex: \d+ Reason: (.*?)\s*$").unwrap());
// Start-up failures, from the binary's strings.
static FATAL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(No SaveName, or invalid SaveName! Exiting!|Error parsing ServerHostSettings.*|.*Address already in use.*)$").unwrap());
static ENDPOINT_ID_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(7656\d{13})").unwrap());

const CRASH_WINDOW_MS: i64 = 15 * 60 * 1000;
const MAX_LINES_PER_TICK: usize = 400;
const QUERY_EVERY_MS: i64 = 10_000;
/// Longest an automatic restart/update waits for players to leave.
const WAIT_EMPTY_MAX_MS: i64 = 60 * 60_000;

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state: Arc<AppState> = app.state::<Arc<AppState>>().inner().clone();
        let mut sup = Supervisor::new();
        sup.boot(&state, &app).await;
        loop {
            let interval = state.settings.read().await.telemetry_interval_ms.clamp(500, 5000);
            let t0 = Instant::now();
            sup.tick(&state, &app).await;
            let spent = t0.elapsed();
            tokio::time::sleep(Duration::from_millis(interval).saturating_sub(spent)).await;
        }
    });
}

/// Samples of one server collected over the current minute (written to manager.db).
#[derive(Default)]
struct MinuteAcc {
    minute: i64,
    n: u32,
    cpu: f64,
    mem: u64,
    read: u64,
    write: u64,
    players: u32,
}

struct Supervisor {
    sys: System,
    nets: Networks,
    last_tick: Instant,
    last_status: HashMap<String, String>,
    over_mem: HashMap<String, u32>,
    hide_until: HashMap<String, i64>,
    /// When a memory/uptime restart was last triggered, per server.
    limit_restart: HashMap<String, i64>,
    /// Ticks since the last full process-list scan.
    since_scan: u32,
    tracked: Vec<sysinfo::Pid>,
    minutes: HashMap<String, MinuteAcc>,
    last_prune: i64,
}

impl Supervisor {
    fn new() -> Self {
        Self {
            sys: System::new(),
            nets: Networks::new_with_refreshed_list(),
            last_tick: Instant::now(),
            last_status: HashMap::new(),
            over_mem: HashMap::new(),
            hide_until: HashMap::new(),
            limit_restart: HashMap::new(),
            since_scan: u32::MAX,
            tracked: vec![],
            minutes: HashMap::new(),
            last_prune: now_ms(),
        }
    }

    async fn boot(&mut self, state: &Arc<AppState>, app: &AppHandle) {
        let instances = state.instances.read().await.clone();
        let check_updates = state.settings.read().await.check_updates_on_launch;
        for inst in &instances {
            let build = steamcmd::local_build(&inst.install_dir);
            let last_bk = backup::list(&state.backup_dir(inst).await).first().map(|b| b.created_at).unwrap_or(0);
            state.history.sessions_close_all(&inst.id, now_ms());
            state
                .with_runtime(&inst.id, |r| {
                    r.installed_build = build;
                    r.last_backup = last_bk;
                    // 0 = check soon after launch; otherwise wait a full interval.
                    r.last_update_check = if check_updates { 0 } else { now_ms() };
                })
                .await;
        }
        // Prime CPU counters so the first sample isn't zero.
        self.sys.refresh_cpu_usage();
        self.refresh_procs();
        tokio::time::sleep(Duration::from_millis(300)).await;
        // Auto-start servers that aren't already running (adopted ones are picked up by tick()).
        for inst in instances.into_iter().filter(|i| i.automation.auto_start && i.is_installed()) {
            let (_, main) = server::running_pids(&inst);
            if main.is_none() {
                let (st, app2) = (state.clone(), app.clone());
                tauri::async_runtime::spawn(async move {
                    manager_log(&app2, &inst.id, "Auto-starting with the manager…");
                    if let Err(e) = server::start(&st, &app2, &inst.id).await {
                        notify(&app2, &inst.id, "error", format!("Auto-start of {} failed: {e}", inst.name));
                    }
                });
            }
        }
    }

    /// Full process discovery (names + exe paths) every 3 ticks; CPU/memory/disk only for the
    /// server processes. Sampling every process on the PC each second would be the main cost.
    fn refresh_procs(&mut self) {
        if self.since_scan >= 3 {
            self.sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet));
            self.tracked = self
                .sys
                .processes()
                .iter()
                .filter(|(_, p)| super::proc::is_server_name(&p.name().to_string_lossy()))
                .map(|(pid, _)| *pid)
                .collect();
            self.since_scan = 0;
        }
        self.since_scan += 1;
        if !self.tracked.is_empty() {
            let pids = self.tracked.clone();
            self.sys.refresh_processes_specifics(
                ProcessesToUpdate::Some(&pids),
                true,
                ProcessRefreshKind::nothing().with_cpu().with_memory().with_disk_usage().with_exe(UpdateKind::OnlyIfNotSet),
            );
            self.tracked.retain(|p| self.sys.process(*p).is_some());
        }
    }

    async fn tick(&mut self, state: &Arc<AppState>, app: &AppHandle) {
        let elapsed = self.last_tick.elapsed().as_secs_f64().max(0.2);
        self.last_tick = Instant::now();
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        self.refresh_procs();
        self.nets.refresh(true);
        let cores = self.sys.cpus().len().max(1);
        let (rx, tx) = self.nets.iter().fold((0u64, 0u64), |(r, t), (_, d)| (r + d.received(), t + d.transmitted()));
        let system = SystemSample {
            cpu: self.sys.global_cpu_usage(),
            mem_used: self.sys.used_memory(),
            mem_total: self.sys.total_memory(),
            rx_bps: (rx as f64 / elapsed) as u64,
            tx_bps: (tx as f64 / elapsed) as u64,
            cores,
            per_core: self.sys.cpus().iter().map(|c| c.cpu_usage()).collect(),
        };

        let procs: Vec<(u32, String)> = self
            .tracked
            .iter()
            .filter_map(|pid| self.sys.process(*pid).and_then(|p| p.exe()).map(|e| (pid.as_u32(), super::proc::norm(e))))
            .collect();

        let now = now_ms();
        let any_starting = state.runtime.lock().await.values().any(|r| r.state == Some(ServerState::Starting));
        if any_starting {
            self.since_scan = u32::MAX;
        }

        let instances = state.instances.read().await.clone();
        let mut samples = vec![];
        for inst in &instances {
            let base = format!("{}\\", super::proc::norm(&inst.install_dir));
            let pids: Vec<u32> = procs.iter().filter(|(_, e)| e.starts_with(&base)).map(|(p, _)| *p).collect();
            let main = pids.first().copied();

            // Telemetry (sum of the server's processes).
            if !pids.is_empty() {
                let mut s = ProcSample { id: inst.id.clone(), ..Default::default() };
                for pid in &pids {
                    if let Some(p) = self.sys.process(sysinfo::Pid::from_u32(*pid)) {
                        s.cpu += p.cpu_usage() / cores as f32;
                        s.mem += p.memory();
                        s.virt += p.virtual_memory();
                        let du = p.disk_usage();
                        s.read_bps += (du.read_bytes as f64 / elapsed) as u64;
                        s.write_bps += (du.written_bytes as f64 / elapsed) as u64;
                        s.uptime = s.uptime.max(p.run_time());
                    }
                }
                self.resource_limits(state, app, inst, &s).await;
                let players = state.with_runtime(&inst.id, |r| r.query_players.unwrap_or(r.online.len() as u32)).await;
                self.accumulate(state, &inst.id, &s, players, now);
                samples.push(s);
            } else {
                self.over_mem.remove(&inst.id);
                self.flush_minute(state, &inst.id);
            }

            // Tail first: when the process just died, its last log lines say why.
            self.tail_log(state, app, inst).await;
            self.lifecycle(state, app, inst, main, now).await;
            self.query(state, app, inst, now).await;
            self.hide_console(state, inst, &pids, now).await;
            self.automation(state, app, inst, main.is_some(), now).await;

            let st = state.status(inst).await;
            let key = serde_json::to_string(&st).unwrap_or_default();
            if self.last_status.get(&inst.id) != Some(&key) {
                self.last_status.insert(inst.id.clone(), key);
                let _ = app.emit("server-status", st);
            }
        }
        let _ = app.emit("telemetry", TelemetryEvent { ts: now, system, servers: samples });
        if now - self.last_prune > 6 * 3_600_000 {
            self.last_prune = now;
            let days = state.settings.read().await.metrics_retention_days;
            state.history.prune(days);
        }
    }

    /// Average one minute of samples into a manager.db row.
    fn accumulate(&mut self, state: &AppState, id: &str, s: &ProcSample, players: u32, now: i64) {
        let minute = now / 60_000;
        let acc = self.minutes.entry(id.to_string()).or_default();
        if acc.minute != minute && acc.n > 0 {
            let n = acc.n.max(1) as f64;
            state.history.metric(
                id,
                &MetricRow {
                    ts: acc.minute * 60_000,
                    cpu: acc.cpu / n,
                    mem: acc.mem as i64,
                    read_bps: (acc.read as f64 / n) as i64,
                    write_bps: (acc.write as f64 / n) as i64,
                    players: acc.players as i64,
                },
            );
            *acc = MinuteAcc::default();
        }
        acc.minute = minute;
        acc.n += 1;
        acc.cpu += s.cpu as f64;
        acc.mem = acc.mem.max(s.mem);
        acc.read += s.read_bps;
        acc.write += s.write_bps;
        acc.players = acc.players.max(players);
    }

    fn flush_minute(&mut self, state: &AppState, id: &str) {
        if let Some(acc) = self.minutes.remove(id) {
            if acc.n > 0 {
                let n = acc.n as f64;
                state.history.metric(
                    id,
                    &MetricRow { ts: acc.minute * 60_000, cpu: acc.cpu / n, mem: acc.mem as i64, read_bps: (acc.read as f64 / n) as i64, write_bps: (acc.write as f64 / n) as i64, players: acc.players as i64 },
                );
            }
        }
    }

    async fn lifecycle(&mut self, state: &Arc<AppState>, app: &AppHandle, inst: &ServerInstance, main: Option<u32>, now: i64) {
        // A lifecycle operation is running – it owns the state.
        let lock = state.op_lock(&inst.id).await;
        let Ok(_guard) = lock.try_lock() else { return };
        let alive = main.is_some();
        let start_time = main.and_then(|p| self.sys.process(sysinfo::Pid::from_u32(p))).map(|p| p.start_time() as i64 * 1000);

        enum Ev {
            None,
            Adopted,
            Ready,
            Crashed { restart_in: Option<u32>, looped: bool, fatal: Option<String> },
            Stopped,
        }
        let ev = state
            .with_runtime(&inst.id, |r| {
                let cur = r.state.unwrap_or(ServerState::Stopped);
                match (alive, cur) {
                    (true, ServerState::Starting) => {
                        r.pid = main;
                        let slow = r.started_at.map(|t| now - t > 300_000).unwrap_or(false);
                        if r.log_ready || r.query_players.is_some() || slow {
                            r.state = Some(ServerState::Running);
                            r.ready_at = Some(now);
                            return Ev::Ready;
                        }
                        Ev::None
                    }
                    (true, ServerState::Running) => {
                        r.pid = main;
                        Ev::None
                    }
                    (true, _) => {
                        // Started outside the manager or the manager was restarted: adopt it.
                        r.pid = main;
                        r.state = Some(ServerState::Running);
                        r.started_at = start_time.or(Some(now));
                        r.ready_at = Some(now);
                        r.intentional_stop = false;
                        r.restart_at = None;
                        r.log_offset = std::fs::metadata(inst.log_path()).map(|m| m.len()).unwrap_or(0);
                        r.log_sig = log_signature(&inst.log_path());
                        r.log_partial.clear();
                        Ev::Adopted
                    }
                    // Just launched: this tick's process scan may predate the spawn.
                    (false, ServerState::Starting) if r.started_at.map(|t| now - t < 10_000).unwrap_or(false) => Ev::None,
                    (false, ServerState::Starting | ServerState::Running | ServerState::Stopping) => {
                        r.pid = None;
                        r.started_at = None;
                        r.ready_at = None;
                        r.online.clear();
                        r.query_players = None;
                        r.waiting_empty = None;
                        if r.intentional_stop || cur == ServerState::Stopping {
                            r.state = Some(ServerState::Stopped);
                            return Ev::Stopped;
                        }
                        r.state = Some(ServerState::Crashed);
                        r.crash_times.retain(|t| now - t < CRASH_WINDOW_MS);
                        r.crash_times.push(now);
                        // A startup config error repeats on every restart – stop right away.
                        let looped = r.fatal.is_some() || (inst.automation.crash_limit > 0 && r.crash_times.len() as u32 > inst.automation.crash_limit);
                        r.crash_loop = looped;
                        let restart_in = (inst.automation.auto_restart && !looped).then_some(inst.automation.restart_delay_secs);
                        if let Some(d) = restart_in {
                            r.restart_at = Some(now + d as i64 * 1000);
                        }
                        Ev::Crashed { restart_in, looped, fatal: r.fatal.clone() }
                    }
                    _ => Ev::None,
                }
            })
            .await;
        match &ev {
            Ev::Adopted => {
                manager_log(app, &inst.id, format!("Found the server already running (PID {}) – now monitoring it.", main.unwrap_or(0)));
                // Recover version and Steam info from the log written so far (not re-streamed).
                let meta = scan_log_meta(&inst.log_path());
                state
                    .with_runtime(&inst.id, |r| {
                        r.game_version = meta.version;
                        r.steam_id = meta.steam_id;
                        r.public_ip = meta.public_ip;
                        r.log_ready = meta.ready;
                        r.last_save = meta.saved.then_some(now);
                        r.players_by_endpoint = meta.online.iter().map(|p| (p.endpoint.clone(), p.key())).collect();
                        r.online = meta.online.into_iter().map(|p| (p.key(), OnlinePlayer { name: p.name, since: now, steam_id: p.steam_id })).collect();
                    })
                    .await;
            }
            Ev::Ready => {
                manager_log(app, &inst.id, format!("Server is online – game port UDP {}, query port UDP {}.", inst.config.port, inst.config.query_port));
                notify_kind(app, &inst.id, "success", "lifecycle", format!("{} is online", inst.name));
            }
            Ev::Crashed { restart_in, looped, fatal } => {
                state.history.sessions_close_all(&inst.id, now);
                let msg = match (*restart_in, *looped) {
                    (_, true) if fatal.is_some() => format!("{} couldn't start ({}) – fix it, then start again.", inst.name, fatal.clone().unwrap_or_default()),
                    (_, true) => format!("{} keeps crashing – auto-restart paused. Check the console and Network & Health.", inst.name),
                    (Some(d), _) => format!("{} stopped unexpectedly – restarting in {d}s", inst.name),
                    (None, _) => format!("{} stopped unexpectedly", inst.name),
                };
                manager_log(app, &inst.id, &msg);
                notify_kind(app, &inst.id, "error", "crash", msg);
            }
            Ev::Stopped => {
                state.history.sessions_close_all(&inst.id, now);
            }
            Ev::None => {}
        }
        if matches!(ev, Ev::Crashed { .. } | Ev::Stopped) {
            state.with_runtime(&inst.id, |r| {
                r.countdown = None;
                r.rcon_ok = None;
            })
            .await;
        }

        // Pending crash restart.
        let due = state
            .with_runtime(&inst.id, |r| match r.restart_at {
                Some(t) if t <= now && !alive => {
                    r.restart_at = None;
                    true
                }
                _ => false,
            })
            .await;
        if due {
            let (st, app2, id) = (state.clone(), app.clone(), inst.id.clone());
            tauri::async_runtime::spawn(async move {
                manager_log(&app2, &id, "Auto-restarting after crash…");
                if let Err(e) = server::start(&st, &app2, &id).await {
                    notify(&app2, &id, "error", format!("Auto-restart failed: {e}"));
                }
            });
        }
    }

    async fn hide_console(&mut self, state: &Arc<AppState>, inst: &ServerInstance, pids: &[u32], now: i64) {
        if inst.launch.show_console || pids.is_empty() {
            self.hide_until.remove(&inst.id);
            return;
        }
        // Keep the console hidden for the first minute in case a console host ignores the
        // start-up show state.
        let started = state.with_runtime(&inst.id, |r| r.started_at.unwrap_or(0)).await;
        let until = *self.hide_until.entry(inst.id.clone()).or_insert(started.max(now - 1) + 60_000);
        if now < until {
            let hidden_now = state.with_runtime(&inst.id, |r| r.console_hidden).await;
            if hidden_now {
                super::proc::set_console_visible(pids, false);
            }
        }
    }

    async fn resource_limits(&mut self, state: &Arc<AppState>, app: &AppHandle, inst: &ServerInstance, s: &ProcSample) {
        let a = &inst.automation;
        let running = state.with_runtime(&inst.id, |r| r.state == Some(ServerState::Running)).await;
        if !running {
            return;
        }
        let mut reason = None;
        if a.memory_limit_mb > 0 && s.mem > a.memory_limit_mb as u64 * 1_048_576 {
            let n = self.over_mem.entry(inst.id.clone()).or_insert(0);
            *n += 1;
            if *n >= 30 {
                reason = Some(format!("memory above {} MB for 30 samples", a.memory_limit_mb));
            }
        } else {
            self.over_mem.remove(&inst.id);
        }
        if a.max_uptime_hours > 0 && s.uptime >= a.max_uptime_hours as u64 * 3600 {
            reason = Some(format!("uptime reached {} h", a.max_uptime_hours));
        }
        if let Some(why) = reason {
            self.over_mem.remove(&inst.id);
            // One trigger per 15 minutes: the restart (and its player warning) takes a while, and
            // the uptime stays above the limit until the new process is up.
            let now = now_ms();
            if self.limit_restart.get(&inst.id).is_some_and(|t| now - t < 15 * 60_000) {
                return;
            }
            self.limit_restart.insert(inst.id.clone(), now);
            notify(app, &inst.id, "warn", format!("Restarting {}: {why}", inst.name));
            manager_log(app, &inst.id, format!("Automatic restart: {why}"));
            run_action(state, app, &inst.id, "restart", "Automatic");
        }
    }

    async fn tail_log(&mut self, state: &Arc<AppState>, app: &AppHandle, inst: &ServerInstance) {
        let live = state.with_runtime(&inst.id, |r| r.state.map(|s| s.is_live()).unwrap_or(false)).await;
        if !live {
            return;
        }
        let path = inst.log_path();
        let Ok(meta) = std::fs::metadata(&path) else { return };
        let len = meta.len();
        // A new session's log (the server truncates it at start) – start at its top.
        let sig = log_signature(&path);
        let offset = state
            .with_runtime(&inst.id, |r| {
                if len < r.log_offset {
                    // Shorter than what we read: a fresh file whose header isn't written yet.
                    r.log_offset = 0;
                    r.log_partial.clear();
                    r.log_sig = None;
                }
                if sig.is_some() && r.log_sig != sig {
                    // Already reading this file from the top when the signature first shows up.
                    if r.log_sig.is_some() {
                        r.log_offset = 0;
                        r.log_partial.clear();
                    }
                    r.log_sig = sig.clone();
                }
                r.log_offset
            })
            .await;
        let start = if len < offset { 0 } else { offset };
        if len == start {
            return;
        }
        // Cap one read at 2 MB so a huge backlog can't stall the loop.
        let start = start.max(len.saturating_sub(2 * 1_048_576));
        let mut buf = vec![];
        let ok = std::fs::File::open(&path)
            .and_then(|mut f| {
                f.seek(SeekFrom::Start(start))?;
                f.take(len - start).read_to_end(&mut buf)
            })
            .is_ok();
        if !ok {
            return;
        }
        let text = String::from_utf8_lossy(&buf).into_owned();
        let now = now_ms();
        // (join|leave, display name, steam id)
        let mut events: Vec<(&str, String, Option<String>)> = vec![];
        let mut lists_reloaded = false;
        let mut fatal = None;
        let mut ready = false;
        let lines = state
            .with_runtime(&inst.id, |r| {
                r.log_offset = len;
                let mut all = std::mem::take(&mut r.log_partial);
                all.push_str(&text);
                let mut lines: Vec<String> = all.split('\n').map(|l| l.trim_end_matches('\r').to_string()).collect();
                r.log_partial = lines.pop().unwrap_or_default();
                for l in &lines {
                    match parse_line(l) {
                        Some(Line::Version(v)) => r.game_version = Some(v),
                        Some(Line::SteamId(v)) => r.steam_id = Some(v),
                        Some(Line::PublicIp(v)) => r.public_ip = Some(v),
                        Some(Line::Ready) => {
                            r.log_ready = true;
                            ready = true;
                        }
                        Some(Line::Saved) => r.last_save = Some(now),
                        Some(Line::Join(p)) => {
                            let key = p.key();
                            r.players_by_endpoint.insert(p.endpoint.clone(), key.clone());
                            // Already listed from the Steam query (by name, without a SteamID).
                            let from_query = r.online.iter().find(|(k, o)| **k != key && o.steam_id.is_none() && !p.name.is_empty() && o.name == p.name).map(|(k, _)| k.clone());
                            let fresh = !r.online.contains_key(&key) && from_query.is_none();
                            if let Some(k) = from_query {
                                r.online.remove(&k);
                            }
                            let display = p.display();
                            r.online.insert(key, OnlinePlayer { name: p.name.clone(), since: r.online.get(&p.key()).map(|o| o.since).unwrap_or(now), steam_id: p.steam_id.clone() });
                            if fresh {
                                events.push(("join", display, p.steam_id));
                            }
                        }
                        Some(Line::Leave(endpoint)) => {
                            let key = r.players_by_endpoint.remove(&endpoint).or_else(|| ENDPOINT_ID_RE.captures(&endpoint).map(|c| c[1].to_string()));
                            if let Some(gone) = key.and_then(|k| r.online.remove(&k)) {
                                let display = if gone.name.is_empty() { gone.steam_id.clone().unwrap_or_default() } else { gone.name.clone() };
                                events.push(("leave", display, gone.steam_id));
                            }
                        }
                        Some(Line::Shutdown) => {
                            // A quit the manager didn't ask for (Ctrl+C in a visible console,
                            // RCON `shutdown`): the server saves and exits cleanly – not a crash.
                            r.intentional_stop = true;
                        }
                        Some(Line::ListsReloaded) => lists_reloaded = true,
                        Some(Line::Fatal(m)) => {
                            if !r.log_ready {
                                r.fatal = Some(m.clone());
                            }
                            if fatal.is_none() {
                                fatal = Some(m);
                            }
                        }
                        None => {}
                    }
                }
                lines
            })
            .await;
        if lines.is_empty() {
            return;
        }
        let shown: Vec<String> = if lines.len() > MAX_LINES_PER_TICK {
            let mut v = vec![format!("… {} earlier lines skipped (open the log file for everything)", lines.len() - MAX_LINES_PER_TICK)];
            v.extend(lines[lines.len() - MAX_LINES_PER_TICK..].iter().cloned());
            v
        } else {
            lines
        };
        let _ = app.emit("log-lines", LogBatch { id: inst.id.clone(), source: "server".into(), lines: shown, ts: now });
        for (kind, name, steam_id) in events {
            if kind == "join" {
                state.history.session_start(&inst.id, &name, steam_id.as_deref(), now);
            } else {
                state.history.session_end(&inst.id, &name, steam_id.as_deref(), now);
            }
            let _ = app.emit("player-event", PlayerEvent { id: inst.id.clone(), name: name.clone(), kind: kind.into(), ts: now });
            notify_kind(app, &inst.id, "info", "player", format!("{name} {} {}", if kind == "join" { "joined" } else { "left" }, inst.name));
        }
        if let Some(m) = fatal {
            notify_kind(app, &inst.id, "error", "crash", format!("Server error: {m}"));
        }
        if ready {
            let _ = app.emit("server-ready", &inst.id);
        }
        if lists_reloaded {
            let _ = app.emit("access-changed", &inst.id);
        }
    }

    /// A2S every 10 s while the server is listed on Steam (it doesn't answer otherwise – verified):
    /// the player count the server itself reports, the world's age, and names to reconcile the
    /// log-based list with (players who joined before the manager opened).
    async fn query(&mut self, state: &Arc<AppState>, app: &AppHandle, inst: &ServerInstance, now: i64) {
        let due = state
            .with_runtime(&inst.id, |r| {
                let live = matches!(r.state, Some(ServerState::Running) | Some(ServerState::Starting));
                let due = live && inst.config.list_on_steam && now - r.last_query >= QUERY_EVERY_MS;
                if due {
                    r.last_query = now;
                }
                due
            })
            .await;
        if !due {
            return;
        }
        let addr = a2s::local_addr(&inst.config.address, inst.config.query_port);
        let Some(info) = a2s::info(addr, Duration::from_millis(1500)).await else { return };
        let names = if info.players > 0 { a2s::players(addr, Duration::from_millis(1500)).await } else { Some(vec![]) };
        let days = a2s::rules(addr, Duration::from_millis(1500)).await.and_then(|r| r.get("days-runningv2").and_then(|d| d.parse::<u32>().ok()));
        let mut joined = vec![];
        let mut left: Vec<(String, Option<String>)> = vec![];
        let mut named: Vec<(String, String)> = vec![];
        state
            .with_runtime(&inst.id, |r| {
                r.query_players = Some(info.players);
                if days.is_some() {
                    r.days_running = days;
                }
                // Only trust A2S names when every slot has one; the log knows Steam ids, A2S only
                // character names, so players are matched by name.
                if let Some(list) = names.filter(|l| l.len() as u32 == info.players && l.iter().all(|p| !p.name.is_empty())) {
                    for p in &list {
                        if r.online.values().any(|o| o.name == p.name) {
                            continue;
                        }
                        // Someone who joined before creating a character has a name now.
                        if let Some(o) = r.online.values_mut().find(|o| o.name.is_empty()) {
                            o.name = p.name.clone();
                            if let Some(sid) = &o.steam_id {
                                named.push((sid.clone(), p.name.clone()));
                            }
                            continue;
                        }
                        let since = now - (p.duration_secs.max(0.0) * 1000.0) as i64;
                        r.online.insert(p.name.clone(), OnlinePlayer { name: p.name.clone(), since, steam_id: None });
                        joined.push(p.name.clone());
                    }
                    // Brand-new characters can be nameless in the log – don't drop those.
                    let gone: Vec<String> = r.online.iter().filter(|(_, o)| !o.name.is_empty() && !list.iter().any(|p| p.name == o.name)).map(|(k, _)| k.clone()).collect();
                    for k in gone {
                        if let Some(o) = r.online.remove(&k) {
                            r.players_by_endpoint.retain(|_, v| v != &k);
                            left.push((o.name, o.steam_id));
                        }
                    }
                } else if info.players == 0 && !r.online.is_empty() {
                    left.extend(std::mem::take(&mut r.online).into_values().map(|o| (if o.name.is_empty() { o.steam_id.clone().unwrap_or_default() } else { o.name }, o.steam_id)));
                    r.players_by_endpoint.clear();
                }
            })
            .await;
        for n in joined {
            state.history.session_start(&inst.id, &n, None, now);
            let _ = app.emit("player-event", PlayerEvent { id: inst.id.clone(), name: n, kind: "join".into(), ts: now });
        }
        for (sid, n) in named {
            state.history.session_rename(&inst.id, &sid, &n);
        }
        for (n, sid) in left {
            state.history.session_end(&inst.id, &n, sid.as_deref(), now);
            let _ = app.emit("player-event", PlayerEvent { id: inst.id.clone(), name: n, kind: "leave".into(), ts: now });
        }
    }

    async fn automation(&mut self, state: &Arc<AppState>, app: &AppHandle, inst: &ServerInstance, alive: bool, now: i64) {
        let a = &inst.automation;
        let local = Local::now();
        let online = state.with_runtime(&inst.id, |r| r.query_players.unwrap_or(r.online.len() as u32)).await;

        // Timed announcements over RCON while someone is online.
        if alive && online > 0 && inst.config.rcon_enabled && !a.announcements.is_empty() {
            let due: Vec<String> = state
                .with_runtime(&inst.id, |r| {
                    if r.state != Some(ServerState::Running) {
                        return vec![];
                    }
                    let mut v = vec![];
                    for (i, an) in a.announcements.iter().enumerate().filter(|(_, an)| an.enabled && an.every_mins > 0 && !an.message.trim().is_empty()) {
                        let last = *r.last_announce.entry(i).or_insert(now);
                        if now - last >= an.every_mins as i64 * 60_000 {
                            r.last_announce.insert(i, now);
                            v.push(an.message.clone());
                        }
                    }
                    v
                })
                .await;
            for msg in due {
                let (st, app2, id) = (state.clone(), app.clone(), inst.id.clone());
                tauri::async_runtime::spawn(async move {
                    if let Ok(i) = st.instance(&id).await {
                        match server::rcon_exec(&st, &i, &format!("announce {}", super::rcon::clean_message(&msg))).await {
                            Ok(_) => manager_log(&app2, &id, format!("Announced: {msg}")),
                            Err(e) => manager_log(&app2, &id, format!("Announcement failed: {e}")),
                        }
                    }
                });
            }
        }

        // Schedules: fire on the matching minute, compute the next one for the UI.
        let mut next: Option<NextSchedule> = None;
        let mut fire = vec![];
        for (idx, e) in a.schedules.iter().enumerate().filter(|(_, e)| e.enabled) {
            let Ok(t) = NaiveTime::parse_from_str(e.time.trim(), "%H:%M") else { continue };
            let day_ok = |wd: u32| e.days.is_empty() || e.days.contains(&(wd as u8));
            if day_ok(local.weekday().num_days_from_sunday()) && local.hour() == t.hour() && local.minute() == t.minute() {
                let key = format!("{}-{idx}-{}-{}", local.format("%Y%m%d"), e.time, e.action);
                let fresh = state.with_runtime(&inst.id, |r| r.fired_schedule_keys.insert(key)).await;
                if fresh {
                    fire.push(e.action.clone());
                }
            }
            for d in 0..8 {
                let date = local.date_naive() + chrono::Days::new(d);
                let Some(dt) = Local.from_local_datetime(&date.and_time(t)).single() else { continue };
                if dt <= local || !day_ok(dt.weekday().num_days_from_sunday()) {
                    continue;
                }
                let at = dt.timestamp_millis();
                if next.as_ref().map(|n| at < n.at).unwrap_or(true) {
                    next = Some(NextSchedule { at, action: e.action.clone() });
                }
                break;
            }
        }
        state
            .with_runtime(&inst.id, |r| {
                r.next_schedule = next;
                if r.fired_schedule_keys.len() > 200 {
                    r.fired_schedule_keys.clear();
                }
            })
            .await;
        for action in fire {
            // Disruptive actions wait for an empty server when asked to.
            if alive && online > 0 && a.wait_for_empty && matches!(action.as_str(), "restart" | "update" | "stop") {
                state.with_runtime(&inst.id, |r| r.waiting_empty = Some((action.clone(), now))).await;
                manager_log(app, &inst.id, format!("Scheduled {action} is waiting for {online} player(s) to leave (at most 60 minutes)."));
                continue;
            }
            manager_log(app, &inst.id, format!("Scheduled {action}"));
            run_action(state, app, &inst.id, &action, "Scheduled");
        }

        // A deferred action whose wait is over.
        let waiting = state
            .with_runtime(&inst.id, |r| match &r.waiting_empty {
                // The server went down meanwhile: only an update still makes sense.
                Some((act, _)) if !alive => {
                    let act = (act == "update").then(|| act.clone());
                    r.waiting_empty = None;
                    act
                }
                Some((act, since)) if online == 0 || now - since > WAIT_EMPTY_MAX_MS => {
                    let act = act.clone();
                    r.waiting_empty = None;
                    Some(act)
                }
                _ => None,
            })
            .await;
        if let Some(action) = waiting {
            manager_log(app, &inst.id, format!("Running the deferred {action} now."));
            run_action(state, app, &inst.id, &action, "Deferred");
        }

        // Interval backups while running.
        if alive && a.backup_interval_mins > 0 {
            let due = state
                .with_runtime(&inst.id, |r| {
                    if r.last_backup == 0 {
                        r.last_backup = now;
                    }
                    let due = r.state == Some(ServerState::Running) && r.busy.is_none() && now - r.last_backup >= a.backup_interval_mins as i64 * 60_000;
                    if due {
                        r.last_backup = now; // claim it so the next tick doesn't double-fire
                    }
                    due
                })
                .await;
            if due {
                let (st, app2, id) = (state.clone(), app.clone(), inst.id.clone());
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = run_backup(&st, &app2, &id, "Interval", "auto").await {
                        notify(&app2, &id, "warn", format!("Automatic backup failed: {e}"));
                    }
                });
            }
        }

        // Idle stop.
        if alive && a.idle_stop_mins > 0 {
            let stop = state
                .with_runtime(&inst.id, |r| {
                    if r.state != Some(ServerState::Running) || online > 0 {
                        r.empty_since = None;
                        return false;
                    }
                    let since = *r.empty_since.get_or_insert(now);
                    if now - since >= a.idle_stop_mins as i64 * 60_000 {
                        r.empty_since = None;
                        return true;
                    }
                    false
                })
                .await;
            if stop {
                notify_kind(app, &inst.id, "info", "lifecycle", format!("{} was empty for {} minutes – stopping it", inst.name, a.idle_stop_mins));
                run_action(state, app, &inst.id, "stop", "Idle");
            }
        }

        // Update checks.
        if a.update_check_mins > 0 && inst.is_installed() {
            let due = state
                .with_runtime(&inst.id, |r| {
                    let due = now - r.last_update_check >= a.update_check_mins as i64 * 60_000 && r.busy.is_none();
                    if due {
                        r.last_update_check = now;
                    }
                    due
                })
                .await;
            if due {
                let (st, app2, id) = (state.clone(), app.clone(), inst.id.clone());
                tauri::async_runtime::spawn(async move {
                    let _ = check_update(&st, &app2, &id, true).await;
                });
            }
        }
    }
}

fn run_action(state: &Arc<AppState>, app: &AppHandle, id: &str, action: &str, why: &'static str) {
    let (st, app2, id, action) = (state.clone(), app.clone(), id.to_string(), action.to_string());
    tauri::async_runtime::spawn(async move {
        // Players online and RCON on: warn them first (`announcerestart`), cancellable.
        if matches!(action.as_str(), "restart" | "update" | "stop") {
            if let Ok(inst) = st.instance(&id).await {
                let (online, busy) = st.with_runtime(&id, |r| (r.query_players.unwrap_or(r.online.len() as u32), r.countdown.is_some())).await;
                let mins = inst.automation.restart_warning_mins;
                if busy {
                    manager_log(&app2, &id, format!("{why} {action} skipped – another countdown is running."));
                    return;
                }
                if online > 0 && mins > 0 && inst.config.rcon_enabled && server::running_pids(&inst).1.is_some() && !server::countdown(&st, &app2, &id, &action, mins).await {
                    return;
                }
            }
        }
        let res = match action.as_str() {
            "restart" => server::restart(&st, &app2, &id, false).await,
            "update" => server::update_job(&st, &app2, &id, false).await,
            "stop" => server::stop(&st, &app2, &id, false).await,
            "start" => server::start(&st, &app2, &id).await,
            "backup" => run_backup(&st, &app2, &id, "Scheduled", "auto").await,
            _ => Ok(()),
        };
        if let Err(e) = res {
            notify(&app2, &id, "error", format!("{why} {action} failed: {e}"));
        }
    });
}

/// A player as the join line describes them.
#[derive(Debug, PartialEq, Clone)]
struct LogPlayer {
    endpoint: String,
    steam_id: Option<String>,
    name: String,
}

impl LogPlayer {
    /// Key in `Runtime::online`: the Steam id when known.
    fn key(&self) -> String {
        self.steam_id.clone().unwrap_or_else(|| if self.name.is_empty() { self.endpoint.clone() } else { self.name.clone() })
    }
    fn display(&self) -> String {
        if self.name.is_empty() {
            self.steam_id.clone().unwrap_or_else(|| self.endpoint.clone())
        } else {
            self.name.clone()
        }
    }
}

#[derive(Debug, PartialEq)]
enum Line {
    Version(String),
    SteamId(String),
    PublicIp(String),
    Ready,
    Saved,
    Join(LogPlayer),
    /// The endpoint that left.
    Leave(String),
    Shutdown,
    ListsReloaded,
    Fatal(String),
}

fn parse_line(l: &str) -> Option<Line> {
    if l.len() < 8 {
        return None;
    }
    if let Some(c) = JOIN_RE.captures(l) {
        let id = c[2].to_string();
        let steam_id = if id.is_empty() { ENDPOINT_ID_RE.captures(&c[1]).map(|m| m[1].to_string()) } else { Some(id) };
        return Some(Line::Join(LogPlayer { endpoint: c[1].to_string(), steam_id, name: c[3].trim().to_string() }));
    }
    if let Some(c) = LEAVE_RE.captures(l) {
        return Some(Line::Leave(c[1].to_string()));
    }
    if READY_RE.is_match(l) {
        return Some(Line::Ready);
    }
    if SAVED_RE.is_match(l) {
        return Some(Line::Saved);
    }
    if let Some(c) = VERSION_RE.captures(l) {
        return Some(Line::Version(c[1].to_string()));
    }
    if let Some(c) = STEAMID_RE.captures(l) {
        return Some(Line::SteamId(c[1].to_string()));
    }
    if let Some(c) = PUBLIC_IP_RE.captures(l) {
        return Some(Line::PublicIp(c[1].to_string()));
    }
    if SHUTDOWN_RE.is_match(l) {
        return Some(Line::Shutdown);
    }
    if LISTS_RE.is_match(l) {
        return Some(Line::ListsReloaded);
    }
    if let Some(c) = FATAL_RE.captures(l) {
        return Some(Line::Fatal(c[1].trim().to_string()));
    }
    None
}

/// What tells one log session from the next: the `Bootstrap - Boot Time: …` line (≈20 KB into the
/// file, after the settings dump – the banner before it is identical every time).
pub fn log_signature(path: &std::path::Path) -> Option<String> {
    let mut buf = vec![0u8; 96 * 1024];
    let n = std::fs::File::open(path).and_then(|mut f| f.read(&mut buf)).ok()?;
    let head = String::from_utf8_lossy(&buf[..n]);
    head.lines().find(|l| l.contains("Bootstrap - Boot Time:")).map(|l| l.trim().to_string())
}

#[derive(Default)]
struct LogMeta {
    version: Option<String>,
    steam_id: Option<String>,
    public_ip: Option<String>,
    ready: bool,
    saved: bool,
    online: Vec<LogPlayer>,
}

/// Version, Steam info and who is online, recovered from a log written so far.
fn scan_log_meta(path: &std::path::Path) -> LogMeta {
    let text = std::fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    let mut m = LogMeta::default();
    let mut online: Vec<LogPlayer> = vec![];
    for l in text.lines() {
        match parse_line(l) {
            Some(Line::Version(v)) => m.version = Some(v),
            Some(Line::SteamId(v)) => m.steam_id = Some(v),
            Some(Line::PublicIp(v)) => m.public_ip = Some(v),
            Some(Line::Ready) => m.ready = true,
            Some(Line::Saved) => m.saved = true,
            Some(Line::Join(p)) => {
                online.retain(|x| x.key() != p.key());
                online.push(p);
            }
            Some(Line::Leave(e)) => online.retain(|x| x.endpoint != e),
            _ => {}
        }
    }
    m.online = online;
    m
}

pub async fn run_backup(state: &Arc<AppState>, app: &AppHandle, id: &str, label: &str, kind: &str) -> crate::error::AppResult<()> {
    let inst = state.instance(id).await?;
    state.set_busy(app, id, Some("Backing up")).await;
    let res = backup::create(state, &inst, label, kind).await;
    state.set_busy(app, id, None).await;
    let b = res?;
    state.with_runtime(id, |r| r.last_backup = b.created_at).await;
    let _ = app.emit("backup-created", &b);
    Ok(())
}

/// Look up the live build for the server's branch (cached 10 min across servers) and, when the
/// profile asks for it, apply the update automatically. Returns true when an update is available.
pub async fn check_update(state: &Arc<AppState>, app: &AppHandle, id: &str, background: bool) -> crate::error::AppResult<bool> {
    let inst = state.instance(id).await?;
    let branch = if inst.branch.trim().is_empty() { "public".to_string() } else { inst.branch.trim().to_string() };
    let cached = state.latest_build_cache.lock().await.get(&branch).cloned().filter(|(t, _)| now_ms() - t < 10 * 60_000);
    let latest = match cached {
        Some((_, b)) => b,
        None => {
            let mut r = TaskReporter::new(app, "update-check", "Checking for server updates", Some(id));
            if background {
                r = r.quiet();
            }
            let res = match steamcmd::latest_build_web(&state.http, &branch).await {
                Some(b) => Ok(Some(b)),
                None => {
                    let steam = state.steamcmd_dir().await;
                    let _l = state.steam_lock.lock().await;
                    steamcmd::latest_build(&state.http, &steam, &branch, &r).await
                }
            };
            let b = match res {
                Ok(b) => b,
                Err(e) => {
                    if !background {
                        r.fail(&e.to_string());
                    }
                    return Err(e);
                }
            };
            if !background {
                r.done(&format!("Live build: {}", b.clone().unwrap_or_else(|| "unknown".into())));
            }
            state.latest_build_cache.lock().await.insert(branch, (now_ms(), b.clone()));
            b
        }
    };
    let installed = steamcmd::local_build(&inst.install_dir);
    let (was, online, alive) = state
        .with_runtime(id, |r| {
            let was = r.latest_build.clone();
            r.latest_build = latest.clone();
            r.installed_build = installed.clone();
            (was, r.query_players.unwrap_or(r.online.len() as u32), r.pid.is_some())
        })
        .await;
    state.emit_status(app, id).await;
    let available = matches!((&installed, &latest), (Some(i), Some(l)) if i != l);
    if available && background {
        if inst.automation.auto_update {
            if alive && online > 0 && inst.automation.wait_for_empty {
                let fresh = state
                    .with_runtime(id, |r| {
                        let fresh = r.waiting_empty.is_none();
                        r.waiting_empty.get_or_insert(("update".into(), now_ms()));
                        fresh
                    })
                    .await;
                if fresh {
                    notify_kind(app, id, "info", "update", format!("Update found for {} – it installs once the {online} player(s) online have left", inst.name));
                }
            } else {
                notify_kind(app, id, "info", "update", format!("Update found for {} – applying it now", inst.name));
                server::update_job(state, app, id, false).await?;
            }
        } else if was != latest {
            notify_kind(app, id, "info", "update", format!("A server update is available for {} (build {})", inst.name, latest.clone().unwrap_or_default()));
        }
    }
    Ok(available)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_server_log_lines() {
        // Lines captured from a real run (v1.1.15.0, Steam build 25169871).
        assert_eq!(
            parse_line("Bootstrap - Boot Time: 2026-10-15 11:54:59 UTC, Version: VRisingServer v1.1.15.0-r101082-b2 (202609071358) (Build) (Release) (m)"),
            Some(Line::Version("1.1.15.0-r101082-b2".into()))
        );
        assert_eq!(parse_line("[Server] Startup Completed - Disabling Scene Loading Systems"), Some(Line::Ready));
        assert_eq!(parse_line("SteamNetworking - Successfully logged in with the SteamGameServer API. SteamID: 90294949908879360"), Some(Line::SteamId("90294949908879360".into())));
        assert_eq!(parse_line("PlatformSystemBase - OnPolicyResponse - Public IP: 32.219.170.177"), Some(Line::PublicIp("32.219.170.177".into())));
        assert_eq!(
            parse_line(r"PersistenceV2 - Finished Saving to 'O:\srv\save-data\Saves\v4\world1\AutoSave_1.save.gz'. Total Persistent ChunkCount 2659. Total Save Size: 6954727"),
            Some(Line::Saved)
        );
        assert_eq!(parse_line("GameBootstrap.OnApplicationQuit()"), Some(Line::Shutdown));
        assert_eq!(parse_line("[FileUserList] Content:"), Some(Line::ListsReloaded));
        assert_eq!(parse_line("[Server] Loaded Chunk 7,21"), None);
        assert_eq!(parse_line("Triggering AutoSave 1!"), None);
        assert_eq!(parse_line("SaveOnExit() - Saving the world on exit!"), None);
        // From the binary's format strings.
        assert_eq!(
            parse_line("User '{Steam 76561198000000001}' '76561198000000001', approvedUserIndex: 0, Character: 'Vlad' connected as ID '0,1', Entity '27583,1'."),
            Some(Line::Join(LogPlayer { endpoint: "{Steam 76561198000000001}".into(), steam_id: Some("76561198000000001".into()), name: "Vlad".into() }))
        );
        assert_eq!(
            parse_line("User '{Steam 76561198000000002}' '', approvedUserIndex: 1, Character: '' connected as ID '1,1', Entity '1,1'."),
            Some(Line::Join(LogPlayer { endpoint: "{Steam 76561198000000002}".into(), steam_id: Some("76561198000000002".into()), name: "".into() }))
        );
        assert_eq!(
            parse_line("User '{Steam 76561198000000001}' disconnected. approvedUserIndex: 0 Reason: Disconnected "),
            Some(Line::Leave("{Steam 76561198000000001}".into()))
        );
    }

    #[test]
    fn log_meta_tracks_who_is_still_online() {
        let dir = std::env::temp_dir().join(format!("vrsm-meta-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("VRisingServer.log");
        std::fs::write(
            &p,
            "Bootstrap - Boot Time: 2026-10-15 11:54:59 UTC, Version: VRisingServer v1.1.15.0-r101082-b2 (x)\n\
             [Server] Startup Completed - Disabling Scene Loading Systems\n\
             User '{Steam 76561198000000001}' '76561198000000001', approvedUserIndex: 0, Character: 'Vlad' connected as ID '0,1', Entity '1,1'.\n\
             User '{Steam 76561198000000003}' '76561198000000003', approvedUserIndex: 1, Character: 'Mina' connected as ID '1,1', Entity '2,1'.\n\
             User '{Steam 76561198000000001}' disconnected. approvedUserIndex: 0 Reason: Disconnected \n",
        )
        .unwrap();
        let m = scan_log_meta(&p);
        assert!(m.ready);
        assert_eq!(m.version.as_deref(), Some("1.1.15.0-r101082-b2"));
        assert_eq!(m.online.len(), 1);
        assert_eq!(m.online[0].name, "Mina");
        assert_eq!(log_signature(&p).as_deref(), Some("Bootstrap - Boot Time: 2026-10-15 11:54:59 UTC, Version: VRisingServer v1.1.15.0-r101082-b2 (x)"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
