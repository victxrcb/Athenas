//! Live channel between Claude Code hooks and the chat view.
//!
//! Hook processes write into the same SQLite file used for attention events: compact "live" events (text
//! deltas, tool start/end, transcript path) and pending permission requests. The app drains the first and
//! answers the second. A permission request never blocks the terminal: Claude Code shows its own dialog
//! while the hook waits, the first answer wins, and the hook is killed when the terminal one comes first.
//! Nothing here approves anything by itself; without an explicit decision the hook prints nothing.
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// A request counts as pending while its hook process keeps refreshing it.
const REQUEST_STALE_MS: i64 = 2_500;
/// Hooks give up when the app stops updating its heartbeat (closed or hung).
const APP_STALE_MS: i64 = 6_000;
const POLL: Duration = Duration::from_millis(150);
pub const PERMISSION_TIMEOUT_SECS: u64 = 3_600;
const MAX_EVENT_STRING: usize = 8_000;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

pub fn migrate(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS live_events (
               id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, payload TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS permission_requests (
               id TEXT PRIMARY KEY, session_id TEXT NOT NULL, payload TEXT NOT NULL,
               created_ms INTEGER NOT NULL, alive_ms INTEGER NOT NULL, decision TEXT);
             CREATE TABLE IF NOT EXISTS app_heartbeat (id INTEGER PRIMARY KEY CHECK (id = 1), at_ms INTEGER NOT NULL);",
        )
        .map_err(|e| e.to_string())
}

/// Clears what a previous run left behind.
pub fn reset(connection: &Connection) {
    let _ = connection.execute_batch("DELETE FROM live_events; DELETE FROM permission_requests; DELETE FROM app_heartbeat;");
}

pub fn heartbeat(connection: &Connection) {
    let _ = connection.execute(
        "INSERT INTO app_heartbeat (id, at_ms) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET at_ms=excluded.at_ms",
        [now_ms()],
    );
}

fn app_alive(connection: &Connection) -> bool {
    connection
        .query_row("SELECT at_ms FROM app_heartbeat WHERE id=1", [], |row| row.get::<_, i64>(0))
        .is_ok_and(|at| now_ms() - at < APP_STALE_MS)
}

fn clip_value(value: &Value) -> Value {
    match value {
        Value::String(text) => match text.char_indices().nth(MAX_EVENT_STRING) {
            Some((index, _)) => Value::String(format!("{}…", &text[..index])),
            None => value.clone(),
        },
        Value::Array(items) => Value::Array(items.iter().take(100).map(clip_value).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), clip_value(item))).collect()),
        _ => value.clone(),
    }
}

