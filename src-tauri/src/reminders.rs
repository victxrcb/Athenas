//! Personal reminders: persistent notes with an optional one-shot notification time.
use rusqlite::{params, Connection};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

const MAX_TEXT: usize = 4_000;

pub struct ReminderStore {
    path: PathBuf,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    pub text: String,
    pub scheduled_at: Option<i64>,
    pub notified_at: Option<i64>,
    pub created_at: i64,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
}

fn open(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

fn list(connection: &Connection) -> Result<Vec<Reminder>, String> {
    let mut query = connection
        .prepare(
            "SELECT id, text, scheduled_at, notified_at, created_at FROM reminders
             ORDER BY CASE WHEN scheduled_at IS NOT NULL AND notified_at IS NULL THEN 0 ELSE 1 END,
                      scheduled_at, created_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = query
        .query_map([], |row| {
            Ok(Reminder {
                id: row.get(0)?,
                text: row.get(1)?,
                scheduled_at: row.get(2)?,
                notified_at: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string());
    rows
}

impl ReminderStore {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let path = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("workspace.sqlite3");
        Ok(Self { path })
    }

    /// Claims due reminders before notifying, so each schedule is announced at most once.
    pub fn start(&self, app: AppHandle) {
        let path = self.path.clone();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(5));
            let Ok(connection) = open(&path) else {
                continue;
            };
            let due = list(&connection)
                .unwrap_or_default()
                .into_iter()
                .filter(|item| {
                    item.scheduled_at
                        .is_some_and(|scheduled| scheduled <= now())
                        && item.notified_at.is_none()
                })
                .collect::<Vec<_>>();
            for item in due {
                let fired_at = now();
                let claimed = connection
                    .execute(
                        "UPDATE reminders SET notified_at=?2 WHERE id=?1 AND notified_at IS NULL",
                        params![item.id, fired_at],
                    )
                    .unwrap_or(0);
                if claimed == 0 {
                    continue;
                }
                let _ = crate::notify::notify_show(
                    app.clone(),
                    "Lembrete".into(),
                    item.text.clone(),
                    None,
                    Some(format!("reminder:{}", item.id)),
                );
                let _ = app.emit("reminder-due", item);
                let _ = app.emit("reminders-changed", ());
            }
        });
    }
}

#[tauri::command]
pub fn reminder_list(state: tauri::State<'_, ReminderStore>) -> Result<Vec<Reminder>, String> {
    list(&open(&state.path)?)
}

#[tauri::command]
pub fn reminder_create(
    state: tauri::State<'_, ReminderStore>,
    text: String,
    scheduled_at: Option<i64>,
) -> Result<Vec<Reminder>, String> {
    let text = text.trim();
    if text.is_empty() || text.len() > MAX_TEXT || text.contains('\0') {
        return Err("Escreva um lembrete de até 4 mil caracteres.".into());
    }
    if scheduled_at
        .is_some_and(|scheduled| scheduled < now() - 60 || scheduled > now() + 366 * 86_400)
    {
        return Err("Escolha um horário futuro, com no máximo um ano de antecedência.".into());
    }
    let connection = open(&state.path)?;
    connection
        .execute(
            "INSERT INTO reminders (id, text, scheduled_at, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![uuid::Uuid::new_v4().to_string(), text, scheduled_at, now()],
        )
        .map_err(|error| error.to_string())?;
    list(&connection)
}

#[tauri::command]
pub fn reminder_delete(
    state: tauri::State<'_, ReminderStore>,
    id: String,
) -> Result<Vec<Reminder>, String> {
    let connection = open(&state.path)?;
    connection
        .execute("DELETE FROM reminders WHERE id=?1", [&id])
        .map_err(|error| error.to_string())?;
    list(&connection)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reminder_rows_round_trip_optional_schedule() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE reminders (id TEXT PRIMARY KEY, text TEXT NOT NULL, scheduled_at INTEGER, notified_at INTEGER, created_at INTEGER NOT NULL);",
        ).unwrap();
        connection
            .execute(
                "INSERT INTO reminders (id, text, created_at) VALUES ('note', 'Comprar café', 10)",
                [],
            )
            .unwrap();
        connection.execute("INSERT INTO reminders (id, text, scheduled_at, created_at) VALUES ('alarm', 'Reunião', 20, 11)", []).unwrap();
        let items = list(&connection).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "alarm");
        assert_eq!(items[1].scheduled_at, None);
    }
}
