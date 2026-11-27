//! Access from the user's phone: a loopback web server published on their Tailscale network, the devices
//! allowed to use it and the commands behind the "Celular" settings. Off until the user turns it on.
mod app;
mod auth;
mod control;
mod notices;
mod push;
mod server;
mod tailscale;

use crate::{
    live::{Decision, PendingPermission},
    terminal::{self, SessionInfo, TerminalState},
};
use app::{AppHost, Entry, Log};
use auth::{Auth, Device, Outcome, PendingRequest};
use control::{Access, Action, Page, Recent};
use push::Subscription;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    net::{Ipv4Addr, TcpListener},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

const DEFAULT_PORT: u16 = 47_821;
/// "Last seen" is written to disk at most this often.
const SEEN_SAVE_MS: i64 = 60_000;
/// Tailscale may still be starting when the app opens with the computer.
const START_ATTEMPTS: u32 = 12;
const START_PAUSE: Duration = Duration::from_secs(10);
const EXIT_DEADLINE: Duration = Duration::from_secs(4);
/// The same session announcing the same thing again this soon is one event reported twice.
const NOTICE_PAUSE_MS: i64 = 4_000;

/// One running agent as the phone lists it.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCard {
    pub id: String,
    pub agent: String,
    pub title: Option<String>,
    pub project: Option<String>,
    /// Only the folder's name; full paths stay on the computer.
    pub folder: String,
    pub tone: String,
    pub label: String,
    pub message: String,
    pub since: Option<i64>,
    /// `working`, `approval`, `done`, `idle` or empty when nothing was reported yet.
    pub state: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub computer: String,
    pub theme: Option<String>,
    pub agents: Vec<AgentCard>,
    /// What the asking device may do; filled in by the server.
    pub can_control: bool,
    pub notifications: bool,
}

/// What only the interface knows about a session: its project and the live status it shows.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PublishedAgent {
    id: String,
    project: Option<String>,
    tone: String,
    label: String,
    #[serde(default)]
    message: String,
    since: Option<i64>,
    #[serde(default)]
    state: String,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct Published {
    theme: Option<String>,
    items: Vec<PublishedAgent>,
}

