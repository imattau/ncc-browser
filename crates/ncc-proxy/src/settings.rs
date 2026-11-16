//! Persistent browser settings.
//!
//! The proxy owns every decision that a setting can change — which relays to ask,
//! whether cleartext is allowed — so settings live here, not in the shell. The shell
//! reads and writes them through commands and never holds the truth.
//!
//! One file, written through a temporary path so a crash cannot leave it half-written,
//! and validated on the way in: a relay list with no usable relay would make every
//! lookup fail silently.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

pub const DEFAULT_RELAYS: &[&str] = &[
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.primal.net",
];
const MAX_RELAYS: usize = 20;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HttpsMode {
    /// Use whatever the publisher offers, in priority order.
    Off,
    /// Prefer https endpoints, fall back to http.
    #[default]
    Prefer,
    /// Only https endpoints are usable.
    Only,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub relays: Vec<String>,
    /// Follow the target identity's NIP-65 relay list. Stored now, honoured once the
    /// resolver learns to gossip.
    pub gossip: bool,
    /// Unlock the identity at startup instead of waiting for a tap. Only works where
    /// the storage envelope needs no input, which is the case with the device
    /// keystore; a passphrase identity stays locked and says why.
    pub keep_unlocked: bool,
    /// Refuse services without a fresh NCC-02 anchor.
    pub anchor_required: bool,
    pub https_mode: HttpsMode,
    /// Show an interstitial before loading a cleartext page.
    pub warn_insecure: bool,
    /// Services the user allowed over cleartext.
    pub http_exceptions: Vec<String>,
    /// Search engine id; see `SEARCH_ENGINES` in the desktop build.
    pub search_engine: String,
    /// SearXNG instance, or a full `%s` template for a custom engine.
    pub search_engine_custom: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            relays: DEFAULT_RELAYS
                .iter()
                .map(|relay| relay.to_string())
                .collect(),
            gossip: true,
            keep_unlocked: false,
            anchor_required: false,
            https_mode: HttpsMode::default(),
            warn_insecure: false,
            http_exceptions: Vec::new(),
            search_engine: "duckduckgo".to_string(),
            search_engine_custom: String::new(),
        }
    }
}

impl Settings {
    /// Reject anything that would leave the browser unable to resolve.
    pub fn validate(mut self) -> Result<Self, String> {
        self.relays = sanitize_relays(self.relays)?;
        if self.relays.is_empty() {
            return Err("Keep at least one relay".to_string());
        }

        // An unknown engine falls back rather than breaking the address bar.
        if !matches!(
            self.search_engine.as_str(),
            "duckduckgo" | "brave" | "startpage" | "google" | "bing" | "searx" | "custom"
        ) {
            self.search_engine = "duckduckgo".to_string();
        }

        let custom = self.search_engine_custom.trim().to_string();
        self.search_engine_custom = custom.clone();

        if self.search_engine == "custom" && !custom.contains("%s") {
            return Err("A custom engine needs a %s placeholder".to_string());
        }
        if self.search_engine == "searx"
            && !custom.is_empty()
            && !(custom.starts_with("https://") || custom.starts_with("http://"))
        {
            return Err("A SearXNG instance must be an http(s) URL".to_string());
        }

        Ok(self)
    }
}

pub fn sanitize_relays(input: Vec<String>) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();

    for raw in input {
        let value = raw.trim();
        if value.is_empty() {
            continue;
        }

        let lower = value.to_ascii_lowercase();
        if !(lower.starts_with("wss://") || lower.starts_with("ws://")) {
            return Err(format!("\"{value}\" is not a ws:// or wss:// relay URL"));
        }
        if !out
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(value))
        {
            out.push(value.to_string());
        }
    }

    if out.len() > MAX_RELAYS {
        out.truncate(MAX_RELAYS);
    }

    Ok(out)
}

#[derive(Debug)]
pub struct SettingsStore {
    path: Option<PathBuf>,
    inner: RwLock<Settings>,
}

impl SettingsStore {
    /// Settings that are not written anywhere, used by the CLI and by tests.
    pub fn in_memory(settings: Settings) -> Self {
        Self {
            path: None,
            inner: RwLock::new(settings),
        }
    }

    /// Load from `path`, or start from defaults when it is missing or unreadable.
    pub fn open(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let settings = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
            .and_then(|settings| settings.validate().ok())
            .unwrap_or_default();

        Self {
            path: Some(path),
            inner: RwLock::new(settings),
        }
    }

    pub fn get(&self) -> Settings {
        self.inner.read().expect("settings lock").clone()
    }

    pub fn relays(&self) -> Vec<String> {
        self.inner.read().expect("settings lock").relays.clone()
    }

    pub fn https_mode(&self) -> HttpsMode {
        self.inner.read().expect("settings lock").https_mode
    }

    pub fn warn_insecure(&self) -> bool {
        self.inner.read().expect("settings lock").warn_insecure
    }

    /// True when this service was allowed over cleartext by the user.
    pub fn allows_http(&self, key: &str) -> bool {
        self.inner
            .read()
            .expect("settings lock")
            .http_exceptions
            .iter()
            .any(|entry| entry.eq_ignore_ascii_case(key))
    }

    pub fn allow_http(&self, key: &str) -> Result<Settings, String> {
        let mut settings = self.get();
        if !settings
            .http_exceptions
            .iter()
            .any(|entry| entry.eq_ignore_ascii_case(key))
        {
            settings.http_exceptions.push(key.to_string());
        }
        self.apply(settings)
    }

