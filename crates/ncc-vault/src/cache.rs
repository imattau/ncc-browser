//! Ciphertext-only local cache.
//!
//! Keeping the signed event means the vault opens offline without a plaintext
//! password ever reaching disk: the content is already NIP-44 ciphertext and only the
//! identity's key can read it.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use nostr::Event;
use serde::{Deserialize, Serialize};

use crate::VAULT_KIND;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedVault {
    pub event: Event,
    pub pending: bool,
    pub synced_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheFile {
    version: u32,
    vaults: HashMap<String, CachedVault>,
    #[serde(default)]
    migrated_from: HashMap<String, Vec<String>>,
}

impl Default for CacheFile {
    fn default() -> Self {
        Self {
            version: 1,
            vaults: HashMap::new(),
            migrated_from: HashMap::new(),
        }
    }
}

pub struct PasswordCache {
    path: PathBuf,
    data: Option<CacheFile>,
}

impl PasswordCache {
    pub fn open(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            data: None,
        }
    }

    pub fn get(&mut self, pubkey: &str) -> Option<CachedVault> {
        let value = self.load().vaults.get(pubkey)?.clone();
        if value.event.kind.as_u16() as u64 != VAULT_KIND {
            return None;
        }
        Some(value)
    }

    pub fn set(&mut self, pubkey: &str, value: CachedVault) {
        let mut data = self.load();
        data.vaults.insert(pubkey.to_string(), value);
        self.write(&data);
    }

    pub fn clear(&mut self, pubkey: &str) {
        let mut data = self.load();
        if data.vaults.remove(pubkey).is_none() {
            return;
        }
        self.write(&data);
    }

    pub fn source_migrated(&mut self, default_pubkey: &str, source_pubkey: &str) -> bool {
        self.load().migrated_from.get(default_pubkey)
            .is_some_and(|sources| sources.iter().any(|source| source == source_pubkey))
    }

    pub fn mark_source_migrated(&mut self, default_pubkey: &str, source_pubkey: &str) {
        let mut data = self.load();
        let sources = data.migrated_from.entry(default_pubkey.to_string()).or_default();
        if sources.iter().any(|source| source == source_pubkey) { return; }
        sources.push(source_pubkey.to_string());
        self.write(&data);
    }

    fn load(&mut self) -> CacheFile {
        if self.data.is_none() {
            let parsed = fs::read(&self.path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<CacheFile>(&bytes).ok())
                .unwrap_or_default();
            self.data = Some(parsed);
        }
        self.data.clone().expect("cache loaded")
    }

    fn write(&mut self, data: &CacheFile) {
        self.data = Some(data.clone());

        if let Some(parent) = self.path.parent() {
            if fs::create_dir_all(parent).is_err() {
                return;
            }
        }
        let Ok(encoded) = serde_json::to_vec_pretty(data) else {
            return;
        };

        let temporary = self.path.with_extension("tmp");
        if fs::write(&temporary, &encoded).is_err() {
            return;
        }
        restrict(&temporary);
        if fs::rename(&temporary, &self.path).is_err() {
            let _ = fs::remove_file(&temporary);
            return;
        }
        restrict(&self.path);
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
    use nostr::{EventBuilder, Keys, Kind};

    fn event(keys: &Keys) -> Event {
        EventBuilder::new(Kind::Custom(30078), "ciphertext")
            .tags(vec![nostr::Tag::parse(["d", crate::VAULT_D]).unwrap()])
            .sign_with_keys(keys)
            .unwrap()
    }

    fn path(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "ncc-vault-cache-{}-{name}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        path
    }

    #[test]
    fn ciphertext_round_trips_and_survives_a_reopen() {
        let path = path("round-trip");
        let keys = Keys::generate();
        let cached = CachedVault {
            event: event(&keys),
            pending: true,
            synced_at: Some(12),
        };

        let mut cache = PasswordCache::open(&path);
        cache.set("npub1test", cached.clone());

        let mut reopened = PasswordCache::open(&path);
        let read = reopened.get("npub1test").expect("cached");
        assert_eq!(read.event.id, cached.event.id);
        assert!(read.pending);
        assert_eq!(read.synced_at, Some(12));

        reopened.clear("npub1test");
        assert!(PasswordCache::open(&path).get("npub1test").is_none());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_corrupt_file_is_disposable() {
        let path = path("corrupt");
        fs::write(&path, b"{ not json").unwrap();
        let mut cache = PasswordCache::open(&path);
        assert!(cache.get("npub1test").is_none());
        cache.set(
            "npub1test",
            CachedVault {
                event: event(&Keys::generate()),
                pending: false,
                synced_at: None,
            },
        );
        assert!(PasswordCache::open(&path).get("npub1test").is_some());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn only_vault_events_are_returned() {
        let path = path("kind");
        let keys = Keys::generate();
        let wrong = EventBuilder::new(Kind::Custom(1), "no")
            .sign_with_keys(&keys)
            .unwrap();
        let mut cache = PasswordCache::open(&path);
        cache.set(
            "npub1test",
            CachedVault {
                event: wrong,
                pending: false,
                synced_at: None,
            },
        );
        assert!(PasswordCache::open(&path).get("npub1test").is_none());
        let _ = fs::remove_file(&path);
    }
}
