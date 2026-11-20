//! The password vault service: unlocking, matching, filling, saving and syncing.
//!
//! The format lives in `ncc-vault`; this module is what needs a key, a socket and the
//! settings store. It is deliberately separate from the HTTP proxy: the shell talks to
//! it through commands, and a page never reaches it. A page can only *offer* a capture,
//! and a fill is always something the person asked for by choosing an entry.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use ncc_identity::IdentityStore;
use ncc_vault::{
    apply_entry, draft_origin, entries_for_origin, find_entry, find_entry_for,
    is_vault_within_limit, merge_vaults, normalize_vault, password_origin, summarize_vault,
    vault_byte_length, vault_filter, CachedVault, GeneratorOptions, PasswordCache, PasswordEntry,
    PasswordVault, TotpCode, TotpSecret, VAULT_CLIENT, VAULT_D, VAULT_KIND, VAULT_TAG,
    VAULT_VERSION,
};

use crate::own_relays::OwnRelays;
use crate::relay::{self, Signer};
use crate::settings::SettingsStore;

const RELAY_WAIT: Duration = Duration::from_secs(8);
const PENDING_TTL: u64 = 120;
const LOCKED: &str = "Unlock the password manager first";
const NO_IDENTITY: &str =
    "Unlock a locally stored identity first: the vault is encrypted to your key.";
const VAULT_ERROR: &str = "The password vault could not be read";

