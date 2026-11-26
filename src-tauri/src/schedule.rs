//! Prompts scheduled to be typed into an agent at a given time: into a session that is open
//! (or a session that resumed the same conversation), or into a new session started for it.
use crate::{settings::PreferencesStore, terminal::TerminalState};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

const MAX_TEXT: usize = 32_000;
const AGENTS: [&str; 3] = ["Claude Code", "Codex", "Shell"];
const REPEATS: [&str; 4] = ["none", "hourly", "daily", "weekly"];

pub struct Scheduler {
    path: PathBuf,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledPrompt {
    pub id: String,
    /// `session` (an existing session) or `new` (start a session at run time).
    pub target: String,
    pub session_id: Option<String>,
    pub agent: String,
    pub folder: String,
    pub label: String,
    pub text: String,
    pub run_at: i64,
    pub repeat: String,
    /// `pending`, `sent`, `failed` or `cancelled`.
    pub status: String,
    pub last_error: Option<String>,
    pub last_run_at: Option<i64>,
    pub created_at: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Fired {
    id: String,
    label: String,
    agent: String,
    error: Option<String>,
    session_id: Option<String>,
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn open(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|e| e.to_string())?;
    connection.busy_timeout(Duration::from_secs(2)).map_err(|e| e.to_string())?;
    Ok(connection)
}

fn list(connection: &Connection) -> Result<Vec<ScheduledPrompt>, String> {
    let mut query = connection
        .prepare(
            "SELECT id, target, session_id, agent, folder, label, text, run_at, repeat, status, last_error, last_run_at, created_at
             FROM scheduled_prompts ORDER BY status='pending' DESC, run_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([], |row| {
            Ok(ScheduledPrompt {
                id: row.get(0)?,
                target: row.get(1)?,
                session_id: row.get(2)?,
                agent: row.get(3)?,
                folder: row.get(4)?,
                label: row.get(5)?,
                text: row.get(6)?,
                run_at: row.get(7)?,
                repeat: row.get(8)?,
                status: row.get(9)?,
                last_error: row.get(10)?,
                last_run_at: row.get(11)?,
                created_at: row.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    rows
}

/// Next run after `now` for a repeating prompt; missed runs while the app was closed are skipped, not replayed.
pub fn next_run(run_at: i64, repeat: &str, now: i64) -> Option<i64> {
    let step = match repeat {
        "hourly" => 3_600,
        "daily" => 86_400,
        "weekly" => 604_800,
        _ => return None,
    };
    let behind = (now - run_at).max(0);
    Some(run_at + (behind / step + 1) * step)
}

fn folder_name(folder: &str) -> &str {
    folder.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().unwrap_or(folder)
}

impl Scheduler {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("workspace.sqlite3");
        Ok(Self { path })
    }

    /// Checks for due prompts every few seconds for the app's lifetime.
    pub fn start(&self, app: AppHandle) {
        let path = self.path.clone();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(5));
            let Ok(connection) = open(&path) else { continue };
            let due: Vec<ScheduledPrompt> = list(&connection)
                .unwrap_or_default()
                .into_iter()
                .filter(|item| item.status == "pending" && item.run_at <= now())
                .collect();
            for item in due {
                let result = deliver(&app, &item);
                let ran = now();
                let (status, run_at, error) = match &result {
                    Ok(_) => match next_run(item.run_at, &item.repeat, ran) {
                        Some(next) => ("pending", next, None),
                        None => ("sent", item.run_at, None),
                    },
                    Err(error) => ("failed", item.run_at, Some(error.clone())),
                };
                let _ = connection.execute(
                    "UPDATE scheduled_prompts SET status=?2, run_at=?3, last_error=?4, last_run_at=?5 WHERE id=?1",
                    params![item.id, status, run_at, error, ran],
                );
                let _ = app.emit(
                    "schedule-fired",
                    Fired { id: item.id.clone(), label: item.label.clone(), agent: item.agent.clone(), error, session_id: result.ok() },
                );
                let _ = app.emit("schedule-changed", ());
            }
        });
    }
}

/// Types the prompt into its target; returns the session that received it.
fn deliver(app: &AppHandle, item: &ScheduledPrompt) -> Result<String, String> {
    let state = app.state::<TerminalState>();
    if item.target == "session" {
        let id = item.session_id.as_deref().ok_or("Agendamento sem sessão.")?;
        let (target, agent) = crate::terminal::running_target(&state, id)
            .ok_or("A sessão não está aberta. Retome-a ou agende para uma sessão nova.")?;
        type_prompt(&state, &target, &agent, &item.text)?;
        return Ok(target);
    }
    let shell = item.agent == "Shell";
    let info = crate::terminal::terminal_start(
        app.clone(),
        state.clone(),
        app.state::<PreferencesStore>(),
        item.agent.clone(),
        item.folder.clone(),
        String::new(),
        None,
        None,
        false,
        None,
        (!shell).then(|| item.text.clone()),
        120,
        32,
        None,
        None,
    )?;
    let _ = app.emit("terminal-status", info.clone());
    if shell {
        // Give the shell a moment to show its prompt before typing.
        thread::sleep(Duration::from_millis(900));
        type_prompt(&state, &info.id, "Shell", &item.text)?;
    }
    Ok(info.id)
}

fn type_prompt(state: &TerminalState, id: &str, agent: &str, text: &str) -> Result<(), String> {
    crate::links::submit(state, id, agent, &crate::links::paste_payload(agent, text))
}

#[tauri::command]
pub fn schedule_list(state: tauri::State<'_, Scheduler>) -> Result<Vec<ScheduledPrompt>, String> {
    list(&open(&state.path)?)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn schedule_create(
    state: tauri::State<'_, Scheduler>,
    terminal: tauri::State<'_, TerminalState>,
    target: String,
    session_id: Option<String>,
    agent: Option<String>,
    folder: Option<String>,
    text: String,
    run_at: i64,
    repeat: String,
) -> Result<Vec<ScheduledPrompt>, String> {
    if text.trim().is_empty() || text.len() > MAX_TEXT || text.contains('\0') {
        return Err("Escreva um prompt de até 32 mil caracteres.".into());
    }
    if !REPEATS.contains(&repeat.as_str()) {
        return Err("Repetição inválida.".into());
    }
    if run_at < now() - 60 || run_at > now() + 366 * 86_400 {
        return Err("Escolha um horário no futuro (até um ano).".into());
    }
    let (session_id, agent, folder, label) = match target.as_str() {
        "session" => {
            let id = session_id.ok_or("Escolha a sessão.")?;
            let session = crate::terminal::session_summary(&terminal, &id).ok_or("Sessão não encontrada.")?;
            let name = session.title.clone().unwrap_or_else(|| session.agent.clone());
            let label = format!("{name} · {}", folder_name(&session.folder));
            (Some(id), session.agent, session.folder, label)
        }
        "new" => {
            let agent = agent.filter(|value| AGENTS.contains(&value.as_str())).ok_or("Agente inválido.")?;
            let folder = folder.filter(|value| Path::new(value).is_dir()).ok_or("Escolha uma pasta existente.")?;
            let label = format!("Nova sessão {agent} · {}", folder_name(&folder));
            (None, agent, folder, label)
        }
        _ => return Err("Destino inválido.".into()),
    };
    let connection = open(&state.path)?;
    connection
        .execute(
            "INSERT INTO scheduled_prompts (id, target, session_id, agent, folder, label, text, run_at, repeat, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10)",
            params![uuid::Uuid::new_v4().to_string(), target, session_id, agent, folder, label, text, run_at, repeat, now()],
        )
        .map_err(|e| e.to_string())?;
    list(&connection)
}

#[tauri::command]
pub fn schedule_cancel(state: tauri::State<'_, Scheduler>, id: String) -> Result<Vec<ScheduledPrompt>, String> {
    let connection = open(&state.path)?;
    connection
        .execute("UPDATE scheduled_prompts SET status='cancelled' WHERE id=?1 AND status='pending'", [&id])
        .map_err(|e| e.to_string())?;
    list(&connection)
}

#[tauri::command]
pub fn schedule_delete(state: tauri::State<'_, Scheduler>, id: String) -> Result<Vec<ScheduledPrompt>, String> {
    let connection = open(&state.path)?;
    connection.execute("DELETE FROM scheduled_prompts WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    list(&connection)
}

/// Sends a prompt on the next check, whatever its time; also retries a failed one.
#[tauri::command]
pub fn schedule_run_now(state: tauri::State<'_, Scheduler>, id: String) -> Result<Vec<ScheduledPrompt>, String> {
    let connection = open(&state.path)?;
    connection
        .execute(
            "UPDATE scheduled_prompts SET status='pending', run_at=?2, last_error=NULL WHERE id=?1 AND status!='cancelled'",
            params![id, now()],
        )
        .map_err(|e| e.to_string())?;
    list(&connection)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeating_prompts_skip_missed_runs() {
        assert_eq!(next_run(1_000, "none", 5_000), None);
        assert_eq!(next_run(1_000, "hourly", 1_000), Some(4_600));
        // Closed for three days: the next daily run is tomorrow, not three catch-up runs.
        assert_eq!(next_run(0, "daily", 3 * 86_400 + 10), Some(4 * 86_400));
        assert_eq!(next_run(0, "weekly", 1), Some(604_800));
    }

    #[test]
    fn labels_use_the_folder_name() {
        assert_eq!(folder_name(r"C:\Users\me\Projeto\"), "Projeto");
        assert_eq!(folder_name("/home/me/app"), "app");
    }
}
