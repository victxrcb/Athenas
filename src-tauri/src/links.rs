//! Links between agent sessions drawn on the mapping canvas, plus the mailbox that lets a
//! commanding agent (via the MCP tools below) type instructions into a linked agent's terminal.
//!
//! The MCP server runs in a separate process (`--mcp-stdio`), so everything it needs lives in
//! `links.sqlite3` next to the other databases; the app polls the mailbox and writes into the PTY.
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

pub const SESSION_ENV: &str = "ATHENAS_SESSION_ID";
const MAX_MESSAGE: usize = 16_000;
const MAX_READ: usize = 20_000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLink {
    pub from_id: String,
    pub to_id: String,
    pub created_at: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageEvent {
    pub id: i64,
    pub from_id: Option<String>,
    pub to_id: String,
    pub error: Option<String>,
}

pub struct LinksDb {
    path: PathBuf,
}

pub fn open(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let connection = Connection::open(path).map_err(|e| e.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_links (
                from_id TEXT NOT NULL, to_id TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()),
                PRIMARY KEY (from_id, to_id));
             CREATE TABLE IF NOT EXISTS agent_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT, to_id TEXT NOT NULL, text TEXT NOT NULL,
                created_at INTEGER NOT NULL DEFAULT (unixepoch()), delivered_at INTEGER, error TEXT);
             CREATE INDEX IF NOT EXISTS agent_messages_pending ON agent_messages(delivered_at);",
        )
        .map_err(|e| e.to_string())?;
    Ok(connection)
}

fn valid_id(id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| "ID de sessão inválido.".to_string())
}

fn list(connection: &Connection) -> Result<Vec<AgentLink>, String> {
    let mut query = connection
        .prepare("SELECT from_id, to_id, created_at FROM agent_links ORDER BY created_at, from_id")
        .map_err(|e| e.to_string())?;
    let links = query
        .query_map([], |row| {
            Ok(AgentLink { from_id: row.get(0)?, to_id: row.get(1)?, created_at: row.get(2)? })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    links
}

fn linked(connection: &Connection, from: &str, to: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT 1 FROM agent_links WHERE from_id=?1 AND to_id=?2",
            params![from, to],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
        .map_err(|e| e.to_string())
}

fn enqueue(connection: &Connection, from: Option<&str>, to: &str, text: &str) -> Result<i64, String> {
    if text.trim().is_empty() || text.len() > MAX_MESSAGE || text.contains('\0') {
        return Err(format!("Mensagem vazia ou maior que {MAX_MESSAGE} caracteres."));
    }
    connection
        .execute(
            "INSERT INTO agent_messages (from_id, to_id, text) VALUES (?1, ?2, ?3)",
            params![from, to, text],
        )
        .map_err(|e| e.to_string())?;
    Ok(connection.last_insert_rowid())
}

/// Text typed into a TUI agent: bracketed paste keeps line breaks inside one prompt, and the
/// Enter is sent separately so the CLI submits instead of inserting a newline.
fn paste_payload(agent: &str, text: &str) -> String {
    if agent == "Shell" {
        text.replace("\r\n", "\n").replace('\n', "\r")
    } else {
        format!("\x1b[200~{}\x1b[201~", text.replace("\r\n", "\n"))
    }
}

fn header(from: Option<&SessionRow>) -> String {
    match from {
        Some(row) => format!("[Athenas · instrução do agente {} ({})]", row.agent, short(&row.id)),
        None => "[Athenas]".to_string(),
    }
}

fn short(id: &str) -> &str {
    &id[..id.len().min(8)]
}

impl LinksDb {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("links.sqlite3");
        open(&path)?;
        Ok(Self { path })
    }

    /// Delivers queued messages into running terminals; runs for the app's lifetime.
    pub fn start(&self, app: AppHandle) {
        let path = self.path.clone();
        let workspace = path.with_file_name("workspace.sqlite3");
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(400));
            let Ok(connection) = open(&path) else { continue };
            let pending: Vec<(i64, Option<String>, String, String)> = connection
                .prepare("SELECT id, from_id, to_id, text FROM agent_messages WHERE delivered_at IS NULL ORDER BY id LIMIT 20")
                .and_then(|mut query| {
                    query
                        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?
                        .collect()
                })
                .unwrap_or_default();
            for (id, from, to, text) in pending {
                let sessions = sessions(&workspace).unwrap_or_default();
                let sender = from.as_deref().and_then(|from| sessions.iter().find(|row| row.id == from));
                let target = sessions.iter().find(|row| row.id == to);
                let error = match target {
                    None => Some("Agente de destino não existe mais.".to_string()),
                    Some(target) => {
                        let body = format!("{} {}", header(sender), text);
                        let state = app.state::<crate::terminal::TerminalState>();
                        crate::terminal::write_session(&state, &to, &paste_payload(&target.agent, &body))
                            .and_then(|_| {
                                thread::sleep(Duration::from_millis(150));
                                crate::terminal::write_session(&state, &to, "\r")
                            })
                            .err()
                    }
                };
                let _ = connection.execute(
                    "UPDATE agent_messages SET delivered_at=unixepoch(), error=?2 WHERE id=?1",
                    params![id, error],
                );
                let _ = app.emit("agent-message", MessageEvent { id, from_id: from, to_id: to, error });
            }
        });
    }
}