fn clip(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// Running agents (never plain shells), as the terminals report them, described the way the desktop shows them.
fn cards(sessions: Vec<SessionInfo>, published: &Published) -> Vec<AgentCard> {
    let known: HashMap<&str, &PublishedAgent> = published.items.iter().map(|item| (item.id.as_str(), item)).collect();
    sessions
        .into_iter()
        .filter(|session| session.agent != "Shell")
        .map(|session| {
            let shown = known.get(session.id.as_str()).copied();
            let folder = session.folder.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().unwrap_or_default().to_string();
            AgentCard {
                tone: shown.map_or_else(|| "running".into(), |item| clip(&item.tone, 20)),
                label: shown.map_or_else(|| "Ativo".into(), |item| clip(&item.label, 40)),
                message: shown.map_or_else(String::new, |item| clip(&item.message, 400)),
                since: shown.and_then(|item| item.since),
                state: shown.map_or_else(String::new, |item| clip(&item.state, 20)),
                project: shown.and_then(|item| item.project.as_deref().map(|name| clip(name, 120))),
                id: session.id,
                agent: session.agent,
                title: session.title,
                folder,
            }
        })
        .collect()
}

/// Everything the server needs from the desktop app, so it can be tested without one.
pub trait Host: Send + Sync {
    fn overview(&self) -> Overview;
    fn asset(&self, name: &str) -> Option<Vec<u8>>;
    fn save_devices(&self, devices: &[Device]) -> Result<(), String>;
    fn conversation(&self, session: &str, page: Page) -> Result<Value, String>;
    /// Permission requests of this session waiting for an answer.
    fn requests(&self, session: &str) -> Result<Vec<PendingPermission>, String>;
    fn send(&self, session: &str, text: &str) -> Result<(), String>;
    fn interrupt(&self, session: &str) -> Result<(), String>;
    fn decide(&self, session: &str, request: &str, decision: &Decision) -> Result<(), String>;
    fn record(&self, action: Action);
    /// The public half of the key that signs notifications.
    fn push_key(&self) -> Result<String, String>;
    /// Sends a sample notification and waits for the answer.
    fn push_test(&self, subscription: &Subscription) -> Result<(), String>;
}

/// Which names the server answers to while it is open.
#[derive(Default)]
struct Door {
    port: u16,
    public_host: Option<String>,
    open: bool,
}

/// What the server threads and the desktop commands share.
pub struct Shared {
    auth: Mutex<Auth>,
    door: Mutex<Door>,
    host: Box<dyn Host>,
    recent: Mutex<Recent>,
}

impl Shared {
    fn new(devices: Vec<Device>, host: Box<dyn Host>) -> Self {
        Self { auth: Mutex::new(Auth::new(devices)), door: Mutex::default(), host, recent: Mutex::default() }
    }

    fn open(&self, port: u16, public_host: Option<String>) {
        if let Ok(mut door) = self.door.lock() {
            *door = Door { port, public_host, open: true };
        }
    }

    fn close(&self) {
        if let Ok(mut door) = self.door.lock() {
            door.open = false;
        }
        if let Ok(mut auth) = self.auth.lock() {
            auth.cancel_pairing();
        }
    }

    fn is_open(&self) -> bool {
        self.door.lock().is_ok_and(|door| door.open)
    }

    fn allows_host(&self, host: &str) -> bool {
        let Ok(door) = self.door.lock() else { return false };
        let host = host.to_ascii_lowercase();
        let public = door.public_host.as_ref().is_some_and(|name| host == *name || host == format!("{name}:443"));
        public || host == format!("127.0.0.1:{}", door.port) || host == format!("localhost:{}", door.port)
    }

    fn allows_origin(&self, origin: &str) -> bool {
        let origin = origin.to_ascii_lowercase();
        if let Some(host) = origin.strip_prefix("https://") {
            return self.door.lock().is_ok_and(|door| door.public_host.as_deref() == Some(host));
        }
        // Plain HTTP only ever means this computer.
        origin.strip_prefix("http://").is_some_and(|host| (host.starts_with("127.0.0.1:") || host.starts_with("localhost:")) && self.allows_host(host))
    }

    fn with_auth<T>(&self, action: impl FnOnce(&mut Auth) -> T) -> Result<T, String> {
        self.auth.lock().map(|mut auth| action(&mut auth)).map_err(|e| e.to_string())
    }

    /// Answers a waiting phone; a new device only counts once it is saved.
    fn collect(&self, request: &str) -> Result<Outcome, String> {
        self.with_auth(|auth| {
            let outcome = auth.collect(request, crate::live::now_ms())?;
            if matches!(outcome, Outcome::Paired(_)) {
                if let Err(error) = self.host.save_devices(&auth.devices) {
                    auth.devices.pop();
                    return Err(format!("Não foi possível salvar o aparelho: {error}"));
                }
            }
            Ok(outcome)
        })?
    }

    /// The device holding this token.
    fn authenticate(&self, token: &str) -> Option<Access> {
        let now = crate::live::now_ms();
        self.with_auth(|auth| {
            let before: Vec<(String, i64)> = auth.devices.iter().map(|device| (device.id.clone(), device.last_seen_at)).collect();
            let device = auth.authenticate(token, now)?;
            let access = Access { id: device.id.clone(), name: device.name.clone(), control: device.control };
            let id = access.id.clone();
            // Comparing periods, not gaps: a phone that asks every few seconds is still saved once a minute.
            if before.iter().any(|(device, seen)| *device == id && now / SEEN_SAVE_MS != seen / SEEN_SAVE_MS) {
                let _ = self.host.save_devices(&auth.devices);
            }
            Some(access)
        })
        .ok()
        .flatten()
    }

    /// Applies a change to the devices and saves it when something changed.
    fn change_devices(&self, change: impl FnOnce(&mut Auth) -> bool) -> Result<(), String> {
        self.with_auth(|auth| if change(auth) { self.host.save_devices(&auth.devices) } else { Ok(()) })?
    }

    fn revoke(&self, device: &str) -> Result<(), String> {
        self.change_devices(|auth| auth.revoke(device))
    }

    fn subscription(&self, device: &str) -> Option<Subscription> {
        self.with_auth(|auth| auth.devices.iter().find(|item| item.id == device).and_then(|item| item.push.clone())).ok().flatten()
    }

    fn subscriptions(&self) -> Vec<Subscription> {
        self.with_auth(|auth| auth.devices.iter().filter_map(|device| device.push.clone()).collect()).unwrap_or_default()
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
struct Config {
    enabled: bool,
    port: u16,
    devices: Vec<Device>,
    /// Signs the notifications; created when a device first asks for them.
    #[serde(skip_serializing_if = "Option::is_none")]
    signing_key: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self { enabled: false, port: DEFAULT_PORT, devices: Vec::new(), signing_key: None }
    }
}

/// `mobile.json` in the app data folder.
struct Store {
    path: PathBuf,
    config: Mutex<Config>,
}

impl Store {
    /// An unreadable file means access stays off with no devices, never the other way around.
    fn load(path: PathBuf) -> Self {
        let config = fs::read(&path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        Self { path, config: Mutex::new(config) }
    }

    fn snapshot(&self) -> Config {
        self.config.lock().map(|config| config.clone()).unwrap_or_default()
    }

    fn update(&self, change: impl FnOnce(&mut Config)) -> Result<(), String> {
        let mut config = self.config.lock().map_err(|e| e.to_string())?;
        let mut next = config.clone();
        change(&mut next);
        let temp = self.path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
        fs::write(&temp, bytes).map_err(|e| e.to_string())?;
        if let Err(error) = crate::mcp_config::atomic_replace(&temp, &self.path) {
            let _ = fs::remove_file(temp);
            return Err(error);
        }
        *config = next;
        Ok(())
    }

    fn signing_key(&self) -> Result<String, String> {
        if let Some(key) = self.snapshot().signing_key {
            return Ok(key);
        }
        let fresh = push::generate_key()?;
        // Another thread may have created it in the meantime; the first one stays.
        self.update(|config| {
            config.signing_key.get_or_insert(fresh);
        })?;
        self.snapshot().signing_key.ok_or_else(|| "Não foi possível criar a chave das notificações.".into())
    }
}

#[derive(Default)]
struct Runtime {
    server: Option<oneshot::Sender<()>>,
    /// The published address; `None` until Tailscale accepted it.
    url: Option<String>,
    error: Option<String>,
    pairing: Option<Pairing>,
    /// Why the latest notification did not go out.
    push_error: Option<String>,
    /// When each session last announced each kind of notice.
    announced: HashMap<(String, &'static str), i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    url: String,
    expires_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    id: String,
    name: String,
    created_at: i64,
    last_seen_at: i64,
    control: bool,
    notifications: bool,
}

/// Everything the settings screen shows; token hashes never leave the backend.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    enabled: bool,
    url: Option<String>,
    error: Option<String>,
    pairing: Option<Pairing>,
    request: Option<PendingRequest>,
    devices: Vec<DeviceView>,
    /// The latest things done from a phone, newest first.
    actions: Vec<Entry>,
    push_error: Option<String>,
}

pub struct MobileState {
    shared: Arc<Shared>,
    store: Arc<Store>,
    published: Arc<Mutex<Published>>,
    log: Arc<Log>,
    runtime: Mutex<Runtime>,
    /// Held while access is being turned on or off, so two changes never interleave.
    switching: Mutex<()>,
}

/// Development builds can serve this computer alone, without Tailscale, to try the phone page in a browser.
fn local_only() -> bool {
    cfg!(debug_assertions) && std::env::var_os("ATHENAS_MOBILE_LOCAL").is_some()
}

impl MobileState {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let store = Arc::new(Store::load(data.join("mobile.json")));
        let published: Arc<Mutex<Published>> = Arc::default();
        let log = Arc::new(Log::load(data.join("mobile-actions.jsonl")));
        let host = AppHost { app: app.clone(), store: store.clone(), published: published.clone(), log: log.clone() };
        let shared = Arc::new(Shared::new(store.snapshot().devices, Box::new(host)));
        Ok(Self { shared, store, published, log, runtime: Mutex::default(), switching: Mutex::new(()) })
    }

    fn runtime(&self) -> Result<std::sync::MutexGuard<'_, Runtime>, String> {
        self.runtime.lock().map_err(|e| e.to_string())
    }

    fn view(&self) -> Result<View, String> {
        let now = crate::live::now_ms();
        let (request, code_active, devices) = self.shared.with_auth(|auth| {
            let devices = auth
                .devices
                .iter()
                .map(|device| DeviceView {
                    id: device.id.clone(),
                    name: device.name.clone(),
                    created_at: device.created_at,
                    last_seen_at: device.last_seen_at,
                    control: device.control,
                    notifications: device.push.is_some(),
                })
                .collect();
            (auth.pending(now), auth.code_active(now), devices)
        })?;
        let enabled = self.store.snapshot().enabled;
        let mut runtime = self.runtime()?;
        // A used or expired code is not worth showing any more.
        if !code_active {
            runtime.pairing = None;
        }
        Ok(View {
            enabled,
            url: runtime.url.clone(),
            error: runtime.error.clone(),
            pairing: runtime.pairing.clone(),
            request,
            devices,
            actions: self.log.latest(5),
            push_error: runtime.push_error.clone(),
        })
    }

    /// Starts the server if needed and publishes it. Callers hold `switching`.
    fn connect(&self) -> Result<(), String> {
        let port = self.store.snapshot().port;
        let url = if local_only() {
            self.listen(port)?;
            self.shared.open(port, None);
            format!("http://127.0.0.1:{port}")
        } else {
            let host = tailscale::ready(&tailscale::status())?;
            self.listen(port)?;
            self.shared.open(port, Some(host.clone()));
            tailscale::publish(port)?;
            format!("https://{host}")
        };
        let mut runtime = self.runtime()?;
        runtime.url = Some(url);
        runtime.error = None;
        Ok(())
    }

    fn listen(&self, port: u16) -> Result<(), String> {
        let mut runtime = self.runtime()?;
        if runtime.server.is_none() {
            runtime.server = Some(serve(self.shared.clone(), port)?);
        }
        Ok(())
    }

    /// Returns whether this instance was the one serving.
    fn stop_server(&self) -> Result<bool, String> {
        self.shared.close();
        let mut runtime = self.runtime()?;
        let stop = runtime.server.take();
        runtime.url = None;
        runtime.pairing = None;
        Ok(stop.is_some_and(|stop| stop.send(()).is_ok()))
    }

    /// Removes the Tailscale publication, unless another instance of the app is using the port it points to.
    fn withdraw(&self, served: bool) -> Result<(), String> {
        let port = self.store.snapshot().port;
        if local_only() || !served && TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_err() {
            return Ok(());
        }
        tailscale::unpublish(port, tailscale::TIMEOUT)
    }

    fn enable(&self) -> Result<(), String> {
        let _switching = self.switching.lock().map_err(|e| e.to_string())?;
        let was_enabled = self.store.snapshot().enabled;
        if let Err(error) = self.connect().and_then(|()| self.store.update(|config| config.enabled = true)) {
            // Turning it on failed, so nothing stays open. A retry of an already enabled access keeps the choice.
            if !was_enabled && self.stop_server()? {
                let _ = self.withdraw(true);
            }
            self.runtime()?.error = Some(error);
        }
        Ok(())
    }

    fn disable(&self) -> Result<(), String> {
        let _switching = self.switching.lock().map_err(|e| e.to_string())?;
        let served = self.stop_server()?;
        self.store.update(|config| config.enabled = false)?;
        let removed = self.withdraw(served);
        self.runtime()?.error = removed.err().map(|error| format!("O acesso foi desligado, mas a publicação no Tailscale não foi removida. {error}"));
        Ok(())
    }

    /// Notifies the phones of sessions that just finished or started waiting for the user.
    fn announce(&self, app: &AppHandle, previous: &Published, next: &Published) {
        if !self.store.snapshot().enabled {
            return;
        }
        let subscriptions = self.shared.subscriptions();
        if subscriptions.is_empty() {
            return;
        }
        let agents = cards(terminal::live_sessions(&app.state::<TerminalState>()), next);
        let mut due = notices::changes(previous, &agents);
        let now = crate::live::now_ms();
        if let Ok(mut runtime) = self.runtime() {
            due.retain(|notice| {
                let key = (notice.session.clone(), notice.kind);
                let fresh = runtime.announced.get(&key).is_none_or(|at| now - at >= NOTICE_PAUSE_MS);
                if fresh {
                    runtime.announced.insert(key, now);
                }
                fresh
            });
        }
        if due.is_empty() {
            return;
        }
        let key = match self.store.signing_key() {
            Ok(key) => key,
            Err(error) => {
                if let Ok(mut runtime) = self.runtime() {
                    runtime.push_error = Some(error);
                }
                return;
            }
        };
        for notice in due {
            let (app, key, subscriptions) = (app.clone(), key.clone(), subscriptions.clone());
            tauri::async_runtime::spawn(async move {
                let payload = notice.payload();
                for subscription in subscriptions {
                    let result = push::deliver(&key, &subscription, &payload, &notice.session).await;
                    let state = app.state::<MobileState>();
                    let error = match result {
                        Ok(()) => None,
                        Err(push::Failure::Gone) => {
                            let _ = state.shared.change_devices(|auth| auth.drop_push(&subscription.endpoint));
                            Some("Um aparelho cancelou as notificações. Ative-as de novo no celular.".to_string())
                        }
                        Err(push::Failure::Other(error)) => Some(error),
                    };
                    if let Ok(mut runtime) = state.runtime() {
                        runtime.push_error = error;
                    };
                }
            });
        }
    }
}

/// Listens on the loopback address only.
fn serve(shared: Arc<Shared>, port: u16) -> Result<oneshot::Sender<()>, String> {
    let mut attempts = 0;
    let listener = loop {
        match TcpListener::bind((Ipv4Addr::LOCALHOST, port)) {
            Ok(listener) => break listener,
            // The previous server may still be letting go of the port.
            Err(_) if attempts < 20 => {
                attempts += 1;
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => return Err(format!("Não foi possível abrir a porta {port} neste computador: {error}")),
        }
    };
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let (stop, stopped) = oneshot::channel::<()>();
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else { return };
        let _ = axum::serve(listener, server::router(shared))
            .with_graceful_shutdown(async move {
                let _ = stopped.await;
            })
            .await;
    });
    Ok(stop)
}

