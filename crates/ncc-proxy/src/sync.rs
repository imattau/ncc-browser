//! Browser data sync for the Android shell: bookmarks, history and open tabs.
//!
//! The documents and merge rules are in `ncc_vault::sync` (shared with the desktop
//! build). This module is what needs a key and a socket. The shell's bookmarks and
//! history live in the chrome's own storage, so the shape here is one exchange: the
//! shell hands over what it has, this fetches the relay copies, merges, publishes what
//! the relays lack, and hands the merged result back for the shell to store.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use ncc_identity::IdentityStore;
use ncc_vault::sync::{
    doc_kind, history_d, history_weeks, history_window_start, merge_bookmarks, merge_history,
    normalize_bookmarks, normalize_history, normalize_tabs, sync_filter, tabs_d, week_of,
    BookmarkDoc, DeviceInfo, DocKind, HistoryDoc, SyncTab, SyncVisit, TabsDoc, BOOKMARKS_D,
    DEVICE_STALE_MS, SYNC_CLIENT, SYNC_KIND, SYNC_TAG, SYNC_VERSION,
};

use crate::own_relays::OwnRelays;
use crate::relay::{self, Signer};
use crate::settings::SettingsStore;

const RELAY_WAIT: Duration = Duration::from_secs(8);
const MAX_EVENT_CONTENT: usize = 1_000_000;
const NO_IDENTITY: &str =
    "Unlock a locally stored identity first: synced data is encrypted to your key.";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryInput {
    #[serde(default)]
    pub cleared_before: u64,
    #[serde(default)]
    pub entries: Vec<SyncVisit>,
}

