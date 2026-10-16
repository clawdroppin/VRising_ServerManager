# AGENTS.md – hand-off guide for AI assistants and contributors

This is the hand-off document for **V Rising Server Manager**, a Windows desktop app that runs *V Rising* dedicated servers. Read it fully before changing code. `CLAUDE.md` points here. User-facing documentation lives in [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md); keep it in sync when behaviour changes.

The app shares its architecture with the sibling managers in `O:\ServerManagers` (it started as a copy of the Enshrouded manager); fixes to shared plumbing (supervisor loop, SteamCMD, backups, UPnP, secrets, UI kit) usually apply to both.

**Repository:** <https://github.com/clawdroppin/VRising_ServerManager>. The default branch is **`release`**; CI (`ci.yml`) runs on pushes to `release` and `main` and on pull requests.

### Before you start – the 60-second version

1. The server is configured **only** through files in `<data>\Settings` – never through command-line flags (§3.2). Edit managed keys, never whole files (§4).
2. **Never keep an RCON connection open** – it stops the server from exiting after its save (§3.6).
3. RCON commands that take one argument need it **quoted**, and errors come back as normal replies starting with `error:` (§3.9).
4. Every new backend command goes into `commands.rs` → `lib.rs` → `src/lib/ipc.ts` → `src/lib/devMock.ts` (§7).
5. Before you hand off: `cargo check` (no warnings), `cargo test --lib`, `npx tsc -p tsconfig.json --noEmit`. If you changed behaviour, update `docs/USER_GUIDE.md` and `CHANGELOG.md`.

## 1. Stack & commands

| Layer | Tech |
|---|---|
| Shell | Tauri 2: main window created in code, tray icon, single-instance, autostart and notification plugins |
| Backend | Rust 2021, tokio, reqwest, sysinfo, rusqlite (bundled), zip, regex, igd-next (UPnP), windows-sys (console, DPAPI) |
| Frontend | React 19, TypeScript 7, Vite 8 (dev port **1450**), Tailwind CSS 4, Motion, Zustand, CodeMirror 6, cmdk, lucide-react |

```bash
npm install
npm run tauri dev                      # full app, hot reload
npm run dev                            # UI only in a browser with the MOCK backend (src/lib/devMock.ts)
npx vite --port 1460                   # same, on another port (the .claude "ui-preview" config)
npx tsc -p tsconfig.json --noEmit      # typecheck
cd src-tauri && cargo check            # must stay warning-free (CI uses -D warnings)
cd src-tauri && cargo test --lib       # unit tests (config, RCON, A2S, log parsing, worlds, backups, history, DPAPI)
npm run build:all                      # NSIS + MSI + portable zip (local)
SHOTS_URL=http://localhost:1460/ node scripts/screenshots.mjs   # regenerate docs/screenshots (needs a dev server)
```

**Testing the real app.** `npx tauri build --debug --no-bundle`, put a `portable.txt` next to `src-tauri/target/debug/vrising-server-manager.exe` (keeps its data in `target/debug/data`), start it with `VRSM_CDP_PORT=9444` and drive the WebView over the Chrome DevTools Protocol (`window.__TAURI_INTERNALS__.invoke('command', args)`). The CDP hook is compiled into debug builds only. Don't use `tauri dev` for this – its rebuild kills the process tree, including servers you started.

**Real server installs** for testing go in the git-ignored `.test-server/` folder (SteamCMD: `+force_install_dir <abs path> +login anonymous +app_update 1829350 validate +quit`).

## 2. Repository map

