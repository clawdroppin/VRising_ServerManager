//! `manager.db` – the manager's own SQLite database: per-minute metric rollups, the event
//! timeline, player sessions (from the server log) and build history.
//!
//! A failure here must never take the app down: if the database can't be opened the manager runs
//! without history (every call becomes a no-op) and logs why.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;

const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS metrics (
  server_id TEXT NOT NULL, ts INTEGER NOT NULL,
  cpu REAL, mem INTEGER, read_bps INTEGER, write_bps INTEGER, players INTEGER,
  PRIMARY KEY (server_id, ts)
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL, name TEXT NOT NULL, joined_at INTEGER NOT NULL, left_at INTEGER, steam_id TEXT
);
CREATE INDEX IF NOT EXISTS sessions_server ON sessions(server_id, joined_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT, ts INTEGER NOT NULL, level TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ts ON events(server_id, ts);
CREATE TABLE IF NOT EXISTS builds (
  server_id TEXT NOT NULL, build_id TEXT NOT NULL, branch TEXT NOT NULL, ts INTEGER NOT NULL
);
"#;

pub struct History {
    db: Mutex<Option<Connection>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricRow {
    pub ts: i64,
    pub cpu: f64,
    pub mem: i64,
    pub read_bps: i64,
    pub write_bps: i64,
    pub players: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRow {
    pub id: i64,
    pub server_id: Option<String>,
    pub ts: i64,
    pub level: String,
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: i64,
    pub name: String,
    pub joined_at: i64,
    pub left_at: Option<i64>,
    pub steam_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSummary {
    pub name: String,
    pub sessions: i64,
    pub total_ms: i64,
    pub first_seen: i64,
    pub last_seen: i64,
    pub steam_id: Option<String>,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl History {
    pub fn open(path: &Path) -> Self {
        let conn = (|| -> rusqlite::Result<Connection> {
            let c = Connection::open(path)?;
            c.pragma_update(None, "journal_mode", "WAL")?;
            c.pragma_update(None, "synchronous", "NORMAL")?;
            c.execute_batch(SCHEMA)?;
            let v: Option<i64> = c.query_row("SELECT version FROM schema_version", [], |r| r.get(0)).optional()?;
            if v.is_none() {
                c.execute("INSERT INTO schema_version(version) VALUES (?1)", [SCHEMA_VERSION])?;
            }
            Ok(c)
        })();
        match conn {
            Ok(c) => Self { db: Mutex::new(Some(c)) },
            Err(e) => {
                eprintln!("manager.db unavailable ({e}); running without history");
                Self { db: Mutex::new(None) }
            }
        }
    }

    #[cfg(test)]
    pub fn memory() -> Self {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        Self { db: Mutex::new(Some(c)) }
    }

    fn with<R: Default>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<R>) -> R {
        let Ok(g) = self.db.lock() else { return R::default() };
        match g.as_ref() {
            Some(c) => f(c).unwrap_or_else(|e| {
                eprintln!("manager.db: {e}");
                R::default()
            }),
            None => R::default(),
        }
    }

    // ------------------------------------------------------------------------------ write

    pub fn event(&self, server_id: Option<&str>, level: &str, kind: &str, message: &str) {
        self.with(|c| {
            c.execute(
                "INSERT INTO events(server_id, ts, level, kind, message) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![server_id, now(), level, kind, message],
            )
            .map(|_| ())
        })
    }

    /// A player joined: open a session row.
    pub fn session_start(&self, server_id: &str, name: &str, steam_id: Option<&str>, ts: i64) {
        self.with(|c| {
            c.execute(
                "INSERT INTO sessions(server_id, name, joined_at, steam_id) VALUES (?1, ?2, ?3, ?4)",
                params![server_id, name, ts, steam_id],
            )
            .map(|_| ())
        })
    }

    /// A player left: close their newest open session (matched by SteamID when known, else name).
    pub fn session_end(&self, server_id: &str, name: &str, steam_id: Option<&str>, ts: i64) {
        self.with(|c| {
            c.execute(
                "UPDATE sessions SET left_at = ?3 WHERE id = (SELECT id FROM sessions WHERE server_id = ?1 AND left_at IS NULL \
                 AND ((?4 IS NOT NULL AND steam_id = ?4) OR name = ?2) ORDER BY joined_at DESC LIMIT 1)",
                params![server_id, name, ts, steam_id],
            )
            .map(|_| ())
        })
    }

    /// A player who joined before creating a character got a name: rename their open session.
    pub fn session_rename(&self, server_id: &str, steam_id: &str, name: &str) {
        self.with(|c| {
            c.execute("UPDATE sessions SET name = ?3 WHERE server_id = ?1 AND steam_id = ?2 AND left_at IS NULL", params![server_id, steam_id, name]).map(|_| ())
        })
    }

    /// Server stopped or crashed: close every open session.
    pub fn sessions_close_all(&self, server_id: &str, ts: i64) {
        self.with(|c| c.execute("UPDATE sessions SET left_at = ?2 WHERE server_id = ?1 AND left_at IS NULL", params![server_id, ts]).map(|_| ()))
    }

    pub fn metric(&self, server_id: &str, row: &MetricRow) {
        self.with(|c| {
            c.execute(
                "INSERT OR REPLACE INTO metrics(server_id, ts, cpu, mem, read_bps, write_bps, players) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![server_id, row.ts, row.cpu, row.mem, row.read_bps, row.write_bps, row.players],
            )
            .map(|_| ())
        })
    }

    pub fn build(&self, server_id: &str, build_id: &str, branch: &str) {
        self.with(|c| {
            let last: Option<String> =
                c.query_row("SELECT build_id FROM builds WHERE server_id = ?1 ORDER BY ts DESC LIMIT 1", [server_id], |r| r.get(0)).optional()?;
            if last.as_deref() != Some(build_id) {
                c.execute("INSERT INTO builds(server_id, build_id, branch, ts) VALUES (?1,?2,?3,?4)", params![server_id, build_id, branch, now()])?;
            }
            Ok(())
        })
    }

    /// Drop old metrics; keep everything else.
    pub fn prune(&self, metrics_days: u32) {
        let cutoff = now() - metrics_days.max(1) as i64 * 86_400_000;
        self.with(|c| c.execute("DELETE FROM metrics WHERE ts < ?1", [cutoff]).map(|_| ()))
    }

    // ------------------------------------------------------------------------------- read

    pub fn metrics(&self, server_id: &str, since: i64) -> Vec<MetricRow> {
        self.with(|c| {
            let mut st = c.prepare("SELECT ts, cpu, mem, read_bps, write_bps, players FROM metrics WHERE server_id = ?1 AND ts >= ?2 ORDER BY ts")?;
            let rows = st.query_map(params![server_id, since], |r| {
                Ok(MetricRow {
                    ts: r.get(0)?,
                    cpu: r.get::<_, Option<f64>>(1)?.unwrap_or(0.0),
                    mem: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                    read_bps: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                    write_bps: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                    players: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                })
            })?;
            rows.collect()
        })
    }

    pub fn events(&self, server_id: Option<&str>, limit: u32) -> Vec<EventRow> {
        self.with(|c| {
            let map = |r: &rusqlite::Row| {
                Ok(EventRow { id: r.get(0)?, server_id: r.get(1)?, ts: r.get(2)?, level: r.get(3)?, kind: r.get(4)?, message: r.get(5)? })
            };
            match server_id {
                Some(s) => {
                    let mut st = c.prepare("SELECT id, server_id, ts, level, kind, message FROM events WHERE server_id = ?1 ORDER BY ts DESC LIMIT ?2")?;
                    let v = st.query_map(params![s, limit], map)?.collect();
                    v
                }
                None => {
                    let mut st = c.prepare("SELECT id, server_id, ts, level, kind, message FROM events ORDER BY ts DESC LIMIT ?1")?;
                    let v = st.query_map(params![limit], map)?.collect();
                    v
                }
            }
        })
    }

    pub fn sessions(&self, server_id: &str, limit: u32) -> Vec<SessionRow> {
        self.with(|c| {
            let mut st = c.prepare("SELECT id, name, joined_at, left_at, steam_id FROM sessions WHERE server_id = ?1 ORDER BY joined_at DESC LIMIT ?2")?;
            let v = st
                .query_map(params![server_id, limit], |r| {
                    Ok(SessionRow { id: r.get(0)?, name: r.get(1)?, joined_at: r.get(2)?, left_at: r.get(3)?, steam_id: r.get(4)? })
                })?
                .collect();
            v
        })
    }

    /// Everyone who ever played on a server, most recent first.
    pub fn players(&self, server_id: &str) -> Vec<PlayerSummary> {
        let now = now();
        self.with(|c| {
            let mut st = c.prepare(
                "SELECT name, COUNT(*), SUM(COALESCE(left_at, ?2) - joined_at), MIN(joined_at), MAX(COALESCE(left_at, ?2)),
                        (SELECT s2.steam_id FROM sessions s2 WHERE s2.server_id = ?1 AND s2.name = s.name AND s2.steam_id IS NOT NULL ORDER BY s2.joined_at DESC LIMIT 1)
                 FROM sessions s WHERE server_id = ?1 GROUP BY name ORDER BY MAX(COALESCE(left_at, ?2)) DESC",
            )?;
            let v = st
                .query_map(params![server_id, now], |r| {
                    Ok(PlayerSummary { name: r.get(0)?, sessions: r.get(1)?, total_ms: r.get(2)?, first_seen: r.get(3)?, last_seen: r.get(4)?, steam_id: r.get(5)? })
                })?
                .collect();
            v
        })
    }

    /// Remove everything stored for a deleted server.
    pub fn forget(&self, server_id: &str) {
        self.with(|c| {
            for t in ["metrics", "events", "sessions", "builds"] {
                c.execute(&format!("DELETE FROM {t} WHERE server_id = ?1"), [server_id])?;
            }
            Ok(())
        })
    }

    pub fn builds(&self, server_id: &str) -> Vec<(String, String, i64)> {
        self.with(|c| {
            let mut st = c.prepare("SELECT build_id, branch, ts FROM builds WHERE server_id = ?1 ORDER BY ts DESC LIMIT 100")?;
            let v = st.query_map([server_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect();
            v
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_dedupe_and_events() {
        let h = History::memory();
        h.build("s", "1", "public");
        h.build("s", "1", "public");
        h.build("s", "2", "public");
        assert_eq!(h.builds("s").len(), 2);
        h.event(Some("s"), "info", "test", "hello");
        assert_eq!(h.events(Some("s"), 10)[0].message, "hello");
        h.metric("s", &MetricRow { ts: now(), cpu: 1.0, mem: 2, read_bps: 3, write_bps: 4, players: 5 });
        assert_eq!(h.metrics("s", 0)[0].players, 5);
        h.session_start("s", "Bob", Some("76561198000000001"), 1000);
        h.session_start("s", "Ann", None, 1500);
        h.session_end("s", "Bob", None, 4000);
        // Joined before making a character, named later, left (matched by SteamID).
        h.session_start("s", "", Some("76561198000000002"), 2000);
        h.session_rename("s", "76561198000000002", "Cid");
        h.session_end("s", "", Some("76561198000000002"), 2500);
        h.sessions_close_all("s", 5000);
        let p = h.players("s");
        assert_eq!(p.len(), 3);
        assert_eq!(p.iter().find(|x| x.name == "Cid").map(|x| x.total_ms), Some(500));
        let bob = p.iter().find(|x| x.name == "Bob").unwrap();
        assert_eq!((bob.sessions, bob.total_ms), (1, 3000));
        assert_eq!(bob.steam_id.as_deref(), Some("76561198000000001"));
        assert_eq!(h.sessions("s", 10).len(), 3);
        h.forget("s");
        assert!(h.players("s").is_empty());
    }
}
