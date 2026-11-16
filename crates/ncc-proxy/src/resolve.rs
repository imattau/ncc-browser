//! NCC-05 resolution: turn `(npub, service)` into fetchable endpoints.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nostr::{Alphabet, Event, Filter, Kind, PublicKey, SingleLetterTag};
use serde_json::Value;

use ncc_core::{
    candidate_d_tags, d_tag_source, normalize_endpoints, parse_payload, payload_expiry,
    sort_endpoints, DTagSource, Endpoint,
};

const LOCATOR_KIND: u16 = 30058;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveError {
    InvalidPubkey,
    NoRecord,
    Expired,
    NoEndpoint,
    InvalidPayload,
    RelayError(String),
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPubkey => f.write_str("That is not an npub or hex pubkey"),
            Self::NoRecord => f.write_str("No locator record for this service"),
            Self::Expired => f.write_str("The locator record has expired"),
            Self::NoEndpoint => f.write_str("The locator has no fetchable endpoints"),
            Self::InvalidPayload => f.write_str("The locator payload could not be read"),
            Self::RelayError(detail) => write!(f, "No relay answered: {detail}"),
        }
    }
}

impl std::error::Error for ResolveError {}

/// One service an identity publishes, as seen by discovery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredService {
    pub name: String,
    /// The record offers at least one http(s) endpoint, so it can carry a page.
    pub page: bool,
}

#[derive(Debug, Clone)]
pub struct ResolvedService {
    /// The pubkey exactly as it was addressed (npub or hex).
    pub pubkey: String,
    pub hex_pubkey: String,
    pub service: String,
    pub d_tag: String,
    pub d_tag_source: DTagSource,
    pub event_id: String,
    /// Unix seconds.
    pub updated_at: i64,
    pub expires_at: i64,
    pub endpoints: Vec<Endpoint>,
}

#[derive(Clone)]
struct CacheEntry {
    expires_at: i64,
    result: Result<ResolvedService, ResolveError>,
}

pub struct Resolver {
    relays: Vec<String>,
    timeout: Duration,
    max_cache_seconds: i64,
    negative_cache_seconds: i64,
    cache: Mutex<HashMap<String, CacheEntry>>,
}

