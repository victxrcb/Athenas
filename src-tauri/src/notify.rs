//! Agent attention events ("finished", "needs approval") and the native notification that announces them.
//!
//! Claude Code reports through hooks: each session starts with `--settings` pointing at a file whose
//! `Stop`/`Notification` hooks run this same executable in `--agent-hook` mode, which records the event in a
//! small SQLite queue that the app polls. Codex reports through OSC 9 escape sequences written to its
//! terminal, which the PTY reader scans with [`OscScanner`].
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

pub const EVENTS_FILE: &str = "agent-events.sqlite3";
const HOOK_FLAG: &str = "--agent-hook";
const MAX_MESSAGE: usize = 400;
const MAX_ICON_BYTES: usize = 512 * 1024;

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttentionEvent {
    pub session_id: String,
    /// `done` (turn finished) or `approval` (waiting for the user).
    pub kind: String,
    pub message: String,
}

fn open(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|e| e.to_string())?;
    connection.busy_timeout(Duration::from_secs(2)).map_err(|e| e.to_string())?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS agent_events (
               id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, kind TEXT NOT NULL,
               message TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));",
        )
        .map_err(|e| e.to_string())?;
    Ok(connection)
}

fn clip(text: &str) -> String {
    let text = text.trim();
    match text.char_indices().nth(MAX_MESSAGE) {
        Some((index, _)) => format!("{}…", &text[..index]),
        None => text.to_string(),
    }
}

/// Maps a Claude Code hook payload to an attention event; `None` for events that should stay silent.
pub fn classify_claude_hook(payload: &Value) -> Option<(&'static str, String)> {
    let message = payload.get("message").and_then(Value::as_str).unwrap_or("").to_string();
    match payload.get("hook_event_name").and_then(Value::as_str)? {
        "Stop" => Some(("done", String::new())),
        "Notification" => match payload.get("notification_type").and_then(Value::as_str) {
            Some("permission_prompt" | "elicitation_dialog") => Some(("approval", message)),
            Some(_) => None,
            // Older releases send no type; the permission prompt is the only one worth announcing.
            None if message.to_lowercase().contains("permission") => Some(("approval", message)),
            None => None,
        },
        _ => None,
    }
}

/// Maps a Codex OSC 9 notification to an attention event.
pub fn classify_codex_message(message: &str) -> (&'static str, String) {
    const ASKS: [&str; 4] = ["Approval requested", "Codex wants to edit", "Plan mode prompt", "Question:"];
    let message = message.trim();
    if ASKS.iter().any(|prefix| message.starts_with(prefix)) {
        ("approval", message.to_string())
    } else if message.eq_ignore_ascii_case("Agent turn complete") {
        ("done", String::new())
    } else {
        ("done", message.to_string())
    }
}

/// Entry point for `athenas-agent --agent-hook <db>`, run by Claude Code hooks. Never blocks the agent:
/// every failure is swallowed and the process exits 0.
pub fn run_hook(db: &Path) {
    let Ok(session_id) = std::env::var(crate::links::SESSION_ENV) else { return };
    if uuid::Uuid::parse_str(&session_id).is_err() {
        return;
    }
    let mut input = Vec::new();
    if std::io::stdin().take(1024 * 1024).read_to_end(&mut input).is_err() {
        return;
    }
    let Ok(payload) = serde_json::from_slice::<Value>(&input) else { return };
    let Some((kind, message)) = classify_claude_hook(&payload) else { return };
    if let Ok(connection) = open(db) {
        let _ = connection.execute(
            "INSERT INTO agent_events (session_id, kind, message) VALUES (?1, ?2, ?3)",
            params![session_id, kind, clip(&message)],
        );
    }
}

