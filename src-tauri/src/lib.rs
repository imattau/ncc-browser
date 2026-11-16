use std::sync::Arc;

use tauri::{Emitter, Manager};

use ncc_identity::{IdentityStore, KeyEnvelope, PassphraseEnvelope, Status};
use ncc_proxy::{
    vault::{Credentials, Draft, PendingSave, SaveOutcome, VaultStatus},
    ApprovalRequest, Approvals, HttpsMode, ProxyConfig, ProxyState, Settings, SettingsStore,
};
use ncc_vault::{GeneratorOptions, PasswordSummary, TotpCode};
use ncc_proxy::settings::PasswordSettings;
use ncc_proxy::vault::VaultService;
use ncc_tor::{Tor, TorConfig, TorMode, TorState, TorStatus};

/// Everything the commands need. The proxy shares the same `Arc`s.
struct SignerState {
    identity: Arc<IdentityStore>,
    approvals: Arc<Approvals>,
    proxy: Arc<ProxyState>,
    /// The session file for a remote signer, when one has been connected.
    sessions: ncc_proxy::bunker::Sessions,
}

/// The loopback port the NCC proxy is listening on, once it started.
struct ProxyPort(Option<u16>);

/// The second listener private tabs use. Separate on purpose: it is a different origin,
/// so its storage is separate, and it is built without any of the on-disk caches.
struct PrivateProxyPort(Option<u16>);

/// The third listener: onion sites, fetched through Tor. A separate port again, so a
/// Tor tab is its own origin and none of the NCC caches are reachable from it.
struct TorProxyPort(Option<u16>);

/// The local SOCKS endpoint Tor tabs leave through, and its state.
struct TorHandle(Option<Arc<Tor>>);

/// Where arti keeps its guard state and directory cache.
struct AppDataDir(std::path::PathBuf);

/// The password vault. It needs the identity and the settings store, not the proxy.
struct VaultHandle(Arc<VaultService>);

#[tauri::command]
fn proxy_port(state: tauri::State<'_, ProxyPort>) -> Option<u16> {
    state.0
}

#[tauri::command]
fn private_proxy_port(state: tauri::State<'_, PrivateProxyPort>) -> Option<u16> {
    state.0
}

#[tauri::command]
fn tor_proxy_port(state: tauri::State<'_, TorProxyPort>) -> Option<u16> {
    state.0
}

/// Bootstrap progress, the route in use and the reason for a failure. The shell shows
/// this rather than guessing from an empty page.
#[tauri::command]
fn tor_status(state: tauri::State<'_, TorHandle>) -> Option<TorStatus> {
    state.0.as_ref().map(|tor| tor.status())
}

/// Start resolving a Tor route, if one is not already being resolved. Called when a
/// Tor tab is opened: launching the app on its own must not contact the Tor network.
#[tauri::command]
fn tor_prepare(state: tauri::State<'_, TorHandle>) {
    if let Some(tor) = state.0.as_ref() {
        tor.prepare();
    }
}

#[tauri::command]
fn vault_status(vault: tauri::State<'_, VaultHandle>) -> VaultStatus {
    vault.0.status()
}

/// Unlocking is gated on a device credential in the shell before this is called; the
/// vault itself can only check that the identity is available.
///
/// The identity is opened here too when it is stored with the device envelope. One
/// device-credential prompt should be enough to open both, and a passphrase-sealed
/// identity stays locked and says so.
#[tauri::command]
async fn vault_unlock(
    state: tauri::State<'_, SignerState>,
    vault: tauri::State<'_, VaultHandle>,
) -> Result<VaultStatus, String> {
    let identity = state.identity.status();
    if identity.initialised && !identity.unlocked {
        let _ = state.identity.unlock(envelope(None).as_ref());
    }
    Ok(vault.0.unlock().await)
}

#[tauri::command]
fn vault_lock(vault: tauri::State<'_, VaultHandle>) -> VaultStatus {
    vault.0.lock()
}

