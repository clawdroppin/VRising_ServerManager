//! Persisted and event types. Everything is camelCase on the wire and mirrored in `src/lib/types.ts`.
//!
//! The V Rising dedicated server (verified against Steam build 25169871, v1.1.15.0) is launched
//! with `-persistentDataPath <dir>`; everything it reads and writes lives there:
//! `Settings\ServerHostSettings.json` (name, ports, password, RCON …), `Settings\ServerGameSettings.json`
//! (gameplay rules), `Settingsdminlist.txt` / `banlist.txt` (SteamID64 per line, reloaded live)
//! and `Saves4\<SaveName>\AutoSave_N.save.gz`. Live player info comes from the log, the
//! Steam A2S query (only while the server is listed on Steam) and RCON.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// "V Rising Dedicated Server" – free Steam tool, anonymous SteamCMD login.
pub const SERVER_APP_ID: u32 = 1829350;
/// The game client (Steam master list `appid`, its local saves).
pub const GAME_APP_ID: u32 = 1604030;
pub const SERVER_EXE: &str = "VRisingServer.exe";
pub const HOST_FILE: &str = "ServerHostSettings.json";
pub const GAME_FILE: &str = "ServerGameSettings.json";
pub const ADMIN_FILE: &str = "adminlist.txt";
pub const BAN_FILE: &str = "banlist.txt";
pub const LOG_FILE: &str = "VRisingServer.log";
/// The save format folder the current server writes (`Saves4\<name>`).
pub const SAVE_VERSION_DIR: &str = "v4";
pub const DEFAULT_GAME_PORT: u16 = 9876;
pub const DEFAULT_QUERY_PORT: u16 = 9877;
pub const DEFAULT_RCON_PORT: u16 = 25575;
pub const DEFAULT_API_PORT: u16 = 9090;
pub const MAX_USERS: u32 = 128;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub steamcmd_dir: Option<PathBuf>,
    pub default_install_root: Option<PathBuf>,
    pub backup_dir: Option<PathBuf>,
    pub last_data_dir: Option<PathBuf>,
    /// Supervisor sample interval for live telemetry.
    pub telemetry_interval_ms: u64,
    pub confirm_destructive: bool,
    pub reduce_motion: bool,
    pub check_updates_on_launch: bool,
    pub accent: String,
    /// Closing the window keeps the manager (and its automation) running in the tray.
    pub close_to_tray: bool,
    /// Windows toast notifications for crashes, updates and players.
    pub desktop_notifications: bool,
    /// Masks IPs, passwords and Steam ids in the UI (for streaming / screenshots).
    pub streamer_mode: bool,
    /// Discord/Slack-compatible webhook for server events. Empty = off. Stored encrypted.
    pub webhook_url: String,
    /// Event levels sent to the webhook: success | error | warn | info
    pub webhook_levels: Vec<String>,
    /// Days of per-minute metrics kept in manager.db.
    pub metrics_retention_days: u32,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            steamcmd_dir: None,
            default_install_root: None,
            backup_dir: None,
            last_data_dir: None,
            telemetry_interval_ms: 1000,
            confirm_destructive: true,
            reduce_motion: false,
            check_updates_on_launch: true,
            accent: "blood".into(),
            close_to_tray: true,
            desktop_notifications: true,
            streamer_mode: false,
            webhook_url: String::new(),
            webhook_levels: vec!["success".into(), "error".into()],
            metrics_retention_days: 30,
        }
    }
}

