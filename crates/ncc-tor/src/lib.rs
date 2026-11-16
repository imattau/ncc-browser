//! The Tor transport for Nostr Navigator on Android.
//!
//! `WebView` has no SOCKS setting and no per-tab proxy, so a Tor tab is not a web
//! view with a proxy attached. It is a loopback HTTP listener whose onion requests
//! leave through the endpoint this crate provides.
//!
//! The endpoint is always local, even when Tor is not: a SOCKS5 listener is bound at
//! startup, and connections wait for a route rather than failing while arti is still
//! bootstrapping. Behind it sits either arti (bundled, the default) or an external
//! daemon such as Orbot, which is what `torMode: local` is for. Both use the same
//! `socks5h` URL, so nothing above this crate knows which one is in use.
//!
//! Names are never resolved here. arti resolves over the network it builds, and the
//! external path hands the name to the daemon's SOCKS endpoint unchanged.

pub mod socks;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

#[cfg(feature = "bundled")]
use socks::BoxStream;
use socks::{DialFuture, Dialer, Endpoint};

/// How Tor is obtained.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TorMode {
    /// The bundled client, falling back to a daemon on the usual ports.
    #[default]
    Auto,
    /// Only the configured SOCKS proxy, which is what Orbot runs.
    Local,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TorConfig {
    pub mode: TorMode,
    /// The SOCKS endpoint used in `local` mode, and the first fallback in `auto`.
    pub socks: String,
    /// arti's guard state. Keeping it makes the second start much faster than the
    /// first, so it is worth a directory of its own.
    pub state_dir: PathBuf,
    /// arti's directory cache.
    pub cache_dir: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TorState {
    /// Nothing has been attempted yet.
    Idle,
    /// arti is bootstrapping, or a daemon is being looked for.
    Starting,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TorKind {
    /// arti, in this process.
    Bundled,
    /// A daemon at the configured or usual SOCKS port.
    External,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorStatus {
    pub state: TorState,
    pub kind: Option<TorKind>,
    /// The SOCKS endpoint actually in use, or `None` before there is one.
    pub proxy: Option<String>,
    pub error: Option<String>,
    /// Bootstrap progress, 0–100. Stays 0 when the route is an external daemon,
    /// which does not report progress to us.
    pub percent: u8,
    pub mode: TorMode,
}

impl TorStatus {
    fn idle(mode: TorMode) -> Self {
        Self {
            state: TorState::Idle,
            kind: None,
            proxy: None,
            error: None,
            percent: 0,
            mode,
        }
    }

    fn starting(mode: TorMode, kind: Option<TorKind>) -> Self {
        Self {
            state: TorState::Starting,
            kind,
            proxy: None,
            error: None,
            percent: 0,
            mode,
        }
    }
}

struct Inner {
    /// The local SOCKS endpoint. It is what a bundled route reports, because that is
    /// where the browser's traffic goes.
    #[cfg_attr(not(feature = "bundled"), allow(dead_code))]
    endpoint: String,
    route: watch::Sender<Option<Arc<dyn Dialer>>>,
    status: watch::Sender<TorStatus>,
    /// Bumped on every reconfigure, so a bootstrap that finishes late cannot install
    /// a route the user has already replaced.
    generation: AtomicU64,
}

impl Inner {
    fn current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    fn publish(&self, generation: u64, status: TorStatus) {
        if self.current(generation) {
            self.status.send_replace(status);
        }
    }

    #[cfg_attr(not(feature = "bundled"), allow(dead_code))]
    fn progress(&self, generation: u64, percent: u8) {
        if !self.current(generation) {
            return;
        }
        let mut status = self.status.borrow().clone();
        status.percent = percent;
        self.status.send_replace(status);
    }

    fn ready(&self, generation: u64, kind: TorKind, proxy: String) {
        if !self.current(generation) {
            return;
        }
        let mut status = self.status.borrow().clone();
        status.state = TorState::Ready;
        status.kind = Some(kind);
        status.proxy = Some(proxy);
        status.error = None;
        status.percent = 100;
        self.status.send_replace(status);
    }

    fn failed(&self, generation: u64, error: String) {
        if !self.current(generation) {
            return;
        }
        let mut status = self.status.borrow().clone();
        status.state = TorState::Failed;
        status.kind = None;
        status.proxy = None;
        status.error = Some(error);
        status.percent = 0;
        self.status.send_replace(status);
    }
}

/// The local SOCKS endpoint and its state.
///
/// Starting is cheap and never fails because Tor is unavailable: the listener is
/// bound immediately, and the page that needs it gets a real SOCKS error instead of
/// a dead tab.
pub struct Tor {
    socks: String,
    inner: Arc<Inner>,
}

impl Tor {
    /// Bind the local endpoint and begin resolving a route.
    ///
    /// Must be called inside a Tokio runtime: the listener and the bootstrap both
    /// live there.
    pub async fn start(config: TorConfig) -> Result<Arc<Self>, String> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| format!("could not bind the Tor endpoint: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();

        // SOCKS5 for reqwest, and `h` so the name is resolved by Tor rather than by
        // this device's resolver.
        let socks = format!("socks5h://127.0.0.1:{port}");

        let (route, _) = watch::channel(None);
        let (status, _) = watch::channel(TorStatus::idle(config.mode));
        let inner = Arc::new(Inner {
            endpoint: socks.clone(),
            route,
            status,
            generation: AtomicU64::new(0),
        });

        let tor = Arc::new(Self {
            socks,
            inner: inner.clone(),
        });

        let dialer = Arc::new(Waiting {
            route: inner.route.clone(),
            status: inner.status.clone(),
        });
        tokio::spawn(socks::serve(listener, dialer));

        tor.reconfigure(config);
        Ok(tor)
    }

    /// The URL reqwest is pointed at. Stable for the life of the process, because it
    /// names this crate's listener rather than whichever route is current.
    pub fn socks_url(&self) -> &str {
        &self.socks
    }

    pub fn status(&self) -> TorStatus {
        self.inner.status.borrow().clone()
    }

    /// Apply new settings. The endpoint does not move, so a page already pointing at
    /// it needs nothing more than a reload once the new route is ready.
    pub fn reconfigure(&self, config: TorConfig) {
        let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let inner = self.inner.clone();
        tokio::spawn(async move {
            resolve(&inner, config, generation).await;
        });
    }
}

/// A dialer that waits for a route. Tor tabs opened during startup wait here instead
/// of failing, which is the difference between "the onion is down" and "Tor is
/// still bootstrapping" in the page the user sees.
struct Waiting {
    route: watch::Sender<Option<Arc<dyn Dialer>>>,
    status: watch::Sender<TorStatus>,
}

impl Dialer for Waiting {
    fn dial<'a>(&'a self, host: &'a str, port: u16) -> DialFuture<'a> {
        Box::pin(async move {
            // Wait only while something is still being attempted. A failed startup is
            // reported immediately, so a tab opened with no Tor shows why instead of
            // hanging for the length of a request timeout.
            // Slightly less than the HTTP client's timeout, so the tab gets this
            // crate's reason rather than a bare request timeout.
            let deadline = tokio::time::Instant::now() + Duration::from_secs(110);
            loop {
                // Read the watches into locals: a guard held across the dial below
                // would make this future non-Send.
                let current = self.route.borrow().clone();
                if let Some(dialer) = current {
                    return dialer.dial(host, port).await;
                }
                let state = self.status.borrow().state;
                if state == TorState::Failed {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::NetworkUnreachable,
                        "Tor is not available",
                    ));
                }
                if tokio::time::Instant::now() > deadline {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "Tor did not become ready in time",
                    ));
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
    }
}

#[cfg(feature = "bundled")]
struct Arti {
    client: Arc<arti_client::TorClient<tor_rtcompat::PreferredRuntime>>,
}

#[cfg(feature = "bundled")]
impl Dialer for Arti {
    fn dial<'a>(&'a self, host: &'a str, port: u16) -> DialFuture<'a> {
        Box::pin(async move {
            let stream = self
                .client
                .connect((host.to_string(), port))
                .await
                .map_err(|error| {
                    std::io::Error::other(format!("Tor could not reach {host}: {error}"))
                })?;
            Ok(Box::new(stream) as BoxStream)
        })
    }
}

struct External {
    endpoint: Endpoint,
}

impl Dialer for External {
    fn dial<'a>(&'a self, host: &'a str, port: u16) -> DialFuture<'a> {
        Box::pin(async move { socks::connect_through(&self.endpoint, host, port).await })
    }
}

async fn resolve(inner: &Arc<Inner>, config: TorConfig, generation: u64) {
    inner.publish(generation, TorStatus::starting(config.mode, None));

    if config.mode == TorMode::Local {
        match external(&config.socks).await {
            Ok((dialer, proxy)) => install(inner, generation, dialer, TorKind::External, proxy),
            Err(error) => inner.failed(generation, error),
        }
        return;
    }

    #[cfg(feature = "bundled")]
    {
        match bootstrap(inner, &config, generation).await {
            Ok(client) => {
                install(
                    inner,
                    generation,
                    Arc::new(Arti { client }),
                    TorKind::Bundled,
                    inner.endpoint.clone(),
                );
                return;
            }
            Err(error) => {
                tracing::warn!(target: "ncc_tor", "bundled Tor did not start: {error}");
                inner.publish(
                    generation,
                    TorStatus::starting(config.mode, Some(TorKind::External)),
                );
            }
        }
    }

    // A daemon is the fallback in auto mode, and the only route in a build without
    // the bundled client.
    let mut candidates: Vec<String> = vec![config.socks.clone()];
    for port in [9050, 9150] {
        let candidate = format!("socks5://127.0.0.1:{port}");
        if !candidates.iter().any(|existing| existing == &candidate) {
            candidates.push(candidate);
        }
    }

    let mut last = String::from("no Tor proxy answered");
    for candidate in candidates {
        match external(&candidate).await {
            Ok((dialer, proxy)) => {
                install(inner, generation, dialer, TorKind::External, proxy);
                return;
            }
            Err(error) => last = error,
        }
    }

    inner.failed(generation, last);
}

fn install(
    inner: &Arc<Inner>,
    generation: u64,
    dialer: Arc<dyn Dialer>,
    kind: TorKind,
    proxy: String,
) {
    if !inner.current(generation) {
        return;
    }
    inner.route.send_replace(Some(dialer));
    inner.ready(generation, kind, proxy);
}

async fn external(proxy: &str) -> Result<(Arc<dyn Dialer>, String), String> {
    let endpoint = socks::parse_proxy(proxy)?;
    if !socks::probe(&endpoint).await {
        return Err(format!(
            "Nothing answered SOCKS5 on {}:{}",
            endpoint.host, endpoint.port
        ));
    }
    let shown = socks::normalize_proxy(proxy)?;
    Ok((Arc::new(External { endpoint }), shown))
}

#[cfg(feature = "bundled")]
async fn bootstrap(
    inner: &Arc<Inner>,
    config: &TorConfig,
    generation: u64,
) -> Result<Arc<arti_client::TorClient<tor_rtcompat::PreferredRuntime>>, String> {
    use arti_client::config::TorClientConfigBuilder;

    std::fs::create_dir_all(&config.state_dir)
        .map_err(|error| format!("could not create {}: {error}", config.state_dir.display()))?;
    std::fs::create_dir_all(&config.cache_dir)
        .map_err(|error| format!("could not create {}: {error}", config.cache_dir.display()))?;

    let built = TorClientConfigBuilder::from_directories(&config.state_dir, &config.cache_dir)
        .build()
        .map_err(|error| format!("Tor configuration was rejected: {error}"))?;

    let client = arti_client::TorClient::builder()
        .config(built)
        .create_unbootstrapped()
        .map_err(|error| format!("Tor could not start: {error}"))?;

    let started = {
        let client = client.clone();
        tokio::spawn(async move {
            client
                .bootstrap()
                .await
                .map_err(|error| format!("Tor could not bootstrap: {error}"))
        })
    };

    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        if !inner.current(generation) {
            return Err("Tor was reconfigured".to_string());
        }

        let percent = (client.bootstrap_status().as_frac() * 100.0).clamp(0.0, 100.0) as u8;
        inner.progress(generation, percent);

        if started.is_finished() {
            break;
        }
        if tokio::time::Instant::now() > deadline {
            return Err("Tor did not bootstrap within 120s".to_string());
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }

    match started.await {
        Ok(Ok(())) => {
            inner.progress(generation, 100);
            // The status carries the URL the caller should show, which is always this
            // crate's endpoint; keep it in place for the ready status.
            Ok(client)
        }
        Ok(Err(error)) => Err(error),
        Err(error) => Err(format!("Tor bootstrap task failed: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(mode: TorMode, socks: &str) -> TorConfig {
        TorConfig {
            mode,
            socks: socks.to_string(),
            state_dir: std::env::temp_dir().join("ncc-tor-test/state"),
            cache_dir: std::env::temp_dir().join("ncc-tor-test/cache"),
        }
    }

    #[tokio::test]
    async fn an_external_daemon_becomes_the_route() {
        // Stand in for Orbot: a SOCKS endpoint that accepts a greeting.
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(socks::serve(
            listener,
            Arc::new(socks::Echo) as Arc<dyn Dialer>,
        ));

        let tor = Tor::start(config(
            TorMode::Local,
            &format!("socks5://127.0.0.1:{port}"),
        ))
        .await
        .unwrap();

        let status = wait_for(&tor, TorState::Ready).await;
        assert_eq!(status.kind, Some(TorKind::External));
        assert_eq!(
            status.proxy.as_deref(),
            Some(format!("socks5h://127.0.0.1:{port}").as_str())
        );
        assert!(tor.socks_url().starts_with("socks5h://127.0.0.1:"));
    }

    #[tokio::test]
    async fn a_missing_daemon_fails_with_the_reason_not_a_dead_lock() {
        let tor = Tor::start(config(TorMode::Local, "socks5://127.0.0.1:1"))
            .await
            .unwrap();
        let status = wait_for(&tor, TorState::Failed).await;
        assert!(status.error.unwrap().contains("Nothing answered"));
    }

    #[tokio::test]
    async fn socks_requests_before_a_route_exists_are_refused_by_code() {
        // No daemon, no bundled client: a tab opened now must fail as a SOCKS error
        // rather than hanging until its own timeout.
        let tor = Tor::start(config(TorMode::Local, "socks5://127.0.0.1:1"))
            .await
            .unwrap();
        let endpoint = socks::parse_proxy(tor.socks_url()).unwrap();
        let result = socks::connect_through(&endpoint, "example.onion", 80).await;
        assert!(result.is_err());
    }

    async fn wait_for(tor: &Arc<Tor>, state: TorState) -> TorStatus {
        for _ in 0..100 {
            let status = tor.status();
            if status.state == state {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("Tor never reached {state:?}: {:?}", tor.status());
    }
}
