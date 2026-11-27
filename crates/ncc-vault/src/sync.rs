//! Browser data sync: bookmarks, history and open tabs.
//!
//! Each document is its own NIP-78 event (kind 30078) whose content is NIP-44 encrypted
//! to the reader's own identity, the same envelope as the password vault but never mixed
//! into it: a vault event is one 40 KB document that is rewritten as a whole, and history
//! changes on every page visit.
//!
//! | Data      | `d` tag                              | Writers          |
//! |-----------|--------------------------------------|------------------|
//! | Bookmarks | `ncc-browser/bookmarks/v1`           | every device     |
//! | History   | `ncc-browser/history/v1/<week>`      | every device     |
//! | Tabs      | `ncc-browser/tabs/v1/<device id>`    | that device only |
//!
//! The merge rules here have to agree with `src/shared/sync.ts` byte for byte. Both are
//! tested against `test/fixtures/sync-vectors.json`.
//!
//! * Bookmarks merge by URL; the newer `updatedAt` wins and a deletion is kept as a
//!   tombstone so it survives a merge from a copy that still has the bookmark.
//! * History merges by URL across weeks: the newest visit wins, the visit count is the
//!   larger of the two (a union cannot know how many visits overlap, and a max never
//!   inflates). `clearedBefore` is a watermark: clearing history sets it, and every
//!   device drops entries last visited at or before it.
//! * Tabs have a single writer, so there is nothing to merge.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const SYNC_KIND: u64 = 30078;
pub const SYNC_VERSION: u32 = 1;
pub const SYNC_TAG: &str = "ncc-browser/sync";
pub const SYNC_CLIENT: &str = "ncc-browser";
pub const BOOKMARKS_D: &str = "ncc-browser/bookmarks/v1";
pub const HISTORY_D_PREFIX: &str = "ncc-browser/history/v1/";
pub const TABS_D_PREFIX: &str = "ncc-browser/tabs/v1/";
pub const IDENTITIES_D: &str = "ncc-browser/identities/v1";

/// Plaintext budget per document, so base64 and NIP-44 framing stay under 64 KB.
pub const MAX_DOC_BYTES: usize = 40_000;
pub const MAX_URL: usize = 4096;
pub const MAX_TITLE: usize = 300;
pub const MAX_BOOKMARKS: usize = 500;
pub const MAX_TABS: usize = 60;
pub const MAX_SYNCED_IDENTITIES: usize = 1000;
/// How many weeks of history leave the device.
pub const HISTORY_WINDOW_WEEKS: u64 = 8;
pub const TOMBSTONE_TTL_MS: u64 = 90 * 24 * 60 * 60 * 1000;
/// A device that has not published tabs for this long is hidden from the list.
pub const DEVICE_STALE_MS: u64 = 60 * 24 * 60 * 60 * 1000;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

pub fn is_syncable_url(url: &str) -> bool {
    let value = url.trim();
    if value.is_empty() || value.len() > MAX_URL {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    lower.starts_with("ncc://") || lower.starts_with("http://") || lower.starts_with("https://")
}

fn clip(value: &str, max: usize) -> String {
    let squashed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    squashed.chars().take(max).collect()
}

fn is_false(value: &bool) -> bool {
    !*value
}

// ───────────────────────────── Bookmarks ─────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBookmark {
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "is_false")]
    pub deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkDoc {
    pub v: u32,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(default)]
    pub entries: Vec<SyncBookmark>,
}

impl Default for BookmarkDoc {
    fn default() -> Self {
        Self {
            v: SYNC_VERSION,
            updated_at: 0,
            entries: Vec::new(),
        }
    }
}

