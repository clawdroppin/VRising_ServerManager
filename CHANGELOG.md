# Changelog

## 1.0.0 – 2026-10-15

First release, built on the Enshrouded / Dragonwilds / Minecraft / ASA Server Manager architecture and verified against the real V Rising dedicated server (Steam build 25169871, v1.1.15.0).

- **Servers:** four-step wizard (server, world & players, admin, launch) with SteamCMD install; free port sets (9876/9877 + RCON 25575, then +10); multi-server tabs; adopt existing installs (Steam client installs and LocalLow data folders detected); duplicate, delete, `.vrising` packs.
- **Settings:** lossless read-modify-write of `ServerHostSettings.json` and `ServerGameSettings.json` (shipped files as templates, number types kept, unknown keys untouched); validation before every save and start; editor for both JSON files and the admin/ban lists with 30 versions of history each.
- **Game rules:** every ServerGameSettings key in plain language across 13 groups, Stunlock's rules and difficulty presets from the installed server, "copy preset into custom rules".
- **Admins & bans:** adminlist.txt / banlist.txt editing that applies live; make-admin / ban from the Players page.
- **RCON:** announcements, timed announcements, restart countdowns with player warnings (cancellable), kick, and an RCON console.
- **Lifecycle:** graceful stop via console break (the world is saved), force stop, crash auto-restart with loop guard, re-adoption after manager restarts, hidden server console, log rotation.
- **Players:** names and SteamIDs from the log, live count via Steam A2S (while listed), in-game day, session feed, player history with play time (SQLite).
- **Worlds:** multiple worlds per server, switch / start new / duplicate / wipe, autosave rollback without overwriting, import from private games or any folder.
- **Backups:** newest autosave of every world + settings, interval / on stop / before update, retention, safe restore with quarantine.
- **Monitoring:** live CPU, memory, disk, network, per-core; 24 h / 7 d / 30 d history; activity timeline; live console with noise filter and previous sessions.
- **Automation:** schedules, auto-update, restart warnings, wait for players to leave, stop when empty, memory/uptime limits, start with Windows, tray mode, Windows notifications, Discord/Slack webhooks.
- **Network & health:** port-forwarding guide with UPnP, router detection, double-NAT/CGNAT warnings, firewall fixes incl. Block rules, Steam master-list check, A2S query tool, RCON check, health checks with fixes.
- **Live changes:** the server name, description and join password apply instantly over RCON while the server runs (no restart).
- **Save safety:** "Check saves" unpacks every autosave of a world to find damaged ones; backups can be verified (every file read, autosaves unpacked).
- **My presets:** save a server's game rules under a name and apply them to any server.
- **Worlds:** rename worlds (the active one keeps loading); Steam profile links for players.
- **Streamer mode** hides IPs, passwords and SteamIDs.
- **Builds:** installer (NSIS), MSI and portable editions.
