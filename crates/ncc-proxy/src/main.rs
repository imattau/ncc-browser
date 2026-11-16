//! `ncc-proxy` — serve the NCC address space over localhost virtual hosts.
//!
//! ```text
//! ncc-proxy --port 47822 --relay wss://nos.lol
//! curl -H 'Host: <npub>.web.localhost:47822' http://127.0.0.1:47822/
//! ```
//!
//! `--resolve <npub>[/service]` prints what the locator resolves to without serving,
//! which is the quickest way to check the pipeline against a live record.

use std::net::{IpAddr, SocketAddr};
use std::process::ExitCode;
use std::sync::Arc;

use ncc_proxy::{serve, ProxyConfig, ProxyState};

const DEFAULT_PORT: u16 = 47_822;
const DEFAULT_RELAYS: &[&str] = &[
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.nostr.band",
];

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_target(false)
        .init();

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("could not start the runtime: {error}");
            return ExitCode::FAILURE;
        }
    };
    runtime.block_on(run())
}

async fn run() -> ExitCode {
    let mut port = DEFAULT_PORT;
    let mut bind: IpAddr = IpAddr::from([127, 0, 0, 1]);
    let mut relays: Vec<String> = Vec::new();
    let mut resolve: Option<String> = None;
    let mut allowed_origins: Vec<String> = Vec::new();
    let mut tor_proxy: Option<String> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => match args.next().and_then(|value| value.parse().ok()) {
                Some(value) => port = value,
                None => return usage("--port needs a number"),
            },
            "--bind" => match args.next().and_then(|value| value.parse().ok()) {
                Some(value) => bind = value,
                None => return usage("--bind needs an IP address"),
            },
            "--relay" => match args.next() {
                Some(value) if !value.trim().is_empty() => relays.push(value),
                _ => return usage("--relay needs a URL"),
            },
            "--relays" => match args.next() {
                Some(value) => relays.extend(
                    value
                        .split(',')
                        .map(str::trim)
                        .filter(|item| !item.is_empty())
                        .map(str::to_string),
                ),
                None => return usage("--relays needs a comma-separated list"),
            },
            "--allow-origin" => match args.next() {
                Some(value) => allowed_origins.push(value),
                None => return usage("--allow-origin needs an origin"),
            },
            // Makes this process the onion listener, fetching through a SOCKS endpoint:
            // the way to try `<onion>.onion.localhost` without a phone.
            "--tor-proxy" => match args.next() {
                Some(value) if value.starts_with("socks5h://") => tor_proxy = Some(value),
                _ => return usage("--tor-proxy needs a socks5h:// URL"),
            },
            "--resolve" => match args.next() {
                Some(value) => resolve = Some(value),
                None => return usage("--resolve needs an npub or hex pubkey"),
            },
            "-h" | "--help" => return usage(""),
            other => return usage(&format!("unknown argument: {other}")),
        }
    }

    if relays.is_empty() {
        if let Ok(value) = std::env::var("NCC_RELAYS") {
            relays.extend(
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|item| !item.is_empty())
                    .map(str::to_string),
            );
        }
    }
    if relays.is_empty() {
        relays = DEFAULT_RELAYS
            .iter()
            .map(|relay| relay.to_string())
            .collect();
    }

    let config = ProxyConfig {
        relays: relays.clone(),
        allowed_origins: allowed_origins.clone(),
        tor_proxy,
        ..Default::default()
    };
    let state = Arc::new(ProxyState::new(&config));

    if let Some(address) = resolve {
        return match resolve_once(&state, &address).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(code) => code,
        };
    }

    let listener = match tokio::net::TcpListener::bind(SocketAddr::new(bind, port)).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("could not bind {bind}:{port}: {error}");
            return ExitCode::FAILURE;
        }
    };

    println!("NCC proxy listening on http://{bind}:{port}");
    println!("  http://<npub>.<service>.localhost:{port}/");
    println!("  http://<npub>.localhost:{port}/        (default service)");
    println!("  relays: {}", relays.join(", "));

    match serve(listener, state).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("server error: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn resolve_once(state: &ProxyState, input: &str) -> Result<(), ExitCode> {
    let trimmed = input.trim();
    let (pubkey, service) = match trimmed.split_once('/') {
        Some((pubkey, service)) if !service.is_empty() => (pubkey, service),
        _ => (trimmed, "addr"),
    };

    match state.resolver().resolve(pubkey, service).await {
        Ok(resolved) => {
            println!("pubkey    {}", resolved.pubkey);
            println!("hex       {}", resolved.hex_pubkey);
            println!(
                "service   {} (d={}, {})",
                resolved.service,
                resolved.d_tag,
                resolved.d_tag_source.as_str()
            );
            println!("event     {}", resolved.event_id);
            println!("expires   {}", resolved.expires_at);
            for endpoint in &resolved.endpoints {
                println!(
                    "endpoint  {} [{} {}]{}",
                    endpoint.url,
                    endpoint.protocol,
                    endpoint.family.as_str(),
                    endpoint
                        .k
                        .as_ref()
                        .map(|k| format!(" k={k}"))
                        .unwrap_or_default()
                );
            }
            Ok(())
        }
        Err(error) => {
            eprintln!("resolve failed: {error}");
            Err(ExitCode::FAILURE)
        }
    }
}

fn usage(message: &str) -> ExitCode {
    if !message.is_empty() {
        eprintln!("{message}\n");
    }
    eprintln!(
        "ncc-proxy [--port {DEFAULT_PORT}] [--bind 127.0.0.1] [--relay URL]… \
         [--relays a,b] [--allow-origin ORIGIN]… [--tor-proxy socks5h://host:port] \
         [--resolve <npub>[/service]]"
    );
    if message.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(2)
    }
}
