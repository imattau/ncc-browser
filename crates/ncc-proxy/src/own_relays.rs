//! Which relays the user's own data goes to.
//!
//! The password vault and browser-data sync read and write the same relays, and the
//! desktop build uses the user's NIP-65 write relays as well as the configured list.
//! This is that rule for the Android shell, so a login saved on one device is looked
//! for on the relays the other device published to.
//!
//! * A dedicated vault relay wins: it is used alone.
//! * Otherwise the configured relays, plus the write relays from the user's newest
//!   kind 10002 event unless `useNip65` is off. At most twelve.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use nostr::Event;
use serde_json::json;

use crate::relay;
use crate::settings::Settings;

const MAX_RELAYS: usize = 12;
const MAX_WRITE_RELAYS: usize = 8;
const LOOKUP_WAIT: Duration = Duration::from_secs(4);
/// How long a lookup is remembered. A miss is remembered briefly so a dead relay list
/// does not cost every sync the lookup timeout.
const HIT_TTL: Duration = Duration::from_secs(10 * 60);
const MISS_TTL: Duration = Duration::from_secs(60);

/// The relays a kind 10002 event publishes to: every `r` tag not marked `read`.
pub fn extract_write_relays(event: &Event) -> Vec<String> {
    if event.kind.as_u16() != 10002 {
        return Vec::new();
    }
    let mut relays: Vec<String> = Vec::new();
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        if parts.len() < 2 || parts[0] != "r" || parts.get(2).map(String::as_str) == Some("read")
        {
            continue;
        }
        let url = parts[1].trim().trim_end_matches('/').to_string();
        if (url.starts_with("wss://") || url.starts_with("ws://")) && !relays.contains(&url) {
            relays.push(url);
        }
    }
    relays.truncate(MAX_WRITE_RELAYS);
    relays
}

/// The configured relays first, then the discovered ones, without repeats.
pub fn merge_relays(configured: &[String], discovered: &[String]) -> Vec<String> {
    let mut merged: Vec<String> = Vec::new();
    for url in configured.iter().chain(discovered.iter()) {
        if !merged.contains(url) {
            merged.push(url.clone());
        }
    }
    merged.truncate(MAX_RELAYS);
    merged
}

struct Lookup {
    pubkey: String,
    configured: Vec<String>,
    write: Vec<String>,
    at: Instant,
}

#[derive(Default)]
pub struct OwnRelays {
    cache: Mutex<Option<Lookup>>,
}

