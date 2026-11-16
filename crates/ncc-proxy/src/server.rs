//! The HTTP server the content WebView loads.
//!
//! Every request carries the service in the `Host` header, so the service is part of
//! the origin exactly as it is under `ncc://`. Requests are resolved, matched to an
//! endpoint, fetched and rewritten back into the same namespace.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::Router;
use url::Url;

use ncc_core::{
    http_origin, join_paths, parse_ncc_address, select_transport_endpoints, upstream_headers,
    Endpoint,
};

use ncc_identity::IdentityStore;

use crate::approvals::Approvals;
use crate::inject::{inject_into_html, relax_csp, Injection, TokenStore, MAX_INJECTION_BYTES};
use crate::nsite::{Blobs, NsiteResolver};
use crate::pins::{pinned_tls_config, PinStore};
use crate::resolve::{ResolveError, ResolvedService, Resolver};
use crate::vhost::{parse_vhost, Vhost};

/// Headers that describe one hop and must not be forwarded either way.
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

#[derive(Debug, Clone)]
pub struct ProxyConfig {
    pub relays: Vec<String>,
    pub request_timeout: Duration,
    pub max_body_bytes: usize,
    /// Origins allowed to read responses with CORS. The shell's own webview is the
    /// only one that needs it (a page fetching a vhost from its own origin does not).
    pub allowed_origins: Vec<String>,
    /// Where verified site blobs survive a restart; `None` keeps them in memory only.
    pub blob_directory: Option<std::path::PathBuf>,
    /// Persisted settings. When absent, an in-memory store is built from `relays`.
    pub settings: Option<Arc<crate::settings::SettingsStore>>,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            relays: Vec::new(),
            request_timeout: Duration::from_secs(20),
            max_body_bytes: 10 * 1024 * 1024,
            allowed_origins: Vec::new(),
            blob_directory: None,
            settings: None,
        }
    }
}

pub struct ProxyState {
    resolver: Resolver,
    client: reqwest::Client,
    pinned_client: reqwest::Client,
    pins: Arc<PinStore>,
    pub(crate) tokens: TokenStore,
    max_body_bytes: usize,
    allowed_origins: Vec<String>,
    identity: Option<Arc<IdentityStore>>,
    approvals: Option<Arc<Approvals>>,
    trusted: Mutex<HashSet<String>>,
    nsite: NsiteResolver,
    blobs: Blobs,
    settings: Arc<crate::settings::SettingsStore>,
}

impl ProxyState {
    pub fn new(config: &ProxyConfig) -> Self {
        let settings = config.settings.clone().unwrap_or_else(|| {
            Arc::new(crate::settings::SettingsStore::in_memory(
                crate::settings::Settings {
                    relays: config.relays.clone(),
                    ..Default::default()
                },
            ))
        });
        let pins = Arc::new(PinStore::new());

        let build = |client: reqwest::ClientBuilder| {
            client
                .redirect(reqwest::redirect::Policy::none())
                .timeout(config.request_timeout)
                .user_agent(concat!("NostrNavigator/", env!("CARGO_PKG_VERSION")))
                .build()
                .expect("HTTP client")
        };

        let client = build(reqwest::Client::builder());

        // Endpoints that publish `k` present a self-signed certificate; ordinary PKI
        // verification would reject them, and accepting everything would be worse.
        let pinned_client = match pinned_tls_config(pins.clone()) {
            Ok(tls) => build(reqwest::Client::builder().use_preconfigured_tls(tls)),
            Err(error) => {
                tracing::error!(target: "ncc_proxy::pins", "could not build the pinned TLS client: {error}");
                client.clone()
            }
        };

        Self {
            resolver: Resolver::new(settings.clone()),
            client,
            pinned_client,
            pins,
            tokens: TokenStore::new(),
            max_body_bytes: config.max_body_bytes,
            allowed_origins: config.allowed_origins.clone(),
            identity: None,
            approvals: None,
            trusted: Mutex::new(HashSet::new()),
            nsite: NsiteResolver::new(settings.clone()),
            settings,
            blobs: Blobs::new(config.request_timeout, config.blob_directory.clone()),
        }
    }

