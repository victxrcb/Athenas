use crate::settings::PreferencesStore;
use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use sysinfo::{Pid, System};
use tauri::{AppHandle, Emitter, Manager};

const MAX_SCROLLBACK: usize = 5 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub agent: String,
    pub folder: String,
    pub command: String,
    pub resume_id: Option<String>,
    pub pane_id: Option<String>,
    pub status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputEvent {
    id: String,
    sequence: u64,
    data: String,
}

struct RunningSession {
    info: SessionInfo,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    pid: Option<u32>,
}

pub struct TerminalState {
    sessions: Mutex<HashMap<String, Arc<Mutex<RunningSession>>>>,
    saved: Mutex<Vec<SessionInfo>>,
    db: Mutex<Connection>,
    suspended_groups: Mutex<HashSet<String>>,
    deleted_sessions: Mutex<HashSet<String>>,
    data_dir: PathBuf,
}

impl TerminalState {
    pub fn new(app: &AppHandle) -> Self {
        let data_dir = app
            .path()
            .app_data_dir()
            .expect("app data directory unavailable");
        fs::create_dir_all(&data_dir).expect("cannot create app data directory");
        let db =
            Connection::open(data_dir.join("workspace.sqlite3")).expect("cannot open database");
        db.pragma_update(None, "journal_mode", "WAL")
            .expect("cannot enable WAL");
        let saved_path = data_dir.join("sessions.json");
        let count: i64 = db
            .query_row("SELECT count(*) FROM sessions", [], |row| row.get(0))
            .expect("cannot count sessions");
        if count == 0 {
            let legacy: Vec<SessionInfo> = fs::read(&saved_path)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_default();
            for item in legacy {
                db.execute("INSERT OR IGNORE INTO sessions (id, agent, folder, command, resume_id, pane_id, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![item.id, item.agent, item.folder, item.command, item.resume_id, item.pane_id, item.status]).expect("cannot migrate sessions");
            }
        }
        let mut query = db
            .prepare("SELECT id, agent, folder, command, resume_id, pane_id, status FROM sessions")
            .expect("cannot query sessions");
        let saved: Vec<SessionInfo> = query
            .query_map([], |row| {
                Ok(SessionInfo {
                    id: row.get(0)?,
                    agent: row.get(1)?,
                    folder: row.get(2)?,
                    command: row.get(3)?,
                    resume_id: row.get(4)?,
                    pane_id: row.get(5)?,
                    status: row.get(6)?,
                })
            })
            .expect("cannot read sessions")
            .collect::<Result<Vec<_>, _>>()
            .expect("invalid session row");
        drop(query);
        let saved = saved
            .into_iter()
            .map(|mut item| {
                if item.status == "rodando" || item.status == "iniciando" {
                    item.status = "concluído".into();
                }
                item
            })
            .collect();
        Self {
            sessions: Mutex::new(HashMap::new()),
            saved: Mutex::new(saved),
            db: Mutex::new(db),
            suspended_groups: Mutex::new(HashSet::new()),
            deleted_sessions: Mutex::new(HashSet::new()),
            data_dir,
        }
    }

    fn update(&self, info: SessionInfo) -> Result<(), String> {
        let deleted = self.deleted_sessions.lock().map_err(|e| e.to_string())?;
        if deleted.contains(&info.id) { return Ok(()); }
        self.db.lock().map_err(|e| e.to_string())?.execute(
            "INSERT INTO sessions (id, agent, folder, command, resume_id, pane_id, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET status=excluded.status, resume_id=excluded.resume_id, pane_id=excluded.pane_id",
            params![info.id, info.agent, info.folder, info.command, info.resume_id, info.pane_id, info.status],
        ).map_err(|e| e.to_string())?;
        let mut saved = self.saved.lock().map_err(|e| e.to_string())?;
        if let Some(previous) = saved.iter_mut().find(|item| item.id == info.id) {
            *previous = info;
        } else {
            saved.push(info);
        }
        Ok(())
    }

    fn log_path(&self, id: &str) -> PathBuf {
        self.data_dir.join("scrollback").join(format!("{id}.log"))
    }
}

fn valid_folder(folder: &str) -> Result<PathBuf, String> {
    let path = fs::canonicalize(folder)
        .map_err(|_| "A pasta não existe ou não está acessível.".to_string())?;
    if !path.is_dir() {
        return Err("Escolha uma pasta, não um arquivo.".into());
    }
    Ok(path)
}

fn valid_command(command: &str, agent: &str) -> Result<String, String> {
    let command = command.trim();
    let default = match agent {
        "Claude Code" => "claude",
        "Codex" => "codex",
        "Shell" => {
            if cfg!(windows) {
                "powershell.exe"
            } else {
                "sh"
            }
        }
        _ => return Err("Agente desconhecido.".into()),
    };
    if command.is_empty() {
        return Ok(default.into());
    }
    if command
        .chars()
        .any(|character| matches!(character, '\n' | '\r' | '\0'))
    {
        return Err("Comando inválido.".into());
    }
    Ok(command.into())
}

fn write_scrollback(path: &Path, bytes: &[u8], limit: usize) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(bytes)?;
    if file.metadata()?.len() as usize > limit + 64 * 1024 {
        drop(file);
        let all = fs::read(path)?;
        let tail = &all[all.len().saturating_sub(limit)..];
        fs::write(path, tail)?;
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_list(state: tauri::State<'_, TerminalState>) -> Result<Vec<SessionInfo>, String> {
    Ok(state.saved.lock().map_err(|e| e.to_string())?.clone())
}

#[tauri::command]
pub fn terminal_start(
    app: AppHandle,
    state: tauri::State<'_, TerminalState>,
    preferences: tauri::State<'_, PreferencesStore>,
    agent: String,
    folder: String,
    command: String,
    resume_id: Option<String>,
    pane_id: Option<String>,
    resume: bool,
    mode: Option<String>,
    initial_prompt: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<SessionInfo, String> {
    let folder = valid_folder(&folder)?;
    if let Some(pane) = &pane_id {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let pane_folder: String = db
            .query_row(
                "SELECT p.folder FROM panes a JOIN projects p ON p.id=a.project_id WHERE a.id=?1",
                [pane],
                |row| row.get(0),
            )
            .map_err(|_| "Painel não encontrado ou sem pasta.".to_string())?;
        if !pane_folder.eq_ignore_ascii_case(&folder.to_string_lossy()) {
            return Err("O painel pertence a outra pasta.".into());
        }
    }
    let command = if command.trim().is_empty() {
        let settings = preferences.snapshot()?;
        match agent.as_str() {
            "Claude Code" => settings.claude_command,
            "Codex" => settings.codex_command,
            "Shell" => settings.shell_command,
            _ => return Err("Agente desconhecido.".into()),
        }
    } else {
        command
    };
    let command = valid_command(&command, &agent)?;
    if !(2..=500).contains(&cols) || !(2..=200).contains(&rows) {
        return Err("Tamanho de terminal inválido.".into());
    }
    let parts = if Path::new(&command).is_file() {
        vec![command.clone()]
    } else {
        shell_words::split(&command)
            .map_err(|_| "Comando inválido. Confira as aspas.".to_string())?
    };
    let executable = parts.first().ok_or("Comando vazio.")?;
    let use_cmd = cfg!(windows)
        && (executable.eq_ignore_ascii_case("codex")
            || executable.to_ascii_lowercase().ends_with(".cmd")
            || executable.to_ascii_lowercase().ends_with(".bat"));
    let mut builder = CommandBuilder::new(if use_cmd { "cmd.exe" } else { executable });
    if use_cmd {
        builder.arg("/d");
        builder.arg("/c");
        builder.arg(executable);
    }
    for argument in parts.iter().skip(1) {
        builder.arg(argument);
    }
    let mode = mode.as_deref().unwrap_or("Normal");
    if !["Normal", "Plan", "Auto-aceitar"].contains(&mode) {
        return Err("Modo de sessão inválido.".into());
    }
    if agent == "Shell" && mode != "Normal" {
        return Err("Shell aceita apenas o modo Normal.".into());
    }
    if !resume {
        match (agent.as_str(), mode) {
            ("Claude Code", "Plan") => builder.args(["--permission-mode", "plan"]),
            ("Claude Code", "Auto-aceitar") => builder.args(["--permission-mode", "acceptEdits"]),
            ("Codex", "Plan") => builder.args(["--sandbox", "read-only"]),
            ("Codex", "Auto-aceitar") => builder.arg("--approve-for-me"),
            _ => (),
        }
        if let Some(prompt) = initial_prompt.as_deref() {
            if agent == "Shell"
                || prompt.trim().is_empty()
                || prompt.len() > 32_000
                || prompt.contains('\0')
            {
                return Err("Prompt inicial inválido para este agente.".into());
            }
            builder.arg(prompt);
        }
    }
    builder.cwd(&folder);
    let resume_id = if agent == "Claude Code" {
        if resume && resume_id.is_none() {
            return Err("Esta sessão Claude não tem ID para retomada.".into());
        }
        let value = resume_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if uuid::Uuid::parse_str(&value).is_err() {
            return Err("ID de sessão Claude inválido.".into());
        }
        if resume {
            builder.arg("--resume");
            builder.arg(&value);
        } else {
            builder.arg("--session-id");
            builder.arg(&value);
        }
        Some(value)
    } else if agent == "Codex" {
        if resume {
            builder.arg("resume");
        }
        None
    } else {
        None
    };
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let child = pair.slave.spawn_command(builder).map_err(|e| {
        format!("Não foi possível iniciar {agent}. Confira o comando e o PATH: {e}")
    })?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let info = SessionInfo {
        id: uuid::Uuid::new_v4().to_string(),
        agent,
        folder: folder.to_string_lossy().into_owned(),
        command,
        resume_id,
        pane_id,
        status: "rodando".into(),
    };
    let pid = child.process_id();
    state.update(info.clone())?;
    let running = Arc::new(Mutex::new(RunningSession {
        info: info.clone(),
        master: pair.master,
        writer,
        child,
        pid,
    }));
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(info.id.clone(), running.clone());
    let path = state.log_path(&info.id);
    let id = info.id.clone();
    let app_output = app.clone();
    let log_preferences = preferences.inner().clone();
    let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(64);
    thread::spawn(move || {
        let mut reader = reader;
        let mut chunk = [0u8; 8192];
        while let Ok(n) = reader.read(&mut chunk) {
            if n == 0 {
                break;
            }
            if sender.send(chunk[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    thread::spawn(move || {
        let mut sequence = 0;
        while let Ok(first) = receiver.recv() {
            let started = Instant::now();
            let mut batch = first;
            while started.elapsed() < Duration::from_millis(16) && batch.len() < 64 * 1024 {
                match receiver.try_recv() {
                    Ok(next) => batch.extend_from_slice(&next),
                    Err(_) => {
                        thread::sleep(Duration::from_millis(1));
                    }
                }
            }
            let limit = log_preferences
                .snapshot()
                .map(|settings| settings.scrollback_mb * 1024 * 1024)
                .unwrap_or(MAX_SCROLLBACK);
            let _ = write_scrollback(&path, &batch, limit);
            sequence += 1;
            let _ = app_output.emit(
                "terminal-output",
                OutputEvent {
                    id: id.clone(),
                    sequence,
                    data: STANDARD.encode(&batch),
                },
            );
        }
        if let Ok(mut session) = running.lock() {
            let status = session
                .child
                .wait()
                .map(|exit| if exit.success() { "concluído" } else { "erro" })
                .unwrap_or("erro");
            session.info.status = status.into();
            let terminal_state = app_output.state::<TerminalState>();
            if terminal_state.deleted_sessions.lock().is_ok_and(|deleted| !deleted.contains(&id)) {
                let _ = terminal_state.update(session.info.clone());
                let _ = app_output.emit("terminal-status", session.info.clone());
            }
        }
        if let Ok(mut sessions) = app_output.state::<TerminalState>().sessions.lock() {
            sessions.remove(&id);
        }
    });
    Ok(info)
}

#[tauri::command]
pub fn terminal_write(
    state: tauri::State<'_, TerminalState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .cloned()
        .ok_or("Sessão encerrada.")?;
    let mut session = session.lock().map_err(|e| e.to_string())?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn terminal_resize(
    state: tauri::State<'_, TerminalState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if !(2..=500).contains(&cols) || !(2..=200).contains(&rows) {
        return Err("Tamanho inválido.".into());
    }
    let session = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .cloned()
        .ok_or("Sessão encerrada.")?;
    let session = session.lock().map_err(|e| e.to_string())?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn terminal_scrollback(
    state: tauri::State<'_, TerminalState>,
    id: String,
) -> Result<String, String> {
    if uuid::Uuid::parse_str(&id).is_err() {
        return Err("ID inválido.".into());
    }
    let bytes = fs::read(state.log_path(&id)).unwrap_or_default();
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
pub fn terminal_stop(state: tauri::State<'_, TerminalState>, id: String) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .cloned()
        .ok_or("Sessão encerrada.")?;
    let mut session = session.lock().map_err(|e| e.to_string())?;
    session.child.kill().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn terminal_delete(state: tauri::State<'_, TerminalState>, id: String) -> Result<(), String> {
    if uuid::Uuid::parse_str(&id).is_err() { return Err("ID inválido.".into()); }
    state.deleted_sessions.lock().map_err(|e| e.to_string())?.insert(id.clone());
    if let Some(session) = state.sessions.lock().map_err(|e| e.to_string())?.get(&id).cloned() {
        let _ = session.lock().map_err(|e| e.to_string())?.child.kill();
    }
    state.db.lock().map_err(|e| e.to_string())?.execute("DELETE FROM sessions WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    state.saved.lock().map_err(|e| e.to_string())?.retain(|item| item.id != id);
    let _ = fs::remove_file(state.log_path(&id));
    Ok(())
}

#[tauri::command]
pub fn terminal_set_pane(
    state: tauri::State<'_, TerminalState>,
    id: String,
    pane_id: String,
) -> Result<SessionInfo, String> {
    let mut info = state
        .saved
        .lock()
        .map_err(|e| e.to_string())?
        .iter()
        .find(|item| item.id == id)
        .cloned()
        .ok_or("Sessão não encontrada.")?;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let pane_folder: String = db
        .query_row(
            "SELECT p.folder FROM panes a JOIN projects p ON p.id=a.project_id WHERE a.id=?1",
            [&pane_id],
            |row| row.get(0),
        )
        .map_err(|_| "Painel não encontrado.".to_string())?;
    if !pane_folder.eq_ignore_ascii_case(&info.folder) {
        return Err("O painel pertence a outra pasta.".into());
    }
    drop(db);
    info.pane_id = Some(pane_id);
    if let Some(running) = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .cloned()
    {
        running.lock().map_err(|e| e.to_string())?.info.pane_id = info.pane_id.clone();
    }
    state.update(info.clone())?;
    Ok(info)
}

#[tauri::command]
pub fn terminal_save_image(
    state: tauri::State<'_, TerminalState>,
    data: String,
) -> Result<String, String> {
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| "Imagem inválida.".to_string())?;
    if bytes.len() > 10 * 1024 * 1024 || !bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        return Err("Cole uma imagem PNG de até 10 MB.".into());
    }
    let path = state
        .data_dir
        .join("clipboard")
        .join(format!("{}.png", uuid::Uuid::new_v4()));
    fs::create_dir_all(path.parent().ok_or("Pasta inválida.")?).map_err(|e| e.to_string())?;
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMemory {
    group_id: String,
    bytes: u64,
    suspended: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySnapshot {
    total_bytes: u64,
    groups: Vec<GroupMemory>,
}

fn running_roots(state: &TerminalState) -> Result<Vec<(String, Pid)>, String> {
    let running: Vec<_> = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .values()
        .cloned()
        .collect();
    let mut roots = Vec::new();
    for item in running {
        let session = item.lock().map_err(|e| e.to_string())?;
        if let Some(pid) = session.pid {
            roots.push((session.info.folder.clone(), Pid::from_u32(pid)));
        }
    }
    Ok(roots)
}

fn group_for_folder(db: &Connection, folder: &str) -> Result<Option<String>, String> {
    db.query_row(
        "SELECT group_id FROM projects WHERE lower(folder) = lower(?1) LIMIT 1",
        [folder],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(|value| value.flatten())
    .map_err(|e| e.to_string())
}

fn process_tree(system: &System, root: Pid) -> Vec<Pid> {
    let mut tree = vec![root];
    for _ in 0..16 {
        let mut changed = false;
        for (pid, process) in system.processes() {
            if process
                .parent()
                .is_some_and(|parent| tree.contains(&parent))
                && !tree.contains(pid)
            {
                tree.push(*pid);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    tree
}

#[tauri::command]
pub fn group_metrics(state: tauri::State<'_, TerminalState>) -> Result<MemorySnapshot, String> {
    let system = System::new_all();
    let roots = running_roots(&state)?;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let suspended = state.suspended_groups.lock().map_err(|e| e.to_string())?;
    let mut groups = HashMap::<String, u64>::new();
    let mut query = db
        .prepare("SELECT id FROM groups")
        .map_err(|e| e.to_string())?;
    for id in query
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
    {
        groups.insert(id.map_err(|e| e.to_string())?, 0);
    }
    drop(query);
    let mut seen = HashSet::new();
    let mut total_bytes = 0;
    for (folder, root) in roots {
        let group = group_for_folder(&db, &folder)?;
        for pid in process_tree(&system, root) {
            if !seen.insert(pid) {
                continue;
            }
            let bytes = system.process(pid).map_or(0, |process| process.memory());
            total_bytes += bytes;
            if let Some(id) = &group {
                *groups.entry(id.clone()).or_default() += bytes;
            }
        }
    }
    Ok(MemorySnapshot {
        total_bytes,
        groups: groups
            .into_iter()
            .map(|(group_id, bytes)| GroupMemory {
                suspended: suspended.contains(&group_id),
                group_id,
                bytes,
            })
            .collect(),
    })
}

#[cfg(windows)]
fn change_process_state(pid: Pid, suspend: bool) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::{
            ProcessStatus::EmptyWorkingSet,
            Threading::{
                OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
                PROCESS_SUSPEND_RESUME,
            },
        },
    };
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtSuspendProcess(process: windows_sys::Win32::Foundation::HANDLE) -> i32;
        fn NtResumeProcess(process: windows_sys::Win32::Foundation::HANDLE) -> i32;
    }
    let handle = unsafe {
        OpenProcess(
            PROCESS_SUSPEND_RESUME | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid.as_u32(),
        )
    };
    if handle.is_null() {
        return Err(format!(
            "Não foi possível abrir o processo {}.",
            pid.as_u32()
        ));
    }
    let status = unsafe {
        if suspend {
            NtSuspendProcess(handle)
        } else {
            NtResumeProcess(handle)
        }
    };
    if suspend && status >= 0 {
        unsafe {
            EmptyWorkingSet(handle);
        }
    }
    unsafe {
        CloseHandle(handle);
    }
    if status < 0 {
        return Err(format!(
            "Falha ao {} o processo {} (NTSTATUS {status}).",
            if suspend { "suspender" } else { "retomar" },
            pid.as_u32()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn change_process_state(_pid: Pid, _suspend: bool) -> Result<(), String> {
    Err("Suspensão de grupos disponível apenas no Windows nesta versão.".into())
}

#[tauri::command]
pub fn group_suspend(
    state: tauri::State<'_, TerminalState>,
    group_id: String,
    suspend: bool,
) -> Result<(), String> {
    if state
        .suspended_groups
        .lock()
        .map_err(|e| e.to_string())?
        .contains(&group_id)
        == suspend
    {
        return Ok(());
    }
    let roots = running_roots(&state)?;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM groups WHERE id=?1)",
            [&group_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("Grupo não encontrado.".into());
    }
    let system = System::new_all();
    let mut targets = Vec::new();
    let mut seen = HashSet::new();
    for (folder, root) in roots {
        if group_for_folder(&db, &folder)?.as_deref() != Some(&group_id) {
            continue;
        }
        for pid in process_tree(&system, root) {
            if seen.insert(pid) {
                targets.push(pid);
            }
        }
    }
    drop(db);
    if suspend {
        targets.reverse();
    }
    let mut changed = Vec::new();
    for pid in targets {
        if let Err(error) = change_process_state(pid, suspend) {
            if suspend {
                for previous in changed.into_iter().rev() {
                    let _ = change_process_state(previous, false);
                }
            }
            return Err(error);
        }
        changed.push(pid);
    }
    let mut groups = state.suspended_groups.lock().map_err(|e| e.to_string())?;
    if suspend {
        groups.insert(group_id);
    } else {
        groups.remove(&group_id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrollback_keeps_only_recent_bytes() {
        let directory =
            std::env::temp_dir().join(format!("athenas-scrollback-{}", uuid::Uuid::new_v4()));
        let path = directory.join("output.log");
        let content = vec![b'A'; MAX_SCROLLBACK + 128 * 1024];
        write_scrollback(&path, &content, MAX_SCROLLBACK).unwrap();
        let saved = fs::read(&path).unwrap();
        assert_eq!(saved.len(), MAX_SCROLLBACK);
        assert!(saved.iter().all(|byte| *byte == b'A'));
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn conpty_runs_a_real_shell() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("cmd.exe");
        command.arg("/d");
        command.arg("/c");
        command.arg("echo ATHENAS_PTY_OK");
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut output = Vec::new();
        let mut chunk = [0u8; 4096];
        while !String::from_utf8_lossy(&output).contains("ATHENAS_PTY_OK") {
            let read = reader.read(&mut chunk).unwrap();
            if read == 0 {
                break;
            }
            output.extend_from_slice(&chunk[..read]);
        }
        assert!(
            String::from_utf8_lossy(&output).contains("ATHENAS_PTY_OK"),
            "{}",
            String::from_utf8_lossy(&output)
        );
        assert!(child.wait().unwrap().success());
    }

    #[cfg(windows)]
    #[test]
    fn can_suspend_and_resume_owned_process() {
        let mut child = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 10"])
            .spawn()
            .unwrap();
        let pid = Pid::from_u32(child.id());
        let suspended = change_process_state(pid, true);
        let resumed = if suspended.is_ok() {
            change_process_state(pid, false)
        } else {
            Ok(())
        };
        let _ = child.kill();
        let _ = child.wait();
        suspended.unwrap();
        resumed.unwrap();
    }
}