#[tauri::command]
fn vault_list(vault: tauri::State<'_, VaultHandle>) -> Vec<PasswordSummary> {
    vault.0.list()
}

#[tauri::command]
fn vault_entry(vault: tauri::State<'_, VaultHandle>, id: String) -> Result<serde_json::Value, String> {
    let entry = vault.0.entry(&id)?;
    Ok(serde_json::to_value(entry).map_err(|error| error.to_string())?)
}

#[tauri::command]
fn vault_matches(
    vault: tauri::State<'_, VaultHandle>,
    url: String,
    kind: String,
) -> Result<Vec<PasswordSummary>, String> {
    vault.0.matches(&url, &kind)
}

#[tauri::command]
fn vault_fill(
    vault: tauri::State<'_, VaultHandle>,
    id: String,
    url: String,
    kind: String,
) -> Result<Credentials, String> {
    vault.0.fill(&id, &url, &kind)
}

#[tauri::command]
fn vault_totp(vault: tauri::State<'_, VaultHandle>, id: String) -> Result<TotpCode, String> {
    vault.0.totp(&id)
}

#[tauri::command]
fn vault_generate(vault: tauri::State<'_, VaultHandle>, options: GeneratorOptions) -> String {
    vault.0.generate(&options)
}

#[tauri::command]
async fn vault_save(
    vault: tauri::State<'_, VaultHandle>,
    draft: Draft,
) -> Result<SaveOutcome, String> {
    Ok(vault.0.save(draft).await)
}

#[tauri::command]
async fn vault_remove(
    vault: tauri::State<'_, VaultHandle>,
    id: String,
) -> Result<SaveOutcome, String> {
    Ok(vault.0.remove(&id).await)
}

#[tauri::command]
fn vault_capture(
    vault: tauri::State<'_, VaultHandle>,
    url: String,
    kind: String,
    title: String,
    username: String,
    password: String,
) -> Result<Option<PendingSave>, String> {
    vault
        .0
        .capture(&url, &kind, &title, &username, &password)
}

#[tauri::command]
async fn vault_respond(
    vault: tauri::State<'_, VaultHandle>,
    id: String,
    action: String,
) -> Result<SaveOutcome, String> {
    Ok(vault.0.respond_to_save(&id, &action).await)
}

#[tauri::command]
fn vault_config(
    state: tauri::State<'_, SignerState>,
    vault: tauri::State<'_, VaultHandle>,
    passwords: PasswordSettings,
) -> Result<Settings, String> {
    let saved = state.proxy.settings().set_passwords(passwords)?;
    let _ = vault;
    Ok(saved)
}

#[tauri::command]
fn vault_forget_never_save(
    state: tauri::State<'_, SignerState>,
    origin: String,
) -> Result<Settings, String> {
    state.proxy.settings().remove_never_save(&origin)
}

/// Called when the shell becomes visible again: pulls the relay copy, throttled.
#[tauri::command]
async fn vault_focus(vault: tauri::State<'_, VaultHandle>) -> Result<VaultStatus, String> {
    Ok(vault.0.on_focus().await)
}

#[tauri::command]
fn browser_settings(state: tauri::State<'_, SignerState>) -> Settings {
    state.proxy.settings().get()
}

#[tauri::command]
fn settings_set_relays(
    state: tauri::State<'_, SignerState>,
    relays: Vec<String>,
) -> Result<Settings, String> {
    state.proxy.settings().set_relays(relays)
}

#[tauri::command]
fn settings_set_search(
    state: tauri::State<'_, SignerState>,
    engine: String,
    custom: String,
) -> Result<Settings, String> {
    state.proxy.settings().set_search(engine, custom)
}

