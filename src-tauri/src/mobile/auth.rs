//! Who may talk to the phone server. A phone gets in only after scanning a one-time code shown on this
//! computer *and* being confirmed here; it then holds a random token of which only the hash is stored.
//! Time is passed in, so every expiry rule can be tested.
use super::push::Subscription;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const CODE_TTL_MS: i64 = 120_000;
pub const REQUEST_TTL_MS: i64 = 120_000;
const MAX_WRONG_CODES: u32 = 10;
const MAX_DEVICES: usize = 10;
const MAX_NAME: usize = 40;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub token_hash: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    /// May open conversations, send messages and approve. Pairing alone only lists the agents.
    #[serde(default)]
    pub control: bool,
    /// Where this device's notifications go, once it asks for them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub push: Option<Subscription>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Verdict {
    Waiting,
    Approved,
    Denied,
}

struct Request {
    id: String,
    name: String,
    /// Shown on both screens, so the user can tell the phone asking is the one in their hand.
    verification: String,
    expires_at: i64,
    verdict: Verdict,
}

/// What the computer shows about a phone waiting for confirmation.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingRequest {
    pub id: String,
    pub name: String,
    pub verification: String,
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Waiting,
    /// The token to hand to the phone; it is never available again.
    Paired(String),
    Denied,
    Expired,
}

#[derive(Default)]
pub struct Auth {
    pub devices: Vec<Device>,
    code: Option<(String, i64)>,
    wrong_codes: u32,
    request: Option<Request>,
}

