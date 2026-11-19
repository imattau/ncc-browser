//! Android payment cards are encrypted to the local NCC identity before touching disk.
//! The cache file contains only the NIP-44 ciphertext; decrypted records live only while
//! the vault is unlocked.
use ncc_identity::IdentityStore;
use ncc_proxy::{own_relays::OwnRelays, settings::SettingsStore};
use nostr::Event;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    sync::OnceLock,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub name: String,
    pub number: String,
    #[serde(default)]
    pub cvc: Option<String>,
    pub exp_month: String,
    pub exp_year: String,
    #[serde(default)]
    pub nickname: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub deleted: bool,
}
#[derive(Serialize, Deserialize)]
struct Vault {
    v: u8,
    updated_at: u64,
    cards: Vec<Card>,
    #[serde(default)]
    tombstones: Vec<Tombstone>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Tombstone {
    id: String,
    deleted_at: u64,
}

static SYSTEM_AUTH_GRANT: OnceLock<Mutex<Option<std::time::Instant>>> = OnceLock::new();

pub fn record_system_auth(success: bool) {
    let grant = SYSTEM_AUTH_GRANT.get_or_init(|| Mutex::new(None));
    *grant.lock().unwrap_or_else(|e| e.into_inner()) = if success {
        Some(std::time::Instant::now() + Duration::from_secs(60))
    } else {
        None
    };
}

fn consume_system_auth() -> bool {
    let grant = SYSTEM_AUTH_GRANT.get_or_init(|| Mutex::new(None));
    let mut grant = grant.lock().unwrap_or_else(|e| e.into_inner());
    let valid = grant.is_some_and(|expires| expires > std::time::Instant::now());
    *grant = None;
    valid
}
#[derive(Serialize, Deserialize)]
struct Cache {
    pubkey: String,
    content: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    id: String,
    name: String,
    last4: String,
    network: String,
    exp_month: String,
    exp_year: String,
    nickname: String,
}
pub struct CardStore {
    path: PathBuf,
    cards: Mutex<Option<(String, Vec<Card>, Vec<Tombstone>)>>,
    generation: AtomicU64,
    own_relays: OwnRelays,
}
impl CardStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            cards: Mutex::new(None),
            generation: AtomicU64::new(0),
            own_relays: OwnRelays::default(),
        }
    }
    pub fn unlock(&self, identity: &IdentityStore) -> Result<(), String> {
        record_system_auth(false);
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let pubkey = identity.public_key().map_err(|e| e.to_string())?.to_hex();
        let cards = fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Cache>(&b).ok())
            .filter(|c| c.pubkey == pubkey)
            .and_then(|c| identity.nip44_decrypt(&pubkey, &c.content).ok())
            .and_then(|s| serde_json::from_str::<Vault>(&s).ok())
            .map(migrate_vault)
            .map(|v| (v.cards, v.tombstones))
            .unwrap_or_default();
        if self.generation.load(Ordering::SeqCst) != generation {
            return Err("The active identity changed while unlocking payment cards".into());
        }
        *self.cards.lock().unwrap_or_else(|e| e.into_inner()) = Some((pubkey, cards.0, cards.1));
        Ok(())
    }
    pub fn lock(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        record_system_auth(false);
        *self.cards.lock().unwrap_or_else(|e| e.into_inner()) = None
    }
    pub fn authorization_generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
    pub fn authorization_generation_is_active(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
            && self
                .cards
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some()
    }
    pub fn list(&self, expected_pubkey: &str) -> Result<Vec<Summary>, String> {
        let s = self.cards.lock().unwrap_or_else(|e| e.into_inner());
        let (pubkey, cards, _) = s.as_ref().ok_or("Unlock payment cards first")?;
        if pubkey != expected_pubkey {
            return Err("The active identity changed. Unlock payment cards again.".into());
        }
        Ok(cards
            .iter()
            .filter(|c| !c.deleted)
            .map(|c| Summary {
                id: c.id.clone(),
                name: c.name.clone(),
                last4: c
                    .number
                    .chars()
                    .rev()
                    .take(4)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect(),
                network: network(&c.number).into(),
                exp_month: c.exp_month.clone(),
                exp_year: c.exp_year.clone(),
                nickname: c.nickname.clone(),
            })
            .collect())
    }
    pub fn get(&self, expected_pubkey: &str, id: &str) -> Result<Card, String> {
        if !consume_system_auth() {
            return Err("Confirm with the device credential before accessing card details".into());
        }
        let s = self.cards.lock().unwrap_or_else(|e| e.into_inner());
        s.as_ref()
            .filter(|(pubkey, _, _)| pubkey == expected_pubkey)
            .and_then(|(_, v, _)| v.iter().find(|c| c.id == id && !c.deleted))
            .cloned()
            .ok_or_else(|| "That card is unavailable".into())
    }
    pub fn save(
        &self,
        identity: &IdentityStore,
        mut card: Card,
        save_cvc: bool,
    ) -> Result<(), String> {
        if !luhn(&card.number) {
            return Err("Enter a valid card number".into());
        }
        let month = card.exp_month.parse::<u32>().unwrap_or(0);
        if !(1..=12).contains(&month) {
            return Err("Enter a valid expiry month".into());
        }
        if card.exp_year.len() != 2 && card.exp_year.len() != 4 {
            return Err("Enter a valid expiry year".into());
        }
        let year = card.exp_year.parse::<u32>().unwrap_or(0);
        let year = if year < 100 { 2000 + year } else { year };
        let now_date = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let days = now_date / 86400;
        let current_year = 1970 + (days / 365);
        if year < current_year as u32 {
            return Err("This card has expired".into());
        }
        if !save_cvc {
            card.cvc = None
        }
        if let Some(cvc) = &card.cvc {
            if !matches!(cvc.len(), 3 | 4) || !cvc.chars().all(|c| c.is_ascii_digit()) {
                card.cvc = None
            }
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let mut guard = self.cards.lock().unwrap_or_else(|e| e.into_inner());
        let (pubkey, cards, tombstones) = guard.as_mut().ok_or("Unlock payment cards first")?;
        let active_pubkey = identity.public_key().map_err(|e| e.to_string())?.to_hex();
        if *pubkey != active_pubkey {
            return Err("The active identity changed. Unlock payment cards again.".into());
        }
        if card.id.is_empty() {
            card.id = format!("{:016x}", now);
            card.created_at = now
        }
        card.updated_at = now;
        cards.retain(|c| c.id != card.id);
        tombstones.retain(|item| item.id != card.id);
        cards.push(card);
        let data = serde_json::to_string(&Vault {
            v: 1,
            updated_at: now,
            cards: cards.clone(),
            tombstones: tombstones.clone(),
        })
        .map_err(|e| e.to_string())?;
        let cache = Cache {
            pubkey: pubkey.clone(),
            content: identity
                .nip44_encrypt(pubkey, &data)
                .map_err(|e| e.to_string())?,
        };
        let bytes = serde_json::to_vec(&cache).map_err(|e| e.to_string())?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?
        }
        let tmp = self.path.with_extension("tmp");
        fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        fs::rename(tmp, &self.path).map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn clear_cvc(&self, identity: &IdentityStore) -> Result<(), String> {
        let mut guard = self.cards.lock().unwrap_or_else(|e| e.into_inner());
        let (pubkey, cards, tombstones) = guard.as_mut().ok_or("Unlock payment cards first")?;
        let active_pubkey = identity.public_key().map_err(|e| e.to_string())?.to_hex();
        if *pubkey != active_pubkey {
            return Err("The active identity changed. Unlock payment cards again.".into());
        }
        for c in cards.iter_mut() {
            c.cvc = None;
            c.updated_at = now_ms();
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let data = serde_json::to_string(&Vault {
            v: 1,
            updated_at: now,
            cards: cards.clone(),
            tombstones: tombstones.clone(),
        })
        .map_err(|e| e.to_string())?;
        let cache = Cache {
            pubkey: pubkey.clone(),
            content: identity
                .nip44_encrypt(pubkey, &data)
                .map_err(|e| e.to_string())?,
        };
        let bytes = serde_json::to_vec(&cache).map_err(|e| e.to_string())?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?
        }
        let tmp = self.path.with_extension("tmp");
        fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        fs::rename(tmp, &self.path).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn remove(&self, identity: &IdentityStore, id: &str) -> Result<(), String> {
        let mut guard = self.cards.lock().unwrap_or_else(|e| e.into_inner());
        let (pubkey, cards, tombstones) = guard.as_mut().ok_or("Unlock payment cards first")?;
        let active_pubkey = identity.public_key().map_err(|e| e.to_string())?.to_hex();
        if *pubkey != active_pubkey {
            return Err("The active identity changed. Unlock payment cards again.".into());
        }
        if !cards.iter().any(|c| c.id == id && !c.deleted) {
            return Err("That card is unavailable".into());
        }
        cards.retain(|c| c.id != id);
        let deleted_at = now_ms();
        tombstones.retain(|item| item.id != id);
        tombstones.push(Tombstone {
            id: id.to_string(),
            deleted_at,
        });
        let data = serde_json::to_string(&Vault {
            v: 1,
            updated_at: deleted_at,
            cards: cards.clone(),
            tombstones: tombstones.clone(),
        })
        .map_err(|e| e.to_string())?;
        let cache = Cache {
            pubkey: pubkey.clone(),
            content: identity
                .nip44_encrypt(pubkey, &data)
                .map_err(|e| e.to_string())?,
        };
        let bytes = serde_json::to_vec(&cache).map_err(|e| e.to_string())?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?
        }
        let tmp = self.path.with_extension("tmp");
        fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        fs::rename(tmp, &self.path).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn sync(
        &self,
        identity: Arc<IdentityStore>,
        settings: Arc<SettingsStore>,
    ) -> Result<(), String> {
        let generation = self.generation.load(Ordering::SeqCst);
        let pubkey = identity.public_key().map_err(|e| e.to_string())?.to_hex();
        let relays = self.own_relays.resolve(&settings.get(), &pubkey).await;
        if self.generation.load(Ordering::SeqCst) != generation
            || identity.public_key().map_err(|e| e.to_string())?.to_hex() != pubkey
        {
            return Err("The active identity changed during card sync".into());
        }
        let filter = json!({"kinds":[30078],"authors":[pubkey],"#d":["ncc-browser/payment-cards/v1"],"limit":20});
        let signer_identity = identity.clone();
        let signer: ncc_proxy::relay::Signer = Arc::new(move |template: Value| {
            signer_identity
                .sign_event(&template)
                .map_err(|e| e.to_string())
        });
        let mut latest: Option<Event> = None;
        for relay in &relays {
            if let Ok(events) =
                ncc_proxy::relay::query_authed(relay, &filter, Duration::from_secs(3), &signer)
                    .await
            {
                for event in events.into_iter().filter(|e| {
                    e.kind.as_u16() == 30078
                        && e.pubkey.to_hex() == pubkey
                        && e.content.len() <= 1_000_000
                        && e.tags.iter().any(|t| {
                            t.as_slice().get(0).map(String::as_str) == Some("d")
                                && t.as_slice().get(1).map(String::as_str)
                                    == Some("ncc-browser/payment-cards/v1")
                        })
                        && e.verify().is_ok()
                }) {
                    if latest
                        .as_ref()
                        .is_none_or(|old| event.created_at > old.created_at)
                    {
                        latest = Some(event)
                    }
                }
            }
        }
        if self.generation.load(Ordering::SeqCst) != generation
            || identity.public_key().map_err(|e| e.to_string())?.to_hex() != pubkey
        {
            return Err("The active identity changed during card sync".into());
        }
        let (local, mut tombstones) = self
            .cards
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .filter(|(key, _, _)| key == &pubkey)
            .map(|(_, cards, deleted)| (cards.clone(), deleted.clone()))
            .ok_or("Unlock payment cards first")?;
        let mut merged = local.clone();
        let mut remote_created = 0;
        let mut remote_snapshot: Option<(Vec<Card>, Vec<Tombstone>)> = None;
        if let Some(event) = latest.as_ref() {
            remote_created = event.created_at.as_secs();
            if let Ok(clear) = identity.nip44_decrypt(&pubkey, &event.content) {
                if let Ok(remote) = serde_json::from_str::<Vault>(&clear).map(migrate_vault) {
                    remote_snapshot = Some((remote.cards.clone(), remote.tombstones.clone()));
                    for tombstone in remote.tombstones {
                        if !tombstones.iter().any(|item| item.id == tombstone.id) {
                            tombstones.push(tombstone);
                        }
                    }
                    for card in remote.cards {
                        if tombstones.iter().any(|item| item.id == card.id) {
                            continue;
                        }
                        match merged.iter_mut().find(|old| old.id == card.id) {
                            Some(old) if card.updated_at > old.updated_at => *old = card,
                            Some(_) => {}
                            None => merged.push(card),
                        }
                    }
                }
            }
        }
        merged.retain(|card| !tombstones.iter().any(|item| item.id == card.id));
        let plaintext = serde_json::to_string(&Vault {
            v: 1,
            updated_at: now_ms(),
            cards: merged.clone(),
            tombstones: tombstones.clone(),
        })
        .map_err(|e| e.to_string())?;
        if self.generation.load(Ordering::SeqCst) != generation
            || identity.public_key().map_err(|e| e.to_string())?.to_hex() != pubkey
        {
            return Err("The active identity changed during card sync".into());
        }
        let publish = match remote_snapshot {
            Some((remote_cards, remote_tombstones)) => {
                merged != remote_cards || tombstones != remote_tombstones
            }
            None => latest.is_none() && (!merged.is_empty() || !tombstones.is_empty()),
        };
        {
            let mut state = self.cards.lock().unwrap_or_else(|e| e.into_inner());
            if self.generation.load(Ordering::SeqCst) != generation {
                return Err("The active identity changed during card sync".into());
            }
            *state = Some((pubkey.clone(), merged.clone(), tombstones));
        }
        self.write_cache(&pubkey, &plaintext, &identity)?;
        if publish && !relays.is_empty() {
            let content = identity
                .nip44_encrypt(&pubkey, &plaintext)
                .map_err(|e| e.to_string())?;
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let template = json!({"kind":30078,"created_at":now.max(remote_created.saturating_add(1)),"tags":[["d","ncc-browser/payment-cards/v1"],["t","ncc-browser/payment-cards"],["client","ncc-browser"]],"content":content});
            let event = identity.sign_event(&template).map_err(|e| e.to_string())?;
            let mut accepted = 0;
            for relay in &relays {
                if ncc_proxy::relay::publish(relay, &event, &signer, Duration::from_secs(4))
                    .await
                    .is_ok()
                {
                    accepted += 1
                }
            }
            if accepted == 0 {
                log::warn!(
                    "payment-card event is encrypted in the local cache; no relay accepted it yet"
                );
            }
        }
        Ok(())
    }

    fn write_cache(
        &self,
        pubkey: &str,
        plaintext: &str,
        identity: &IdentityStore,
    ) -> Result<(), String> {
        let cache = Cache {
            pubkey: pubkey.to_string(),
            content: identity
                .nip44_encrypt(pubkey, plaintext)
                .map_err(|e| e.to_string())?,
        };
        let bytes = serde_json::to_vec(&cache).map_err(|e| e.to_string())?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?
        }
        let tmp = self.path.with_extension("tmp");
        fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        fs::rename(tmp, &self.path).map_err(|e| e.to_string())?;
        Ok(())
    }
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn migrate_vault(mut vault: Vault) -> Vault {
    let legacy = vault
        .cards
        .iter()
        .filter(|card| card.deleted)
        .map(|card| Tombstone {
            id: card.id.clone(),
            deleted_at: card.updated_at,
        })
        .collect::<Vec<_>>();
    for item in legacy {
        if !vault
            .tombstones
            .iter()
            .any(|existing| existing.id == item.id)
        {
            vault.tombstones.push(item);
        }
    }
    let deleted_ids = vault
        .tombstones
        .iter()
        .map(|item| item.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    vault
        .cards
        .retain(|card| !card.deleted && !deleted_ids.contains(card.id.as_str()));
    vault
}
fn luhn(s: &str) -> bool {
    let d = s
        .chars()
        .filter(|c| c.is_ascii_digit())
        .map(|c| c.to_digit(10).unwrap_or(0))
        .collect::<Vec<_>>();
    if !(12..=19).contains(&d.len()) {
        return false;
    }
    d.iter()
        .rev()
        .enumerate()
        .map(|(i, n)| {
            if i % 2 == 1 {
                let x = n * 2;
                if x > 9 {
                    x - 9
                } else {
                    x
                }
            } else {
                *n
            }
        })
        .sum::<u32>()
        % 10
        == 0
}

#[cfg(test)]
mod tests {
    use super::{consume_system_auth, record_system_auth};

    #[test]
    fn native_auth_grant_is_one_use_and_fail_closed() {
        record_system_auth(false);
        assert!(!consume_system_auth());
        record_system_auth(true);
        assert!(consume_system_auth());
        assert!(!consume_system_auth());
        record_system_auth(false);
        assert!(!consume_system_auth());
    }
}
fn network(n: &str) -> &'static str {
    if n.starts_with('4') {
        "Visa"
    } else if n.starts_with("34") || n.starts_with("37") {
        "American Express"
    } else if n.starts_with("51")
        || n.starts_with("52")
        || n.starts_with("53")
        || n.starts_with("54")
        || n.starts_with("55")
    {
        "Mastercard"
    } else if n.starts_with("6011") || n.starts_with("65") {
        "Discover"
    } else {
        "Card"
    }
}