#[tauri::command]
fn settings_set_https(
    state: tauri::State<'_, SignerState>,
    mode: String,
    warn: bool,
) -> Result<Settings, String> {
    let mode = match mode.as_str() {
        "off" => HttpsMode::Off,
        "only" => HttpsMode::Only,
        _ => HttpsMode::Prefer,
    };
    state.proxy.settings().set_https_mode(mode)?;
    state.proxy.settings().set_warn_insecure(warn)
}

#[tauri::command]
async fn settings_set_tor(
    state: tauri::State<'_, SignerState>,
    tor_handle: tauri::State<'_, TorHandle>,
    dir: tauri::State<'_, AppDataDir>,
    mode: String,
    socks: String,
) -> Result<Settings, String> {
    let mode = match mode.as_str() {
        "local" => TorMode::Local,
        _ => TorMode::Auto,
    };
    let saved = state.proxy.settings().set_tor(mode, socks.clone())?;

    if let Some(tor) = tor_handle.0.as_ref() {
        // The endpoint stays where it is, so a tab already pointing at it only needs a
        // reload once the new route is ready.
        tor.reconfigure(tor_config(&dir.0, mode, socks));
    }

    Ok(saved)
}

#[tauri::command]
fn settings_set_gossip(
    state: tauri::State<'_, SignerState>,
    value: bool,
) -> Result<Settings, String> {
    state.proxy.settings().set_gossip(value)
}

#[tauri::command]
fn clear_cache(state: tauri::State<'_, SignerState>) -> bool {
    state.proxy.clear_caches();
    true
}

#[derive(serde::Serialize)]
struct BunkerInfo {
    configured: bool,
    npub: Option<String>,
    relays: Vec<String>,
}

fn bunker_info(remote: Option<&ncc_proxy::bunker::Bunker>) -> BunkerInfo {
    let Some(bunker) = remote else {
        return BunkerInfo {
            configured: false,
            npub: None,
            relays: Vec::new(),
        };
    };

    BunkerInfo {
        configured: true,
        npub: bunker.user_npub(),
        relays: bunker.relays(),
    }
}

/// Connect a remote signer. The link carries everything: the signer's key, its relays
/// and the optional single-use secret.
///
/// It connects immediately, so a link the signer refuses fails here, in front of the
/// person who pasted it, rather than on the first signature a page asks for.
#[tauri::command]
async fn bunker_connect(
    state: tauri::State<'_, SignerState>,
    url: String,
) -> Result<BunkerInfo, String> {
    let target = ncc_proxy::bunker::parse_bunker(&url)?;
    let bunker = Arc::new(ncc_proxy::bunker::Bunker::generate(target));

    bunker.connect().await?;

    let envelope = envelope(None);
    state.sessions.save_for(&bunker, envelope.as_ref())?;

    state.proxy.set_remote(Some(bunker));
    Ok(bunker_info(state.proxy.remote().as_deref()))
}

/// A stored session is reused here rather than at startup, so launching the app never
/// waits on a relay.
#[tauri::command]
fn bunker_status(state: tauri::State<'_, SignerState>) -> BunkerInfo {
    if state.proxy.remote().is_none() {
        let envelope = envelope(None);
        if let Some((target, client)) = state.sessions.load(envelope.as_ref()) {
            state
                .proxy
                .set_remote(Some(Arc::new(ncc_proxy::bunker::Bunker::new(target, client))));
        }
    }

    bunker_info(state.proxy.remote().as_deref())
}

#[tauri::command]
async fn bunker_disconnect(state: tauri::State<'_, SignerState>) -> Result<BunkerInfo, String> {
    if let Some(bunker) = state.proxy.remote() {
        // A courtesy: the session is forgotten here either way.
        let _ = bunker.logout().await;
    }

    state.sessions.forget();
    state.proxy.set_remote(None);
    Ok(bunker_info(None))
}

