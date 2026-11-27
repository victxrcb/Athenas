//! What a phone may do to a running agent, and when. Sending a message types it into the agent's terminal and
//! presses Enter, so it is refused whenever that Enter could answer a question instead.
use super::{AgentCard, Shared};
use crate::live::{Decision, PendingPermission};
use serde_json::{json, Value};

const MAX_MESSAGE: usize = 100_000;
const MAX_REMEMBERED: usize = 200;
/// A second Esc shortly after the first opens menus inside the agents.
const INTERRUPT_PAUSE_MS: i64 = 3_000;

/// The paired device making a request.
#[derive(Clone, Debug)]
pub struct Access {
    pub id: String,
    pub name: String,
    /// Whether the user let this device open conversations, send messages and approve.
    pub control: bool,
}

#[derive(Debug)]
pub struct Refusal {
    pub status: u16,
    pub message: String,
}

fn refuse<T>(status: u16, message: impl Into<String>) -> Result<T, Refusal> {
    Err(Refusal { status, message: message.into() })
}

fn internal(message: String) -> Refusal {
    Refusal { status: 500, message }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Sent,
    Interrupted,
    Allowed,
    Denied,
    Answered,
}

/// Something done from a phone, reported to the desktop and written to the log.
#[derive(Clone, Debug)]
pub struct Action {
    pub session_id: String,
    pub device: String,
    /// The session as the user knows it.
    pub agent: String,
    pub kind: Kind,
    /// The message sent, or what was approved or refused.
    pub detail: String,
}

/// Which part of a conversation to read; mirrors the desktop chat.
#[derive(Default, Debug)]
pub struct Page {
    pub from: Option<u64>,
    pub before: Option<u64>,
    pub source: Option<String>,
}

/// Messages recently accepted, so a retry over a bad connection never types the same one twice.
#[derive(Default)]
pub struct Recent {
    messages: std::collections::VecDeque<(String, bool)>,
    interrupts: std::collections::HashMap<String, i64>,
}

enum Reservation {
    New,
    Sending,
    Sent,
}

impl Recent {
    fn reserve(&mut self, key: &str) -> Reservation {
        match self.messages.iter().find(|(known, _)| known == key) {
            Some((_, true)) => Reservation::Sent,
            Some((_, false)) => Reservation::Sending,
            None => {
                self.messages.push_back((key.to_string(), false));
                while self.messages.len() > MAX_REMEMBERED {
                    self.messages.pop_front();
                }
                Reservation::New
            }
        }
    }

    fn finish(&mut self, key: &str, sent: bool) {
        if sent {
            if let Some(entry) = self.messages.iter_mut().find(|(known, _)| known == key) {
                entry.1 = true;
            }
        } else {
            self.messages.retain(|(known, _)| known != key);
        }
    }

    fn may_interrupt(&mut self, session: &str, now: i64) -> bool {
        if self.interrupts.get(session).is_some_and(|last| now - last < INTERRUPT_PAUSE_MS) {
            return false;
        }
        self.interrupts.insert(session.to_string(), now);
        true
    }
}

/// Characters that leave nothing visible and that the agents may drop from the start of a message.
fn unseen(c: char) -> bool {
    c.is_whitespace() || c.is_control() || matches!(c, '\u{ad}' | '\u{180e}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2069}' | '\u{feff}')
}

fn permitted(access: &Access) -> Result<(), Refusal> {
    if access.control {
        Ok(())
    } else {
        refuse(403, "Libere este aparelho no computador, em Ajustes → Celular.")
    }
}

fn running(shared: &Shared, session: &str) -> Result<AgentCard, Refusal> {
    match shared.host.overview().agents.into_iter().find(|agent| agent.id == session) {
        Some(agent) => Ok(agent),
        None => refuse(404, "Este agente não está mais em execução."),
    }
}

fn label(agent: &AgentCard) -> String {
    agent.title.clone().filter(|title| !title.trim().is_empty()).unwrap_or_else(|| agent.agent.clone())
}

fn requests(shared: &Shared, session: &str) -> Result<Vec<PendingPermission>, Refusal> {
    shared.host.requests(session).map_err(internal)
}

fn record(shared: &Shared, access: &Access, agent: &AgentCard, kind: Kind, detail: String) {
    shared.host.record(Action { session_id: agent.id.clone(), device: access.name.clone(), agent: label(agent), kind, detail });
}

