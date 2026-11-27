//! The HTTP server the phone talks to. It listens on the loopback address only; Tailscale is what makes it
//! reachable, over HTTPS, from the user's other devices. Every action is a specific one: there is no way to
//! write freely into a terminal.
use super::{
    auth::Outcome,
    control::{self, Access, Page, Refusal},
    push::{self, Subscription},
    Shared,
};
use crate::live::Decision;
use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use std::sync::Arc;

const COOKIE: &str = "athenas_device";
const COOKIE_AGE: u32 = 365 * 24 * 3600;
const MAX_BODY: usize = 4 * 1024;
/// A message of the largest accepted size, even if every character needs escaping.
const MAX_MESSAGE_BODY: usize = 256 * 1024;
/// Answers to several questions at once.
const MAX_DECISION_BODY: usize = 64 * 1024;
const CSP: &str = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; \
                   connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

pub fn router(shared: Arc<Shared>) -> Router {
    Router::new()
        .route("/api/pair", post(pair))
        .route("/api/pair/status", post(pair_status))
        .route("/api/agents", get(agents))
        .route("/api/conversation", post(conversation))
        .route("/api/send", post(send).layer(DefaultBodyLimit::max(MAX_MESSAGE_BODY)))
        .route("/api/interrupt", post(interrupt))
        .route("/api/decide", post(decide).layer(DefaultBodyLimit::max(MAX_DECISION_BODY)))
        .route("/api/push/key", get(push_key))
        .route("/api/push/subscribe", post(push_subscribe))
        .route("/api/push/unsubscribe", post(push_unsubscribe))
        .route("/api/push/test", post(push_test))
        .route("/api/logout", post(logout))
        .fallback(asset)
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .layer(middleware::from_fn_with_state(shared.clone(), guard))
        .with_state(shared)
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

fn text<'a>(headers: &'a HeaderMap, name: header::HeaderName) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

/// Refuses requests addressed to another name (DNS rebinding) or sent by another site, then adds the
/// security headers every answer carries.
async fn guard(State(shared): State<Arc<Shared>>, request: Request, next: Next) -> Response {
    if !shared.is_open() {
        return error(StatusCode::SERVICE_UNAVAILABLE, "O acesso pelo celular está desligado.");
    }
    let headers = request.headers();
    if !text(headers, header::HOST).is_some_and(|host| shared.allows_host(host)) {
        return error(StatusCode::MISDIRECTED_REQUEST, "Endereço não reconhecido.");
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        if !text(headers, header::ORIGIN).is_some_and(|origin| shared.allows_origin(origin)) {
            return error(StatusCode::FORBIDDEN, "Origem não permitida.");
        }
    }
    let api = request.uri().path().starts_with("/api/");
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    for (name, value) in [
        (header::CONTENT_SECURITY_POLICY, CSP),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::REFERRER_POLICY, "no-referrer"),
        (header::X_FRAME_OPTIONS, "DENY"),
    ] {
        headers.insert(name, HeaderValue::from_static(value));
    }
    if api {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

/// Only JSON bodies are read, so a plain form on another page cannot produce one.
fn json_body<T: DeserializeOwned>(headers: &HeaderMap, body: &Bytes) -> Result<T, Response> {
    if !text(headers, header::CONTENT_TYPE).is_some_and(|kind| kind.starts_with("application/json")) {
        return Err(error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Envie JSON."));
    }
    serde_json::from_slice(body).map_err(|_| error(StatusCode::BAD_REQUEST, "Pedido inválido."))
}

fn cookie(token: &str, age: u32) -> HeaderValue {
    HeaderValue::from_str(&format!("{COOKIE}={token}; Path=/; Max-Age={age}; HttpOnly; Secure; SameSite=Strict"))
        .unwrap_or_else(|_| HeaderValue::from_static(""))
}

fn token(headers: &HeaderMap) -> Option<&str> {
    headers.get_all(header::COOKIE).iter().filter_map(|value| value.to_str().ok()).flat_map(|value| value.split(';')).find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        (name == COOKIE && !value.is_empty()).then_some(value)
    })
}

