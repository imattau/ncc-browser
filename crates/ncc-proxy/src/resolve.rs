//! NCC-05 resolution: turn `(npub, service)` into fetchable endpoints.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nostr::{Alphabet, Event, Filter, Kind, PublicKey, SingleLetterTag};
use serde_json::Value;

use ncc_core::{
    candidate_d_tags, d_tag_source, normalize_endpoints, parse_payload, payload_expiry,
    sort_endpoints, DTagSource, Endpoint,
};

const LOCATOR_KIND: u16 = 30058;
/// How many records to try under one `d` tag before falling through to the
/// next candidate.
const MAX_EVENTS_PER_D: usize = 10;

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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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

/// One record on disk, with the moment it stops being trusted.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct StoredRecord {
    expires_at: i64,
    resolved: ResolvedService,
}

pub struct Resolver {
    settings: Arc<crate::settings::SettingsStore>,
    timeout: Duration,
    max_cache_seconds: i64,
    negative_cache_seconds: i64,
    cache: Mutex<HashMap<String, CacheEntry>>,
    flights: Arc<crate::cache::Flights>,
    /// Where records survive a restart; `None` keeps them in memory only.
    directory: Option<PathBuf>,
}

impl Resolver {
    pub fn new(settings: Arc<crate::settings::SettingsStore>) -> Self {
        Self {
            settings,
            timeout: Duration::from_secs(8),
            max_cache_seconds: 60,
            negative_cache_seconds: 15,
            cache: Mutex::new(HashMap::new()),
            flights: Arc::default(),
            directory: None,
        }
    }

