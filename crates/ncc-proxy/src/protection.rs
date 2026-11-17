//! Shared ad and tracker filtering engine used by the Android WebView bridge.

use std::{
    path::Path,
    sync::{
        OnceLock, RwLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use adblock::{Engine, FilterSet, lists::ParseOptions, request::Request};

use crate::settings::{ProtectionLevel, ProtectionSettings};

// Keep a useful baseline available before the full lists download on first launch,
// and whenever the device is offline. Standard must still block the major ad networks
// in that state instead of silently acting like protection is disabled.
const FALLBACK_FILTERS: &str = "||doubleclick.net^\n\
||googlesyndication.com^\n\
||googleadservices.com^\n\
||adservice.google.com^\n\
||pagead2.googlesyndication.com^\n\
||google-analytics.com^\n\
||facebook.net^\n\
||adnxs.com^\n\
||adsrvr.org^\n\
||taboola.com^\n\
||outbrain.com^\n\
||criteo.com^\n\
||rubiconproject.com^\n\
||pubmatic.com^\n\
||openx.net^\n\
||casalemedia.com^\n\
||smartadserver.com^\n\
||amazon-adsystem.com^\n\
||moatads.com^\n\
||scorecardresearch.com^\n\
||advertising.com^\n\
||adcolony.com^\n\
||unityads.unity3d.com^\n";
struct FilterList { file: &'static str, url: &'static str, privacy: bool }
const LISTS: &[FilterList] = &[
    FilterList { file: "easylist.txt", url: "https://easylist.to/easylist/easylist.txt", privacy: false },
    FilterList { file: "ubo-filters.txt", url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt", privacy: false },
    FilterList { file: "brave-specific.txt", url: "https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-specific.txt", privacy: false },
    FilterList { file: "brave-unbreak.txt", url: "https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-unbreak.txt", privacy: false },
    FilterList { file: "brave-android.txt", url: "https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-android-specific.txt", privacy: false },
    FilterList { file: "easyprivacy.txt", url: "https://easylist.to/easylist/easyprivacy.txt", privacy: true },
    FilterList { file: "ubo-privacy.txt", url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt", privacy: true },
];

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterStatus {
    pub loaded_lists: usize,
    pub total_lists: usize,
    pub updating: bool,
    pub updated_at: Option<u64>,
    pub error: Option<String>,
}

impl Default for FilterStatus {
    fn default() -> Self {
        Self { loaded_lists: 0, total_lists: LISTS.len(), updating: false, updated_at: None, error: None }
    }
}

static STANDARD_ENGINE: OnceLock<RwLock<Engine>> = OnceLock::new();
static STRICT_ENGINE: OnceLock<RwLock<Engine>> = OnceLock::new();
static CONFIG: OnceLock<RwLock<ProtectionSettings>> = OnceLock::new();
static BLOCKED: AtomicU64 = AtomicU64::new(0);
static SESSION_EXCEPTIONS: OnceLock<
    RwLock<std::collections::HashMap<String, std::collections::HashSet<String>>>,
> = OnceLock::new();
static FILTER_STATUS: OnceLock<RwLock<FilterStatus>> = OnceLock::new();

fn standard_engine() -> &'static RwLock<Engine> {
    STANDARD_ENGINE.get_or_init(|| RwLock::new(compile(&[FALLBACK_FILTERS.to_string()])))
}

fn strict_engine() -> &'static RwLock<Engine> {
    STRICT_ENGINE.get_or_init(|| RwLock::new(compile(&[FALLBACK_FILTERS.to_string()])))
}

fn config() -> &'static RwLock<ProtectionSettings> {
    CONFIG.get_or_init(|| RwLock::new(ProtectionSettings::default()))
}

fn filter_status_store() -> &'static RwLock<FilterStatus> {
    FILTER_STATUS.get_or_init(|| RwLock::new(FilterStatus::default()))
}

