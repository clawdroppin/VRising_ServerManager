use crate::core::{history::History, secrets};
use crate::error::{AppError, AppResult};
use crate::models::*;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, RwLock};

/// Volatile, per-instance runtime bookkeeping (never persisted).
#[derive(Debug, Default)]
pub struct Runtime {
    pub pid: Option<u32>,
    pub state: Option<ServerState>,
    pub started_at: Option<i64>,
    pub ready_at: Option<i64>,
    pub intentional_stop: bool,
    pub crash_times: Vec<i64>,
    pub crash_loop: bool,
    /// Short label of a long operation in progress (backup, update …) – shown in the UI.
    pub busy: Option<String>,
    /// Settings changed while running → they take effect on the next restart.
    pub pending_restart: bool,
    pub installed_build: Option<String>,
    pub latest_build: Option<String>,
    pub game_version: Option<String>,
    pub days_running: Option<u32>,
    pub last_backup: i64,
    pub last_update_check: i64,
    pub last_exit_code: Option<i64>,
    pub fired_schedule_keys: HashSet<String>,
    pub next_schedule: Option<NextSchedule>,
    /// Auto-restart scheduled after a crash (ms timestamp).
    pub restart_at: Option<i64>,
    /// Log tail position, and the session signature of the file it belongs to: the server
    /// truncates its log on every start, so a new signature means "start over".
    pub log_offset: u64,
    pub log_partial: String,
    pub log_sig: Option<String>,
    /// Players currently online (SteamID64, or the name when unknown -> details).
    pub online: BTreeMap<String, OnlinePlayer>,
    /// Network endpoint from the join line (`{Steam 7656…}`) -> key in `online` (the leave line
    /// only names the endpoint).
    pub players_by_endpoint: HashMap<String, String>,
    /// RCON answered the last command.
    pub rcon_ok: Option<bool>,
    /// A restart/update/stop announced to players and waiting: (action, when it runs).
    pub countdown: Option<(String, i64)>,
    /// Last time each timed announcement went out (index -> ms).
    pub last_announce: HashMap<usize, i64>,
    /// Player count the server reports over A2S.
    pub query_players: Option<u32>,
    pub last_query: i64,
    pub console_hidden: bool,
    pub steam_id: Option<String>,
    pub public_ip: Option<String>,
    pub last_save: Option<i64>,
    /// The log reported the server is up (`[Server] Startup Completed`).
    pub log_ready: bool,
    /// A fatal start-up error the server logged before it came online.
    pub fatal: Option<String>,
    /// Since when nobody has been online (idle stop).
    pub empty_since: Option<i64>,
    /// An automatic update/restart waiting for the server to empty: (action, since).
    pub waiting_empty: Option<(String, i64)>,
}