/// What the shell needs to draw the unlocked/locked state.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub configured: bool,
    pub unlocked: bool,
    pub entry_count: usize,
    pub pending: bool,
    pub syncing: bool,
    pub last_synced_at: Option<u64>,
    pub relays: Vec<String>,
    pub auto_lock_minutes: u32,
    pub offer_save: bool,
    pub vault_relay: String,
    pub use_nip65: bool,
    pub never_save: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingSave {
    pub id: String,
    pub origin: String,
    pub title: String,
    pub username: String,
    /// `create` or `update`.
    pub mode: String,
    pub locked: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    #[serde(default)]
    pub id: Option<String>,
    pub origin: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub totp: String,
    #[serde(default)]
    pub passkey: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutcome {
    pub ok: bool,
    pub pending: bool,
    pub error: Option<String>,
    pub status: VaultStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

struct Pending {
    origin: String,
    title: String,
    username: String,
    password: String,
    expires: u64,
}

#[derive(Default)]
struct State {
    unlocked: bool,
    pubkey: Option<String>,
    vault: Option<PasswordVault>,
    cached: Option<CachedVault>,
    /// The `created_at` of the last event we signed, so a replacement is always newer.
    last_created_at: u64,
    pending: HashMap<String, Pending>,
    syncing: bool,
    error: Option<String>,
    last_synced_at: Option<u64>,
    last_activity: u64,
}

pub struct VaultService {
    identity: Arc<IdentityStore>,
    settings: Arc<SettingsStore>,
    own_relays: OwnRelays,
    cache: Mutex<PasswordCache>,
    state: Mutex<State>,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl VaultService {
    pub fn new(
        identity: Arc<IdentityStore>,
        settings: Arc<SettingsStore>,
        cache_path: impl Into<std::path::PathBuf>,
    ) -> Self {
        Self::with_clock(identity, settings, cache_path, Arc::new(now_seconds))
    }

    pub fn with_clock(
        identity: Arc<IdentityStore>,
        settings: Arc<SettingsStore>,
        cache_path: impl Into<std::path::PathBuf>,
        now: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self {
            identity,
            settings,
            own_relays: OwnRelays::default(),
            cache: Mutex::new(PasswordCache::open(cache_path)),
            state: Mutex::new(State::default()),
            now,
        }
    }

    fn now(&self) -> u64 {
        (self.now)()
    }

    fn secure(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, PasswordCache> {
        self.cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Drop the decrypted vault once it has been idle for the configured time.
    ///
    /// Checked on every operation instead of on a timer: a timer would have to keep the
    /// app awake to do the same thing, and the only observable difference is when the
    /// memory is freed.
    fn expire(&self) {
        let minutes = self.settings.get().passwords.auto_lock_minutes;
        if minutes == 0 {
            return;
        }
        let mut state = self.secure();
        if !state.unlocked {
            return;
        }
        if self.now().saturating_sub(state.last_activity) >= u64::from(minutes) * 60 {
            clear_vault(&mut state);
        }
    }

    fn touch(&self) {
        let now = self.now();
        let mut state = self.secure();
        if state.unlocked {
            state.last_activity = now;
        }
    }

    pub fn status(&self) -> VaultStatus {
        self.expire();
        let settings = self.settings.get().passwords;
        let state = self.secure();
        VaultStatus {
            // `initialised`, not "the key is loaded": an identity sealed by the device
            // envelope is still configured while it is locked, and telling its owner to
            // set one up would be wrong.
            configured: self.identity.status().initialised,
            unlocked: state.unlocked,
            entry_count: state
                .vault
                .as_ref()
                .map(|vault| vault.active().count())
                .unwrap_or_default(),
            pending: state
                .cached
                .as_ref()
                .map(|cached| cached.pending)
                .unwrap_or(false),
            syncing: state.syncing,
            last_synced_at: state.last_synced_at,
            relays: self.relays(),
            auto_lock_minutes: settings.auto_lock_minutes,
            offer_save: settings.offer_save,
            vault_relay: settings.vault_relay,
            use_nip65: settings.use_nip65,
            never_save: settings.never_save,
            error: state.error.clone(),
        }
    }

    /// The relays shown in the settings: what is known without asking anyone.
    fn relays(&self) -> Vec<String> {
        self.own_relays.known(&self.settings.get())
    }

    /// The relays to talk to: a dedicated vault relay alone, otherwise the configured
    /// list plus your own NIP-65 write relays (see `own_relays`).
    async fn network_relays(&self, pubkey: &str) -> Vec<String> {
        self.own_relays.resolve(&self.settings.get(), pubkey).await
    }

    fn require_pubkey(&self) -> Result<String, String> {
        self.identity
            .public_key()
            .map(|key| key.to_hex())
            .map_err(|_| NO_IDENTITY.to_string())
    }

    pub async fn unlock(&self) -> VaultStatus {
        self.expire();

        let pubkey = match self.require_pubkey() {
            Ok(pubkey) => pubkey,
            Err(error) => {
                self.fail(error);
                return self.status();
            }
        };

        let already_open = {
            let state = self.secure();
            state.unlocked && state.pubkey.as_deref() == Some(pubkey.as_str())
        };
        if already_open {
            self.touch();
            return self.status();
        }

        {
            let mut state = self.secure();
            clear_vault(&mut state);
            state.pubkey = Some(pubkey.clone());
            state.error = None;
        }

        let cached = { self.cache().get(&pubkey) };

        // An explicit block, not `drop`: the guard's scope has to end before the
        // await below for the future to stay `Send` for the command layer.
        {
            let mut state = self.secure();
            state.last_created_at = cached
                .as_ref()
                .map(|cached| cached.event.created_at.as_secs())
                .unwrap_or_default();
            state.last_synced_at = cached.as_ref().and_then(|cached| cached.synced_at);
            state.cached = cached.clone();

            if let Some(cached) = &cached {
                match decrypt(&self.identity, &pubkey, &cached.event) {
                    Ok(vault) => state.vault = Some(vault),
                    Err(error) => {
                        state.vault = Some(PasswordVault::default());
                        state.error = Some(format!("{error}. Fetching the relay copy."));
                    }
                }
            } else {
                state.vault = Some(PasswordVault::default());
            }

            state.unlocked = true;
            state.last_activity = self.now();
        }

        match self.sync(true).await {
            Ok(()) => {}
            Err(error) => self.fail(error),
        }

        self.touch();
        self.status()
    }

    pub fn lock(&self) -> VaultStatus {
        {
            let mut state = self.secure();
            clear_vault(&mut state);
        }
        self.status()
    }

    fn fail(&self, error: String) {
        let mut state = self.secure();
        state.error = Some(error);
    }

    pub fn list(&self) -> Vec<ncc_vault::PasswordSummary> {
        self.expire_for_read();
        self.touch();
        let state = self.secure();
        state
            .vault
            .as_ref()
            .map(summarize_vault)
            .unwrap_or_default()
    }

    fn expire_for_read(&self) {
        self.expire();
    }

    /// Map the active tab's address to the canonical origin the vault stores.
    pub fn origin_for_tab(&self, url: &str, kind: &str) -> Result<String, String> {
        if kind != "normal" {
            return Err(match kind {
                "private" => "Passwords are unavailable in private tabs.".to_string(),
                "tor" => "Passwords are unavailable in Tor tabs.".to_string(),
                _ => "Passwords are unavailable in this tab.".to_string(),
            });
        }

        let parsed =
            url::Url::parse(url).map_err(|_| "That page has no usable address.".to_string())?;
        let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();

        if host.ends_with(".localhost") {
            if host.ends_with(".nsite.localhost") {
                return Err("Passwords are not available for nsites.".to_string());
            }
            if host.ends_with(".onion.localhost") || host.ends_with(".tor.localhost") {
                return Err("Passwords are unavailable in Tor tabs.".to_string());
            }
            let vhost = crate::vhost::parse_vhost(&host)
                .ok_or_else(|| "That page has no usable identity.".to_string())?;
            return Ok(format!("ncc://{}/{}", vhost.pubkey, vhost.service));
        }

        password_origin(url).ok_or_else(|| {
            if parsed.scheme() == "http" {
                "Passwords are disabled on insecure pages.".to_string()
            } else {
                "Passwords are only available on https and ncc pages.".to_string()
            }
        })
    }

    pub fn matches(
        &self,
        url: &str,
        kind: &str,
    ) -> Result<Vec<ncc_vault::PasswordSummary>, String> {
        let origin = self.origin_for_tab(url, kind)?;
        self.expire_for_read();
        self.touch();

        let state = self.secure();
        if !state.unlocked {
            return Ok(Vec::new());
        }
        let Some(vault) = &state.vault else {
            return Ok(Vec::new());
        };
        Ok(entries_for_origin(vault, &origin)
            .iter()
            .map(ncc_vault::summarize)
            .collect())
    }

    /// Hand one entry to the tab that asked for it. The origin check is the whole
    /// security property here: a fill cannot cross origins even if the shell asks.
    pub fn fill(&self, id: &str, url: &str, kind: &str) -> Result<Credentials, String> {
        let origin = self.origin_for_tab(url, kind)?;
        self.expire_for_read();
        self.touch();

        let state = self.secure();
        if !state.unlocked {
            return Err(LOCKED.to_string());
        }
        let vault = state
            .vault
            .as_ref()
            .ok_or_else(|| VAULT_ERROR.to_string())?;
        let entry =
            find_entry(vault, id).ok_or_else(|| "That login no longer exists".to_string())?;
        if entry.deleted {
            return Err("That login no longer exists".to_string());
        }
        if entry.origin != origin {
            return Err("That login belongs to a different site".to_string());
        }
        if entry.password.is_empty() {
            return Err("This login has no password".to_string());
        }

        Ok(Credentials {
            username: entry.username.clone(),
            password: entry.password.clone(),
        })
    }

    pub fn totp(&self, id: &str) -> Result<TotpCode, String> {
        self.expire_for_read();
        self.touch();
        let state = self.secure();
        if !state.unlocked {
            return Err(LOCKED.to_string());
        }
        let vault = state
            .vault
            .as_ref()
            .ok_or_else(|| VAULT_ERROR.to_string())?;
        let entry =
            find_entry(vault, id).ok_or_else(|| "That login no longer exists".to_string())?;
        if entry.totp.is_empty() {
            return Err("This login has no 2FA secret".to_string());
        }
        let secret = TotpSecret::parse(&entry.totp)?;
        Ok(secret.code((self.now)().saturating_mul(1000)))
    }

    pub fn generate(&self, options: &GeneratorOptions) -> String {
        ncc_vault::generate_password(options)
    }

    pub fn entry(&self, id: &str) -> Result<PasswordEntry, String> {
        self.expire_for_read();
        self.touch();
        let state = self.secure();
        if !state.unlocked {
            return Err(LOCKED.to_string());
        }
        let vault = state
            .vault
            .as_ref()
            .ok_or_else(|| VAULT_ERROR.to_string())?;
        find_entry(vault, id)
            .filter(|entry| !entry.deleted)
            .cloned()
            .ok_or_else(|| "That login no longer exists".to_string())
    }

    /// A password the page offered on submit. Does not save anything: the shell shows a
    /// prompt and calls `respond_to_save`.
    pub fn capture(
        &self,
        url: &str,
        kind: &str,
        title: &str,
        username: &str,
        password: &str,
    ) -> Result<Option<PendingSave>, String> {
        let origin = self.origin_for_tab(url, kind)?;
        let settings = self.settings.get().passwords;
        if !settings.offer_save {
            return Ok(None);
        }
        if settings.never_save.iter().any(|entry| entry == &origin) {
            return Ok(None);
        }
        if password.is_empty() {
            return Ok(None);
        }

        let username: String = username
            .trim()
            .chars()
            .take(ncc_vault::MAX_USERNAME)
            .collect();
        let password: String = password.chars().take(ncc_vault::MAX_PASSWORD).collect();
        let title: String = title.trim().chars().take(ncc_vault::MAX_TITLE).collect();

        let now = self.now();
        let mut state = self.secure();

        state.pending.retain(|_, pending| pending.expires > now);

        let duplicate = state.pending.values().any(|pending| {
            pending.origin == origin && pending.username == username && pending.password == password
        });
        if duplicate {
            return Ok(None);
        }

        let existing = state
            .vault
            .as_ref()
            .and_then(|vault| find_entry_for(vault, &origin, &username));
        if existing
            .as_ref()
            .map(|entry| entry.password == password)
            .unwrap_or(false)
        {
            return Ok(None);
        }

        let id = format!("{:016x}", random_u64());
        let pending_title = if title.is_empty() {
            origin.clone()
        } else {
            title
        };
        state.pending.insert(
            id.clone(),
            Pending {
                origin: origin.clone(),
                title: pending_title.clone(),
                username: username.clone(),
                password,
                expires: now + PENDING_TTL,
            },
        );

        Ok(Some(PendingSave {
            id,
            origin,
            title: pending_title,
            username,
            mode: if existing.is_some() {
                "update"
            } else {
                "create"
            }
            .to_string(),
            locked: !state.unlocked,
        }))
    }

    pub async fn respond_to_save(&self, id: &str, action: &str) -> SaveOutcome {
        let pending = {
            let now = self.now();
            let mut state = self.secure();
            state.pending.retain(|_, pending| pending.expires > now);
            state.pending.remove(id)
        };

        let Some(pending) = pending else {
            return SaveOutcome {
                ok: false,
                pending: false,
                error: Some("That save request expired".to_string()),
                status: self.status(),
            };
        };

        match action {
            "dismiss" => SaveOutcome {
                ok: true,
                pending: false,
                error: None,
                status: self.status(),
            },
            "never" => match self.settings.add_never_save(&pending.origin) {
                Ok(_) => SaveOutcome {
                    ok: true,
                    pending: false,
                    error: None,
                    status: self.status(),
                },
                Err(error) => SaveOutcome {
                    ok: false,
                    pending: false,
                    error: Some(error),
                    status: self.status(),
                },
            },
            "save" => {
                if !self.secure().unlocked {
                    return SaveOutcome {
                        ok: false,
                        pending: false,
                        error: Some(LOCKED.to_string()),
                        status: self.status(),
                    };
                }
                let existing = self
                    .secure()
                    .vault
                    .as_ref()
                    .and_then(|vault| find_entry_for(vault, &pending.origin, &pending.username))
                    .map(|entry| entry.id);

                self.save(Draft {
                    id: existing.clone(),
                    origin: pending.origin,
                    title: pending.title,
                    username: pending.username,
                    password: pending.password,
                    notes: existing
                        .as_deref()
                        .and_then(|id| self.entry(id).ok())
                        .map(|entry| entry.notes)
                        .unwrap_or_default(),
                    totp: existing
                        .as_deref()
                        .and_then(|id| self.entry(id).ok())
                        .map(|entry| entry.totp)
                        .unwrap_or_default(),
                    passkey: None,
                })
                .await
            }
            _ => SaveOutcome {
                ok: false,
                pending: false,
                error: Some("Unknown action".to_string()),
                status: self.status(),
            },
        }
    }

    pub async fn save(&self, draft: Draft) -> SaveOutcome {
        self.expire();
        if !self.secure().unlocked {
            return SaveOutcome {
                ok: false,
                pending: false,
                error: Some(LOCKED.to_string()),
                status: self.status(),
            };
        }

        let result = self.save_inner(draft).await;
        match result {
            Ok((entry, pending, error)) => {
                {
                    let mut state = self.secure();
                    if let Some(vault) = state.vault.clone() {
                        state.vault = Some(apply_entry(&vault, entry));
                    }
                    state.error = error.clone();
                }
                SaveOutcome {
                    ok: true,
                    pending,
                    error,
                    status: self.status(),
                }
            }
            Err(error) => {
                self.fail(error.clone());
                SaveOutcome {
                    ok: false,
                    pending: false,
                    error: Some(error),
                    status: self.status(),
                }
            }
        }
    }

    async fn save_inner(
        &self,
        draft: Draft,
    ) -> Result<(PasswordEntry, bool, Option<String>), String> {
        let origin = draft_origin(&draft.origin)
            .ok_or_else(|| "Enter an https:// or ncc:// address".to_string())?;

        let pubkey = self.require_pubkey()?;
        self.ensure_latest(&pubkey).await;

        let now = self.now();
        let (vault, existing) = {
            let state = self.secure();
            let vault = state.vault.clone().ok_or_else(|| VAULT_ERROR.to_string())?;
            let existing = draft
                .id
                .as_deref()
                .and_then(|id| find_entry(&vault, id))
                .cloned();
            (vault, existing)
        };

        let id = existing
            .as_ref()
            .map(|entry| entry.id.clone())
            .unwrap_or_else(|| format!("{:016x}", random_u64()));

        let entry = PasswordEntry {
            id,
            origin,
            title: clip(&draft.title, ncc_vault::MAX_TITLE),
            username: clip(&draft.username, ncc_vault::MAX_USERNAME),
            // Not clipped through `clip`: a password's spaces are part of it.
            password: draft
                .password
                .chars()
                .take(ncc_vault::MAX_PASSWORD)
                .collect(),
            notes: clip(&draft.notes, ncc_vault::MAX_NOTES),
            totp: clip(&draft.totp, ncc_vault::MAX_TOTP),
            created_at: existing
                .as_ref()
                .map(|entry| entry.created_at)
                .unwrap_or(now),
            updated_at: now,
            deleted: false,
            passkey: draft.passkey.or_else(|| existing.as_ref().and_then(|entry| entry.passkey.clone())),
        };

        let next = apply_entry(&vault, entry.clone());
        let (published, error) = self.publish(&pubkey, next).await?;
        Ok((entry, published, error))
    }

    pub async fn remove(&self, id: &str) -> SaveOutcome {
        self.expire();
        if !self.secure().unlocked {
            return SaveOutcome {
                ok: false,
                pending: false,
                error: Some(LOCKED.to_string()),
                status: self.status(),
            };
        }

        let result = self.remove_inner(id).await;
        match result {
            Ok((pending, error)) => SaveOutcome {
                ok: true,
                pending,
                error,
                status: self.status(),
            },
            Err(error) => {
                self.fail(error.clone());
                SaveOutcome {
                    ok: false,
                    pending: false,
                    error: Some(error),
                    status: self.status(),
                }
            }
        }
    }

    async fn remove_inner(&self, id: &str) -> Result<(bool, Option<String>), String> {
        let pubkey = self.require_pubkey()?;
        self.ensure_latest(&pubkey).await;

        let (vault, mut entry) = {
            let state = self.secure();
            let vault = state.vault.clone().ok_or_else(|| VAULT_ERROR.to_string())?;
            let entry = find_entry(&vault, id)
                .filter(|entry| !entry.deleted)
                .cloned()
                .ok_or_else(|| "That login no longer exists".to_string())?;
            (vault, entry)
        };
        entry.deleted = true;
        entry.updated_at = self.now();

        let next = apply_entry(&vault, entry);
        let (pending, error) = self.publish(&pubkey, next).await?;
        Ok((pending, error))
    }

    /// Merge the newest relay copy into memory. Called before a write, so a save never
    /// clobbers an entry another device added.
    async fn ensure_latest(&self, pubkey: &str) {
        let relays = self.network_relays(pubkey).await;
        if relays.is_empty() {
            return;
        }

        // Offline is fine here: a save goes ahead locally and is retried by the next sync.
        let Ok(Some(remote)) = self.fetch_remote(&relays, pubkey).await else {
            return;
        };

        let mut state = self.secure();
        let cached_at = state
            .cached
            .as_ref()
            .map(|cached| cached.event.created_at.as_secs());
        if cached_at
            .map(|at| remote.created_at.as_secs() < at)
            .unwrap_or(false)
        {
            return;
        }
        if state
            .cached
            .as_ref()
            .map(|cached| cached.event.id == remote.id)
            .unwrap_or(false)
        {
            return;
        }

        let Ok(remote_vault) = decrypt(&self.identity, pubkey, &remote) else {
            return;
        };
        let local = state.vault.clone().unwrap_or_default();
        let (merged, changed) = merge_vaults(&local, &remote_vault);
        state.vault = Some(merged);
        state.last_created_at = state.last_created_at.max(remote.created_at.as_secs());
        if !changed {
            state.cached = Some(CachedVault {
                event: remote,
                pending: false,
                synced_at: Some(self.now()),
            });
            state.last_synced_at = Some(self.now());
        }
    }

    /// Pull the relay copy and publish the union when the remote had entries we lacked.
    async fn sync(&self, publish_merged: bool) -> Result<(), String> {
        let pubkey = self.require_pubkey()?;
        let relays = self.network_relays(&pubkey).await;
        if relays.is_empty() {
            return Ok(());
        }

        {
            let mut state = self.secure();
            if state.syncing {
                return Ok(());
            }
            state.syncing = true;
        }

        let outcome = self.sync_inner(&relays, &pubkey, publish_merged).await;

        let mut state = self.secure();
        state.syncing = false;
        match outcome {
            Ok(()) => {
                state.last_synced_at = Some(self.now());
                state.error = None;
                Ok(())
            }
            Err(error) => {
                state.error = Some(error.clone());
                Err(error)
            }
        }
    }

    async fn sync_inner(
        &self,
        relays: &[String],
        pubkey: &str,
        publish_merged: bool,
    ) -> Result<(), String> {
        // No relay answering is a failure, not an empty vault: calling it "synced" would
        // hide that a login never left the device.
        let remote = self.fetch_remote(relays, pubkey).await?;

        // A save that no relay accepted is retried here, whatever the relays hold.
        let (local, was_pending, cached_id) = {
            let state = self.secure();
            (
                state.vault.clone().unwrap_or_default(),
                state.cached.as_ref().is_some_and(|cached| cached.pending),
                state.cached.as_ref().map(|cached| cached.event.id),
            )
        };

        let Some(remote) = remote else {
            // The relays have no vault yet: send ours if there is anything in it.
            if publish_merged && (was_pending || !local.entries.is_empty()) {
                let (_, error) = self.publish(pubkey, local).await?;
                if let Some(error) = error {
                    return Err(error);
                }
            }
            return Ok(());
        };

        if cached_id == Some(remote.id) && !was_pending {
            return Ok(());
        }

        let remote_vault = decrypt(&self.identity, pubkey, &remote)?;
        let (merged, changed) = merge_vaults(&local, &remote_vault);

        {
            let mut state = self.secure();
            state.vault = Some(merged.clone());
            state.last_created_at = state.last_created_at.max(remote.created_at.as_secs());
            if !changed && !was_pending {
                state.cached = Some(CachedVault {
                    event: remote,
                    pending: false,
                    synced_at: Some(self.now()),
                });
            }
        }

        if (changed || was_pending) && publish_merged {
            // Either the remote copy won something, so the union has to go back out or
            // the other device would keep offering its older entry, or an earlier
            // publish never reached a relay.
            let (_, error) = self.publish(pubkey, merged).await?;
            if let Some(error) = error {
                return Err(error);
            }
        }

        Ok(())
    }

    /// The newest vault event any relay holds. `Err` only when no relay answered at all;
    /// `Ok(None)` means they answered and have none.
    async fn fetch_remote(
        &self,
        relays: &[String],
        pubkey: &str,
    ) -> Result<Option<nostr::Event>, String> {
        let signer = self.signer();
        let filter = vault_filter(pubkey);
        let attempts = relays
            .iter()
            .map(|relay| relay::query_authed(relay, &filter, RELAY_WAIT, &signer))
            .collect::<Vec<_>>();
        let results = futures_util::future::join_all(attempts).await;

        let mut valid: Vec<nostr::Event> = Vec::new();
        let mut answered = 0;
        let mut first_error = None;
        for result in results {
            match result {
                Ok(events) => {
                    answered += 1;
                    valid.extend(events.into_iter().filter(|event| {
                        event.kind.as_u16() as u64 == VAULT_KIND
                            && event.pubkey.to_hex() == pubkey
                            && event.content.len() <= 1_000_000
                            && event.tags.iter().any(|tag| {
                                let parts = tag.as_slice();
                                parts.len() >= 2 && parts[0] == "d" && parts[1] == VAULT_D
                            })
                            && event.verify().is_ok()
                    }))
                }
                Err(error) => {
                    tracing::debug!(target: "ncc_proxy::vault", "{error}");
                    first_error.get_or_insert(error);
                }
            }
        }
        if answered == 0 {
            return Err(first_error.unwrap_or_else(|| "No relay answered".to_string()));
        }

        valid.sort_by(|a, b| {
            b.created_at
                .as_secs()
                .cmp(&a.created_at.as_secs())
                .then_with(|| a.id.to_hex().cmp(&b.id.to_hex()))
        });
        Ok(valid.into_iter().next())
    }

    fn signer(&self) -> Signer {
        let identity = self.identity.clone();
        Arc::new(move |template: Value| {
            identity
                .sign_event(&template)
                .map_err(|error| error.to_string())
        })
    }

    async fn publish(
        &self,
        pubkey: &str,
        vault: PasswordVault,
    ) -> Result<(bool, Option<String>), String> {
        if !is_vault_within_limit(&vault) {
            return Err(format!(
                "The vault would exceed {} KB. Remove entries or shorten notes.",
                vault_byte_length(&vault) / 1024
            ));
        }

        let relays = self.network_relays(pubkey).await;
        if relays.is_empty() {
            return Err("No vault relay is configured".to_string());
        }

        let plaintext = serde_json::to_string(&vault).map_err(|error| error.to_string())?;
        let content = self
            .identity
            .nip44_encrypt(pubkey, &plaintext)
            .map_err(|_| NO_IDENTITY.to_string())?;

        let created_at = {
            let previous = self.secure().last_created_at;
            self.now().max(previous.saturating_add(1))
        };

        let template = json!({
            "kind": VAULT_KIND,
            "created_at": created_at,
            "tags": [
                ["d", VAULT_D],
                ["t", VAULT_TAG],
                ["client", VAULT_CLIENT],
            ],
            "content": content,
        });
        let event = self
            .identity
            .sign_event(&template)
            .map_err(|error| format!("The vault could not be signed: {error}"))?;
        if event.verify().is_err() {
            return Err("The signed vault event is invalid".to_string());
        }

        let signer = self.signer();
        let (accepted, first_error) =
            relay::publish_all(&relays, &event, &signer, RELAY_WAIT).await;
        let pending = accepted < relays.len();

        let cached = CachedVault {
            event,
            pending,
            synced_at: Some(self.now()),
        };
        self.cache().set(pubkey, cached.clone());

        let error = if pending {
            Some(match accepted {
                0 => format!(
                    "No relay accepted the vault ({} tried){}",
                    relays.len(),
                    first_error
                        .map(|error| format!(": {error}"))
                        .unwrap_or_default()
                ),
                accepted => format!(
                    "{accepted} of {} relays accepted the vault{}",
                    relays.len(),
                    first_error
                        .map(|error| format!(": {error}"))
                        .unwrap_or_default()
                ),
            })
        } else {
            None
        };

        let mut state = self.secure();
        state.cached = Some(cached);
        state.last_created_at = created_at;
        state.last_synced_at = Some(self.now());
        state.vault = Some(vault);
        state.error = error.clone();

        Ok((pending, error))
    }

    /// Called when the shell regains focus: pull, but not more often than every 30s.
    pub async fn on_focus(&self) -> VaultStatus {
        self.expire();
        let should_sync = {
            let state = self.secure();
            state.unlocked
                && !state.syncing
                && state
                    .last_synced_at
                    .map(|at| self.now().saturating_sub(at) > 30)
                    .unwrap_or(true)
        };
        if should_sync {
            let _ = self.sync(true).await;
        }
        self.status()
    }
}

fn clear_vault(state: &mut State) {
    state.unlocked = false;
    state.pubkey = None;
    state.vault = None;
    state.last_activity = 0;
}

fn decrypt(
    identity: &IdentityStore,
    pubkey: &str,
    event: &nostr::Event,
) -> Result<PasswordVault, String> {
    let plaintext = identity
        .nip44_decrypt(pubkey, &event.content)
        .map_err(|_| VAULT_ERROR.to_string())?;
    let parsed: Value = serde_json::from_str(&plaintext)
        .map_err(|_| "The decrypted vault is not valid JSON".to_string())?;
    let version = parsed.get("v").and_then(Value::as_u64).unwrap_or_default();
    if version != u64::from(VAULT_VERSION) {
        return Err("This vault was created by a newer version".to_string());
    }
    Ok(normalize_vault(&parsed))
}

fn clip(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

fn random_u64() -> u64 {
    rand::random::<u64>()
}

fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> Arc<SettingsStore> {
        // A relay that refuses the connection immediately: saves then complete
        // locally with `pending`, which is the path a device with no relay takes,
        // without any test waiting on a network.
        Arc::new(SettingsStore::in_memory(crate::settings::Settings {
            relays: vec!["ws://127.0.0.1:1".to_string()],
            ..Default::default()
        }))
    }

    fn identity() -> Arc<IdentityStore> {
        // An ephemeral store is generated unlocked, which is what these tests need.
        Arc::new(IdentityStore::ephemeral())
    }

    fn service(clock: u64) -> VaultService {
        let dir =
            std::env::temp_dir().join(format!("ncc-vault-service-{}-{clock}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        VaultService::with_clock(
            identity(),
            settings(),
            dir.join("cache.json"),
            Arc::new(move || clock),
        )
    }

    const NPUB: &str = "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhs2n3v";

    #[tokio::test]
    async fn unlock_without_a_relay_opens_an_empty_vault() {
        let vault = service(1000);
        let status = vault.unlock().await;
        assert!(status.unlocked);
        assert_eq!(status.entry_count, 0);
        assert_eq!(status.relays.len(), 1);
    }

    #[tokio::test]
    async fn a_save_lands_in_memory_and_in_the_cache() {
        let vault = service(1000);
        vault.unlock().await;

        let outcome = vault
            .save(Draft {
                id: None,
                origin: "example.com".into(),
                title: "Example".into(),
                username: "alice".into(),
                password: "hunter2".into(),
                notes: String::new(),
                totp: String::new(),
                passkey: None,
            })
            .await;

        // No relay accepted it because this test has none, but the entry exists.
        assert!(outcome.ok);
        assert!(outcome.pending);
        assert_eq!(vault.list().len(), 1);
        assert_eq!(vault.list()[0].origin, "https://example.com");
    }

    #[tokio::test]
    async fn a_fill_cannot_cross_origins() {
        let vault = service(2000);
        vault.unlock().await;
        vault
            .save(Draft {
                id: None,
                origin: "https://bank.example".into(),
                title: "Bank".into(),
                username: "alice".into(),
                password: "secret".into(),
                notes: String::new(),
                totp: String::new(),
                passkey: None,
            })
            .await;

        let id = vault.list()[0].id.clone();
        let filled = vault
            .fill(&id, "https://bank.example/login", "normal")
            .expect("same origin");
        assert_eq!(filled.password, "secret");

        let error = vault
            .fill(&id, "https://evil.example/login", "normal")
            .expect_err("other origin");
        assert!(error.contains("different site"));
    }

    #[tokio::test]
    async fn vhosts_map_to_ncc_origins_and_other_tabs_are_refused() {
        let vault = service(3000);
        assert_eq!(
            vault
                .origin_for_tab(&format!("http://{NPUB}.web.localhost:47822/x"), "normal")
                .unwrap(),
            format!("ncc://{NPUB}/web")
        );
        assert_eq!(
            vault
                .origin_for_tab(&format!("http://{NPUB}.localhost:47822/"), "normal")
                .unwrap(),
            format!("ncc://{NPUB}/addr")
        );
        assert!(vault
            .origin_for_tab(&format!("http://{NPUB}.web.localhost:1/"), "private")
            .is_err());
        assert!(vault
            .origin_for_tab("http://example.com/", "normal")
            .unwrap_err()
            .contains("insecure"));
    }

    #[tokio::test]
    async fn a_capture_is_offered_once_and_respects_never_save() {
        let vault = service(4000);
        vault.unlock().await;

        let pending = vault
            .capture(
                "https://example.com/login",
                "normal",
                "Example",
                "alice",
                "hunter2",
            )
            .unwrap()
            .expect("pending");
        assert_eq!(pending.mode, "create");
        assert!(!pending.locked);

        // The same submit twice must not produce two prompts.
        assert!(vault
            .capture(
                "https://example.com/login",
                "normal",
                "Example",
                "alice",
                "hunter2"
            )
            .unwrap()
            .is_none());

        vault.respond_to_save(&pending.id, "never").await;
        assert!(vault
            .capture(
                "https://example.com/login",
                "normal",
                "Example",
                "alice",
                "other"
            )
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn accepting_a_capture_saves_it() {
        let vault = service(5000);
        vault.unlock().await;

        let pending = vault
            .capture(
                "https://example.com",
                "normal",
                "Example",
                "alice",
                "hunter2",
            )
            .unwrap()
            .expect("pending");
        let outcome = vault.respond_to_save(&pending.id, "save").await;
        assert!(outcome.ok, "{:?}", outcome.error);
        assert_eq!(vault.list().len(), 1);
    }

    #[tokio::test]
    async fn the_idle_timer_locks_the_vault() {
        let clock = Arc::new(Mutex::new(10_000u64));
        let dir = std::env::temp_dir().join(format!(
            "ncc-vault-lock-{}-{}",
            std::process::id(),
            *clock.lock().unwrap()
        ));
        let _ = std::fs::remove_dir_all(&dir);

        let ticking = clock.clone();
        let vault = VaultService::with_clock(
            identity(),
            settings(),
            dir.join("cache.json"),
            Arc::new(move || *ticking.lock().unwrap()),
        );

        vault.unlock().await;
        assert!(vault.status().unlocked);

        // Fifteen minutes is the default.
        *clock.lock().unwrap() = 10_000 + 15 * 60;
        let status = vault.status();
        assert!(!status.unlocked);
        assert_eq!(status.entry_count, 0);
    }

    #[tokio::test]
    async fn a_tombstone_removes_an_entry_from_the_list() {
        let vault = service(6000);
        vault.unlock().await;
        vault
            .save(Draft {
                id: None,
                origin: "https://example.com".into(),
                title: "Example".into(),
                username: "alice".into(),
                password: "hunter2".into(),
                notes: String::new(),
                totp: String::new(),
                passkey: None,
            })
            .await;

        let id = vault.list()[0].id.clone();
        let outcome = vault.remove(&id).await;
        assert!(outcome.ok, "{:?}", outcome.error);
        assert!(vault.list().is_empty());
    }

    /// The shell's command layer requires every future to be `Send`; a guard held
    /// across an await would show up here instead of as a build failure three crates
    /// away.
    #[test]
    fn the_async_api_is_send() {
        fn assert_send<T: Send>(_: T) {}
        let vault = service(9000);
        assert_send(vault.unlock());
        assert_send(vault.save(Draft {
            id: None,
            origin: "https://example.com".into(),
            title: String::new(),
            username: String::new(),
            password: String::new(),
            notes: String::new(),
            totp: String::new(),
            passkey: None,
        }));
        assert_send(vault.remove("0123456789abcdef"));
        assert_send(vault.respond_to_save("0123456789abcdef", "dismiss"));
        assert_send(vault.on_focus());
    }

    #[test]
    fn generated_ids_are_hex_and_sixteen_long() {
        let id = format!("{:016x}", random_u64());
        assert_eq!(id.len(), 16);
        assert!(ncc_vault::is_entry_id(&id));
    }

    #[test]
    fn totp_codes_are_derived_for_the_stored_secret() {
        // The service reads the vault through the same code path the UI uses.
        let secret = TotpSecret::parse("JBSWY3DP").unwrap();
        let code = secret.code(7000 * 1000);
        assert_eq!(code.code.len(), 6);
    }

    /// A relay in this process that keeps the newest event per `d` tag, enough for the
    /// vault to publish to and read from.
    async fn memory_relay() -> (String, Arc<Mutex<HashMap<String, Value>>>) {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let url = format!("ws://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let store: Arc<Mutex<HashMap<String, Value>>> = Arc::new(Mutex::new(HashMap::new()));
        let shared = store.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let store = shared.clone();
                tokio::spawn(async move {
                    let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                        return;
                    };
                    while let Some(Ok(Message::Text(text))) = socket.next().await {
                        let Ok(value) = serde_json::from_str::<Value>(&text) else {
                            continue;
                        };
                        match value.get(0).and_then(Value::as_str) {
                            Some("EVENT") => {
                                let event = value[1].clone();
                                let d = event["tags"]
                                    .as_array()
                                    .and_then(|tags| {
                                        tags.iter()
                                            .find(|tag| tag[0] == "d")
                                            .map(|tag| tag[1].to_string())
                                    })
                                    .unwrap_or_default();
                                let id = event["id"].clone();
                                store.lock().unwrap().insert(d, event);
                                let _ = socket
                                    .send(Message::Text(
                                        json!(["OK", id, true, ""]).to_string().into(),
                                    ))
                                    .await;
                            }
                            Some("REQ") => {
                                let sub = value[1].clone();
                                let events: Vec<Value> =
                                    store.lock().unwrap().values().cloned().collect();
                                for event in events {
                                    let _ = socket
                                        .send(Message::Text(
                                            json!(["EVENT", sub, event]).to_string().into(),
                                        ))
                                        .await;
                                }
                                let _ = socket
                                    .send(Message::Text(json!(["EOSE", sub]).to_string().into()))
                                    .await;
                            }
                            _ => {}
                        }
                    }
                });
            }
        });
        (url, store)
    }

    fn draft(origin: &str, user: &str) -> Draft {
        Draft {
            id: None,
            origin: origin.into(),
            title: String::new(),
            username: user.into(),
            password: "secret".into(),
            notes: String::new(),
            totp: String::new(),
            passkey: None,
        }
    }

    #[tokio::test]
    async fn a_relay_that_cannot_be_reached_is_reported_not_called_synced() {
        let vault = service(3000);
        let status = vault.unlock().await;
        assert!(
            status.error.is_some(),
            "unlocking against a dead relay must say the relay copy was not fetched: {status:?}"
        );
    }

    #[tokio::test]
    async fn a_login_saved_offline_reaches_the_relay_on_the_next_sync() {
        let (url, store) = memory_relay().await;
        let settings = settings(); // starts with a dead relay
        let dir = std::env::temp_dir().join(format!("ncc-vault-offline-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let vault = VaultService::with_clock(
            identity(),
            settings.clone(),
            dir.join("cache.json"),
            Arc::new(|| 4000),
        );
        vault.unlock().await;
        let outcome = vault.save(draft("https://offline.example", "alice")).await;
        assert!(outcome.ok && outcome.pending, "{outcome:?}");
        assert!(store.lock().unwrap().is_empty());

        // Back online.
        settings.set_relays(vec![url]).unwrap();
        vault.sync(true).await.unwrap();
        assert_eq!(
            store.lock().unwrap().len(),
            1,
            "a pending save has to be published once a relay is reachable"
        );
    }

    /// Cross-implementation check against a real relay, with `test/password-live.test.ts`:
    ///
    /// ```text
    /// nak serve --port 10547 &
    /// export NCC_SYNC_RELAY=ws://127.0.0.1:10547 NCC_SYNC_NSEC=<hex>
    /// NCC_VAULT_PHASE=1 cargo test -p ncc-proxy vault::tests::live -- --ignored
    /// npx vitest run test/password-live.test.ts
    /// NCC_VAULT_PHASE=2 cargo test -p ncc-proxy vault::tests::live -- --ignored
    /// ```
    #[tokio::test]
    #[ignore = "needs a relay and a key: see the doc comment"]
    async fn live_round_trip_with_the_desktop_build() {
        let (Ok(relay), Ok(nsec), Ok(phase)) = (
            std::env::var("NCC_SYNC_RELAY"),
            std::env::var("NCC_SYNC_NSEC"),
            std::env::var("NCC_VAULT_PHASE"),
        ) else {
            panic!("set NCC_SYNC_RELAY, NCC_SYNC_NSEC and NCC_VAULT_PHASE");
        };
        let dir = std::env::temp_dir().join(format!("ncc-vault-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
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
        let vault = VaultService::new(identity, settings, dir.join("cache.json"));
        let status = vault.unlock().await;
        assert!(status.unlocked, "{status:?}");

        if phase == "1" {
            let outcome = vault
                .save(Draft {
                    id: None,
                    origin: "https://phone.example".into(),
                    title: "Phone login".into(),
                    username: "alice".into(),
                    password: "phone password with spaces ".into(),
                    notes: "from android".into(),
                    totp: String::new(),
                    passkey: None,
                })
                .await;
            assert!(outcome.ok && !outcome.pending, "{outcome:?}");
        } else {
            // The desktop has merged and added its own login.
            let origins: Vec<_> = vault
                .list()
                .iter()
                .map(|entry| entry.origin.clone())
                .collect();
            assert!(
                origins.contains(&"https://phone.example".to_string()),
                "{origins:?}"
            );
            assert!(
                origins.contains(&"https://desktop.example".to_string()),
                "{origins:?}"
            );
            let desktop = vault
                .matches("https://desktop.example/login", "normal")
                .unwrap()
                .into_iter()
                .next()
                .expect("the desktop login matches its own origin");
            let credentials = vault
                .fill(&desktop.id, "https://desktop.example/login", "normal")
                .unwrap();
            assert_eq!(credentials.username, "bob");
            assert_eq!(credentials.password, "desktop-secret");
        }
    }
}
