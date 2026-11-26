//! Backend of the chat view: binds each terminal session to the conversation file its CLI writes
//! (`~/.claude/projects/**.jsonl`, `~/.codex/sessions/**.jsonl`), reads it incrementally, and types
//! messages into the same PTY the terminal view shows. It never starts or restarts an agent.
use crate::terminal::{self, TerminalState};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

/// Longest string forwarded to the UI; the untouched line stays available through `chat_raw`.
const MAX_STRING: usize = 48_000;
const MAX_IMAGE: usize = 3 * 1024 * 1024;
const MAX_RAW_LINE: u64 = 8 * 1024 * 1024;
const BLOCK: u64 = 1024 * 1024;
const INITIAL_LINES: usize = 400;
const MAX_BATCH_BYTES: usize = 3 * 1024 * 1024;
const MAX_MESSAGE: usize = 100_000;

pub struct ChatState {
    bindings: Mutex<HashMap<String, PathBuf>>,
    bindings_path: PathBuf,
    /// Sessions whose current process has reported through a hook, so it is past its startup dialogs.
    announced: Mutex<HashSet<String>>,
    events_db: PathBuf,
}

impl ChatState {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let bindings_path = data.join("chat-bindings.json");
        let bindings = fs::read(&bindings_path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        Ok(Self { bindings: Mutex::new(bindings), bindings_path, announced: Mutex::default(), events_db: data.join(crate::notify::EVENTS_FILE) })
    }

    fn bound(&self, session: &str) -> Option<PathBuf> {
        self.bindings.lock().ok()?.get(session).cloned()
    }

    fn save(&self, bindings: &HashMap<String, PathBuf>) {
        if let Ok(bytes) = serde_json::to_vec(bindings) {
            let _ = fs::write(&self.bindings_path, bytes);
        }
    }

    /// Records which conversation file a session writes; paths outside the agents' folders are refused.
    pub fn bind(&self, session: &str, path: PathBuf) {
        if !allowed_transcript(&path, &transcript_roots()) {
            return;
        }
        if let Ok(mut bindings) = self.bindings.lock() {
            if bindings.get(session) != Some(&path) {
                bindings.insert(session.to_string(), path);
                self.save(&bindings);
            }
        }
    }

    pub fn announce(&self, session: &str) {
        if let Ok(mut announced) = self.announced.lock() {
            announced.insert(session.to_string());
        }
    }

    /// A new process is about to start for this session.
    pub fn starting(&self, session: &str) {
        if let Ok(mut announced) = self.announced.lock() {
            announced.remove(session);
        }
    }

    /// The running process either reported through a hook or already wrote to its conversation.
    fn ready(&self, session: &str, since: Option<SystemTime>) -> bool {
        if self.announced.lock().is_ok_and(|announced| announced.contains(session)) {
            return true;
        }
        let (Some(path), Some(since)) = (self.bound(session), since) else { return false };
        fs::metadata(path).and_then(|meta| meta.modified()).is_ok_and(|modified| modified >= since)
    }

    pub fn forget(&self, session: &str) {
        if let Ok(mut bindings) = self.bindings.lock() {
            if bindings.remove(session).is_some() {
                self.save(&bindings);
            }
        }
    }