/// Writes the Claude Code settings file whose hooks call back into this executable; returns its path.
pub fn claude_hook_settings(data_dir: &Path) -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    // Forward slashes and double quotes work both in Git Bash and in cmd.exe, which Claude may use for hooks.
    let slash = |path: &Path| path.to_string_lossy().replace('\\', "/");
    let command = format!(
        "\"{}\" {HOOK_FLAG} \"{}\"",
        slash(&executable),
        slash(&data_dir.join(EVENTS_FILE))
    );
    let hook = serde_json::json!([{ "hooks": [{ "type": "command", "command": command, "timeout": 10 }] }]);
    let settings = serde_json::json!({ "hooks": { "Stop": hook, "Notification": hook } });
    let path = data_dir.join("claude-hooks.json");
    let body = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    if fs::read(&path).ok().as_deref() != Some(body.as_slice()) {
        fs::write(&path, body).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

/// Codex `-c` overrides that make it emit OSC 9 notifications even while its pane is focused;
/// the app decides itself whether the user is already looking.
pub const CODEX_NOTIFY_ARGS: [&str; 6] = [
    "-c", "tui.notifications=true",
    "-c", "tui.notification_method=osc9",
    "-c", "tui.notification_condition=always",
];

/// Finds desktop notifications (OSC 9 and OSC 777;notify) in a PTY byte stream, across chunk boundaries.
#[derive(Default)]
pub struct OscScanner {
    pending: Vec<u8>,
}

impl OscScanner {
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut found = Vec::new();
        let mut data = std::mem::take(&mut self.pending);
        data.extend_from_slice(bytes);
        let mut index = 0;
        while let Some(offset) = data[index..].windows(2).position(|pair| pair == b"\x1b]") {
            let start = index + offset + 2;
            let end = (start..data.len()).find(|&i| data[i] == 0x07 || (data[i] == 0x1b && data.get(i + 1) == Some(&b'\\')));
            let Some(end) = end else {
                // Unterminated: keep it for the next chunk unless it is clearly not a notification.
                if data.len() - start < 4096 {
                    self.pending = data[index + offset..].to_vec();
                }
                return found;
            };
            if let Some(message) = notification_text(&String::from_utf8_lossy(&data[start..end])) {
                found.push(message);
            }
            index = end + 1;
        }
        // A trailing ESC may start the next sequence.
        if data.last() == Some(&0x1b) {
            self.pending = vec![0x1b];
        }
        found
    }
}

fn notification_text(body: &str) -> Option<String> {
    if let Some(rest) = body.strip_prefix("9;") {
        // ConEmu reuses OSC 9 with numeric sub-commands (9;4 is the progress bar); those are not notifications.
        let numeric = rest.split(';').next().is_some_and(|head| !head.is_empty() && head.chars().all(|c| c.is_ascii_digit()));
        return (!numeric && !rest.trim().is_empty()).then(|| rest.to_string());
    }
    let rest = body.strip_prefix("777;notify;")?;
    let (title, text) = rest.split_once(';').unwrap_or((rest, ""));
    let message = if text.trim().is_empty() { title } else { text };
    (!message.trim().is_empty()).then(|| message.to_string())
}

/// Polls the hook queue and forwards each event to the UI as `agent-attention`; runs for the app's lifetime.
pub fn start(app: AppHandle, data_dir: PathBuf) {
    let path = data_dir.join(EVENTS_FILE);
    thread::spawn(move || {
        // Events left from a previous run refer to sessions that are no longer running.
        let mut connection = open(&path).ok();
        if let Some(db) = connection.as_ref() {
            let _ = db.execute("DELETE FROM agent_events", []);
        }
        loop {
            thread::sleep(Duration::from_millis(500));
            if connection.is_none() {
                connection = open(&path).ok();
            }
            let Some(db) = connection.as_ref() else { continue };
            let events: Vec<(i64, AttentionEvent)> = db
                .prepare("SELECT id, session_id, kind, message FROM agent_events ORDER BY id LIMIT 50")
                .and_then(|mut query| {
                    query
                        .query_map([], |row| {
                            Ok((row.get(0)?, AttentionEvent { session_id: row.get(1)?, kind: row.get(2)?, message: row.get(3)? }))
                        })?
                        .collect()
                })
                .unwrap_or_default();
            for (id, event) in events {
                let _ = db.execute("DELETE FROM agent_events WHERE id=?1", [id]);
                let _ = app.emit("agent-attention", event);
            }
        }
    });
}

pub fn emit_codex(app: &AppHandle, session_id: &str, message: &str) {
    let (kind, message) = classify_codex_message(message);
    let _ = app.emit(
        "agent-attention",
        AttentionEvent { session_id: session_id.to_string(), kind: kind.into(), message: clip(&message) },
    );
}

fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3))
}

/// Shows a native notification with the agent's icon; clicking it focuses the app and emits
/// `notification-open` with `target` so the UI can jump to the session or worker.
#[tauri::command]
pub fn notify_show(app: AppHandle, title: String, body: String, icon_png: Option<String>, target: Option<String>) -> Result<(), String> {
    let icon = match icon_png {
        Some(encoded) => {
            let bytes = STANDARD.decode(encoded.as_bytes()).map_err(|_| "Ícone inválido.".to_string())?;
            if bytes.len() > MAX_ICON_BYTES || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                return Err("Ícone inválido.".into());
            }
            let folder = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("notify-icons");
            fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
            let path = folder.join(format!("{:016x}.png", fnv(&bytes)));
            if !path.exists() {
                fs::write(&path, &bytes).map_err(|e| e.to_string())?;
            }
            Some(path)
        }
        None => None,
    };
    show(&app, &clip(&title), &clip(&body), icon.as_deref(), target)
}