pub fn normalize_bookmarks(value: &Value, now: u64) -> BookmarkDoc {
    let mut by_url: BTreeMap<String, SyncBookmark> = BTreeMap::new();
    let entries = value
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for raw in entries {
        let Ok(mut entry) = serde_json::from_value::<SyncBookmark>(raw) else {
            continue;
        };
        if !is_syncable_url(&entry.url) {
            continue;
        }
        entry.url = entry.url.trim().to_string();
        entry.title = clip(&entry.title, MAX_TITLE);
        if entry.title.is_empty() {
            entry.title = entry.url.clone();
        }
        if entry.updated_at == 0 {
            entry.updated_at = entry.created_at;
        }
        match by_url.get(&entry.url) {
            Some(existing) if !bookmark_wins(&entry, existing) => {}
            _ => {
                by_url.insert(entry.url.clone(), entry);
            }
        }
    }
    let mut entries: Vec<SyncBookmark> = by_url.into_values().collect();
    entries.retain(|entry| {
        !entry.deleted || now.saturating_sub(entry.updated_at) <= TOMBSTONE_TTL_MS
    });
    sort_bookmarks(&mut entries);
    BookmarkDoc {
        v: SYNC_VERSION,
        updated_at: value.get("updatedAt").and_then(Value::as_u64).unwrap_or(0),
        entries,
    }
}

/// Does `a` beat `b` for the same URL? Newer wins; a delete wins a tie; then the
/// greater title, so the choice never depends on which copy is "local".
fn bookmark_wins(a: &SyncBookmark, b: &SyncBookmark) -> bool {
    (a.updated_at, a.deleted, &a.title) > (b.updated_at, b.deleted, &b.title)
}

fn sort_bookmarks(entries: &mut [SyncBookmark]) {
    entries.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| a.url.cmp(&b.url))
    });
}

pub fn merge_bookmarks(local: &BookmarkDoc, remote: &BookmarkDoc, now: u64) -> BookmarkDoc {
    let mut merged: BTreeMap<String, SyncBookmark> = BTreeMap::new();
    for entry in local.entries.iter().chain(remote.entries.iter()) {
        match merged.get(&entry.url) {
            Some(existing) if !bookmark_wins(entry, existing) => {}
            _ => {
                merged.insert(entry.url.clone(), entry.clone());
            }
        }
    }
    let mut entries: Vec<SyncBookmark> = merged.into_values().collect();
    entries.retain(|entry| {
        !entry.deleted || now.saturating_sub(entry.updated_at) <= TOMBSTONE_TTL_MS
    });
    sort_bookmarks(&mut entries);
    fit_bookmarks(&mut entries);
    BookmarkDoc {
        v: SYNC_VERSION,
        updated_at: local.updated_at.max(remote.updated_at),
        entries,
    }
}

/// Make the document fit: tombstones go first, then the oldest bookmarks.
pub fn fit_bookmarks(entries: &mut Vec<SyncBookmark>) {
    let live = entries.iter().filter(|entry| !entry.deleted).count();
    if live > MAX_BOOKMARKS {
        let mut seen = 0;
        entries.retain(|entry| {
            if entry.deleted {
                return true;
            }
            seen += 1;
            seen <= MAX_BOOKMARKS
        });
    }
    while doc_len(&json!({ "v": SYNC_VERSION, "updatedAt": 0, "entries": entries })) > MAX_DOC_BYTES
    {
        if let Some(position) = entries.iter().rposition(|entry| entry.deleted) {
            entries.remove(position);
        } else if entries.pop().is_none() {
            break;
        }
    }
}

// ───────────────────────────── History ─────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncVisit {
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub visits: u64,
    #[serde(default)]
    pub last_visit: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDoc {
    pub v: u32,
    #[serde(default)]
    pub week: u64,
    #[serde(default)]
    pub cleared_before: u64,
    #[serde(default)]
    pub entries: Vec<SyncVisit>,
}

impl HistoryDoc {
    pub fn empty(week: u64) -> Self {
        Self {
            v: SYNC_VERSION,
            week,
            cleared_before: 0,
            entries: Vec::new(),
        }
    }
}

/// Weeks start on Monday (UTC); the epoch fell on a Thursday.
pub fn week_of(ms: u64) -> u64 {
    (ms / DAY_MS + 3) / 7
}

pub fn history_d(week: u64) -> String {
    format!("{HISTORY_D_PREFIX}{week}")
}

