//! The HTTP server the content WebView loads.
//!
//! Every request carries the service in the `Host` header, so the service is part of
//! the origin exactly as it is under `ncc://`. Requests are resolved, matched to an
//! endpoint, fetched and rewritten back into the same namespace.

use std::collections::HashSet;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::Router;
use futures_util::FutureExt;
use url::Url;

use ncc_core::{
    http_origin, is_onion_host, join_paths, parse_ncc_address, select_transport_endpoints,
    upstream_headers, Endpoint,
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

/// How far the Tor route is, as far as a page waiting on it is concerned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TorProgress {
    /// Nothing is happening yet, or the client is still bootstrapping.
    Starting {
        percent: u8,
    },
    Ready,
    Failed {
        reason: String,
    },
}

/// Where the Tor listener learns that progress. The proxy does not depend on the Tor
/// crate, so the shell supplies this.
pub trait TorProgressSource: Send + Sync + std::fmt::Debug {
    fn progress(&self) -> TorProgress;
}

#[derive(Debug, Clone)]
pub struct ProxyConfig {
    pub relays: Vec<String>,
    pub request_timeout: Duration,
    pub max_body_bytes: usize,
    /// Origins allowed to read responses with CORS. The shell's own webview is the
    /// only one that needs it (a page fetching a vhost from its own origin does not).
    pub allowed_origins: Vec<String>,
    /// Root of the on-disk cache: manifests, locator records and verified site files.
    /// `None` keeps all three in memory only.
    pub cache_directory: Option<std::path::PathBuf>,
    /// Where trusted services are remembered. Separate from the cache on purpose:
    /// clearing the cache must not revoke a permission.
    pub permissions_file: Option<std::path::PathBuf>,
    /// Persisted settings. When absent, an in-memory store is built from `relays`.
    pub settings: Option<Arc<crate::settings::SettingsStore>>,
    /// The SOCKS endpoint onion traffic leaves through. Setting it makes this
    /// listener the Tor listener: it serves onion vhosts and nothing else, and its
    /// client never gets a direct route to anything.
    pub tor_proxy: Option<String>,
    /// Lets the Tor listener answer a page load with a "Connecting to Tor" page while
    /// the route is still being built, instead of leaving the tab blank and waiting.
    pub tor_progress: Option<Arc<dyn TorProgressSource>>,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            relays: Vec::new(),
            request_timeout: Duration::from_secs(20),
            max_body_bytes: 10 * 1024 * 1024,
            allowed_origins: Vec::new(),
            cache_directory: None,
            permissions_file: None,
            settings: None,
            tor_proxy: None,
            tor_progress: None,
        }
    }
}

pub struct ProxyState {
    resolver: Resolver,
    client: reqwest::Client,
    pinned_client: reqwest::Client,
    /// Present only on the Tor listener.
    tor_client: Option<reqwest::Client>,
    tor_progress: Option<Arc<dyn TorProgressSource>>,
    pins: Arc<PinStore>,
    pub(crate) tokens: TokenStore,
    max_body_bytes: usize,
    allowed_origins: Vec<String>,
    identity: Option<Arc<IdentityStore>>,
    approvals: Option<Arc<Approvals>>,
    /// A remote signer, when the user chose one instead of holding a key here.
    remote: Mutex<Option<Arc<crate::bunker::Bunker>>>,
    trusted: Trusted,
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

        // A named root set rather than reqwest's platform verifier, which panics on
        // Android unless something initialises it with a JVM context.
        let roots = crate::pins::webpki_tls_config();
        let client = match &roots {
            Ok(tls) => build(reqwest::Client::builder().use_preconfigured_tls(tls.clone())),
            Err(error) => {
                tracing::error!(target: "ncc_proxy::pins", "could not build the TLS client: {error}");
                build(reqwest::Client::builder())
            }
        };

        // Endpoints that publish `k` present a self-signed certificate; ordinary PKI
        // verification would reject them, and accepting everything would be worse.
        let pinned_client = match pinned_tls_config(pins.clone()) {
            Ok(tls) => build(reqwest::Client::builder().use_preconfigured_tls(tls)),
            Err(error) => {
                tracing::error!(target: "ncc_proxy::pins", "could not build the pinned TLS client: {error}");
                client.clone()
            }
        };