    /// Attach a signer. Without this, the NIP-07 routes answer 501.
    pub fn with_signer(mut self, identity: Arc<IdentityStore>, approvals: Arc<Approvals>) -> Self {
        self.identity = Some(identity);
        self.approvals = Some(approvals);
        self
    }

    pub fn identity(&self) -> Option<&IdentityStore> {
        self.identity.as_deref()
    }

    pub fn approvals(&self) -> Option<&Approvals> {
        self.approvals.as_deref()
    }

    pub fn nsite(&self) -> &NsiteResolver {
        &self.nsite
    }

    pub fn blobs(&self) -> &Blobs {
        &self.blobs
    }

    pub fn settings(&self) -> &Arc<crate::settings::SettingsStore> {
        &self.settings
    }

    /// Services the user chose to stop asking about for this session.
    pub fn is_trusted(&self, key: &str) -> bool {
        self.trusted.lock().expect("trust lock").contains(key)
    }

    /// Services the user stopped being asked about, for the permissions screen.
    pub fn trusted_keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self
            .trusted
            .lock()
            .expect("trust lock")
            .iter()
            .cloned()
            .collect();
        keys.sort();
        keys
    }

    pub fn untrust(&self, key: &str) {
        self.trusted.lock().expect("trust lock").remove(key);
    }

    pub fn trust(&self, key: &str) {
        self.trusted
            .lock()
            .expect("trust lock")
            .insert(key.to_string());
    }

    pub fn resolver(&self) -> &Resolver {
        &self.resolver
    }

    pub fn pins(&self) -> &PinStore {
        &self.pins
    }
}

pub fn app(state: Arc<ProxyState>) -> Router {
    Router::new().fallback(handle).with_state(state)
}

pub async fn serve(
    listener: tokio::net::TcpListener,
    state: Arc<ProxyState>,
) -> std::io::Result<()> {
    axum::serve(listener, app(state)).await
}

/// Adds CORS only for origins the shell registered, so a random web page cannot read
/// NCC content through the loopback proxy.
async fn handle(State(state): State<Arc<ProxyState>>, request: Request) -> Response {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let mut response = handle_inner(&state, request).await;

    if let Some(origin) = origin {
        if state
            .allowed_origins
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(&origin))
        {
            if let Ok(value) = HeaderValue::from_str(&origin) {
                response
                    .headers_mut()
                    .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
                response
                    .headers_mut()
                    .insert(header::VARY, HeaderValue::from_static("origin"));
            }
        }
    }

    response
}

