//! NIP-07 over HTTP.
//!
//! The shim injected into a page posts here, on the page's own origin, so the service
//! comes from the `Host` header and never from the page. Everything a page can ask
//! for is gated on the same three things: a token issued for this document load, an
//! unlocked identity, and — unless the user trusted this service — an approval.

use std::time::Duration;

use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use nostr::JsonUtil;
use serde_json::{json, Value};

use crate::approvals::ApprovalRequest;
use crate::server::{host_key, json_error};
use crate::vhost::Vhost;
use crate::ProxyState;

const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
const PREVIEW_CHARS: usize = 160;

pub async fn handle(state: &ProxyState, vhost: &Vhost, method: &str, body: &[u8]) -> Response {
    let parsed: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let token = parsed
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let key = host_key(vhost);

    if !state.tokens.matches(token, &key) {
        return json_error(
            StatusCode::FORBIDDEN,
            "invalid-token",
            "This page holds no signer token for this service.",
        );
    }

    let Some(identity) = state.identity() else {
        return json_error(
            StatusCode::NOT_IMPLEMENTED,
            "signer-not-configured",
            "This build has no identity yet.",
        );
    };

    if !identity.is_unlocked() {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "identity-locked",
            "Unlock the identity in the browser, then try again.",
        );
    }

    let params = parsed.get("params").cloned().unwrap_or(Value::Null);

    match method {
        // Reading the public key is not a signing operation: it is the page asking
        // who is logged in, and it reveals nothing that was not already requested.
        //
        // NIP-07 returns **hex**. Returning the npub works on clients that decode
        // bech32 and breaks the ones that parse the string as a key (ditto reports
        // "unpadded hex 63").
        "get-public-key" => match identity.public_key() {
            Ok(public_key) => ok(json!({ "result": public_key.to_hex() })),
            Err(error) => internal(error),
        },

        "get-relays" => {
            let mut map = serde_json::Map::new();
            for url in state.resolver().relays() {
                map.insert(url.clone(), json!({ "read": true, "write": true }));
            }
            ok(json!({ "result": map }))
        }

        "sign-event" => {
            let kind = params
                .get("kind")
                .and_then(Value::as_u64)
                .map(|kind| kind as u16);
            let preview = params
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .chars()
                .take(PREVIEW_CHARS)
                .collect::<String>();

            if !approved(state, vhost, method, kind, preview).await {
                return declined();
            }

            match identity.sign_event(&params) {
                Ok(event) => match event.as_json().parse::<Value>() {
                    Ok(value) => ok(json!({ "result": value })),
                    Err(error) => internal_text(error.to_string()),
                },
                Err(error) => internal(error),
            }
        }

        "nip04-encrypt" | "nip04-decrypt" | "nip44-encrypt" | "nip44-decrypt" => {
            let peer = params
                .get("peer")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let text = params
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();

            let preview = if method.ends_with("encrypt") {
                text.chars().take(PREVIEW_CHARS).collect::<String>()
            } else {
                format!("{}…", &text.chars().take(32).collect::<String>())
            };

            if !approved(state, vhost, method, None, preview).await {
                return declined();
            }

            let result = match method {
                "nip04-encrypt" => identity.nip04_encrypt(peer, text),
                "nip04-decrypt" => identity.nip04_decrypt(peer, text),
                "nip44-encrypt" => identity.nip44_encrypt(peer, text),
                _ => identity.nip44_decrypt(peer, text),
            };

            match result {
                Ok(value) => ok(json!({ "result": value })),
                Err(error) => internal(error),
            }
        }

        _ => json_error(
            StatusCode::NOT_FOUND,
            "unknown-method",
            "Unknown signer method.",
        ),
    }
}

async fn approved(
    state: &ProxyState,
    vhost: &Vhost,
    method: &str,
    kind: Option<u16>,
    preview: String,
) -> bool {
    let key = host_key(vhost);
    if state.is_trusted(&key) {
        return true;
    }

    let Some(approvals) = state.approvals() else {
        return false;
    };

    approvals
        .ask(
            ApprovalRequest {
                id: String::new(),
                service: key,
                method: method.to_string(),
                kind,
                preview,
            },
            APPROVAL_TIMEOUT,
        )
        .await
}

fn ok(value: Value) -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        value.to_string(),
    )
        .into_response()
}

fn declined() -> Response {
    json_error(
        StatusCode::FORBIDDEN,
        "rejected",
        "The user declined this request.",
    )
}

fn internal(error: ncc_identity::IdentityError) -> Response {
    internal_text(error.to_string())
}

fn internal_text(detail: String) -> Response {
    json_error(StatusCode::INTERNAL_SERVER_ERROR, "signer-failed", &detail)
}


#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    use axum::http::StatusCode;

    use super::*;
    use crate::approvals::Approvals;
    use crate::server::ProxyConfig;
    use crate::vhost::Vhost;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn state() -> (ProxyState, Vhost) {
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ncc-signer-test-{}-{id}.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);

        let identity = Arc::new(ncc_identity::IdentityStore::open(path));
        identity.create("passphrase").expect("create");

        let state = ProxyState::new(&ProxyConfig::default())
            .with_signer(identity, Arc::new(Approvals::new(|_| {})));

        let vhost = Vhost {
            pubkey: "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhs2n3v"
                .to_string(),
            service: "web".to_string(),
        };
        state.tokens.remember("token", &host_key(&vhost));

        (state, vhost)
    }

    #[tokio::test]
    async fn get_public_key_returns_hex_not_bech32() {
        let (state, vhost) = state();
        let response = handle(&state, &vhost, "get-public-key", br#"{"token":"token"}"#).await;
        assert_eq!(response.status(), StatusCode::OK);

        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .expect("body");
        let value: Value = serde_json::from_slice(&body).expect("json");
        let result = value.get("result").and_then(Value::as_str).expect("result");

        assert_eq!(result.len(), 64, "NIP-07 wants hex, got {result}");
        assert!(result.chars().all(|character| character.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn a_call_without_a_token_is_refused() {
        let (state, vhost) = state();
        let response = handle(&state, &vhost, "get-public-key", br#"{"token":"other"}"#).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn a_locked_identity_answers_401() {
        let (state, vhost) = state();
        state.identity().expect("signer").lock();
        let response = handle(&state, &vhost, "get-public-key", br#"{"token":"token"}"#).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
