//! Index of Claude Code and Codex conversations stored on disk (`~/.claude/projects`, `~/.codex/sessions`),
//! for searching, resuming and token usage. Files are parsed once and cached by size and modification
//! time, in memory and in `history-index.json`, so later searches only read what changed.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};
use tauri::{AppHandle, Manager};

const INDEX_VERSION: u32 = 1;
const MAX_SEARCH_TEXT: usize = 96 * 1024;
const MAX_PREVIEW_TEXT: usize = 6_000;
const MAX_PREVIEW_MESSAGES: usize = 400;

#[derive(Clone, Copy, Default, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl Tokens {
    fn add(&mut self, other: &Tokens) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
    }
    pub fn total(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub agent: String,
    pub folder: String,
    pub title: String,
    /// Milliseconds since the epoch.
    pub started_at: i64,
    pub updated_at: i64,
    pub prompts: u32,
    pub tokens: Tokens,
    /// Claude Code's own estimate (`cost-state`); Codex does not record one.
    pub cost_usd: Option<f64>,
    pub model: Option<String>,
    /// Lowercased prompts and answers (capped), for search. Stored in the index file, never sent to the UI.
    pub search_text: String,
    /// Tokens per UTC hour (`unix seconds / 3600`), so the UI can group them by local day.
    pub hourly: Vec<(i64, Tokens)>,
}

/// What the UI receives for a conversation.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationView {
    id: String,
    agent: String,
    folder: String,
    title: String,
    started_at: i64,
    updated_at: i64,
    prompts: u32,
    tokens: Tokens,
    cost_usd: Option<f64>,
    model: Option<String>,
}

impl From<Conversation> for ConversationView {
    fn from(item: Conversation) -> Self {
        Self { id: item.id, agent: item.agent, folder: item.folder, title: item.title, started_at: item.started_at, updated_at: item.updated_at, prompts: item.prompts, tokens: item.tokens, cost_usd: item.cost_usd, model: item.model }
    }
}

#[derive(Serialize, Deserialize)]
struct Cached {
    size: u64,
    modified: u64,
    conversation: Option<Conversation>,
}

#[derive(Serialize, Deserialize, Default)]
struct DiskIndex {
    version: u32,
    files: HashMap<String, Cached>,
}

pub struct HistoryIndex {
    files: Mutex<HashMap<String, Cached>>,
    path: PathBuf,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

/// Every conversation file, newest layout first.
fn conversation_files(home: &Path) -> Vec<(PathBuf, &'static str)> {
    let mut files = Vec::new();
    if let Ok(projects) = fs::read_dir(home.join(".claude").join("projects")) {
        for project in projects.flatten() {
            let Ok(entries) = fs::read_dir(project.path()) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|ext| ext == "jsonl") {
                    files.push((path, "Claude Code"));
                }
            }
        }
    }
    let mut stack = vec![home.join(".codex").join("sessions")];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|ext| ext == "jsonl") {
                files.push((path, "Codex"));
            }
        }
    }
    files
}