/// Keeping the identity unlocked across launches.
///
/// Turning it on unlocks now; turning it off locks now. It can only work where the
/// envelope opens without asking anything, which is the case with the device keystore.
#[tauri::command]
fn settings_set_keep_unlocked(
    state: tauri::State<'_, SignerState>,
    enabled: bool,
) -> Result<Status, String> {
    state.proxy.settings().set_keep_unlocked(enabled)?;

    if enabled {
        let envelope = envelope(None);
        state
            .identity
            .unlock(envelope.as_ref())
            .map_err(|error| error.to_string())?;
    } else {
        state.identity.lock();
    }

    Ok(state.identity.status())
}

#[tauri::command]
fn identity_status(state: tauri::State<'_, SignerState>) -> Status {
    state.identity.status()
}

/// How the secret is sealed. On Android the keystore holds the wrapping key, so no
/// passphrase is involved; the passphrase envelope is only used elsewhere, and to
/// migrate a file written before the keystore existed.
fn envelope(passphrase: Option<String>) -> Box<dyn KeyEnvelope> {
    #[cfg(target_os = "android")]
    {
        let _ = passphrase;
        Box::new(ncc_identity::device::DeviceEnvelope)
    }
    #[cfg(not(target_os = "android"))]
    {
        Box::new(PassphraseEnvelope::new(passphrase.unwrap_or_default()))
    }
}