        // Onion fetches go through SOCKS and nowhere else. The long timeout is
        // deliberate: a circuit and an onion service are both allowed to be slow.
        let tor_client = config.tor_proxy.as_ref().and_then(|proxy| {
            let proxy = match reqwest::Proxy::all(proxy) {
                Ok(proxy) => proxy,
                Err(error) => {
                    tracing::error!(target: "ncc_proxy::onion", "bad Tor proxy: {error}");
                    return None;
                }
            };
            let mut builder = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                // Tor has to bootstrap and build a circuit before the onion is even
                // reached, so the ordinary timeout would give up on a working request.
                .timeout(config.request_timeout.max(Duration::from_secs(120)))
                .user_agent(concat!("NostrNavigator/", env!("CARGO_PKG_VERSION")))
                .proxy(proxy);
            if let Ok(tls) = &roots {
                builder = builder.use_preconfigured_tls(tls.clone());
            }
            builder.build().ok()
        });

        Self {
            resolver: Resolver::new(settings.clone())
                .with_directory(pointer_directory(&config.cache_directory, "records")),
            client,
            pinned_client,
            tor_client,
            tor_progress: config.tor_progress.clone(),
            pins,
            tokens: TokenStore::new(),
            max_body_bytes: config.max_body_bytes,
            allowed_origins: config.allowed_origins.clone(),
            identity: None,
            approvals: None,
            remote: Mutex::new(None),
            trusted: Trusted::open(config.permissions_file.clone()),
            nsite: NsiteResolver::new(settings.clone())
                .with_directory(pointer_directory(&config.cache_directory, "manifests")),
            settings,
            blobs: Blobs::new(
                config.request_timeout,
                pointer_directory(&config.cache_directory, "nsite-blobs"),
                roots.ok(),
            ),
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

    /// The remote signer, when the user connected one. It answers for the identity:
    /// the key it signs with never reaches this device.
    pub fn remote(&self) -> Option<Arc<crate::bunker::Bunker>> {
        crate::lock(&self.remote).clone()
    }

    pub fn set_remote(&self, bunker: Option<Arc<crate::bunker::Bunker>>) {
        *crate::lock(&self.remote) = bunker;
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

    /// Drop everything cached from the network: locators, site manifests, and blobs in
    /// memory and on disk.
    pub fn clear_caches(&self) {
        self.resolver.clear();
        self.nsite.clear();
        self.blobs.clear();
    }

    /// Services the user chose to stop being asked about.
    pub fn is_trusted(&self, key: &str) -> bool {
        self.trusted.contains(key)
    }

    /// Services the user stopped being asked about, for the permissions screen.
    pub fn trusted_keys(&self) -> Vec<String> {
        self.trusted.list()
    }

    pub fn untrust(&self, key: &str) {
        self.trusted.remove(key);
    }

    pub fn trust(&self, key: &str) {
        self.trusted.insert(key);
    }

    pub fn resolver(&self) -> &Resolver {
        &self.resolver
    }

    /// The client onion requests use. `None` means this is not the Tor listener.
    pub(crate) fn tor_client(&self) -> Option<&reqwest::Client> {
        self.tor_client.as_ref()
    }

    pub(crate) fn tor_progress(&self) -> Option<TorProgress> {
        self.tor_progress.as_ref().map(|source| source.progress())
    }

    pub(crate) fn is_tor_listener(&self) -> bool {
        self.tor_client.is_some()
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

/// Services that may ask the signer without a prompt.
///
/// A permission, not a cache: it is written next to the settings and survives a
/// restart, because "remember this service" that is forgotten on relaunch is a bug,
/// not a policy. Clearing the cache must not hand a service the right to sign again
/// either, which is why this is a file of its own rather than a cache entry.
struct Trusted {
    path: Option<std::path::PathBuf>,
    keys: Mutex<HashSet<String>>,
}

impl Trusted {
    fn open(path: Option<std::path::PathBuf>) -> Self {
        let keys = path
            .as_ref()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
            .map(|list| list.into_iter().collect())
            .unwrap_or_default();

        Self {
            path,
            keys: Mutex::new(keys),
        }
    }

    fn contains(&self, key: &str) -> bool {
        crate::lock(&self.keys).contains(key)
    }

    fn list(&self) -> Vec<String> {
        let mut keys: Vec<String> = crate::lock(&self.keys).iter().cloned().collect();
        keys.sort();
        keys
    }

    fn insert(&self, key: &str) {
        crate::lock(&self.keys).insert(key.to_string());
        self.save();
    }

    fn remove(&self, key: &str) {
        crate::lock(&self.keys).remove(key);
        self.save();
    }

    fn save(&self) {
        let Some(path) = &self.path else {
            return;
        };

        let keys = self.list();
        let Ok(bytes) = serde_json::to_vec_pretty(&keys) else {
            return;
        };

        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        // Beside the target, then rename: a crash cannot leave half a permission list.
        let temporary = path.with_extension("tmp");
        if std::fs::write(&temporary, bytes).is_ok() {
            let _ = std::fs::rename(&temporary, path);
        }
    }
}

/// A named directory inside the cache root, if there is a root at all.
fn pointer_directory(root: &Option<std::path::PathBuf>, name: &str) -> Option<std::path::PathBuf> {
    root.as_ref().map(|root| root.join(name))
}

/// The panic's own words.
///
/// The payload has to be downcast through the box's contents: passing `&Box<dyn Any>`
/// as `&dyn Any` does not deref, it downcasts *the box*, which never matches — that
/// is how every message became "a panic with no message".
fn panic_detail(panic: &(dyn std::any::Any + Send)) -> String {
    if let Some(message) = panic.downcast_ref::<&str>() {
        return (*message).to_string();
    }
    if let Some(message) = panic.downcast_ref::<String>() {
        return message.clone();
    }

    "a panic carrying a non-text payload".to_string()
}

#[cfg(test)]
mod panic_tests {
    use super::*;

    #[test]
    fn a_panic_message_is_not_lost() {
        let text = std::panic::catch_unwind(|| panic!("the manifest had no servers"))
            .expect_err("should have panicked");
        assert!(panic_detail(text.as_ref()).contains("no servers"));

        let formatted = std::panic::catch_unwind(|| panic!("kind {}", 24133))
            .expect_err("should have panicked");
        assert!(panic_detail(formatted.as_ref()).contains("24133"));
    }
}

/// The last resort: the proxy itself failed, so say so rather than hanging the page.
fn crash(detail: &str) -> Response {
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <style>body{{font:15px system-ui;margin:2rem;max-width:40rem}}\
         pre{{white-space:pre-wrap;word-break:break-word;background:#f4f4f4;padding:12px;border-radius:8px}}</style>\
         <h1>The proxy failed</h1>\
         <p>This page could not be served. The details below belong in a bug report.</p>\
         <pre>{}</pre>",
        escape(detail)
    );
    (StatusCode::INTERNAL_SERVER_ERROR, Html(body)).into_response()
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Adds CORS only for origins the shell registered, so a random web page cannot read
/// NCC content through the loopback proxy.
async fn handle(State(state): State<Arc<ProxyState>>, request: Request) -> Response {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    // A panic would tear down axum's task, and the browser would show an empty
    // response with nothing to go on. Answer like any other failure instead, and keep
    // the message: this process is the only one that knows what went wrong.
    let mut response = match AssertUnwindSafe(handle_inner(&state, request))
        .catch_unwind()
        .await
    {
        Ok(response) => response,
        Err(panic) => {
            let detail = panic_detail(panic.as_ref());
            tracing::error!("request failed: {detail}");
            crash(&detail)
        }
    };

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
    let path = request.uri().path().to_string();
    let query = request.uri().query().unwrap_or_default().to_string();

    if path == "/__ncc/route" {
        return route(state, &authority, &query).await;
    }

    if path == "/__ncc/info" {
        return info(state, &query).await;
    }

    // Every clearnet reference in an onion document points here. It is answered by
    // this process, never fetched.
    if path == "/__ncc/blocked" {
        return crate::onion::blocked_page(&query);
    }

    // Downloads: the app process cannot resolve a virtual host, so it names one by URL
    // and the request continues as if it had arrived on that host.
    let (vhost, path, query) = if path == "/__ncc/fetch" {
        match fetch_target(&query) {
            Ok(parts) => parts,
            Err(detail) => return json_error(StatusCode::BAD_REQUEST, "invalid-download", &detail),
        }
    } else {
        let Some(vhost) = parse_vhost(&authority) else {
            return help_page(&authority);
        };
        (vhost, path, query)
    };

    if request.method() == axum::http::Method::CONNECT {
        return text(StatusCode::METHOD_NOT_ALLOWED, "CONNECT is not proxied");
    }

    // Continuing past a cleartext warning: remember the exception, then go back to
    // the page the browser would have loaded.
    if request.uri().path() == "/__ncc/allow" {
        return allow_cleartext(
            state,
            &vhost,
            &authority,
            request.uri().query().unwrap_or_default(),
        );
    }

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

    if vhost.kind == crate::vhost::HostKind::Onion {
        if !state.is_tor_listener() {
            return crate::onion::needs_tor_page(&authority);
        }
        return crate::onion::serve(
            state, &vhost, &authority, &path, &query, &method, &headers, &body,
        )
        .await;
    }

    // The Tor listener is onion-only. Serving an NCC address here would resolve it
    // off the clearnet while the tab claims to be private.
    if state.is_tor_listener() {
        return crate::onion::not_onion_page();
    }

    if vhost.kind == crate::vhost::HostKind::Nsite {
        return crate::nsite::serve(state, &vhost, &path, &query, &method, document).await;
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
    let mut candidates = selection.candidates;

    // The user's HTTPS policy decides which of those are actually usable.
    let mode = state.settings().https_mode();
    if mode == crate::settings::HttpsMode::Only {
        candidates.retain(|endpoint| endpoint.protocol == "https" || endpoint.protocol == "wss");
        if candidates.is_empty() {
            return failure_page(
                StatusCode::BAD_GATEWAY,
                "Only secure endpoints are allowed",
                "This locator publishes cleartext endpoints only, and the HTTPS policy is set to require TLS.",
                &vhost,
            );
        }
    }
    let candidates = ncc_core::sort_candidates_for_https(
        &candidates,
        match mode {
            crate::settings::HttpsMode::Off => ncc_core::HttpsMode::Off,
            crate::settings::HttpsMode::Prefer => ncc_core::HttpsMode::Warn,
            crate::settings::HttpsMode::Only => ncc_core::HttpsMode::Only,
        },
    );

    if candidates.is_empty() {
        return error_page(&ResolveError::NoEndpoint, &vhost);
    }

    // A cleartext page is worth an interstitial, but only once per service: the
    // answer is remembered in settings, so the next visit goes straight through.
    let cleartext = candidates
        .first()
        .map(|endpoint| endpoint.protocol == "http" || endpoint.protocol == "ws")
        .unwrap_or(false);

    if document
        && cleartext
        && state.settings().warn_insecure()
        && !state.settings().allows_http(&vhost.identity_key())
    {
        return cleartext_warning(state, &vhost, candidates.first());
    }

    let mut failures = Vec::new();
    for endpoint in &candidates {
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

pub(crate) fn request_headers(headers: &HeaderMap, target: &Url, document: bool) -> HeaderMap {
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

pub(crate) fn is_document_request(headers: &HeaderMap) -> bool {
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

    // `.onion` is routed by the Tor listener. A bare onion host is accepted too,
    // because that is what people paste.
    let onion_input = if lower.starts_with("http://") || lower.starts_with("https://") {
        Some(target.trim().to_string())
    } else if !target.contains(char::is_whitespace)
        && !lower.starts_with("ncc:")
        && !lower.starts_with("nsite:")
        && lower.contains(".onion")
    {
        Some(format!("http://{}", target.trim()))
    } else {
        None
    };

    if let Some(input) = onion_input {
        if let Ok(url) = url::Url::parse(&input) {
            let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
            if is_onion_host(&host) {
                if !state.is_tor_listener() {
                    return json_error(
                        StatusCode::BAD_REQUEST,
                        "tor-required",
                        "Onion addresses load in a Tor tab",
                    );
                }
                return routed(format!(
                    "http://{}{}{}{}",
                    with_port(format!("{host}.localhost")),
                    url.path(),
                    url.query()
                        .map(|query| format!("?{query}"))
                        .unwrap_or_default(),
                    url.fragment()
                        .map(|fragment| format!("#{fragment}"))
                        .unwrap_or_default()
                ));
            }
        }
    }

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

/// Resolve `?u=<vhost URL>` into the parts the normal request path needs.
fn fetch_target(query: &str) -> Result<(Vhost, String, String), String> {
    let target = url::form_urlencoded::parse(query.as_bytes())
        .find(|(name, _)| name == "u")
        .map(|(_, value)| value.into_owned())
        .ok_or_else(|| "Pass the file as ?u=<vhost url>".to_string())?;

    let parsed = url::Url::parse(&target).map_err(|_| "Not a URL".to_string())?;

    let host = parsed.host_str().unwrap_or_default();
    let authority = match parsed.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };

    let vhost = parse_vhost(&authority)
        .ok_or_else(|| "Only NCC and site hosts can be fetched here".to_string())?;

    let path = if parsed.path().is_empty() {
        "/".to_string()
    } else {
        parsed.path().to_string()
    };
    let query = parsed.query().unwrap_or_default().to_string();

    Ok((vhost, path, query))
}

/// A page that has to be acknowledged before a cleartext service loads.
fn cleartext_warning(state: &ProxyState, vhost: &Vhost, endpoint: Option<&Endpoint>) -> Response {
    let key = vhost.identity_key();
    let injection = Injection::new(&key);
    state.tokens.remember(&injection.token, &key);

    let host = endpoint
        .and_then(|endpoint| url::Url::parse(&endpoint.url).ok())
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| "this endpoint".to_string());

    let body = format!(
        "<!doctype html><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <style>body{{font:15px system-ui;margin:2rem;max-width:34rem;line-height:1.5}}\
         a.button{{display:inline-block;margin-top:1.5rem;padding:12px 18px;border-radius:10px;\
         background:#2563eb;color:#fff;text-decoration:none;font-weight:600}}\
         code{{background:#eee;padding:.1rem .3rem;border-radius:3px}}</style>\
         <h1>Not a secure connection</h1>\
         <p><code>{key}</code> is served by <code>{host}</code> over plain HTTP. Anything\
         sent to it — a login, a message — can be read or changed on the way.</p>\
         <p>If the service is yours, publish an HTTPS endpoint with a <code>k</code>\
         fingerprint; that is what makes the connection checkable.</p>\
         <a class=\"button\" href=\"/__ncc/allow?token={token}\">Continue anyway</a>",
        key = key,
        host = host,
        token = injection.token
    );

    (
        StatusCode::OK,
        [(header::CACHE_CONTROL, "no-store")],
        Html(body),
    )
        .into_response()
}

/// Record the exception the warning page asked for, then reload the page.
fn allow_cleartext(state: &ProxyState, vhost: &Vhost, authority: &str, query: &str) -> Response {
    let token = url::form_urlencoded::parse(query.as_bytes())
        .find(|(name, _)| name == "token")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();

    let key = vhost.identity_key();
    if !state.tokens.matches(&token, &key) {
        return json_error(
            StatusCode::FORBIDDEN,
            "invalid-token",
            "That warning has expired; reload the page.",
        );
    }

    if let Err(error) = state.settings().allow_http(&key) {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "settings-failed", &error);
    }

    let _ = authority;

    Response::builder()
        .status(StatusCode::FOUND)
        .header(header::LOCATION, "/")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::empty())
        .expect("redirect")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_permission_survives_a_restart() {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let id = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("ncc-permissions-{}-{id}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);

        let first = Trusted::open(Some(path.clone()));
        first.insert("ncc://npub1abc/web");
        first.insert("nsite://npub1abc/blog");
        assert!(first.contains("ncc://npub1abc/web"));

        // A new process reads the same file, which is the whole point.
        let second = Trusted::open(Some(path.clone()));
        assert!(second.contains("ncc://npub1abc/web"));
        assert_eq!(
            second.list(),
            vec![
                "ncc://npub1abc/web".to_string(),
                "nsite://npub1abc/blog".to_string()
            ]
        );

        second.remove("ncc://npub1abc/web");
        assert!(!Trusted::open(Some(path.clone())).contains("ncc://npub1abc/web"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn trusting_without_a_file_only_lasts_for_the_session() {
        let trusted = Trusted::open(None);
        trusted.insert("ncc://npub1abc/web");
        assert!(trusted.contains("ncc://npub1abc/web"));
        assert!(Trusted::open(None).list().is_empty());
    }
}
