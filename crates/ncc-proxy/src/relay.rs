//! Minimal Nostr relay client for locator queries.
//!
//! One connection per query, opened with a `REQ`, closed after `EOSE` or a deadline.
//! The desktop build keeps a long-lived pool; that matters for latency, not for
//! correctness, and a browser only queries when its cache misses.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use nostr::{Event, Kind};
use serde_json::{json, Value};
use tokio::time::{timeout, Instant};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

const SUBSCRIPTION: &str = "ncc";

/// Signs what a relay asks for. The vault passes the identity's signer here so that
/// NIP-42 AUTH and the vault event itself are signed by the same key.
pub type Signer = Arc<dyn Fn(Value) -> Result<Event, String> + Send + Sync>;

/// Whether a message is an AUTH challenge, and its challenge string.
fn auth_challenge(message: &Value) -> Option<String> {
    if message.get(0).and_then(Value::as_str) != Some("AUTH") {
        return None;
    }
    message
        .get(1)
        .and_then(Value::as_str)
        .map(|challenge| challenge.to_string())
}

/// The NIP-42 event a relay expects.
fn auth_template(relay: &str, challenge: &str) -> Value {
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    json!({
        "kind": 22242,
        "created_at": created_at,
        "tags": [["relay", relay], ["challenge", challenge]],
        "content": "",
    })
}

async fn authenticate<S>(
    sink: &mut S,
    relay: &str,
    challenge: &str,
    signer: &Signer,
) -> Result<(), String>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let template = auth_template(relay, challenge);
    let event = signer(template)?;
    if event.kind != Kind::Authentication {
        return Err(format!("{relay}: signer returned a non-AUTH event"));
    }
    sink.send(Message::Text(
        json!([
            "AUTH",
            serde_json::to_value(&event).map_err(|error| error.to_string())?
        ])
        .to_string()
        .into(),
    ))
    .await
    .map_err(|error| format!("{relay}: {error}"))?;
    Ok(())
}

/// Query one relay and return every verified event it sent before `EOSE` or `wait`.
pub async fn query(relay: &str, filter: &Value, wait: Duration) -> Result<Vec<Event>, String> {
    query_inner(relay, filter, wait, None).await
}

/// Query a relay that may require NIP-42 authentication.
pub async fn query_authed(
    relay: &str,
    filter: &Value,
    wait: Duration,
    signer: &Signer,
) -> Result<Vec<Event>, String> {
    query_inner(relay, filter, wait, Some(signer)).await
}

async fn query_inner(
    relay: &str,
    filter: &Value,
    wait: Duration,
    signer: Option<&Signer>,
) -> Result<Vec<Event>, String> {
    let deadline = Instant::now() + wait;

    let (socket, _) = timeout(wait, connect_async(relay))
        .await
        .map_err(|_| format!("{relay}: connect timed out"))?
        .map_err(|error| format!("{relay}: {error}"))?;

    let (mut sink, mut stream) = socket.split();
    let request = json!(["REQ", SUBSCRIPTION, filter]).to_string();
    sink.send(Message::Text(request.clone().into()))
        .await
        .map_err(|error| format!("{relay}: {error}"))?;

    let mut events = Vec::new();
    let mut authenticated = false;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }

        let next = match timeout(remaining, stream.next()).await {
            Ok(next) => next,
            Err(_) => break,
        };

        let Some(Ok(message)) = next else {
            break;
        };

        let Message::Text(text) = message else {
            continue;
        };

        let Ok(message) = serde_json::from_str::<Value>(&text) else {
            continue;
        };

        if let Some(challenge) = auth_challenge(&message) {
            let Some(signer) = signer else {
                break;
            };
            authenticate(&mut sink, relay, &challenge, signer).await?;
            authenticated = true;
            // The REQ went out before the relay trusted us. Ask again now that it does;
            // relays either ignore the first one or close it with auth-required.
            sink.send(Message::Text(request.clone().into()))
                .await
                .map_err(|error| format!("{relay}: {error}"))?;
            continue;
        }

        match message.get(0).and_then(Value::as_str) {
            Some("EVENT") => {
                let Some(raw) = message.get(2) else {
                    continue;
                };
                let Ok(event) = serde_json::from_value::<Event>(raw.clone()) else {
                    continue;
                };
                // A locator is worthless if its signature does not check out.
                if event.verify().is_err() {
                    continue;
                }
                events.push(event);
            }
            Some("CLOSED") => {
                let reason = message.get(2).and_then(Value::as_str).unwrap_or_default();
                // A relay may close the pre-auth REQ; the re-REQ above is the answer.
                if authenticated && reason.contains("auth-required") {
                    break;
                }
                break;
            }
            Some("EOSE") => break,
            Some("NOTICE") => {
                tracing::debug!(target: "ncc_proxy::relay", "{relay}: {message}");
            }
            _ => {}
        }
    }

    let close = json!(["CLOSE", SUBSCRIPTION]).to_string();
    let _ = sink.send(Message::Text(close.into())).await;
    let _ = sink.close().await;

    Ok(events)
}