#[cfg(windows)]
fn show(app: &AppHandle, title: &str, body: &str, icon: Option<&Path>, target: Option<String>) -> Result<(), String> {
    use tauri_winrt_notification::{IconCrop, Toast};
    // Installed builds register the bundle identifier on their Start menu shortcut; dev builds have none.
    let app_id = if cfg!(debug_assertions) { Toast::POWERSHELL_APP_ID.to_string() } else { app.config().identifier.clone() };
    let mut toast = Toast::new(&app_id).title(title).text1(body);
    if let Some(icon) = icon {
        toast = toast.icon(icon, IconCrop::Square, "");
    }
    let handle = app.clone();
    toast
        .on_activated(move |_| {
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            if let Some(target) = &target {
                let _ = handle.emit("notification-open", target.clone());
            }
            Ok(())
        })
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn show(_app: &AppHandle, _title: &str, _body: &str, _icon: Option<&Path>, _target: Option<String>) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scanner_finds_notifications_across_chunks() {
        let mut scanner = OscScanner::default();
        assert!(scanner.feed(b"output \x1b]9;Approval req").is_empty());
        assert_eq!(scanner.feed(b"uested: git push\x07 more"), vec!["Approval requested: git push"]);
        assert_eq!(scanner.feed(b"\x1b]777;notify;Codex;Agent turn complete\x1b\\"), vec!["Agent turn complete"]);
        assert_eq!(scanner.feed(b"a\x1b"), Vec::<String>::new());
        assert_eq!(scanner.feed(b"]9;done\x07"), vec!["done"]);
    }

    #[test]
    fn scanner_ignores_progress_and_other_sequences() {
        let mut scanner = OscScanner::default();
        assert!(scanner.feed(b"\x1b]9;4;1;50\x07\x1b]0;title\x07\x1b]8;;http://x\x07link\x1b]8;;\x07").is_empty());
    }

    #[test]
    fn claude_hooks_are_classified() {
        let stop = serde_json::json!({ "hook_event_name": "Stop" });
        assert_eq!(classify_claude_hook(&stop), Some(("done", String::new())));
        let ask = serde_json::json!({ "hook_event_name": "Notification", "notification_type": "permission_prompt", "message": "Claude needs your permission to use Bash" });
        assert_eq!(classify_claude_hook(&ask).map(|e| e.0), Some("approval"));
        let idle = serde_json::json!({ "hook_event_name": "Notification", "notification_type": "idle_prompt", "message": "Claude is waiting for your input" });
        assert_eq!(classify_claude_hook(&idle), None);
        let legacy = serde_json::json!({ "hook_event_name": "Notification", "message": "Claude needs your permission to use Edit" });
        assert_eq!(classify_claude_hook(&legacy).map(|e| e.0), Some("approval"));
    }

    #[test]
    fn codex_messages_are_classified() {
        assert_eq!(classify_codex_message("Approval requested: npm test").0, "approval");
        assert_eq!(classify_codex_message("Codex wants to edit 3 files").0, "approval");
        assert_eq!(classify_codex_message("Agent turn complete"), ("done", String::new()));
        assert_eq!(classify_codex_message("Fixed the parser"), ("done", "Fixed the parser".into()));
    }

    #[test]
    fn hook_settings_point_back_to_this_executable() {
        let dir = std::env::temp_dir().join(format!("athenas-hooks-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = claude_hook_settings(&dir).unwrap();
        let settings: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let command = settings["hooks"]["Stop"][0]["hooks"][0]["command"].as_str().unwrap();
        assert!(command.contains(HOOK_FLAG) && command.contains(EVENTS_FILE) && !command.contains('\\'));
        assert!(settings["hooks"]["Notification"].is_array());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn hook_queue_round_trip() {
        let path = std::env::temp_dir().join(format!("athenas-events-{}.sqlite3", uuid::Uuid::new_v4()));
        let db = open(&path).unwrap();
        db.execute("INSERT INTO agent_events (session_id, kind, message) VALUES ('s', 'done', '')", []).unwrap();
        let count: i64 = db.query_row("SELECT count(*) FROM agent_events", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1);
        drop(db);
        let _ = fs::remove_file(path);
    }
}