pub struct AppState {
    pub data_dir: PathBuf,
    pub portable: bool,
    pub settings: RwLock<AppSettings>,
    pub instances: RwLock<Vec<ServerInstance>>,
    pub runtime: Mutex<HashMap<String, Runtime>>,
    pub http: reqwest::Client,
    pub history: History,
    /// Secrets that couldn't be decrypted at load (portable folder moved to another PC).
    pub lost_secrets: Vec<String>,
    /// Cancellation flags for long-running tasks, keyed by task id.
    pub cancels: Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
    /// SteamCMD keeps global state in its folder; only one invocation may run at a time.
    pub steam_lock: Mutex<()>,
    /// Latest build per branch seen on Steam and when.
    pub latest_build_cache: Mutex<HashMap<String, (i64, Option<String>)>>,
    /// Serialises lifecycle operations per server (start/stop/restart/update never overlap).
    pub op_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl AppState {
    pub fn load(data_dir: PathBuf, portable: bool) -> Self {
        let _ = std::fs::create_dir_all(&data_dir);
        let mut settings: AppSettings = load_json_safe(&data_dir.join("settings.json"));
        let mut instances: Vec<ServerInstance> = load_json_safe(&data_dir.join("instances.json"));
        // Secrets are DPAPI-encrypted on disk; plain values (old files, hand edits) are accepted.
        let mut lost = secrets::open_settings(&mut settings);
        for i in instances.iter_mut() {
            lost.extend(secrets::open_instance(i));
        }
        // A portable folder may have been moved or opened from another drive letter: re-root every
        // stored path that pointed inside the old data folder.
        if let Some(old) = settings.last_data_dir.clone().filter(|o| o != &data_dir) {
            let fix = |p: &mut PathBuf| {
                if let Some(n) = crate::paths::rebase(p, &old, &data_dir) {
                    *p = n;
                }
            };
            for d in [&mut settings.steamcmd_dir, &mut settings.default_install_root, &mut settings.backup_dir].into_iter().flatten() {
                fix(d);
            }
            for i in instances.iter_mut() {
                fix(&mut i.install_dir);
            }
            let sealed: Vec<ServerInstance> = instances.iter().map(secrets::seal_instance).collect();
            let _ = write_json_atomic(&data_dir.join("instances.json"), &sealed);
        }
        if settings.last_data_dir.as_ref() != Some(&data_dir) {
            settings.last_data_dir = Some(data_dir.clone());
            let _ = write_json_atomic(&data_dir.join("settings.json"), &secrets::seal_settings(&settings));
        }
        let history = History::open(&data_dir.join("manager.db"));
        history.prune(settings.metrics_retention_days);
        let http = reqwest::Client::builder()
            .user_agent(concat!("VRising-Server-Manager/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("http client");
        Self {
            data_dir,
            portable,
            settings: RwLock::new(settings),
            instances: RwLock::new(instances),
            runtime: Mutex::new(HashMap::new()),
            http,
            history,
            lost_secrets: lost,
            cancels: Mutex::new(HashMap::new()),
            steam_lock: Mutex::new(()),
            latest_build_cache: Mutex::new(HashMap::new()),
            op_locks: Mutex::new(HashMap::new()),
        }
    }

    pub async fn persist_instances(&self) -> AppResult<()> {
        let list: Vec<ServerInstance> = self.instances.read().await.iter().map(secrets::seal_instance).collect();
        write_json_atomic(&self.data_dir.join("instances.json"), &list)
    }

    pub async fn persist_settings(&self) -> AppResult<()> {
        let s = secrets::seal_settings(&self.settings.read().await.clone());
        write_json_atomic(&self.data_dir.join("settings.json"), &s)
    }

    /// Replace one stored profile and persist the list.
    pub async fn put_instance(&self, inst: &ServerInstance) -> AppResult<()> {
        {
            let mut list = self.instances.write().await;
            if let Some(slot) = list.iter_mut().find(|i| i.id == inst.id) {
                *slot = inst.clone();
            }
        }
        self.persist_instances().await
    }

    pub async fn instance(&self, id: &str) -> AppResult<ServerInstance> {
        self.instances
            .read()
            .await
            .iter()
            .find(|i| i.id == id)
            .cloned()
            .ok_or_else(|| AppError::InstanceNotFound(id.to_string()))
    }

    pub async fn op_lock(&self, id: &str) -> Arc<Mutex<()>> {
        self.op_locks.lock().await.entry(id.to_string()).or_default().clone()
    }

    pub async fn steamcmd_dir(&self) -> PathBuf {
        self.settings
            .read()
            .await
            .steamcmd_dir
            .clone()
            .unwrap_or_else(|| self.data_dir.join("steamcmd"))
    }

    /// Where a server's backups go: `<server folder>\Backups` by default, or
    /// `<override>\<server id>` when a global backup folder is set in App settings.
    pub async fn backup_dir(&self, inst: &ServerInstance) -> PathBuf {
        match self.settings.read().await.backup_dir.clone() {
            Some(root) => root.join(&inst.id),
            None => inst.install_dir.join("Backups"),
        }
    }

    pub async fn default_install_root(&self) -> PathBuf {
        self.settings
            .read()
            .await
            .default_install_root
            .clone()
            .unwrap_or_else(|| self.data_dir.join("servers"))
    }

    pub async fn with_runtime<R>(&self, id: &str, f: impl FnOnce(&mut Runtime) -> R) -> R {
        let mut map = self.runtime.lock().await;
        f(map.entry(id.to_string()).or_default())
    }

    pub async fn status(&self, inst: &ServerInstance) -> ServerStatus {
        let map = self.runtime.lock().await;
        let rt = map.get(&inst.id);
        let installed = inst.is_installed();
        let state = match rt.and_then(|r| r.state) {
            Some(s) => s,
            None if !installed => ServerState::NotInstalled,
            None => ServerState::Stopped,
        };
        let state = if matches!(state, ServerState::Stopped | ServerState::Crashed) && !installed {
            ServerState::NotInstalled
        } else {
            state
        };
        ServerStatus {
            id: inst.id.clone(),
            state,
            pid: rt.and_then(|r| r.pid),
            started_at: rt.and_then(|r| r.started_at),
            ready_at: rt.and_then(|r| r.ready_at),
            installed_build: rt.and_then(|r| r.installed_build.clone()),
            latest_build: rt.and_then(|r| r.latest_build.clone()),
            game_version: rt.and_then(|r| r.game_version.clone()),
            days_running: rt.and_then(|r| r.days_running),
            crash_count: rt.map(|r| r.crash_times.len() as u32).unwrap_or(0),
            crash_loop: rt.map(|r| r.crash_loop).unwrap_or(false),
            pending_restart: rt.map(|r| r.pending_restart).unwrap_or(false),
            players: rt.map(|r| r.online.values().cloned().collect()).unwrap_or_default(),
            query_players: rt.and_then(|r| r.query_players),
            next_schedule: rt.and_then(|r| r.next_schedule.clone()),
            last_backup: rt.map(|r| r.last_backup).filter(|t| *t > 0),
            last_exit_code: rt.and_then(|r| r.last_exit_code),
            busy: rt.and_then(|r| r.busy.clone()),
            rcon_ok: rt.and_then(|r| r.rcon_ok),
            steam_id: rt.and_then(|r| r.steam_id.clone()),
            public_ip: rt.and_then(|r| r.public_ip.clone()),
            last_save: rt.and_then(|r| r.last_save),
            waiting: rt.and_then(|r| r.waiting_empty.as_ref().map(|(a, _)| a.clone())),
            countdown: rt.and_then(|r| r.countdown.as_ref().map(|(action, at)| NextSchedule { at: *at, action: action.clone() })),
        }
    }

    pub async fn emit_status(&self, app: &AppHandle, id: &str) {
        if let Ok(inst) = self.instance(id).await {
            let st = self.status(&inst).await;
            let _ = app.emit("server-status", st);
        }
    }

    pub async fn set_busy(&self, app: &AppHandle, id: &str, label: Option<&str>) {
        self.with_runtime(id, |r| r.busy = label.map(|s| s.to_string())).await;
        self.emit_status(app, id).await;
    }

    pub async fn register_cancel(&self, task_id: &str) -> Arc<std::sync::atomic::AtomicBool> {
        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        self.cancels.lock().await.insert(task_id.to_string(), flag.clone());
        flag
    }
}

/// Emit a toast-style event for one server, record it in the timeline and forward it to the
/// webhook / Windows notifications when configured.
pub fn notify(app: &AppHandle, id: &str, level: &str, message: impl Into<String>) {
    notify_kind(app, id, level, "event", message)
}

/// `notify` with a timeline category: lifecycle | crash | player | backup | update | config | event.
pub fn notify_kind(app: &AppHandle, id: &str, level: &str, kind: &str, message: impl Into<String>) {
    let message = message.into();
    let _ = app.emit(
        "server-event",
        ServerEvent { id: id.to_string(), level: level.to_string(), message: message.clone(), ts: now_ms() },
    );
    use tauri::Manager;
    let Some(state) = app.try_state::<Arc<AppState>>() else { return };
    let state = state.inner().clone();
    let (id, level, kind, app) = (id.to_string(), level.to_string(), kind.to_string(), app.clone());
    tauri::async_runtime::spawn(async move {
        state.history.event((!id.is_empty()).then_some(id.as_str()), &level, &kind, &message);
        let s = state.settings.read().await.clone();
        let name = state.instance(&id).await.map(|i| i.name).unwrap_or_default();
        // Windows toasts for what needs attention and for player traffic – only while the window
        // isn't in front (the in-app toast covers that).
        let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
        let worth = level == "error" || level == "warn" || kind == "player" || (level == "success" && kind == "lifecycle");
        if s.desktop_notifications && !focused && worth {
            use tauri_plugin_notification::NotificationExt;
            let title = if name.is_empty() { "V Rising Server Manager".to_string() } else { name.clone() };
            let _ = app.notification().builder().title(title).body(&message).show();
        }
        if s.webhook_url.trim().is_empty() || !s.webhook_levels.iter().any(|l| l == &level) {
            return;
        }
        let _ = send_webhook(&state.http, s.webhook_url.trim(), &level, &name, &message).await;
    });
}

/// POST a message in a shape Discord (`content`) and Slack (`text`) both accept.
pub async fn send_webhook(http: &reqwest::Client, url: &str, level: &str, server: &str, message: &str) -> AppResult<()> {
    let icon = match level {
        "success" => "\u{1F7E2}",
        "error" => "\u{1F534}",
        "warn" => "\u{1F7E0}",
        _ => "\u{1F535}",
    };
    let text = if server.is_empty() { format!("{icon} {message}") } else { format!("{icon} **{server}** \u{2013} {message}") };
    let body = serde_json::json!({ "content": text, "text": text, "username": "V Rising Server Manager" });
    let r = http.post(url).json(&body).timeout(std::time::Duration::from_secs(10)).send().await?;
    if !r.status().is_success() {
        return Err(AppError::msg(format!("Webhook returned HTTP {}", r.status())));
    }
    Ok(())
}

/// Emit a manager line into a server's console stream.
pub fn manager_log(app: &AppHandle, id: &str, line: impl Into<String>) {
    let _ = app.emit(
        "log-lines",
        LogBatch { id: id.to_string(), source: "manager".into(), lines: vec![line.into()], ts: now_ms() },
    );
}

/// Small helper to stream progress for long running jobs to the UI.
#[derive(Clone)]
pub struct TaskReporter {
    pub app: AppHandle,
    pub task_id: String,
    pub instance_id: Option<String>,
    pub kind: String,
    pub title: String,
    /// When set, raw output lines are not forwarded to the log stream.
    pub quiet: bool,
}

impl TaskReporter {
    pub fn new(app: &AppHandle, kind: &str, title: &str, instance_id: Option<&str>) -> Self {
        Self {
            app: app.clone(),
            task_id: uuid::Uuid::new_v4().to_string(),
            instance_id: instance_id.map(|s| s.to_string()),
            kind: kind.to_string(),
            title: title.to_string(),
            quiet: false,
        }
    }
    pub fn quiet(mut self) -> Self {
        self.quiet = true;
        self
    }
    fn send(&self, message: &str, progress: Option<f64>, done: bool, error: Option<String>) {
        let _ = self.app.emit(
            "task",
            TaskEvent {
                task_id: self.task_id.clone(),
                instance_id: self.instance_id.clone(),
                kind: self.kind.clone(),
                title: self.title.clone(),
                message: message.to_string(),
                progress,
                done,
                error,
            },
        );
    }
    pub fn progress(&self, message: &str, progress: Option<f64>) {
        self.send(message, progress, false, None)
    }
    pub fn done(&self, message: &str) {
        self.send(message, Some(1.0), true, None)
    }
    pub fn fail(&self, error: &str) {
        self.send(error, None, true, Some(error.to_string()))
    }
    pub fn log(&self, line: &str) {
        if self.quiet {
            return;
        }
        let _ = self.app.emit(
            "log-lines",
            LogBatch {
                id: self.instance_id.clone().unwrap_or_default(),
                source: self.kind.clone(),
                lines: vec![line.to_string()],
                ts: chrono::Utc::now().timestamp_millis(),
            },
        );
    }
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Load a JSON file without ever losing data: a file that exists but can't be parsed is kept as
/// `<name>.corrupt-<timestamp>` and the last good `.bak` copy is used instead.
pub fn load_json_safe<T: serde::de::DeserializeOwned + Default>(path: &Path) -> T {
    if !path.exists() {
        return read_json(&path.with_extension("json.bak")).unwrap_or_default();
    }
    if let Some(v) = read_json(path) {
        return v;
    }
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let corrupt = path.with_extension(format!("json.corrupt-{stamp}"));
    let _ = std::fs::rename(path, &corrupt);
    eprintln!("{} was unreadable; kept as {} and restored from backup", path.display(), corrupt.display());
    read_json(&path.with_extension("json.bak")).unwrap_or_default()
}

pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Keep the previous good version as a one-step backup.
    if path.exists() && read_json::<serde_json::Value>(path).is_some() {
        let _ = std::fs::copy(path, path.with_extension("json.bak"));
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corrupt_file_is_preserved_and_backup_used() {
        let dir = std::env::temp_dir().join(format!("vrsm-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("instances.json");
        write_json_atomic(&p, &vec![1, 2, 3]).unwrap();
        write_json_atomic(&p, &vec![4, 5]).unwrap(); // .bak now holds [1,2,3]
        std::fs::write(&p, "{ not json").unwrap();
        let v: Vec<i32> = load_json_safe(&p);
        assert_eq!(v, vec![1, 2, 3]);
        let kept = std::fs::read_dir(&dir).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains("corrupt-"));
        assert!(kept, "corrupt file must be kept");
        let _ = std::fs::remove_dir_all(dir);
    }
}