/// The keys of `ServerHostSettings.json` the profile owns, plus the gameplay rules of
/// `ServerGameSettings.json` as flattened `Dotted.Path` → value pairs. Keys the manager doesn't
/// know (and the server's own additions) stay owned by the files.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerConfig {
    pub name: String,
    pub description: String,
    /// Bind address; empty = all interfaces.
    pub address: String,
    /// UDP game port.
    pub port: u16,
    /// UDP Steam query port.
    pub query_port: u16,
    pub max_connected_users: u32,
    pub max_connected_admins: u32,
    pub server_fps: u32,
    /// The world folder under `Saves4` the server loads (created on first start).
    pub save_name: String,
    /// Join password; empty = open server.
    pub password: String,
    /// Steam VAC.
    pub secure: bool,
    pub list_on_steam: bool,
    pub list_on_eos: bool,
    pub lan_mode: bool,
    pub hide_ip_address: bool,
    /// Rolling autosaves kept, and seconds between them.
    pub auto_save_count: u32,
    pub auto_save_interval: u32,
    pub compress_save_files: bool,
    /// A file name from `StreamingAssets\GameSettingPresets` (without .json). When set, the
    /// server ignores ServerGameSettings.json completely (verified).
    pub game_settings_preset: String,
    /// `Difficulty_Easy` | `Difficulty_Normal` | `Difficulty_Brutal` – overlaid on the game settings.
    pub game_difficulty_preset: String,
    pub admin_only_debug_events: bool,
    pub disable_debug_events: bool,
    pub rcon_enabled: bool,
    pub rcon_port: u16,
    pub rcon_password: String,
    /// The built-in HTTP API (metrics / Prometheus).
    pub api_enabled: bool,
    pub api_port: u16,
    /// ServerGameSettings.json, flattened (`GameTimeModifiers.DayDurationInSeconds`). Arrays and
    /// keys missing here keep whatever the file has.
    pub game_settings: BTreeMap<String, serde_json::Value>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            name: "V Rising Server".into(),
            description: String::new(),
            address: String::new(),
            port: DEFAULT_GAME_PORT,
            query_port: DEFAULT_QUERY_PORT,
            max_connected_users: 40,
            max_connected_admins: 4,
            server_fps: 30,
            save_name: "world1".into(),
            password: String::new(),
            secure: true,
            list_on_steam: true,
            list_on_eos: false,
            lan_mode: false,
            hide_ip_address: false,
            auto_save_count: 20,
            auto_save_interval: 120,
            compress_save_files: true,
            game_settings_preset: String::new(),
            game_difficulty_preset: String::new(),
            admin_only_debug_events: true,
            disable_debug_events: false,
            rcon_enabled: true,
            rcon_port: DEFAULT_RCON_PORT,
            rcon_password: String::new(),
            api_enabled: false,
            api_port: DEFAULT_API_PORT,
            game_settings: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LaunchSettings {
    /// `-persistentDataPath`: settings, admin/ban lists and saves. Relative = inside the install folder.
    pub data_dir: String,
    /// Ask the router to forward the game and query ports over UPnP on every start.
    pub upnp: bool,
    /// Keep the server's console window visible (hidden by default).
    pub show_console: bool,
    /// normal | belowNormal | aboveNormal | high | idle
    pub priority: String,
    /// CPU cores the server may use. Empty = all cores.
    pub affinity: Vec<u32>,
    /// Free-form extra arguments appended to the command line.
    pub extra_args: String,
}