pub fn filter_status() -> FilterStatus {
    filter_status_store().read().map(|status| status.clone()).unwrap_or_default()
}

fn compile(lists: &[String]) -> Engine {
    let mut filters = FilterSet::new(false);
    for list in lists {
        filters.add_filter_list(list.clone(), ParseOptions::default());
    }
    Engine::new_with_filter_set(filters)
}

pub fn set_config(settings: ProtectionSettings) {
    if let Ok(mut current) = config().write() {
        *current = settings;
    }
}

pub fn level() -> ProtectionLevel {
    config()
        .read()
        .map(|value| value.level)
        .unwrap_or(ProtectionLevel::Standard)
}

pub fn blocked_count() -> u64 {
    BLOCKED.load(Ordering::Relaxed)
}

fn session_exceptions()
-> &'static RwLock<std::collections::HashMap<String, std::collections::HashSet<String>>> {
    SESSION_EXCEPTIONS.get_or_init(|| RwLock::new(std::collections::HashMap::new()))
}

pub fn set_session_exception(kind: &str, origin: &str, allowed: bool) {
    if kind != "private" && kind != "tor" {
        return;
    }
    if let Ok(mut entries) = session_exceptions().write() {
        let sites = entries.entry(kind.to_string()).or_default();
        if allowed {
            sites.insert(origin.to_string());
        } else {
            sites.remove(origin);
        }
    }
}

pub fn clear_session_exceptions(kind: &str) {
    if let Ok(mut entries) = session_exceptions().write() {
        entries.remove(kind);
    }
}

pub fn has_exception(kind: &str, origin: &str) -> bool {
    if kind == "normal" {
        return config()
            .read()
            .map(|value| value.site_exceptions.iter().any(|entry| entry == origin))
            .unwrap_or(false);
    }
    session_exceptions()
        .read()
        .ok()
        .and_then(|entries| entries.get(kind).map(|sites| sites.contains(origin)))
        .unwrap_or(false)
}

pub fn cosmetic_selectors(url: &str, kind: &str) -> Vec<String> {
    let selected_level = level();
    if selected_level == ProtectionLevel::Off {
        return Vec::new();
    }
    let origin = url::Url::parse(url).ok().map(|value| value.origin().ascii_serialization());
    if origin.as_ref().is_some_and(|origin| has_exception(kind, origin)) {
        return Vec::new();
    }
    let engine = if selected_level == ProtectionLevel::Strict { strict_engine() } else { standard_engine() };
    let Ok(resources) = engine.read() else {
        return Vec::new();
    };
    resources
        .url_cosmetic_resources(url)
        .hide_selectors
        .into_iter()
        .collect()
}

pub fn check_request(
    url: &str,
    source: &str,
    request_type: &str,
    method: &str,
    kind: &str,
) -> bool {
    let settings = match config().read() {
        Ok(value) => value.clone(),
        Err(_) => return false,
    };
    if settings.level == ProtectionLevel::Off {
        return false;
    }
    let source_origin = if request_type == "document" {
        url::Url::parse(url)
    } else {
        url::Url::parse(source)
    }
    .ok()
    .map(|value| value.origin().ascii_serialization());
    if source_origin
        .as_ref()
        .is_some_and(|origin| has_exception(kind, origin))
    {
        return false;
    }
    if settings.block_scripts && request_type == "script" {
        return true;
    }
    let Ok(request) = Request::new(
        url,
        if source.is_empty() { url } else { source },
        request_type,
        method,
    ) else {
        return false;
    };
    let engine = if settings.level == ProtectionLevel::Strict {
        strict_engine()
    } else {
        standard_engine()
    };
    let blocked = engine
        .read()
        .map(|value| value.check_network_request(&request).should_block())
        .unwrap_or(false);
    if blocked {
        BLOCKED.fetch_add(1, Ordering::Relaxed);
    }
    blocked
}