#[tauri::command]
fn identity_create(
    state: tauri::State<'_, SignerState>,
    passphrase: Option<String>,
) -> Result<Status, String> {
    let envelope = envelope(passphrase);
    state
        .identity
        .create(envelope.as_ref())
        .map(|_| state.identity.status())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn identity_import(
    state: tauri::State<'_, SignerState>,
    passphrase: Option<String>,
    secret: String,
) -> Result<Status, String> {
    let envelope = envelope(passphrase);
    state
        .identity
        .import(envelope.as_ref(), &secret)
        .map(|_| state.identity.status())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn identity_unlock(
    state: tauri::State<'_, SignerState>,
    passphrase: Option<String>,
) -> Result<Status, String> {
    // A file from before the keystore is opened with its passphrase, then rewritten
    // with the device envelope, so the passphrase is asked for exactly once.
    let legacy = state.identity.status().envelope.as_deref() == Some("legacy");
    let envelope: Box<dyn KeyEnvelope> = if legacy {
        let Some(passphrase) = passphrase else {
            return Err(ncc_identity::IdentityError::PassphraseRequired.to_string());
        };
        Box::new(PassphraseEnvelope::new(passphrase))
    } else {
        envelope(None)
    };

    state
        .identity
        .unlock(envelope.as_ref())
        .map(|_| state.identity.status())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn identity_lock(state: tauri::State<'_, SignerState>) -> Status {
    state.identity.lock();
    state.identity.status()
}

#[tauri::command]
fn signer_permissions(state: tauri::State<'_, SignerState>) -> Vec<String> {
    state.proxy.trusted_keys()
}

/// Trust a service without waiting for it to ask, from the site information sheet. Only
/// the shell can call this: a page never reaches Tauri commands.
#[tauri::command]
fn signer_trust(state: tauri::State<'_, SignerState>, service: String) -> Vec<String> {
    if service.starts_with("ncc://") || service.starts_with("nsite://") {
        state.proxy.trust(&service);
    }
    state.proxy.trusted_keys()
}

/// "Forget trust decisions for this site": the signer permission and a cleartext
/// exception both go, so the next visit asks and warns again. Returns what is still
/// trusted. Passwords' never-save list has its own command.
#[tauri::command]
fn site_forget_trust(
    state: tauri::State<'_, SignerState>,
    service: String,
) -> Result<Vec<String>, String> {
    state.proxy.untrust(&service);
    state.proxy.settings().remove_http_exception(&service)?;
    Ok(state.proxy.trusted_keys())
}

#[tauri::command]
fn signer_revoke(state: tauri::State<'_, SignerState>, service: String) -> Vec<String> {
    state.proxy.untrust(&service);
    state.proxy.trusted_keys()
}

/// Answer a parked signer request. `remember` grants the whole service, and the grant
/// is written to disk, so the shell stops asking across restarts too.
#[tauri::command]
fn signer_respond(
    state: tauri::State<'_, SignerState>,
    id: String,
    allow: bool,
    remember: bool,
    service: Option<String>,
) -> bool {
    let answered = state.approvals.resolve(&id, allow);
    if answered && allow && remember {
        if let Some(service) = service {
            state.proxy.trust(&service);
        }
    }
    answered
}

fn default_relays() -> Vec<String> {
    if let Ok(value) = std::env::var("NCC_RELAYS") {
        let relays: Vec<String> = value
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect();
        if !relays.is_empty() {
            return relays;
        }
    }

    vec![
        "wss://relay.damus.io".to_string(),
        "wss://nos.lol".to_string(),
        "wss://relay.primal.net".to_string(),
    ]
}

/// Tells the Tor listener how far Tor has got, so a tab opened while it is still being
/// built shows "Connecting to Tor" instead of a blank page.
struct TorProgressFeed(Arc<Tor>);

impl std::fmt::Debug for TorProgressFeed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TorProgressFeed")
    }
}

impl ncc_proxy::TorProgressSource for TorProgressFeed {
    fn progress(&self) -> ncc_proxy::TorProgress {
        let status = self.0.status();
        match status.state {
            TorState::Ready => ncc_proxy::TorProgress::Ready,
            TorState::Failed => ncc_proxy::TorProgress::Failed {
                reason: status
                    .error
                    .unwrap_or_else(|| "No route to Tor was found.".to_string()),
            },
            _ => ncc_proxy::TorProgress::Starting {
                percent: status.percent,
            },
        }
    }
}

fn tor_config(dir: &std::path::Path, mode: TorMode, socks: String) -> TorConfig {
    TorConfig {
        mode,
        socks,
        state_dir: dir.join("tor").join("state"),
        cache_dir: dir.join("tor").join("cache"),
    }
}

fn proxy_config(
    data_dir: Option<std::path::PathBuf>,
    settings: Option<Arc<SettingsStore>>,
) -> ProxyConfig {
    ProxyConfig {
        relays: default_relays(),
        settings,
        permissions_file: data_dir
            .as_ref()
            .map(|dir| dir.join("permissions.json")),
        // Manifests, records and verified site files survive a restart; site files are
        // hash-checked when read back.
        cache_directory: data_dir,
        // Only the shell's own bundle may read responses across origins. A page
        // served from a vhost does not need CORS at all.
        allowed_origins: vec![
            "tauri://localhost".to_string(),
            "http://tauri.localhost".to_string(),
            "https://tauri.localhost".to_string(),
        ],
        ..Default::default()
    }
}

/// Bind a loopback socket, on `preferred` when it is free and on any free port when not.
///
/// A page's origin includes the port, so a new port every launch is a new origin for
/// every site: `localStorage`, IndexedDB and service workers all start empty after a
/// restart. Reusing the last port keeps them. It is still a port the OS chose, picked
/// once and remembered, rather than a well-known number another app could squat on, and
/// if something else has taken it the proxy simply moves, as it did before.
fn bind_loopback(preferred: Option<u16>) -> Result<std::net::TcpListener, String> {
    let reused = preferred
        .filter(|port| *port > 0)
        .and_then(|port| std::net::TcpListener::bind(("127.0.0.1", port)).ok());
    if let Some(listener) = reused {
        return Ok(listener);
    }
    std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())
}

/// The port used last time, if one was recorded.
fn remembered_port(file: &std::path::Path) -> Option<u16> {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|text| text.trim().parse::<u16>().ok())
        .filter(|port| *port >= 1024)
}

