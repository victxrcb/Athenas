use rusqlite::{params, Connection};
use serde::Serialize;
use std::{fs, sync::Mutex};
use std::{path::PathBuf, process::Command};
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
    pub split_ratio: f64,
    pub updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub groups: Vec<Group>,
    pub projects: Vec<Project>,
    pub panes: Vec<Pane>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pane {
    pub id: String,
    pub project_id: String,
    pub position: i64,
    pub pinned: bool,
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
    } else if version != 1 && version != 2 && version != 3 && version != 4 && version != 5 {
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
    if version < 3 {
        connection.execute_batch("BEGIN;
            CREATE TABLE panes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                position INTEGER NOT NULL);
            ALTER TABLE sessions ADD COLUMN pane_id TEXT REFERENCES panes(id) ON DELETE SET NULL;
            PRAGMA user_version = 3;
            COMMIT;").map_err(|e| e.to_string())?;
    }
    if version < 4 {
        connection
            .execute_batch(
                "BEGIN;
            ALTER TABLE projects ADD COLUMN split_ratio REAL NOT NULL DEFAULT 0.5;
            PRAGMA user_version = 4;
            COMMIT;",
            )
            .map_err(|e| e.to_string())?;
    }
    if version < 5 {
        connection.execute_batch("BEGIN;
            ALTER TABLE panes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
            PRAGMA user_version = 5;
            COMMIT;").map_err(|e| e.to_string())?;
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
        let mut projects_query = connection.prepare("SELECT id, group_id, name, folder, layout, split_ratio, updated_at FROM projects ORDER BY updated_at DESC, rowid DESC").map_err(|e| e.to_string())?;
        let projects = projects_query
            .query_map([], |row| {
                Ok(Project {
                    id: row.get(0)?,
                    group_id: row.get(1)?,
                    name: row.get(2)?,
                    folder: row.get(3)?,
                    layout: row.get(4)?,
                    split_ratio: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut panes_query = connection
            .prepare("SELECT id, project_id, position, pinned FROM panes ORDER BY pinned DESC, position")
            .map_err(|e| e.to_string())?;
        let panes = panes_query
            .query_map([], |row| {
                Ok(Pane {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    position: row.get(2)?,
                    pinned: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(WorkspaceSnapshot {
            groups,
            projects,
            panes,
        })
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

#[tauri::command]
pub fn project_set_split(
    state: tauri::State<'_, WorkspaceDb>,
    id: String,
    ratio: f64,
) -> Result<WorkspaceSnapshot, String> {
    if !ratio.is_finite() || !(0.2..=0.8).contains(&ratio) {
        return Err("Divisão inválida.".into());
    }
    let changed = state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .execute(
            "UPDATE projects SET split_ratio=?1 WHERE id=?2",
            params![ratio, id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Projeto não encontrado.".into());
    }
    state.snapshot()
}

#[tauri::command]
pub fn pane_create(
    state: tauri::State<'_, WorkspaceDb>,
    project_id: String,
) -> Result<WorkspaceSnapshot, String> {
    let connection = state.0.lock().map_err(|e| e.to_string())?;
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
            [&project_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("Projeto não encontrado.".into());
    }
    let position: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM panes WHERE project_id = ?1",
            [&project_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    connection
        .execute(
            "INSERT INTO panes (id, project_id, position) VALUES (?1, ?2, ?3)",
            params![uuid::Uuid::new_v4().to_string(), project_id, position],
        )
        .map_err(|e| e.to_string())?;
    drop(connection);
    state.snapshot()
}

#[tauri::command]
pub fn pane_set_pinned(state: tauri::State<'_, WorkspaceDb>, id: String, pinned: bool) -> Result<WorkspaceSnapshot, String> {
    let changed = state.0.lock().map_err(|e| e.to_string())?.execute(
        "UPDATE panes SET pinned=?1 WHERE id=?2", params![pinned,id]).map_err(|e| e.to_string())?;
    if changed == 0 { return Err("Painel não encontrado.".into()); }
    state.snapshot()
}

#[tauri::command]
pub fn pane_delete(state: tauri::State<'_, WorkspaceDb>, id: String) -> Result<WorkspaceSnapshot, String> {
    let connection = state.0.lock().map_err(|e| e.to_string())?;
    let count: i64 = connection.query_row("SELECT COUNT(*) FROM sessions WHERE pane_id=?1", [&id], |row| row.get(0)).map_err(|e| e.to_string())?;
    if count > 0 { return Err("Mova ou encerre as sessões deste painel antes de excluí-lo.".into()); }
    let changed = connection.execute("DELETE FROM panes WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    if changed == 0 { return Err("Painel não encontrado.".into()); }
    drop(connection);
    state.snapshot()
}

#[tauri::command]
pub fn project_update(
    state: tauri::State<'_, WorkspaceDb>,
    id: String,
    name: String,
    folder: String,
    group_id: Option<String>,
) -> Result<WorkspaceSnapshot, String> {
    let name = clean_name(name)?;
    let path = fs::canonicalize(folder.trim())
        .map_err(|_| "A pasta não existe ou não está acessível.".to_string())?;
    if !path.is_dir() {
        return Err("Escolha uma pasta válida.".into());
    }
    let text = path.to_string_lossy();
    let folder = text.strip_prefix(r"\\?\").filter(|rest| !rest.starts_with("UNC")).unwrap_or(&text).to_string();
    let connection = state.0.lock().map_err(|e| e.to_string())?;
    let changed = connection
        .execute(
            "UPDATE projects SET name=?2, folder=?3, group_id=?4, updated_at=unixepoch() WHERE id=?1",
            params![id, name, folder, group_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Projeto não encontrado.".into());
    }
    drop(connection);
    state.snapshot()
}

/// Removes only the project and its panes; terminals and files on disk are left untouched.
#[tauri::command]
pub fn project_delete(
    state: tauri::State<'_, WorkspaceDb>,
    id: String,
) -> Result<WorkspaceSnapshot, String> {
    let connection = state.0.lock().map_err(|e| e.to_string())?;
    connection
        .execute("UPDATE sessions SET pane_id=NULL WHERE pane_id IN (SELECT id FROM panes WHERE project_id=?1)", [&id])
        .map_err(|e| e.to_string())?;
    connection.execute("DELETE FROM panes WHERE project_id=?1", [&id]).map_err(|e| e.to_string())?;
    let changed = connection.execute("DELETE FROM projects WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Projeto não encontrado.".into());
    }
    drop(connection);
    state.snapshot()
}

#[tauri::command]
pub fn project_reveal(folder: String) -> Result<(), String> {
    let folder = fs::canonicalize(folder).map_err(|_| "Pasta do projeto não encontrada.")?;
    if !folder.is_dir() {
        return Err("Pasta do projeto inválida.".into());
    }
    let text = folder.to_string_lossy();
    let clean = text.strip_prefix(r"\\?\").unwrap_or(&text).to_string();
    let program = if cfg!(windows) { "explorer.exe" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    std::process::Command::new(program).arg(clean).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn project_open_vscode(folder: String) -> Result<(), String> {
    let folder = fs::canonicalize(folder).map_err(|_| "Pasta do projeto não encontrada.")?;
    if !folder.is_dir() { return Err("Pasta do projeto inválida.".into()); }
    #[cfg(windows)]
    let candidates: Vec<PathBuf> = [
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from).map(|path| path.join("Programs/Microsoft VS Code/Code.exe")),
        std::env::var_os("ProgramFiles").map(PathBuf::from).map(|path| path.join("Microsoft VS Code/Code.exe")),
    ].into_iter().flatten().collect();
    #[cfg(not(windows))]
    let candidates: Vec<PathBuf> = std::env::var_os("PATH").map(|path| std::env::split_paths(&path)
        .map(|folder| folder.join("code")).collect()).unwrap_or_default();
    let executable = candidates.into_iter().find(|path| path.is_file())
        .ok_or("VS Code não encontrado nesta máquina.")?;
    Command::new(executable).arg(folder).spawn().map_err(|e| format!("Falha ao abrir VS Code: {e}"))?;
    Ok(())
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
        assert_eq!(version, 5);
        connection
            .execute("INSERT INTO groups (id, name) VALUES ('g1', 'Equipe')", [])
            .unwrap();
        connection.execute("INSERT INTO projects (id, group_id, name, updated_at) VALUES ('p1', 'g1', 'Projeto', 1)", []).unwrap();
        connection.execute("INSERT INTO sessions (id, agent, folder, command, status) VALUES ('s1', 'Shell', 'C:/', 'cmd.exe', 'rodando')", []).unwrap();
        connection
            .execute(
                "INSERT INTO panes (id, project_id, position) VALUES ('pane1', 'p1', 0)",
                [],
            )
            .unwrap();
        connection
            .execute("UPDATE sessions SET pane_id = 'pane1' WHERE id = 's1'", [])
            .unwrap();
    }
}
