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
    /// Refuse services without a fresh NCC-02 anchor.
    pub anchor_required: bool,
    pub https_mode: HttpsMode,
    /// Show an interstitial before loading a cleartext page.
    pub warn_insecure: bool,
    /// Services the user allowed over cleartext.
    pub http_exceptions: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            relays: DEFAULT_RELAYS
                .iter()
                .map(|relay| relay.to_string())
                .collect(),
            gossip: true,
            anchor_required: false,
            https_mode: HttpsMode::default(),
            warn_insecure: false,
            http_exceptions: Vec::new(),
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
