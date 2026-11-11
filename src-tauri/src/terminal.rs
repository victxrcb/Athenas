use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
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
}

pub struct TerminalState {
    sessions: Mutex<HashMap<String, Arc<Mutex<RunningSession>>>>,
    saved: Mutex<Vec<SessionInfo>>,
    data_dir: PathBuf,
}

impl TerminalState {
    pub fn new(app: &AppHandle) -> Self {
        let data_dir = app
            .path()
            .app_data_dir()
            .expect("app data directory unavailable");
        fs::create_dir_all(&data_dir).expect("cannot create app data directory");
        let saved_path = data_dir.join("sessions.json");
        let saved: Vec<SessionInfo> = fs::read(&saved_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
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
            data_dir,
        }
    }

    fn persist(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(&*self.saved.lock().map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        fs::write(self.data_dir.join("sessions.json"), bytes).map_err(|e| e.to_string())
    }

    fn update(&self, info: SessionInfo) -> Result<(), String> {
        let mut saved = self.saved.lock().map_err(|e| e.to_string())?;
        if let Some(previous) = saved.iter_mut().find(|item| item.id == info.id) {
            *previous = info;
        } else {
            saved.push(info);
        }
        drop(saved);
        self.persist()
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

fn write_scrollback(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(bytes)?;
    if file.metadata()?.len() as usize > MAX_SCROLLBACK + 64 * 1024 {
        drop(file);
        let all = fs::read(path)?;
        let tail = &all[all.len().saturating_sub(MAX_SCROLLBACK)..];
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
    agent: String,
    folder: String,
    command: String,
    resume_id: Option<String>,
    resume: bool,
    cols: u16,
    rows: u16,
) -> Result<SessionInfo, String> {
    let folder = valid_folder(&folder)?;
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
        status: "rodando".into(),
    };
    state.update(info.clone())?;
    let running = Arc::new(Mutex::new(RunningSession {
        info: info.clone(),
        master: pair.master,
        writer,
        child,
    }));
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(info.id.clone(), running.clone());
    let path = state.log_path(&info.id);
    let id = info.id.clone();
    let app_output = app.clone();
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
            let _ = write_scrollback(&path, &batch);
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
            let _ = app_output
                .state::<TerminalState>()
                .update(session.info.clone());
            let _ = app_output.emit("terminal-status", session.info.clone());
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
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("Sessão encerrada.")?;
    session
        .lock()
        .map_err(|e| e.to_string())?
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
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("Sessão encerrada.")?;
    session
        .lock()
        .map_err(|e| e.to_string())?
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
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("Sessão encerrada.")?;
    session
        .lock()
        .map_err(|e| e.to_string())?
        .child
        .kill()
        .map_err(|e| e.to_string())
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