async fn handle_inner(state: &ProxyState, request: Request) -> Response {
    let authority = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();

    // Linking between schemes needs the same rules the hosts use, so the page asks
    // this process instead of reimplementing base32 labels in Kotlin.
    if request.uri().path() == "/__ncc/route" {
        return route(state, &authority, request.uri().query().unwrap_or_default()).await;
    }

    if request.uri().path() == "/__ncc/info" {
        return info(state, request.uri().query().unwrap_or_default()).await;
    }

    let Some(vhost) = parse_vhost(&authority) else {
        return help_page(&authority);
    };

    if request.method() == axum::http::Method::CONNECT {
        return text(StatusCode::METHOD_NOT_ALLOWED, "CONNECT is not proxied");
    }

    let path = request.uri().path().to_string();
    let query = request.uri().query().unwrap_or_default().to_string();
    let method = request.method().clone();
    let headers = request.headers().clone();
    let document = is_document_request(&headers);

    let body = match axum::body::to_bytes(request.into_body(), state.max_body_bytes).await {
        Ok(body) => body,
        Err(_) => return text(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large"),
    };

    // Signer calls are answered by this process and never forwarded upstream. The
    // service comes from the Host header, so a page cannot claim another one.
    if let Some(signer_method) = path.strip_prefix("/__ncc/nip07/") {
        return crate::signer::handle(state, &vhost, signer_method, &body).await;
    }

    if vhost.kind == crate::vhost::HostKind::Nsite {
        return crate::nsite::serve(state, &vhost, &path, &query, &method).await;
    }

    let resolved = match state.resolver.resolve(&vhost.pubkey, &vhost.service).await {
        Ok(resolved) => resolved,
        // The address named a service this identity does not publish. It may still
        // publish others, so use the records that do exist instead of dead-ending.
        Err(ResolveError::NoRecord) => {
            return missing_service(state, &vhost, &authority).await;
        }
        Err(error) => return error_page(&error, &vhost),
    };

    let selection = select_transport_endpoints(&resolved.endpoints, false);
    if selection.candidates.is_empty() {
        return error_page(&ResolveError::NoEndpoint, &vhost);
    }

    let mut failures = Vec::new();
    for endpoint in &selection.candidates {
        match forward(
            state, endpoint, &method, &headers, &body, &path, &query, &authority, document, &vhost,
        )
        .await
        {
            Ok(response) => return response,
            // A wrong key is not a reason to try somewhere else: someone answered for
            // this service with a certificate the record does not name.
            Err(ForwardError::Fatal(detail)) => {
                return failure_page(
                    StatusCode::BAD_GATEWAY,
                    "Certificate does not match the locator",
                    &detail,
                    &vhost,
                )
            }
            Err(ForwardError::Retry(detail)) => failures.push(detail),
        }
    }

    failure_page(
        StatusCode::BAD_GATEWAY,
        "Every endpoint refused the connection",
        &failures.join("; "),
        &vhost,
    )
}

enum ForwardError {
    /// Another endpoint may work.
    Retry(String),
    /// Stop: the answer was authenticated and wrong.
    Fatal(String),
}

#[allow(clippy::too_many_arguments)]
async fn forward(
    state: &ProxyState,
    endpoint: &Endpoint,
    method: &axum::http::Method,
    headers: &HeaderMap,
    body: &[u8],
    path: &str,
    query: &str,
    authority: &str,
    document: bool,
    vhost: &Vhost,
) -> Result<Response, ForwardError> {
    let base = Url::parse(&endpoint.url)
        .map_err(|error| ForwardError::Retry(format!("{}: {error}", endpoint.url)))?;

    let mut target = base.clone();
    target.set_path(&join_paths(base.path(), path));
    target.set_query(if query.is_empty() { None } else { Some(query) });

    let upstream_headers = request_headers(headers, &target, document);

    let pinned = endpoint.k.clone();
    let client = if pinned.is_some() {
        &state.pinned_client
    } else {
        &state.client
    };
    let host = target.host_str().unwrap_or_default().to_string();
    if let Some(fingerprint) = &pinned {
        state.pins.set(&host, fingerprint);
    }

    let mut request = client
        .request(method.clone(), target.clone())
        .headers(upstream_headers);

    if !matches!(*method, axum::http::Method::GET | axum::http::Method::HEAD) && !body.is_empty() {
        request = request.body(body.to_vec());
    }

    let response = request.send().await.map_err(|error| match &pinned {
        Some(fingerprint) => {
            let reason = state
                .pins
                .take_failure(&host)
                .unwrap_or_else(|| "the TLS handshake failed".to_string());
            ForwardError::Fatal(format!(
                "{host} presented {reason} (locator k={fingerprint})"
            ))
        }
        None => ForwardError::Retry(format!("{host}: {error}")),
    })?;

    let status = response.status();
    let mut response_headers = HeaderMap::new();

    for (name, value) in response.headers() {
        let name_text = name.as_str().to_ascii_lowercase();
        if HOP_BY_HOP.contains(&name_text.as_str()) {
            continue;
        }
        if name_text == "location" {
            let Ok(location) = value.to_str() else {
                continue;
            };
            let rewritten = rewrite_location(location, &target, authority);
            if let Ok(value) = HeaderValue::from_str(&rewritten) {
                response_headers.insert(header::LOCATION, value);
            }
            continue;
        }
        response_headers.append(name.clone(), value.clone());
    }

    // A top-level NCC document is a live view of a locator-bound endpoint; a stale
    // cached copy would outlive a publisher's rotation.
    if document {
        response_headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response_headers.remove(header::ETAG);
        response_headers.remove(header::LAST_MODIFIED);
    }

    let is_html = response_headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_ascii_lowercase().starts_with("text/html"))
        .unwrap_or(false);
    let small_enough = response
        .content_length()
        .map(|length| length as usize <= MAX_INJECTION_BYTES)
        .unwrap_or(true);

    if document
        && status.is_success()
        && is_html
        && !response_headers.contains_key(header::CONTENT_ENCODING)
        && small_enough
    {
        let bytes = response
            .bytes()
            .await
            .map_err(|error| ForwardError::Retry(error.to_string()))?;

        if bytes.len() <= MAX_INJECTION_BYTES {
            let html = String::from_utf8_lossy(&bytes);
            let (body, nonce) = inject_shim(state, vhost, &html);

            if let Some(csp) = response_headers
                .get(header::CONTENT_SECURITY_POLICY)
                .and_then(|value| value.to_str().ok())
            {
                let relaxed = relax_csp(csp, &nonce);
                if let Ok(value) = HeaderValue::from_str(&relaxed) {
                    response_headers.insert(header::CONTENT_SECURITY_POLICY, value);
                }
            }

            response_headers.remove(header::CONTENT_LENGTH);

            let mut builder = Response::builder().status(status);
            if let Some(out) = builder.headers_mut() {
                *out = response_headers;
            }
            return builder
                .body(Body::from(body))
                .map_err(|error| ForwardError::Retry(error.to_string()));
        }

        // Too large after all: hand it back untouched.
        let mut builder = Response::builder().status(status);
        if let Some(out) = builder.headers_mut() {
            *out = response_headers;
        }
        return builder
            .body(Body::from(bytes))
            .map_err(|error| ForwardError::Retry(error.to_string()));
    }

    let stream = response.bytes_stream();
    let mut builder = Response::builder().status(status);
    if let Some(out) = builder.headers_mut() {
        *out = response_headers;
    }
    builder
        .body(Body::from_stream(stream))
        .map_err(|error| ForwardError::Retry(error.to_string()))
}