pub fn parse_history_d(d: &str) -> Option<u64> {
    d.strip_prefix(HISTORY_D_PREFIX)?.parse().ok()
}

pub fn tabs_d(device_id: &str) -> String {
    format!("{TABS_D_PREFIX}{device_id}")
}

pub fn parse_tabs_d(d: &str) -> Option<&str> {
    d.strip_prefix(TABS_D_PREFIX).filter(|id| is_device_id(id))
}

pub fn is_device_id(value: &str) -> bool {
    (8..=32).contains(&value.len()) && value.chars().all(|c| c.is_ascii_hexdigit())
}

/// The oldest week that leaves the device.
pub fn history_window_start(now: u64) -> u64 {
    week_of(now).saturating_sub(HISTORY_WINDOW_WEEKS - 1)
}

pub fn normalize_history(value: &Value, week: u64) -> HistoryDoc {
    let cleared_before = value
        .get("clearedBefore")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let raw = value
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut by_url: BTreeMap<String, SyncVisit> = BTreeMap::new();
    for item in raw {
        let Ok(mut entry) = serde_json::from_value::<SyncVisit>(item) else {
            continue;
        };
        if !is_syncable_url(&entry.url) || entry.last_visit <= cleared_before {
            continue;
        }
        entry.url = entry.url.trim().to_string();
        entry.title = clip(&entry.title, MAX_TITLE);
        if entry.title.is_empty() {
            entry.title = entry.url.clone();
        }
        entry.visits = entry.visits.max(1);
        absorb_visit(&mut by_url, entry);
    }
    let mut doc = HistoryDoc {
        v: SYNC_VERSION,
        week,
        cleared_before,
        entries: by_url.into_values().collect(),
    };
    sort_visits(&mut doc.entries);
    fit_history(&mut doc);
    doc
}

fn absorb_visit(map: &mut BTreeMap<String, SyncVisit>, entry: SyncVisit) {
    match map.get_mut(&entry.url) {
        Some(existing) => {
            let newer = (entry.last_visit, &entry.title) > (existing.last_visit, &existing.title);
            existing.visits = existing.visits.max(entry.visits);
            if newer {
                existing.last_visit = entry.last_visit;
                existing.title = entry.title;
            }
        }
        None => {
            map.insert(entry.url.clone(), entry);
        }
    }
}

fn sort_visits(entries: &mut [SyncVisit]) {
    entries.sort_by(|a, b| {
        b.last_visit
            .cmp(&a.last_visit)
            .then_with(|| a.url.cmp(&b.url))
    });
}

/// Union two copies of the same week (or of the whole local history).
pub fn merge_history(local: &HistoryDoc, remote: &HistoryDoc) -> HistoryDoc {
    let cleared_before = local.cleared_before.max(remote.cleared_before);
    let mut by_url: BTreeMap<String, SyncVisit> = BTreeMap::new();
    for entry in local.entries.iter().chain(remote.entries.iter()) {
        if entry.last_visit <= cleared_before {
            continue;
        }
        absorb_visit(&mut by_url, entry.clone());
    }
    let mut doc = HistoryDoc {
        v: SYNC_VERSION,
        week: local.week.max(remote.week),
        cleared_before,
        entries: by_url.into_values().collect(),
    };
    sort_visits(&mut doc.entries);
    fit_history(&mut doc);
    doc
}

/// Keep the most recent visits that fit.
pub fn fit_history(doc: &mut HistoryDoc) {
    while doc_len(&serde_json::to_value(&*doc).unwrap_or(Value::Null)) > MAX_DOC_BYTES {
        if doc.entries.pop().is_none() {
            break;
        }
    }
}

