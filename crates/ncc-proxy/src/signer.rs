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

    // A remote signer answers for the identity. There is no local prompt in that
    // mode: the bunker asks its own user, and that is the only answer that can
    // produce a signature, so asking twice would be asking the same question again.
    if let Some(bunker) = state.remote() {
        return remote(state, &bunker, method, &parsed).await;
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

        "get-relays" => relays(state),

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
                format!("{}…", text.chars().take(32).collect::<String>())
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

/// Answer NIP-07 from a signer this device does not hold the key for.
async fn remote(
    state: &ProxyState,
    bunker: &crate::bunker::Bunker,
    method: &str,
    parsed: &Value,
) -> Response {
    let params = parsed.get("params").cloned().unwrap_or(Value::Null);

    match method {
        // NIP-07 wants hex, and it wants the *user's* key: the bunker's own key is
        // only the channel.
        "get-public-key" => match bunker.ensure_user().await {
            Ok(user) => ok(json!({ "result": user })),
            Err(detail) => unreachable_signer(&detail),
        },

        "get-relays" => relays(state),

        "sign-event" => {
            // Learn the user key first, so a signature from any other key is refused.
            if let Err(detail) = bunker.ensure_user().await {
                return unreachable_signer(&detail);
            }

            match bunker.sign_event(&params).await {
                Ok(event) => match event.as_json().parse::<Value>() {
                    Ok(value) => ok(json!({ "result": value })),
                    Err(error) => internal_text(error.to_string()),
                },
                Err(detail) => signer_error(&detail),
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

            let result = match method {
                "nip04-encrypt" => bunker.nip04_encrypt(peer, text).await,
                "nip04-decrypt" => bunker.nip04_decrypt(peer, text).await,
                "nip44-encrypt" => bunker.nip44_encrypt(peer, text).await,
                _ => bunker.nip44_decrypt(peer, text).await,
            };

            match result {
                Ok(value) => ok(json!({ "result": value })),
                Err(detail) => signer_error(&detail),
            }
        }

        _ => json_error(
            StatusCode::NOT_FOUND,
            "unknown-method",
            "Unknown signer method.",
        ),
    }
}

fn relays(state: &ProxyState) -> Response {
    let mut map = serde_json::Map::new();
    for url in state.resolver().relays() {
        map.insert(url.clone(), json!({ "read": true, "write": true }));
    }
    ok(json!({ "result": map }))
}

/// The signer could not be reached, or refused. Both are the signer's business, not
/// this browser's, and both are worth showing as they came.
fn signer_error(detail: &str) -> Response {
    json_error(StatusCode::BAD_GATEWAY, "signer-refused", detail)
}

fn unreachable_signer(detail: &str) -> Response {
    json_error(StatusCode::BAD_GATEWAY, "signer-unreachable", detail)
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
        let path =
            std::env::temp_dir().join(format!("ncc-signer-test-{}-{id}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);

        let identity = Arc::new(ncc_identity::IdentityStore::open(path));
        identity
            .create(&ncc_identity::PassphraseEnvelope::new("passphrase"))
            .expect("create");

        let state = ProxyState::new(&ProxyConfig::default())
            .with_signer(identity, Arc::new(Approvals::new(|_| {})));

        let vhost = Vhost {
            pubkey: "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhs2n3v".to_string(),
            service: "web".to_string(),
            site: None,
            onion: None,
            kind: crate::vhost::HostKind::Ncc,
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
        assert!(result
            .chars()
            .all(|character| character.is_ascii_hexdigit()));
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