fn request_headers(headers: &HeaderMap, target: &Url, document: bool) -> HeaderMap {
    let pairs: Vec<(String, String)> = headers
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect();

    let mut out = HeaderMap::new();
    for (name, value) in upstream_headers(&pairs, target) {
        let lower = name.to_ascii_lowercase();
        if HOP_BY_HOP.contains(&lower.as_str()) {
            continue;
        }
        // Injection needs the document as text; ask the endpoint not to compress it.
        if document && lower == "accept-encoding" {
            continue;
        }
        let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(&value),
        ) else {
            continue;
        };
        out.append(name, value);
    }
    out
}

/// Keep redirects inside the NCC namespace.
///
/// A relative `Location` is already correct: the browser resolves it against the
/// virtual host, which is where the page came from. An absolute URL to the endpoint
/// itself must become relative again, otherwise the browser would follow it to the
/// endpoint origin.
fn rewrite_location(location: &str, target: &Url, authority: &str) -> String {
    let Ok(resolved) = Url::parse(location) else {
        return location.to_string();
    };

    if resolved.scheme() == "ncc" {
        if let Ok(address) = parse_ncc_address(resolved.as_str()) {
            let port = authority.rsplit_once(':').map(|(_, port)| port);
            let host = crate::vhost::host_for(&address.pubkey, &address.service);
            let host = match port {
                Some(port) => format!("{host}:{port}"),
                None => host,
            };
            return format!(
                "http://{host}{}{}{}",
                address.path, address.search, address.hash
            );
        }
        return location.to_string();
    }

    if !matches!(resolved.scheme(), "http" | "https") {
        return location.to_string();
    }
    if http_origin(&resolved) != http_origin(target) {
        return location.to_string();
    }

    let mut relative = resolved.path().to_string();
    if let Some(query) = resolved.query() {
        relative.push('?');
        relative.push_str(query);
    }
    if let Some(fragment) = resolved.fragment() {
        relative.push('#');
        relative.push_str(fragment);
    }
    relative
}