#[tauri::command]
pub fn agent_links_list(state: tauri::State<'_, LinksDb>) -> Result<Vec<AgentLink>, String> {
    list(&open(&state.path)?)
}

#[tauri::command]
pub fn agent_link_create(
    state: tauri::State<'_, LinksDb>,
    from_id: String,
    to_id: String,
) -> Result<Vec<AgentLink>, String> {
    valid_id(&from_id)?;
    valid_id(&to_id)?;
    if from_id == to_id {
        return Err("Um agente não pode comandar a si mesmo.".into());
    }
    let connection = open(&state.path)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO agent_links (from_id, to_id) VALUES (?1, ?2)",
            params![from_id, to_id],
        )
        .map_err(|e| e.to_string())?;
    list(&connection)
}

#[tauri::command]
pub fn agent_link_delete(
    state: tauri::State<'_, LinksDb>,
    from_id: String,
    to_id: String,
) -> Result<Vec<AgentLink>, String> {
    let connection = open(&state.path)?;
    connection
        .execute(
            "DELETE FROM agent_links WHERE from_id=?1 AND to_id=?2",
            params![from_id, to_id],
        )
        .map_err(|e| e.to_string())?;
    list(&connection)
}

/// Tells the commanding agent which agents it controls and how to reach them.
#[tauri::command]
pub fn agent_link_introduce(state: tauri::State<'_, LinksDb>, from_id: String) -> Result<i64, String> {
    valid_id(&from_id)?;
    let connection = open(&state.path)?;
    let workspace = state.path.with_file_name("workspace.sqlite3");
    let all = sessions(&workspace)?;
    let targets: Vec<String> = list(&connection)?
        .into_iter()
        .filter(|link| link.from_id == from_id)
        .filter_map(|link| all.iter().find(|row| row.id == link.to_id))
        .map(|row| format!("{} ({}) em {} [id {}]", row.agent, row.status, row.folder, row.id))
        .collect();
    if targets.is_empty() {
        return Err("Este agente ainda não comanda nenhum outro.".into());
    }
    let text = format!(
        "Você foi conectado no Mapeamento como líder dos agentes: {}. Use as ferramentas MCP do Athenas: athenas_agents para listá-los, athenas_send (target, message) para enviar uma instrução ao terminal de um deles e athenas_read (target) para ler a saída recente dele. Aguarde minhas próximas instruções.",
        targets.join("; ")
    );
    enqueue(&connection, None, &from_id, &text)
}

/// Removes links and pending messages of a deleted session.
pub fn forget_session(app: &AppHandle, id: &str) {
    if let Some(state) = app.try_state::<LinksDb>() {
        if let Ok(connection) = open(&state.path) {
            let _ = connection.execute("DELETE FROM agent_links WHERE from_id=?1 OR to_id=?1", [id]);
            let _ = connection.execute(
                "DELETE FROM agent_messages WHERE to_id=?1 AND delivered_at IS NULL",
                [id],
            );
        }
    }
}

