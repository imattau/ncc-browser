use std::sync::Arc;

use tauri::Manager;

/// The loopback port the NCC proxy is listening on, once it started.
struct ProxyPort(Option<u16>);

#[tauri::command]
fn proxy_port(state: tauri::State<'_, ProxyPort>) -> Option<u16> {
    state.0
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

/// Start the NCC proxy on an ephemeral loopback port.
///
/// The content WebView will load `http://<npub>.<service>.localhost:<port>/`, so the
/// service stays part of the origin the way `ncc://` gives the desktop build. The
/// port is ephemeral because nothing outside this process is allowed to reach it.
fn start_proxy() -> Result<u16, String> {
    let listener =
        std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();

    let config = ncc_proxy::ProxyConfig {
        relays: default_relays(),
        // Only the shell's own bundle may read responses across origins. A page
        // served from a vhost does not need CORS at all.
        allowed_origins: vec![
            "tauri://localhost".to_string(),
            "http://tauri.localhost".to_string(),
            "https://tauri.localhost".to_string(),
        ],
        ..Default::default()
    };

    let state = Arc::new(ncc_proxy::ProxyState::new(&config));
    let listener =
        tokio::net::TcpListener::from_std(listener).map_err(|error| error.to_string())?;

    tauri::async_runtime::spawn(async move {
        if let Err(error) = ncc_proxy::serve(listener, state).await {
            eprintln!("[proxy] {error}");
        }
    });

    Ok(port)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![proxy_port])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            match start_proxy() {
                Ok(port) => {
                    println!("[proxy] listening on 127.0.0.1:{port}");
                    app.manage(ProxyPort(Some(port)));
                }
                Err(error) => {
                    eprintln!("[proxy] could not start: {error}");
                    app.manage(ProxyPort(None));
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
