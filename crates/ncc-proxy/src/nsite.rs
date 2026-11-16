//! NIP-5A sites: manifest resolution, blob verification and serving.
//!
//! A site is a manifest event whose `path` tags map request paths to sha256 hashes;
//! the bytes live on Blossom servers. Nothing is served until the bytes hash to the
//! value the manifest named, which is what makes the cache safe: a hash never changes
//! meaning.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use nostr::{Alphabet, Event, Filter, Kind, PublicKey, SingleLetterTag};

use ncc_core::{
    content_type_for, match_path, nsite_host, PathMatch, NSITE_NAMED_KIND, NSITE_ROOT_KIND,
};

use crate::vhost::Vhost;
use crate::ProxyState;

const CACHE_SECONDS: i64 = 60;
const NEGATIVE_SECONDS: i64 = 15;
const MAX_SERVERS: usize = 8;
const MAX_FILE_BYTES: usize = 25 * 1024 * 1024;
const DEFAULT_CACHE_BYTES: usize = 64 * 1024 * 1024;
const DISK_CACHE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug)]
pub enum NsiteError {
    NoManifest,
    Invalid,
}

impl std::fmt::Display for NsiteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoManifest => f.write_str("No site manifest published by this identity"),
            Self::Invalid => f.write_str("The site manifest could not be read"),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Manifest {
    pub event_id: String,
    pub updated_at: i64,
    pub title: Option<String>,
    pub servers: Vec<String>,
    pub paths: BTreeMap<String, String>,
}

/// One manifest on disk, with the moment it stops being trusted.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct StoredManifest {
    expires_at: i64,
    manifest: Manifest,
}

pub struct NsiteResolver {
    settings: Arc<crate::settings::SettingsStore>,
    timeout: Duration,
    cache: Mutex<HashMap<String, (i64, Manifest)>>,
    misses: Mutex<HashMap<String, i64>>,
    flights: Arc<crate::cache::Flights>,
    /// Where manifests survive a restart; `None` keeps them in memory only.
    directory: Option<PathBuf>,
}

impl NsiteResolver {
    pub fn new(settings: Arc<crate::settings::SettingsStore>) -> Self {
        Self {
            settings,
            timeout: Duration::from_secs(8),
            cache: Mutex::new(HashMap::new()),
            misses: Mutex::new(HashMap::new()),
            flights: Arc::default(),
            directory: None,
        }
    }

    pub fn with_directory(mut self, directory: Option<PathBuf>) -> Self {
        self.directory = directory;
        self
    }

    pub async fn resolve(
        &self,
        pubkey_input: &str,
        site: Option<&str>,
    ) -> Result<Manifest, NsiteError> {
        let key = PublicKey::parse(pubkey_input.trim()).map_err(|_| NsiteError::Invalid)?;
        let hex = key.to_hex();
        let cache_key = format!("{hex}:{}", site.unwrap_or(""));
        let now = crate::resolve::unix_now();
        if self.recently_missed(&cache_key, now) {
            return Err(NsiteError::NoManifest);
        }
        if let Some(manifest) = self.fresh(&cache_key, now) {
            return Ok(manifest);
        }

        // A cold page load asks for several files at once. The first request looks the
        // manifest up; the rest wait here and then find it in the cache.
        let _flight = self.flights.board(&cache_key).await;

        let now = crate::resolve::unix_now();
        if self.recently_missed(&cache_key, now) {
            return Err(NsiteError::NoManifest);
        }
        if let Some(manifest) = self.fresh(&cache_key, now) {
            return Ok(manifest);
        }

        let outcome = self.query(key, &hex, site, now).await;

        match &outcome {
            Ok((manifest, expires)) => {
                let until = (*expires).min(now + CACHE_SECONDS);
                crate::lock(&self.cache).insert(cache_key.clone(), (until, manifest.clone()));
                crate::cache::save(
                    self.directory.as_deref(),
                    &cache_key,
                    &StoredManifest {
                        expires_at: until,
                        manifest: manifest.clone(),
                    },
                );
            }
            Err(_) => {
                crate::lock(&self.misses).insert(cache_key, now + NEGATIVE_SECONDS);
            }
        }

        outcome.map(|(manifest, _)| manifest)
    }