```
src-tauri/src/
  main.rs            entry; helper mode `--send-ctrl-c <pid>` (graceful stop, §3)
  lib.rs             setup: data dir, orphaned-WebView recovery, window, tray, plugins, command list
  commands.rs        every #[tauri::command] (thin wrappers; add new ones to lib.rs + src/lib/ipc.ts + devMock.ts)
  state.rs           AppState, per-server Runtime, TaskReporter, notify()/notify_kind() (timeline + toast + webhook), safe JSON IO
  models.rs          persisted & event types (camelCase); SERVER_APP_ID, ServerConfig, path helpers
  paths.rs           installed vs portable data dir, path rebasing
  core/
    config.rs        ServerHostSettings.json + ServerGameSettings.json: lossless read-modify-write, flattened game
                     settings, admin/ban list files, validation
    server.rs        launch line, log rotation, start / stop / restart / update, rcon_exec, restart countdown
    supervisor.rs    single loop: process tracking/adoption, telemetry + per-minute history, log tail & parsing,
                     A2S polling, crash restart, schedules, countdown warnings, timed announcements,
                     wait-for-empty, idle stop, interval backups, update checks
    rcon.rs          Source RCON client (one connection per command – see §4)
    a2s.rs           Steam A2S INFO / PLAYER / RULES (player count, names, days running)
    worlds.rs        world folders (Saves\v4\<name>), autosave rollback, import / duplicate / rename / switch /
                     wipe, autosave integrity check (gunzip every save)
    backup.rs        zip backups (newest autosave per world + Settings), restore, verify, retention, .vrising packs
    presets.rs       the user's own game-rule presets (<app data>\rule-presets.json), shared by all servers
    history.rs       manager.db (SQLite): metrics, event timeline, player sessions (with SteamID), builds
    secrets.rs       DPAPI encryption of the join password, RCON password, branch password and webhook URL
    proc.rs          detached CreateProcessW launch (own hidden console), console break, priority/affinity,
                     console visibility, UDP/TCP port owners, is_within(), orphaned-WebView cleanup
    steamcmd.rs      bootstrap, app_update (beta branches), build ids (api.steamcmd.net, then SteamCMD)
    network.rs       firewall state/rules, IPs, gateway, port suggestions, Steam listing
    upnp.rs          UPnP IGD discovery, port mapping, router info, WAN address classification
    diagnostics.rs   health checks with fix ids
src/
  store/app.ts       Zustand store: instances, statuses, tabs, tasks, toasts, dialogs; onlineCount()
  lib/live.ts        ring buffers for telemetry & console, lineLevel()/isNoise() for V Rising log lines
  lib/ipc.ts         typed commands + event listen (mock-aware)   lib/types.ts mirrors models.rs
  lib/defaults.ts    default ServerConfig (mirrors ServerConfig::default)
  data/gameplay.ts   every ServerGameSettings key (defaults from the shipped file), groups, preset helpers
  features/server/   Workspace (header, nav, shared Save bar), draft.ts, views/*
  features/dialogs/  new-server wizard, import/export/clone/delete, app settings
scripts/             build-portable.mjs, screenshots.mjs
.github/workflows/   ci.yml (check on push/PR), release.yml (tag v* -> GitHub Release)
```

## 3. Verified facts about the server

Tested against a real install (Steam build **25169871**, `VRisingServer v1.1.15.0-r101082-b2`, October 2026). Re-verify after big game updates.