/// Publish one event, authenticating if the relay asks. Returns the relay's reason on
/// refusal, so a caller can report which relays missed a save.
pub async fn publish(
    relay: &str,
    event: &Event,
    signer: &Signer,
    wait: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + wait;

    let (socket, _) = timeout(wait, connect_async(relay))
        .await
        .map_err(|_| format!("{relay}: connect timed out"))?
        .map_err(|error| format!("{relay}: {error}"))?;
    let (mut sink, mut stream) = socket.split();

    let payload = json!([
        "EVENT",
        serde_json::to_value(event).map_err(|error| error.to_string())?
    ])
    .to_string();
    sink.send(Message::Text(payload.clone().into()))
        .await
        .map_err(|error| format!("{relay}: {error}"))?;

    let mut resent = false;
    let mut auth_refusals = 0u8;

    let outcome = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break Err(format!("{relay}: timed out waiting for OK"));
        }

        let next = match timeout(remaining, stream.next()).await {
            Ok(next) => next,
            Err(_) => break Err(format!("{relay}: timed out waiting for OK")),
        };
        let Some(Ok(Message::Text(text))) = next else {
            break Err(format!("{relay}: connection closed before OK"));
        };
        let Ok(message) = serde_json::from_str::<Value>(&text) else {
            continue;
        };

        if let Some(challenge) = auth_challenge(&message) {
            authenticate(&mut sink, relay, &challenge, signer).await?;
            // Many relays refuse the first EVENT outright rather than queueing it.
            if !resent {
                sink.send(Message::Text(payload.clone().into()))
                    .await
                    .map_err(|error| format!("{relay}: {error}"))?;
                resent = true;
            }
            continue;
        }

        match message.get(0).and_then(Value::as_str) {
            Some("OK") => {
                let id = message.get(1).and_then(Value::as_str).unwrap_or_default();
                if id != event.id.to_hex() {
                    continue;
                }
                let accepted = message.get(2).and_then(Value::as_bool).unwrap_or(false);
                let reason = message
                    .get(3)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if accepted {
                    break Ok(());
                }
                // A relay may refuse the unauthenticated EVENT before it has sent the
                // challenge, and the refusal can arrive after the AUTH round trip. Both
                // are covered by waiting; a relay that keeps saying it after two
                // resends is genuinely refusing.
                if reason.contains("auth-required") && auth_refusals < 2 {
                    auth_refusals += 1;
                    continue;
                }
                break Err(format!(
                    "{relay}: {}",
                    if reason.is_empty() {
                        "refused"
                    } else {
                        &reason
                    }
                ));
            }
            Some("NOTICE") => {
                let reason = message.get(1).and_then(Value::as_str).unwrap_or_default();
                break Err(format!(
                    "{relay}: {}",
                    if reason.is_empty() { "notice" } else { reason }
                ));
            }
            Some("CLOSED") => {
                let reason = message.get(2).and_then(Value::as_str).unwrap_or_default();
                break Err(format!("{relay}: {reason}"));
            }
            _ => {}
        }
    };

    let _ = sink.close().await;
    outcome
}

/// Publish to several relays; returns how many accepted and the first reason given.
pub async fn publish_all(
    relays: &[String],
    event: &Event,
    signer: &Signer,
    wait: Duration,
) -> (usize, Option<String>) {
    let attempts = relays
        .iter()
        .map(|relay| publish(relay, event, signer, wait))
        .collect::<Vec<_>>();
    let results = futures_util::future::join_all(attempts).await;

    let mut accepted = 0;
    let mut first_error = None;
    for result in results {
        match result {
            Ok(()) => accepted += 1,
            Err(error) => {
                tracing::debug!(target: "ncc_proxy::relay", "{error}");
                first_error.get_or_insert(error);
            }
        }
    }
    (accepted, first_error)
}