/// Load the last known good rules synchronously before any WebView can navigate.
pub fn load_cached_lists(cache_dir: &Path) {
    let mut standard = vec![FALLBACK_FILTERS.to_string()];
    let mut strict = vec![FALLBACK_FILTERS.to_string()];
    let mut loaded_lists = 0;
    let mut updated_at = None;
    for list in LISTS {
        let path = cache_dir.join(list.file);
        if let Ok(text) = std::fs::read_to_string(&path) {
            if text.len() < 100 || text.len() > 12_000_000 { continue; }
            if list.privacy { strict.push(text); } else { standard.push(text.clone()); strict.push(text); }
            loaded_lists += 1;
            if let Ok(modified) = std::fs::metadata(path).and_then(|metadata| metadata.modified()) {
                let stamp = modified.duration_since(UNIX_EPOCH).ok().map(|duration| duration.as_secs());
                updated_at = updated_at.max(stamp);
            }
        }
    }
    if let Ok(mut current) = standard_engine().write() { *current = compile(&standard); }
    if let Ok(mut current) = strict_engine().write() { *current = compile(&strict); }
    if let Ok(mut status) = filter_status_store().write() {
        status.loaded_lists = loaded_lists;
        status.updated_at = updated_at;
    }
}

/// Download one list into the cache; the file name when it could not be updated.
async fn fetch_list(
    client: reqwest::Client,
    cache_dir: std::path::PathBuf,
    file: &'static str,
    url: &'static str,
) -> Option<&'static str> {
    let result = async {
        let response = client.get(url).send().await.ok()?;
        if !response.status().is_success() { return None; }
        let body = response.text().await.ok()?;
        if !(100..=12_000_000).contains(&body.len()) { return None; }
        let temporary = cache_dir.join(format!("{file}.tmp"));
        if std::fs::write(&temporary, &body).is_err()
            || std::fs::rename(&temporary, cache_dir.join(file)).is_err() {
            return None;
        }
        Some(())
    }.await;
    result.is_none().then_some(file)
}

/// Loads cached lists immediately, then refreshes them from maintained upstreams.
pub async fn refresh_lists(cache_dir: &Path) {
    let _ = std::fs::create_dir_all(cache_dir);
    {
        let Ok(mut status) = filter_status_store().write() else { return; };
        if status.updating { return; }
        status.updating = true;
        status.error = None;
    }
    load_cached_lists(cache_dir);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build();
    let Ok(client) = client else {
        if let Ok(mut status) = filter_status_store().write() { status.updating = false; status.error = Some("Could not start the filter-list updater".into()); }
        return;
    };
    // A named async fn rather than a closure returning an async block: the closure form
    // trips rustc's "FnOnce is not general enough" error once the future is spawned.
    // Three at a time, without a stream adapter: those lose the 'static lifetimes and
    // then fail the Send bound.
    let mut failures: Vec<&'static str> = Vec::new();
    for batch in LISTS.chunks(3) {
        let downloads = batch
            .iter()
            .map(|list| fetch_list(client.clone(), cache_dir.to_path_buf(), list.file, list.url))
            .collect::<Vec<_>>();
        failures.extend(futures_util::future::join_all(downloads).await.into_iter().flatten());
    }
    load_cached_lists(cache_dir);
    if let Ok(mut status) = filter_status_store().write() {
        status.updating = false;
        if failures.is_empty() {
            status.error = None;
        } else {
            status.error = Some(format!("Could not update {} of {} lists; saved lists remain active", failures.len(), LISTS.len()));
        }
    }
}

/// Keep list downloads bounded on startup while refreshing missing/stale lists daily.
pub async fn refresh_lists_if_stale(cache_dir: &Path) {
    let now = SystemTime::now();
    let fresh = LISTS.iter().all(|list| {
        std::fs::metadata(cache_dir.join(list.file))
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age < std::time::Duration::from_secs(24 * 60 * 60))
    });
    if !fresh {
        refresh_lists(cache_dir).await;
    }
}