/// What the shell has, for each category that is switched on. `None` means off.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    pub device: DeviceInfo,
    pub now: u64,
    #[serde(default)]
    pub bookmarks: Option<Value>,
    #[serde(default)]
    pub history: Option<HistoryInput>,
    #[serde(default)]
    pub tabs: Option<Vec<SyncTab>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryOutput {
    pub cleared_before: u64,
    pub entries: Vec<SyncVisit>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DeviceTab {
    pub url: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceOutput {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub updated_at: u64,
    pub tabs: Vec<DeviceTab>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncResponse {
    pub bookmarks: Option<BookmarkDoc>,
    pub history: Option<HistoryOutput>,
    pub devices: Vec<DeviceOutput>,
    /// Categories that failed, so the rest still go through.
    pub errors: Vec<String>,
}

/// What the relays hold, already decrypted and normalised.
#[derive(Debug, Default)]
pub struct Remote {
    pub bookmarks: Option<BookmarkDoc>,
    pub history: BTreeMap<u64, HistoryDoc>,
    pub tabs: Vec<TabsDoc>,
}

#[derive(Debug)]
pub struct Plan {
    pub response: SyncResponse,
    pub publish: Vec<(String, Value)>,
}

/// The merge itself, with no network: what to hand back and what to publish.
pub fn plan(request: &SyncRequest, remote: &Remote, own_tabs_key: Option<&str>) -> Plan {
    let now = request.now;
    let mut response = SyncResponse::default();
    let mut publish: Vec<(String, Value)> = Vec::new();

    if let Some(local) = &request.bookmarks {
        let local = normalize_bookmarks(local, now);
        let empty = BookmarkDoc::default();
        let remote_doc = remote.bookmarks.as_ref().unwrap_or(&empty);
        let merged = merge_bookmarks(&local, remote_doc, now);
        let differs = !same(&zero_updated(&merged), &zero_updated(remote_doc));
        if differs && (!merged.entries.is_empty() || remote.bookmarks.is_some()) {
            let mut doc = merged.clone();
            doc.updated_at = now;
            publish.push((BOOKMARKS_D.to_string(), to_value(&doc)));
        }
        response.bookmarks = Some(merged);
    }

    if let Some(local) = &request.history {
        let start = history_window_start(now);
        let end = week_of(now);
        let mut remote_flat = HistoryDoc::empty(0);
        for (week, doc) in &remote.history {
            if *week >= start && *week <= end {
                remote_flat = merge_history(&remote_flat, doc);
            }
        }
        let mut local_flat = HistoryDoc::empty(0);
        local_flat.cleared_before = local.cleared_before;
        local_flat.entries = local.entries.clone();
        let merged = merge_history(&local_flat, &remote_flat);
        for doc in history_weeks(&merged.entries, merged.cleared_before, now).values() {
            let remote_doc = remote.history.get(&doc.week);
            if remote_doc.is_some_and(|remote_doc| same(remote_doc, doc)) {
                continue;
            }
            if remote_doc.is_none() && doc.entries.is_empty() && doc.cleared_before == 0 {
                continue;
            }
            publish.push((history_d(doc.week), to_value(doc)));
        }
        response.history = Some(HistoryOutput {
            cleared_before: merged.cleared_before,
            entries: merged.entries,
        });
    }

    if let Some(tabs) = &request.tabs {
        let key = tabs_key(&request.device, tabs);
        let own_published = remote
            .tabs
            .iter()
            .any(|doc| doc.device.id == request.device.id);
        if own_tabs_key != Some(key.as_str()) || !own_published {
            let doc = TabsDoc {
                v: SYNC_VERSION,
                device: request.device.clone(),
                updated_at: now,
                tabs: tabs.clone(),
                removed: false,
            };
            if let Some(doc) = normalize_tabs(&to_value(&doc)) {
                publish.push((tabs_d(&request.device.id), to_value(&doc)));
            }
        }
        for doc in &remote.tabs {
            if doc.device.id == request.device.id
                || doc.removed
                || now.saturating_sub(doc.updated_at) > DEVICE_STALE_MS
            {
                continue;
            }
            response.devices.push(DeviceOutput {
                id: doc.device.id.clone(),
                name: if doc.device.name.is_empty() {
                    "Unnamed device".to_string()
                } else {
                    doc.device.name.clone()
                },
                platform: doc.device.platform.clone(),
                updated_at: doc.updated_at,
                tabs: doc
                    .tabs
                    .iter()
                    .map(|tab| DeviceTab {
                        url: tab.url.clone(),
                        title: tab.title.clone(),
                    })
                    .collect(),
            });
        }
        response
            .devices
            .sort_by_key(|device| std::cmp::Reverse(device.updated_at));
    }

    Plan { response, publish }
}

fn tabs_key(device: &DeviceInfo, tabs: &[SyncTab]) -> String {
    json!([
        device.name,
        tabs.iter()
            .map(|tab| json!([tab.url, tab.title]))
            .collect::<Vec<_>>()
    ])
    .to_string()
}

fn zero_updated(doc: &BookmarkDoc) -> BookmarkDoc {
    let mut doc = doc.clone();
    doc.updated_at = 0;
    doc
}

fn to_value<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

fn same<T: Serialize>(a: &T, b: &T) -> bool {
    to_value(a) == to_value(b)
}

pub struct SyncService {
    identity: Arc<IdentityStore>,
    settings: Arc<SettingsStore>,
    own_relays: OwnRelays,
    last_created: Mutex<HashMap<String, u64>>,
    last_tabs_key: Mutex<Option<String>>,
    busy: tokio::sync::Mutex<()>,
}

impl SyncService {
    pub fn new(identity: Arc<IdentityStore>, settings: Arc<SettingsStore>) -> Self {
        Self {
            identity,
            settings,
            own_relays: OwnRelays::default(),
            last_created: Mutex::new(HashMap::new()),
            last_tabs_key: Mutex::new(None),
            busy: tokio::sync::Mutex::new(()),
        }
    }

    /// The same relays the vault uses (a dedicated vault relay, or the configured list
    /// plus your NIP-65 write relays), so one setting covers both.
    async fn relays(&self, pubkey: &str) -> Vec<String> {
        self.own_relays.resolve(&self.settings.get(), pubkey).await
    }

    fn signer(&self) -> Signer {
        let identity = self.identity.clone();
        Arc::new(move |template: Value| {
            identity
                .sign_event(&template)
                .map_err(|error| error.to_string())
        })
    }

    fn pubkey(&self) -> Result<String, String> {
        self.identity
            .public_key()
            .map(|key| key.to_hex())
            .map_err(|_| NO_IDENTITY.to_string())
    }

    /// One full exchange. Only one runs at a time; a second waits for the first.
    pub async fn exchange(&self, request: SyncRequest) -> Result<SyncResponse, String> {
        let _guard = self.busy.lock().await;
        let pubkey = self.pubkey()?;
        let relays = self.relays(&pubkey).await;
        if relays.is_empty() {
            return Err("No relay is configured for sync".to_string());
        }

        let latest = self.fetch(&relays, &pubkey).await?;
        {
            let mut created = self.last_created();
            for (d, event) in &latest {
                let entry = created.entry(d.clone()).or_insert(0);
                *entry = (*entry).max(event.created_at.as_secs());
            }
        }

        let mut errors = Vec::new();
        let remote = self.decode(&pubkey, &latest, &request, &mut errors);
        let own_key = self.last_tabs_key().clone();
        let mut plan = plan(&request, &remote, own_key.as_deref());

        for (d, doc) in &plan.publish {
            if let Err(error) = self.publish(&relays, &pubkey, d, doc, request.now).await {
                errors.push(error);
            }
        }
        if let Some(tabs) = &request.tabs {
            if plan
                .publish
                .iter()
                .any(|(d, _)| d.starts_with("ncc-browser/tabs/"))
            {
                *self.last_tabs_key() = Some(tabs_key(&request.device, tabs));
            }
        }
        plan.response.errors = errors;
        Ok(plan.response)
    }

    /// Mark another device as removed. It comes back the next time that device syncs.
    pub async fn remove_device(&self, device: DeviceInfo, now: u64) -> Result<(), String> {
        let _guard = self.busy.lock().await;
        let pubkey = self.pubkey()?;
        let relays = self.relays(&pubkey).await;
        let latest = self.fetch(&relays, &pubkey).await?;
        {
            let mut created = self.last_created();
            for (d, event) in &latest {
                let entry = created.entry(d.clone()).or_insert(0);
                *entry = (*entry).max(event.created_at.as_secs());
            }
        }
        let doc = TabsDoc {
            v: SYNC_VERSION,
            device: device.clone(),
            updated_at: now,
            tabs: Vec::new(),
            removed: true,
        };
        self.publish(&relays, &pubkey, &tabs_d(&device.id), &to_value(&doc), now)
            .await
    }

    fn last_created(&self) -> std::sync::MutexGuard<'_, HashMap<String, u64>> {
        self.last_created
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn last_tabs_key(&self) -> std::sync::MutexGuard<'_, Option<String>> {
        self.last_tabs_key
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The newest valid event for each document.
    async fn fetch(
        &self,
        relays: &[String],
        pubkey: &str,
    ) -> Result<BTreeMap<String, nostr::Event>, String> {
        let signer = self.signer();
        let filter = sync_filter(pubkey);
        let attempts = relays
            .iter()
            .map(|relay| relay::query_authed(relay, &filter, RELAY_WAIT, &signer))
            .collect::<Vec<_>>();
        let mut latest: BTreeMap<String, nostr::Event> = BTreeMap::new();
        let mut first_error = None;
        let mut answered = 0;
        for result in futures_util::future::join_all(attempts).await {
            let events = match result {
                Ok(events) => {
                    answered += 1;
                    events
                }
                Err(error) => {
                    first_error.get_or_insert(error);
                    continue;
                }
            };
            for event in events {
                if event.kind.as_u16() as u64 != SYNC_KIND
                    || event.pubkey.to_hex() != pubkey
                    || event.content.len() > MAX_EVENT_CONTENT
                {
                    continue;
                }
                let tag = |name: &str| {
                    event.tags.iter().find_map(|tag| {
                        let parts = tag.as_slice();
                        (parts.len() >= 2 && parts[0] == name).then(|| parts[1].clone())
                    })
                };
                let tagged = event.tags.iter().any(|tag| {
                    let parts = tag.as_slice();
                    parts.len() >= 2 && parts[0] == "t" && parts[1] == SYNC_TAG
                });
                let Some(d) = tag("d") else { continue };
                if !tagged || doc_kind(&d).is_none() || event.verify().is_err() {
                    continue;
                }
                let newer = latest.get(&d).map_or(true, |current| {
                    (event.created_at, std::cmp::Reverse(event.id.to_hex()))
                        > (current.created_at, std::cmp::Reverse(current.id.to_hex()))
                });
                if newer {
                    latest.insert(d, event);
                }
            }
        }
        // Nothing answered: stop here rather than waiting on every relay again to publish.
        if answered == 0 {
            return Err(first_error.unwrap_or_else(|| "No relay answered".to_string()));
        }
        Ok(latest)
    }

    fn decode(
        &self,
        pubkey: &str,
        latest: &BTreeMap<String, nostr::Event>,
        request: &SyncRequest,
        errors: &mut Vec<String>,
    ) -> Remote {
        let mut remote = Remote::default();
        let start = history_window_start(request.now);
        let end = week_of(request.now);
        for (d, event) in latest {
            let Some(kind) = doc_kind(d) else { continue };
            let wanted = match &kind {
                DocKind::Bookmarks => request.bookmarks.is_some(),
                DocKind::History(week) => {
                    request.history.is_some() && *week >= start && *week <= end
                }
                DocKind::Tabs(_) => request.tabs.is_some(),
            };
            if !wanted {
                continue;
            }
            let value = match self.decrypt(pubkey, event) {
                Ok(value) => value,
                Err(error) => {
                    errors.push(format!("{d}: {error}"));
                    continue;
                }
            };
            match kind {
                DocKind::Bookmarks => {
                    remote.bookmarks = Some(normalize_bookmarks(&value, request.now))
                }
                DocKind::History(week) => {
                    remote.history.insert(week, normalize_history(&value, week));
                }
                DocKind::Tabs(_) => {
                    if let Some(doc) = normalize_tabs(&value) {
                        remote.tabs.push(doc);
                    }
                }
            }
        }
        remote
    }

    fn decrypt(&self, pubkey: &str, event: &nostr::Event) -> Result<Value, String> {
        let plaintext = self
            .identity
            .nip44_decrypt(pubkey, &event.content)
            .map_err(|_| "could not be decrypted".to_string())?;
        let value: Value =
            serde_json::from_str(&plaintext).map_err(|_| "is not valid JSON".to_string())?;
        if value.get("v").and_then(Value::as_u64) != Some(u64::from(SYNC_VERSION)) {
            return Err("was written by a newer version".to_string());
        }
        Ok(value)
    }

    async fn publish(
        &self,
        relays: &[String],
        pubkey: &str,
        d: &str,
        doc: &Value,
        now_ms: u64,
    ) -> Result<(), String> {
        let content = self
            .identity
            .nip44_encrypt(pubkey, &doc.to_string())
            .map_err(|_| NO_IDENTITY.to_string())?;
        let created_at = {
            let previous = self.last_created().get(d).copied().unwrap_or(0);
            (now_ms / 1000).max(previous.saturating_add(1))
        };
        let template = json!({
            "kind": SYNC_KIND,
            "created_at": created_at,
            "tags": [["d", d], ["t", SYNC_TAG], ["client", SYNC_CLIENT]],
            "content": content,
        });
        let event = self
            .identity
            .sign_event(&template)
            .map_err(|error| format!("could not be signed: {error}"))?;
        if event.verify().is_err() {
            return Err("The signed sync event is invalid".to_string());
        }
        let (accepted, first_error) =
            relay::publish_all(relays, &event, &self.signer(), RELAY_WAIT).await;
        if accepted == 0 {
            return Err(first_error.unwrap_or_else(|| {
                format!("No relay accepted the update ({} tried)", relays.len())
            }));
        }
        self.last_created().insert(d.to_string(), created_at);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000_000;

    fn device() -> DeviceInfo {
        DeviceInfo {
            id: "0123456789abcdef".into(),
            name: "Phone".into(),
            platform: "android".into(),
        }
    }

    fn request() -> SyncRequest {
        SyncRequest {
            device: device(),
            now: NOW,
            bookmarks: None,
            history: None,
            tabs: None,
        }
    }

    fn visit(url: &str, at: u64) -> SyncVisit {
        SyncVisit {
            url: url.into(),
            title: url.into(),
            visits: 1,
            last_visit: at,
        }
    }

    #[test]
    fn the_request_the_shell_sends_deserialises() {
        // Exactly what `mobile/main.js` passes to `sync_exchange`, with off categories as null.
        let request: SyncRequest = serde_json::from_value(json!({
            "device": {"id": "0123456789abcdef", "name": "Android phone", "platform": "android"},
            "now": 1_800_000_000_000u64,
            "bookmarks": {"v": 1, "updatedAt": 0, "entries": [
                {"url": "https://a.example/", "title": "A", "createdAt": 1, "updatedAt": 2},
                {"url": "https://b.example/", "title": "B", "createdAt": 1, "updatedAt": 3, "deleted": true}
            ]},
            "history": {"clearedBefore": 0, "entries": [
                {"url": "https://a.example/", "title": "A", "visits": 2, "lastVisit": 1_799_999_999_000u64}
            ]},
            "tabs": null
        }))
        .unwrap();
        assert!(request.tabs.is_none());
        assert_eq!(request.history.unwrap().entries[0].visits, 2);
        let plan = plan(
            &SyncRequest {
                history: None,
                ..request
            },
            &Remote::default(),
            None,
        );
        let out = serde_json::to_value(&plan.response).unwrap();
        assert!(out["bookmarks"]["entries"].is_array());
        assert!(out["history"].is_null());
        assert!(out["devices"].as_array().unwrap().is_empty());
    }

    #[test]
    fn nothing_is_published_for_a_category_that_is_off() {
        let plan = plan(&request(), &Remote::default(), None);
        assert!(plan.publish.is_empty());
        assert!(plan.response.bookmarks.is_none());
    }

    #[test]
    fn a_local_bookmark_is_published_once_and_then_left_alone() {
        let mut request = request();
        request.bookmarks = Some(json!({
            "v": 1,
            "entries": [{"url": "https://a.example/", "title": "A", "createdAt": NOW, "updatedAt": NOW}]
        }));
        let first = plan(&request, &Remote::default(), None);
        assert_eq!(first.publish.len(), 1);
        assert_eq!(first.publish[0].0, BOOKMARKS_D);

        // The relay now holds what was published: a second pass has nothing to send.
        let remote = Remote {
            bookmarks: first.response.bookmarks.clone(),
            ..Default::default()
        };
        assert!(plan(&request, &remote, None).publish.is_empty());
    }

    #[test]
    fn a_remote_removal_beats_an_older_local_bookmark() {
        let mut request = request();
        request.bookmarks = Some(json!({
            "v": 1,
            "entries": [{"url": "https://a.example/", "title": "A", "createdAt": 1, "updatedAt": NOW - 1000}]
        }));
        let remote = Remote {
            bookmarks: Some(normalize_bookmarks(
                &json!({"v":1,"entries":[{"url":"https://a.example/","title":"A","createdAt":1,"updatedAt":NOW,"deleted":true}]}),
                NOW,
            )),
            ..Default::default()
        };
        let merged = plan(&request, &remote, None).response.bookmarks.unwrap();
        assert!(merged.entries[0].deleted);
    }

    #[test]
    fn history_publishes_only_the_weeks_that_changed() {
        let mut request = request();
        request.history = Some(HistoryInput {
            cleared_before: 0,
            entries: vec![visit("https://a.example/", NOW - 1000)],
        });
        let first = plan(&request, &Remote::default(), None);
        assert_eq!(first.publish.len(), 1);

        let week = week_of(NOW - 1000);
        let mut remote = Remote::default();
        remote
            .history
            .insert(week, normalize_history(&first.publish[0].1, week));
        assert!(plan(&request, &remote, None).publish.is_empty());
    }

    #[test]
    fn a_remote_clear_removes_local_history() {
        let mut request = request();
        request.history = Some(HistoryInput {
            cleared_before: 0,
            entries: vec![visit("https://a.example/", NOW - 5000)],
        });
        let week = week_of(NOW);
        let mut remote = Remote::default();
        let mut cleared = HistoryDoc::empty(week);
        cleared.cleared_before = NOW - 1000;
        remote.history.insert(week, cleared);
        let output = plan(&request, &remote, None).response.history.unwrap();
        assert!(output.entries.is_empty());
        assert_eq!(output.cleared_before, NOW - 1000);
    }

    #[test]
    fn tabs_are_published_once_and_other_devices_listed() {
        let mut request = request();
        request.tabs = Some(vec![SyncTab {
            url: "https://a.example/".into(),
            title: "A".into(),
            last_active: NOW,
        }]);
        let other = TabsDoc {
            v: 1,
            device: DeviceInfo {
                id: "fedcba9876543210".into(),
                name: "Laptop".into(),
                platform: "linux".into(),
            },
            updated_at: NOW - 10,
            tabs: vec![SyncTab {
                url: "https://b.example/".into(),
                title: "B".into(),
                last_active: 0,
            }],
            removed: false,
        };
        let remote = Remote {
            tabs: vec![other],
            ..Default::default()
        };
        let first = plan(&request, &remote, None);
        assert_eq!(first.publish.len(), 1);
        assert_eq!(first.response.devices.len(), 1);
        assert_eq!(first.response.devices[0].name, "Laptop");

        // Once published, unchanged tabs are not sent again.
        let key = tabs_key(&request.device, request.tabs.as_ref().unwrap());
        let mut published = Remote::default();
        published.tabs.push(TabsDoc {
            v: 1,
            device: request.device.clone(),
            updated_at: NOW,
            tabs: vec![],
            removed: false,
        });
        assert!(plan(&request, &published, Some(&key)).publish.is_empty());
    }

    /// Cross-implementation check against a real relay, run by hand with the desktop
    /// test in `test/sync-live.test.ts`:
    ///
    /// ```text
    /// nak serve --port 10547 &
    /// NCC_SYNC_RELAY=ws://127.0.0.1:10547 NCC_SYNC_NSEC=<hex> NCC_SYNC_PHASE=1 \
    ///   cargo test -p ncc-proxy sync::tests::live -- --ignored
    /// ```
    #[tokio::test]
    #[ignore = "needs a relay and a key: see the doc comment"]
    async fn live_round_trip_with_the_desktop_build() {
        let (Ok(relay), Ok(nsec), Ok(phase)) = (
            std::env::var("NCC_SYNC_RELAY"),
            std::env::var("NCC_SYNC_NSEC"),
            std::env::var("NCC_SYNC_PHASE"),
        ) else {
            panic!("set NCC_SYNC_RELAY, NCC_SYNC_NSEC and NCC_SYNC_PHASE");
        };
        let dir = std::env::temp_dir().join(format!("ncc-sync-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let identity = Arc::new(IdentityStore::open(dir.join("identity.json")));
        identity
            .import(
                &ncc_identity::PassphraseEnvelope::new("test-passphrase"),
                &nsec,
            )
            .unwrap();
        let settings = Arc::new(SettingsStore::in_memory(crate::settings::Settings {
            relays: vec![relay],
            ..Default::default()
        }));
        let service = SyncService::new(identity, settings);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        if phase == "1" {
            // The phone publishes first.
            let response = service
                .exchange(SyncRequest {
                    device: device(),
                    now,
                    bookmarks: Some(json!({"v":1,"entries":[
                        {"url":"https://phone.example/","title":"From the phone","createdAt":now,"updatedAt":now}
                    ]})),
                    history: Some(HistoryInput {
                        cleared_before: 0,
                        entries: vec![visit("https://phone.example/visited", now - 1000)],
                    }),
                    tabs: Some(vec![SyncTab {
                        url: "https://phone.example/tab".into(),
                        title: "Phone tab".into(),
                        last_active: now,
                    }]),
                })
                .await
                .unwrap();
            assert!(response.errors.is_empty(), "{:?}", response.errors);
        } else {
            // After the desktop has synced and added its own: the phone sees both.
            let response = service
                .exchange(SyncRequest {
                    device: device(),
                    now,
                    bookmarks: Some(json!({"v":1,"entries":[]})),
                    history: Some(HistoryInput {
                        cleared_before: 0,
                        entries: vec![],
                    }),
                    tabs: Some(vec![]),
                })
                .await
                .unwrap();
            assert!(response.errors.is_empty(), "{:?}", response.errors);
            let urls: Vec<_> = response
                .bookmarks
                .unwrap()
                .entries
                .iter()
                .map(|entry| entry.url.clone())
                .collect();
            assert!(
                urls.contains(&"https://phone.example/".to_string()),
                "{urls:?}"
            );
            assert!(
                urls.contains(&"https://desktop.example/".to_string()),
                "{urls:?}"
            );
            let history: Vec<_> = response
                .history
                .unwrap()
                .entries
                .iter()
                .map(|entry| entry.url.clone())
                .collect();
            assert!(
                history.contains(&"https://desktop.example/visited".to_string()),
                "{history:?}"
            );
            assert_eq!(response.devices.len(), 1, "{:?}", response.devices);
            assert_eq!(response.devices[0].name, "Desktop");
            assert_eq!(
                response.devices[0].tabs[0].url,
                "https://desktop.example/tab"
            );
        }
    }
}
