mod commands;
mod core;
mod error;
mod models;
mod paths;
mod state;

use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Helper-mode entry used by main.rs (`--send-ctrl-c <pid>`).
pub fn send_ctrl_c(pid: u32) -> i32 {
    core::proc::send_ctrl_c(pid)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second launch just focuses the running manager - two managers would fight over servers.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let loc = paths::resolve(app.handle())?;
            // The main window is created here (not from config) so a portable install can keep the
            // WebView2 profile inside its own folder instead of %LOCALAPPDATA%.
            let cfg = app.config().app.windows.iter().find(|w| w.label == "main").cloned().expect("main window config");
            let make = |data_dir: Option<std::path::PathBuf>| -> tauri::Result<tauri::WebviewWindow> {
                let mut builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &cfg)?;
                if let Some(d) = data_dir {
                    builder = builder.data_directory(d);
                }
                // Debug builds only: expose the WebView over CDP for automated UI testing.
                #[cfg(debug_assertions)]
                if let Ok(port) = std::env::var("VRSM_CDP_PORT") {
                    builder = builder.additional_browser_args(&format!(
                        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"
                    ));
                }
                builder.build()
            };
            let profile = loc.portable.then(|| loc.dir.join("webview"));
            // A WebView2 left over from a crashed/killed run keeps the profile locked: the next
            // window either hangs blank or fails with "resource is in use". Clear orphans first
            // (cheap process scan; WMI only when one is suspected), then fall back to a separate
            // recovery profile for this session – it only holds UI cache.
            if core::proc::orphan_webview_suspected() && core::proc::kill_orphaned_webviews() > 0 {
                std::thread::sleep(std::time::Duration::from_millis(600));
            }
            if let Err(e) = make(profile.clone()) {
                eprintln!("Window creation failed ({e}); retrying with a recovery WebView profile");
                core::proc::kill_orphaned_webviews();
                let base = match &profile {
                    Some(p) => p.clone(),
                    None => app.path().app_local_data_dir()?,
                };
                make(Some(base.join(format!("webview-recovery-{}", std::process::id()))))?;
            } else {
                // Normal start: drop recovery profiles from earlier sessions (best effort).
                let base = match &profile {
                    Some(p) => Some(p.clone()),
                    None => app.path().app_local_data_dir().ok(),
                };
                if let Some(Ok(rd)) = base.map(std::fs::read_dir) {
                    for e in rd.flatten().filter(|e| e.file_name().to_string_lossy().starts_with("webview-recovery-")) {
                        let _ = std::fs::remove_dir_all(e.path());
                    }
                }
            }
            app.manage(Arc::new(state::AppState::load(loc.dir, loc.portable)));

            let title = MenuItem::with_id(app, "title", "V Rising Server Manager", false, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Open", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit (servers keep running)", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&title, &sep, &show, &quit])?;
            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().cloned().expect("icon"))
                .tooltip("V Rising Server Manager")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id().as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            // Started by Windows at login with --minimized: stay in the tray, automation still runs.
            if !std::env::args().any(|a| a == "--minimized") {
                show_main(app.handle());
            }
            core::supervisor::spawn(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Window close (X, Alt+F4, taskbar): the UI decides - tray or quit.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.emit("app://close-requested", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_info,
            commands::get_settings,
            commands::save_settings,
            commands::cancel_task,
            commands::test_webhook,
            commands::app_quit,
            commands::window_hide,
            commands::probe_folder,
            commands::list_instances,
            commands::get_statuses,
            commands::suggest_ports,
            commands::create_instance,
            commands::update_instance,
            commands::validate_config,
            commands::reorder_instances,
            commands::delete_instance,
            commands::clone_instance,
            commands::find_existing_installs,
            commands::import_existing,
            commands::install_server,
            commands::check_update,
            commands::start_server,
            commands::stop_server,
            commands::restart_server,
            commands::cancel_deferred,
            commands::get_launch_line,
            commands::set_console_visible,
            commands::clear_crash_state,
            commands::query_server,
            commands::read_config,
            commands::write_config,
            commands::list_config_history,
            commands::read_text_file,
            commands::list_presets,
            commands::read_preset,
            commands::get_access,
            commands::set_access,
            commands::rcon_command,
            commands::announce,
            commands::kick_player,
            commands::read_log_tail,
            commands::list_log_files,
            commands::list_worlds,
            commands::list_local_worlds,
            commands::scan_world_folder,
            commands::import_world,
            commands::restore_autosave,
            commands::export_world,
            commands::duplicate_world,
            commands::delete_world,
            commands::reset_world,
            commands::activate_world,
            commands::metrics_history,
            commands::event_history,
            commands::player_sessions,
            commands::known_players,
            commands::build_history,
            commands::create_backup,
            commands::list_backups,
            commands::get_backup_dir,
            commands::restore_backup,
            commands::delete_backup,
            commands::export_pack,
            commands::read_pack,
            commands::import_pack,
            commands::firewall_state,
            commands::add_firewall_rules,
            commands::remove_firewall_rules,
            commands::net_info,
            commands::steam_listing,
            commands::upnp_probe,
            commands::upnp_map,
            commands::upnp_unmap,
            commands::run_diagnostics,
            commands::disk_usage,
            commands::rename_world,
            commands::check_world,
            commands::verify_backup,
            commands::list_rule_presets,
            commands::save_rule_preset,
            commands::delete_rule_preset,
        ])
        .run(tauri::generate_context!())
        .expect("error while running V Rising Server Manager");
}