/// Reopens access the user had left on.
pub fn start(app: AppHandle) {
    if !app.state::<MobileState>().store.snapshot().enabled {
        return;
    }
    thread::spawn(move || {
        let state = app.state::<MobileState>();
        for _ in 0..START_ATTEMPTS {
            {
                let Ok(_switching) = state.switching.lock() else { return };
                if !state.store.snapshot().enabled {
                    return;
                }
                match state.connect() {
                    Ok(()) => return,
                    Err(error) => {
                        if let Ok(mut runtime) = state.runtime() {
                            runtime.error = Some(error);
                        }
                    }
                }
            }
            thread::sleep(START_PAUSE);
        }
    });
}

/// Takes the address down when the app closes; it comes back at the next start.
pub fn shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<MobileState>() else { return };
    // Only what this instance published: another one may be serving on the same port.
    if !local_only() && state.runtime().is_ok_and(|runtime| runtime.server.is_some()) {
        let _ = tailscale::unpublish(state.store.snapshot().port, EXIT_DEADLINE);
    }
}

async fn blocking<T: Send + 'static>(app: AppHandle, action: impl FnOnce(&MobileState) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || action(&app.state::<MobileState>())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mobile_state(app: AppHandle) -> Result<View, String> {
    blocking(app, MobileState::view).await
}