1. **AppID 1829350** installs anonymously (~300 MB download, ~2 GB on disk). The game client is **1604030** (Steam master list `appid`, `steam_appid.txt`). `VRisingServer.exe` is a Unity (IL2CPP) console program; string literals live in `VRisingServer_Data\il2cpp_data\Metadata\global-metadata.dat` – grep it for log formats.
2. **Data folder.** Launched as `VRisingServer.exe -persistentDataPath "<abs>" -logFile "<abs>"` (the manager passes nothing else). Everything lives in the data folder: `Settings\ServerHostSettings.json`, `Settings\ServerGameSettings.json`, `Settings\adminlist.txt`, `banlist.txt` (+ `tempbanlist.txt`, mute lists the server creates), and `Saves\v4\<SaveName>\`. A missing JSON falls back to `VRisingServer_Data\StreamingAssets\Settings\*.json` (the manager uses those as templates). Without `-persistentDataPath` the default is `%USERPROFILE%\AppData\LocalLow\Stunlock Studios\VRisingServer` (import detects it). The server never rewrites the JSON files; it logs the effective values (`Loaded ServerHostSettings:` / `Final ServerGameSettings Values:`, enums as numbers).
3. **Presets.** `GameSettingsPreset` (a file name from `StreamingAssets\GameSettingPresets`, 31 shipped) makes the server **ignore ServerGameSettings.json completely** (verified: custom ClanSize 2 → 4 with `StandardPvE`). `GameDifficultyPreset` (`Difficulty_Easy/Normal/Brutal`) overlays on top. Log: `Loaded ServerGameSettings from Preset: …`.
4. **Number types matter.** Integer keys must stay integers; `config::apply_game` keeps the type of the existing value (`coerce_like`).
5. **Ports:** UDP **game 9876** and **query 9877** (netstat-verified), TCP **RCON 25575** when enabled, TCP **API 9090** when enabled. `FallbackPort` 9878 is in the effective settings but not bound; suggestions step by 10 to keep it free.
6. **Graceful stop = Ctrl+Break** (Ctrl+C works too) via the helper (`--send-ctrl-c`). Log: `GameBootstrap.OnApplicationQuit()` → `SaveOnExit() - Saving the world on exit!` → `PersistenceV2 - Finished Saving to '…AutoSave_N.save.gz'` → exit in ~5 s. **An open RCON client connection keeps the process alive after the save** (it hung until force-killed) – hence one RCON connection per command. stdin `quit` also exists (`[CheckForQuitThread]`), unused.
7. **Log** (`-logFile`) is truncated on every start; `server::start` moves the old one to `logs\backup\VRisingServer_<time>.log` (last 20) and the tail starts at 0. Session signature: the `Bootstrap - Boot Time:` line (~20 KB in). Parsed lines (unit-tested in `supervisor.rs`):
   - version `Bootstrap - Boot Time: … Version: VRisingServer v1.1.15.0-r101082-b2 …` · ready `[Server] Startup Completed` (≈25 s on a fresh world)
   - `SteamNetworking - Successfully logged in with the SteamGameServer API. SteamID: …` · `OnPolicyResponse - Public IP: …`
   - saves `PersistenceV2 - Finished Saving to '…'` (preceded by `Triggering AutoSave N!`)
   - admin/ban list reload `[FileUserList] Content:`
   - players (format strings from the metadata, **not yet seen with a real client**): `User '{0}' '{1}', approvedUserIndex: {2}, Character: '{3}' connected as ID '{4},{5}', Entity '{6},{7}'.` ({0} = endpoint like `{Steam 7656…}`, {1} = SteamID64, {3} empty for a brand-new character) and `User '{0}' disconnected. approvedUserIndex: {1} Reason: {2} {3}`
   - fatal `No SaveName, or invalid SaveName! Exiting!`, `Error parsing ServerHostSettings…`, `Address already in use`
   - the rest is mostly noise (chunk streaming, prefab registration) – `lib/live.ts::isNoise` hides it in the console.
8. **A2S answers only while `ListOnSteam` is on** (unlisted: no reply on any address). INFO: version `0.0.0.1`, keywords like `pvp,cs4,hc,ded,dif_no`; RULES: `days-runningv2`, `blood-bound-enabled`, `castle-heart-damage-mode`, `settings0..11` (encoded). The supervisor polls every 10 s when listed.
9. **RCON** (Source protocol): AUTH answered with one AUTH_RESPONSE. Commands: `help`, `announce <text>`, `announcerestart <minutes>` (localized "restarting in N minutes" in chat), `shutdown <times> <message>`, `cancelshutdown`, `version`, `time`, `name`, `description`, `password <pw>|--clear`, `runcommand <console command>` (runs, **no output** – kick uses `runcommand kick "<name>"`; the console receives `kick <name>`). No player list over RCON.
   - **Arguments are split on spaces unless quoted:** `name A B` → `error: too many arguments\n\n usage: name <name>`; `name "A B"` → `new server name set`. `announce` takes the rest of the line either way. Errors arrive as a normal RESPONSE_VALUE starting with `error:` – `rcon::check_reply` turns them into `Err`.
   - **Live changes:** `name "<n>"` updates the Steam listing within seconds (A2S name changed), `password "<pw>"` / `password --clear` take effect at once (A2S password flag), `description "<d>"` answers `server description updated`. They don't touch the files – `update_instance` sends them (`apply_live`) *and* writes the files, so the change survives restarts and no restart is requested when only these changed.
10. **Admin/ban lists reload live** – the server polls them (~10 s) and logs `[FileUserList] Content:`. Admins then type `adminauth` in the in-game console.
11. **Saves:** `Saves\v4\<SaveName>\AutoSave_<n>.save.gz` (`.save` uncompressed), ~7 MB each for a fresh world; numbers go up; `AutoSaveSmartKeep` thins old ones; the newest is loaded (`CreateAndHostServer - … Loaded Save:AutoSave_0.save.gz`, or `<None>` for a new world). `SessionId.json` and `StartDate.json` sit beside them. Rollback = copy an older autosave to the next number (never overwrite).
12. **Memory:** ~2.6 GB for an empty fresh world.
13. **Local game saves** (import) are looked for in `%USERPROFILE%\AppData\LocalLow\Stunlock Studios\VRising\Saves` and `…\CloudSaves\<v>\<steamid>` – **not verified** on a PC with the game installed.
14. **Update checks:** `https://api.steamcmd.net/v1/info/1829350` → `depots.branches.<branch>.buildid`, SteamCMD `app_info_print` as fallback.

## 4. Invariants & gotchas