/// Record the port for the next launch. Failing to write it only costs the next
/// launch its web storage, so it is not an error.
fn remember_port(file: &std::path::Path, port: u16) {
    if remembered_port(file) == Some(port) {
        return;
    }
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(file, port.to_string());
}

/// Start the NCC proxy on a loopback port, `preferred` when it is free.
///
/// The content WebView loads `http://<npub>.<service>.localhost:<port>/`, so the
/// service stays part of the origin the way `ncc://` gives the desktop build. The
/// port is not a fixed number because nothing outside this process is allowed to reach
/// it.
///
/// The socket is bound with `std` and only *converted* inside the async task: tokio's
/// `from_std` registers with the reactor and panics when called outside a runtime,
/// which `setup()` is.
fn start_proxy(proxy: Arc<ProxyState>, preferred: Option<u16>) -> Result<u16, String> {
    let std_listener = bind_loopback(preferred)?;
    std_listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let port = std_listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();

    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(std_listener) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("[proxy] could not attach the listener: {error}");
                return;
            }
        };
        if let Err(error) = ncc_proxy::serve(listener, proxy).await {
            eprintln!("[proxy] {error}");
        }
    });

    Ok(port)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            proxy_port,
            private_proxy_port,
            tor_proxy_port,
            tor_status,
            tor_prepare,
            settings_set_tor,
            vault_status,
            vault_unlock,
            vault_lock,
            vault_list,
            vault_entry,
            vault_matches,
            vault_fill,
            vault_totp,
            vault_generate,
            vault_save,
            vault_remove,
            vault_capture,
            vault_respond,
            vault_config,
            vault_forget_never_save,
            vault_focus,
            bunker_connect,
            bunker_status,
            bunker_disconnect,
            identity_status,
            identity_create,
            identity_import,
            identity_unlock,
            identity_lock,
            settings_set_keep_unlocked,
            browser_settings,
            clear_cache,
            settings_set_relays,
            settings_set_search,
            settings_set_https,
            settings_set_gossip,
            signer_permissions,
            signer_trust,
            site_forget_trust,
            signer_revoke,
            signer_respond
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            let identity = Arc::new(IdentityStore::open(data_dir.join("identity.json")));

            let handle = app.handle().clone();
            let approvals = Arc::new(Approvals::new(move |request: ApprovalRequest| {
                // The shell renders the prompt; it is the only UI that may ask for a
                // passphrase or grant trust.
                let _ = handle.emit("ncc:signer", request);
            }));

            let settings = Arc::new(SettingsStore::open(data_dir.join("config.json")));

            // Staying unlocked is a setting, so it applies before anything asks. A file
            // that still needs a passphrase simply stays locked, and says so in status.
            if settings.get().keep_unlocked {
                let envelope = envelope(None);
                match identity.unlock(envelope.as_ref()) {
                    Ok(npub) => println!("[identity] unlocked at startup: {npub}"),
                    Err(error) => eprintln!("[identity] keep-unlocked did not apply: {error}"),
                }
            }
            let proxy = Arc::new(
                ProxyState::new(&proxy_config(Some(data_dir.clone()), Some(settings.clone())))
                    .with_signer(identity.clone(), approvals.clone()),
            );

            // A failure here must not take the shell down with it: the app is still
            // usable to show why the proxy could not start.
            // Normal tabs keep their web storage across launches by keeping the port.
            let port_file = data_dir.join("proxy-port");
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                start_proxy(proxy.clone(), remembered_port(&port_file))
            }));
            let port = match outcome {
                Ok(Ok(port)) => {
                    remember_port(&port_file, port);
                    println!("[proxy] listening on 127.0.0.1:{port}");
                    Some(port)
                }
                Ok(Err(error)) => {
                    eprintln!("[proxy] could not start: {error}");
                    None
                }
                Err(_) => {
                    eprintln!("[proxy] panicked while starting");
                    None
                }
            };

            // Private tabs: the same proxy, minus every cache and with a key that exists
            // only in memory. Nothing a private tab does is written down.
            let private_proxy = Arc::new(
                ProxyState::new(&proxy_config(None, Some(settings.clone()))).with_signer(
                    Arc::new(IdentityStore::ephemeral()),
                    approvals.clone(),
                ),
            );
            let private_port = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                start_proxy(private_proxy.clone(), None)
            }))
            .ok()
            .and_then(Result::ok);

            match private_port {
                Some(port) => println!("[proxy] private listener on 127.0.0.1:{port}"),
                None => eprintln!("[proxy] could not start the private listener"),
            }

            // Tor tabs: the local SOCKS endpoint starts here and resolves its route in
            // the background. Failing to bind it is not fatal — the rest of the app
            // works, and the Tor status says what happened.
            let (tor_mode, tor_socks) = settings.tor();
            let tor = tauri::async_runtime::block_on(Tor::start(tor_config(
                &data_dir,
                tor_mode,
                tor_socks,
            )))
            .map_err(|error| {
                eprintln!("[tor] could not start the endpoint: {error}");
                error
            })
            .ok();

            let tor_port = tor.as_ref().and_then(|tor| {
                let mut config = proxy_config(None, Some(settings.clone()));
                config.tor_proxy = Some(tor.socks_url().to_string());
                config.tor_progress = Some(Arc::new(TorProgressFeed(tor.clone())));
                let listener = Arc::new(
                    ProxyState::new(&config).with_signer(
                        Arc::new(IdentityStore::ephemeral()),
                        approvals.clone(),
                    ),
                );
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    start_proxy(listener, None)
                })) {
                    Ok(Ok(port)) => {
                        println!("[proxy] Tor listener on 127.0.0.1:{port}");
                        Some(port)
                    }
                    _ => {
                        eprintln!("[proxy] could not start the Tor listener");
                        None
                    }
                }
            });

            app.manage(ProxyPort(port));
            app.manage(PrivateProxyPort(private_port));
            let vault_service = Arc::new(VaultService::new(
                identity.clone(),
                settings.clone(),
                data_dir.join("vault").join("cache.json"),
            ));

            app.manage(TorProxyPort(tor_port));
            app.manage(VaultHandle(vault_service));
            app.manage(TorHandle(tor));
            app.manage(AppDataDir(data_dir.clone()));
            app.manage(SignerState {
                identity,
                approvals,
                proxy,
                sessions: ncc_proxy::bunker::Sessions::open(data_dir.join("nip46-session.json")),
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ncc-port-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_free_preferred_port_is_reused() {
        // Find a free port, release it, then ask for it.
        let probe = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("probe");
        let port = probe.local_addr().expect("addr").port();
        drop(probe);

        let listener = bind_loopback(Some(port)).expect("bind");
        assert_eq!(listener.local_addr().expect("addr").port(), port);
    }

    #[test]
    fn a_taken_preferred_port_falls_back_to_another() {
        let taken = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("taken");
        let port = taken.local_addr().expect("addr").port();

        let listener = bind_loopback(Some(port)).expect("bind");
        assert_ne!(listener.local_addr().expect("addr").port(), port);
    }

    #[test]
    fn no_preference_still_binds() {
        assert!(bind_loopback(None).is_ok());
        assert!(bind_loopback(Some(0)).is_ok());
    }

    #[test]
    fn the_port_survives_a_restart_and_junk_is_ignored() {
        let dir = scratch("file");
        let file = dir.join("proxy-port");

        assert_eq!(remembered_port(&file), None);
        remember_port(&file, 48_123);
        assert_eq!(remembered_port(&file), Some(48_123));

        // A privileged or malformed value is not trusted.
        std::fs::write(&file, "80").expect("write");
        assert_eq!(remembered_port(&file), None);
        std::fs::write(&file, "not a port").expect("write");
        assert_eq!(remembered_port(&file), None);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