impl Default for LaunchSettings {
    fn default() -> Self {
        Self { data_dir: "./save-data".into(), upnp: false, show_console: false, priority: "normal".into(), affinity: vec![], extra_args: String::new() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ScheduleEntry {
    pub enabled: bool,
    /// Local time, "HH:MM".
    pub time: String,
    /// 0 = Sunday … 6 = Saturday. Empty = every day.
    pub days: Vec<u8>,
    /// restart | backup | update | stop | start
    pub action: String,
}

impl Default for ScheduleEntry {
    fn default() -> Self {
        Self { enabled: true, time: "04:00".into(), days: vec![], action: "restart".into() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AutomationSettings {
    pub auto_start: bool,
    pub auto_restart: bool,
    pub restart_delay_secs: u32,
    /// Crash-loop guard: stop auto-restarting after this many crashes within 15 minutes.
    pub crash_limit: u32,
    pub stop_timeout_secs: u32,
    pub schedules: Vec<ScheduleEntry>,
    pub backup_interval_mins: u32,
    pub backup_keep: u32,
    pub backup_on_stop: bool,
    pub backup_before_update: bool,
    pub update_on_start: bool,
    pub update_check_mins: u32,
    pub auto_update: bool,
    /// Wait for the server to be empty before an automatic update/restart (up to 60 minutes).
    pub wait_for_empty: bool,
    /// Restart when the server's memory exceeds this many MB (0 = off).
    pub memory_limit_mb: u32,
    /// Restart when the server has been up this many hours (0 = off).
    pub max_uptime_hours: u32,
    /// Stop the server after this many minutes with nobody online (0 = off).
    pub idle_stop_mins: u32,
    /// Warn players over RCON this many minutes before an automatic restart/update/stop while
    /// someone is online (`announcerestart`; 0 = off).
    pub restart_warning_mins: u32,
    /// Messages announced over RCON on a timer while players are online.
    pub announcements: Vec<Announcement>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Announcement {
    pub enabled: bool,
    pub message: String,
    pub every_mins: u32,
}

impl Default for Announcement {
    fn default() -> Self {
        Self { enabled: true, message: "Welcome! Be kind to each other.".into(), every_mins: 60 }
    }
}

impl Default for AutomationSettings {
    fn default() -> Self {
        Self {
            auto_start: false,
            auto_restart: true,
            restart_delay_secs: 10,
            crash_limit: 3,
            stop_timeout_secs: 60,
            schedules: vec![],
            backup_interval_mins: 60,
            backup_keep: 24,
            backup_on_stop: true,
            backup_before_update: true,
            update_on_start: false,
            update_check_mins: 60,
            auto_update: false,
            wait_for_empty: false,
            memory_limit_mb: 0,
            max_uptime_hours: 0,
            idle_stop_mins: 0,
            restart_warning_mins: 5,
            announcements: vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerInstance {
    pub id: String,
    pub name: String,
    pub color: String,
    pub install_dir: PathBuf,
    pub created_at: i64,
    pub notes: String,
    /// Steam branch ("public" or a beta name) and its password.
    pub branch: String,
    pub branch_password: String,
    pub config: ServerConfig,
    pub launch: LaunchSettings,
    pub automation: AutomationSettings,
}

impl Default for ServerInstance {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "V Rising Server".into(),
            color: "blood".into(),
            install_dir: PathBuf::new(),
            created_at: 0,
            notes: String::new(),
            branch: "public".into(),
            branch_password: String::new(),
            config: ServerConfig::default(),
            launch: LaunchSettings::default(),
            automation: AutomationSettings::default(),
        }
    }
}

/// A `./relative` or absolute folder from the config, resolved against the install folder.
fn resolve_dir(base: &Path, v: &str, fallback: &str) -> PathBuf {
    let v = v.trim();
    let v = if v.is_empty() { fallback } else { v };
    let p = PathBuf::from(v.replace('/', "\\"));
    if p.is_absolute() {
        p
    } else {
        base.join(v.trim_start_matches("./").trim_start_matches(".\\").replace('/', "\\"))
    }
}

impl ServerInstance {
    /// Every UDP port the server binds and players need: game + query (verified: 9876/9877).
    pub fn udp_ports(&self) -> Vec<u16> {
        vec![self.config.port, self.config.query_port]
    }
    /// TCP ports: RCON and the HTTP API when enabled (only needed from outside for remote admin).
    pub fn tcp_ports(&self) -> Vec<u16> {
        let mut v = vec![];
        if self.config.rcon_enabled {
            v.push(self.config.rcon_port);
        }
        if self.config.api_enabled {
            v.push(self.config.api_port);
        }
        v
    }
    /// `-persistentDataPath`.
    pub fn data_dir(&self) -> PathBuf {
        resolve_dir(&self.install_dir, &self.launch.data_dir, "./save-data")
    }
    pub fn settings_dir(&self) -> PathBuf {
        self.data_dir().join("Settings")
    }
    pub fn host_path(&self) -> PathBuf {
        self.settings_dir().join(HOST_FILE)
    }
    pub fn game_path(&self) -> PathBuf {
        self.settings_dir().join(GAME_FILE)
    }
    pub fn admin_path(&self) -> PathBuf {
        self.settings_dir().join(ADMIN_FILE)
    }
    pub fn ban_path(&self) -> PathBuf {
        self.settings_dir().join(BAN_FILE)
    }
    fn streaming_assets(&self) -> PathBuf {
        self.install_dir.join("VRisingServer_Data").join("StreamingAssets")
    }
    /// The default settings shipped with the server (the template for new files).
    pub fn default_settings_dir(&self) -> PathBuf {
        self.streaming_assets().join("Settings")
    }
    pub fn presets_dir(&self) -> PathBuf {
        self.streaming_assets().join("GameSettingPresets")
    }
    pub fn difficulty_presets_dir(&self) -> PathBuf {
        self.streaming_assets().join("GameDifficultyPresets")
    }
    /// `Saves` – each save format has a subfolder (`v4` today, `v3`/`v1` from older versions).
    pub fn saves_root(&self) -> PathBuf {
        self.data_dir().join("Saves")
    }
    pub fn saves_dir(&self) -> PathBuf {
        self.saves_root().join(SAVE_VERSION_DIR)
    }
    /// The folder of the world the server loads.
    pub fn world_dir(&self) -> PathBuf {
        self.saves_dir().join(self.config.save_name.trim())
    }
    pub fn logs_dir(&self) -> PathBuf {
        self.install_dir.join("logs")
    }
    pub fn log_path(&self) -> PathBuf {
        self.logs_dir().join(LOG_FILE)
    }
    pub fn server_exe(&self) -> PathBuf {
        resolve_server_exe(&self.install_dir)
    }
    pub fn is_installed(&self) -> bool {
        self.server_exe().exists()
    }
}

pub fn resolve_server_exe(install_dir: &Path) -> PathBuf {
    install_dir.join(SERVER_EXE)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ServerState {
    NotInstalled,
    Stopped,
    Installing,
    Updating,
    Starting,
    Running,
    Stopping,
    Restarting,
    Crashed,
}

impl ServerState {
    pub fn is_live(self) -> bool {
        matches!(self, ServerState::Starting | ServerState::Running | ServerState::Stopping)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub id: String,
    pub state: ServerState,
    pub pid: Option<u32>,
    pub started_at: Option<i64>,
    pub ready_at: Option<i64>,
    pub installed_build: Option<String>,
    pub latest_build: Option<String>,
    /// Game version from the log (`v1.1.15.0-r101082-b2`).
    pub game_version: Option<String>,
    /// In-game days the world has been running (A2S rule `days-runningv2`, only while listed on Steam).
    pub days_running: Option<u32>,
    pub crash_count: u32,
    pub crash_loop: bool,
    pub pending_restart: bool,
    /// Players online (from the log; the count is confirmed by A2S while listed on Steam).
    pub players: Vec<OnlinePlayer>,
    /// Player count reported by the server over A2S (None = no answer yet).
    pub query_players: Option<u32>,
    pub next_schedule: Option<NextSchedule>,
    pub last_backup: Option<i64>,
    pub last_exit_code: Option<i64>,
    pub busy: Option<String>,
    /// RCON answered the last probe (None = disabled or not tried yet).
    pub rcon_ok: Option<bool>,
    /// Steam game-server id from the log.
    pub steam_id: Option<String>,
    /// Public IPv4 the server registered with Steam.
    pub public_ip: Option<String>,
    /// The last world save the log reported.
    pub last_save: Option<i64>,
    /// An automatic restart/update/stop waiting for players to leave.
    pub waiting: Option<String>,
    /// A restart/update/stop announced to players over RCON, and when it runs.
    pub countdown: Option<NextSchedule>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OnlinePlayer {
    /// Character name (empty for a brand-new player until they create a character).
    pub name: String,
    pub since: i64,
    /// SteamID64 (the log's PlatformId).
    pub steam_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NextSchedule {
    pub at: i64,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProcSample {
    pub id: String,
    pub cpu: f32,
    pub mem: u64,
    pub virt: u64,
    pub read_bps: u64,
    pub write_bps: u64,
    pub uptime: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemSample {
    pub cpu: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    pub rx_bps: u64,
    pub tx_bps: u64,
    pub cores: usize,
    pub per_core: Vec<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryEvent {
    pub ts: i64,
    pub system: SystemSample,
    pub servers: Vec<ProcSample>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub task_id: String,
    pub instance_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub message: String,
    pub progress: Option<f64>,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogBatch {
    pub id: String,
    /// server | manager | steamcmd
    pub source: String,
    pub lines: Vec<String>,
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerEvent {
    pub id: String,
    /// info | success | warn | error
    pub level: String,
    pub message: String,
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerEvent {
    pub id: String,
    pub name: String,
    /// join | leave
    pub kind: String,
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
    pub created_at: i64,
    pub label: String,
    pub kind: String,
    pub files: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFile {
    pub path: PathBuf,
    pub exists: bool,
    pub text: String,
    pub modified: Option<i64>,
    /// Text saved while the server ran – written once it exits.
    pub pending: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackManifest {
    pub format: u32,
    pub app_version: String,
    pub exported_at: i64,
    pub instance: ServerInstance,
    pub has_saves: bool,
    pub has_config: bool,
    pub includes_secrets: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagCheck {
    pub id: String,
    pub title: String,
    /// ok | warn | error | info
    pub level: String,
    pub detail: String,
    /// Fix the UI can trigger: firewall | install | validate | settings | admins | ports | update | log | rcon | ""
    pub fix: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub data_dir: PathBuf,
    pub portable: bool,
    pub app_id: u32,
    pub cores: usize,
    pub total_memory: u64,
    pub os: String,
    pub hostname: String,
    /// Secrets that couldn't be decrypted at load (portable folder moved to another PC/account).
    pub lost_secrets: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirs_resolve_relative_and_absolute() {
        let mut i = ServerInstance { install_dir: PathBuf::from(r"D:\srv\a"), ..Default::default() };
        assert_eq!(i.data_dir(), PathBuf::from(r"D:\srv\a\save-data"));
        assert_eq!(i.host_path(), PathBuf::from(r"D:\srv\a\save-data\Settings\ServerHostSettings.json"));
        assert_eq!(i.world_dir(), PathBuf::from(r"D:\srv\a\save-data\Saves\v4\world1"));
        assert_eq!(i.log_path(), PathBuf::from(r"D:\srv\a\logs\VRisingServer.log"));
        i.launch.data_dir = r"E:\vr\one".into();
        assert_eq!(i.data_dir(), PathBuf::from(r"E:\vr\one"));
        i.launch.data_dir = "".into();
        assert_eq!(i.data_dir(), PathBuf::from(r"D:\srv\a\save-data"));
        assert_eq!(i.udp_ports(), vec![9876, 9877]);
        assert_eq!(i.tcp_ports(), vec![25575]);
    }
}
