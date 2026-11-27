//! The desktop side of [`Host`]: connects the phone server to the terminals, the chat and the app's files,
//! and keeps the log of what was done from a phone.
use super::{
    cards, control::{Action, Kind, Page}, notices::Notice, push::{self, Subscription}, AgentCard, Device, Host, MobileState, Overview, Published, Store,
};
use crate::{
    chat::{self, ChatState},
    live::{Decision, PendingPermission},
    terminal::{self, TerminalState},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    fs,
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager};

const KEPT: usize = 100;
const MAX_LOG_BYTES: u64 = 256 * 1024;
const MAX_DETAIL: usize = 300;

/// One line of the log.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub at: i64,
    pub device: String,
    pub agent: String,
    /// `sent`, `interrupted`, `allowed`, `denied` or `answered`.
    pub action: String,
    pub detail: String,
}

/// `mobile-actions.jsonl` in the app data folder.
pub struct Log {
    path: PathBuf,
    entries: Mutex<VecDeque<Entry>>,
}

impl Log {
    pub fn load(path: PathBuf) -> Self {
        let text = fs::read_to_string(&path).unwrap_or_default();
        let mut entries: VecDeque<Entry> = text.lines().filter_map(|line| serde_json::from_str(line).ok()).collect();
        while entries.len() > KEPT {
            entries.pop_front();
        }
        Self { path, entries: Mutex::new(entries) }
    }

    pub fn add(&self, entry: Entry) {
        let Ok(mut entries) = self.entries.lock() else { return };
        entries.push_back(entry.clone());
        while entries.len() > KEPT {
            entries.pop_front();
        }
        let line = |entry: &Entry| serde_json::to_string(entry).map(|text| text + "\n").unwrap_or_default();
        // A large file is rewritten with only what is still kept.
        if fs::metadata(&self.path).is_ok_and(|meta| meta.len() > MAX_LOG_BYTES) {
            let _ = fs::write(&self.path, entries.iter().map(line).collect::<String>());
        } else if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&self.path) {
            let _ = file.write_all(line(&entry).as_bytes());
        }
    }

    /// Newest first.
    pub fn latest(&self, count: usize) -> Vec<Entry> {
        self.entries.lock().map(|entries| entries.iter().rev().take(count).cloned().collect()).unwrap_or_default()
    }
}

/// Tauri answers a missing file with the desktop page. The MIME type it reports cannot tell them apart,
/// because it calls any extension it does not know (`.webmanifest`) HTML.
pub fn is_fallback_page(name: &str, bytes: &[u8]) -> bool {
    const DOCTYPE: &[u8] = b"<!doctype html";
    !name.ends_with(".html") && bytes.get(..DOCTYPE.len()).is_some_and(|start| start.eq_ignore_ascii_case(DOCTYPE))
}

pub struct AppHost {
    pub app: AppHandle,
    pub store: Arc<Store>,
    pub published: Arc<Mutex<Published>>,
    pub log: Arc<Log>,
}

impl Host for AppHost {
    fn overview(&self) -> Overview {
        let published = self.published.lock().map(|value| value.clone()).unwrap_or_default();
        let sessions = terminal::live_sessions(&self.app.state::<TerminalState>());
        let computer = self
            .app
            .try_state::<MobileState>()
            .and_then(|state| state.runtime.lock().ok()?.url.clone())
            .and_then(|url| url.strip_prefix("https://")?.split('.').next().map(str::to_string))
            .unwrap_or_default();
        let agents: Vec<AgentCard> = cards(sessions, &published);
        Overview { computer, agents, theme: published.theme, ..Overview::default() }
    }

    /// A file of the built interface. In `tauri dev` it comes from `dist/`, so run `npm run build` first.
    fn asset(&self, name: &str) -> Option<Vec<u8>> {
        let asset = self.app.asset_resolver().get(name.to_string())?;
        (!is_fallback_page(name, &asset.bytes)).then_some(asset.bytes)
    }

