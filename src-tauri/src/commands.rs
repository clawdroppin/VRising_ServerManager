//! Every `#[tauri::command]`. Thin wrappers that delegate to `core::*`.

use crate::core::history::{EventRow, MetricRow, PlayerSummary, SessionRow};
use crate::core::{backup, config, diagnostics, network, presets, proc, secrets, server, steamcmd, supervisor, worlds};
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::state::{manager_log, now_ms, AppState};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

type St<'a> = State<'a, Arc<AppState>>;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| AppError::msg(e.to_string()))?
}

/// Run a long job in the background; errors become toasts. Returns immediately.
fn background<F>(app: &AppHandle, id: &str, what: &'static str, fut: F)
where
    F: std::future::Future<Output = AppResult<()>> + Send + 'static,
{
    let (app2, id) = (app.clone(), id.to_string());
    tauri::async_runtime::spawn(async move {
        if let Err(e) = fut.await {
            crate::state::notify(&app2, &id, "error", format!("{what} failed: {e}"));
        }
    });
}

fn require_stopped(inst: &ServerInstance) -> AppResult<()> {
    let (_, main) = server::running_pids(inst);
    if main.is_some() {
        return Err(AppError::msg("Stop the server first – it has these files open while running."));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------- app

#[tauri::command]
pub async fn get_app_info(state: St<'_>) -> AppResult<AppInfo> {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.refresh_cpu_list(sysinfo::CpuRefreshKind::nothing());
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        data_dir: state.data_dir.clone(),
        portable: state.portable,
        app_id: SERVER_APP_ID,
        cores: sys.cpus().len(),
        total_memory: sys.total_memory(),
        os: sysinfo::System::long_os_version().unwrap_or_else(|| "Windows".into()),
        hostname: sysinfo::System::host_name().unwrap_or_default(),
        lost_secrets: state.lost_secrets.clone(),
    })
}

#[tauri::command]
pub async fn get_settings(state: St<'_>) -> AppResult<AppSettings> {
    Ok(state.settings.read().await.clone())
}

#[tauri::command]
pub async fn save_settings(state: St<'_>, settings: AppSettings) -> AppResult<()> {
    let mut s = settings;
    s.last_data_dir = Some(state.data_dir.clone());
    s.metrics_retention_days = s.metrics_retention_days.clamp(1, 365);
    *state.settings.write().await = s;
    state.persist_settings().await
}

#[tauri::command]
pub async fn test_webhook(state: St<'_>, url: String) -> AppResult<()> {
    crate::state::send_webhook(&state.http, url.trim(), "success", "", "Test message from V Rising Server Manager \u{2013} notifications work!").await
}

#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn window_hide(window: tauri::WebviewWindow) {
    let _ = window.hide();
}