- **The settings files are shared with the user (and the Config Files view).** Never write a whole file from the profile; `config::apply_host` / `apply_game` replace managed keys only (unknown keys and arrays survive). `write_text` keeps 30 versions per file in `Settings\_config-history`.
- **Never hold an RCON connection open** (§3.6). `server::rcon_exec` connects, runs one command and closes. Quote single arguments with `rcon::quote_arg` (§3.9).
- **Secrets never go on the command line** and are DPAPI-sealed in the manager's files (`secrets.rs`); the server itself needs them in plain text in ServerHostSettings.json. A value that can't be decrypted comes back empty and is listed in `AppInfo.lostSecrets`.
- **Lifecycle operations hold `AppState::op_lock(id)`** – start/stop/restart/update and every command that rewrites world or settings files while requiring a stopped server (rollback, wipe, restore, rename). The supervisor uses `try_lock` and skips transitions while an operation runs. The restart countdown runs *before* taking the lock; a stop clears any pending countdown or deferred action so a warned restart can't bring the server back. Memory/uptime restarts go through the same warning countdown, at most once per 15 minutes. Don't add per-server loops; extend the supervisor tick.
- **Players** are keyed by SteamID when the log gave one, else by name. A2S (names only) is reconciled by name; a nameless log player (brand-new character) takes the first unmatched A2S name and their session row is renamed (`history::session_rename`). `session_end` matches by SteamID first.
- **Supervisor cost.** Full process discovery every 3 ticks; CPU/memory/disk only for `VRisingServer.exe` PIDs; A2S every 10 s (listed servers only); one manager.db row per server per minute.
- **SteamCMD.** Wrap every call in `steam_lock`. Install folders must be absolute (`abs_dir`).
- **Folder containment checks use `proc::is_within`**, not string prefixes.
- **Servers outlive the manager.** The supervisor adopts any `VRisingServer.exe` under a profile's install dir and recovers version, Steam id and online players from the current log.
- **Never lose user data.** Restores, imports, rollbacks, wipes and deletes quarantine first (`Saves\_quarantine`) and/or take a safety backup. `worlds::quarantine_dir` falls back to moving the contents when the folder itself is locked (Explorer, sync tools, IDE watchers). Deleting a server moves its `Backups` out first.
- **Only the user's actions change their router or firewall.** Firewall rules open UDP game+query only; RCON/API stay closed.
- **Mock backend only in browser dev** (`!isTauri()`); extend `devMock.ts` whenever you add a command.
- **Charts.** Series `#e5485a` / `#8b7cf6` and disk-usage `#e5485a` / `#8b7cf6` / `#b9801a` passed the dataviz validator on the dark surface `#140d10`. One y-axis per chart; status colours are not series colours.

## 5. Releasing

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, and add a `CHANGELOG.md` entry.
2. `cargo check` (warning-free), `cargo test --lib`, `npx tsc --noEmit` and `npm run build:all` must pass locally.
3. Commit to `release`, then `git tag vX.Y.Z && git push origin release --tags`. `release.yml` publishes `VRising-Server-Manager-Setup.exe`, `.msi`, `-Portable.zip` and `SHA256SUMS.txt` (the README download links point at these names). Tags with a hyphen become pre-releases. **Never move or delete a released tag.**

## 6. Ideas / not yet done

- Verify the player join/leave lines with a real client; verify the local game-save locations.
- Character names with spaces: `runcommand kick "A B"` reaches the console as `kick A B` – unverified how the console splits it.
- Decode A2S `settings0..11` for a "settings as players see them" view.
- BepInEx / Thunderstore mod management (server-side mods), wipe scheduling (`ResetDaysInterval`), the server's HTTP API metrics as a data source.
- Discord bot instead of a plain webhook; code signing; an auto-updater; Linux (Wine) hosts.

## 7. Recipes

**Add a backend command.** Write it in `commands.rs` (thin – logic goes in `core/*`), register it in `lib.rs`'s `generate_handler!`, add a typed wrapper to `src/lib/ipc.ts` (+ types in `src/lib/types.ts`, camelCase), and a handler in `src/lib/devMock.ts` so `npm run dev` keeps working. Long jobs: `background()` + `TaskReporter`; file work: `blocking()`.

**Add a game rule.** Add it to `src/data/gameplay.ts` with the default from the shipped `StreamingAssets\Settings\ServerGameSettings.json` (same number type). Nested keys are dotted (`CastleStatModifiers_Global.CastleLimit`); the backend flattens/unflattens generically, so no Rust change is needed.

**Add a host setting.** Field in `ServerConfig` (`models.rs`, with a serde default) → `config::apply_host` / `read_host` → `src/lib/types.ts` + `defaults.ts` → `views/Settings.tsx`. Add validation in `config::validate` if a bad value can stop the server.

**Parse a new log line.** Capture the real line, add a regex + `Line` variant in `supervisor.rs`, handle it in `tail_log` (and `scan_log_meta` if it matters after re-adoption), and add the captured line to `parses_real_server_log_lines`.

**Change something the user sees.** Keep the UI copy plain (players, worlds, saves – not keys) and update `docs/USER_GUIDE.md`. Regenerate screenshots with `scripts/screenshots.mjs` when a page changes visibly.