    /// A manifest this session already has, or the copy an earlier one left on disk.
    fn fresh(&self, cache_key: &str, now: i64) -> Option<Manifest> {
        if let Some((expires, manifest)) = crate::lock(&self.cache).get(cache_key) {
            if *expires > now {
                return Some(manifest.clone());
            }
        }

        let stored: StoredManifest = crate::cache::load(self.directory.as_deref(), cache_key)?;
        if stored.expires_at <= now {
            return None;
        }

        crate::lock(&self.cache).insert(
            cache_key.to_string(),
            (stored.expires_at, stored.manifest.clone()),
        );
        Some(stored.manifest)
    }

    fn recently_missed(&self, cache_key: &str, now: i64) -> bool {
        crate::lock(&self.misses)
            .get(cache_key)
            .map(|until| *until > now)
            .unwrap_or(false)
    }

    /// Drop cached manifests and misses, in memory and on disk.
    pub fn clear(&self) {
        crate::lock(&self.cache).clear();
        crate::lock(&self.misses).clear();
        crate::cache::forget(self.directory.clone());
    }

    /// The manifest as stored by an earlier session, tested through `resolve`.
    #[cfg(test)]
    fn store_for_test(&self, cache_key: &str, until: i64, manifest: &Manifest) {
        crate::cache::save(
            self.directory.as_deref(),
            cache_key,
            &StoredManifest {
                expires_at: until,
                manifest: manifest.clone(),
            },
        );
    }

    async fn query(
        &self,
        key: PublicKey,
        hex: &str,
        site: Option<&str>,
        now: i64,
    ) -> Result<(Manifest, i64), NsiteError> {
        let kind = if site.is_some() {
            NSITE_NAMED_KIND
        } else {
            NSITE_ROOT_KIND
        };

        let mut filter = Filter::new()
            .kinds([Kind::Custom(kind)])
            .author(key)
            .limit(20);
        if let Some(site) = site {
            filter = filter.custom_tag(SingleLetterTag::lowercase(Alphabet::D), site);
        }

        let Ok(filter) = serde_json::to_value(&filter) else {
            return Err(NsiteError::Invalid);
        };

        let events = crate::relay::query_all(&self.settings.relays(), &filter, self.timeout).await;

        let mut best: Option<Manifest> = None;
        for event in &events {
            let Some(manifest) = read_manifest(event, hex, site) else {
                continue;
            };
            let newer = match &best {
                None => true,
                Some(current) => manifest.updated_at > current.updated_at,
            };
            if newer {
                best = Some(manifest);
            }
        }

        match best {
            // A manifest has no ttl of its own; confirm it on the next cache miss.
            Some(manifest) => Ok((manifest, now + CACHE_SECONDS)),
            None => Err(NsiteError::NoManifest),
        }
    }
}

fn read_manifest(event: &Event, hex: &str, site: Option<&str>) -> Option<Manifest> {
    let expected = if site.is_some() {
        NSITE_NAMED_KIND
    } else {
        NSITE_ROOT_KIND
    };
    if event.kind.as_u16() != expected || event.pubkey.to_hex() != hex {
        return None;
    }
    if event.verify().is_err() {
        return None;
    }

    if let Some(site) = site {
        let d_tag = event.tags.iter().find_map(|tag| {
            let slice = tag.as_slice();
            (slice.first().map(String::as_str) == Some("d"))
                .then(|| slice.get(1).cloned())
                .flatten()
        });
        if d_tag.as_deref() != Some(site) {
            return None;
        }
    }

    let mut paths: BTreeMap<String, String> = BTreeMap::new();
    let mut servers: Vec<String> = Vec::new();
    let mut title: Option<String> = None;

    for tag in event.tags.iter() {
        let slice = tag.as_slice();
        match slice.first().map(String::as_str) {
            Some("path") => {
                let Some(path) = slice.get(1) else { continue };
                let Some(hash) = slice.get(2) else { continue };
                let hash = hash.to_ascii_lowercase();
                if !path.starts_with('/')
                    || path.contains('\0')
                    || path.split('/').any(|segment| segment == "..")
                {
                    continue;
                }
                if hash.len() != 64 || !hash.chars().all(|character| character.is_ascii_hexdigit())
                {
                    continue;
                }
                paths.entry(path.clone()).or_insert(hash);
            }
            Some("server") => {
                if let Some(url) = slice.get(1) {
                    let url = url.trim_end_matches('/').to_string();
                    if (url.starts_with("https://") || url.starts_with("http://"))
                        && !servers.contains(&url)
                        && servers.len() < MAX_SERVERS
                    {
                        servers.push(url);
                    }
                }
            }
            Some("title") => {
                if let Some(value) = slice.get(1) {
                    title = Some(value.clone());
                }
            }
            _ => {}
        }
    }

    if paths.is_empty() {
        return None;
    }

    Some(Manifest {
        event_id: event.id.to_hex(),
        updated_at: event.created_at.as_secs() as i64,
        title,
        servers,
        paths,
    })
}

