//! The two things a browser should not ask for twice.
//!
//! A manifest and a locator record are pointers: small, cheap to keep, expensive to
//! find, because finding one means a relay round trip. The files they point at are a
//! different problem and live in `nsite::Blobs`.
//!
//! Both halves are best effort. A cache that cannot write its directory is still a
//! cache; it just starts cold next time.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::de::DeserializeOwned;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

/// One lookup per key at a time.
///
/// A page load asks for several files at once, so the request that finds an empty
/// cache is not the only one: without a gate, every one of them queried the relays.
/// A caller boards, re-checks the cache, and only then does the lookup.
#[derive(Default)]
pub struct Flights {
    waiting: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
}

pub struct Flight {
    flights: Arc<Flights>,
    key: String,
    guard: Option<OwnedMutexGuard<()>>,
}

impl Flights {
    /// Queue behind the lookup already running for `key`, if there is one.
    pub async fn board(self: &Arc<Self>, key: &str) -> Flight {
        let gate = {
            let mut waiting = crate::lock(&self.waiting);
            waiting
                .entry(key.to_string())
                .or_insert_with(|| Arc::new(AsyncMutex::new(())))
                .clone()
        };

        let guard = gate.lock_owned().await;
        Flight {
            flights: Arc::clone(self),
            key: key.to_string(),
            guard: Some(guard),
        }
    }
}

impl Drop for Flight {
    fn drop(&mut self) {
        // Release first, then forget: the next caller then finds either the answer in
        // the cache or a free gate, never one that is already held.
        drop(self.guard.take());
        crate::lock(&self.flights.waiting).remove(&self.key);
    }
}

/// Read a stored entry. Entries carry their own expiry, so a stale file is simply a
/// miss; the next successful lookup writes over it.
pub fn load<T: DeserializeOwned>(directory: Option<&Path>, key: &str) -> Option<T> {
    let bytes = std::fs::read(directory?.join(file_name(key))).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn save<T: Serialize>(directory: Option<&Path>, key: &str, value: &T) {
    let Some(directory) = directory else {
        return;
    };
    if std::fs::create_dir_all(directory).is_err() {
        return;
    }

    let Ok(bytes) = serde_json::to_vec(value) else {
        return;
    };

    // Write beside the target and rename, so a crash cannot leave a half-read entry.
    let path = directory.join(file_name(key));
    let temporary = path.with_extension("tmp");
    if std::fs::write(&temporary, bytes).is_ok() {
        let _ = std::fs::rename(&temporary, &path);
    }
}

/// Drop everything stored in `directory`. A user asking for a clean slate gets one.
pub fn forget(directory: Option<PathBuf>) {
    let Some(directory) = directory else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let _ = std::fs::remove_file(entry.path());
    }
}

/// Keys carry d-tags and service names, which are not all safe as file names.
fn file_name(key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    let mut name: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    name.push_str(".json");
    name
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[test]
    fn entries_round_trip_and_stale_ones_stay_readable() {
        let directory = std::env::temp_dir().join(format!("ncc-cache-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&directory);

        #[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
        struct Entry {
            expires_at: i64,
            value: String,
        }

        let entry = Entry {
            expires_at: 42,
            value: "kept".into(),
        };
        save(Some(&directory), "hex:service/with:odd/chars", &entry);

        let read: Entry = load(Some(&directory), "hex:service/with:odd/chars").expect("stored");
        assert_eq!(read, entry);

        // The key is hashed, so nothing the caller passes can escape the directory.
        assert!(load::<Entry>(Some(&directory), "../../etc/passwd").is_none());

        forget(Some(directory.clone()));
        assert!(load::<Entry>(Some(&directory), "hex:service/with:odd/chars").is_none());
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[tokio::test]
    async fn a_key_is_looked_up_once_while_others_wait() {
        let flights = Arc::new(Flights::default());
        let lookups = Arc::new(AtomicUsize::new(0));
        let answer = Arc::new(AsyncMutex::new(None::<u32>));

        let mut tasks = Vec::new();
        for _ in 0..8 {
            let flights = Arc::clone(&flights);
            let lookups = Arc::clone(&lookups);
            let answer = Arc::clone(&answer);

            tasks.push(tokio::spawn(async move {
                // The pattern the resolvers use: board, look again, then query.
                let _flight = flights.board("npub:web").await;
                if let Some(value) = *answer.lock().await {
                    return value;
                }

                lookups.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                *answer.lock().await = Some(7);
                7
            }));
        }

        for task in tasks {
            assert_eq!(task.await.expect("task"), 7);
        }
        assert_eq!(lookups.load(Ordering::SeqCst), 1);
    }
}