    fn events(&self) -> Result<Connection, String> {
        crate::notify::open(&self.events_db)
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

fn agent_home(variable: &str, folder: &str) -> Option<PathBuf> {
    std::env::var_os(variable).map(PathBuf::from).or_else(|| home().map(|home| home.join(folder)))
}

fn transcript_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    roots.extend(agent_home("CLAUDE_CONFIG_DIR", ".claude").map(|path| path.join("projects")));
    roots.extend(agent_home("CODEX_HOME", ".codex").map(|path| path.join("sessions")));
    roots
}

fn plain_components(path: &Path) -> Vec<String> {
    path.components()
        .map(|part| {
            let text = part.as_os_str().to_string_lossy();
            if cfg!(windows) { text.trim_start_matches(r"\\?\").to_lowercase() } else { text.into_owned() }
        })
        .collect()
}

/// A `.jsonl` file below one of the agents' conversation folders, without `..` tricks.
fn allowed_transcript(path: &Path, roots: &[PathBuf]) -> bool {
    if path.extension().is_none_or(|extension| extension != "jsonl") || path.components().any(|part| matches!(part, Component::ParentDir)) {
        return false;
    }
    let parts = plain_components(path);
    roots.iter().any(|root| {
        let base = plain_components(root);
        parts.len() > base.len() && parts[..base.len()] == base[..]
    })
}

fn claude_transcript(id: &str) -> Option<PathBuf> {
    uuid::Uuid::parse_str(id).ok()?;
    let projects = agent_home("CLAUDE_CONFIG_DIR", ".claude")?.join("projects");
    fs::read_dir(projects).ok()?.flatten().map(|entry| entry.path().join(format!("{id}.jsonl"))).find(|path| path.is_file())
}

fn codex_files() -> Vec<PathBuf> {
    let Some(root) = agent_home("CODEX_HOME", ".codex").map(|path| path.join("sessions")) else { return Vec::new() };
    let mut files = Vec::new();
    let mut stack = vec![root];
    while let Some(folder) = stack.pop() {
        let Ok(entries) = fs::read_dir(folder) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|extension| extension == "jsonl") {
                files.push(path);
            }
        }
    }
    files
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    id: String,
    started_at: i64,
    /// The first message of the conversation, to tell candidates apart.
    preview: String,
    #[serde(skip)]
    path: PathBuf,
}

/// Reads the header of a Codex rollout; `None` for other folders and for threads that are not a CLI chat.
fn codex_candidate(path: &Path, folder: &str) -> Option<Candidate> {
    let mut reader = BufReader::new(fs::File::open(path).ok()?).take(2 * BLOCK);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let meta: Value = serde_json::from_str(&line).ok()?;
    let payload = meta.get("payload")?;
    if meta.get("type")?.as_str()? != "session_meta" || !terminal::same_folder(payload.get("cwd")?.as_str()?, folder) {
        return None;
    }
    let source = payload.get("thread_source").and_then(Value::as_str).unwrap_or("user");
    if source == "subagent" || payload.get("source").and_then(Value::as_str) == Some("exec") {
        return None;
    }
    let id = payload.get("id")?.as_str()?.to_string();
    let started_at = payload.get("timestamp").and_then(Value::as_str).and_then(crate::history::parse_timestamp).unwrap_or(0);
    let mut preview = String::new();
    for _ in 0..80 {
        line.clear();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        if !line.contains("UserMessage") && !line.contains("user_message") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
        let text = value.pointer("/payload/message").and_then(Value::as_str)
            .or_else(|| value.pointer("/payload/item/content/0/text").and_then(Value::as_str));
        if let Some(text) = text {
            preview = text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(120).collect();
            break;
        }
    }
    Some(Candidate { id, started_at, preview, path: path.to_path_buf() })
}

/// Picks the rollout of a running Codex session without a thread id. It binds only when exactly one new
/// conversation can belong to it; anything ambiguous is left for the user to choose.
fn choose_codex(found: &[Candidate], since_ms: i64, rivals: bool) -> Option<&Candidate> {
    if rivals {
        return None;
    }
    let mut fresh = found.iter().filter(|item| item.started_at >= since_ms - 5_000);
    let first = fresh.next()?;
    fresh.next().is_none().then_some(first)
}

fn codex_candidates(state: &ChatState, session: &str, folder: &str, since: SystemTime) -> Vec<Candidate> {
    let taken: Vec<PathBuf> = state.bindings.lock().map(|map| map.iter().filter(|(id, _)| *id != session).map(|(_, path)| path.clone()).collect()).unwrap_or_default();
    let mut found: Vec<Candidate> = codex_files()
        .into_iter()
        .filter(|path| fs::metadata(path).and_then(|meta| meta.modified()).is_ok_and(|modified| modified + Duration::from_secs(5) >= since))
        .filter(|path| !taken.contains(path))
        .filter_map(|path| codex_candidate(&path, folder))
        .collect();
    found.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    found.truncate(8);
    found
}

fn resolve(app: &AppHandle, session: &str) -> Result<(Option<PathBuf>, Vec<Candidate>, String), String> {
    let terminals = app.state::<TerminalState>();
    let info = terminal::session_summary(&terminals, session).ok_or("Sessão não encontrada.")?;
    let chat = app.state::<ChatState>();
    if let Some(path) = chat.bound(session) {
        return Ok((Some(path), Vec::new(), info.agent));
    }
    let mut candidates = Vec::new();
    let found = match info.agent.as_str() {
        "Claude Code" => info.resume_id.as_deref().and_then(claude_transcript),
        "Codex" => {
            let by_id = info.resume_id.as_deref().filter(|id| uuid::Uuid::parse_str(id).is_ok()).and_then(|id| {
                let suffix = format!("{id}.jsonl");
                codex_files().into_iter().find(|path| path.file_name().is_some_and(|name| name.to_string_lossy().ends_with(&suffix)))
            });
            match (by_id, terminal::running_since(&terminals, session)) {
                (Some(path), _) => Some(path),
                (None, Some(since)) => {
                    candidates = codex_candidates(&chat, session, &info.folder, since);
                    let since_ms = since.duration_since(SystemTime::UNIX_EPOCH).map(|value| value.as_millis() as i64).unwrap_or(0);
                    let rivals = terminal::running_peers(&terminals, session).into_iter().any(|id| chat.bound(&id).is_none());
                    choose_codex(&candidates, since_ms, rivals).map(|item| item.path.clone())
                }
                (None, None) => None,
            }
        }
        _ => None,
    };
    if let Some(path) = &found {
        chat.bind(session, path.clone());
        candidates.clear();
    }
    Ok((found, candidates, info.agent))
}

fn clip_string(text: &str, clipped: &mut bool) -> Value {
    match text.char_indices().nth(MAX_STRING) {
        Some((index, _)) => {
            *clipped = true;
            Value::String(format!("{}\n…[recortado]", &text[..index]))
        }
        None => Value::String(text.to_string()),
    }
}

fn clip(value: &Value, clipped: &mut bool) -> Value {
    match value {
        Value::String(text) => clip_string(text, clipped),
        Value::Array(items) => Value::Array(items.iter().map(|item| clip(item, clipped)).collect()),
        Value::Object(map) => {
            // Pasted images are shown, so their data is kept whole up to a limit.
            if map.get("type").and_then(Value::as_str) == Some("base64") {
                let fits = map.get("data").and_then(Value::as_str).is_some_and(|data| data.len() <= MAX_IMAGE);
                if fits {
                    return value.clone();
                }
                *clipped = true;
                return json!({ "type": "omitted" });
            }
            Value::Object(map.iter().map(|(key, item)| (key.clone(), clip(item, clipped))).collect())
        }
        _ => value.clone(),
    }
}

fn pick(value: &Value, keys: &[&str]) -> Map<String, Value> {
    keys.iter().filter_map(|key| value.get(*key).map(|item| (key.to_string(), item.clone()))).collect()
}

/// Keeps the Claude Code transcript lines the chat shows. Private reasoning, request dumps and subagent
/// side conversations are dropped.
fn claude_line(value: &Value) -> Option<Value> {
    let kind = value.get("type")?.as_str()?;
    // A message sent while the agent was busy is only recorded as this attachment.
    if kind == "attachment" {
        let attachment = value.get("attachment")?;
        let queued = attachment.get("type").and_then(Value::as_str) == Some("queued_command")
            && attachment.pointer("/origin/kind").and_then(Value::as_str) == Some("human")
            && value.get("isSidechain").and_then(Value::as_bool) != Some(true);
        if !queued {
            return None;
        }
        let mut out = pick(value, &["type", "uuid", "timestamp"]);
        out.insert("attachment".into(), Value::Object(pick(attachment, &["type", "prompt"])));
        return Some(Value::Object(out));
    }
    if !matches!(kind, "user" | "assistant" | "system" | "ai-title" | "custom-title" | "cost-state" | "permission-mode" | "pr-link") {
        return None;
    }
    if value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    if kind == "cost-state" {
        return Some(Value::Object(pick(value, &["type", "totalCostUSD", "totalLinesAdded", "totalLinesRemoved"])));
    }
    let mut out = pick(value, &["type", "subtype", "uuid", "timestamp", "message", "toolUseResult", "isMeta", "isApiErrorMessage", "isCompactSummary", "content", "level", "durationMs", "cwd", "gitBranch", "version", "permissionMode", "aiTitle", "customTitle", "prNumber", "prUrl", "prRepository"]);
    if let Some(Value::Object(message)) = out.get_mut("message") {
        if let Some(Value::Array(blocks)) = message.get_mut("content") {
            blocks.retain(|block| !matches!(block.get("type").and_then(Value::as_str), Some("thinking" | "redacted_thinking")));
            if blocks.is_empty() && kind == "assistant" && value.pointer("/message/usage").is_none() {
                return None;
            }
        }
        message.retain(|key, _| matches!(key.as_str(), "id" | "role" | "content" | "model" | "usage"));
    }
    if let Some(Value::Object(result)) = out.get_mut("toolUseResult") {
        // The patch already describes the change; the whole file would only repeat it.
        if result.contains_key("structuredPatch") {
            result.remove("originalFile");
            result.remove("oldString");
            result.remove("newString");
        }
    }
    Some(Value::Object(out))
}

fn codex_line(value: &Value) -> Option<Value> {
    let kind = value.get("type")?.as_str()?;
    let payload = value.get("payload")?;
    let inner = payload.get("type").and_then(Value::as_str);
    let body = match (kind, inner) {
        ("session_meta", _) => Value::Object(pick(payload, &["id", "cwd", "cli_version", "git", "timestamp"])),
        ("turn_context", _) => Value::Object(pick(payload, &["turn_id", "model", "effort", "approval_policy", "sandbox_policy", "cwd"])),
        ("event_msg", Some("item_completed")) => {
            if payload.pointer("/item/type").and_then(Value::as_str) == Some("Reasoning") {
                return None;
            }
            payload.clone()
        }
        ("event_msg", Some("token_count")) => {
            let mut map = pick(payload, &["type"]);
            if let Some(info) = payload.get("info") {
                map.insert("info".into(), Value::Object(pick(info, &["last_token_usage", "model_context_window"])));
            }
            Value::Object(map)
        }
        ("event_msg", Some("task_started" | "task_complete" | "turn_aborted" | "user_message" | "agent_message" | "error" | "stream_error")) => payload.clone(),
        ("response_item", Some("message")) if payload.get("role").and_then(Value::as_str) == Some("assistant") => Value::Object(pick(payload, &["type", "id", "role", "content"])),
        ("response_item", Some("function_call" | "custom_tool_call" | "function_call_output" | "custom_tool_call_output" | "local_shell_call")) => Value::Object(pick(payload, &["type", "call_id", "name", "arguments", "input", "output", "action", "status"])),
        _ => return None,
    };
    let mut out = pick(value, &["type", "timestamp", "ordinal"]);
    out.insert("payload".into(), body);
    Some(Value::Object(out))
}

#[derive(Serialize, Debug)]
pub struct Line {
    /// Byte offset of the line in the file: a stable identity and the key for `chat_raw`.
    o: u64,
    v: Value,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    clipped: bool,
}

fn parse_line(agent: &str, offset: u64, bytes: &[u8]) -> Option<Line> {
    // Request dumps can be megabytes long and are never shown; skip them without decoding.
    if bytes.starts_with(b"{\"type\":\"api-request") || bytes.starts_with(b"{\"type\":\"file-history") {
        return None;
    }
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let kept = if agent == "Codex" { codex_line(&value) } else { claude_line(&value) }?;
    let mut clipped = false;
    let v = clip(&kept, &mut clipped);
    Some(Line { o: offset, v, clipped })
}

#[derive(Debug)]
struct Slice {
    start: u64,
    end: u64,
    lines: Vec<Line>,
}

/// New complete lines after `from`, stopping early when the batch grows large.
fn read_forward(path: &Path, agent: &str, from: u64) -> std::io::Result<Slice> {
    let mut file = fs::File::open(path)?;
    file.seek(SeekFrom::Start(from))?;
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut buffer = Vec::new();
    let mut offset = from;
    let mut lines = Vec::new();
    let mut kept = 0;
    while kept < MAX_BATCH_BYTES {
        buffer.clear();
        let count = reader.read_until(b'\n', &mut buffer)?;
        // A line still being written stays for the next read.
        if count == 0 || buffer.last() != Some(&b'\n') {
            break;
        }
        if let Some(line) = parse_line(agent, offset, &buffer) {
            kept += line.v.to_string().len();
            lines.push(line);
        }
        offset += count as u64;
    }
    Ok(Slice { start: from, end: offset, lines })
}

/// The most recent lines ending before `before`, read backwards block by block.
fn read_backward(path: &Path, agent: &str, before: u64, wanted: usize) -> std::io::Result<Slice> {
    let mut file = fs::File::open(path)?;
    // Everything between `position` and `before` is loaded; `head` holds a line that starts earlier.
    let mut position = before;
    let mut head: Vec<u8> = Vec::new();
    let mut end = None;
    let mut lines: Vec<Line> = Vec::new();
    let mut kept = 0;
    while position > 0 && lines.len() < wanted && kept < MAX_BATCH_BYTES {
        let from = position.saturating_sub(BLOCK);
        let mut block = vec![0; (position - from) as usize];
        file.seek(SeekFrom::Start(from))?;
        file.read_exact(&mut block)?;
        block.append(&mut head);
        position = from;
        if end.is_none() {
            // Drop a trailing fragment that is still being written.
            let Some(last) = block.iter().rposition(|byte| *byte == b'\n') else {
                head = block;
                continue;
            };
            block.truncate(last + 1);
            end = Some(from + last as u64 + 1);
        }
        let first = if from == 0 { 0 } else { block.iter().position(|byte| *byte == b'\n').map_or(block.len(), |index| index + 1) };
        let mut offset = from + first as u64;
        let mut found = Vec::new();
        for piece in block[first..].split_inclusive(|byte| *byte == b'\n') {
            if let Some(line) = parse_line(agent, offset, piece) {
                kept += line.v.to_string().len();
                found.push(line);
            }
            offset += piece.len() as u64;
        }
        found.append(&mut lines);
        lines = found;
        block.truncate(first);
        head = block;
    }
    Ok(match end {
        Some(end) => Slice { start: position + head.len() as u64, end, lines },
        None => Slice { start: 0, end: 0, lines },
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    /// False while no conversation file is known for the session.
    bound: bool,
    /// The file changed identity or shrank: the UI must drop what it holds.
    reset: bool,
    source: String,
    start: u64,
    end: u64,
    /// More complete lines are already available after `end`.
    more: bool,
    lines: Vec<Line>,
    candidates: Vec<Candidate>,
}

/// Reads a session's conversation: the latest page by default, new lines with `from`, older ones with `before`.
#[tauri::command]
pub async fn chat_read(app: AppHandle, session_id: String, from: Option<u64>, before: Option<u64>, source: Option<String>) -> Result<Chunk, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (path, candidates, agent) = resolve(&app, &session_id)?;
        let empty = |bound: bool, source: String, candidates| Chunk { bound, reset: false, source, start: 0, end: 0, more: false, lines: Vec::new(), candidates };
        let Some(path) = path else { return Ok(empty(false, String::new(), candidates)) };
        let name = path.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
        let changed = source.is_some_and(|previous| previous != name);
        let Ok(meta) = fs::metadata(&path) else {
            // Claude announces the transcript path before writing the first line.
            return Ok(Chunk { reset: changed, ..empty(true, name, Vec::new()) });
        };
        if fs::canonicalize(&path).map_or(true, |real| !transcript_roots().iter().any(|root| fs::canonicalize(root).is_ok_and(|root| real.starts_with(root)))) {
            return Err("O arquivo da conversa está fora das pastas dos agentes.".into());
        }
        let size = meta.len();
        let reset = changed || from.is_some_and(|from| from > size);
        let slice = match (from.filter(|_| !reset), before.filter(|_| !reset)) {
            (_, Some(before)) => read_backward(&path, &agent, before.min(size), INITIAL_LINES),
            (Some(from), None) => read_forward(&path, &agent, from),
            (None, None) => read_backward(&path, &agent, size, INITIAL_LINES),
        }
        .map_err(|e| format!("Não foi possível ler a conversa: {e}"))?;
        let more = from.is_some() && !reset && slice.end > from.unwrap_or(0) && slice.end < size;
        Ok(Chunk { bound: true, reset, source: name, start: slice.start, end: slice.end, more, lines: slice.lines, candidates: Vec::new() })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The untouched line at `offset`, for "view original output".
#[tauri::command]
pub async fn chat_raw(app: AppHandle, session_id: String, offset: u64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = app.state::<ChatState>().bound(&session_id).ok_or("Conversa não encontrada.")?;
        let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
        // Offsets come from `chat_read`; refuse anything that is not the start of a line.
        if offset > 0 {
            let mut previous = [0u8; 1];
            file.seek(SeekFrom::Start(offset - 1)).map_err(|e| e.to_string())?;
            file.read_exact(&mut previous).map_err(|e| e.to_string())?;
            if previous[0] != b'\n' {
                return Err("Posição inválida.".into());
            }
        }
        file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        BufReader::new(file.take(MAX_RAW_LINE)).read_until(b'\n', &mut bytes).map_err(|e| e.to_string())?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Linha grande demais ou incompleta.".to_string())?;
        // Private reasoning stays private here too.
        let mut value = value;
        if let Some(Value::Array(blocks)) = value.pointer_mut("/message/content") {
            blocks.retain(|block| !matches!(block.get("type").and_then(Value::as_str), Some("thinking" | "redacted_thinking")));
        }
        serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Links a Codex session to the conversation the user picked among the candidates.
#[tauri::command]
pub async fn chat_bind(app: AppHandle, session_id: String, conversation_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let terminals = app.state::<TerminalState>();
        let info = terminal::session_summary(&terminals, &session_id).ok_or("Sessão não encontrada.")?;
        let since = terminal::running_since(&terminals, &session_id).ok_or("A sessão precisa estar em execução.")?;
        let chat = app.state::<ChatState>();
        let candidate = codex_candidates(&chat, &session_id, &info.folder, since)
            .into_iter()
            .find(|item| item.id == conversation_id)
            .ok_or("Conversa não encontrada.")?;
        chat.bind(&session_id, candidate.path);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Control characters would end the bracketed paste early or act as keystrokes in the TUI.
fn clean_message(text: &str) -> Result<String, String> {
    let text: String = text.replace("\r\n", "\n").replace('\r', "\n").chars().filter(|c| *c == '\n' || *c == '\t' || !c.is_control()).collect();
    if text.trim().is_empty() {
        return Err("Escreva uma mensagem.".into());
    }
    if text.len() > MAX_MESSAGE {
        return Err("A mensagem é grande demais.".into());
    }
    Ok(text)
}

/// Types a message into the session's terminal and submits it. Without `force` it refuses while the agent
/// has not shown it is ready, because a startup dialog would receive the keystrokes instead.
#[tauri::command]
pub async fn chat_send(app: AppHandle, session_id: String, text: String, force: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let text = clean_message(&text)?;
        let terminals = app.state::<TerminalState>();
        let (id, agent) = terminal::running_target(&terminals, &session_id)
            .filter(|(id, _)| id == &session_id)
            .ok_or("Sessão encerrada. Retome a sessão para enviar.")?;
        if agent == "Shell" {
            return Err("O chat é usado apenas com agentes.".into());
        }
        let chat = app.state::<ChatState>();
        if let Ok(connection) = chat.events() {
            if crate::live::pending(&connection).iter().any(|request| request.session_id == id) {
                return Err("Responda a solicitação pendente antes de enviar uma mensagem.".into());
            }
        }
        if !force {
            // Finds the conversation file first, in case it appeared since the last read.
            resolve(&app, &id)?;
            if !chat.ready(&id, terminal::running_since(&terminals, &id)) {
                return Err("NOT_READY".into());
            }
        }
        // A one-line command is typed, so the CLI recognises it as a command rather than pasted text.
        let payload = if text.starts_with('/') && !text.contains('\n') { text } else { crate::links::paste_payload(&agent, &text) };
        crate::links::submit(&terminals, &id, &agent, &payload)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn chat_permissions(state: tauri::State<'_, ChatState>) -> Result<Vec<crate::live::PendingPermission>, String> {
    Ok(crate::live::pending(&state.events()?))
}

#[tauri::command]
pub fn chat_permission_decide(state: tauri::State<'_, ChatState>, session_id: String, request_id: String, decision: crate::live::Decision) -> Result<(), String> {
    crate::live::decide(&state.events()?, &session_id, &request_id, &decision)
}

fn session_folder(app: &AppHandle, session: &str) -> Result<PathBuf, String> {
    let info = terminal::session_summary(&app.state::<TerminalState>(), session).ok_or("Sessão não encontrada.")?;
    fs::canonicalize(info.folder).map_err(|_| "A pasta da sessão não está acessível.".into())
}

fn without_verbatim(path: &Path) -> String {
    let text = path.to_string_lossy();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

/// A file named in a conversation, only if it exists inside the session's folder.
fn file_inside(folder: &Path, file: &str) -> Result<PathBuf, String> {
    let path = Path::new(file);
    let joined = if path.is_absolute() { path.to_path_buf() } else { folder.join(path) };
    let real = fs::canonicalize(joined).map_err(|_| "Arquivo não encontrado.".to_string())?;
    if !real.is_file() || !real.starts_with(folder) {
        return Err("Só é possível abrir arquivos dentro da pasta da sessão.".into());
    }
    Ok(real)
}

#[tauri::command]
pub fn chat_open_file(app: AppHandle, session_id: String, path: String, line: Option<u32>) -> Result<(), String> {
    let file = file_inside(&session_folder(&app, &session_id)?, &path)?;
    let mut target = without_verbatim(&file);
    if let Some(line) = line.filter(|line| *line > 0) {
        target = format!("{target}:{line}");
    }
    Command::new(crate::workspace::vscode_executable()?)
        .args(["--goto", &target])
        .spawn()
        .map_err(|e| format!("Falha ao abrir VS Code: {e}"))?;
    Ok(())
}

fn git_output(folder: &Path, args: &[&str]) -> Option<String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(without_verbatim(folder)).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatContext {
    folder: String,
    branch: Option<String>,
    /// Instruction files the agents read, relative to the folder.
    instructions: Vec<String>,
    /// Custom slash commands defined in the project or by the user (Claude Code).
    commands: Vec<String>,
}

#[tauri::command]
pub async fn chat_context(app: AppHandle, session_id: String) -> Result<ChatContext, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = session_folder(&app, &session_id)?;
        let branch = git_output(&folder, &["branch", "--show-current"]).map(|text| text.trim().to_string()).filter(|text| !text.is_empty());
        let instructions = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"].into_iter().filter(|name| folder.join(name).is_file()).map(str::to_string).collect();
        let mut commands: Vec<String> = [Some(folder.join(".claude")), agent_home("CLAUDE_CONFIG_DIR", ".claude")]
            .into_iter()
            .flatten()
            .filter_map(|base| fs::read_dir(base.join("commands")).ok())
            .flat_map(|entries| entries.flatten())
            .filter(|entry| entry.path().extension().is_some_and(|extension| extension == "md"))
            .filter_map(|entry| entry.path().file_stem().map(|stem| stem.to_string_lossy().into_owned()))
            .take(100)
            .collect();
        commands.sort();
        commands.dedup();
        Ok(ChatContext { folder: without_verbatim(&folder), branch, instructions, commands })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn walk_files(folder: &Path) -> Vec<String> {
    let mut files = Vec::new();
    let mut stack = vec![(folder.to_path_buf(), 0)];
    while let Some((current, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(current) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if depth < 5 && !name.starts_with('.') && !matches!(name.as_str(), "node_modules" | "target" | "dist" | "build") {
                    stack.push((entry.path(), depth + 1));
                }
            } else if let Ok(relative) = entry.path().strip_prefix(folder) {
                files.push(relative.to_string_lossy().replace('\\', "/"));
            }
            if files.len() >= 5_000 {
                return files;
            }
        }
    }
    files
}

/// Best matches first: file names before folders, shorter paths before longer ones.
fn match_files(files: Vec<String>, query: &str) -> Vec<String> {
    let query = query.to_lowercase();
    let mut found: Vec<(bool, usize, String)> = files
        .into_iter()
        .filter_map(|path| {
            let lower = path.to_lowercase();
            lower.contains(&query).then(|| (!lower.rsplit('/').next().unwrap_or(&lower).contains(&query), path.len(), path))
        })
        .collect();
    found.sort();
    found.into_iter().take(30).map(|(_, _, path)| path).collect()
}

/// Files of the session folder for `@` mentions.
#[tauri::command]
pub async fn chat_files(app: AppHandle, session_id: String, query: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = session_folder(&app, &session_id)?;
        let files = git_output(&folder, &["-c", "core.quotepath=off", "ls-files", "--cached", "--others", "--exclude-standard"])
            .map(|text| text.lines().take(20_000).map(str::to_string).collect())
            .unwrap_or_else(|| walk_files(&folder));
        Ok(match_files(files, &query))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Saves text where the user chooses in a native dialog; the UI cannot pick the path itself.
#[tauri::command]
pub async fn chat_export(app: AppHandle, content: String, name: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let name: String = name.chars().filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | ' ' | '.')).take(80).collect();
        let Some(path) = app.dialog().file().set_file_name(format!("{}.md", name.trim().trim_end_matches(".md"))).add_filter("Markdown", &["md"]).blocking_save_file() else {
            return Ok(false);
        };
        let path = path.into_path().map_err(|e| e.to_string())?;
        fs::write(path, content).map_err(|e| format!("Não foi possível salvar: {e}"))?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(lines: &[String]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("athenas-chat-{}.jsonl", uuid::Uuid::new_v4()));
        fs::write(&path, lines.join("")).unwrap();
        path
    }

    fn user(number: usize) -> String {
        format!("{{\"type\":\"user\",\"uuid\":\"u{number}\",\"message\":{{\"role\":\"user\",\"content\":\"mensagem {number}\"}}}}\n")
    }

    #[test]
    fn only_agent_conversation_files_can_be_bound() {
        let roots = vec![PathBuf::from("C:/home/.claude/projects")];
        assert!(allowed_transcript(Path::new("C:/home/.claude/projects/p/a.jsonl"), &roots));
        assert!(!allowed_transcript(Path::new("C:/home/.claude/projects/../../secret.jsonl"), &roots));
        assert!(!allowed_transcript(Path::new("C:/home/.claude/projects/p/a.txt"), &roots));
        assert!(!allowed_transcript(Path::new("C:/home/.claude/projects-evil/a.jsonl"), &roots));
        assert!(!allowed_transcript(Path::new("C:/other/a.jsonl"), &roots));
    }

    #[test]
    fn claude_lines_drop_reasoning_dumps_and_side_chats() {
        assert!(parse_line("Claude Code", 0, b"{\"type\":\"api-request\",\"x\":1}\n").is_none());
        assert!(parse_line("Claude Code", 0, b"{\"type\":\"user\",\"isSidechain\":true,\"message\":{}}\n").is_none());
        let line = parse_line("Claude Code", 0, br#"{"type":"assistant","message":{"id":"m","content":[{"type":"thinking","thinking":"privado"},{"type":"text","text":"oi"}],"usage":{}},"serverClassifierContext":{}}"#).unwrap();
        let text = line.v.to_string();
        assert!(text.contains("oi") && !text.contains("privado") && !text.contains("serverClassifierContext"));
        let edit = parse_line("Claude Code", 0, br#"{"type":"user","message":{"content":[]},"toolUseResult":{"filePath":"a","originalFile":"inteiro","structuredPatch":[]}}"#).unwrap();
        assert!(!edit.v.to_string().contains("inteiro"));
    }

    #[test]
    fn only_messages_queued_by_the_user_survive_among_attachments() {
        let queued = br#"{"type":"attachment","uuid":"q","attachment":{"type":"queued_command","prompt":"depois rode os testes","origin":{"kind":"human"},"delivery_id":"d"}}"#;
        let line = parse_line("Claude Code", 0, queued).unwrap();
        assert_eq!(line.v["attachment"]["prompt"], "depois rode os testes");
        assert!(line.v["attachment"].get("delivery_id").is_none());
        assert!(parse_line("Claude Code", 0, br#"{"type":"attachment","attachment":{"type":"queued_command","prompt":"x","origin":{"kind":"task-notification"}}}"#).is_none());
        assert!(parse_line("Claude Code", 0, br#"{"type":"attachment","attachment":{"type":"environment"}}"#).is_none());
    }

    #[test]
    fn codex_lines_skip_reasoning_and_trim_headers() {
        assert!(parse_line("Codex", 0, br#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"Reasoning"}}}"#).is_none());
        assert!(parse_line("Codex", 0, br#"{"type":"response_item","payload":{"type":"reasoning"}}"#).is_none());
        let meta = parse_line("Codex", 0, br#"{"type":"session_meta","payload":{"id":"x","base_instructions":{"text":"enorme"}}}"#).unwrap();
        assert!(!meta.v.to_string().contains("enorme"));
    }

    #[test]
    fn long_strings_are_clipped_and_flagged() {
        let text = "a".repeat(MAX_STRING + 10);
        let raw = format!("{{\"type\":\"user\",\"message\":{{\"content\":\"{text}\"}}}}\n");
        let line = parse_line("Claude Code", 0, raw.as_bytes()).unwrap();
        assert!(line.clipped);
        assert!(line.v.pointer("/message/content").unwrap().as_str().unwrap().ends_with("[recortado]"));
    }

    #[test]
    fn reading_forward_waits_for_complete_lines() {
        let mut content = vec![user(1), user(2)];
        content.push("{\"type\":\"user\",\"mess".into());
        let path = file(&content);
        let slice = read_forward(&path, "Claude Code", 0).unwrap();
        assert_eq!(slice.lines.len(), 2);
        assert_eq!(slice.end as usize, content[0].len() + content[1].len());
        assert_eq!(slice.lines[1].o as usize, content[0].len());
        assert!(read_forward(&path, "Claude Code", slice.end).unwrap().lines.is_empty());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn paging_backwards_covers_every_line_exactly_once_across_blocks() {
        // Filler lines make the file span several blocks, with lines cut at block boundaries.
        let filler = format!("{{\"type\":\"attachment\",\"data\":\"{}\"}}\n", "x".repeat(700_000));
        let mut content = Vec::new();
        for number in 0..30 {
            content.push(user(number));
            if number % 5 == 0 {
                content.push(filler.clone());
            }
        }
        content.push("{\"incompleto".into());
        let path = file(&content);
        let size = fs::metadata(&path).unwrap().len();
        let mut before = size;
        let mut seen = Vec::new();
        let mut first_end = None;
        while before > 0 {
            let slice = read_backward(&path, "Claude Code", before, 4).unwrap();
            first_end.get_or_insert(slice.end);
            for line in slice.lines.iter().rev() {
                seen.push(line.v["uuid"].as_str().unwrap().to_string());
            }
            assert!(slice.start < before);
            before = slice.start;
        }
        seen.reverse();
        assert_eq!(seen, (0..30).map(|number| format!("u{number}")).collect::<Vec<_>>());
        assert_eq!(first_end.unwrap(), size - "{\"incompleto".len() as u64);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn codex_binds_only_when_one_new_conversation_matches() {
        let make = |id: &str, started_at| Candidate { id: id.into(), started_at, preview: String::new(), path: PathBuf::new() };
        let one = [make("new", 100_000), make("old", 1_000)];
        assert_eq!(choose_codex(&one, 100_000, false).unwrap().id, "new");
        assert!(choose_codex(&one, 100_000, true).is_none());
        assert!(choose_codex(&[make("a", 100_000), make("b", 101_000)], 100_000, false).is_none());
        assert!(choose_codex(&[make("old", 1_000)], 100_000, false).is_none());
    }

    #[test]
    fn messages_cannot_smuggle_control_keys() {
        assert_eq!(clean_message("a\x1b[201~\r\nb\x03").unwrap(), "a[201~\nb");
        assert!(clean_message("  \x1b ").is_err());
    }

    #[test]
    fn only_files_inside_the_session_folder_open() {
        let root = std::env::temp_dir().join(format!("athenas-inside-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.ts"), "").unwrap();
        let outside = file(&[]);
        let folder = fs::canonicalize(&root).unwrap();
        assert!(file_inside(&folder, "src/a.ts").is_ok());
        assert!(file_inside(&folder, &outside.to_string_lossy()).is_err());
        assert!(file_inside(&folder, "src").is_err());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(outside);
    }

    #[test]
    fn mentions_prefer_file_names() {
        let files = vec!["docs/chat/readme.md".to_string(), "src/Chat.tsx".to_string(), "other.txt".to_string()];
        assert_eq!(match_files(files, "chat"), vec!["src/Chat.tsx", "docs/chat/readme.md"]);
    }
}
