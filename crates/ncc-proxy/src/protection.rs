//! Shared ad and tracker filtering engine used by the Android WebView bridge.

use std::{
    path::Path,
    sync::{
        OnceLock, RwLock,
        atomic::{AtomicU64, Ordering},
    },
};

use adblock::{Engine, FilterSet, lists::ParseOptions, request::Request};

use crate::settings::{ProtectionLevel, ProtectionSettings};

const FALLBACK_FILTERS: &str =
    "||doubleclick.net^\n||googlesyndication.com^\n||google-analytics.com^\n||facebook.net^\n";
const LISTS: &[(&str, &str)] = &[
    ("easylist.txt", "https://easylist.to/easylist/easylist.txt"),
    (
        "easyprivacy.txt",
        "https://easylist.to/easylist/easyprivacy.txt",
    ),
    (
        "privacy.txt",
        "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt",
    ),
];

static STANDARD_ENGINE: OnceLock<RwLock<Engine>> = OnceLock::new();
static STRICT_ENGINE: OnceLock<RwLock<Engine>> = OnceLock::new();
static CONFIG: OnceLock<RwLock<ProtectionSettings>> = OnceLock::new();
static BLOCKED: AtomicU64 = AtomicU64::new(0);
static SESSION_EXCEPTIONS: OnceLock<
    RwLock<std::collections::HashMap<String, std::collections::HashSet<String>>>,
> = OnceLock::new();

fn standard_engine() -> &'static RwLock<Engine> {
    STANDARD_ENGINE.get_or_init(|| RwLock::new(compile(&[FALLBACK_FILTERS.to_string()])))
}

fn strict_engine() -> &'static RwLock<Engine> {
    STRICT_ENGINE.get_or_init(|| RwLock::new(compile(&[FALLBACK_FILTERS.to_string()])))
}

fn config() -> &'static RwLock<ProtectionSettings> {
    CONFIG.get_or_init(|| RwLock::new(ProtectionSettings::default()))
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

pub fn cosmetic_selectors(url: &str) -> Vec<String> {
    if level() == ProtectionLevel::Off {
        return Vec::new();
    }
    let Ok(resources) = standard_engine().read() else {
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

/// Loads saved lists immediately, then refreshes them from their maintained upstreams.
pub async fn refresh_lists(cache_dir: &Path) {
    let _ = std::fs::create_dir_all(cache_dir);
    let mut loaded = Vec::new();
    for (file, _) in LISTS {
        if let Ok(text) = std::fs::read_to_string(cache_dir.join(file)) {
            loaded.push(text);
        }
    }
    if !loaded.is_empty() {
        let standard = compile(&loaded[..loaded.len().min(2)]);
        let strict = compile(&loaded);
        if let Ok(mut current) = standard_engine().write() {
            *current = standard;
        }
        if let Ok(mut current) = strict_engine().write() {
            *current = strict;
        }
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build();
    let Ok(client) = client else { return };
    let mut fresh = Vec::new();
    for (file, url) in LISTS {
        let result = async {
            let response = client.get(*url).send().await.ok()?;
            if !response.status().is_success() {
                return None;
            }
            let body = response.text().await.ok()?;
            if !(100..=12_000_000).contains(&body.len()) {
                return None;
            }
            let _ = std::fs::write(cache_dir.join(file), &body);
            Some(body)
        }
        .await;
        if let Some(text) = result {
            fresh.push(text);
        }
    }
    if !fresh.is_empty() {
        let standard = compile(&fresh[..fresh.len().min(2)]);
        let strict = compile(&fresh);
        if let Ok(mut current) = standard_engine().write() {
            *current = standard;
        }
        if let Ok(mut current) = strict_engine().write() {
            *current = strict;
        }
    }
}