fn is_document_request(headers: &HeaderMap) -> bool {
    if let Some(destination) = headers.get("sec-fetch-dest").and_then(|v| v.to_str().ok()) {
        return destination == "document";
    }
    headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|accept| accept.contains("text/html"))
        .unwrap_or(false)
}

fn text(status: StatusCode, message: &str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        message.to_string(),
    )
        .into_response()
}

fn help_page(authority: &str) -> Response {
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>NCC proxy</title>\
         <style>body{{font:15px system-ui;margin:2rem;max-width:40rem}}\
         code{{background:#eee;padding:.1rem .3rem;border-radius:3px}}</style>\
         <h1>NCC proxy</h1>\
         <p>This server speaks NCC over virtual hosts. It was asked for \
         <code>{authority}</code>, which is not an NCC address.</p>\
         <p>Load <code>http://&lt;npub&gt;.&lt;service&gt;.localhost:PORT/</code> instead, \
         or <code>http://&lt;npub&gt;.localhost:PORT/</code> for the default service.</p>"
    );
    (StatusCode::NOT_FOUND, Html(body)).into_response()
}

/// Insert the NIP-07 shim into a document and return the nonce used for it.
///
/// Both schemes serve HTML, and `window.nostr` should exist on either, so this is
/// shared rather than living in the NCC path.
pub(crate) fn inject_shim(state: &ProxyState, vhost: &Vhost, html: &str) -> (String, String) {
    let key = host_key(vhost);
    let injection = Injection::new(&key);
    state.tokens.remember(&injection.token, &key);
    (
        inject_into_html(html, &injection.script_tag()),
        injection.nonce,
    )
}

/// What the browser knows about one service or site, for the site panel.
///
/// The shell never talks to relays; it asks here, so the record, the endpoint and the
/// pin it shows are the same ones serving the page.
async fn info(state: &ProxyState, query: &str) -> Response {
    let host = url::form_urlencoded::parse(query.as_bytes())
        .find(|(name, _)| name == "u")
        .map(|(_, value)| value.into_owned());

    let Some(host) = host else {
        return json_error(StatusCode::BAD_REQUEST, "missing-host", "Pass ?u=<host>");
    };

    let Some(vhost) = parse_vhost(&host) else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "unknown-host",
            "Not an NCC or site host",
        );
    };

    if vhost.kind == crate::vhost::HostKind::Nsite {
        return match state
            .nsite()
            .resolve(&vhost.pubkey, vhost.site.as_deref())
            .await
        {
            Ok(manifest) => json_ok(serde_json::json!({
                "kind": "nsite",
                "pubkey": vhost.pubkey,
                "service": serde_json::Value::Null,
                "site": vhost.site,
                "event": manifest.event_id,
                "updated": manifest.updated_at,
                "expires": serde_json::Value::Null,
                "title": manifest.title,
                "servers": manifest.servers,
                "paths": manifest.paths.len(),
                "endpoints": [],
            })),
            Err(error) => json_error(StatusCode::NOT_FOUND, "no-manifest", &error.to_string()),
        };
    }

    match state
        .resolver()
        .resolve(&vhost.pubkey, &vhost.service)
        .await
    {
        Ok(resolved) => json_ok(serde_json::json!({
            "kind": "ncc",
            "pubkey": vhost.pubkey,
            "service": vhost.service,
            "site": serde_json::Value::Null,
            "dTag": resolved.d_tag,
            "event": resolved.event_id,
            "updated": resolved.updated_at,
            "expires": resolved.expires_at,
            "endpoints": resolved
                .endpoints
                .iter()
                .map(|endpoint| serde_json::json!({
                    "host": url::Url::parse(&endpoint.url)
                        .ok()
                        .and_then(|url| url.host_str().map(str::to_string))
                        .unwrap_or_else(|| endpoint.url.clone()),
                    "protocol": endpoint.protocol,
                    "family": endpoint.family.as_str(),
                    "pinned": endpoint.k.is_some(),
                }))
                .collect::<Vec<_>>(),
        })),
        Err(error) => json_error(StatusCode::NOT_FOUND, "no-record", &error.to_string()),
    }
}