/// Split a flat history into the per-week documents that leave the device. Weeks older
/// than the window are not synced; every week in the window gets a document so the
/// `clearedBefore` watermark reaches it even when it has no entries left.
pub fn history_weeks(
    entries: &[SyncVisit],
    cleared_before: u64,
    now: u64,
) -> BTreeMap<u64, HistoryDoc> {
    let start = history_window_start(now);
    let end = week_of(now);
    let mut weeks: BTreeMap<u64, HistoryDoc> = BTreeMap::new();
    if cleared_before > 0 {
        for week in start..=end {
            let mut doc = HistoryDoc::empty(week);
            doc.cleared_before = cleared_before;
            weeks.insert(week, doc);
        }
    }
    for entry in entries {
        let week = week_of(entry.last_visit);
        if week < start || week > end || entry.last_visit <= cleared_before {
            continue;
        }
        let doc = weeks.entry(week).or_insert_with(|| {
            let mut doc = HistoryDoc::empty(week);
            doc.cleared_before = cleared_before;
            doc
        });
        doc.entries.push(entry.clone());
    }
    for doc in weeks.values_mut() {
        let mut by_url: BTreeMap<String, SyncVisit> = BTreeMap::new();
        for entry in doc.entries.drain(..) {
            absorb_visit(&mut by_url, entry);
        }
        doc.entries = by_url.into_values().collect();
        sort_visits(&mut doc.entries);
        fit_history(doc);
    }
    weeks
}

// ───────────────────────────── Tabs ─────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub platform: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTab {
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub last_active: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabsDoc {
    pub v: u32,
    pub device: DeviceInfo,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(default)]
    pub tabs: Vec<SyncTab>,
    /// Set when another device removed this one from the list.
    #[serde(default, skip_serializing_if = "is_false")]
    pub removed: bool,
}

pub fn normalize_tabs(value: &Value) -> Option<TabsDoc> {
    let mut doc: TabsDoc = serde_json::from_value(value.clone()).ok()?;
    if doc.v != SYNC_VERSION || !is_device_id(&doc.device.id) {
        return None;
    }
    doc.device.name = clip(&doc.device.name, 80);
    doc.device.platform = clip(&doc.device.platform, 20);
    doc.tabs.retain(|tab| is_syncable_url(&tab.url));
    for tab in &mut doc.tabs {
        tab.url = tab.url.trim().to_string();
        tab.title = clip(&tab.title, MAX_TITLE);
        if tab.title.is_empty() {
            tab.title = tab.url.clone();
        }
    }
    doc.tabs.truncate(MAX_TABS);
    while doc_len(&serde_json::to_value(&doc).unwrap_or(Value::Null)) > MAX_DOC_BYTES {
        if doc.tabs.pop().is_none() {
            break;
        }
    }
    Some(doc)
}

// ───────────────────────────── Relay filter ─────────────────────────────

/// One query that finds every sync document of an identity.
pub fn sync_filter(pubkey: &str) -> Value {
    json!({
        "kinds": [SYNC_KIND],
        "authors": [pubkey],
        "#t": [SYNC_TAG],
        "limit": 200,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocKind {
    Bookmarks,
    Identities,
    History(u64),
    Tabs(String),
}

pub fn doc_kind(d: &str) -> Option<DocKind> {
    if d == BOOKMARKS_D {
        return Some(DocKind::Bookmarks);
    }
    if d == IDENTITIES_D {
        return Some(DocKind::Identities);
    }
    if let Some(week) = parse_history_d(d) {
        return Some(DocKind::History(week));
    }
    parse_tabs_d(d).map(|id| DocKind::Tabs(id.to_string()))
}

fn doc_len(value: &Value) -> usize {
    serde_json::to_string(value)
        .map(|text| text.len())
        .unwrap_or(usize::MAX)
}

// ---------------------------------------------------------------------------
// Identities. The rules here match `planIdentitySync` in `src/shared/sync.ts`; both
// run `test/fixtures/identity-sync-vectors.json`.
// ---------------------------------------------------------------------------

/// Whether a key has been taken out of identity sync, or put back. The newer mark for
/// a key wins; at the same moment, removal wins. A removed key is left out of the
/// vault, but no device deletes its own copy because of a mark.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdentityMark {
    pub pubkey: String,
    pub removed: bool,
    /// Epoch milliseconds the choice was made.
    pub at: u64,
}

/// What one device remembers: keys removed from it only, and every mark it has seen.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdentityState {
    #[serde(default)]
    pub excluded: Vec<String>,
    #[serde(default)]
    pub marks: Vec<IdentityMark>,
}

/// A vault in canonical form: `pubkey -> nsec`, with removed keys left out.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IdentityVault {
    pub entries: BTreeMap<String, String>,
    pub marks: Vec<IdentityMark>,
}