fn hash(secret: &str) -> String {
    Sha256::digest(secret.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 256 bits from the operating system, in hexadecimal.
fn secret() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| format!("Sem fonte de números aleatórios: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn verification_number() -> Result<String, String> {
    let mut bytes = [0u8; 4];
    getrandom::fill(&mut bytes).map_err(|error| format!("Sem fonte de números aleatórios: {error}"))?;
    let number = u32::from_le_bytes(bytes) % 1_000_000;
    Ok(format!("{:03} {:03}", number / 1000, number % 1000))
}

fn clean_name(name: &str) -> String {
    let name: String = name.chars().filter(|c| !c.is_control()).collect();
    let name: String = name.trim().chars().take(MAX_NAME).collect();
    if name.is_empty() { "Celular".into() } else { name }
}

impl Auth {
    pub fn new(devices: Vec<Device>) -> Self {
        Self { devices, ..Self::default() }
    }

    /// Replaces any earlier code and forgets a phone that was still waiting.
    pub fn start_pairing(&mut self, now: i64) -> Result<(String, i64), String> {
        let code = secret()?;
        let expires_at = now + CODE_TTL_MS;
        self.code = Some((hash(&code), expires_at));
        self.wrong_codes = 0;
        self.request = None;
        Ok((code, expires_at))
    }

    pub fn cancel_pairing(&mut self) {
        self.code = None;
        self.request = None;
    }

    /// A phone presents the scanned code. The code works once.
    pub fn claim(&mut self, code: &str, name: &str, now: i64) -> Result<PendingRequest, String> {
        const REFUSED: &str = "Código inválido ou vencido. Gere um novo no computador.";
        let Some((expected, expires_at)) = self.code.as_ref() else { return Err(REFUSED.into()) };
        if now >= *expires_at {
            self.code = None;
            return Err(REFUSED.into());
        }
        if hash(code) != *expected {
            self.wrong_codes += 1;
            if self.wrong_codes >= MAX_WRONG_CODES {
                self.code = None;
            }
            return Err(REFUSED.into());
        }
        let request = Request {
            id: secret()?,
            name: clean_name(name),
            verification: verification_number()?,
            expires_at: now + REQUEST_TTL_MS,
            verdict: Verdict::Waiting,
        };
        let pending = PendingRequest { id: request.id.clone(), name: request.name.clone(), verification: request.verification.clone() };
        self.code = None;
        self.request = Some(request);
        Ok(pending)
    }

    pub fn code_active(&self, now: i64) -> bool {
        self.code.as_ref().is_some_and(|(_, expires_at)| now < *expires_at)
    }

    /// The phone waiting for the user's answer, if any.
    pub fn pending(&self, now: i64) -> Option<PendingRequest> {
        self.request
            .as_ref()
            .filter(|request| request.verdict == Verdict::Waiting && now < request.expires_at)
            .map(|request| PendingRequest { id: request.id.clone(), name: request.name.clone(), verification: request.verification.clone() })
    }

    /// The user's answer on the computer.
    pub fn decide(&mut self, id: &str, allow: bool, now: i64) -> Result<(), String> {
        let request = self
            .request
            .as_mut()
            .filter(|request| request.id == id && request.verdict == Verdict::Waiting && now < request.expires_at)
            .ok_or("Este pedido de pareamento expirou.")?;
        request.verdict = if allow { Verdict::Approved } else { Verdict::Denied };
        // The phone still has to fetch the answer.
        request.expires_at = now + REQUEST_TTL_MS;
        Ok(())
    }

    /// The phone asks how its request went. An approval is delivered, and the device created, exactly once.
    pub fn collect(&mut self, id: &str, now: i64) -> Result<Outcome, String> {
        let Some(request) = self.request.as_ref().filter(|request| request.id == id && now < request.expires_at) else {
            return Ok(Outcome::Expired);
        };
        match request.verdict {
            Verdict::Waiting => Ok(Outcome::Waiting),
            Verdict::Denied => {
                self.request = None;
                Ok(Outcome::Denied)
            }
            Verdict::Approved => {
                let token = secret()?;
                let device = Device { id: uuid::Uuid::new_v4().to_string(), name: request.name.clone(), token_hash: hash(&token), created_at: now, last_seen_at: now, control: false, push: None };
                self.request = None;
                self.devices.push(device);
                // Oldest access goes first when the list is full.
                while self.devices.len() > MAX_DEVICES {
                    let oldest = self.devices.iter().enumerate().min_by_key(|(_, device)| device.last_seen_at).map(|(index, _)| index);
                    if let Some(index) = oldest {
                        self.devices.remove(index);
                    }
                }
                Ok(Outcome::Paired(token))
            }
        }
    }

    /// The device holding `token`; records that it was seen.
    pub fn authenticate(&mut self, token: &str, now: i64) -> Option<&Device> {
        let wanted = hash(token);
        let device = self.devices.iter_mut().find(|device| device.token_hash == wanted)?;
        device.last_seen_at = now;
        Some(device)
    }

    pub fn set_control(&mut self, id: &str, control: bool) -> bool {
        let Some(device) = self.devices.iter_mut().find(|device| device.id == id) else { return false };
        device.control = control;
        true
    }

    /// One browser has one subscription: pairing it again must not notify it twice.
    pub fn set_push(&mut self, id: &str, push: Option<Subscription>) -> bool {
        if !self.devices.iter().any(|device| device.id == id) {
            return false;
        }
        for device in &mut self.devices {
            if device.id == id {
                device.push = push.clone();
            } else if push.as_ref().is_some_and(|new| device.push.as_ref().is_some_and(|old| old.endpoint == new.endpoint)) {
                device.push = None;
            }
        }
        true
    }

    /// Forgets a subscription its push service no longer knows.
    pub fn drop_push(&mut self, endpoint: &str) -> bool {
        let mut dropped = false;
        for device in &mut self.devices {
            if device.push.as_ref().is_some_and(|push| push.endpoint == endpoint) {
                device.push = None;
                dropped = true;
            }
        }
        dropped
    }

    pub fn revoke(&mut self, id: &str) -> bool {
        let before = self.devices.len();
        self.devices.retain(|device| device.id != id);
        before != self.devices.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paired(auth: &mut Auth, now: i64) -> String {
        let (code, _) = auth.start_pairing(now).unwrap();
        let request = auth.claim(&code, "Meu celular", now).unwrap();
        auth.decide(&request.id, true, now).unwrap();
        match auth.collect(&request.id, now).unwrap() {
            Outcome::Paired(token) => token,
            other => panic!("not paired: {other:?}"),
        }
    }

    #[test]
    fn a_phone_needs_the_code_and_the_confirmation() {
        let mut auth = Auth::default();
        let (code, _) = auth.start_pairing(0).unwrap();
        let request = auth.claim(&code, "  Redmi\u{7}  ", 1).unwrap();
        assert_eq!(request.name, "Redmi");
        assert_eq!(request.verification.len(), 7);
        assert_eq!(auth.collect(&request.id, 2).unwrap(), Outcome::Waiting);
        assert!(auth.devices.is_empty());
        auth.decide(&request.id, true, 3).unwrap();
        let Outcome::Paired(token) = auth.collect(&request.id, 4).unwrap() else { panic!("not paired") };
        assert_eq!(auth.devices.len(), 1);
        assert!(!auth.devices[0].token_hash.contains(&token));
        assert_eq!(auth.authenticate(&token, 9).unwrap().last_seen_at, 9);
        // The approval is delivered only once.
        assert_eq!(auth.collect(&request.id, 5).unwrap(), Outcome::Expired);
        assert!(auth.authenticate("outro", 10).is_none());
    }

    #[test]
    fn codes_work_once_expire_and_survive_few_mistakes() {
        let mut auth = Auth::default();
        let (code, expires_at) = auth.start_pairing(0).unwrap();
        assert!(auth.claim(&code, "a", expires_at).is_err());
        let (code, _) = auth.start_pairing(0).unwrap();
        auth.claim(&code, "a", 1).unwrap();
        assert!(auth.claim(&code, "b", 2).is_err());
        let (code, _) = auth.start_pairing(0).unwrap();
        for _ in 0..MAX_WRONG_CODES {
            assert!(auth.claim("errado", "a", 1).is_err());
        }
        assert!(!auth.code_active(1));
        assert!(auth.claim(&code, "a", 1).is_err());
    }

    #[test]
    fn denied_cancelled_and_stale_requests_create_nothing() {
        let mut auth = Auth::default();
        let (code, _) = auth.start_pairing(0).unwrap();
        let request = auth.claim(&code, "", 0).unwrap();
        assert_eq!(request.name, "Celular");
        auth.decide(&request.id, false, 1).unwrap();
        assert!(auth.decide(&request.id, true, 1).is_err());
        assert_eq!(auth.collect(&request.id, 2).unwrap(), Outcome::Denied);

        let (code, _) = auth.start_pairing(0).unwrap();
        let request = auth.claim(&code, "a", 0).unwrap();
        assert!(auth.pending(REQUEST_TTL_MS).is_none());
        assert!(auth.decide(&request.id, true, REQUEST_TTL_MS).is_err());

        let (code, _) = auth.start_pairing(0).unwrap();
        let request = auth.claim(&code, "a", 0).unwrap();
        auth.cancel_pairing();
        assert_eq!(auth.collect(&request.id, 1).unwrap(), Outcome::Expired);
        assert!(auth.devices.is_empty());
    }

    #[test]
    fn new_devices_cannot_control_and_a_browser_keeps_one_subscription() {
        let mut auth = Auth::default();
        paired(&mut auth, 0);
        paired(&mut auth, 1);
        assert!(auth.devices.iter().all(|device| !device.control && device.push.is_none()));
        let (first, second) = (auth.devices[0].id.clone(), auth.devices[1].id.clone());
        assert!(auth.set_control(&first, true) && auth.devices[0].control && !auth.devices[1].control);
        assert!(!auth.set_control("outro", true));
        let push = Subscription { endpoint: "https://fcm.googleapis.com/a".into(), p256dh: "k".into(), auth: "a".into() };
        assert!(auth.set_push(&first, Some(push.clone())) && auth.set_push(&second, Some(push.clone())));
        assert!(auth.devices[0].push.is_none() && auth.devices[1].push.is_some());
        assert!(auth.drop_push(&push.endpoint) && !auth.drop_push(&push.endpoint));
        // Devices saved before these fields existed load without control.
        let old: Device = serde_json::from_str(r#"{"id":"x","name":"n","tokenHash":"h","createdAt":1,"lastSeenAt":1}"#).unwrap();
        assert!(!old.control && old.push.is_none());
    }

    #[test]
    fn revoking_cuts_access_and_the_list_is_bounded() {
        let mut auth = Auth::default();
        let first = paired(&mut auth, 0);
        let id = auth.devices[0].id.clone();
        assert!(auth.revoke(&id));
        assert!(!auth.revoke(&id));
        assert!(auth.authenticate(&first, 1).is_none());
        let oldest = paired(&mut auth, 1);
        for now in 0..MAX_DEVICES as i64 {
            paired(&mut auth, 100 + now);
        }
        assert_eq!(auth.devices.len(), MAX_DEVICES);
        assert!(auth.authenticate(&oldest, 500).is_none());
    }
}