    fn save_devices(&self, devices: &[Device]) -> Result<(), String> {
        self.store.update(|config| config.devices = devices.to_vec())
    }

    fn conversation(&self, session: &str, page: Page) -> Result<Value, String> {
        let chunk = chat::read(&self.app, session, page.from, page.before, page.source)?;
        serde_json::to_value(chunk).map_err(|e| e.to_string())
    }

    fn requests(&self, session: &str) -> Result<Vec<PendingPermission>, String> {
        let mut pending = self.app.state::<ChatState>().pending()?;
        pending.retain(|request| request.session_id == session);
        Ok(pending)
    }

    /// Never forced: an agent that has not shown it is ready may be showing a startup question.
    fn send(&self, session: &str, text: &str) -> Result<(), String> {
        chat::send(&self.app, session, text, false)
    }

    fn interrupt(&self, session: &str) -> Result<(), String> {
        terminal::write_session(&self.app.state::<TerminalState>(), session, "\x1b")
    }

    fn decide(&self, session: &str, request: &str, decision: &Decision) -> Result<(), String> {
        self.app.state::<ChatState>().decide(session, request, decision)
    }

    fn record(&self, action: Action) {
        let kind = match action.kind {
            Kind::Sent => "sent",
            Kind::Interrupted => "interrupted",
            Kind::Allowed => "allowed",
            Kind::Denied => "denied",
            Kind::Answered => "answered",
        };
        // The interface updates the session the same way as when this is done on the computer.
        let text = if action.kind == Kind::Sent { action.detail.as_str() } else { "" };
        let _ = self.app.emit("mobile-action", json!({ "sessionId": action.session_id, "kind": kind, "text": text }));
        self.log.add(Entry {
            at: crate::live::now_ms(),
            device: action.device,
            agent: action.agent,
            action: kind.into(),
            detail: action.detail.chars().take(MAX_DETAIL).collect(),
        });
    }

    fn push_key(&self) -> Result<String, String> {
        push::public_key(&self.store.signing_key()?)
    }

    fn push_test(&self, subscription: &Subscription) -> Result<(), String> {
        let key = self.store.signing_key()?;
        let notice = Notice { session: String::new(), kind: "done", title: "Notificações ligadas".into(), body: "O Athenas vai avisar quando um agente terminar ou precisar de você.".into() };
        tauri::async_runtime::block_on(push::deliver(&key, subscription, &notice.payload(), "teste")).map_err(|failure| match failure {
            push::Failure::Gone => "O serviço de notificações não reconhece mais este aparelho. Desligue e ligue as notificações.".into(),
            push::Failure::Other(error) => error,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_desktop_page_is_not_served_in_place_of_a_missing_file() {
        let page = b"<!DOCTYPE html><html></html>";
        assert!(is_fallback_page("assets/gone.js", page) && is_fallback_page("manifest.webmanifest", page));
        assert!(!is_fallback_page("mobile.html", page));
        assert!(!is_fallback_page("manifest.webmanifest", br#"{ "name": "Athenas Agent" }"#));
        assert!(!is_fallback_page("favicon.png", b"\x89PNG"));
    }

    #[test]
    fn the_log_keeps_the_latest_actions_across_restarts() {
        let path = std::env::temp_dir().join(format!("athenas-actions-{}.jsonl", uuid::Uuid::new_v4()));
        let log = Log::load(path.clone());
        for index in 0..KEPT + 5 {
            log.add(Entry { at: index as i64, device: "d".into(), agent: "a".into(), action: "sent".into(), detail: format!("linha\n{index}") });
        }
        let reloaded = Log::load(path.clone());
        assert_eq!(reloaded.latest(2).iter().map(|entry| entry.at).collect::<Vec<_>>(), vec![104, 103]);
        assert_eq!(reloaded.latest(1000).len(), KEPT);
        fs::remove_file(path).unwrap();
    }
}
