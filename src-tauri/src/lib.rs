use std::sync::Arc;

use tauri::{Emitter, Manager};

use ncc_identity::{IdentityStore, Status};
use ncc_proxy::{ApprovalRequest, Approvals, ProxyConfig, ProxyState};

/// Everything the commands need. The proxy shares the same `Arc`s.
struct SignerState {
    identity: Arc<IdentityStore>,
    approvals: Arc<Approvals>,
    proxy: Arc<ProxyState>,
}

/// The loopback port the NCC proxy is listening on, once it started.
struct ProxyPort(Option<u16>);

#[tauri::command]
fn proxy_port(state: tauri::State<'_, ProxyPort>) -> Option<u16> {
    state.0
}

#[tauri::command]
fn identity_status(state: tauri::State<'_, SignerState>) -> Status {
    state.identity.status()
}

#[tauri::command]
fn identity_create(
    state: tauri::State<'_, SignerState>,
    passphrase: String,
) -> Result<Status, String> {
    state
        .identity
        .create(&passphrase)
        .map(|_| state.identity.status())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn identity_import(
    state: tauri::State<'_, SignerState>,
    passphrase: String,
    secret: String,
) -> Result<Status, String> {
    state
        .identity
        .import(&passphrase, &secret)
        .map(|_| state.identity.status())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn identity_unlock(
    state: tauri::State<'_, SignerState>,
    passphrase: String,
) -> Result<Status, String> {
    state
        .identity
        .unlock(&passphrase)
        .map(|_| state.identity.status())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn identity_lock(state: tauri::State<'_, SignerState>) -> Status {
    state.identity.lock();
    state.identity.status()
}

/// Answer a parked signer request. `remember` grants the whole service, so the shell
/// stops asking until the app restarts.
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

fn proxy_config(data_dir: Option<std::path::PathBuf>) -> ProxyConfig {
    ProxyConfig {
        relays: default_relays(),
        // Verified site blobs survive a restart; the hash is re-checked on read.
        blob_directory: data_dir.map(|dir| dir.join("nsite-blobs")),
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
            identity_status,
            identity_create,
            identity_import,
            identity_unlock,
            identity_lock,
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

            let proxy = Arc::new(
                ProxyState::new(&proxy_config(Some(data_dir.clone())))
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

            app.manage(ProxyPort(port));
            app.manage(SignerState {
                identity,
                approvals,
                proxy,
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