/// A page of the conversation together with the requests waiting for an answer.
pub fn conversation(shared: &Shared, access: &Access, session: &str, page: Page) -> Result<Value, Refusal> {
    permitted(access)?;
    running(shared, session)?;
    let chunk = shared.host.conversation(session, page).map_err(internal)?;
    Ok(json!({ "chunk": chunk, "requests": requests(shared, session)? }))
}

pub fn send(shared: &Shared, access: &Access, session: &str, message_id: &str, text: &str) -> Result<(), Refusal> {
    permitted(access)?;
    let agent = running(shared, session)?;
    // Cleaned the same way as it will be typed, so the check below sees what the agent will see.
    let cleaned = crate::chat::clean_message(text).map_err(|message| Refusal { status: 400, message })?;
    let text = cleaned.trim_matches(unseen);
    if text.is_empty() {
        return refuse(400, "Escreva uma mensagem.");
    }
    if text.len() > MAX_MESSAGE {
        return refuse(400, "A mensagem é grande demais.");
    }
    // Both agents read these as commands: `!` even runs one in the shell without asking.
    if text.starts_with(['/', '!']) {
        return refuse(400, "Pelo celular não é possível enviar comandos, que começam com / ou !.");
    }
    if message_id.is_empty() || message_id.len() > 64 {
        return refuse(400, "Pedido inválido.");
    }
    let key = format!("{}/{session}/{message_id}", access.id);
    let reservation = shared.recent.lock().map_err(|e| internal(e.to_string()))?.reserve(&key);
    match reservation {
        Reservation::Sent => return Ok(()),
        Reservation::Sending => return refuse(409, "Essa mensagem ainda está sendo enviada."),
        Reservation::New => {}
    }
    // The desktop status covers questions that have no structured request, such as Codex approvals.
    let result = if agent.state == "approval" || !requests(shared, session)?.is_empty() {
        refuse(409, "O agente está esperando uma resposta. Responda antes de enviar uma mensagem.")
    } else {
        shared.host.send(session, text).or_else(|error| {
            if error == "NOT_READY" {
                refuse(409, "O agente ainda não sinalizou que está pronto. Envie a primeira mensagem pelo computador.")
            } else {
                refuse(409, error)
            }
        })
    };
    shared.recent.lock().map_err(|e| internal(e.to_string()))?.finish(&key, result.is_ok());
    if result.is_ok() {
        record(shared, access, &agent, Kind::Sent, text.to_string());
    }
    result
}

pub fn interrupt(shared: &Shared, access: &Access, session: &str) -> Result<(), Refusal> {
    permitted(access)?;
    let agent = running(shared, session)?;
    if !matches!(agent.state.as_str(), "working" | "approval") {
        return refuse(409, "O agente não está trabalhando.");
    }
    if !shared.recent.lock().map_err(|e| internal(e.to_string()))?.may_interrupt(session, crate::live::now_ms()) {
        return refuse(409, "A interrupção já foi enviada.");
    }
    shared.host.interrupt(session).map_err(|error| Refusal { status: 409, message: error })?;
    record(shared, access, &agent, Kind::Interrupted, String::new());
    Ok(())
}

/// What a request asks for, in one line for the log.
fn subject(request: &PendingPermission) -> String {
    let what = ["command", "file_path", "notebook_path", "url", "pattern"].iter().find_map(|key| request.tool_input.get(*key).and_then(Value::as_str));
    what.map_or_else(|| request.tool_name.clone(), |what| format!("{}: {what}", request.tool_name))
}

pub fn decide(shared: &Shared, access: &Access, session: &str, request_id: &str, decision: &Decision) -> Result<(), Refusal> {
    permitted(access)?;
    let agent = running(shared, session)?;
    let kind = match decision.behavior.as_str() {
        "allow" => Kind::Allowed,
        "deny" => Kind::Denied,
        "answer" => Kind::Answered,
        // Standing rules widen what the agent may do from then on; that is decided at the computer.
        _ => return refuse(400, "Essa resposta só pode ser dada no computador."),
    };
    let Some(request) = requests(shared, session)?.into_iter().find(|request| request.id == request_id) else {
        return refuse(409, "Esta solicitação já foi respondida ou expirou.");
    };
    shared.host.decide(session, request_id, decision).map_err(|error| Refusal { status: 409, message: error })?;
    record(shared, access, &agent, kind, subject(&request));
    Ok(())
}