#[derive(Clone, Serialize)]
struct SessionRow {
    id: String,
    agent: String,
    folder: String,
    status: String,
}

fn sessions(workspace: &Path) -> Result<Vec<SessionRow>, String> {
    let connection = Connection::open_with_flags(workspace, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    let mut query = connection
        .prepare("SELECT id, agent, folder, status FROM sessions")
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([], |row| {
            Ok(SessionRow { id: row.get(0)?, agent: row.get(1)?, folder: row.get(2)?, status: row.get(3)? })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    rows
}

/// Removes ANSI/VT escape sequences and control characters so a TUI log reads as plain text.
pub fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.peek() {
                Some('[') => {
                    chars.next();
                    while let Some(&next) = chars.peek() {
                        chars.next();
                        if ('\x40'..='\x7e').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') | Some('P') | Some('_') | Some('^') => {
                    chars.next();
                    while let Some(next) = chars.next() {
                        if next == '\x07' {
                            break;
                        }
                        if next == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            },
            '\r' => {}
            '\n' | '\t' => out.push(c),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    let mut cleaned = String::with_capacity(out.len());
    let mut blank = 0;
    for line in out.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        cleaned.push_str(line);
        cleaned.push('\n');
    }
    cleaned
}

fn read_tail(path: &Path, bytes: usize) -> String {
    let Ok(mut file) = fs::File::open(path) else { return String::new() };
    let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let start = len.saturating_sub(bytes as u64);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buffer = Vec::new();
    let _ = file.read_to_end(&mut buffer);
    String::from_utf8_lossy(&buffer).into_owned()
}

pub fn mcp_tools() -> Vec<Value> {
    vec![
        json!({"name":"athenas_agents","description":"Lista os agentes ligados a você no Mapeamento do Athenas: os que você comanda (commands) e os que comandam você (commanded_by).",
            "inputSchema":{"type":"object","properties":{}}}),
        json!({"name":"athenas_send","description":"Envia uma instrução ao terminal de um agente que você comanda no Mapeamento do Athenas. A mensagem é digitada e submetida como um prompt.",
            "inputSchema":{"type":"object","properties":{"target":{"type":"string","description":"ID (ou prefixo do ID) do agente comandado."},
            "message":{"type":"string"}},"required":["target","message"]}}),
        json!({"name":"athenas_read","description":"Lê a saída recente (texto, sem cores) do terminal de um agente ligado a você no Mapeamento.",
            "inputSchema":{"type":"object","properties":{"target":{"type":"string"},"max_chars":{"type":"integer","minimum":200,"maximum":MAX_READ}},"required":["target"]}}),
    ]
}

fn caller() -> Result<String, String> {
    let id = std::env::var(SESSION_ENV).map_err(|_| {
        "Este agente não foi aberto por um terminal do Athenas (ou foi aberto antes desta versão). Reinicie a sessão pelo Athenas.".to_string()
    })?;
    valid_id(&id)?;
    Ok(id)
}

fn resolve<'a>(rows: &'a [SessionRow], target: &str) -> Result<&'a SessionRow, String> {
    let target = target.trim().to_ascii_lowercase();
    if target.len() < 4 {
        return Err("Informe o ID do agente (pelo menos 4 caracteres).".into());
    }
    let mut found = rows.iter().filter(|row| row.id.to_ascii_lowercase().starts_with(&target));
    match (found.next(), found.next()) {
        (Some(row), None) => Ok(row),
        (Some(_), Some(_)) => Err("ID ambíguo; use mais caracteres.".into()),
        _ => Err("Agente não encontrado.".into()),
    }
}

/// Handles the link tools for the MCP stdio server; returns None for tools it does not own.
pub fn mcp_call(data_dir: &Path, name: &str, args: &Value) -> Option<Result<Value, String>> {
    if !name.starts_with("athenas_") {
        return None;
    }
    Some((|| {
        let me = caller()?;
        let connection = open(&data_dir.join("links.sqlite3"))?;
        let rows = sessions(&data_dir.join("workspace.sqlite3"))?;
        let links = list(&connection)?;
        let describe = |id: &str| {
            rows.iter().find(|row| row.id == id).map(|row| json!(row)).unwrap_or_else(|| json!({"id":id,"status":"removido"}))
        };
        match name {
            "athenas_agents" => Ok(json!({
                "me": describe(&me),
                "commands": links.iter().filter(|link| link.from_id == me).map(|link| describe(&link.to_id)).collect::<Vec<_>>(),
                "commanded_by": links.iter().filter(|link| link.to_id == me).map(|link| describe(&link.from_id)).collect::<Vec<_>>(),
            })),
            "athenas_send" => {
                let target = resolve(&rows, args.get("target").and_then(Value::as_str).ok_or("target obrigatório.")?)?;
                let message = args.get("message").and_then(Value::as_str).ok_or("message obrigatório.")?;
                if !linked(&connection, &me, &target.id)? {
                    return Err("Você não comanda este agente. Crie o link no Mapeamento do Athenas.".into());
                }
                let id = enqueue(&connection, Some(&me), &target.id, message)?;
                let started = Instant::now();
                while started.elapsed() < Duration::from_secs(4) {
                    let state: Option<(Option<i64>, Option<String>)> = connection
                        .query_row("SELECT delivered_at, error FROM agent_messages WHERE id=?1", [id], |row| Ok((row.get(0)?, row.get(1)?)))
                        .optional()
                        .map_err(|e| e.to_string())?;
                    match state {
                        Some((Some(_), Some(error))) => return Err(format!("Mensagem não entregue: {error}")),
                        Some((Some(_), None)) => return Ok(json!({"delivered":true,"message_id":id,"target":target.id,
                            "hint":"Use athenas_read depois de alguns segundos para acompanhar a resposta."})),
                        _ => thread::sleep(Duration::from_millis(200)),
                    }
                }
                Ok(json!({"delivered":false,"queued":true,"message_id":id,"hint":"O Athenas está fechado ou ocupado; a mensagem fica na fila."}))
            }
            "athenas_read" => {
                let target = resolve(&rows, args.get("target").and_then(Value::as_str).ok_or("target obrigatório.")?)?;
                if !linked(&connection, &me, &target.id)? && !linked(&connection, &target.id, &me)? {
                    return Err("Este agente não está ligado a você no Mapeamento.".into());
                }
                let max = args.get("max_chars").and_then(Value::as_u64).unwrap_or(4000).clamp(200, MAX_READ as u64) as usize;
                let raw = read_tail(&data_dir.join("scrollback").join(format!("{}.log", target.id)), max * 8);
                let text = strip_ansi(&raw);
                let tail: String = text.chars().rev().take(max).collect::<Vec<_>>().into_iter().rev().collect();
                Ok(json!({"agent":describe(&target.id),"output":tail}))
            }
            _ => Err("Ferramenta desconhecida.".into()),
        }
    })())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_terminal_escapes() {
        let raw = "\x1b[2J\x1b[1;1H\x1b[38;5;10mOlá\x1b[0m\r\n\x1b]0;title\x07mundo\n\n\n\nfim";
        assert_eq!(strip_ansi(raw), "Olá\nmundo\n\nfim\n");
    }

    #[test]
    fn links_are_directional_and_messages_queue() {
        let path = std::env::temp_dir().join(format!("athenas-links-{}.sqlite3", uuid::Uuid::new_v4()));
        let connection = open(&path).unwrap();
        connection.execute("INSERT INTO agent_links (from_id, to_id) VALUES ('a', 'b')", []).unwrap();
        assert!(linked(&connection, "a", "b").unwrap());
        assert!(!linked(&connection, "b", "a").unwrap());
        assert!(enqueue(&connection, Some("a"), "b", "   ").is_err());
        let id = enqueue(&connection, Some("a"), "b", "rode os testes").unwrap();
        assert!(id > 0);
        drop(connection);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn paste_keeps_lines_in_one_prompt() {
        assert_eq!(paste_payload("Claude Code", "a\r\nb"), "\x1b[200~a\nb\x1b[201~");
        assert_eq!(paste_payload("Shell", "a\nb"), "a\rb");
    }
}