/// The paired device making the request.
fn device(shared: &Shared, headers: &HeaderMap) -> Result<Access, Response> {
    token(headers).and_then(|token| shared.authenticate(token)).ok_or_else(|| error(StatusCode::UNAUTHORIZED, "Este aparelho não está pareado."))
}

/// Work that takes locks the terminals also use, or waits on them, stays off the server's threads.
async fn blocking(action: impl FnOnce() -> Result<Value, Refusal> + Send + 'static) -> Response {
    match tokio::task::spawn_blocking(action).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(refusal)) => error(StatusCode::from_u16(refusal.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), &refusal.message),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "O pedido falhou no computador."),
    }
}

/// Authenticates, reads the JSON body and runs the action for that device.
async fn act<T: DeserializeOwned + Send + 'static>(
    shared: Arc<Shared>,
    headers: HeaderMap,
    body: Bytes,
    action: impl FnOnce(&Shared, &Access, T) -> Result<Value, Refusal> + Send + 'static,
) -> Response {
    let access = match device(&shared, &headers) {
        Ok(access) => access,
        Err(response) => return response,
    };
    let input: T = match json_body(&headers, &body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    blocking(move || action(&shared, &access, input)).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PairBody {
    code: String,
    name: String,
}

async fn pair(State(shared): State<Arc<Shared>>, headers: HeaderMap, body: Bytes) -> Response {
    let body: PairBody = match json_body(&headers, &body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    match shared.with_auth(|auth| auth.claim(&body.code, &body.name, crate::live::now_ms())) {
        Ok(Ok(request)) => Json(json!({ "requestId": request.id, "verification": request.verification })).into_response(),
        Ok(Err(message)) | Err(message) => error(StatusCode::FORBIDDEN, &message),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatusBody {
    request_id: String,
}

/// A POST so the request id never appears in an address.
async fn pair_status(State(shared): State<Arc<Shared>>, headers: HeaderMap, body: Bytes) -> Response {
    let body: StatusBody = match json_body(&headers, &body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    match shared.collect(&body.request_id) {
        Ok(Outcome::Waiting) => Json(json!({ "status": "waiting" })).into_response(),
        Ok(Outcome::Denied) => Json(json!({ "status": "denied" })).into_response(),
        Ok(Outcome::Expired) => Json(json!({ "status": "expired" })).into_response(),
        Ok(Outcome::Paired(token)) => {
            let mut response = Json(json!({ "status": "paired" })).into_response();
            response.headers_mut().insert(header::SET_COOKIE, cookie(&token, COOKIE_AGE));
            response
        }
        Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
}

async fn agents(State(shared): State<Arc<Shared>>, headers: HeaderMap) -> Response {
    let access = match device(&shared, &headers) {
        Ok(access) => access,
        Err(response) => return response,
    };
    blocking(move || {
        let mut overview = shared.host.overview();
        overview.can_control = access.control;
        overview.notifications = shared.subscription(&access.id).is_some();
        serde_json::to_value(overview).map_err(|failure| Refusal { status: 500, message: failure.to_string() })
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConversationBody {
    session_id: String,
    from: Option<u64>,
    before: Option<u64>,
    source: Option<String>,
}

/// A POST so that nothing about the conversation appears in an address.
async fn conversation(State(shared): State<Arc<Shared>>, headers: HeaderMap, body: Bytes) -> Response {
    act(shared, headers, body, |shared, access, body: ConversationBody| {
        control::conversation(shared, access, &body.session_id, Page { from: body.from, before: body.before, source: body.source })
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SendBody {
    session_id: String,
    message_id: String,
    text: String,
}

async fn send(State(shared): State<Arc<Shared>>, headers: HeaderMap, body: Bytes) -> Response {
    act(shared, headers, body, |shared, access, body: SendBody| {
        control::send(shared, access, &body.session_id, &body.message_id, &body.text).map(|()| json!({}))
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionBody {
    session_id: String,
}

async fn interrupt(State(shared): State<Arc<Shared>>, headers: HeaderMap, body: Bytes) -> Response {
    act(shared, headers, body, |shared, access, body: SessionBody| control::interrupt(shared, access, &body.session_id).map(|()| json!({}))).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DecideBody {
    session_id: String,
    request_id: String,
    decision: Decision,
}

async fn decide(State(shared): State<Arc<Shared>>, headers: HeaderMap, body: Bytes) -> Response {
    act(shared, headers, body, |shared, access, body: DecideBody| {
        control::decide(shared, access, &body.session_id, &body.request_id, &body.decision).map(|()| json!({}))
    })
    .await
}

fn failure(message: String) -> Refusal {
    Refusal { status: 500, message }
}

async fn push_key(State(shared): State<Arc<Shared>>, headers: HeaderMap) -> Response {
    if let Err(response) = device(&shared, &headers) {
        return response;
    }
    blocking(move || shared.host.push_key().map(|key| json!({ "publicKey": key })).map_err(failure)).await
}

/// Notifications carry only what the list of agents already shows, so any paired device may ask for them.
async fn push_subscribe(State(shared): State<Arc<Shared>>, headers: HeaderMap, body: Bytes) -> Response {
    act(shared, headers, body, |shared, access, subscription: Subscription| {
        push::validate(&subscription).map_err(|message| Refusal { status: 400, message })?;
        shared.change_devices(|auth| auth.set_push(&access.id, Some(subscription))).map_err(failure)?;
        Ok(json!({}))
    })
    .await
}

#[derive(Deserialize)]
struct Empty {}

async fn push_unsubscribe(State(shared): State<Arc<Shared>>, headers: HeaderMap, body: Bytes) -> Response {
    act(shared, headers, body, |shared, access, _: Empty| {
        shared.change_devices(|auth| auth.set_push(&access.id, None)).map_err(failure)?;
        Ok(json!({}))
    })
    .await
}

async fn push_test(State(shared): State<Arc<Shared>>, headers: HeaderMap, body: Bytes) -> Response {
    act(shared, headers, body, |shared, access, _: Empty| {
        let Some(subscription) = shared.subscription(&access.id) else {
            return Err(Refusal { status: 409, message: "As notificações não estão ligadas neste aparelho.".into() });
        };
        shared.host.push_test(&subscription).map_err(|message| Refusal { status: 502, message })?;
        Ok(json!({}))
    })
    .await
}

async fn logout(State(shared): State<Arc<Shared>>, headers: HeaderMap) -> Response {
    if let Ok(access) = device(&shared, &headers) {
        if let Err(message) = shared.revoke(&access.id) {
            return error(StatusCode::INTERNAL_SERVER_ERROR, &message);
        }
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(header::SET_COOKIE, cookie("", 0));
    response
}

/// The phone page, its icons, its service worker and the built files in `assets/`; never the desktop page.
fn asset_name(path: &str) -> Option<&str> {
    let name = path.strip_prefix('/')?;
    if name.is_empty() || name == "mobile.html" {
        return Some("mobile.html");
    }
    if matches!(name, "manifest.webmanifest" | "sw.js" | "favicon.png" | "mobile-icon-192.png" | "mobile-icon-512.png" | "mobile-badge.png") {
        return Some(name);
    }
    let file = name.strip_prefix("assets/")?;
    let plain = !file.is_empty() && !file.starts_with('.') && file.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    plain.then_some(name)
}

fn content_type(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or_default() {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "webmanifest" => "application/manifest+json",
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        _ => "application/octet-stream",
    }
}

async fn asset(State(shared): State<Arc<Shared>>, method: Method, uri: axum::http::Uri) -> Response {
    let found = (method == Method::GET || method == Method::HEAD)
        .then(|| asset_name(uri.path()))
        .flatten()
        .and_then(|name| Some((name, shared.host.asset(name)?)));
    let Some((name, bytes)) = found else { return error(StatusCode::NOT_FOUND, "Não encontrado.") };
    // Built file names carry a hash of their content; the page itself must always be fresh.
    let cache = if name.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    ([(header::CONTENT_TYPE, content_type(name)), (header::CACHE_CONTROL, cache)], Body::from(bytes)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live::PendingPermission;
    use crate::mobile::{control::Action, control::Kind, AgentCard, Device, Host, Overview};
    use std::sync::Mutex;
    use tower::ServiceExt;

    const HOST: &str = "pc.example.ts.net";
    const ORIGIN: &str = "https://pc.example.ts.net";

    /// What the fake desktop holds and what the server asked of it.
    #[derive(Default)]
    struct Desktop {
        state: String,
        requests: Vec<PendingPermission>,
        calls: Vec<String>,
        actions: Vec<(Kind, String)>,
        send_error: Option<String>,
    }

    struct Fake(Arc<Mutex<Desktop>>);

    impl Host for Fake {
        fn overview(&self) -> Overview {
            let state = self.0.lock().unwrap().state.clone();
            Overview { computer: "pc".into(), agents: vec![AgentCard { id: "s1".into(), agent: "Codex".into(), state, ..AgentCard::default() }], ..Overview::default() }
        }
        fn asset(&self, name: &str) -> Option<Vec<u8>> {
            matches!(name, "mobile.html" | "sw.js" | "assets/app-1.js").then(|| name.as_bytes().to_vec())
        }
        fn save_devices(&self, _: &[Device]) -> Result<(), String> {
            Ok(())
        }
        fn conversation(&self, session: &str, page: Page) -> Result<Value, String> {
            Ok(json!({ "session": session, "from": page.from, "lines": [] }))
        }
        fn requests(&self, session: &str) -> Result<Vec<PendingPermission>, String> {
            Ok(self.0.lock().unwrap().requests.iter().filter(|request| request.session_id == session).cloned().collect())
        }
        fn send(&self, session: &str, text: &str) -> Result<(), String> {
            let mut desktop = self.0.lock().unwrap();
            if let Some(error) = desktop.send_error.take() {
                return Err(error);
            }
            desktop.calls.push(format!("send {session} {text}"));
            Ok(())
        }
        fn interrupt(&self, session: &str) -> Result<(), String> {
            self.0.lock().unwrap().calls.push(format!("interrupt {session}"));
            Ok(())
        }
        fn decide(&self, session: &str, request: &str, decision: &Decision) -> Result<(), String> {
            self.0.lock().unwrap().calls.push(format!("decide {session} {request} {}", decision.behavior));
            Ok(())
        }
        fn record(&self, action: Action) {
            self.0.lock().unwrap().actions.push((action.kind, action.detail));
        }
        fn push_key(&self) -> Result<String, String> {
            Ok("chave".into())
        }
        fn push_test(&self, subscription: &Subscription) -> Result<(), String> {
            self.0.lock().unwrap().calls.push(format!("test {}", subscription.endpoint));
            Ok(())
        }
    }

    fn setup() -> (Arc<Shared>, Arc<Mutex<Desktop>>) {
        let desktop = Arc::new(Mutex::new(Desktop::default()));
        let shared = Shared::new(Vec::new(), Box::new(Fake(desktop.clone())));
        shared.open(47821, Some(HOST.into()));
        (Arc::new(shared), desktop)
    }

    async fn call(shared: &Arc<Shared>, request: axum::http::Request<Body>) -> (StatusCode, HeaderMap, String) {
        let response = router(shared.clone()).oneshot(request).await.unwrap();
        let (parts, body) = response.into_parts();
        let bytes = axum::body::to_bytes(body, 1 << 20).await.unwrap();
        (parts.status, parts.headers, String::from_utf8_lossy(&bytes).into_owned())
    }

    fn get_request(path: &str, cookie: Option<&str>) -> axum::http::Request<Body> {
        let mut builder = axum::http::Request::builder().uri(path).header(header::HOST, HOST);
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        builder.body(Body::empty()).unwrap()
    }

    fn post_request(path: &str, origin: &str, body: serde_json::Value, cookie: Option<&str>) -> axum::http::Request<Body> {
        let mut builder = axum::http::Request::builder().method("POST").uri(path)
            .header(header::HOST, HOST).header(header::ORIGIN, origin).header(header::CONTENT_TYPE, "application/json");
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        builder.body(Body::from(body.to_string())).unwrap()
    }

    /// Pairs a device and returns its cookie.
    async fn pair_device(shared: &Arc<Shared>) -> String {
        let (code, _) = shared.with_auth(|auth| auth.start_pairing(crate::live::now_ms())).unwrap().unwrap();
        let (status, _, body) = call(shared, post_request("/api/pair", ORIGIN, json!({ "code": code, "name": "Redmi" }), None)).await;
        assert_eq!(status, StatusCode::OK);
        let id = serde_json::from_str::<serde_json::Value>(&body).unwrap()["requestId"].as_str().unwrap().to_string();
        let waiting = call(shared, post_request("/api/pair/status", ORIGIN, json!({ "requestId": id }), None)).await;
        assert!(waiting.2.contains("waiting") && waiting.1.get(header::SET_COOKIE).is_none());
        shared.with_auth(|auth| auth.decide(&id, true, crate::live::now_ms())).unwrap().unwrap();
        let (_, headers, body) = call(shared, post_request("/api/pair/status", ORIGIN, json!({ "requestId": id }), None)).await;
        assert!(body.contains("paired"));
        let set = headers[header::SET_COOKIE].to_str().unwrap();
        assert!(["HttpOnly", "Secure", "SameSite=Strict"].iter().all(|flag| set.contains(flag)));
        set.split(';').next().unwrap().to_string()
    }

    fn allow_control(shared: &Arc<Shared>) {
        let id = shared.with_auth(|auth| auth.devices[0].id.clone()).unwrap();
        shared.change_devices(|auth| auth.set_control(&id, true)).unwrap();
    }

    fn permission(id: &str, session: &str) -> PendingPermission {
        PendingPermission { id: id.into(), session_id: session.into(), tool_name: "Bash".into(), tool_input: json!({ "command": "npm test" }), suggestions: json!([]), agent_id: None, created_at: 0 }
    }

    async fn post_json(shared: &Arc<Shared>, cookie: &str, path: &str, body: serde_json::Value) -> (StatusCode, String) {
        let (status, _, text) = call(shared, post_request(path, ORIGIN, body, Some(cookie))).await;
        (status, text)
    }

    #[tokio::test]
    async fn pairing_gives_a_cookie_that_reads_agents_until_logout() {
        let (shared, _) = setup();
        assert_eq!(call(&shared, get_request("/api/agents", None)).await.0, StatusCode::UNAUTHORIZED);
        let cookie = pair_device(&shared).await;
        let (status, headers, body) = call(&shared, get_request("/api/agents", Some(&format!("a=1; {cookie}")))).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"s1\"") && body.contains("\"canControl\":false"));
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert_eq!(call(&shared, post_request("/api/logout", ORIGIN, json!({}), Some(&cookie))).await.0, StatusCode::NO_CONTENT);
        assert_eq!(call(&shared, get_request("/api/agents", Some(&cookie))).await.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_device_without_permission_can_only_list() {
        let (shared, desktop) = setup();
        desktop.lock().unwrap().state = "working".into();
        let cookie = pair_device(&shared).await;
        for (path, body) in [
            ("/api/conversation", json!({ "sessionId": "s1" })),
            ("/api/send", json!({ "sessionId": "s1", "messageId": "m", "text": "oi" })),
            ("/api/interrupt", json!({ "sessionId": "s1" })),
            ("/api/decide", json!({ "sessionId": "s1", "requestId": "r", "decision": { "behavior": "allow" } })),
        ] {
            assert_eq!(post_json(&shared, &cookie, path, body.clone()).await.0, StatusCode::FORBIDDEN, "{path}");
            assert_eq!(call(&shared, post_request(path, ORIGIN, body.clone(), None)).await.0, StatusCode::UNAUTHORIZED, "{path}");
            assert_eq!(call(&shared, post_request(path, "https://evil.example", body, Some(&cookie))).await.0, StatusCode::FORBIDDEN, "{path}");
        }
        assert!(desktop.lock().unwrap().calls.is_empty());
        allow_control(&shared);
        let (status, body) = post_json(&shared, &cookie, "/api/conversation", json!({ "sessionId": "s1", "from": 7 })).await;
        assert!(status == StatusCode::OK && body.contains("\"from\":7") && body.contains("\"requests\":[]"));
        assert_eq!(post_json(&shared, &cookie, "/api/conversation", json!({ "sessionId": "outra" })).await.0, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn a_message_is_typed_once_and_never_into_a_question_or_as_a_command() {
        let (shared, desktop) = setup();
        let cookie = pair_device(&shared).await;
        allow_control(&shared);
        let send = |id: &str, text: &str| json!({ "sessionId": "s1", "messageId": id, "text": text });
        assert_eq!(post_json(&shared, &cookie, "/api/send", send("1", "  rode os testes \n")).await.0, StatusCode::OK);
        // The same message retried is accepted without being typed again.
        assert_eq!(post_json(&shared, &cookie, "/api/send", send("1", "rode os testes")).await.0, StatusCode::OK);
        // Characters that would be dropped before typing must not hide a command from the check.
        for text in ["!rm -rf .", "  ! whoami", "/permissions", "\n/clear", "   ", "\u{1b}!whoami", "\u{0}\u{7}/clear", "\u{feff}!whoami", "\u{200b} \u{2060}!whoami", "\r\n!whoami", "\u{200b}"] {
            assert_eq!(post_json(&shared, &cookie, "/api/send", send("2", text)).await.0, StatusCode::BAD_REQUEST, "{text:?}");
        }
        desktop.lock().unwrap().state = "approval".into();
        assert_eq!(post_json(&shared, &cookie, "/api/send", send("3", "sim")).await.0, StatusCode::CONFLICT);
        {
            let mut desktop = desktop.lock().unwrap();
            desktop.state = "working".into();
            desktop.requests = vec![permission("r1", "s1")];
        }
        assert_eq!(post_json(&shared, &cookie, "/api/send", send("3", "sim")).await.0, StatusCode::CONFLICT);
        {
            let mut desktop = desktop.lock().unwrap();
            desktop.requests.clear();
            desktop.send_error = Some("NOT_READY".into());
        }
        let (status, body) = post_json(&shared, &cookie, "/api/send", send("3", "sim")).await;
        assert!(status == StatusCode::CONFLICT && body.contains("pelo computador"));
        // A refused message may be sent again.
        assert_eq!(post_json(&shared, &cookie, "/api/send", send("3", "sim")).await.0, StatusCode::OK);
        // Control characters never reach the terminal.
        assert_eq!(post_json(&shared, &cookie, "/api/send", send("5", "a\u{1b}[201~b")).await.0, StatusCode::OK);
        assert_eq!(desktop.lock().unwrap().calls.pop().unwrap(), "send s1 a[201~b");
        let long = "a".repeat(50_000);
        assert_eq!(post_json(&shared, &cookie, "/api/send", send("4", &long)).await.0, StatusCode::OK);
        let desktop = desktop.lock().unwrap();
        assert_eq!(desktop.calls[..2], ["send s1 rode os testes".to_string(), "send s1 sim".to_string()]);
        assert_eq!(desktop.calls.len(), 3);
        assert_eq!(desktop.actions.iter().filter(|(kind, _)| *kind == Kind::Sent).count(), 4);
    }

    #[tokio::test]
    async fn approvals_answer_only_a_waiting_request_without_widening_rules() {
        let (shared, desktop) = setup();
        let cookie = pair_device(&shared).await;
        allow_control(&shared);
        desktop.lock().unwrap().requests = vec![permission("r1", "s1"), permission("r2", "outra")];
        let decide = |request: &str, behavior: &str| json!({ "sessionId": "s1", "requestId": request, "decision": { "behavior": behavior } });
        assert_eq!(post_json(&shared, &cookie, "/api/decide", decide("r1", "always")).await.0, StatusCode::BAD_REQUEST);
        // Another session's request cannot be answered through this one.
        assert_eq!(post_json(&shared, &cookie, "/api/decide", decide("r2", "allow")).await.0, StatusCode::CONFLICT);
        assert_eq!(post_json(&shared, &cookie, "/api/decide", decide("r1", "allow")).await.0, StatusCode::OK);
        let desktop = desktop.lock().unwrap();
        assert_eq!(desktop.calls, ["decide s1 r1 allow"]);
        assert_eq!(desktop.actions, [(Kind::Allowed, "Bash: npm test".to_string())]);
    }

    #[tokio::test]
    async fn interrupting_needs_a_working_agent_and_is_not_repeated() {
        let (shared, desktop) = setup();
        let cookie = pair_device(&shared).await;
        allow_control(&shared);
        let body = json!({ "sessionId": "s1" });
        desktop.lock().unwrap().state = "done".into();
        assert_eq!(post_json(&shared, &cookie, "/api/interrupt", body.clone()).await.0, StatusCode::CONFLICT);
        desktop.lock().unwrap().state = "working".into();
        assert_eq!(post_json(&shared, &cookie, "/api/interrupt", body.clone()).await.0, StatusCode::OK);
        assert_eq!(post_json(&shared, &cookie, "/api/interrupt", body).await.0, StatusCode::CONFLICT);
        assert_eq!(desktop.lock().unwrap().calls, ["interrupt s1"]);
    }

    #[tokio::test]
    async fn notifications_are_registered_only_with_real_push_services() {
        let (shared, desktop) = setup();
        let cookie = pair_device(&shared).await;
        assert!(call(&shared, get_request("/api/push/key", Some(&cookie))).await.2.contains("chave"));
        assert_eq!(call(&shared, get_request("/api/push/key", None)).await.0, StatusCode::UNAUTHORIZED);
        assert_eq!(post_json(&shared, &cookie, "/api/push/test", json!({})).await.0, StatusCode::CONFLICT);
        let subscription = |endpoint: &str| json!({ "endpoint": endpoint, "p256dh": "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", "auth": "BTBZMqHH6r4Tts7J_aSIgg" });
        assert_eq!(post_json(&shared, &cookie, "/api/push/subscribe", subscription("https://127.0.0.1/x")).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(post_json(&shared, &cookie, "/api/push/subscribe", subscription("https://fcm.googleapis.com/x")).await.0, StatusCode::OK);
        assert!(call(&shared, get_request("/api/agents", Some(&cookie))).await.2.contains("\"notifications\":true"));
        assert_eq!(post_json(&shared, &cookie, "/api/push/test", json!({})).await.0, StatusCode::OK);
        assert_eq!(post_json(&shared, &cookie, "/api/push/unsubscribe", json!({})).await.0, StatusCode::OK);
        assert!(shared.subscriptions().is_empty());
        assert_eq!(desktop.lock().unwrap().calls, ["test https://fcm.googleapis.com/x"]);
    }

    #[tokio::test]
    async fn other_names_other_sites_and_a_closed_server_are_refused() {
        let (shared, _) = setup();
        let rebound = axum::http::Request::builder().uri("/").header(header::HOST, "evil.example").body(Body::empty()).unwrap();
        assert_eq!(call(&shared, rebound).await.0, StatusCode::MISDIRECTED_REQUEST);
        let local = axum::http::Request::builder().uri("/").header(header::HOST, "127.0.0.1:47821").body(Body::empty()).unwrap();
        assert_eq!(call(&shared, local).await.0, StatusCode::OK);
        let foreign = post_request("/api/pair", "https://evil.example", json!({ "code": "x", "name": "y" }), None);
        assert_eq!(call(&shared, foreign).await.0, StatusCode::FORBIDDEN);
        let mut form = post_request("/api/pair", ORIGIN, json!({ "code": "x", "name": "y" }), None);
        form.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
        assert_eq!(call(&shared, form).await.0, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        let huge = post_request("/api/pair", ORIGIN, json!({ "code": "x".repeat(MAX_BODY), "name": "y" }), None);
        assert_eq!(call(&shared, huge).await.0, StatusCode::PAYLOAD_TOO_LARGE);
        shared.close();
        assert_eq!(call(&shared, get_request("/", None)).await.0, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn only_the_phone_page_files_are_served() {
        let (shared, _) = setup();
        let (status, headers, body) = call(&shared, get_request("/", None)).await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, "mobile.html"));
        assert_eq!(headers[header::CONTENT_SECURITY_POLICY], CSP);
        let script = call(&shared, get_request("/assets/app-1.js", None)).await;
        assert!(script.1[header::CACHE_CONTROL].to_str().unwrap().contains("immutable"));
        let worker = call(&shared, get_request("/sw.js", None)).await;
        assert_eq!((worker.0, worker.1[header::CACHE_CONTROL].to_str().unwrap()), (StatusCode::OK, "no-cache"));
        for path in ["/index.html", "/assets/../index.html", "/assets/%2e%2e/index.html", "/assets/sub/x.js", "/assets/missing.js"] {
            assert_eq!(call(&shared, get_request(path, None)).await.0, StatusCode::NOT_FOUND, "{path}");
        }
    }
}
