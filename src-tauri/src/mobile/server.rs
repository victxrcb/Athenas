//! The HTTP server the phone talks to. It listens on the loopback address only; Tailscale is what makes it
//! reachable, over HTTPS, from the user's other devices. Stage 1 is read only: pairing and the agent list.
use super::auth::Outcome;
use super::Shared;
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
use serde_json::json;
use std::sync::Arc;

const COOKIE: &str = "athenas_device";
const COOKIE_AGE: u32 = 365 * 24 * 3600;
const MAX_BODY: usize = 4 * 1024;
const CSP: &str = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; \
                   connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

pub fn router(shared: Arc<Shared>) -> Router {
    Router::new()
        .route("/api/pair", post(pair))
        .route("/api/pair/status", post(pair_status))
        .route("/api/agents", get(agents))
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
    if token(&headers).and_then(|token| shared.authenticate(token)).is_none() {
        return error(StatusCode::UNAUTHORIZED, "Este aparelho não está pareado.");
    }
    // Reading sessions takes locks the terminals also use; keep it off the server's threads.
    let source = shared.clone();
    match tokio::task::spawn_blocking(move || source.overview()).await {
        Ok(overview) => Json(overview).into_response(),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Não foi possível ler os agentes."),
    }
}

async fn logout(State(shared): State<Arc<Shared>>, headers: HeaderMap) -> Response {
    if let Some(device) = token(&headers).and_then(|token| shared.authenticate(token)) {
        if let Err(message) = shared.revoke(&device) {
            return error(StatusCode::INTERNAL_SERVER_ERROR, &message);
        }
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(header::SET_COOKIE, cookie("", 0));
    response
}

/// The phone page, its icons and the built files in `assets/`; never the desktop page.
fn asset_name(path: &str) -> Option<&str> {
    let name = path.strip_prefix('/')?;
    if name.is_empty() || name == "mobile.html" {
        return Some("mobile.html");
    }
    if matches!(name, "manifest.webmanifest" | "favicon.png" | "mobile-icon-192.png" | "mobile-icon-512.png") {
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
        .and_then(|name| Some((name, shared.asset(name)?)));
    let Some((name, bytes)) = found else { return error(StatusCode::NOT_FOUND, "Não encontrado.") };
    // Built file names carry a hash of their content; the page itself must always be fresh.
    let cache = if name.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    ([(header::CONTENT_TYPE, content_type(name)), (header::CACHE_CONTROL, cache)], Body::from(bytes)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mobile::{AgentCard, Overview};
    use tower::ServiceExt;

    const HOST: &str = "pc.example.ts.net";
    const ORIGIN: &str = "https://pc.example.ts.net";

    fn shared() -> Arc<Shared> {
        let shared = Shared::new(
            Vec::new(),
            Box::new(|| Overview { computer: "pc".into(), theme: None, agents: vec![AgentCard { id: "s1".into(), agent: "Codex".into(), ..AgentCard::default() }] }),
            Box::new(|name| (name == "mobile.html" || name == "assets/app-1.js").then(|| name.as_bytes().to_vec())),
            Box::new(|_| Ok(())),
        );
        shared.open(47821, Some(HOST.into()));
        Arc::new(shared)
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

    #[tokio::test]
    async fn pairing_gives_a_cookie_that_reads_agents_until_logout() {
        let shared = shared();
        assert_eq!(call(&shared, get_request("/api/agents", None)).await.0, StatusCode::UNAUTHORIZED);
        let (code, _) = shared.with_auth(|auth| auth.start_pairing(crate::live::now_ms())).unwrap().unwrap();
        let (status, _, body) = call(&shared, post_request("/api/pair", ORIGIN, json!({ "code": code, "name": "Redmi" }), None)).await;
        assert_eq!(status, StatusCode::OK);
        let id = serde_json::from_str::<serde_json::Value>(&body).unwrap()["requestId"].as_str().unwrap().to_string();
        let waiting = call(&shared, post_request("/api/pair/status", ORIGIN, json!({ "requestId": id }), None)).await;
        assert!(waiting.2.contains("waiting") && waiting.1.get(header::SET_COOKIE).is_none());
        shared.with_auth(|auth| auth.decide(&id, true, crate::live::now_ms())).unwrap().unwrap();
        let (_, headers, body) = call(&shared, post_request("/api/pair/status", ORIGIN, json!({ "requestId": id }), None)).await;
        assert!(body.contains("paired"));
        let set = headers[header::SET_COOKIE].to_str().unwrap();
        assert!(["HttpOnly", "Secure", "SameSite=Strict"].iter().all(|flag| set.contains(flag)));
        let cookie = set.split(';').next().unwrap().to_string();

        let (status, headers, body) = call(&shared, get_request("/api/agents", Some(&format!("a=1; {cookie}")))).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"s1\""));
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");

        assert_eq!(call(&shared, post_request("/api/logout", ORIGIN, json!({}), Some(&cookie))).await.0, StatusCode::NO_CONTENT);
        assert_eq!(call(&shared, get_request("/api/agents", Some(&cookie))).await.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn other_names_other_sites_and_a_closed_server_are_refused() {
        let shared = shared();
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
        let shared = shared();
        let (status, headers, body) = call(&shared, get_request("/", None)).await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, "mobile.html"));
        assert_eq!(headers[header::CONTENT_SECURITY_POLICY], CSP);
        let script = call(&shared, get_request("/assets/app-1.js", None)).await;
        assert!(script.1[header::CACHE_CONTROL].to_str().unwrap().contains("immutable"));
        for path in ["/index.html", "/assets/../index.html", "/assets/%2e%2e/index.html", "/assets/sub/x.js", "/assets/missing.js"] {
            assert_eq!(call(&shared, get_request(path, None)).await.0, StatusCode::NOT_FOUND, "{path}");
        }
    }
}
