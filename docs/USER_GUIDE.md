# User guide

Everything you need to host a V Rising server with V Rising Server Manager – from the first install to rolling back a raided castle.

**Contents**
1. [Install the manager](#1-install-the-manager)
2. [Create your first server](#2-create-your-first-server)
3. [Let players in](#3-let-players-in)
4. [Day-to-day: start, stop, monitor](#4-day-to-day-start-stop-monitor)
5. [Server settings](#5-server-settings)
6. [Game rules](#6-game-rules)
7. [Admins & bans](#7-admins--bans)
8. [Players, RCON & announcements](#8-players-rcon--announcements)
9. [Worlds](#9-worlds)
10. [Backups](#10-backups)
11. [Automation](#11-automation)
12. [Several servers, import, export](#12-several-servers-import-export)
13. [Troubleshooting](#13-troubleshooting)

## 1. Install the manager

- **Installer** (`VRising-Server-Manager-Setup.exe`): installs for your Windows user; data lives in `%APPDATA%\com.vrisingservermanager.app`.
- **Portable** (`…-Portable.zip`): unzip anywhere you can write to. Everything – settings, SteamCMD, servers, backups – stays in the `data` folder next to the exe.

Windows SmartScreen may warn on first launch because the app isn't code-signed: **More info → Run anyway**.

A server needs about **2 GB** of disk plus ~7 MB per autosave, around **3 GB of RAM** for a quiet world and **8 GB+** for a busy 40-player server.

## 2. Create your first server

Click **New server** (or press **Ctrl+N**). The wizard has four steps:

1. **Server** – a profile name, a colour, the install folder (leave empty for automatic) and the ports. A free set is picked for you: UDP **9876** (game) and **9877** (query), TCP **25575** for RCON; a second server gets 9886/9887/25576.
2. **World & players** – the name players search for, an optional join password, max players, **PvE or PvP**, difficulty (Easy, Normal, Brutal) and whether the server is listed on Steam.
3. **Admin** – your SteamID64 (optional, so you can use admin commands in-game) and RCON, which is on by default with a generated password.
4. **Launch** – review and download the server with SteamCMD (about 300 MB, no Steam account needed).

When the download finishes, press **Start**. A fresh world is online in about 30 seconds. The Overview shows a short checklist until everything is set up.

Already have a server? **Import server → Existing folder** adopts it with its worlds and settings – its `save-data` folder, or the default data folder under `AppData\LocalLow\Stunlock Studios\VRisingServer` if it was run without one. Servers installed through the Steam client (Library → Tools) are detected automatically.

## 3. Let players in

Players open **Online Play → Find Servers** and search your server name (or use **Direct Connect** with your address). The Overview has copy buttons for the name, the address and the password.

Friends on your own network can join right away. For everyone else:

- **Port Forwarding** shows what to forward: **UDP 9876 and 9877** (or your ports). *Forward ports automatically* uses UPnP; otherwise follow the router-specific steps. RCON is listed as optional – only forward it if you administer from outside.
- **Windows Firewall:** click *Allow through firewall* (one admin prompt). If you once dismissed Windows' "allow access?" popup, Windows created a hidden **Block** rule – the button removes it too.
- **Is it listed?** *Ask Steam if it's listed* checks Steam's server list, which is what the in-game browser shows.
- **Double NAT / CGNAT** are detected and explained.

## 4. Day-to-day: start, stop, monitor

- **Start / Stop / Restart** live in the header of every server. **Stop** asks the server to save and shut down (a few seconds) and force-closes only after the timeout. The ⋯ menu has **Restart with warning** (players get a "restarting in N minutes" message and the restart happens after the countdown – cancel it from the header) and **Force stop**.
- Servers **keep running when you close the manager**. With "Keep running in the tray" (default) the manager keeps watching them; when you reopen it, it re-attaches to anything still running.
- **Overview:** join details, live CPU/memory/players/disk, recent console, version, the active world and its last save, the in-game day, next schedule, last backup and an activity timeline.
- **Performance:** live charts (1 m – 1 h), and **24 h / 7 d / 30 d history** of players, CPU, memory and disk.
- **Console:** the live server log with filters, search and previous sessions. Engine chatter (chunk streaming etc.) is hidden by default. The **RCON>** box at the bottom sends commands (`help`, `announce …`, `time` …).
- **Ctrl+K** opens the command palette; **Ctrl+Tab** switches tabs; **Ctrl+S** saves.

## 5. Server settings

**Server Settings** edits `ServerHostSettings.json`: name and description, Steam/Epic listing, max players and admin slots, the join password, VAC, LAN mode, the ports (with *Pick free ports*), bind address, server FPS, the save name, autosave interval and count, and RCON / HTTP API.

The server reads its settings when it starts, so most changes made while it runs show a **Restart to apply changes** button. The **name, description and join password** are the exception: while the server runs (with RCON on) they're applied on the spot – the Steam server list shows the new name within seconds – and written to the file for the next start.

**Config Files** is an editor for the four files – `ServerHostSettings.json`, `ServerGameSettings.json`, `adminlist.txt`, `banlist.txt` – with validation and the last 30 versions of each. Edits flow back into the other pages; keys the manager doesn't know are left untouched.

**Process & Launch:** show or hide the server's console window, CPU priority and cores, the data folder (`-persistentDataPath`) and extra arguments.

## 6. Game rules

Everything in `ServerGameSettings.json`, in plain language and grouped: game mode & social (PvP/PvE, difficulty, clan size …), PvP & sieges, castles, castle limits (per heart level), loot & resources, vampire stats, enemies & V Blood, crafting & building, day/night & blood moons, inactivity, traders, raid/PvP time windows and rift incursions. Changed values are marked and can be reset one by one or all at once; keys the manager doesn't describe appear under *Other settings*.

At the top you can pick one of **Stunlock's presets** (read from the installed server):

- A **rules preset** (StandardPvP, DuoPvP, Level 50 PvE …) replaces every custom value – the server ignores ServerGameSettings.json while one is set. Use **Copy into custom rules** to start from a preset and tweak it.
- A **difficulty preset** (Easy, Normal, Brutal) adjusts difficulty on top of the rules.

**My presets** are your own rule sets, shared by all your servers: set up the rules, click *Save current rules…* and give them a name; *Apply* fills them into any server's custom rules (nothing is written until you save).

Rules apply from the next start, to existing worlds too.

## 7. Admins & bans

`adminlist.txt` and `banlist.txt` hold one SteamID64 per line. Add or remove entries here (or from the Players page); the running server reloads both files within about ten seconds – no restart needed.

- **Admins** type `adminauth` in the in-game console (the `~` key) to unlock admin commands, and can use the admin slots when the server is full.
- **Bans** block a player from connecting. Banning someone who's online also kicks them (over RCON).

Find a SteamID64 on the Players page (everyone who joined is listed with theirs) or in a Steam profile URL (`steamcommunity.com/profiles/7656…`).

## 8. Players, RCON & announcements

- **Online now:** who's on, with SteamID, play time, a link to their Steam profile and buttons to make admin, kick or ban. The count comes from the server itself while it's listed on Steam; names and SteamIDs come from the log. A brand-new player shows as "New player" until they create a character.
- **Announce:** send a message to everyone online.
- **History:** everyone who has played, with SteamID, sessions, total play time, first and last seen – filterable.

RCON is what makes announcements, restart warnings and kicks possible. It's on by default (TCP 25575, generated password) and only reachable from this PC unless you forward the port.

## 9. Worlds

Each world is a folder (`save-data\Saves\v4\<name>`) of numbered autosaves; the server loads the newest one of the world named in **Save name**.

- **Roll back to this** makes an older autosave the one that loads next – it's copied to the next number, so nothing is overwritten, and a backup is taken first.
- **Check saves** unpacks every autosave of the world and marks damaged ones (a save cut off by a crash or a full disk). If the newest is damaged, roll back to the newest intact one before starting.
- **Export / Duplicate** copy a world; **Rename** renames it (the active world keeps loading under the new name – server stopped).
- **Wipe** moves the active world to quarantine (nothing is deleted); the next start generates a fresh Vardoran under the same name.
- **Other worlds:** switch the server to another world, or **start a new world** under a new name (your current one stays and you can switch back).
- **Bring a world from the game** lists private games found on this PC, or any folder you pick, and copies one in – optionally with its own game rules.

In V Rising, characters and castles live in the world, so switching or wiping a world affects everyone's progress. Back up first (the manager does it automatically before rollbacks, wipes and restores).

## 10. Backups

A backup is a zip snapshot of every world's newest autosave plus the settings files (host and game settings, admin and ban lists). They're made on an interval while running, after every stop and before updates (all configurable under Automation), or manually with a label. Old automatic backups are pruned past the *keep* count; manual ones are never pruned.

**Verify** (the shield button) reads every file in a backup and unpacks its autosaves, so you know it restores before you need it; it lists the worlds inside.

**Restore** (server stopped) quarantines the worlds it replaces first and can also restore the settings files. By default backups live in `<server folder>\Backups`; App settings can move them elsewhere.

## 11. Automation

- **Uptime & recovery:** start with the manager, restart after a crash (with a delay and a crash-loop guard), stop timeout, restart above a memory limit or after an uptime, **stop when empty** after N minutes.
- **Schedules:** restart, update, backup, stop or start at a time on chosen days.
- **Warnings & announcements:** before an automatic restart, update or stop while players are online, the manager announces it and waits (default 5 minutes, with reminders). Timed announcements (Discord link, rules …) go out every N minutes while someone is online.
- **Wait for players to leave:** optionally hold automatic actions until the server is empty (up to an hour).
- **Updates:** check every N minutes, install automatically, or update on every start.
- **Notifications:** Windows toasts (App settings) and a Discord/Slack webhook with selectable levels.

Combine **Start with Windows** (App settings) with **Start with the manager** for hands-off hosting.

## 12. Several servers, import, export

- Run as many servers as your PC handles; each needs its own ports (picked automatically).
- **Duplicate** copies a server's settings and admin/ban lists (new ports and RCON password) and optionally its worlds.
- **Export** creates a `.vrising` pack (profile + settings, optionally the worlds and passwords) to move a server to another PC or keep it as a template. **Import** installs it.
- **Delete** removes the profile, and optionally the files; backups are moved to the data folder first.

## 13. Troubleshooting

Open **Network & Health** first – it checks the files, both settings files, your settings, admins, ports, RCON, the firewall, memory, disk, the server version, the Steam listing and the last log, with a fix button where possible. **Query the server** shows what the server tells Steam (only while it's listed).

| Problem | What to do |
|---|---|
| The server stops right after starting | Console → look for `Exiting!`, `Error parsing` or `Address already in use`. Network & Health explains settings problems. Worlds → *Check saves* finds a damaged newest autosave. |
| Nobody can find it | Is *List on Steam* on? Network & Health → *Steam server list*. If missing: firewall + port forward. After a game patch: update. |
| Friends can find it but not join | Forward UDP 9876 and 9877 to this PC, allow the firewall, check for CGNAT on Port Forwarding. |
| My custom rules are ignored | A rules preset is set under Game Rules – clear it or copy it into custom rules. |
| Admin commands don't work | Your SteamID64 must be in Admins & Bans, then type `adminauth` in the in-game console. |
| Player count shows "—" | The server answers Steam queries only while listed on Steam; names still come from the log. |
| "Stop the server first" | Rollbacks, wipes and restores need the server stopped, because it has the world open. |
| Moved the portable folder to another PC | Encrypted passwords can't be read on another Windows account – the app tells you which ones to re-enter. |
