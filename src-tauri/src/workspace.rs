use rusqlite::{params, Connection};
use serde::Serialize;
use std::{fs, sync::Mutex};
use tauri::{AppHandle, Manager};

pub struct WorkspaceDb(Mutex<Connection>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub group_id: Option<String>,
    pub name: String,
    pub folder: Option<String>,
    pub layout: String,
    pub updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub groups: Vec<Group>,
    pub projects: Vec<Project>,
}

fn migrate(connection: &Connection) -> Result<(), String> {
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if version == 0 {
        connection.execute_batch("BEGIN;
            CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE projects (id TEXT PRIMARY KEY, group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
                name TEXT NOT NULL, folder TEXT, layout TEXT NOT NULL DEFAULT 'auto', updated_at INTEGER NOT NULL);
            PRAGMA user_version = 1;
            COMMIT;").map_err(|e| e.to_string())?;
    } else if version != 1 && version != 2 {
        return Err(format!("Versão de banco não suportada: {version}"));
    }
    if version < 2 {
        connection
            .execute_batch(
                "BEGIN;
            CREATE TABLE sessions (id TEXT PRIMARY KEY, agent TEXT NOT NULL, folder TEXT NOT NULL,
                command TEXT NOT NULL, resume_id TEXT, status TEXT NOT NULL);
            PRAGMA user_version = 2;
            COMMIT;",
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

impl WorkspaceDb {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let connection =
            Connection::open(directory.join("workspace.sqlite3")).map_err(|e| e.to_string())?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
        migrate(&connection)?;
        Ok(Self(Mutex::new(connection)))
    }

    fn snapshot(&self) -> Result<WorkspaceSnapshot, String> {
        let connection = self.0.lock().map_err(|e| e.to_string())?;
        let mut groups_query = connection
            .prepare("SELECT id, name FROM groups ORDER BY name COLLATE NOCASE")
            .map_err(|e| e.to_string())?;
        let groups = groups_query
            .query_map([], |row| {
                Ok(Group {
                    id: row.get(0)?,
                    name: row.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut projects_query = connection.prepare("SELECT id, group_id, name, folder, layout, updated_at FROM projects ORDER BY updated_at DESC, rowid DESC").map_err(|e| e.to_string())?;
        let projects = projects_query
            .query_map([], |row| {
                Ok(Project {
                    id: row.get(0)?,
                    group_id: row.get(1)?,
                    name: row.get(2)?,
                    folder: row.get(3)?,
                    layout: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(WorkspaceSnapshot { groups, projects })
    }
}

fn clean_name(name: String) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("O nome precisa ter entre 1 e 80 caracteres.".into());
    }
    Ok(name.into())
}

#[tauri::command]
pub fn workspace_list(state: tauri::State<'_, WorkspaceDb>) -> Result<WorkspaceSnapshot, String> {
    state.snapshot()
}

#[tauri::command]
pub fn group_create(
    state: tauri::State<'_, WorkspaceDb>,
    name: String,
) -> Result<WorkspaceSnapshot, String> {
    let name = clean_name(name)?;
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .execute(
            "INSERT INTO groups (id, name) VALUES (?1, ?2)",
            params![uuid::Uuid::new_v4().to_string(), name],
        )
        .map_err(|e| e.to_string())?;
    state.snapshot()
}

#[tauri::command]
pub fn project_create(
    state: tauri::State<'_, WorkspaceDb>,
    name: String,
    folder: Option<String>,
    group_id: Option<String>,
) -> Result<WorkspaceSnapshot, String> {
    let name = clean_name(name)?;
    let folder = folder
        .filter(|value| !value.trim().is_empty())
        .ok_or("Escolha a pasta do projeto.")?;
    let path = fs::canonicalize(&folder)
        .map_err(|_| "A pasta não existe ou não está acessível.".to_string())?;
    if !path.is_dir() {
        return Err("Escolha uma pasta válida.".into());
    }
    let folder = Some(path.to_string_lossy().into_owned());
    let connection = state.0.lock().map_err(|e| e.to_string())?;
    connection.execute("INSERT INTO projects (id, group_id, name, folder, updated_at) VALUES (?1, ?2, ?3, ?4, unixepoch())",
        params![uuid::Uuid::new_v4().to_string(), group_id, name, folder]).map_err(|e| e.to_string())?;
    drop(connection);
    state.snapshot()
}

#[tauri::command]
pub fn project_set_layout(
    state: tauri::State<'_, WorkspaceDb>,
    id: String,
    layout: String,
) -> Result<WorkspaceSnapshot, String> {
    if !["auto", "spotlight", "sidebar", "grid"].contains(&layout.as_str()) {
        return Err("Layout inválido.".into());
    }
    let changed = state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .execute(
            "UPDATE projects SET layout = ?1, updated_at = unixepoch() WHERE id = ?2",
            params![layout, id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Projeto não encontrado.".into());
    }
    state.snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_creates_persistent_workspace_schema_once() {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        migrate(&connection).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 2);
        connection
            .execute("INSERT INTO groups (id, name) VALUES ('g1', 'Equipe')", [])
            .unwrap();
        connection.execute("INSERT INTO projects (id, group_id, name, updated_at) VALUES ('p1', 'g1', 'Projeto', 1)", []).unwrap();
        connection.execute("INSERT INTO sessions (id, agent, folder, command, status) VALUES ('s1', 'Shell', 'C:/', 'cmd.exe', 'rodando')", []).unwrap();
    }
}