/// `2026-11-15T16:11:46.268Z` → milliseconds since the epoch (UTC).
pub fn parse_timestamp(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let number = |range: std::ops::Range<usize>| value.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    let millis = value.get(20..23).and_then(|text| text.parse::<i64>().ok()).filter(|_| bytes.get(19) == Some(&b'.')).unwrap_or(0);
    // Days from civil (Howard Hinnant).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000) + millis)
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| match part.get("type").and_then(Value::as_str) {
                Some("text" | "input_text" | "output_text") => part.get("text").and_then(Value::as_str),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn clip_title(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("");
    let mut title: String = line.chars().take(90).collect();
    if line.chars().count() > 90 {
        title.push('…');
    }
    title
}

/// Prompts written by a person, not wrappers the CLIs inject (`<command-name>`, `<environment_context>`…).
fn human_prompt(text: &str) -> bool {
    let text = text.trim_start();
    !text.is_empty() && !text.starts_with('<') && !text.starts_with("[Request interrupted")
}

struct Builder {
    agent: &'static str,
    id: String,
    folder: String,
    title: Option<String>,
    first_prompt: Option<String>,
    started: i64,
    updated: i64,
    prompts: u32,
    tokens: Tokens,
    hourly: HashMap<i64, Tokens>,
    cost: Option<f64>,
    model: Option<String>,
    search: String,
}

impl Builder {
    fn new(agent: &'static str, id: String) -> Self {
        Self { agent, id, folder: String::new(), title: None, first_prompt: None, started: 0, updated: 0, prompts: 0, tokens: Tokens::default(), hourly: HashMap::new(), cost: None, model: None, search: String::new() }
    }
    fn seen(&mut self, at: Option<i64>) {
        if let Some(at) = at {
            if self.started == 0 || at < self.started {
                self.started = at;
            }
            self.updated = self.updated.max(at);
        }
    }
    fn text(&mut self, text: &str) {
        if self.search.len() < MAX_SEARCH_TEXT {
            let room = MAX_SEARCH_TEXT - self.search.len();
            let lower = text.to_lowercase();
            let cut = lower.char_indices().map(|(index, _)| index).take_while(|index| *index <= room).last().unwrap_or(0);
            self.search.push_str(if lower.len() <= room { &lower } else { &lower[..cut] });
            self.search.push('\n');
        }
    }
    fn prompt(&mut self, text: &str) {
        self.prompts += 1;
        if self.first_prompt.is_none() {
            self.first_prompt = Some(clip_title(text));
        }
        self.text(text);
    }
    fn usage(&mut self, at: Option<i64>, tokens: Tokens) {
        self.tokens.add(&tokens);
        if let Some(at) = at {
            self.hourly.entry(at / 3_600_000).or_default().add(&tokens);
        }
    }
    fn finish(self) -> Option<Conversation> {
        if self.prompts == 0 && self.tokens.total() == 0 {
            return None;
        }
        let mut hourly: Vec<(i64, Tokens)> = self.hourly.into_iter().collect();
        hourly.sort_by_key(|(hour, _)| *hour);
        Some(Conversation {
            id: self.id,
            agent: self.agent.into(),
            folder: self.folder,
            title: self.title.or(self.first_prompt).filter(|title| !title.is_empty()).unwrap_or_else(|| "Sem título".into()),
            started_at: self.started,
            updated_at: self.updated,
            prompts: self.prompts,
            tokens: self.tokens,
            cost_usd: self.cost,
            model: self.model,
            search_text: self.search,
            hourly,
        })
    }
}

fn lines(path: &Path, mut each: impl FnMut(&str)) {
    let Ok(file) = fs::File::open(path) else { return };
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(_) => each(&String::from_utf8_lossy(&buffer)),
        }
    }
}