fn json_ok(value: serde_json::Value) -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        value.to_string(),
    )
        .into_response()
}

/// Map an `ncc://` or `nsite://` link onto the host this browser loads.
async fn route(state: &ProxyState, authority: &str, query: &str) -> Response {
    let target = url::form_urlencoded::parse(query.as_bytes())
        .find(|(name, _)| name == "u")
        .map(|(_, value)| value.into_owned());

    let Some(target) = target else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "missing-url",
            "Pass the address as ?u=<ncc://…|nsite://…>",
        );
    };

    let port = authority.rsplit_once(':').map(|(_, port)| port.to_string());
    let with_port = |host: String| match &port {
        Some(port) if !port.is_empty() => format!("{host}:{port}"),
        _ => host,
    };

    let lower = target.trim().to_ascii_lowercase();

    if lower.starts_with("ncc:") {
        let Ok(address) = parse_ncc_address(target.trim()) else {
            return json_error(
                StatusCode::BAD_REQUEST,
                "invalid-ncc",
                "Not an ncc:// address",
            );
        };
        let host = crate::vhost::host_for(&address.pubkey, &address.service);
        let path = if address.path.is_empty() {
            "/".to_string()
        } else {
            address.path.clone()
        };
        return routed(format!(
            "http://{}{}{}{}",
            with_port(host),
            path,
            address.search,
            address.hash
        ));
    }

    if lower.starts_with("nsite:") {
        let Some(address) = ncc_core::parse_nsite_address(target.trim()) else {
            return json_error(
                StatusCode::BAD_REQUEST,
                "invalid-nsite",
                "Not an nsite:// address",
            );
        };
        // A `d`-like first segment is a site only when one is published; otherwise it
        // is a path on the root site. That needs the manifest, which is why this
        // endpoint exists rather than the shell guessing.
        let (site, path) = match &address.site {
            Some(site)
                if state
                    .nsite()
                    .resolve(&address.pubkey, Some(site))
                    .await
                    .is_ok() =>
            {
                (Some(site.clone()), address.path.clone())
            }
            Some(site) => (None, format!("/{site}{}", address.path)),
            None => (None, address.path.clone()),
        };

        let host = ncc_core::nsite_host(&address.pubkey, site.as_deref());
        return routed(format!(
            "http://{}{}{}{}",
            with_port(host),
            path,
            address.search,
            address.hash
        ));
    }

    if lower.starts_with("http://") || lower.starts_with("https://") {
        if let Ok(url) = url::Url::parse(target.trim()) {
            let host = url.host_str().unwrap_or_default();
            if !host.ends_with(".localhost") {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "unsupported-host",
                    "Only NCC and site hosts are routed here",
                );
            }
            if url.port().is_none() {
                let mut rebuilt = url.clone();
                if let Some(port) = port.as_deref().and_then(|value| value.parse::<u16>().ok()) {
                    let _ = rebuilt.set_port(Some(port));
                }
                return routed(rebuilt.to_string());
            }
            return routed(url.to_string());
        }
    }

    json_error(
        StatusCode::BAD_REQUEST,
        "unsupported-scheme",
        "Only ncc://, nsite:// and localhost URLs are routed",
    )
}

fn routed(url: String) -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({ "url": url }).to_string(),
    )
        .into_response()
}

/// Fall back to whatever the identity actually publishes.
///
/// `ncc://<npub>/` means the `addr` service, and the resolver's `d`-tag ladder only
/// ever falls back *to* `addr`, never from it. An identity that publishes `web` and
/// nothing else would otherwise be unreachable at its bare address, on every shell.
async fn missing_service(state: &ProxyState, vhost: &Vhost, authority: &str) -> Response {
    let services = state.resolver.discover_services(&vhost.pubkey).await;
    if services.is_empty() {
        return failure_page(
            StatusCode::NOT_FOUND,
            &format!("No service called \"{}\"", vhost.service),
            "This identity publishes no NCC-05 locator records that these relays can see.",
            vhost,
        );
    }

    let pages: Vec<&crate::resolve::DiscoveredService> =
        services.iter().filter(|service| service.page).collect();

    // One page to go to and no ambiguity: land there instead of asking.
    if pages.len() == 1 {
        return redirect_to_service(vhost, authority, &pages[0].name);
    }

    service_list_page(vhost, authority, &services)
}

