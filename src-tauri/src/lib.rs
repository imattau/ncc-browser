use std::sync::Arc;

use tauri::{Emitter, Manager};

use ncc_identity::{IdentityStore, KeyEnvelope, PassphraseEnvelope, Status};
use ncc_proxy::{
    ApprovalRequest, Approvals, HttpsMode, ProxyConfig, ProxyState, Settings, SettingsStore,
};

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

#[tauri::command]
fn proxy_port(state: tauri::State<'_, ProxyPort>) -> Option<u16> {
    state.0
}

#[tauri::command]
fn private_proxy_port(state: tauri::State<'_, PrivateProxyPort>) -> Option<u16> {
    state.0
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

/// Start the NCC proxy on an ephemeral loopback port.
///
/// The content WebView loads `http://<npub>.<service>.localhost:<port>/`, so the
/// service stays part of the origin the way `ncc://` gives the desktop build. The
/// port is ephemeral because nothing outside this process is allowed to reach it.
///
/// The socket is bound with `std` and only *converted* inside the async task: tokio's
/// `from_std` registers with the reactor and panics when called outside a runtime,
/// which `setup()` is.
fn start_proxy(proxy: Arc<ProxyState>) -> Result<u16, String> {
    let std_listener =
        std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
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
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                start_proxy(proxy.clone())
            }));
            let port = match outcome {
                Ok(Ok(port)) => {
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
                start_proxy(private_proxy.clone())
            }))
            .ok()
            .and_then(Result::ok);

            match private_port {
                Some(port) => println!("[proxy] private listener on 127.0.0.1:{port}"),
                None => eprintln!("[proxy] could not start the private listener"),
            }

            app.manage(ProxyPort(port));
            app.manage(PrivateProxyPort(private_port));
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