pub fn parse_claude(path: &Path) -> Option<Conversation> {
    let id = path.file_stem()?.to_string_lossy().into_owned();
    let mut conversation = Builder::new("Claude Code", id);
    let mut messages = HashSet::new();
    lines(path, |line| {
        // The request dumps carry whole system prompts; skip them without decoding.
        if line.starts_with("{\"type\":\"api-request") || line.starts_with("{\"type\":\"file-history") {
            return;
        }
        let wanted = ["\"type\":\"user\"", "\"type\":\"assistant\"", "\"type\":\"ai-title\"", "\"type\":\"summary\"", "\"type\":\"cost-state\""];
        if !wanted.iter().any(|marker| line.contains(marker)) {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else { return };
        let at = value.get("timestamp").and_then(Value::as_str).and_then(parse_timestamp);
        if conversation.folder.is_empty() {
            if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
                conversation.folder = cwd.to_string();
            }
        }
        match value.get("type").and_then(Value::as_str) {
            Some("ai-title") => conversation.title = value.get("aiTitle").and_then(Value::as_str).map(clip_title),
            Some("summary") if conversation.title.is_none() => conversation.title = value.get("summary").and_then(Value::as_str).map(clip_title),
            Some("cost-state") => conversation.cost = value.get("totalCostUSD").and_then(Value::as_f64),
            Some("user") => {
                conversation.seen(at);
                if value.get("isMeta").and_then(Value::as_bool) == Some(true) || value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
                    return;
                }
                let Some(message) = value.get("message") else { return };
                let text = text_of(message.get("content").unwrap_or(&Value::Null));
                if human_prompt(&text) {
                    conversation.prompt(&text);
                }
            }
            Some("assistant") => {
                conversation.seen(at);
                let Some(message) = value.get("message") else { return };
                conversation.text(&text_of(message.get("content").unwrap_or(&Value::Null)));
                if let Some(model) = message.get("model").and_then(Value::as_str).filter(|model| !model.starts_with('<')) {
                    conversation.model = Some(model.to_string());
                }
                // One API response is logged once per content block, with the same usage each time.
                let key = message.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                if key.is_empty() || !messages.insert(key) {
                    return;
                }
                if let Some(usage) = message.get("usage") {
                    let field = |name: &str| usage.get(name).and_then(Value::as_u64).unwrap_or(0);
                    conversation.usage(at, Tokens { input: field("input_tokens"), output: field("output_tokens"), cache_read: field("cache_read_input_tokens"), cache_write: field("cache_creation_input_tokens") });
                }
            }
            _ => {}
        }
    });
    conversation.finish()
}