#[tauri::command]
pub async fn cancel_task(state: St<'_>, task_id: String) -> AppResult<()> {
    if let Some(f) = state.cancels.lock().await.get(&task_id) {
        f.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderProbe {
    exists: bool,
    writable: bool,
    empty: bool,
    has_server: bool,
    free_bytes: Option<u64>,
}

#[tauri::command]
pub async fn probe_folder(path: String) -> AppResult<FolderProbe> {
    blocking(move || {
        let p = PathBuf::from(&path);
        let exists = p.exists();
        let empty = !exists || std::fs::read_dir(&p).map(|mut r| r.next().is_none()).unwrap_or(true);
        let has_server = resolve_server_exe(&p).exists();
        let probe_dir = if exists { p.clone() } else { p.ancestors().find(|a| a.exists()).map(|a| a.to_path_buf()).unwrap_or(p.clone()) };
        let t = probe_dir.join(format!(".vrsm-{}", uuid::Uuid::new_v4()));
        let writable = std::fs::write(&t, b"").is_ok();
        let _ = std::fs::remove_file(&t);
        let disks = sysinfo::Disks::new_with_refreshed_list();
        let n = proc::norm(&probe_dir);
        let free_bytes = disks
            .iter()
            .filter(|d| n.starts_with(&proc::norm(d.mount_point())))
            .max_by_key(|d| d.mount_point().as_os_str().len())
            .map(|d| d.available_space());
        Ok(FolderProbe { exists, writable, empty, has_server, free_bytes })
    })
    .await
}

// ---------------------------------------------------------------------------------- instances

#[tauri::command]
pub async fn list_instances(state: St<'_>) -> AppResult<Vec<ServerInstance>> {
    Ok(state.instances.read().await.clone())
}

#[tauri::command]
pub async fn get_statuses(state: St<'_>) -> AppResult<Vec<ServerStatus>> {
    let list = state.instances.read().await.clone();
    let mut out = vec![];
    for i in &list {
        out.push(state.status(i).await);
    }
    Ok(out)
}

#[tauri::command]
pub async fn suggest_ports(state: St<'_>, exclude_id: Option<String>) -> AppResult<network::PortSet> {
    let list = state.instances.read().await.clone();
    Ok(network::suggest_ports(&list, exclude_id.as_deref()).await)
}

fn ports_clash(list: &[ServerInstance], inst: &ServerInstance) -> bool {
    let mine: Vec<u16> = inst.udp_ports().into_iter().chain(inst.tcp_ports()).collect();
    list.iter().filter(|o| o.id != inst.id).any(|o| o.udp_ports().iter().chain(o.tcp_ports().iter()).any(|p| mine.contains(p)))
}

async fn assign_free_ports(state: &AppState, inst: &mut ServerInstance) {
    let list = state.instances.read().await.clone();
    if inst.config.port == 0 || inst.config.query_port == 0 || ports_clash(&list, inst) {
        let p = network::suggest_ports(&list, Some(&inst.id)).await;
        inst.config.port = p.port;
        inst.config.query_port = p.query_port;
        inst.config.rcon_port = p.rcon_port;
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInput {
    name: String,
    install_dir: Option<PathBuf>,
    color: Option<String>,
    config: ServerConfig,
    install_now: bool,
    template_id: Option<String>,
}

/// Folders must be absolute – a relative path would resolve against wherever the app (or
/// SteamCMD, which then silently falls back to its own library) happens to run.
fn abs_dir(p: PathBuf) -> AppResult<PathBuf> {
    let s = p.to_string_lossy().trim().replace('/', "\\").trim_end_matches('\\').to_string();
    let s = if s.len() == 2 && s.ends_with(':') { format!("{s}\\") } else { s };
    let p = PathBuf::from(&s);
    if !p.is_absolute() {
        return Err(AppError::msg(format!("“{s}” isn't a full folder path – use something like D:\\VRisingServers\\MyServer.")));
    }
    Ok(p)
}

fn slug(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let s = s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    if s.is_empty() {
        "server".into()
    } else {
        s.chars().take(40).collect()
    }
}

async fn unique_dir(state: &AppState, name: &str) -> PathBuf {
    let root = state.default_install_root().await;
    let base = slug(name);
    let mut p = root.join(&base);
    let mut n = 2;
    let used: Vec<String> = state.instances.read().await.iter().map(|i| proc::norm(&i.install_dir)).collect();
    while p.exists() && std::fs::read_dir(&p).map(|mut r| r.next().is_some()).unwrap_or(false) || used.contains(&proc::norm(&p)) {
        p = root.join(format!("{base}-{n}"));
        n += 1;
    }
    p
}

async fn add_instance(state: &AppState, inst: ServerInstance) -> AppResult<ServerInstance> {
    {
        let mut list = state.instances.write().await;
        if list.iter().any(|i| proc::norm(&i.install_dir) == proc::norm(&inst.install_dir)) {
            return Err(AppError::msg("Another server profile already uses that folder."));
        }
        list.push(inst.clone());
    }
    state.persist_instances().await?;
    Ok(inst)
}

/// RCON gets a strong random password when it's on without one (a fresh profile).
fn fill_passwords(c: &mut ServerConfig) {
    if c.rcon_password.is_empty() {
        c.rcon_password = secrets::random_password(16);
    }
}

/// A server folder that already has a data folder (ours, or the server's default under LocalLow
/// when it was run by hand) keeps using it.
fn detect_data_dir(inst: &mut ServerInstance) {
    if inst.data_dir().join("Settings").exists() || inst.data_dir().join("Saves").exists() {
        return;
    }
    if let Some(home) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        let def = home.join("AppData").join("LocalLow").join("Stunlock Studios").join("VRisingServer");
        if def.join("Saves").exists() || def.join("Settings").exists() {
            inst.launch.data_dir = def.to_string_lossy().into_owned();
        }
    }
}

#[tauri::command]
pub async fn create_instance(app: AppHandle, state: St<'_>, input: CreateInput) -> AppResult<ServerInstance> {
    let name = if input.name.trim().is_empty() { "V Rising Server".to_string() } else { input.name.trim().to_string() };
    let mut inst = match &input.template_id {
        Some(t) => state.instance(t).await?,
        None => ServerInstance::default(),
    };
    inst.id = uuid::Uuid::new_v4().to_string();
    inst.name = name.clone();
    inst.created_at = now_ms();
    inst.color = input.color.unwrap_or_else(|| "blood".into());
    inst.install_dir = match input.install_dir {
        Some(d) if !d.as_os_str().is_empty() => abs_dir(d)?,
        _ => unique_dir(&state, &name).await,
    };
    inst.config = input.config;
    assign_free_ports(&state, &mut inst).await;
    std::fs::create_dir_all(&inst.install_dir)?;
    // An install that already has settings in the chosen folder keeps its world and gameplay rules.
    if inst.host_path().exists() {
        let mut probe = inst.config.clone();
        if config::read_files_into(&inst, &mut probe).is_ok() {
            inst.config.save_name = probe.save_name;
            inst.config.game_settings = probe.game_settings;
        }
    }
    fill_passwords(&mut inst.config);
    config::ensure_valid(&inst.config)?;
    if inst.is_installed() {
        let _ = config::sync(&inst);
    }
    let inst = add_instance(&state, inst).await?;
    if input.install_now {
        let (st, app2, id) = (state.inner().clone(), app.clone(), inst.id.clone());
        background(&app, &inst.id, "Install", async move { server::update_job(&st, &app2, &id, false).await });
    }
    state.emit_status(&app, &inst.id).await;
    Ok(inst)
}

#[tauri::command]
pub async fn update_instance(app: AppHandle, state: St<'_>, instance: ServerInstance) -> AppResult<ServerInstance> {
    let old = state.instance(&instance.id).await?;
    let mut inst = instance;
    inst.install_dir = abs_dir(inst.install_dir)?;
    inst.config.max_connected_users = inst.config.max_connected_users.clamp(1, MAX_USERS);
    if inst.config.port == 0 || inst.config.query_port == 0 {
        return Err(AppError::msg("Ports can't be 0."));
    }
    config::ensure_valid(&inst.config)?;
    if proc::norm(&old.install_dir) != proc::norm(&inst.install_dir) {
        require_stopped(&old).map_err(|_| AppError::msg("Stop the server before changing its folder."))?;
    }
    state.put_instance(&inst).await?;
    let build = steamcmd::local_build(&inst.install_dir);
    state.with_runtime(&inst.id, |r| r.installed_build = build).await;
    let (_, main) = server::running_pids(&inst);
    let restart_needed = old.config != inst.config || old.launch.extra_args != inst.launch.extra_args || old.launch.data_dir != inst.launch.data_dir;
    match main {
        Some(pid) => {
            // Priority / affinity / console visibility apply live; the config at the next start.
            if old.launch.priority != inst.launch.priority || old.launch.affinity != inst.launch.affinity {
                let _ = proc::apply_priority_affinity(pid, &inst.launch.priority, &inst.launch.affinity);
            }
            if old.launch.show_console != inst.launch.show_console {
                let (pids, _) = server::running_pids(&inst);
                proc::set_console_visible(&pids, inst.launch.show_console);
                state.with_runtime(&inst.id, |r| r.console_hidden = !inst.launch.show_console).await;
            }
            // Name, description and join password can change live over RCON.
            let all_live = restart_needed && apply_live(&app, &state, &old, &inst).await;
            if restart_needed && !all_live {
                state.with_runtime(&inst.id, |r| r.pending_restart = true).await;
            }
            if restart_needed {
                // The server reads its files only at start – write them now so they're ready (and
                // so live changes survive the next restart).
                let i2 = inst.clone();
                blocking(move || config::sync(&i2)).await?;
            }
        }
        None => {
            if inst.is_installed() || inst.host_path().exists() {
                let i2 = inst.clone();
                blocking(move || config::sync(&i2)).await?;
            }
        }
    }
    if old.config != inst.config {
        state.history.event(Some(&inst.id), "info", "config", "Server settings changed");
    }
    state.emit_status(&app, &inst.id).await;
    let _ = app.emit("instances-changed", ());
    Ok(inst)
}

/// Push the settings the running server can change without a restart (`name`, `description`,
/// `password` over RCON). True when that covers every change between `old` and `new`.
async fn apply_live(app: &AppHandle, state: &AppState, old: &ServerInstance, new: &ServerInstance) -> bool {
    let (o, n) = (&old.config, &new.config);
    // RCON as the running server knows it (the old settings).
    if !o.rcon_enabled || o.rcon_password.is_empty() {
        return false;
    }
    let mut rest = o.clone();
    rest.name = n.name.clone();
    rest.description = n.description.clone();
    rest.password = n.password.clone();
    let only_live = rest == *n && old.launch.extra_args == new.launch.extra_args && old.launch.data_dir == new.launch.data_dir;
    use crate::core::rcon::quote_arg;
    let mut cmds: Vec<(&str, Option<String>)> = vec![];
    if o.name != n.name {
        cmds.push(("name", quote_arg(&n.name).map(|v| format!("name {v}"))));
    }
    // Multi-line descriptions only apply in full from the file.
    if o.description != n.description {
        cmds.push(("description", quote_arg(&n.description).filter(|_| !n.description.contains('\n')).map(|v| format!("description {v}"))));
    }
    if o.password != n.password {
        cmds.push(("password", if n.password.is_empty() { Some("password --clear".to_string()) } else { quote_arg(&n.password).filter(|v| v.len() - 2 == n.password.len()).map(|v| format!("password {v}")) }));
    }
    if cmds.is_empty() {
        return only_live;
    }
    let mut all_ok = true;
    for (what, cmd) in cmds {
        let Some(cmd) = cmd else {
            all_ok = false;
            continue;
        };
        match server::rcon_exec(state, old, &cmd).await {
            Ok(_) => manager_log(app, &new.id, format!("Applied the new server {what} live (RCON).")),
            Err(e) => {
                manager_log(app, &new.id, format!("Couldn't apply the {what} live ({e}) – it applies at the next restart."));
                all_ok = false;
            }
        }
    }
    all_ok && only_live
}

#[tauri::command]
pub async fn validate_config(config: ServerConfig) -> AppResult<Vec<config::Issue>> {
    Ok(config::validate(&config))
}

#[tauri::command]
pub async fn reorder_instances(state: St<'_>, ids: Vec<String>) -> AppResult<()> {
    {
        let mut list = state.instances.write().await;
        list.sort_by_key(|i| ids.iter().position(|x| x == &i.id).unwrap_or(usize::MAX));
    }
    state.persist_instances().await
}

#[tauri::command]
pub async fn delete_instance(app: AppHandle, state: St<'_>, id: String, delete_files: bool) -> AppResult<()> {
    let inst = state.instance(&id).await?;
    let (_, main) = server::running_pids(&inst);
    if main.is_some() {
        server::stop(&state, &app, &id, false).await?;
    }
    state.instances.write().await.retain(|i| i.id != id);
    state.persist_instances().await?;
    state.runtime.lock().await.remove(&id);
    state.history.forget(&id);
    if delete_files && inst.install_dir.exists() {
        // Keep backups: they live inside the folder by default, so move them out first.
        let dir = inst.install_dir.clone();
        let keep = state.data_dir.join("deleted-server-backups").join(&id);
        blocking(move || {
            let bk = dir.join("Backups");
            if bk.exists() {
                std::fs::create_dir_all(keep.parent().unwrap())?;
                let _ = std::fs::rename(&bk, &keep);
            }
            std::fs::remove_dir_all(&dir)?;
            Ok(())
        })
        .await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn clone_instance(state: St<'_>, id: String, name: String, copy_saves: bool) -> AppResult<ServerInstance> {
    let src = state.instance(&id).await?;
    let mut inst = src.clone();
    inst.id = uuid::Uuid::new_v4().to_string();
    inst.name = if name.trim().is_empty() { format!("{} (copy)", src.name) } else { name.trim().to_string() };
    inst.config.name = inst.name.clone();
    inst.created_at = now_ms();
    inst.install_dir = unique_dir(&state, &inst.name).await;
    inst.launch.data_dir = "./save-data".into();
    inst.config.port = 0;
    assign_free_ports(&state, &mut inst).await;
    // A fresh RCON password: the copy is a different server.
    inst.config.rcon_password = secrets::random_password(16);
    let (s2, d2) = (src.clone(), inst.clone());
    blocking(move || {
        std::fs::create_dir_all(d2.settings_dir())?;
        // Start from the original's settings files (unknown keys, admin and ban lists).
        if s2.settings_dir().exists() {
            for e in std::fs::read_dir(s2.settings_dir())?.flatten().filter(|e| e.path().is_file()) {
                std::fs::copy(e.path(), d2.settings_dir().join(e.file_name()))?;
            }
        }
        if copy_saves && s2.saves_dir().exists() {
            std::fs::create_dir_all(d2.saves_dir())?;
            for w in worlds::list(&s2).into_iter().filter(|w| w.version == SAVE_VERSION_DIR) {
                worlds::export(&s2, &w.version, &w.name, &d2.saves_dir())?;
            }
        }
        if d2.is_installed() || d2.host_path().exists() {
            config::sync(&d2)?;
        }
        Ok(())
    })
    .await?;
    add_instance(&state, inst).await
}

#[tauri::command]
pub async fn find_existing_installs(state: St<'_>) -> AppResult<Vec<PathBuf>> {
    let known: Vec<String> = state.instances.read().await.iter().map(|i| proc::norm(&i.install_dir)).collect();
    Ok(steamcmd::find_steam_client_installs().await.into_iter().filter(|p| !known.contains(&proc::norm(p))).collect())
}

#[tauri::command]
pub async fn import_existing(app: AppHandle, state: St<'_>, path: PathBuf, name: Option<String>) -> AppResult<ServerInstance> {
    let path = abs_dir(path)?;
    if !resolve_server_exe(&path).exists() {
        return Err(AppError::msg("No V Rising dedicated server found in that folder (looked for VRisingServer.exe)."));
    }
    let mut inst = ServerInstance { id: uuid::Uuid::new_v4().to_string(), created_at: now_ms(), install_dir: path.clone(), ..Default::default() };
    detect_data_dir(&mut inst);
    config::reload(&mut inst)?;
    inst.name = name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| inst.config.name.clone());
    assign_free_ports(&state, &mut inst).await;
    if inst.config.rcon_enabled && inst.config.rcon_password.is_empty() {
        fill_passwords(&mut inst.config);
    }
    let inst = add_instance(&state, inst).await?;
    let build = steamcmd::local_build(&inst.install_dir);
    state.with_runtime(&inst.id, |r| r.installed_build = build).await;
    state.emit_status(&app, &inst.id).await;
    Ok(inst)
}

// ---------------------------------------------------------------------------------- lifecycle

#[tauri::command]
pub async fn install_server(app: AppHandle, state: St<'_>, id: String, validate: bool) -> AppResult<()> {
    let st = state.inner().clone();
    let (app2, id2) = (app.clone(), id.clone());
    background(&app, &id, if validate { "Validate" } else { "Update" }, async move { server::update_job(&st, &app2, &id2, validate).await });
    Ok(())
}

#[tauri::command]
pub async fn check_update(app: AppHandle, state: St<'_>, id: String) -> AppResult<bool> {
    let st = state.inner().clone();
    state.latest_build_cache.lock().await.clear();
    supervisor::check_update(&st, &app, &id, false).await
}

#[tauri::command]
pub async fn start_server(app: AppHandle, state: St<'_>, id: String) -> AppResult<()> {
    state.with_runtime(&id, |r| r.crash_loop = false).await;
    server::start(&state, &app, &id).await
}

#[tauri::command]
pub async fn stop_server(app: AppHandle, state: St<'_>, id: String, force: bool) -> AppResult<()> {
    let st = state.inner().clone();
    let (app2, id2) = (app.clone(), id.clone());
    // Graceful stops take a few seconds (world save) – return at once, status events follow.
    background(&app, &id, "Stop", async move { server::stop(&st, &app2, &id2, force).await });
    Ok(())
}

/// `warn_mins`: announce the restart over RCON and wait this long first (cancellable).
#[tauri::command]
pub async fn restart_server(app: AppHandle, state: St<'_>, id: String, update: bool, warn_mins: Option<u32>) -> AppResult<()> {
    let st = state.inner().clone();
    let (app2, id2) = (app.clone(), id.clone());
    if state.with_runtime(&id, |r| r.countdown.is_some()).await {
        return Err(AppError::msg("A restart countdown is already running."));
    }
    background(&app, &id, "Restart", async move {
        if let Some(m) = warn_mins.filter(|m| *m > 0) {
            if !server::countdown(&st, &app2, &id2, if update { "update" } else { "restart" }, m).await {
                return Ok(());
            }
        }
        server::restart(&st, &app2, &id2, update).await
    });
    Ok(())
}

#[tauri::command]
pub async fn cancel_deferred(app: AppHandle, state: St<'_>, id: String) -> AppResult<()> {
    state
        .with_runtime(&id, |r| {
            r.waiting_empty = None;
            r.countdown = None;
        })
        .await;
    manager_log(&app, &id, "Cancelled the pending automatic action.");
    state.emit_status(&app, &id).await;
    Ok(())
}

#[tauri::command]
pub async fn get_launch_line(state: St<'_>, id: String) -> AppResult<String> {
    Ok(server::launch_line(&state.instance(&id).await?))
}

#[tauri::command]
pub async fn set_console_visible(state: St<'_>, id: String, visible: bool) -> AppResult<usize> {
    let inst = state.instance(&id).await?;
    let (pids, _) = server::running_pids(&inst);
    state.with_runtime(&id, |r| r.console_hidden = !visible).await;
    Ok(proc::set_console_visible(&pids, visible))
}

#[tauri::command]
pub async fn clear_crash_state(app: AppHandle, state: St<'_>, id: String) -> AppResult<()> {
    state
        .with_runtime(&id, |r| {
            r.crash_loop = false;
            r.crash_times.clear();
            r.restart_at = None;
            if r.state == Some(ServerState::Crashed) {
                r.state = Some(ServerState::Stopped);
            }
        })
        .await;
    state.emit_status(&app, &id).await;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    info: Option<crate::core::a2s::A2sInfo>,
    players: Vec<crate::core::a2s::A2sPlayer>,
}

/// Ask the server what it tells the Steam browser (A2S) – on this PC, or at an address.
#[tauri::command]
pub async fn query_server(state: St<'_>, id: String, address: Option<String>) -> AppResult<QueryResult> {
    use crate::core::a2s;
    let inst = state.instance(&id).await?;
    let addr: std::net::SocketAddr = match address.filter(|a| !a.trim().is_empty()) {
        Some(a) => {
            // "host" alone means the server's query port.
            let a = a.trim();
            let target = if a.parse::<std::net::SocketAddr>().is_ok() || (a.matches(':').count() == 1 && !a.ends_with(':')) { a.to_string() } else { format!("{a}:{}", inst.config.query_port) };
            let found = tokio::net::lookup_host(target.clone()).await.map_err(|e| AppError::msg(format!("Couldn't resolve {target}: {e}")))?.next();
            found.ok_or_else(|| AppError::msg("Address not found"))?
        }
        None => a2s::local_addr(&inst.config.address, inst.config.query_port),
    };
    let t = std::time::Duration::from_secs(3);
    let info = a2s::info(addr, t).await;
    let players = if info.is_some() { a2s::players(addr, t).await.unwrap_or_default() } else { vec![] };
    Ok(QueryResult { info, players })
}

// ------------------------------------------------------------------------------------- config

/// The files the Config Files view edits: host | game | admins | bans.
fn config_file(inst: &ServerInstance, file: &str) -> AppResult<(PathBuf, PathBuf)> {
    Ok(match file {
        "host" => (inst.host_path(), config::host_template(inst)),
        "game" => (inst.game_path(), config::game_template(inst)),
        "admins" => (inst.admin_path(), PathBuf::new()),
        "bans" => (inst.ban_path(), PathBuf::new()),
        _ => return Err(AppError::msg("Unknown config file")),
    })
}

#[tauri::command]
pub async fn read_config(state: St<'_>, id: String, file: String) -> AppResult<ConfigFile> {
    let inst = state.instance(&id).await?;
    let (path, template) = config_file(&inst, &file)?;
    blocking(move || {
        let meta = std::fs::metadata(&path).ok();
        // A file the server hasn't got yet shows the shipped defaults it would use.
        let text = match std::fs::read(&path) {
            Ok(b) => String::from_utf8_lossy(&b).trim_start_matches('\u{feff}').to_string(),
            Err(_) => std::fs::read(&template).map(|b| String::from_utf8_lossy(&b).trim_start_matches('\u{feff}').to_string()).unwrap_or_default(),
        };
        Ok(ConfigFile {
            exists: meta.is_some(),
            modified: meta.and_then(|m| m.modified().ok()).map(|t| chrono::DateTime::<chrono::Utc>::from(t).timestamp_millis()),
            text,
            pending: false,
            path,
        })
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    /// The server is running: JSON changes apply at the next start (lists apply live).
    restart_needed: bool,
    instance: ServerInstance,
}

/// Save hand edits of a settings file. The profile follows the managed keys of the JSON files.
#[tauri::command]
pub async fn write_config(app: AppHandle, state: St<'_>, id: String, file: String, text: String) -> AppResult<WriteResult> {
    let mut inst = state.instance(&id).await?;
    let (path, _) = config_file(&inst, &file)?;
    let is_json = file == "host" || file == "game";
    let mut probe = inst.config.clone();
    if is_json {
        let doc = config::parse_doc(&text).map_err(|e| AppError::msg(format!("The text {e}")))?;
        if file == "host" {
            config::read_host(&doc, &mut probe);
        } else {
            probe.game_settings = config::flatten(&doc);
        }
        config::ensure_valid(&probe)?;
    } else {
        let bad: Vec<&str> = text.lines().map(|l| l.trim()).filter(|l| !l.is_empty() && !config::is_steam_id(l)).take(3).collect();
        if !bad.is_empty() {
            return Err(AppError::msg(format!("These lines aren't SteamID64s: {}", bad.join(", "))));
        }
    }
    let (p, t) = (path.clone(), text.clone());
    blocking(move || config::write_text(&p, &t)).await?;
    let (_, main) = server::running_pids(&inst);
    let restart_needed = is_json && main.is_some();
    if restart_needed {
        state.with_runtime(&id, |r| r.pending_restart = true).await;
    }
    if is_json {
        inst.config = probe;
        state.put_instance(&inst).await?;
        let _ = app.emit("instances-changed", ());
    } else {
        let _ = app.emit("access-changed", &id);
    }
    state.emit_status(&app, &id).await;
    Ok(WriteResult { restart_needed, instance: inst })
}

#[tauri::command]
pub async fn list_config_history(state: St<'_>, id: String, file: String) -> AppResult<Vec<(String, i64)>> {
    let inst = state.instance(&id).await?;
    let (path, _) = config_file(&inst, &file)?;
    let dir = config::history_dir(&path);
    let prefix = format!("{}.", path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default());
    blocking(move || {
        let mut v: Vec<(String, i64)> = std::fs::read_dir(&dir)
            .map(|rd| {
                rd.flatten()
                    .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
                    .map(|e| {
                        let t = e.metadata().ok().and_then(|m| m.modified().ok()).map(|t| chrono::DateTime::<chrono::Utc>::from(t).timestamp_millis()).unwrap_or(0);
                        (e.path().to_string_lossy().into_owned(), t)
                    })
                    .collect()
            })
            .unwrap_or_default();
        v.sort_by(|a, b| b.1.cmp(&a.1));
        Ok(v)
    })
    .await
}

#[tauri::command]
pub async fn read_text_file(state: St<'_>, id: String, path: PathBuf) -> AppResult<String> {
    let inst = state.instance(&id).await?;
    if !proc::is_within(&path, &inst.install_dir) && !proc::is_within(&path, &inst.data_dir()) {
        return Err(AppError::msg("That file is outside the server's folders."));
    }
    blocking(move || Ok(String::from_utf8_lossy(&std::fs::read(&path)?).into_owned())).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Presets {
    settings: Vec<String>,
    difficulty: Vec<String>,
}

/// The game-settings and difficulty presets shipped with the installed server.
#[tauri::command]
pub async fn list_presets(state: St<'_>, id: String) -> AppResult<Presets> {
    let inst = state.instance(&id).await?;
    Ok(Presets { settings: config::list_presets(&inst.presets_dir()), difficulty: config::list_presets(&inst.difficulty_presets_dir()) })
}

/// What a preset sets, flattened like the profile's game settings (`kind`: settings | difficulty).
#[tauri::command]
pub async fn read_preset(state: St<'_>, id: String, kind: String, name: String) -> AppResult<std::collections::BTreeMap<String, serde_json::Value>> {
    let inst = state.instance(&id).await?;
    let dir = if kind == "difficulty" { inst.difficulty_presets_dir() } else { inst.presets_dir() };
    if name.contains(['\\', '/', '.']) {
        return Err(AppError::msg("Invalid preset name"));
    }
    let doc = config::read_doc(&dir.join(format!("{name}.json")))?;
    Ok(config::flatten(&doc))
}

// ------------------------------------------------------------------------------ admins & bans

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessEntry {
    steam_id: String,
    /// Last character name seen with this id (player history).
    name: Option<String>,
    online: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessView {
    admins: Vec<AccessEntry>,
    bans: Vec<AccessEntry>,
}

#[tauri::command]
pub async fn get_access(state: St<'_>, id: String) -> AppResult<AccessView> {
    let inst = state.instance(&id).await?;
    let known = state.history.players(&id);
    let online: Vec<String> = state.with_runtime(&id, |r| r.online.values().filter_map(|o| o.steam_id.clone()).collect()).await;
    let entry = |sid: String| AccessEntry {
        name: known.iter().filter(|p| p.steam_id.as_deref() == Some(sid.as_str())).max_by_key(|p| p.last_seen).map(|p| p.name.clone()),
        online: online.contains(&sid),
        steam_id: sid,
    };
    let (a, b) = (inst.admin_path(), inst.ban_path());
    let (admins, bans) = blocking(move || Ok((config::read_list(&a), config::read_list(&b)))).await?;
    Ok(AccessView { admins: admins.into_iter().map(entry).collect(), bans: bans.into_iter().map(entry).collect() })
}

/// Add or remove a SteamID64 in adminlist.txt / banlist.txt. The running server reloads the
/// files within seconds (verified), so this applies live.
#[tauri::command]
pub async fn set_access(app: AppHandle, state: St<'_>, id: String, list: String, steam_id: String, add: bool) -> AppResult<bool> {
    let inst = state.instance(&id).await?;
    let path = match list.as_str() {
        "admins" => inst.admin_path(),
        "bans" => inst.ban_path(),
        _ => return Err(AppError::msg("Unknown list")),
    };
    let sid = steam_id.trim().to_string();
    let s2 = sid.clone();
    let changed = blocking(move || config::edit_list(&path, &s2, add)).await?;
    if changed {
        let what = match (list.as_str(), add) {
            ("admins", true) => "Admin added",
            ("admins", false) => "Admin removed",
            (_, true) => "Player banned",
            _ => "Player unbanned",
        };
        state.history.event(Some(&id), "info", "config", &format!("{what}: {sid}"));
        // A ban takes effect for new connections; kick the player now if they're online.
        if list == "bans" && add {
            let name = state.with_runtime(&id, |r| r.online.values().find(|o| o.steam_id.as_deref() == Some(sid.as_str())).map(|o| o.name.clone())).await;
            if let Some(n) = name.filter(|n| !n.is_empty()) {
                let _ = server::rcon_exec(&state, &inst, &format!("runcommand kick \"{n}\"")).await;
            }
        }
        let _ = app.emit("access-changed", &id);
    }
    Ok(changed)
}

// --------------------------------------------------------------------------------------- RCON

/// Run any RCON command (the Console view's command box).
#[tauri::command]
pub async fn rcon_command(app: AppHandle, state: St<'_>, id: String, command: String) -> AppResult<String> {
    let inst = state.instance(&id).await?;
    let cmd = command.trim();
    if cmd.is_empty() {
        return Err(AppError::msg("Type a command first."));
    }
    let out = server::rcon_exec(&state, &inst, cmd).await?;
    manager_log(&app, &id, format!("RCON> {cmd}"));
    Ok(out)
}

#[tauri::command]
pub async fn announce(app: AppHandle, state: St<'_>, id: String, message: String) -> AppResult<()> {
    let inst = state.instance(&id).await?;
    let msg = crate::core::rcon::clean_message(&message);
    if msg.is_empty() {
        return Err(AppError::msg("The message is empty."));
    }
    server::rcon_exec(&state, &inst, &format!("announce {msg}")).await?;
    manager_log(&app, &id, format!("Announced: {msg}"));
    Ok(())
}

/// Kick by character name through the server console (`runcommand kick`). The server gives no
/// feedback for console commands, so success means "sent".
#[tauri::command]
pub async fn kick_player(app: AppHandle, state: St<'_>, id: String, name: String) -> AppResult<()> {
    let inst = state.instance(&id).await?;
    let n = name.trim().replace('"', "");
    if n.is_empty() {
        return Err(AppError::msg("This player has no character name yet – ban their SteamID instead."));
    }
    server::rcon_exec(&state, &inst, &format!("runcommand kick \"{n}\"")).await?;
    manager_log(&app, &id, format!("Kick sent for {n}."));
    Ok(())
}

// ---------------------------------------------------------------------------------------- logs

#[tauri::command]
pub async fn read_log_tail(state: St<'_>, id: String, max_lines: usize) -> AppResult<Vec<String>> {
    let inst = state.instance(&id).await?;
    blocking(move || {
        let path = inst.log_path();
        let Ok(meta) = std::fs::metadata(&path) else { return Ok(vec![]) };
        use std::io::{Read, Seek, SeekFrom};
        let len = meta.len();
        let start = len.saturating_sub(1_048_576);
        let mut f = std::fs::File::open(&path)?;
        f.seek(SeekFrom::Start(start))?;
        let mut buf = vec![];
        f.read_to_end(&mut buf)?;
        let text = String::from_utf8_lossy(&buf);
        let lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
        let skip = lines.len().saturating_sub(max_lines.clamp(10, 20_000));
        Ok(lines[skip..].to_vec())
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFile {
    path: PathBuf,
    name: String,
    size: u64,
    modified: i64,
}

/// The current log plus the previous sessions kept in `logs\backup`.
#[tauri::command]
pub async fn list_log_files(state: St<'_>, id: String) -> AppResult<Vec<LogFile>> {
    let inst = state.instance(&id).await?;
    blocking(move || {
        let mut v: Vec<LogFile> = vec![];
        for dir in [inst.logs_dir(), inst.logs_dir().join("backup")] {
            let Ok(rd) = std::fs::read_dir(dir) else { continue };
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if !n.starts_with("VRisingServer") || !n.ends_with(".log") {
                    continue;
                }
                let Ok(m) = e.metadata() else { continue };
                v.push(LogFile {
                    name: n,
                    path: e.path(),
                    size: m.len(),
                    modified: m.modified().ok().map(|t| chrono::DateTime::<chrono::Utc>::from(t).timestamp_millis()).unwrap_or(0),
                });
            }
        }
        v.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(v)
    })
    .await
}

// -------------------------------------------------------------------------------------- worlds

#[tauri::command]
pub async fn list_worlds(state: St<'_>, id: String) -> AppResult<Vec<worlds::World>> {
    let inst = state.instance(&id).await?;
    blocking(move || Ok(worlds::list(&inst))).await
}

#[tauri::command]
pub async fn list_local_worlds() -> AppResult<Vec<worlds::LocalWorld>> {
    blocking(|| Ok(worlds::local_worlds())).await
}

/// Worlds in any folder the user picks (an old server's Saves folder, a copied world).
#[tauri::command]
pub async fn scan_world_folder(path: PathBuf) -> AppResult<Vec<worlds::World>> {
    blocking(move || Ok(worlds::scan_any(&path))).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    name: String,
    files: usize,
}

/// Copy a world in; `activate` makes it the one the server loads.
#[tauri::command]
pub async fn import_world(app: AppHandle, state: St<'_>, id: String, dir: PathBuf, name: String, adopt_settings: bool, activate: bool) -> AppResult<ImportResult> {
    let inst = state.instance(&id).await?;
    if activate || adopt_settings {
        require_stopped(&inst)?;
    }
    let i2 = inst.clone();
    let (world, files) = blocking(move || worlds::import(&i2, &dir, &name, adopt_settings)).await?;
    let mut updated = state.instance(&id).await?;
    if adopt_settings {
        config::reload(&mut updated)?;
    }
    if activate {
        updated.config.save_name = world.clone();
    }
    if activate || adopt_settings {
        state.put_instance(&updated).await?;
        let u2 = updated.clone();
        blocking(move || config::sync(&u2)).await?;
        let _ = app.emit("instances-changed", ());
    }
    crate::state::notify_kind(&app, &id, "success", "world", format!("Imported world “{world}” ({files} files){}", if activate { " – it loads on the next start" } else { "" }));
    Ok(ImportResult { name: world, files })
}

/// Make an older autosave the one the server loads next (copied to the next number).
#[tauri::command]
pub async fn restore_autosave(state: St<'_>, id: String, version: String, world: String, number: u32) -> AppResult<String> {
    let inst = state.instance(&id).await?;
    // Held so a start (button, schedule, crash restart) can't race the file changes.
    let lock = state.op_lock(&id).await;
    let _g = lock.lock().await;
    require_stopped(&inst)?;
    let _ = backup::create(&state, &inst, "Before autosave rollback", "auto").await;
    blocking(move || worlds::restore_autosave(&inst, &version, &world, number)).await
}

#[tauri::command]
pub async fn export_world(state: St<'_>, id: String, version: String, world: String, dest: PathBuf) -> AppResult<usize> {
    let inst = state.instance(&id).await?;
    blocking(move || worlds::export(&inst, &version, &world, &dest)).await
}

#[tauri::command]
pub async fn duplicate_world(state: St<'_>, id: String, version: String, world: String, new_name: String) -> AppResult<String> {
    let inst = state.instance(&id).await?;
    blocking(move || worlds::duplicate(&inst, &version, &world, &new_name)).await
}

#[tauri::command]
pub async fn delete_world(state: St<'_>, id: String, version: String, world: String) -> AppResult<()> {
    let inst = state.instance(&id).await?;
    if version == SAVE_VERSION_DIR && world.eq_ignore_ascii_case(inst.config.save_name.trim()) {
        require_stopped(&inst)?;
    }
    blocking(move || worlds::remove(&inst, &version, &world).map(|_| ())).await
}

#[tauri::command]
pub async fn reset_world(state: St<'_>, id: String) -> AppResult<Option<PathBuf>> {
    let inst = state.instance(&id).await?;
    let lock = state.op_lock(&id).await;
    let _g = lock.lock().await;
    require_stopped(&inst)?;
    let _ = backup::create(&state, &inst, "Before world reset", "auto").await;
    blocking(move || worlds::reset(&inst)).await
}

/// Switch the world the server loads (`SaveName`) – an existing world or a new name (created on
/// the next start).
#[tauri::command]
pub async fn activate_world(app: AppHandle, state: St<'_>, id: String, name: String) -> AppResult<ServerInstance> {
    let mut inst = state.instance(&id).await?;
    let name = worlds::check_name(&name)?.to_string();
    inst.config.save_name = name;
    let (_, main) = server::running_pids(&inst);
    state.put_instance(&inst).await?;
    if inst.is_installed() || inst.host_path().exists() {
        let i2 = inst.clone();
        blocking(move || config::sync(&i2)).await?;
    }
    if main.is_some() {
        state.with_runtime(&id, |r| r.pending_restart = true).await;
    }
    let _ = app.emit("instances-changed", ());
    state.emit_status(&app, &id).await;
    Ok(inst)
}

/// Rename a world. Renaming the active one moves `SaveName` along (server stopped).
#[tauri::command]
pub async fn rename_world(app: AppHandle, state: St<'_>, id: String, version: String, world: String, new_name: String) -> AppResult<String> {
    let inst = state.instance(&id).await?;
    let lock = state.op_lock(&id).await;
    let _g = lock.lock().await;
    let active = version == SAVE_VERSION_DIR && world.trim().eq_ignore_ascii_case(inst.config.save_name.trim());
    if active {
        require_stopped(&inst)?;
    }
    let i2 = inst.clone();
    let name = blocking(move || worlds::rename(&i2, &version, &world, &new_name)).await?;
    if active {
        let mut updated = state.instance(&id).await?;
        updated.config.save_name = name.clone();
        state.put_instance(&updated).await?;
        if updated.is_installed() || updated.host_path().exists() {
            blocking(move || config::sync(&updated)).await?;
        }
        let _ = app.emit("instances-changed", ());
        state.emit_status(&app, &id).await;
    }
    Ok(name)
}

/// Decompress every autosave of a world to find damaged ones.
#[tauri::command]
pub async fn check_world(state: St<'_>, id: String, version: String, world: String) -> AppResult<Vec<worlds::SaveCheck>> {
    let inst = state.instance(&id).await?;
    blocking(move || worlds::check_saves(&inst, &version, &world)).await
}

// ------------------------------------------------------------------------------ rule presets

#[tauri::command]
pub async fn list_rule_presets(state: St<'_>) -> AppResult<Vec<presets::RulePreset>> {
    Ok(presets::list(&state.data_dir))
}

#[tauri::command]
pub async fn save_rule_preset(state: St<'_>, name: String, settings: std::collections::BTreeMap<String, serde_json::Value>) -> AppResult<presets::RulePreset> {
    presets::save(&state.data_dir, &name, settings, now_ms())
}

#[tauri::command]
pub async fn delete_rule_preset(state: St<'_>, name: String) -> AppResult<()> {
    presets::delete(&state.data_dir, &name)
}

// ------------------------------------------------------------------------------------- history

#[tauri::command]
pub async fn metrics_history(state: St<'_>, id: String, since: i64) -> AppResult<Vec<MetricRow>> {
    Ok(state.history.metrics(&id, since))
}

#[tauri::command]
pub async fn event_history(state: St<'_>, id: Option<String>, limit: u32) -> AppResult<Vec<EventRow>> {
    Ok(state.history.events(id.as_deref(), limit.clamp(1, 2000)))
}

#[tauri::command]
pub async fn player_sessions(state: St<'_>, id: String, limit: u32) -> AppResult<Vec<SessionRow>> {
    Ok(state.history.sessions(&id, limit.clamp(1, 2000)))
}

#[tauri::command]
pub async fn known_players(state: St<'_>, id: String) -> AppResult<Vec<PlayerSummary>> {
    Ok(state.history.players(&id))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildRow {
    build_id: String,
    branch: String,
    ts: i64,
}

#[tauri::command]
pub async fn build_history(state: St<'_>, id: String) -> AppResult<Vec<BuildRow>> {
    Ok(state.history.builds(&id).into_iter().map(|(build_id, branch, ts)| BuildRow { build_id, branch, ts }).collect())
}

// ------------------------------------------------------------------------------------- backups

#[tauri::command]
pub async fn create_backup(app: AppHandle, state: St<'_>, id: String, label: String) -> AppResult<BackupInfo> {
    let inst = state.instance(&id).await?;
    state.set_busy(&app, &id, Some("Backing up")).await;
    let res = backup::create(&state, &inst, if label.trim().is_empty() { "Manual backup" } else { label.trim() }, "manual").await;
    state.set_busy(&app, &id, None).await;
    let b = res?;
    state.with_runtime(&id, |r| r.last_backup = b.created_at).await;
    let _ = app.emit("backup-created", &b);
    Ok(b)
}

#[tauri::command]
pub async fn list_backups(state: St<'_>, id: String) -> AppResult<Vec<BackupInfo>> {
    let inst = state.instance(&id).await?;
    let dir = state.backup_dir(&inst).await;
    blocking(move || Ok(backup::list(&dir))).await
}

#[tauri::command]
pub async fn get_backup_dir(state: St<'_>, id: String) -> AppResult<PathBuf> {
    let inst = state.instance(&id).await?;
    Ok(state.backup_dir(&inst).await)
}

#[tauri::command]
pub async fn restore_backup(app: AppHandle, state: St<'_>, id: String, path: PathBuf, include_config: bool) -> AppResult<u32> {
    let inst = state.instance(&id).await?;
    let lock = state.op_lock(&id).await;
    let _g = lock.lock().await;
    require_stopped(&inst)?;
    let dir = state.backup_dir(&inst).await;
    if !proc::is_within(&path, &dir) {
        return Err(AppError::msg("That backup isn't in this server's backup folder."));
    }
    // Safety net: snapshot what's there now.
    if inst.saves_root().exists() {
        let _ = backup::create(&state, &inst, "Before restore", "auto").await;
    }
    let i2 = inst.clone();
    let n = blocking(move || backup::restore(&i2, &path, include_config)).await?;
    if include_config {
        // The profile follows the restored settings files.
        let mut updated = inst.clone();
        if config::read_files_into(&inst, &mut updated.config).is_ok() {
            state.put_instance(&updated).await?;
            let _ = app.emit("instances-changed", ());
        }
    }
    manager_log(&app, &id, format!("Restored {n} files from backup."));
    crate::state::notify_kind(&app, &id, "success", "backup", format!("Restored {n} files from a backup"));
    Ok(n)
}

#[tauri::command]
pub async fn verify_backup(state: St<'_>, id: String, path: PathBuf) -> AppResult<backup::VerifyResult> {
    let inst = state.instance(&id).await?;
    let dir = state.backup_dir(&inst).await;
    if !proc::is_within(&path, &dir) {
        return Err(AppError::msg("That backup isn't in this server's backup folder."));
    }
    blocking(move || backup::verify(&path)).await
}

#[tauri::command]
pub async fn delete_backup(state: St<'_>, id: String, path: PathBuf) -> AppResult<()> {
    let inst = state.instance(&id).await?;
    let dir = state.backup_dir(&inst).await;
    if !proc::is_within(&path, &dir) {
        return Err(AppError::msg("That backup isn't in this server's backup folder."));
    }
    std::fs::remove_file(path)?;
    Ok(())
}

// --------------------------------------------------------------------------------------- packs

#[tauri::command]
pub async fn export_pack(state: St<'_>, id: String, dest: PathBuf, options: backup::PackOptions) -> AppResult<()> {
    let inst = state.instance(&id).await?;
    blocking(move || backup::export_pack(&inst, &dest, &options)).await
}

#[tauri::command]
pub async fn read_pack(path: PathBuf) -> AppResult<PackManifest> {
    blocking(move || backup::read_pack(&path)).await
}

#[tauri::command]
pub async fn import_pack(app: AppHandle, state: St<'_>, path: PathBuf, name: String, install_dir: Option<PathBuf>, install_now: bool) -> AppResult<ServerInstance> {
    let p2 = path.clone();
    let m = blocking(move || backup::read_pack(&p2)).await?;
    let mut inst = m.instance;
    inst.id = uuid::Uuid::new_v4().to_string();
    inst.created_at = now_ms();
    inst.name = if name.trim().is_empty() { inst.name } else { name.trim().to_string() };
    inst.install_dir = match install_dir {
        Some(d) if !d.as_os_str().is_empty() => abs_dir(d)?,
        _ => unique_dir(&state, &inst.name).await,
    };
    inst.launch.data_dir = "./save-data".into();
    assign_free_ports(&state, &mut inst).await;
    if inst.config.rcon_enabled {
        fill_passwords(&mut inst.config);
    }
    let i2 = inst.clone();
    blocking(move || {
        backup::unpack_into(&path, &i2)?;
        // The pack's settings files win for gameplay; the profile's ports/passwords are written over.
        let mut probe = i2.config.clone();
        if config::read_files_into(&i2, &mut probe).is_ok() {
            let mut merged = i2.clone();
            merged.config.game_settings = probe.game_settings;
            config::sync(&merged)?;
        } else {
            config::sync(&i2)?;
        }
        Ok(())
    })
    .await?;
    let inst = add_instance(&state, inst).await?;
    if install_now && !inst.is_installed() {
        let (st, app2, id) = (state.inner().clone(), app.clone(), inst.id.clone());
        background(&app, &inst.id, "Install", async move { server::update_job(&st, &app2, &id, false).await });
    }
    state.emit_status(&app, &inst.id).await;
    Ok(inst)
}

// ------------------------------------------------------------------------------------- network

#[tauri::command]
pub async fn firewall_state(state: St<'_>, id: String) -> AppResult<network::FirewallState> {
    let inst = state.instance(&id).await?;
    Ok(network::firewall_state(&inst).await)
}

#[tauri::command]
pub async fn add_firewall_rules(state: St<'_>, id: String) -> AppResult<()> {
    let inst = state.instance(&id).await?;
    let out = network::add_firewall_rules(&inst, &state.data_dir.join("tmp")).await?;
    if !out.contains("RULES_OK") {
        return Err(AppError::msg(format!("Windows didn't confirm the rules: {}", out.lines().filter(|l| l.contains("ERROR") || l.contains("Error")).collect::<Vec<_>>().join(" "))));
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_firewall_rules(state: St<'_>, id: String) -> AppResult<()> {
    let inst = state.instance(&id).await?;
    network::remove_firewall_rules(&inst, &state.data_dir.join("tmp")).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetInfo {
    public_ip: Option<String>,
    local: Vec<network::LocalIp>,
    gateway: Option<String>,
}

#[tauri::command]
pub async fn net_info(state: St<'_>) -> AppResult<NetInfo> {
    let (public_ip, gateway) = tokio::join!(network::public_ip(&state.http), network::default_gateway());
    let mut local = blocking(|| Ok(network::local_ips())).await?;
    // Put the adapter on the router's subnet first – that's the address to forward to.
    if let Some(gw) = &gateway {
        let prefix: String = gw.rsplitn(2, '.').nth(1).unwrap_or("").to_string() + ".";
        local.sort_by_key(|l| !l.ip.starts_with(&prefix));
    }
    Ok(NetInfo { public_ip, local, gateway })
}

/// Servers Steam lists at this PC's public IP – what the in-game Join list is built from.
#[tauri::command]
pub async fn steam_listing(state: St<'_>, id: String) -> AppResult<Vec<network::SteamListing>> {
    let ip = match state.with_runtime(&id, |r| r.public_ip.clone()).await {
        Some(ip) => ip,
        None => network::public_ip(&state.http).await.ok_or_else(|| AppError::msg("Couldn't find this PC's public IP."))?,
    };
    network::steam_listing(&state.http, &ip).await
}

#[tauri::command]
pub async fn upnp_probe(state: St<'_>) -> AppResult<crate::core::upnp::UpnpInfo> {
    Ok(crate::core::upnp::probe(&state.http).await)
}

#[tauri::command]
pub async fn upnp_map(app: AppHandle, state: St<'_>, id: String) -> AppResult<Vec<String>> {
    let inst = state.instance(&id).await?;
    let lines = crate::core::upnp::map_server(&inst).await?;
    manager_log(&app, &id, format!("UPnP: {}", lines.join(", ")));
    Ok(lines)
}

#[tauri::command]
pub async fn upnp_unmap(state: St<'_>, id: String) -> AppResult<()> {
    let inst = state.instance(&id).await?;
    crate::core::upnp::unmap_server(&inst).await
}

// --------------------------------------------------------------------------------- diagnostics

#[tauri::command]
pub async fn run_diagnostics(state: St<'_>, id: String) -> AppResult<Vec<DiagCheck>> {
    let inst = state.instance(&id).await?;
    Ok(diagnostics::run(&state, &inst).await)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    install: u64,
    saves: u64,
    backups: u64,
    logs: u64,
}

#[tauri::command]
pub async fn disk_usage(state: St<'_>, id: String) -> AppResult<DiskUsage> {
    let inst = state.instance(&id).await?;
    let bk = state.backup_dir(&inst).await;
    blocking(move || {
        let backups = backup::folder_size(&bk);
        let install = backup::folder_size(&inst.install_dir);
        let inside = proc::is_within(&bk, &inst.install_dir);
        Ok(DiskUsage {
            install: if inside { install.saturating_sub(backups) } else { install },
            saves: backup::folder_size(&inst.saves_root()),
            backups,
            logs: backup::folder_size(&inst.logs_dir()),
        })
    })
    .await
}