impl OwnRelays {
    fn cache(&self) -> std::sync::MutexGuard<'_, Option<Lookup>> {
        self.cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// What is known without asking anyone: for showing the list in the settings.
    pub fn known(&self, settings: &Settings) -> Vec<String> {
        let dedicated = settings.passwords.vault_relay.trim();
        if !dedicated.is_empty() {
            return vec![dedicated.to_string()];
        }
        let write = if settings.passwords.use_nip65 {
            self.cache()
                .as_ref()
                .filter(|lookup| lookup.configured == settings.relays)
                .map(|lookup| lookup.write.clone())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        merge_relays(&settings.relays, &write)
    }

    /// The relays to read from and publish to for `pubkey`.
    pub async fn resolve(&self, settings: &Settings, pubkey: &str) -> Vec<String> {
        let dedicated = settings.passwords.vault_relay.trim();
        if !dedicated.is_empty() {
            return vec![dedicated.to_string()];
        }
        if !settings.passwords.use_nip65 || settings.relays.is_empty() {
            return settings.relays.clone();
        }

        let cached = {
            let cache = self.cache();
            cache.as_ref().and_then(|lookup| {
                let ttl = if lookup.write.is_empty() {
                    MISS_TTL
                } else {
                    HIT_TTL
                };
                (lookup.pubkey == pubkey
                    && lookup.configured == settings.relays
                    && lookup.at.elapsed() < ttl)
                    .then(|| lookup.write.clone())
            })
        };
        let write = match cached {
            Some(write) => write,
            None => {
                let write = discover(&settings.relays, pubkey).await;
                *self.cache() = Some(Lookup {
                    pubkey: pubkey.to_string(),
                    configured: settings.relays.clone(),
                    write: write.clone(),
                    at: Instant::now(),
                });
                write
            }
        };
        merge_relays(&settings.relays, &write)
    }
}

/// The write relays from the user's newest relay list, asked of the configured relays.
async fn discover(configured: &[String], pubkey: &str) -> Vec<String> {
    let filter = json!({"kinds": [10002], "authors": [pubkey], "limit": 5});
    let events = relay::query_all(configured, &filter, LOOKUP_WAIT).await;
    events
        .into_iter()
        .filter(|event| event.kind.as_u16() == 10002 && event.pubkey.to_hex() == pubkey)
        .max_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| b.id.to_hex().cmp(&a.id.to_hex()))
        })
        .map(|event| extract_write_relays(&event))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    fn relay_list(keys: &Keys, tags: &[&[&str]]) -> Event {
        EventBuilder::new(Kind::Custom(10002), "")
            .tags(tags.iter().map(|tag| Tag::parse(tag.iter().copied()).unwrap()))
            .sign_with_keys(keys)
            .unwrap()
    }

    #[test]
    fn write_relays_skip_read_only_and_bad_urls() {
        let keys = Keys::generate();
        let event = relay_list(
            &keys,
            &[
                &["r", "wss://write.example/"],
                &["r", "wss://both.example", "write"],
                &["r", "wss://read.example", "read"],
                &["r", "https://not-a-relay.example"],
                &["r", "wss://write.example"],
            ],
        );
        assert_eq!(
            extract_write_relays(&event),
            vec!["wss://write.example", "wss://both.example"]
        );
    }

    #[test]
    fn only_kind_10002_counts() {
        let keys = Keys::generate();
        let event = EventBuilder::new(Kind::TextNote, "")
            .tags([Tag::parse(["r", "wss://x.example"]).unwrap()])
            .sign_with_keys(&keys)
            .unwrap();
        assert!(extract_write_relays(&event).is_empty());
    }

    #[test]
    fn configured_relays_come_first_and_the_list_is_capped() {
        let configured = vec!["wss://a".to_string(), "wss://b".to_string()];
        let discovered: Vec<String> = (0..20).map(|i| format!("wss://d{i}")).collect();
        let merged = merge_relays(&configured, &discovered);
        assert_eq!(&merged[..2], ["wss://a", "wss://b"]);
        assert_eq!(merged.len(), MAX_RELAYS);
        assert_eq!(
            merge_relays(&configured, &["wss://a".to_string()]),
            configured
        );
    }

    #[tokio::test]
    async fn a_dedicated_relay_is_used_alone_and_nip65_can_be_turned_off() {
        let own = OwnRelays::default();
        let mut settings = Settings {
            relays: vec!["wss://configured".into()],
            ..Default::default()
        };
        settings.passwords.vault_relay = "wss://vault".into();
        assert_eq!(own.resolve(&settings, "pk").await, vec!["wss://vault"]);

        settings.passwords.vault_relay = String::new();
        settings.passwords.use_nip65 = false;
        assert_eq!(own.resolve(&settings, "pk").await, vec!["wss://configured"]);
        assert_eq!(own.known(&settings), vec!["wss://configured"]);
    }

    /// A relay that answers every request with one stored event.
    async fn relay_serving(event: Event) -> String {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("ws://127.0.0.1:{}", listener.local_addr().unwrap().port());
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let event = event.clone();
                tokio::spawn(async move {
                    let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                        return;
                    };
                    while let Some(Ok(Message::Text(text))) = socket.next().await {
                        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                            continue;
                        };
                        if value.get(0).and_then(|v| v.as_str()) == Some("REQ") {
                            let sub = value[1].clone();
                            let _ = socket
                                .send(Message::Text(
                                    json!(["EVENT", sub, event]).to_string().into(),
                                ))
                                .await;
                            let _ = socket
                                .send(Message::Text(json!(["EOSE", sub]).to_string().into()))
                                .await;
                        }
                    }
                });
            }
        });
        url
    }

    #[tokio::test]
    async fn the_users_write_relays_are_added_to_the_configured_ones() {
        let keys = Keys::generate();
        let event = relay_list(
            &keys,
            &[&["r", "wss://mine.example"], &["r", "wss://read.example", "read"]],
        );
        let url = relay_serving(event).await;
        let settings = Settings {
            relays: vec![url.clone()],
            ..Default::default()
        };
        let own = OwnRelays::default();
        let resolved = own.resolve(&settings, &keys.public_key().to_hex()).await;
        assert_eq!(resolved, vec![url.clone(), "wss://mine.example".to_string()]);
        // Remembered: the settings can show it without another lookup.
        assert_eq!(own.known(&settings), resolved);

        // Someone else's relay list is not mine.
        let other = Keys::generate();
        let fresh = OwnRelays::default();
        assert_eq!(
            fresh.resolve(&settings, &other.public_key().to_hex()).await,
            vec![url]
        );
    }
}