impl Resolver {
    pub fn new(relays: Vec<String>) -> Self {
        Self {
            relays,
            timeout: Duration::from_secs(8),
            max_cache_seconds: 60,
            negative_cache_seconds: 15,
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn relays(&self) -> &[String] {
        &self.relays
    }

    pub async fn resolve(
        &self,
        pubkey_input: &str,
        service: &str,
    ) -> Result<ResolvedService, ResolveError> {
        let key = PublicKey::parse(pubkey_input.trim()).map_err(|_| ResolveError::InvalidPubkey)?;
        let hex = key.to_hex();
        let cache_key = format!("{hex}:{service}");
        let now = unix_now();

        if let Some(entry) = self.cache.lock().expect("cache lock").get(&cache_key) {
            if entry.expires_at > now {
                return entry.result.clone();
            }
        }

        let result = self
            .query(key, &hex, pubkey_input.trim(), service, now)
            .await;

        let cached_for = match &result {
            Ok(resolved) => (resolved.expires_at - now).clamp(1, self.max_cache_seconds),
            Err(_) => self.negative_cache_seconds,
        };
        self.cache.lock().expect("cache lock").insert(
            cache_key,
            CacheEntry {
                expires_at: now + cached_for,
                result: result.clone(),
            },
        );

        result
    }

    /// Every service this identity publishes, for when the requested one is missing.
    ///
    /// Costs one relay query, only on the failure path. Each entry also says whether
    /// the record offers an http(s) endpoint, so a caller can tell a page service
    /// from a relay one instead of guessing from the name.
    pub async fn discover_services(&self, pubkey_input: &str) -> Vec<DiscoveredService> {
        let Ok(key) = PublicKey::parse(pubkey_input.trim()) else {
            return Vec::new();
        };
        let filter = Filter::new()
            .kinds([Kind::Custom(LOCATOR_KIND)])
            .author(key)
            .limit(50);
        let Ok(filter) = serde_json::to_value(&filter) else {
            return Vec::new();
        };

        let budget = self.timeout.min(Duration::from_secs(5));
        let events = crate::relay::query_all(&self.relays, &filter, budget).await;

        let mut found: std::collections::BTreeMap<String, (i64, bool)> =
            std::collections::BTreeMap::new();

        for event in &events {
            let Some(d_tag) = identifier(event) else {
                continue;
            };
            let service = d_tag
                .strip_suffix("-locator")
                .map(str::to_string)
                .unwrap_or(d_tag);

            let page = serde_json::from_str::<Value>(&event.content)
                .ok()
                .and_then(|value| parse_payload(&value))
                .map(|payload| {
                    normalize_endpoints(
                        payload.fields.get("endpoints").unwrap_or(&Value::Null),
                        false,
                    )
                    .iter()
                    .any(|endpoint| endpoint.protocol == "http" || endpoint.protocol == "https")
                })
                .unwrap_or(false);

            let created = event.created_at.as_secs() as i64;
            found
                .entry(service)
                .and_modify(|entry| {
                    if created > entry.0 {
                        *entry = (created, page);
                    }
                })
                .or_insert((created, page));
        }

        found
            .into_iter()
            .map(|(name, (_, page))| DiscoveredService { name, page })
            .collect()
    }

    pub fn invalidate(&self, pubkey: &str, service: &str) {
        let Ok(key) = PublicKey::parse(pubkey.trim()) else {
            return;
        };
        self.cache
            .lock()
            .expect("cache lock")
            .remove(&format!("{}:{service}", key.to_hex()));
    }

    async fn query(
        &self,
        key: PublicKey,
        hex: &str,
        pubkey_input: &str,
        service: &str,
        now: i64,
    ) -> Result<ResolvedService, ResolveError> {
        let candidates = candidate_d_tags(Some(service));
        let filter = Filter::new()
            .kinds([Kind::Custom(LOCATOR_KIND)])
            .author(key)
            .custom_tags(SingleLetterTag::lowercase(Alphabet::D), candidates.clone())
            .limit(30);
        let Ok(filter) = serde_json::to_value(&filter) else {
            return Err(ResolveError::InvalidPayload);
        };

        if self.relays.is_empty() {
            return Err(ResolveError::RelayError("no relays configured".into()));
        }

        let events = crate::relay::query_all(&self.relays, &filter, self.timeout).await;
        if events.is_empty() {
            return Err(ResolveError::NoRecord);
        }

        // The publisher can rotate an endpoint by publishing a newer record; the
        // newest `created_at` wins, and a tie is broken by event id so the answer is
        // stable between requests.
        let mut best: Option<(Event, String)> = None;
        for event in events {
            let Some(d_tag) = identifier(&event) else {
                continue;
            };
            if !candidates.iter().any(|candidate| candidate == &d_tag) {
                continue;
            }
            let newer = match &best {
                None => true,
                Some((current, _)) => {
                    (event.created_at, &event.id) > (current.created_at, &current.id)
                }
            };
            if newer {
                best = Some((event, d_tag));
            }
        }

        let Some((event, d_tag)) = best else {
            return Err(ResolveError::NoRecord);
        };

        let payload: Value =
            serde_json::from_str(&event.content).map_err(|_| ResolveError::InvalidPayload)?;
        let payload = parse_payload(&payload).ok_or(ResolveError::InvalidPayload)?;

        let expires_at = payload_expiry(&payload, expiration_tag(&event).as_deref());
        if expires_at <= now {
            return Err(ResolveError::Expired);
        }

        let endpoints = normalize_endpoints(
            payload.fields.get("endpoints").unwrap_or(&Value::Null),
            false,
        );
        if endpoints.is_empty() {
            return Err(ResolveError::NoEndpoint);
        }

        Ok(ResolvedService {
            pubkey: pubkey_input.to_string(),
            hex_pubkey: hex.to_string(),
            service: service.to_string(),
            d_tag_source: d_tag_source(&d_tag, service),
            d_tag,
            event_id: event.id.to_hex(),
            updated_at: payload.updated_at,
            expires_at,
            endpoints: sort_endpoints(&endpoints),
        })
    }
}

fn identifier(event: &Event) -> Option<String> {
    event.tags.iter().find_map(|tag| {
        let slice = tag.as_slice();
        if slice.first().map(String::as_str) == Some("d") {
            slice.get(1).cloned()
        } else {
            None
        }
    })
}

fn expiration_tag(event: &Event) -> Option<String> {
    event.tags.iter().find_map(|tag| {
        let slice = tag.as_slice();
        if slice.first().map(String::as_str) == Some("expiration") {
            slice.get(1).cloned()
        } else {
            None
        }
    })
}

pub fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}
