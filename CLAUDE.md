# CLAUDE.md

All project guidance for AI assistants lives in **[AGENTS.md](AGENTS.md)** – read it before making changes. User docs: [docs/USER_GUIDE.md](docs/USER_GUIDE.md).

Quick reminders:
- Steam AppID for the dedicated server is **1829350** (the game is 1604030).
- Ports: UDP **9876** (game) + **9877** (query); TCP 25575 RCON and 9090 API only when enabled.
- The server is launched with `-persistentDataPath <abs> -logFile <abs>`; settings live in `<data>\Settings` (ServerHostSettings.json, ServerGameSettings.json, adminlist.txt, banlist.txt). Only read-modify-write the keys the profile owns (`core/config.rs`).
- A `GameSettingsPreset` makes the server ignore ServerGameSettings.json entirely.
- Graceful stop = Ctrl+Break to the server's own hidden console → it saves and exits. **Never keep an RCON connection open** – it blocks the process from exiting.
- Saves: `<data>\Saves\v4\<SaveName>\AutoSave_N.save.gz`; rollback copies to the next number.
- Keep `cargo check` warning-free, `cargo test --lib` and `npx tsc -p tsconfig.json --noEmit` passing.
- The mock backend (`src/lib/devMock.ts`) must only load in browser dev (`!isTauri()`).