impl IdentityVault {
    pub fn to_document(&self, now: u64) -> Value {
        let entries: Vec<Value> = self
            .entries
            .iter()
            .map(|(pubkey, nsec)| json!({"pubkey": pubkey, "nsec": nsec}))
            .collect();
        let mut document = json!({"v": SYNC_VERSION, "updatedAt": now, "entries": entries});
        if !self.marks.is_empty() {
            document["marks"] = json!(self.marks);
        }
        document
    }
}

fn is_pubkey(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn merge_identity_marks<'a>(marks: impl IntoIterator<Item = &'a IdentityMark>) -> Vec<IdentityMark> {
    let mut merged = BTreeMap::<String, IdentityMark>::new();
    for mark in marks {
        let newer = merged.get(&mark.pubkey).map_or(true, |current| {
            mark.at > current.at || (mark.at == current.at && mark.removed)
        });
        if newer {
            merged.insert(mark.pubkey.clone(), mark.clone());
        }
    }
    merged.into_values().collect()
}

fn identity_vault(entries: BTreeMap<String, String>, marks: Vec<IdentityMark>) -> IdentityVault {
    let mut entries = entries;
    for mark in marks.iter().filter(|mark| mark.removed) {
        entries.remove(&mark.pubkey);
    }
    IdentityVault { entries, marks }
}

fn add_identity(entries: &mut BTreeMap<String, String>, pubkey: String, nsec: String) -> Result<(), String> {
    if entries.get(&pubkey).is_some_and(|existing| *existing != nsec) {
        return Err("The identity vault has conflicting keys for one public key".into());
    }
    entries.insert(pubkey, nsec);
    Ok(())
}

/// Read a decrypted vault. `None` is a vault that has not been written yet.
pub fn parse_identity_vault(value: Option<&Value>) -> Result<IdentityVault, String> {
    let Some(value) = value else { return Ok(IdentityVault::default()) };
    let invalid = || "The identity vault has an unsupported or invalid format".to_string();
    if value.get("v").and_then(Value::as_u64) != Some(u64::from(SYNC_VERSION)) {
        return Err(invalid());
    }
    let items = value.get("entries").and_then(Value::as_array).ok_or_else(invalid)?;
    if items.len() > MAX_SYNCED_IDENTITIES {
        return Err("The identity vault contains too many identities".into());
    }
    let mut entries = BTreeMap::new();
    for item in items {
        let (Some(pubkey), Some(nsec)) = (
            item.get("pubkey").and_then(Value::as_str).filter(|id| is_pubkey(id)),
            item.get("nsec").and_then(Value::as_str),
        ) else {
            return Err("The identity vault contains an invalid key entry".into());
        };
        let pubkey = pubkey.to_ascii_lowercase();
        // Removals go by public key, so an entry must really be the key it says it is.
        let matches = nostr::SecretKey::parse(nsec)
            .is_ok_and(|secret| nostr::Keys::new(secret).public_key().to_hex() == pubkey);
        if !matches {
            return Err("An identity vault key does not match its public key".into());
        }
        add_identity(&mut entries, pubkey, nsec.to_string())?;
    }
    let marks = match value.get("marks") {
        None => Vec::new(),
        Some(list) => {
            let marks: Vec<IdentityMark> = serde_json::from_value(list.clone())
                .map_err(|_| "The identity vault has an invalid list of removals".to_string())?;
            if marks.len() > MAX_SYNCED_IDENTITIES || !marks.iter().all(|mark| is_pubkey(&mark.pubkey)) {
                return Err("The identity vault has an invalid list of removals".into());
            }
            let lowered: Vec<IdentityMark> = marks
                .into_iter()
                .map(|mark| IdentityMark { pubkey: mark.pubkey.to_ascii_lowercase(), ..mark })
                .collect();
            merge_identity_marks(&lowered)
        }
    };
    Ok(identity_vault(entries, marks))
}