#[tauri::command]
pub async fn mobile_tailscale() -> Result<tailscale::Status, String> {
    tauri::async_runtime::spawn_blocking(tailscale::status).await.map_err(|e| e.to_string())
}

/// A failure to turn access on is reported in the returned view, next to what is missing.
#[tauri::command]
pub async fn mobile_set_enabled(app: AppHandle, enabled: bool) -> Result<View, String> {
    blocking(app, move |state| {
        if enabled { state.enable()? } else { state.disable()? }
        state.view()
    })
    .await
}

#[tauri::command]
pub async fn mobile_pairing_start(app: AppHandle) -> Result<View, String> {
    blocking(app, |state| {
        let url = state.runtime()?.url.clone().ok_or("Ligue o acesso pelo celular primeiro.")?;
        let (code, expires_at) = state.shared.with_auth(|auth| auth.start_pairing(crate::live::now_ms()))??;
        // The code goes in the fragment, which browsers never send to a server or write to its logs.
        state.runtime()?.pairing = Some(Pairing { url: format!("{url}/#pair={code}"), expires_at });
        state.view()
    })
    .await
}

#[tauri::command]
pub async fn mobile_pairing_cancel(app: AppHandle) -> Result<View, String> {
    blocking(app, |state| {
        state.shared.with_auth(Auth::cancel_pairing)?;
        state.view()
    })
    .await
}