pub fn parse_codex(path: &Path) -> Option<Conversation> {
    let mut conversation = Builder::new("Codex", String::new());
    let mut responses = HashSet::new();
    let mut fallback: Vec<(Option<i64>, Tokens)> = Vec::new();
    let mut user_messages = 0;
    lines(path, |line| {
        let wanted = ["\"session_meta\"", "\"user_message\"", "\"UserMessage\"", "\"role\":\"assistant\"", "\"token_usage_record\"", "\"token_count\"", "\"turn_context\""];
        if !wanted.iter().any(|marker| line.contains(marker)) {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else { return };
        let at = value.get("timestamp").and_then(Value::as_str).and_then(parse_timestamp);
        let payload = value.get("payload").unwrap_or(&Value::Null);
        let kind = payload.get("type").and_then(Value::as_str);
        match (value.get("type").and_then(Value::as_str), kind) {
            (Some("session_meta"), _) => {
                conversation.id = payload.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                conversation.folder = payload.get("cwd").and_then(Value::as_str).unwrap_or_default().to_string();
                conversation.seen(payload.get("timestamp").and_then(Value::as_str).and_then(parse_timestamp));
            }
            (Some("turn_context"), _) => {
                if let Some(model) = payload.get("model").and_then(Value::as_str) {
                    conversation.model = Some(model.to_string());
                }
            }
            // Newer releases log prompts as completed `UserMessage` items, older ones as `user_message` events.
            (Some("event_msg"), Some("user_message")) => {
                conversation.seen(at);
                let text = payload.get("message").and_then(Value::as_str).unwrap_or_default();
                if human_prompt(text) {
                    user_messages += 1;
                    conversation.prompt(text);
                }
            }
            (Some("event_msg"), Some("item_completed")) if user_messages == 0 => {
                let item = payload.get("item").unwrap_or(&Value::Null);
                if item.get("type").and_then(Value::as_str) == Some("UserMessage") {
                    conversation.seen(at);
                    let text = text_of(item.get("content").unwrap_or(&Value::Null));
                    if human_prompt(&text) {
                        conversation.prompt(&text);
                    }
                }
            }
            (Some("response_item"), Some("message")) if payload.get("role").and_then(Value::as_str) == Some("assistant") => {
                conversation.seen(at);
                conversation.text(&text_of(payload.get("content").unwrap_or(&Value::Null)));
            }
            (Some("token_usage_record"), _) => {
                let response = payload.get("response_id").and_then(Value::as_str).unwrap_or_default().to_string();
                if response.is_empty() || !responses.insert(response) {
                    return;
                }
                if let Some(tokens) = payload.get("usage").map(codex_tokens) {
                    conversation.usage(at, tokens);
                }
            }
            (Some("event_msg"), Some("token_count")) => {
                if let Some(tokens) = payload.get("info").and_then(|info| info.get("last_token_usage")).map(codex_tokens) {
                    fallback.push((at, tokens));
                }
            }
            _ => {}
        }
    });
    // Releases without per-response records still log the last usage after each response.
    if responses.is_empty() {
        for (at, tokens) in fallback {
            conversation.usage(at, tokens);
        }
    }
    if conversation.id.is_empty() {
        return None;
    }
    conversation.finish()
}

/// OpenAI counts cached input inside `input_tokens`; split it out like Claude does.
fn codex_tokens(usage: &Value) -> Tokens {
    let field = |name: &str| usage.get(name).and_then(Value::as_u64).unwrap_or(0);
    let cached = field("cached_input_tokens");
    Tokens { input: field("input_tokens").saturating_sub(cached), output: field("output_tokens"), cache_read: cached, cache_write: field("cache_write_input_tokens") }
}

impl HistoryIndex {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("history-index.json");
        let disk: DiskIndex = fs::read(&path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        let files = if disk.version == INDEX_VERSION { disk.files } else { HashMap::new() };
        Ok(Self { files: Mutex::new(files), path })
    }

    /// Re-reads changed files and returns every known conversation.
    pub fn refresh(&self) -> Result<Vec<Conversation>, String> {
        let home = home().ok_or("Pasta do usuário não encontrada.")?;
        let found = conversation_files(&home);
        let mut changed = false;
        let mut current = HashMap::new();
        let mut files = self.files.lock().map_err(|e| e.to_string())?;
        for (path, agent) in found {
            let Ok(meta) = fs::metadata(&path) else { continue };
            let modified = meta.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
            let key = path.to_string_lossy().into_owned();
            let cached = match files.remove(&key) {
                Some(cached) if cached.size == meta.len() && cached.modified == modified => cached,
                _ => {
                    changed = true;
                    let conversation = if agent == "Codex" { parse_codex(&path) } else { parse_claude(&path) };
                    Cached { size: meta.len(), modified, conversation }
                }
            };
            current.insert(key, cached);
        }
        changed |= !files.is_empty();
        *files = current;
        if changed {
            let disk = DiskIndex { version: INDEX_VERSION, files: std::mem::take(&mut *files) };
            if let Ok(bytes) = serde_json::to_vec(&disk) {
                let _ = fs::write(&self.path, bytes);
            }
            *files = disk.files;
        }
        let mut list: Vec<Conversation> = files.values().filter_map(|cached| cached.conversation.clone()).collect();
        list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(list)
    }

    fn file_of(&self, agent: &str, id: &str) -> Option<PathBuf> {
        let files = self.files.lock().ok()?;
        files.iter().find_map(|(path, cached)| {
            let conversation = cached.conversation.as_ref()?;
            (conversation.agent == agent && conversation.id == id).then(|| PathBuf::from(path))
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    #[serde(flatten)]
    conversation: ConversationView,
    snippet: Option<String>,
}

/// Lines of text around the first match, for the result list.
fn snippet(text: &str, query: &str) -> Option<String> {
    let index = text.find(query)?;
    let start = text[..index].char_indices().rev().nth(60).map(|(at, _)| at).unwrap_or(0);
    let end = text[index..].char_indices().nth(query.chars().count() + 100).map(|(at, _)| index + at).unwrap_or(text.len());
    let piece = text[start..end].split_whitespace().collect::<Vec<_>>().join(" ");
    Some(format!("{}{}{}", if start > 0 { "…" } else { "" }, piece, if end < text.len() { "…" } else { "" }))
}

pub fn search(conversations: Vec<Conversation>, query: &str, agent: Option<&str>, limit: usize) -> Vec<SearchHit> {
    let terms: Vec<String> = query.to_lowercase().split_whitespace().map(str::to_string).collect();
    conversations
        .into_iter()
        .filter(|item| agent.map_or(true, |agent| item.agent == agent))
        .filter_map(|item| {
            if terms.is_empty() {
                return Some(SearchHit { conversation: item.into(), snippet: None });
            }
            let haystack = format!("{}\n{}\n{}", item.title.to_lowercase(), item.folder.to_lowercase(), item.search_text);
            if !terms.iter().all(|term| haystack.contains(term.as_str())) {
                return None;
            }
            let snippet = snippet(&item.search_text, &terms[0]);
            Some(SearchHit { conversation: item.into(), snippet })
        })
        .take(limit)
        .collect()
}

#[tauri::command]
pub async fn history_search(app: AppHandle, query: Option<String>, agent: Option<String>, limit: Option<usize>) -> Result<Vec<SearchHit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let index = app.state::<HistoryIndex>();
        let conversations = index.refresh()?;
        Ok(search(conversations, query.as_deref().unwrap_or(""), agent.as_deref(), limit.unwrap_or(300).min(1000)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewMessage {
    role: String,
    text: String,
    at: Option<i64>,
}

#[tauri::command]
pub async fn history_messages(app: AppHandle, agent: String, id: String) -> Result<Vec<PreviewMessage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let index = app.state::<HistoryIndex>();
        let path = index.file_of(&agent, &id).ok_or("Conversa não encontrada. Atualize o histórico.")?;
        let mut messages = Vec::new();
        let mut seen = HashSet::new();
        lines(&path, |line| {
            if messages.len() >= MAX_PREVIEW_MESSAGES || line.starts_with("{\"type\":\"api-request") {
                return;
            }
            let Ok(value) = serde_json::from_str::<Value>(line) else { return };
            let at = value.get("timestamp").and_then(Value::as_str).and_then(parse_timestamp);
            let (role, text) = if agent == "Codex" {
                let payload = value.get("payload").unwrap_or(&Value::Null);
                match (value.get("type").and_then(Value::as_str), payload.get("type").and_then(Value::as_str)) {
                    (Some("event_msg"), Some("user_message")) => ("user", payload.get("message").and_then(Value::as_str).unwrap_or_default().to_string()),
                    (Some("event_msg"), Some("item_completed")) if payload.pointer("/item/type").and_then(Value::as_str) == Some("UserMessage") => ("user", text_of(payload.pointer("/item/content").unwrap_or(&Value::Null))),
                    (Some("response_item"), Some("message")) if payload.get("role").and_then(Value::as_str) == Some("assistant") => ("assistant", text_of(payload.get("content").unwrap_or(&Value::Null))),
                    _ => return,
                }
            } else {
                if value.get("isMeta").and_then(Value::as_bool) == Some(true) || value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
                    return;
                }
                match value.get("type").and_then(Value::as_str) {
                    Some(kind @ ("user" | "assistant")) => (if kind == "user" { "user" } else { "assistant" }, text_of(value.pointer("/message/content").unwrap_or(&Value::Null))),
                    _ => return,
                }
            };
            if text.trim().is_empty() || (role == "user" && !human_prompt(&text)) {
                return;
            }
            // Codex logs some prompts twice (event and item); keep the first.
            if !seen.insert(format!("{role}:{}", text.trim())) {
                return;
            }
            let mut text = text.trim().to_string();
            if text.chars().count() > MAX_PREVIEW_TEXT {
                text = text.chars().take(MAX_PREVIEW_TEXT).collect::<String>() + "…";
            }
            messages.push(PreviewMessage { role: role.into(), text, at });
        });
        Ok(messages)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucket {
    hour: i64,
    agent: String,
    folder: String,
    tokens: Tokens,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageConversation {
    id: String,
    agent: String,
    folder: String,
    title: String,
    tokens: Tokens,
    cost_usd: Option<f64>,
    updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    buckets: Vec<UsageBucket>,
    top: Vec<UsageConversation>,
    /// Sum of Claude Code's own estimates for the conversations used in the period (whole conversations).
    claude_cost_usd: f64,
    conversations: usize,
}

/// Token usage since `since` (ms): hourly buckets per agent and folder, and the heaviest conversations.
pub fn usage_report(conversations: &[Conversation], since: i64) -> UsageReport {
    let first_hour = since / 3_600_000;
    let mut buckets: HashMap<(i64, String, String), Tokens> = HashMap::new();
    let mut top = Vec::new();
    let mut claude_cost_usd = 0.0;
    for item in conversations {
        let mut period = Tokens::default();
        for (hour, tokens) in item.hourly.iter().filter(|(hour, _)| *hour >= first_hour) {
            buckets.entry((*hour, item.agent.clone(), item.folder.clone())).or_default().add(tokens);
            period.add(tokens);
        }
        if period.total() > 0 {
            claude_cost_usd += item.cost_usd.unwrap_or(0.0);
            top.push(UsageConversation { id: item.id.clone(), agent: item.agent.clone(), folder: item.folder.clone(), title: item.title.clone(), tokens: period, cost_usd: item.cost_usd, updated_at: item.updated_at });
        }
    }
    top.sort_by(|a, b| b.tokens.total().cmp(&a.tokens.total()));
    let used = top.len();
    top.truncate(15);
    let mut buckets: Vec<UsageBucket> = buckets.into_iter().map(|((hour, agent, folder), tokens)| UsageBucket { hour, agent, folder, tokens }).collect();
    buckets.sort_by_key(|bucket| bucket.hour);
    UsageReport { buckets, top, claude_cost_usd, conversations: used }
}

#[tauri::command]
pub async fn history_session_tokens(app: AppHandle, agent: String, id: String) -> Result<Option<u64>, String> {
    if uuid::Uuid::parse_str(&id).is_err() || !matches!(agent.as_str(), "Claude Code" | "Codex") {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let conversations = app.state::<HistoryIndex>().refresh()?;
        Ok(conversations.iter()
            .find(|conversation| conversation.agent == agent && conversation.id == id && !conversation.hourly.is_empty())
            .map(|conversation| conversation.tokens.total()))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn history_usage(app: AppHandle, since: i64) -> Result<UsageReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conversations = app.state::<HistoryIndex>().refresh()?;
        Ok(usage_report(&conversations, since))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(lines: &[&str]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("{}.jsonl", uuid::Uuid::new_v4()));
        fs::write(&path, lines.join("\n")).unwrap();
        path
    }

    #[test]
    fn timestamps_are_read_as_utc_milliseconds() {
        assert_eq!(parse_timestamp("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_timestamp("2026-11-15T16:11:46.268Z"), Some(1_794_759_106_268));
        assert_eq!(parse_timestamp("ontem"), None);
    }

    #[test]
    fn claude_transcripts_count_each_response_once() {
        let path = write(&[
            r#"{"type":"api-request-shape","shape":{"system":"enorme"}}"#,
            r#"{"type":"user","cwd":"C:\\proj","timestamp":"2026-11-15T10:00:00Z","message":{"role":"user","content":"Corrija o login"}}"#,
            r#"{"type":"user","isMeta":true,"timestamp":"2026-11-15T10:00:01Z","message":{"role":"user","content":"Base directory"}}"#,
            r#"{"type":"user","timestamp":"2026-11-15T10:00:02Z","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-15T10:00:03Z","message":{"id":"m1","model":"claude-opus-5-5","content":[{"type":"text","text":"Pronto, ajustei o token."}],"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":20}}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-15T10:00:04Z","message":{"id":"m1","content":[{"type":"tool_use"}],"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":20}}}"#,
            r#"{"type":"ai-title","aiTitle":"Login quebrado"}"#,
            r#"{"type":"cost-state","totalCostUSD":0.42}"#,
        ]);
        let conversation = parse_claude(&path).unwrap();
        assert_eq!(conversation.title, "Login quebrado");
        assert_eq!(conversation.folder, r"C:\proj");
        assert_eq!(conversation.prompts, 1);
        assert_eq!(conversation.tokens, Tokens { input: 10, output: 5, cache_read: 100, cache_write: 20 });
        assert_eq!(conversation.cost_usd, Some(0.42));
        assert_eq!(conversation.model.as_deref(), Some("claude-opus-5-5"));
        assert!(conversation.search_text.contains("ajustei o token"));
        assert_eq!(conversation.hourly.len(), 1);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn codex_sessions_split_cached_input_and_skip_injected_context() {
        let path = write(&[
            r#"{"timestamp":"2026-11-14T14:08:53Z","type":"session_meta","payload":{"id":"01a1da61-2484-7140-afb7-152c8dfd1797","cwd":"C:\\Teste","timestamp":"2026-11-14T14:06:01Z"}}"#,
            r#"{"timestamp":"2026-11-14T14:08:54Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"}]}}"#,
            r#"{"timestamp":"2026-11-14T14:08:54Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"Crie um site de músicas"}]}}}"#,
            r#"{"timestamp":"2026-11-14T14:08:57Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Vou criar o estúdio"}]}}"#,
            r#"{"timestamp":"2026-11-14T14:08:59Z","type":"token_usage_record","payload":{"response_id":"r1","usage":{"input_tokens":1000,"cached_input_tokens":600,"output_tokens":50}}}"#,
            r#"{"timestamp":"2026-11-14T14:09:00Z","type":"token_usage_record","payload":{"response_id":"r1","usage":{"input_tokens":1000,"cached_input_tokens":600,"output_tokens":50}}}"#,
            r#"{"timestamp":"2026-11-14T14:09:06Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1000,"cached_input_tokens":600,"output_tokens":50}}}}"#,
        ]);
        let conversation = parse_codex(&path).unwrap();
        assert_eq!(conversation.id, "01a1da61-2484-7140-afb7-152c8dfd1797");
        assert_eq!(conversation.title, "Crie um site de músicas");
        assert_eq!(conversation.prompts, 1);
        assert_eq!(conversation.tokens, Tokens { input: 400, output: 50, cache_read: 600, cache_write: 0 });
        let _ = fs::remove_file(path);
    }

    #[test]
    fn search_needs_every_term_and_returns_a_snippet() {
        let path = write(&[
            r#"{"type":"user","cwd":"C:\\proj","timestamp":"2026-11-15T10:00:00Z","message":{"content":"Corrija o login do painel admin"}}"#,
        ]);
        let conversation = parse_claude(&path).unwrap();
        let hits = search(vec![conversation.clone()], "LOGIN admin", None, 10);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.as_deref().unwrap().contains("login do painel"));
        assert!(search(vec![conversation.clone()], "login deploy", None, 10).is_empty());
        assert!(search(vec![conversation], "login", Some("Codex"), 10).is_empty());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn usage_report_groups_by_hour_agent_and_folder() {
        let make = |agent: &str, hour: i64, total: u64| Conversation {
            id: format!("{agent}{hour}"), agent: agent.into(), folder: "C:/p".into(), title: "t".into(), started_at: 0, updated_at: hour * 3_600_000,
            prompts: 1, tokens: Tokens { input: total, ..Tokens::default() }, cost_usd: None, model: None, search_text: String::new(),
            hourly: vec![(hour, Tokens { input: total, ..Tokens::default() })],
        };
        let report = usage_report(&[make("Codex", 10, 5), make("Codex", 10, 7), make("Claude Code", 2, 100)], 5 * 3_600_000);
        assert_eq!(report.buckets.len(), 1);
        assert_eq!(report.buckets[0].tokens.input, 12);
        assert_eq!(report.top.len(), 2);
    }
}