/// The compact form of a hook payload the chat view needs; `None` for events it ignores.
pub fn live_event(payload: &Value) -> Option<Value> {
    let event = payload.get("hook_event_name").and_then(Value::as_str)?;
    if !matches!(event, "SessionStart" | "UserPromptSubmit" | "MessageDisplay" | "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PermissionRequest" | "Stop" | "StopFailure") {
        return None;
    }
    let mut out = Map::new();
    out.insert("event".into(), event.into());
    out.insert("at".into(), now_ms().into());
    for (source, target) in [
        ("transcript_path", "transcriptPath"), ("permission_mode", "permissionMode"), ("model", "model"),
        ("tool_name", "toolName"), ("tool_use_id", "toolUseId"), ("agent_id", "agentId"),
        ("message_id", "messageId"), ("index", "index"), ("final", "final"), ("duration_ms", "durationMs"),
    ] {
        if let Some(value) = payload.get(source) {
            out.insert(target.into(), value.clone());
        }
    }
    if let Some(level) = payload.pointer("/effort/level") {
        out.insert("effort".into(), level.clone());
    }
    // Deltas are the streamed answer itself, so they travel whole.
    if let Some(delta) = payload.get("delta") {
        out.insert("delta".into(), delta.clone());
    }
    if event == "PreToolUse" {
        if let Some(input) = payload.get("tool_input") {
            out.insert("toolInput".into(), clip_value(input));
        }
    }
    Some(Value::Object(out))
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Decision {
    /// `allow`, `deny`, `always` (apply one of Claude's own suggestions) or `answer` (AskUserQuestion).
    pub behavior: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answers: Option<Map<String, Value>>,
}

/// The hook output for a decision, or `None` when that decision is not valid for the request.
pub fn decision_output(request: &Value, decision: &Decision) -> Option<Value> {
    let tool = request.get("tool_name").and_then(Value::as_str).unwrap_or_default();
    // These two need an edited input; a bare "allow" does not answer them.
    let interactive = matches!(tool, "AskUserQuestion" | "ExitPlanMode");
    let body = match decision.behavior.as_str() {
        "allow" if !interactive => json!({ "behavior": "allow" }),
        "deny" => json!({ "behavior": "deny", "message": "Recusado pelo usuário no Athenas." }),
        "always" if !interactive => {
            let suggestion = request.get("permission_suggestions")?.as_array()?.get(decision.suggestion?)?;
            // Never widen to a mode that skips every check, even if it is suggested.
            if suggestion.get("mode").and_then(Value::as_str) == Some("bypassPermissions") {
                return None;
            }
            json!({ "behavior": "allow", "updatedPermissions": [suggestion] })
        }
        "answer" if tool == "AskUserQuestion" => {
            let input = request.get("tool_input")?.as_object()?;
            let questions = input.get("questions")?.as_array()?;
            let answers = decision.answers.as_ref()?;
            let complete = !questions.is_empty() && answers.len() == questions.len() && questions.iter().all(|question| {
                question.get("question").and_then(Value::as_str)
                    .and_then(|text| answers.get(text))
                    .and_then(Value::as_str)
                    .is_some_and(|answer| !answer.trim().is_empty() && answer.len() <= 4_000)
            });
            if !complete {
                return None;
            }
            let mut updated = input.clone();
            updated.insert("answers".into(), Value::Object(answers.clone()));
            json!({ "behavior": "allow", "updatedInput": updated })
        }
        _ => return None,
    };
    Some(json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": body } }))
}

pub fn record(connection: &Connection, session_id: &str, event: &Value) {
    let _ = connection.execute(
        "INSERT INTO live_events (session_id, payload) VALUES (?1, ?2)",
        params![session_id, event.to_string()],
    );
}

/// Registers a permission request and waits for the user's decision in the chat. Returns the hook output
/// to print, or `None` to leave the terminal dialog as the only way to answer.
pub fn await_decision(connection: &Connection, session_id: &str, request: &Value, timeout: Duration) -> Option<Value> {
    if !app_alive(connection) {
        return None;
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    connection
        .execute(
            "INSERT INTO permission_requests (id, session_id, payload, created_ms, alive_ms) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, session_id, request.to_string(), now],
        )
        .ok()?;
    let started = Instant::now();
    let output = loop {
        thread::sleep(POLL);
        // The row disappears when the app decides the request is moot (turn ended, session removed).
        let row: Result<Option<String>, _> = connection.query_row("SELECT decision FROM permission_requests WHERE id=?1", [&id], |row| row.get(0));
        match row {
            Ok(Some(text)) => break serde_json::from_str::<Decision>(&text).ok().and_then(|decision| decision_output(request, &decision)),
            Ok(None) => {}
            Err(rusqlite::Error::QueryReturnedNoRows) => break None,
            Err(_) => continue,
        }
        if started.elapsed() > timeout || !app_alive(connection) {
            break None;
        }
        let _ = connection.execute("UPDATE permission_requests SET alive_ms=?2 WHERE id=?1", params![id, now_ms()]);
    };
    let _ = connection.execute("DELETE FROM permission_requests WHERE id=?1", [&id]);
    output
}

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PendingPermission {
    pub id: String,
    pub session_id: String,
    pub tool_name: String,
    pub tool_input: Value,
    pub suggestions: Value,
    pub agent_id: Option<String>,
    pub created_at: i64,
}

/// Requests still waiting for an answer; abandoned ones are removed.
pub fn pending(connection: &Connection) -> Vec<PendingPermission> {
    let _ = connection.execute("DELETE FROM permission_requests WHERE alive_ms < ?1", [now_ms() - REQUEST_STALE_MS]);
    let Ok(mut query) = connection.prepare("SELECT id, session_id, payload, created_ms FROM permission_requests WHERE decision IS NULL ORDER BY created_ms") else {
        return Vec::new();
    };
    query
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?)))
        .map(|rows| {
            rows.flatten()
                .filter_map(|(id, session_id, payload, created_at)| {
                    let payload: Value = serde_json::from_str(&payload).ok()?;
                    Some(PendingPermission {
                        id,
                        session_id,
                        tool_name: payload.get("tool_name").and_then(Value::as_str).unwrap_or("Ferramenta").to_string(),
                        tool_input: payload.get("tool_input").cloned().unwrap_or(Value::Null),
                        suggestions: payload.get("permission_suggestions").cloned().unwrap_or_else(|| json!([])),
                        agent_id: payload.get("agent_id").and_then(Value::as_str).map(str::to_string),
                        created_at,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn decide(connection: &Connection, session_id: &str, id: &str, decision: &Decision) -> Result<(), String> {
    const GONE: &str = "Esta solicitação já foi respondida ou expirou.";
    let payload: String = connection
        .query_row(
            "SELECT payload FROM permission_requests WHERE id=?1 AND session_id=?2 AND decision IS NULL AND alive_ms >= ?3",
            params![id, session_id, now_ms() - REQUEST_STALE_MS],
            |row| row.get(0),
        )
        .map_err(|_| GONE.to_string())?;
    let request: Value = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
    if decision_output(&request, decision).is_none() {
        return Err("Resposta não aceita para esta solicitação.".into());
    }
    let text = serde_json::to_string(decision).map_err(|e| e.to_string())?;
    let changed = connection
        .execute("UPDATE permission_requests SET decision=?2 WHERE id=?1 AND decision IS NULL", params![id, text])
        .map_err(|e| e.to_string())?;
    if changed == 1 { Ok(()) } else { Err(GONE.into()) }
}

/// Takes the queued live events, oldest first.
pub fn drain(connection: &Connection) -> Vec<(String, Value)> {
    let rows: Vec<(i64, String, String)> = connection
        .prepare("SELECT id, session_id, payload FROM live_events ORDER BY id LIMIT 400")
        .and_then(|mut query| query.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?.collect())
        .unwrap_or_default();
    if let Some((last, _, _)) = rows.last() {
        let _ = connection.execute("DELETE FROM live_events WHERE id <= ?1", [last]);
    }
    rows.into_iter()
        .filter_map(|(_, session, payload)| Some((session, serde_json::from_str(&payload).ok()?)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> (Connection, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!("athenas-live-{}.sqlite3", uuid::Uuid::new_v4()));
        let connection = Connection::open(&path).unwrap();
        migrate(&connection).unwrap();
        (connection, path)
    }

    fn decision(behavior: &str) -> Decision {
        Decision { behavior: behavior.into(), suggestion: None, answers: None }
    }

    #[test]
    fn decisions_only_produce_what_the_request_supports() {
        let bash = json!({ "tool_name": "Bash", "tool_input": { "command": "npm i" }, "permission_suggestions": [
            { "type": "addRules", "rules": [{ "toolName": "Bash" }], "behavior": "allow", "destination": "session" },
            { "type": "setMode", "mode": "bypassPermissions", "destination": "session" } ] });
        let allow = decision_output(&bash, &decision("allow")).unwrap();
        assert_eq!(allow["hookSpecificOutput"]["decision"], json!({ "behavior": "allow" }));
        assert_eq!(decision_output(&bash, &decision("deny")).unwrap()["hookSpecificOutput"]["decision"]["behavior"], "deny");
        let always = decision_output(&bash, &Decision { suggestion: Some(0), ..decision("always") }).unwrap();
        assert_eq!(always["hookSpecificOutput"]["decision"]["updatedPermissions"][0]["type"], "addRules");
        assert!(decision_output(&bash, &Decision { suggestion: Some(1), ..decision("always") }).is_none());
        assert!(decision_output(&bash, &Decision { suggestion: Some(9), ..decision("always") }).is_none());
        assert!(decision_output(&bash, &decision("answer")).is_none());
        assert!(decision_output(&bash, &decision("whatever")).is_none());
        let plan = json!({ "tool_name": "ExitPlanMode", "tool_input": { "plan": "x" } });
        assert!(decision_output(&plan, &decision("allow")).is_none());
        assert!(decision_output(&plan, &decision("deny")).is_some());
    }

    #[test]
    fn question_answers_must_cover_every_question() {
        let request = json!({ "tool_name": "AskUserQuestion", "tool_input": { "questions": [{ "question": "Cor?" }, { "question": "Tom?" }] } });
        let mut answers = Map::new();
        answers.insert("Cor?".into(), "Azul".into());
        assert!(decision_output(&request, &Decision { answers: Some(answers.clone()), ..decision("answer") }).is_none());
        answers.insert("Tom?".into(), "Claro".into());
        let output = decision_output(&request, &Decision { answers: Some(answers), ..decision("answer") }).unwrap();
        assert_eq!(output["hookSpecificOutput"]["decision"]["updatedInput"]["answers"]["Cor?"], "Azul");
        assert!(output["hookSpecificOutput"]["decision"]["updatedInput"]["questions"].is_array());
        assert!(decision_output(&request, &decision("allow")).is_none());
    }

    #[test]
    fn nothing_waits_when_the_app_is_not_running() {
        let (connection, path) = database();
        assert!(await_decision(&connection, "s", &json!({ "tool_name": "Bash" }), Duration::from_secs(5)).is_none());
        assert!(pending(&connection).is_empty());
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_decision_reaches_the_waiting_hook_once() {
        let (connection, path) = database();
        heartbeat(&connection);
        let hook_path = path.clone();
        let hook = thread::spawn(move || {
            let connection = Connection::open(hook_path).unwrap();
            await_decision(&connection, "s", &json!({ "tool_name": "Bash", "tool_input": {} }), Duration::from_secs(5))
        });
        let request = (0..100).find_map(|_| {
            thread::sleep(Duration::from_millis(30));
            pending(&connection).into_iter().next()
        }).expect("request never appeared");
        assert!(decide(&connection, "other", &request.id, &decision("allow")).is_err());
        decide(&connection, "s", &request.id, &decision("allow")).unwrap();
        assert!(decide(&connection, "s", &request.id, &decision("deny")).is_err());
        let output = hook.join().unwrap().unwrap();
        assert_eq!(output["hookSpecificOutput"]["decision"]["behavior"], "allow");
        assert!(pending(&connection).is_empty());
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn abandoned_requests_disappear_and_events_drain_in_order() {
        let (connection, path) = database();
        connection.execute("INSERT INTO permission_requests (id, session_id, payload, created_ms, alive_ms) VALUES ('a','s','{}',0,0)", []).unwrap();
        assert!(pending(&connection).is_empty());
        assert!(decide(&connection, "s", "a", &decision("allow")).is_err());
        record(&connection, "s", &json!({ "n": 1 }));
        record(&connection, "s", &json!({ "n": 2 }));
        let drained = drain(&connection);
        assert_eq!(drained.iter().map(|(_, value)| value["n"].as_i64().unwrap()).collect::<Vec<_>>(), vec![1, 2]);
        assert!(drain(&connection).is_empty());
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn live_events_keep_only_what_the_chat_needs() {
        let delta = live_event(&json!({ "hook_event_name": "MessageDisplay", "delta": "Oi", "index": 0, "final": true, "message_id": "m", "cwd": "x" })).unwrap();
        assert_eq!((delta["delta"].as_str(), delta["messageId"].as_str(), delta.get("cwd")), (Some("Oi"), Some("m"), None));
        let done = live_event(&json!({ "hook_event_name": "PostToolUse", "tool_use_id": "t", "tool_response": "segredo", "tool_input": { "a": 1 } })).unwrap();
        assert!(done.get("toolResponse").is_none() && done.get("toolInput").is_none());
        assert!(live_event(&json!({ "hook_event_name": "PreCompact" })).is_none());
    }
}