pub fn merge_identity_vaults(a: &IdentityVault, b: &IdentityVault) -> Result<IdentityVault, String> {
    let mut entries = a.entries.clone();
    for (pubkey, nsec) in &b.entries {
        add_identity(&mut entries, pubkey.clone(), nsec.clone())?;
    }
    Ok(identity_vault(entries, merge_identity_marks(a.marks.iter().chain(&b.marks))))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityPlan {
    /// The vault as it should now be on the relays.
    pub vault: IdentityVault,
    /// Public keys in the vault to save on this device.
    pub imports: Vec<String>,
    /// Excluded keys that are on this device again.
    pub unexclude: Vec<String>,
    /// Keys held here that have been removed from sync. Never deleted without asking.
    pub removals: Vec<String>,
}

pub fn plan_identity_sync(
    local: &BTreeMap<String, String>,
    remote: &IdentityVault,
    state: &IdentityState,
) -> Result<IdentityPlan, String> {
    let mine = identity_vault(local.clone(), merge_identity_marks(&state.marks));
    // The device's own removals must also drop keys it still holds.
    let vault = merge_identity_vaults(&mine, remote)?;
    let imports = vault
        .entries
        .keys()
        .filter(|id| !local.contains_key(*id) && !state.excluded.contains(*id))
        .cloned()
        .collect();
    let unexclude = state.excluded.iter().filter(|id| local.contains_key(*id)).cloned().collect();
    let removals = vault
        .marks
        .iter()
        .filter(|mark| mark.removed && local.contains_key(&mark.pubkey))
        .map(|mark| mark.pubkey.clone())
        .collect();
    Ok(IdentityPlan { vault, imports, unexclude, removals })
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTORS: &str = include_str!("../../../test/fixtures/sync-vectors.json");

    #[test]
    fn weeks_start_on_monday() {
        // 1970-01-05 was a Monday: the first day of week 1.
        assert_eq!(week_of(0), 0);
        assert_eq!(week_of(4 * DAY_MS), 1);
        assert_eq!(week_of(11 * DAY_MS - 1), 1);
        assert_eq!(week_of(11 * DAY_MS), 2);
    }

    #[test]
    fn bookmark_merge_is_symmetric() {
        let a = BookmarkDoc {
            entries: vec![SyncBookmark {
                url: "https://a.example/".into(),
                title: "A".into(),
                created_at: 1,
                updated_at: 5,
                deleted: false,
            }],
            ..Default::default()
        };
        let mut b = a.clone();
        b.entries[0].updated_at = 5;
        b.entries[0].deleted = true;
        assert_eq!(
            merge_bookmarks(&a, &b, 10),
            merge_bookmarks(&b, &a, 10),
            "a delete wins a tie whichever side holds it"
        );
        assert!(merge_bookmarks(&a, &b, 10).entries[0].deleted);
    }

    #[test]
    fn vectors_agree_with_the_typescript_implementation() {
        let vectors: Value = serde_json::from_str(VECTORS).unwrap();
        for case in vectors["bookmarks"].as_array().unwrap() {
            let now = case["now"].as_u64().unwrap();
            let local = normalize_bookmarks(&case["local"], now);
            let remote = normalize_bookmarks(&case["remote"], now);
            let merged = merge_bookmarks(&local, &remote, now);
            assert_eq!(
                serde_json::to_value(&merged).unwrap(),
                case["expect"],
                "bookmarks: {}",
                case["name"]
            );
        }
        for case in vectors["history"].as_array().unwrap() {
            let week = case["week"].as_u64().unwrap();
            let local = normalize_history(&case["local"], week);
            let remote = normalize_history(&case["remote"], week);
            let merged = merge_history(&local, &remote);
            assert_eq!(
                serde_json::to_value(&merged).unwrap(),
                case["expect"],
                "history: {}",
                case["name"]
            );
        }
        for case in vectors["weeks"].as_array().unwrap() {
            let entries: Vec<SyncVisit> =
                serde_json::from_value(case["entries"].clone()).unwrap();
            let weeks = history_weeks(
                &entries,
                case["clearedBefore"].as_u64().unwrap(),
                case["now"].as_u64().unwrap(),
            );
            let out: Value = Value::Array(
                weeks
                    .values()
                    .map(|doc| serde_json::to_value(doc).unwrap())
                    .collect(),
            );
            assert_eq!(out, case["expect"], "weeks: {}", case["name"]);
        }
    }

    #[test]
    fn oversized_history_keeps_the_newest_visits() {
        let entries: Vec<SyncVisit> = (0..2000)
            .map(|index| SyncVisit {
                url: format!("https://site{index}.example/some/long/path/to/a/page"),
                title: format!("A page title number {index}"),
                visits: 1,
                last_visit: 1_000_000 + index,
            })
            .collect();
        let mut doc = HistoryDoc::empty(1);
        doc.entries = entries;
        sort_visits(&mut doc.entries);
        fit_history(&mut doc);
        assert!(doc_len(&serde_json::to_value(&doc).unwrap()) <= MAX_DOC_BYTES);
        assert_eq!(doc.entries[0].last_visit, 1_001_999);
    }

    #[test]
    fn tabs_reject_bad_device_ids_and_urls() {
        let bad = json!({"v":1,"device":{"id":"../x","name":"n","platform":"p"},"tabs":[]});
        assert!(normalize_tabs(&bad).is_none());
        let good = json!({
            "v":1,
            "device":{"id":"0123456789abcdef","name":"Laptop","platform":"linux"},
            "tabs":[{"url":"javascript:alert(1)","title":"x"},{"url":"https://a.example/","title":" A "}]
        });
        let doc = normalize_tabs(&good).unwrap();
        assert_eq!(doc.tabs.len(), 1);
        assert_eq!(doc.tabs[0].title, "A");
    }

    #[test]
    fn d_tags_round_trip() {
        assert_eq!(doc_kind(BOOKMARKS_D), Some(DocKind::Bookmarks));
        assert_eq!(doc_kind(IDENTITIES_D), Some(DocKind::Identities));
        assert_eq!(doc_kind(&history_d(2900)), Some(DocKind::History(2900)));
        assert_eq!(
            doc_kind(&tabs_d("0123456789abcdef")),
            Some(DocKind::Tabs("0123456789abcdef".into()))
        );
        assert_eq!(doc_kind("ncc-browser/passwords/v1"), None);
    }

    #[test]
    fn identity_cases_match_the_desktop_build() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/identity-sync-vectors.json"
        ))
        .unwrap();
        let strings = |value: &Value| -> Vec<String> {
            serde_json::from_value(value.clone()).unwrap()
        };
        let cases = vectors["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let local = case["local"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| {
                    (
                        entry["pubkey"].as_str().unwrap().to_string(),
                        entry["nsec"].as_str().unwrap().to_string(),
                    )
                })
                .collect();
            let remote =
                parse_identity_vault(Some(&case["remote"]).filter(|value| !value.is_null())).unwrap();
            let state: IdentityState = serde_json::from_value(case["state"].clone()).unwrap();
            let plan = plan_identity_sync(&local, &remote, &state).unwrap();
            let expected = &case["expect"];
            assert_eq!(
                plan.vault.entries.keys().cloned().collect::<Vec<_>>(),
                strings(&expected["entries"]),
                "{name}"
            );
            assert_eq!(plan.imports, strings(&expected["imports"]), "{name}");
            assert_eq!(plan.unexclude, strings(&expected["unexclude"]), "{name}");
            assert_eq!(plan.removals, strings(&expected["removals"]), "{name}");
            assert_eq!(json!(plan.vault.marks), expected["marks"], "{name}");
        }
        for case in vectors["refused"].as_array().unwrap() {
            assert!(
                parse_identity_vault(Some(&case["remote"])).is_err(),
                "{}",
                case["name"]
            );
        }
    }
}