    pub fn with_directory(mut self, directory: Option<PathBuf>) -> Self {
        self.directory = directory;
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn relays(&self) -> Vec<String> {
        self.settings.relays()
    }

    pub async fn resolve(
        &self,
        pubkey_input: &str,
        service: &str,
    ) -> Result<ResolvedService, ResolveError> {
        self.resolve_with_transport(pubkey_input, service, false).await
    }

    /// Resolve a relay locator, allowing ws(s) endpoints in the NCC-05 record.
    pub async fn resolve_relay(
        &self,
        pubkey_input: &str,
        service: &str,
    ) -> Result<ResolvedService, ResolveError> {
        self.resolve_with_transport(pubkey_input, service, true).await
    }

    async fn resolve_with_transport(
        &self,
        pubkey_input: &str,
        service: &str,
        allow_ws: bool,
    ) -> Result<ResolvedService, ResolveError> {
        let key = PublicKey::parse(pubkey_input.trim()).map_err(|_| ResolveError::InvalidPubkey)?;
        let hex = key.to_hex();
        let cache_key = format!("{hex}:{service}:{}", if allow_ws { "relay" } else { "web" });
        let now = unix_now();
        if let Some(entry) = self.cached(&cache_key, now) {
            return entry;
        }

        // Several tabs can ask for the same service at once. One relay query answers
        // all of them; the rest wait here and then find it in the cache.
        let _flight = self.flights.board(&cache_key).await;

        let now = unix_now();
        if let Some(entry) = self.cached(&cache_key, now) {
            return entry;
        }

        let result = self
            .query(key, &hex, pubkey_input.trim(), service, now, allow_ws)
            .await;

        let cached_for = match &result {
            Ok(resolved) => (resolved.expires_at - now).clamp(1, self.max_cache_seconds),
            Err(_) => self.negative_cache_seconds,
        };

        let entry = CacheEntry {
            expires_at: now + cached_for,
            result: result.clone(),
        };
        crate::lock(&self.cache).insert(cache_key.clone(), entry);

        if let Ok(resolved) = &result {
            crate::cache::save(
                self.directory.as_deref(),
                &cache_key,
                &StoredRecord {
                    expires_at: now + cached_for,
                    resolved: resolved.clone(),
                },
            );
        }

        result
    }

    /// A record this session already has, or the copy an earlier one left on disk.
    fn cached(&self, cache_key: &str, now: i64) -> Option<Result<ResolvedService, ResolveError>> {
        if let Some(entry) = crate::lock(&self.cache).get(cache_key) {
            if entry.expires_at > now {
                return Some(entry.result.clone());
            }
        }

        let stored: StoredRecord = crate::cache::load(self.directory.as_deref(), cache_key)?;
        if stored.expires_at <= now {
            return None;
        }

        crate::lock(&self.cache).insert(
            cache_key.to_string(),
            CacheEntry {
                expires_at: stored.expires_at,
                result: Ok(stored.resolved.clone()),
            },
        );
        Some(Ok(stored.resolved))
    }

    /// The target identity's NIP-65 read relays, when gossip is on.
    ///
    /// A publisher often publishes a locator to relays their own list names and not to
    /// the browser's defaults, so this is the difference between resolving and not.
    async fn gossip_relays(&self, key: PublicKey, _hex: &str) -> Vec<String> {
        let filter = Filter::new()
            .kinds([Kind::Custom(10002)])
            .author(key)
            .limit(1);
        let Ok(filter) = serde_json::to_value(&filter) else {
            return Vec::new();
        };

        let budget = self.timeout.min(Duration::from_secs(5));
        let events = crate::relay::query_all(&self.settings.relays(), &filter, budget).await;

        let mut relays: Vec<String> = Vec::new();
        for event in &events {
            for tag in event.tags.iter() {
                let slice = tag.as_slice();
                if slice.first().map(String::as_str) != Some("r") {
                    continue;
                }
                let Some(url) = slice.get(1) else { continue };
                // "write" marks a relay the identity publishes to; the rest are readable.
                if slice.get(2).map(String::as_str) == Some("write") {
                    continue;
                }
                let url = url.trim();
                if (url.starts_with("wss://") || url.starts_with("ws://"))
                    && !relays.iter().any(|existing| existing == url)
                {
                    relays.push(url.to_string());
                }
            }
        }

        relays.truncate(8);
        relays
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
        let events = crate::relay::query_all(&self.settings.relays(), &filter, budget).await;

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

    /// Drop every cached record and miss. Used by "clear cache".
    pub fn clear(&self) {
        crate::lock(&self.cache).clear();
        crate::cache::forget(self.directory.clone());
    }

    pub fn invalidate(&self, pubkey: &str, service: &str) {
        let Ok(key) = PublicKey::parse(pubkey.trim()) else {
            return;
        };
        let mut cache = crate::lock(&self.cache);
        let prefix = format!("{}:{service}:", key.to_hex());
        cache.retain(|cache_key, _| !cache_key.starts_with(&prefix));
    }

    async fn query(
        &self,
        key: PublicKey,
        hex: &str,
        pubkey_input: &str,
        service: &str,
        now: i64,
        allow_ws: bool,
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

        let mut relays = self.settings.relays();
        if self.settings.gossip() {
            for relay in self.gossip_relays(key, hex).await {
                if !relays
                    .iter()
                    .any(|existing| existing.eq_ignore_ascii_case(&relay))
                {
                    relays.push(relay);
                }
            }
        }
        if relays.is_empty() {
            return Err(ResolveError::RelayError("no relays configured".into()));
        }

        let events = crate::relay::query_all(&relays, &filter, self.timeout).await;
        if events.is_empty() {
            return Err(ResolveError::NoRecord);
        }

        select_locator(
            &events,
            pubkey_input,
            hex,
            service,
            &candidates,
            now,
            allow_ws,
        )
    }
}

/// Pick the record for `service` out of everything the relay query returned.
///
/// `candidates` is a specificity ladder (`<service>`, `<service>-locator`, then
/// the default `addr` record), and that ladder decides the winner: each
/// candidate's newest usable record is tried before the next candidate is
/// considered. Recency never crosses a candidate boundary.
///
/// This used to pick the newest event across *all* candidates, which made the
/// `addr` fallback shadow every named service on publishers that refresh it
/// last -- and ncc-server's provisioner does exactly that (web, relay, npanel,
/// ditto, search, then addr), so `/search` on Android resolved to the welcome
/// page while desktop, which already walked the ladder in order, resolved it
/// correctly. Validating each record before moving on also means an expired or
/// malformed exact record falls through to the next candidate instead of
/// failing the whole lookup.
fn select_locator(
    events: &[Event],
    pubkey_input: &str,
    hex: &str,
    service: &str,
    candidates: &[String],
    now: i64,
    allow_ws: bool,
) -> Result<ResolvedService, ResolveError> {
    let mut by_tag: HashMap<&str, Vec<&Event>> = HashMap::new();
    for event in events {
        let Some(d_tag) = identifier(event) else {
            continue;
        };
        if let Some(candidate) = candidates.iter().find(|candidate| **candidate == d_tag) {
            by_tag.entry(candidate.as_str()).or_default().push(event);
        }
    }
    for bucket in by_tag.values_mut() {
        // The publisher can rotate an endpoint by publishing a newer record;
        // newest wins, and a tie is broken by event id so answers are stable.
        bucket.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
    }

    let mut saw_expired = false;
    let mut saw_no_endpoint = false;
    let mut saw_invalid = false;

    for candidate in candidates {
        let Some(bucket) = by_tag.get(candidate.as_str()) else {
            continue;
        };

        for event in bucket.iter().take(MAX_EVENTS_PER_D) {
            let payload: Value = match serde_json::from_str(&event.content) {
                Ok(payload) => payload,
                Err(_) => {
                    saw_invalid = true;
                    continue;
                }
            };
            let Some(payload) = parse_payload(&payload) else {
                saw_invalid = true;
                continue;
            };

            let expires_at = payload_expiry(&payload, expiration_tag(event).as_deref());
            if expires_at <= now {
                saw_expired = true;
                continue;
            }

            let endpoints = normalize_endpoints(
                payload.fields.get("endpoints").unwrap_or(&Value::Null),
                allow_ws,
            );
            if endpoints.is_empty() {
                saw_no_endpoint = true;
                continue;
            }

            return Ok(ResolvedService {
                pubkey: pubkey_input.to_string(),
                hex_pubkey: hex.to_string(),
                service: service.to_string(),
                d_tag: (*candidate).clone(),
                d_tag_source: d_tag_source(candidate, service),
                event_id: event.id.to_hex(),
                updated_at: payload.updated_at,
                expires_at,
                endpoints: sort_endpoints(&endpoints),
            });
        }
    }

    if saw_expired {
        Err(ResolveError::Expired)
    } else if saw_no_endpoint {
        Err(ResolveError::NoEndpoint)
    } else if saw_invalid {
        Err(ResolveError::InvalidPayload)
    } else {
        Err(ResolveError::NoRecord)
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

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Tag, Timestamp};

    /// A signed NCC-05 locator for `d`, with one https endpoint.
    fn locator(keys: &Keys, d: &str, created_at: i64, url: &str, ttl: i64) -> Event {
        let payload = serde_json::json!({
            "ttl": ttl,
            "updated_at": created_at,
            "endpoints": [{
                "url": url,
                "protocol": "https",
                "family": "ipv4",
                "priority": 1,
            }],
        });
        EventBuilder::new(Kind::Custom(LOCATOR_KIND), payload.to_string())
            .tags([Tag::parse(["d", d]).unwrap()])
            .custom_created_at(Timestamp::from(created_at.max(0) as u64))
            .sign_with_keys(keys)
            .unwrap()
    }

    fn select(events: &[Event], service: &str, now: i64) -> Result<ResolvedService, ResolveError> {
        let hex = "ab".repeat(32);
        select_locator(
            events,
            &hex,
            &hex,
            service,
            &candidate_d_tags(Some(service)),
            now,
            false,
        )
    }

    // ncc-server's provisioner creates named services first and `addr` last, so
    // `addr` is normally the newest locator on an identity. Ordering by
    // `created_at` across every candidate made Android resolve `/search` to the
    // welcome page; the candidate ladder must win over recency.
    #[test]
    fn a_refreshed_addr_record_does_not_shadow_a_named_service() {
        let keys = Keys::generate();
        let now = unix_now();

        let search = locator(
            &keys,
            "search-locator",
            now - 10,
            "https://example.com:8447/",
            3600,
        );
        let addr = locator(&keys, "addr", now - 5, "https://example.com:8443/", 3600);

        let resolved = select(&[search, addr], "search", now).expect("resolves the named service");

        assert_eq!(resolved.d_tag, "search-locator");
        assert_eq!(resolved.d_tag_source, DTagSource::LocatorSuffix);
        assert_eq!(resolved.endpoints[0].url, "https://example.com:8447/");
    }

    #[test]
    fn an_exact_record_beats_a_newer_sidecar_suffix_record() {
        let keys = Keys::generate();
        let now = unix_now();

        let exact = locator(&keys, "search", now - 30, "https://example.com:9000/", 3600);
        let suffix = locator(
            &keys,
            "search-locator",
            now - 5,
            "https://example.com:8447/",
            3600,
        );

        let resolved = select(&[exact, suffix], "search", now).expect("resolves");
        assert_eq!(resolved.d_tag_source, DTagSource::Exact);
        assert_eq!(resolved.endpoints[0].url, "https://example.com:9000/");
    }

    #[test]
    fn newest_record_wins_within_one_candidate() {
        let keys = Keys::generate();
        let now = unix_now();

        let older = locator(
            &keys,
            "search-locator",
            now - 30,
            "https://old.example/",
            3600,
        );
        let newer = locator(
            &keys,
            "search-locator",
            now - 5,
            "https://new.example/",
            3600,
        );

        let resolved = select(&[older, newer], "search", now).expect("resolves");
        assert_eq!(resolved.endpoints[0].url, "https://new.example/");
    }

    // A broken exact/suffix record must not fail the lookup when a lower
    // candidate is still usable.
    #[test]
    fn an_expired_named_record_falls_through_to_addr() {
        let keys = Keys::generate();
        let now = unix_now();

        let expired = locator(
            &keys,
            "search-locator",
            now - 100,
            "https://old.example/",
            10,
        );
        let addr = locator(&keys, "addr", now - 5, "https://example.com:8443/", 3600);

        let resolved = select(&[expired, addr], "search", now).expect("falls back to addr");
        assert_eq!(resolved.d_tag, "addr");
        assert_eq!(resolved.d_tag_source, DTagSource::Default);
    }

    #[test]
    fn a_malformed_named_record_falls_through_to_the_next_candidate() {
        let keys = Keys::generate();
        let now = unix_now();

        let broken = EventBuilder::new(Kind::Custom(LOCATOR_KIND), "not json")
            .tags([Tag::parse(["d", "search-locator"]).unwrap()])
            .custom_created_at(Timestamp::from((now - 5).max(0) as u64))
            .sign_with_keys(&keys)
            .unwrap();
        let addr = locator(&keys, "addr", now - 10, "https://example.com:8443/", 3600);

        let resolved = select(&[broken, addr], "search", now).expect("falls back to addr");
        assert_eq!(resolved.d_tag, "addr");
    }

    #[test]
    fn the_default_service_uses_only_the_addr_record() {
        let keys = Keys::generate();
        let now = unix_now();

        let addr = locator(&keys, "addr", now - 5, "https://example.com:8443/", 3600);
        let web = locator(
            &keys,
            "web-locator",
            now - 1,
            "https://example.com:8443/",
            3600,
        );

        let resolved = select(&[addr, web], "addr", now).expect("resolves the root");
        assert_eq!(resolved.d_tag, "addr");
        assert_eq!(resolved.d_tag_source, DTagSource::Exact);
    }

    #[test]
    fn nothing_usable_reports_why() {
        let keys = Keys::generate();
        let now = unix_now();

        let expired = locator(
            &keys,
            "search-locator",
            now - 100,
            "https://old.example/",
            10,
        );
        assert_eq!(
            select(&[expired], "search", now).unwrap_err(),
            ResolveError::Expired
        );

        let no_endpoints = EventBuilder::new(
            Kind::Custom(LOCATOR_KIND),
            serde_json::json!({ "ttl": 600, "updated_at": now, "endpoints": [] }).to_string(),
        )
        .tags([Tag::parse(["d", "search-locator"]).unwrap()])
        .custom_created_at(Timestamp::from((now - 5).max(0) as u64))
        .sign_with_keys(&keys)
        .unwrap();
        assert_eq!(
            select(&[no_endpoints], "search", now).unwrap_err(),
            ResolveError::NoEndpoint
        );

        assert_eq!(
            select(&[], "search", now).unwrap_err(),
            ResolveError::NoRecord
        );
    }

    /// A directory no other test can delete: tests run in parallel.
    fn directory() -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let id = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("ncc-records-{}-{id}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    fn resolver(directory: Option<PathBuf>) -> Resolver {
        // No relays: anything that resolves came from disk.
        let settings = crate::settings::SettingsStore::in_memory(crate::settings::Settings {
            relays: Vec::new(),
            ..Default::default()
        });
        Resolver::new(Arc::new(settings)).with_directory(directory)
    }

    fn record(hex: &str) -> ResolvedService {
        ResolvedService {
            pubkey: hex.to_string(),
            hex_pubkey: hex.to_string(),
            service: "web".into(),
            d_tag: "web".into(),
            d_tag_source: DTagSource::Exact,
            event_id: "ab".repeat(32),
            updated_at: 1_700_000_000,
            expires_at: unix_now() + 600,
            endpoints: vec![Endpoint {
                url: "https://example.com/".into(),
                protocol: "https".into(),
                priority: 0,
                family: ncc_core::EndpointFamily::Ipv4,
                k: None,
            }],
        }
    }

    fn store(directory: &std::path::Path, key: &str, expires_at: i64, resolved: &ResolvedService) {
        crate::cache::save(
            Some(directory),
            key,
            &StoredRecord {
                expires_at,
                resolved: resolved.clone(),
            },
        );
    }

    #[tokio::test]
    async fn a_record_survives_a_restart() {
        let directory = directory();
        let hex = nostr::Keys::generate().public_key().to_hex();
        let key = format!("{hex}:web:web");

        store(&directory, &key, unix_now() + 30, &record(&hex));

        let reopened = resolver(Some(directory.clone()));
        let resolved = reopened.resolve(&hex, "web").await.expect("from disk");

        assert_eq!(resolved.event_id, record(&hex).event_id);
        assert_eq!(resolved.endpoints, record(&hex).endpoints);

        let _ = std::fs::remove_dir_all(&directory);
    }

    #[tokio::test]
    async fn an_expired_record_is_not_used() {
        let directory = directory();
        let hex = nostr::Keys::generate().public_key().to_hex();
        let key = format!("{hex}:web:web");

        store(&directory, &key, unix_now() - 1, &record(&hex));

        let reopened = resolver(Some(directory.clone()));
        assert!(reopened.resolve(&hex, "web").await.is_err());

        let _ = std::fs::remove_dir_all(&directory);
    }
}