fn service_origin(vhost: &Vhost, authority: &str, service: &str) -> String {
    let host = crate::vhost::host_for(&vhost.pubkey, service);
    match authority.rsplit_once(':') {
        Some((_, port)) => format!("{host}:{port}"),
        None => host,
    }
}

fn redirect_to_service(vhost: &Vhost, authority: &str, service: &str) -> Response {
    let location = format!("http://{}/", service_origin(vhost, authority, service));
    Response::builder()
        .status(StatusCode::FOUND)
        .header(header::LOCATION, location)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::empty())
        .expect("redirect response")
}

fn service_list_page(
    vhost: &Vhost,
    authority: &str,
    services: &[crate::resolve::DiscoveredService],
) -> Response {
    let mut items = String::new();
    for service in services {
        if service.page {
            items.push_str(&format!(
                "<li><a href=\"http://{}/\">{name}</a></li>",
                service_origin(vhost, authority, &service.name),
                name = service.name
            ));
        } else {
            items.push_str(&format!(
                "<li><span class=\"muted\">{}</span> <small>(not a page service)</small></li>",
                service.name
            ));
        }
    }

    let body = format!(
        "<!doctype html><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <style>body{{font:15px system-ui;margin:2rem;max-width:40rem}}\
         code{{background:#eee;padding:.1rem .3rem;border-radius:3px}}\
         .muted{{color:#666}}</style>\
         <h1>Which service?</h1>\
         <p><code>{pubkey}</code> does not publish a service called \
         <code>{requested}</code>. It publishes these:</p>\
         <ul>{items}</ul>",
        pubkey = vhost.pubkey,
        requested = vhost.service
    );

    (
        StatusCode::OK,
        [(header::CACHE_CONTROL, "no-store")],
        Html(body),
    )
        .into_response()
}

/// The identity a token and a signer request are scoped to.
pub(crate) fn host_key(vhost: &Vhost) -> String {
    vhost.identity_key()
}

pub(crate) fn json_error(status: StatusCode, code: &str, message: &str) -> Response {
    let body = serde_json::json!({ "code": code, "message": message }).to_string();
    (status, [(header::CONTENT_TYPE, "application/json")], body).into_response()
}

fn error_page(error: &ResolveError, vhost: &Vhost) -> Response {
    let status = match error {
        ResolveError::InvalidPubkey => StatusCode::BAD_REQUEST,
        ResolveError::NoRecord => StatusCode::NOT_FOUND,
        ResolveError::Expired => StatusCode::GONE,
        ResolveError::NoEndpoint => StatusCode::BAD_GATEWAY,
        ResolveError::InvalidPayload => StatusCode::BAD_GATEWAY,
        ResolveError::RelayError(_) => StatusCode::SERVICE_UNAVAILABLE,
    };
    failure_page(status, &error.to_string(), "", vhost)
}

fn failure_page(status: StatusCode, title: &str, detail: &str, vhost: &Vhost) -> Response {
    let detail = if detail.is_empty() {
        String::new()
    } else {
        format!("<p class=\"detail\"><code>{detail}</code></p>")
    };
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>NCC error</title>\
         <style>body{{font:15px system-ui;margin:2rem;max-width:40rem}}\
         code{{background:#eee;padding:.1rem .3rem;border-radius:3px}}\
         .detail{{word-break:break-word}}</style>\
         <h1>{status}</h1>\
         <p>{title}</p>{detail}\
         <p><code>{pubkey}/{service}</code></p>",
        pubkey = vhost.pubkey,
        service = vhost.service
    );

    (status, Html(body)).into_response()
}

/// Resolve one address to its endpoints. Exposed for tests and the CLI.
pub async fn resolve_address(
    state: &ProxyState,
    pubkey: &str,
    service: &str,
) -> Result<ResolvedService, ResolveError> {
    state.resolver.resolve(pubkey, service).await
}