/// Query every relay concurrently and merge the results.
pub async fn query_all(relays: &[String], filter: &Value, wait: Duration) -> Vec<Event> {
    let queries = relays
        .iter()
        .map(|relay| query(relay, filter, wait))
        .collect::<Vec<_>>();

    let results = futures_util::future::join_all(queries).await;
    let mut events = Vec::new();
    for result in results {
        match result {
            Ok(found) => events.extend(found),
            Err(error) => tracing::debug!(target: "ncc_proxy::relay", "{error}"),
        }
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Message;

    fn signer_for(keys: Keys) -> Signer {
        Arc::new(move |template: Value| {
            let kind = Kind::from(template["kind"].as_u64().unwrap_or_default() as u16);
            let created_at = Timestamp::from(template["created_at"].as_u64().unwrap_or_default());
            let tags: Vec<Tag> = serde_json::from_value(template["tags"].clone())
                .map_err(|error| error.to_string())?;
            let content = template["content"].as_str().unwrap_or_default().to_string();
            EventBuilder::new(kind, content)
                .tags(tags)
                .custom_created_at(created_at)
                .sign_with_keys(&keys)
                .map_err(|error| error.to_string())
        })
    }

    fn vault_event(keys: &Keys) -> Event {
        EventBuilder::new(Kind::Custom(30078), "ciphertext")
            .tags(vec![Tag::parse(["d", "ncc-browser/passwords/v1"]).unwrap()])
            .sign_with_keys(keys)
            .unwrap()
    }

    async fn listener() -> (TcpListener, String) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        (listener, format!("ws://127.0.0.1:{port}"))
    }

    /// A relay that requires NIP-42, then accepts one event.
    async fn auth_relay(listener: TcpListener, relay_url: String, accept: bool) {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        socket
            .send(Message::Text(
                json!(["AUTH", "challenge-abc"]).to_string().into(),
            ))
            .await
            .unwrap();

        let mut authenticated = false;
        while let Some(Ok(message)) = socket.next().await {
            let Message::Text(text) = message else {
                continue;
            };
            let value: Value = serde_json::from_str(&text).unwrap();

            match value.get(0).and_then(Value::as_str) {
                Some("AUTH") => {
                    let event: Event =
                        serde_json::from_value(value.get(1).cloned().unwrap()).unwrap();
                    assert_eq!(event.kind, Kind::Authentication);
                    assert!(event.verify().is_ok());
                    let tags = event
                        .tags
                        .iter()
                        .map(|tag| tag.as_slice().to_vec())
                        .collect::<Vec<_>>();
                    assert!(tags
                        .iter()
                        .any(|tag| tag == &["challenge".to_string(), "challenge-abc".to_string()]));
                    assert!(tags
                        .iter()
                        .any(|tag| tag[0] == "relay" && tag[1] == relay_url));
                    authenticated = true;
                }
                Some("EVENT") => {
                    let event: Event =
                        serde_json::from_value(value.get(1).cloned().unwrap()).unwrap();
                    if !authenticated {
                        socket
                            .send(Message::Text(
                                json!([
                                    "OK",
                                    event.id.to_hex(),
                                    false,
                                    "auth-required: authenticate first"
                                ])
                                .to_string()
                                .into(),
                            ))
                            .await
                            .unwrap();
                        continue;
                    }
                    let body = if accept {
                        json!(["OK", event.id.to_hex(), true, ""])
                    } else {
                        json!(["OK", event.id.to_hex(), false, "blocked: not today"])
                    };
                    socket
                        .send(Message::Text(body.to_string().into()))
                        .await
                        .unwrap();
                    break;
                }
                _ => {}
            }
        }
    }

    #[tokio::test]
    async fn publish_authenticates_and_retries_the_event() {
        let keys = Keys::generate();
        let (listener, url) = listener().await;
        let server = tokio::spawn(auth_relay(listener, url.clone(), true));

        let event = vault_event(&keys);
        let signer = signer_for(keys);
        publish(&url, &event, &signer, Duration::from_secs(5))
            .await
            .expect("published after auth");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn a_refusal_carries_the_relays_reason() {
        let keys = Keys::generate();
        let (listener, url) = listener().await;
        let server = tokio::spawn(auth_relay(listener, url.clone(), false));

        let error = publish(
            &url,
            &vault_event(&keys),
            &signer_for(keys),
            Duration::from_secs(5),
        )
        .await
        .expect_err("refused");
        assert!(error.contains("blocked"), "{error}");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn query_collects_events_after_authenticating() {
        let keys = Keys::generate();
        let event = vault_event(&keys);
        let served = event.clone();
        let (listener, url) = listener().await;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            socket
                .send(Message::Text(
                    json!(["AUTH", "challenge-xyz"]).to_string().into(),
                ))
                .await
                .unwrap();

            while let Some(Ok(message)) = socket.next().await {
                let Message::Text(text) = message else {
                    continue;
                };
                let value: Value = serde_json::from_str(&text).unwrap();
                match value.get(0).and_then(Value::as_str) {
                    Some("AUTH") => {}
                    Some("REQ") => {
                        socket
                            .send(Message::Text(
                                json!(["EVENT", "ncc", serde_json::to_value(&served).unwrap()])
                                    .to_string()
                                    .into(),
                            ))
                            .await
                            .unwrap();
                        socket
                            .send(Message::Text(json!(["EOSE", "ncc"]).to_string().into()))
                            .await
                            .unwrap();
                        break;
                    }
                    _ => {}
                }
            }
        });

        let filter = json!({"kinds": [30078], "#d": ["ncc-browser/passwords/v1"]});
        let events = query_authed(&url, &filter, Duration::from_secs(5), &signer_for(keys))
            .await
            .expect("query");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, event.id);
        server.await.unwrap();
    }
}