    pub fn gossip(&self) -> bool {
        self.inner.read().expect("settings lock").gossip
    }

    pub fn search(&self) -> (String, String) {
        let settings = self.inner.read().expect("settings lock");
        (
            settings.search_engine.clone(),
            settings.search_engine_custom.clone(),
        )
    }

    /// Apply a validated replacement and persist it. Memory is only changed once the
    /// new value is known to be usable.
    pub fn apply(&self, settings: Settings) -> Result<Settings, String> {
        let settings = settings.validate()?;
        self.persist(&settings)?;
        *self.inner.write().expect("settings lock") = settings.clone();
        Ok(settings)
    }

    pub fn set_relays(&self, relays: Vec<String>) -> Result<Settings, String> {
        let sanitized = sanitize_relays(relays)?;
        if sanitized.is_empty() {
            return Err("Keep at least one relay".to_string());
        }
        let mut settings = self.get();
        settings.relays = sanitized;
        self.apply(settings)
    }

    pub fn set_keep_unlocked(&self, value: bool) -> Result<Settings, String> {
        let mut settings = self.get();
        settings.keep_unlocked = value;
        self.apply(settings)
    }

    pub fn set_gossip(&self, value: bool) -> Result<Settings, String> {
        let mut settings = self.get();
        settings.gossip = value;
        self.apply(settings)
    }

    pub fn set_https_mode(&self, mode: HttpsMode) -> Result<Settings, String> {
        let mut settings = self.get();
        settings.https_mode = mode;
        self.apply(settings)
    }

    pub fn set_search(&self, engine: String, custom: String) -> Result<Settings, String> {
        let mut settings = self.get();
        settings.search_engine = engine;
        settings.search_engine_custom = custom;
        self.apply(settings)
    }

    pub fn set_warn_insecure(&self, value: bool) -> Result<Settings, String> {
        let mut settings = self.get();
        settings.warn_insecure = value;
        self.apply(settings)
    }

    fn persist(&self, settings: &Settings) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };

        let encoded = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }

        let temporary = path.with_extension("tmp");
        fs::write(&temporary, &encoded).map_err(|error| error.to_string())?;
        restrict(&temporary);
        fs::rename(&temporary, path).map_err(|error| error.to_string())?;
        restrict(path);
        Ok(())
    }
}

#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("ncc-settings-{}-{name}.json", std::process::id()));
        let _ = fs::remove_file(&path);
        path
    }

    #[test]
    fn defaults_are_usable() {
        let settings = Settings::default();
        assert_eq!(settings.relays.len(), 3);
        assert!(settings.validate().is_ok());
    }

    #[test]
    fn relays_are_validated_and_deduplicated() {
        assert_eq!(
            sanitize_relays(vec![
                " wss://a.example ".into(),
                "".into(),
                "WSS://A.example".into(),
                "ws://b.example".into()
            ])
            .unwrap(),
            vec!["wss://a.example".to_string(), "ws://b.example".to_string()]
        );

        assert!(sanitize_relays(vec!["https://nope.example".into()]).is_err());
        assert!(sanitize_relays(vec!["".into()]).unwrap().is_empty());
    }

    #[test]
    fn an_empty_relay_list_is_refused() {
        let store = SettingsStore::in_memory(Settings::default());
        assert!(store.set_relays(vec![]).is_err());
        // The old list survives a rejected change.
        assert_eq!(store.get().relays.len(), 3);
    }

    #[test]
    fn search_engines_are_validated() {
        let store = SettingsStore::in_memory(Settings::default());
        assert!(store
            .set_search("custom".into(), "https://x/?q=".into())
            .is_err());
        assert!(store.set_search("searx".into(), "searx.be".into()).is_err());

        let saved = store
            .set_search("custom".into(), "https://example.org/find?q=%s".into())
            .expect("custom");
        assert_eq!(saved.search_engine, "custom");

        // An unknown id is not an error; it just falls back.
        let fallback = store
            .set_search("nonsense".into(), String::new())
            .expect("fallback");
        assert_eq!(fallback.search_engine, "duckduckgo");
    }

    #[test]
    fn cleartext_exceptions_are_remembered_once() {
        let store = SettingsStore::in_memory(Settings::default());
        assert!(!store.allows_http("ncc://npub/web"));

        store.allow_http("ncc://npub/web").expect("allow");
        assert!(store.allows_http("ncc://npub/web"));
        assert!(!store.allows_http("ncc://npub/other"));

        // Allowing the same service twice must not duplicate the entry.
        store.allow_http("ncc://npub/web").expect("allow again");
        assert_eq!(store.get().http_exceptions.len(), 1);
    }

    #[test]
    fn settings_round_trip_through_a_file() {
        let path = temp_path("round-trip");
        let store = SettingsStore::open(&path);
        store
            .set_relays(vec!["wss://only.example".into()])
            .expect("set relays");
        store.set_https_mode(HttpsMode::Only).expect("https mode");

        let reopened = SettingsStore::open(&path);
        assert_eq!(
            reopened.get().relays,
            vec!["wss://only.example".to_string()]
        );
        assert_eq!(reopened.get().https_mode, HttpsMode::Only);

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_corrupt_file_falls_back_to_defaults() {
        let path = temp_path("corrupt");
        fs::write(&path, b"{ not json").unwrap();
        let store = SettingsStore::open(&path);
        assert_eq!(store.get().relays.len(), 3);
        let _ = fs::remove_file(&path);
    }
}