struct BlobCache {
    entries: HashMap<String, Vec<u8>>,
    order: Vec<String>,
    total: usize,
}

pub struct Blobs {
    client: reqwest::Client,
    cache: Mutex<BlobCache>,
    max_total: usize,
    /// Where verified blobs survive a restart. Optional: private sessions would pass
    /// `None` so nothing is written down.
    directory: Option<PathBuf>,
}

impl Blobs {
    pub fn new(
        timeout: Duration,
        directory: Option<PathBuf>,
        tls: Option<rustls::ClientConfig>,
    ) -> Self {
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(3))
            .timeout(timeout)
            .user_agent(concat!("NostrNavigator/", env!("CARGO_PKG_VERSION")));
        if let Some(tls) = tls {
            builder = builder.use_preconfigured_tls(tls);
        }

        let client = builder.build().expect("blossom client");

        Self {
            client,
            cache: Mutex::new(BlobCache {
                entries: HashMap::new(),
                order: Vec::new(),
                total: 0,
            }),
            max_total: DEFAULT_CACHE_BYTES,
            directory,
        }
    }

    /// Fetch by hash from the manifest's servers and refuse anything that does not
    /// hash back to it.
    pub async fn get(&self, hash: &str, servers: &[String]) -> Result<Vec<u8>, String> {
        if let Some(bytes) = crate::lock(&self.cache).entries.get(hash).cloned() {
            return Ok(bytes);
        }

        if let Some(bytes) = self.read_disk(hash) {
            self.remember(hash, bytes.clone());
            return Ok(bytes);
        }

        if servers.is_empty() {
            return Err("the manifest lists no Blossom servers".to_string());
        }

        let mut last = "no server answered".to_string();
        for server in servers.iter().take(MAX_SERVERS) {
            let url = format!("{server}/{hash}");
            match self.client.get(&url).send().await {
                Ok(response) => {
                    if !response.status().is_success() {
                        last = format!("{server}: HTTP {}", response.status());
                        continue;
                    }
                    let bytes = match response.bytes().await {
                        Ok(bytes) => bytes,
                        Err(error) => {
                            last = format!("{server}: {error}");
                            continue;
                        }
                    };
                    if bytes.len() > MAX_FILE_BYTES {
                        last = format!("{server}: file larger than {MAX_FILE_BYTES} bytes");
                        continue;
                    }
                    if sha256_hex(&bytes) != hash {
                        last = format!("{server}: content does not match {hash}");
                        continue;
                    }
                    self.remember(hash, bytes.to_vec());
                    self.write_disk(hash, &bytes);
                    return Ok(bytes.to_vec());
                }
                Err(error) => last = format!("{server}: {error}"),
            }
        }

        Err(last)
    }

    fn remember(&self, hash: &str, bytes: Vec<u8>) {
        let mut cache = crate::lock(&self.cache);
        if cache.entries.contains_key(hash) {
            return;
        }

        cache.total += bytes.len();
        cache.order.push(hash.to_string());
        cache.entries.insert(hash.to_string(), bytes);

        while cache.total > self.max_total && !cache.order.is_empty() {
            let victim = cache.order.remove(0);
            if let Some(removed) = cache.entries.remove(&victim) {
                cache.total = cache.total.saturating_sub(removed.len());
            }
        }
    }

    pub fn cached_bytes(&self) -> usize {
        crate::lock(&self.cache).total
    }

    /// Forget every blob, in memory and on disk. Verified bytes are safe to keep, but
    /// a user asking for a clean slate should get one.
    pub fn clear(&self) {
        {
            let mut cache = crate::lock(&self.cache);
            cache.entries.clear();
            cache.order.clear();
            cache.total = 0;
        }

        let Some(directory) = &self.directory else {
            return;
        };
        if let Ok(entries) = std::fs::read_dir(directory) {
            for entry in entries.flatten() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    /// Read a blob back from disk, re-checking its hash: a file on disk is not trusted
    /// just because it is there.
    fn read_disk(&self, hash: &str) -> Option<Vec<u8>> {
        let path = self.directory.as_ref()?.join(hash);
        let bytes = std::fs::read(&path).ok()?;
        if sha256_hex(&bytes) != hash {
            let _ = std::fs::remove_file(&path);
            return None;
        }
        Some(bytes)
    }

    fn write_disk(&self, hash: &str, bytes: &[u8]) {
        let Some(directory) = &self.directory else {
            return;
        };
        if std::fs::create_dir_all(directory).is_err() {
            return;
        }
        if std::fs::write(directory.join(hash), bytes).is_ok() {
            self.evict(directory);
        }
    }

    /// Keep the directory under its cap, dropping the least recently written files.
    fn evict(&self, directory: &std::path::Path) {
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };

        let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = entries
            .flatten()
            .filter_map(|entry| {
                let metadata = entry.metadata().ok()?;
                let modified = metadata.modified().ok()?;
                Some((modified, metadata.len(), entry.path()))
            })
            .collect();

        let mut total: u64 = files.iter().map(|(_, size, _)| *size).sum();
        if total <= DISK_CACHE_BYTES {
            return;
        }

        files.sort_by_key(|(modified, _, _)| *modified);
        for (_, size, path) in files {
            if total <= DISK_CACHE_BYTES {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(size);
            }
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Serve one site request. `path` and `search` come from the browser's URL.
pub async fn serve(
    state: &ProxyState,
    vhost: &Vhost,
    path: &str,
    search: &str,
    method: &Method,
    document: bool,
) -> Response {
    if !matches!(*method, Method::GET | Method::HEAD) {
        return page(StatusCode::METHOD_NOT_ALLOWED, "Sites are read-only");
    }

    let site = vhost.site.as_deref();
    let manifest = match state.nsite().resolve(&vhost.pubkey, site).await {
        Ok(manifest) => manifest,
        Err(error) => {
            return page(
                StatusCode::NOT_FOUND,
                &format!("{error} for {}", display(vhost)),
            )
        }
    };

    let matched = match_path(&manifest.paths, path, search);

    match matched {
        // A manifest can hold any string here, and `header()` panics on one it cannot
        // encode; a malformed redirect must not take the whole connection down.
        PathMatch::Redirect { location } => match HeaderValue::from_str(&location) {
            Ok(value) => Response::builder()
                .status(StatusCode::FOUND)
                .header(header::LOCATION, value)
                .header(header::CACHE_CONTROL, "no-store")
                .body(Body::empty())
                .unwrap_or_else(|_| page(StatusCode::INTERNAL_SERVER_ERROR, "Could not redirect")),
            Err(_) => page(
                StatusCode::BAD_GATEWAY,
                &format!(
                    "The manifest of {} redirects to a location a browser cannot follow: {location}",
                    display(vhost)
                ),
            ),
        },

        PathMatch::File { path, hash } => match state.blobs().get(&hash, &manifest.servers).await {
            Ok(bytes) => response_for(state, vhost, path, bytes, StatusCode::OK, method, document),
            Err(detail) => page(
                StatusCode::BAD_GATEWAY,
                &format!("{detail}\n\nserving {}", display(vhost)),
            ),
        },

        PathMatch::Missing => {
            // A site may ship its own 404 page; NIP-5A allows serving it with 404.
            if let Some(hash) = manifest.paths.get("/404.html") {
                if let Ok(bytes) = state.blobs().get(hash, &manifest.servers).await {
                    return response_for(
                        state,
                        vhost,
                        "/404.html".to_string(),
                        bytes,
                        StatusCode::NOT_FOUND,
                        method,
                        document,
                    );
                }
            }
            page(
                StatusCode::NOT_FOUND,
                &format!("No such file in {}\n\n{}", display(vhost), path),
            )
        }
    }
}

fn response_for(
    state: &ProxyState,
    vhost: &Vhost,
    served_path: String,
    bytes: Vec<u8>,
    status: StatusCode,
    method: &Method,
    document: bool,
) -> Response {
    let content_type = content_type_for(&served_path, None);

    // Sites are pages too: `window.nostr` should exist on them exactly as it does on a
    // service, so the shim goes in on the way out. A download is not a page.
    let bytes = if document && content_type.starts_with("text/html") {
        let html = String::from_utf8_lossy(&bytes);
        crate::server::inject_shim(state, vhost, &html)
            .0
            .into_bytes()
    } else {
        bytes
    };

    let cache = if served_path.ends_with(".html") {
        "no-cache"
    } else {
        "public, max-age=86400"
    };

    let body = if *method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(bytes)
    };

    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, cache)
        .body(body)
        .unwrap_or_else(|_| {
            page(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not build the response",
            )
        })
}

fn display(vhost: &Vhost) -> String {
    match &vhost.site {
        Some(site) => format!("nsite://{}/{}", vhost.pubkey, site),
        None => format!("nsite://{}", vhost.pubkey),
    }
}

fn page(status: StatusCode, detail: &str) -> Response {
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <style>body{{font:15px system-ui;margin:2rem;max-width:40rem}}\
         pre{{white-space:pre-wrap;word-break:break-word;background:#f4f4f4;padding:12px;border-radius:8px}}</style>\
         <h1>{status}</h1><pre>{detail}</pre>"
    );
    (status, Html(body)).into_response()
}

/// Advertising a site's own host, used by the link router.
pub fn host_for(pubkey: &str, site: Option<&str>) -> String {
    nsite_host(pubkey, site)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolver(directory: Option<PathBuf>) -> NsiteResolver {
        // No relays: anything that returns a manifest returned it from disk.
        let settings = crate::settings::SettingsStore::in_memory(crate::settings::Settings {
            relays: Vec::new(),
            ..Default::default()
        });
        NsiteResolver::new(Arc::new(settings)).with_directory(directory)
    }

    /// A directory no other test can delete: tests run in parallel.
    fn directory() -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let id = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("ncc-manifests-{}-{id}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    fn manifest() -> Manifest {
        Manifest {
            event_id: "ab".repeat(32),
            updated_at: 1_700_000_000,
            title: Some("kept".into()),
            servers: vec!["https://blossom.example".into()],
            paths: BTreeMap::from([("/index.html".to_string(), "cd".repeat(32))]),
        }
    }

    #[tokio::test]
    async fn a_manifest_survives_a_restart() {
        let directory = directory();
        let hex = nostr::Keys::generate().public_key().to_hex();
        let key = format!("{hex}:");

        let first = resolver(Some(directory.clone()));
        first.store_for_test(&key, crate::resolve::unix_now() + 30, &manifest());

        // A new resolver stands in for the next launch: memory is empty, the disk copy
        // is not, and there are no relays to fall back on.
        let second = resolver(Some(directory.clone()));
        let resolved = second.resolve(&hex, None).await.expect("from disk");

        assert_eq!(resolved.title.as_deref(), Some("kept"));
        assert_eq!(resolved.event_id, manifest().event_id);

        let _ = std::fs::remove_dir_all(&directory);
    }

    #[tokio::test]
    async fn an_expired_manifest_is_not_used() {
        let directory = directory();
        let hex = nostr::Keys::generate().public_key().to_hex();

        let first = resolver(Some(directory.clone()));
        first.store_for_test(
            &format!("{hex}:"),
            crate::resolve::unix_now() - 1,
            &manifest(),
        );

        let second = resolver(Some(directory.clone()));
        assert!(second.resolve(&hex, None).await.is_err());

        let _ = std::fs::remove_dir_all(&directory);
    }
}
