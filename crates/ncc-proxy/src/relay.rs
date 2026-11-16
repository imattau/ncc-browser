//! Minimal Nostr relay client for locator queries.
//!
//! One connection per query, opened with a `REQ`, closed after `EOSE` or a deadline.
//! The desktop build keeps a long-lived pool; that matters for latency, not for
//! correctness, and a browser only queries when its cache misses.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use nostr::Event;
use serde_json::{json, Value};
use tokio::time::{timeout, Instant};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

const SUBSCRIPTION: &str = "ncc";

/// Query one relay and return every verified event it sent before `EOSE` or `wait`.
pub async fn query(relay: &str, filter: &Value, wait: Duration) -> Result<Vec<Event>, String> {
    let deadline = Instant::now() + wait;

    let (socket, _) = timeout(wait, connect_async(relay))
        .await
        .map_err(|_| format!("{relay}: connect timed out"))?
        .map_err(|error| format!("{relay}: {error}"))?;

    let (mut sink, mut stream) = socket.split();
    let request = json!(["REQ", SUBSCRIPTION, filter]).to_string();
    sink.send(Message::Text(request.into()))
        .await
        .map_err(|error| format!("{relay}: {error}"))?;

    let mut events = Vec::new();
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
            Some("EOSE") | Some("CLOSED") | Some("NOTICE") => break,
            _ => {}
        }
    }

    let close = json!(["CLOSE", SUBSCRIPTION]).to_string();
    let _ = sink.send(Message::Text(close.into())).await;
    let _ = sink.close().await;

    Ok(events)
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