#[tauri::command]
pub async fn mobile_pairing_decide(app: AppHandle, request_id: String, allow: bool) -> Result<View, String> {
    blocking(app, move |state| {
        state.shared.with_auth(|auth| auth.decide(&request_id, allow, crate::live::now_ms()))??;
        state.view()
    })
    .await
}

#[tauri::command]
pub async fn mobile_revoke(app: AppHandle, device_id: String) -> Result<View, String> {
    blocking(app, move |state| {
        state.shared.revoke(&device_id)?;
        state.view()
    })
    .await
}

#[tauri::command]
pub async fn mobile_set_control(app: AppHandle, device_id: String, allow: bool) -> Result<View, String> {
    blocking(app, move |state| {
        state.shared.change_devices(|auth| auth.set_control(&device_id, allow))?;
        state.view()
    })
    .await
}

/// The interface reports each session's project and live status, so the phone shows what the desktop shows.
/// Changes in that status are what the phone is notified about.
#[tauri::command]
pub fn mobile_publish(app: AppHandle, state: tauri::State<'_, MobileState>, snapshot: Published) -> Result<(), String> {
    if snapshot.items.len() > 500 {
        return Err("Sessões demais.".into());
    }
    let previous = std::mem::replace(&mut *state.published.lock().map_err(|e| e.to_string())?, snapshot.clone());
    state.announce(&app, &previous, &snapshot);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, agent: &str, folder: &str) -> SessionInfo {
        SessionInfo { id: id.into(), agent: agent.into(), folder: folder.into(), command: "segredo".into(), resume_id: None, pane_id: None, status: "rodando".into(), title: None }
    }

    /// A host with nothing running, counting how often devices are saved.
    #[derive(Default)]
    struct Empty {
        saves: Arc<Mutex<u32>>,
    }

    impl Host for Empty {
        fn overview(&self) -> Overview {
            Overview::default()
        }
        fn asset(&self, _: &str) -> Option<Vec<u8>> {
            None
        }
        fn save_devices(&self, _: &[Device]) -> Result<(), String> {
            *self.saves.lock().unwrap() += 1;
            Ok(())
        }
        fn conversation(&self, _: &str, _: Page) -> Result<Value, String> {
            Ok(Value::Null)
        }
        fn requests(&self, _: &str) -> Result<Vec<PendingPermission>, String> {
            Ok(Vec::new())
        }
        fn send(&self, _: &str, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn interrupt(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn decide(&self, _: &str, _: &str, _: &Decision) -> Result<(), String> {
            Ok(())
        }
        fn record(&self, _: Action) {}
        fn push_key(&self) -> Result<String, String> {
            Ok(String::new())
        }
        fn push_test(&self, _: &Subscription) -> Result<(), String> {
            Ok(())
        }
    }

    fn empty_shared() -> Shared {
        Shared::new(Vec::new(), Box::new(Empty::default()))
    }

    #[test]
    fn cards_list_agents_only_and_hide_paths_and_commands() {
        let published = Published {
            theme: None,
            items: vec![
                PublishedAgent { id: "a".into(), project: Some("Loja".into()), tone: "waiting".into(), label: "Aguardando você".into(), message: "x".repeat(900), since: Some(5), state: "approval".into() },
                PublishedAgent { id: "gone".into(), ..PublishedAgent::default() },
            ],
        };
        let list = cards(vec![session("a", "Claude Code", r"C:\Users\eu\loja\"), session("b", "Codex", "/home/eu/api"), session("c", "Shell", "/tmp")], &published);
        assert_eq!(list.iter().map(|card| (card.id.as_str(), card.folder.as_str(), card.label.as_str())).collect::<Vec<_>>(), vec![("a", "loja", "Aguardando você"), ("b", "api", "Ativo")]);
        assert_eq!(list[0].message.len(), 400);
        let json = serde_json::to_string(&list).unwrap();
        assert!(!json.contains("segredo") && !json.contains("Users"));
    }

    #[test]
    fn last_seen_is_saved_about_once_a_minute_during_constant_use() {
        let host = Empty::default();
        let saves = host.saves.clone();
        let shared = Shared::new(Vec::new(), Box::new(host));
        let now = crate::live::now_ms();
        let (code, _) = shared.with_auth(|auth| auth.start_pairing(now)).unwrap().unwrap();
        let id = shared.with_auth(|auth| auth.claim(&code, "a", now)).unwrap().unwrap().id;
        shared.with_auth(|auth| auth.decide(&id, true, now)).unwrap().unwrap();
        let Outcome::Paired(token) = shared.collect(&id).unwrap() else { panic!("not paired") };
        // Last saved over a minute ago, then asked again and again.
        shared.with_auth(|auth| auth.devices[0].last_seen_at = now - SEEN_SAVE_MS - 1).unwrap();
        *saves.lock().unwrap() = 0;
        for _ in 0..20 {
            assert!(shared.authenticate(&token).is_some());
        }
        // One save, or two if a minute turned over while the loop ran.
        assert!((1..=2).contains(&*saves.lock().unwrap()));
    }

    #[test]
    fn only_the_published_name_and_this_computer_are_accepted() {
        let shared = empty_shared();
        assert!(!shared.is_open());
        shared.open(1234, Some("pc.ts.net".into()));
        for host in ["pc.ts.net", "PC.ts.net:443", "127.0.0.1:1234", "localhost:1234"] {
            assert!(shared.allows_host(host), "{host}");
        }
        for host in ["pc.ts.net:80", "other.ts.net", "127.0.0.1", "127.0.0.1:9", "pc.ts.net.evil.com"] {
            assert!(!shared.allows_host(host), "{host}");
        }
        assert!(shared.allows_origin("https://pc.ts.net") && shared.allows_origin("http://127.0.0.1:1234"));
        assert!(!shared.allows_origin("http://pc.ts.net") && !shared.allows_origin("https://evil.com") && !shared.allows_origin("null"));
    }

    #[test]
    fn the_server_listens_on_loopback_and_releases_its_port() {
        use std::io::{Read, Write};
        let port = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap().local_addr().unwrap().port();
        let shared = Arc::new(empty_shared());
        shared.open(port, None);
        let ask = || {
            let mut stream = std::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            write!(stream, "GET /api/agents HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").unwrap();
            let mut answer = String::new();
            stream.read_to_string(&mut answer).unwrap();
            answer
        };
        let stop = serve(shared.clone(), port).unwrap();
        assert!(ask().starts_with("HTTP/1.1 401"));
        let _ = stop.send(());
        // Turning access off and on again must find the port free.
        let stop = serve(shared, port).unwrap();
        assert!(ask().starts_with("HTTP/1.1 401"));
        let _ = stop.send(());
    }

    #[test]
    fn a_broken_config_leaves_access_off_and_changes_are_saved() {
        let path = std::env::temp_dir().join(format!("athenas-mobile-{}.json", uuid::Uuid::new_v4()));
        fs::write(&path, "{ not json").unwrap();
        let store = Store::load(path.clone());
        assert!(!store.snapshot().enabled && store.snapshot().devices.is_empty());
        store.update(|config| config.enabled = true).unwrap();
        assert!(Store::load(path.clone()).snapshot().enabled);
        assert_eq!(Store::load(path.clone()).snapshot().port, DEFAULT_PORT);
        fs::remove_file(path).unwrap();
    }
}
