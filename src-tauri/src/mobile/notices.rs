//! Which changes in the sessions' status deserve a notification on the phone.
use super::{AgentCard, Published};
use serde_json::json;
use std::collections::HashMap;

const MAX_TITLE: usize = 80;
const MAX_BODY: usize = 180;

#[derive(Clone, Debug, PartialEq)]
pub struct Notice {
    pub session: String,
    /// `approval` or `done`.
    pub kind: &'static str,
    pub title: String,
    pub body: String,
}

impl Notice {
    /// What the phone's service worker receives.
    pub fn payload(&self) -> String {
        json!({ "title": self.title, "body": self.body, "session": self.session }).to_string()
    }
}

fn clip(text: String, limit: usize) -> String {
    match text.char_indices().nth(limit) {
        Some((index, _)) => format!("{}…", &text[..index]),
        None => text,
    }
}

/// Compares what the desktop showed before with what it shows now. A session is announced when it starts
/// waiting for the user, or when a turn finishes.
pub fn changes(previous: &Published, agents: &[AgentCard]) -> Vec<Notice> {
    let before: HashMap<&str, (&str, Option<i64>)> = previous.items.iter().map(|item| (item.id.as_str(), (item.state.as_str(), item.since))).collect();
    agents
        .iter()
        .filter_map(|agent| {
            let old = before.get(agent.id.as_str()).copied();
            let name = agent.title.as_deref().map(str::trim).filter(|title| !title.is_empty()).unwrap_or(&agent.agent);
            let place = agent.project.as_deref().unwrap_or(&agent.folder);
            let (kind, title, detail) = match agent.state.as_str() {
                "approval" if old.is_none_or(|(state, _)| state != "approval") => {
                    let detail = if agent.message.is_empty() { "Aguardando sua resposta." } else { &agent.message };
                    ("approval", format!("{name} precisa de você"), detail)
                }
                // A session seen for the first time as finished is history, not news.
                "done" if old.is_some_and(|(state, since)| state != "done" || since != agent.since) => ("done", format!("{name} terminou"), "Pronto para a próxima instrução."),
                _ => return None,
            };
            let source = if place.is_empty() { agent.agent.clone() } else { format!("{} · {place}", agent.agent) };
            Some(Notice { session: agent.id.clone(), kind, title: clip(title, MAX_TITLE), body: clip(format!("{source}\n{detail}"), MAX_BODY) })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn published(states: &[(&str, &str, i64)]) -> Published {
        serde_json::from_value(json!({ "theme": null, "items": states.iter().map(|(id, state, since)| json!({ "id": id, "project": null, "tone": "", "label": "", "state": state, "since": since })).collect::<Vec<_>>() })).unwrap()
    }

    fn agent(id: &str, state: &str, since: i64) -> AgentCard {
        AgentCard { id: id.into(), agent: "Codex".into(), folder: "api".into(), state: state.into(), since: Some(since), ..AgentCard::default() }
    }

    fn kinds(previous: &Published, agents: &[AgentCard]) -> Vec<(String, &'static str)> {
        changes(previous, agents).into_iter().map(|notice| (notice.session, notice.kind)).collect()
    }

    #[test]
    fn only_new_waiting_and_finished_turns_are_announced() {
        let before = published(&[("a", "working", 1), ("b", "approval", 1), ("c", "done", 1), ("d", "working", 1), ("e", "done", 1)]);
        let now = [agent("a", "done", 2), agent("b", "approval", 1), agent("c", "done", 1), agent("d", "approval", 2), agent("e", "done", 5), agent("f", "approval", 2), agent("g", "done", 2), agent("h", "working", 2)];
        assert_eq!(kinds(&before, &now), vec![("a".into(), "done"), ("d".into(), "approval"), ("e".into(), "done"), ("f".into(), "approval")]);
        // Interrupting is the user's own action.
        assert!(kinds(&published(&[("a", "working", 1)]), &[agent("a", "idle", 2)]).is_empty());
    }

    #[test]
    fn the_text_names_the_session_and_stays_short() {
        let mut waiting = agent("a", "approval", 2);
        waiting.title = Some("Corrigir login".into());
        waiting.project = Some("Loja".into());
        waiting.message = "x".repeat(500);
        let notice = changes(&Published::default(), &[waiting]).remove(0);
        assert_eq!(notice.title, "Corrigir login precisa de você");
        assert!(notice.body.starts_with("Codex · Loja\nxx") && notice.body.chars().count() == MAX_BODY + 1);
        assert!(notice.payload().contains("\"session\":\"a\""));
    }
}
