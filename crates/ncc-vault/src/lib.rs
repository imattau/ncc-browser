//! The password vault format, shared by every shell.
//!
//! A vault is one NIP-78 event (kind 30078, `d = ncc-browser/passwords/v1`) whose
//! content is NIP-44 encrypted to the reader's own identity. This crate is the part
//! that has to agree with the desktop build byte for byte: validation, the merge
//! rule, origin canonicalisation, the generator and TOTP. Anything that needs a key,
//! a socket or a UI lives in the shell.
//!
//! Compatibility is the whole point, so two rules are stricter than they look:
//!
//! * Memory of the desktop's `canUsePasswordOrigin`: only `https://` and `ncc://`
//!   entries exist. `nsite://` parses, but the desktop drops such entries during
//!   normalisation, so accepting one here would make it vanish on the other machine.
//! * Ids are sixteen hex characters (`randomBytes(8).toString('hex')`), not UUIDs.

pub mod cache;
pub mod generator;
pub mod sync;
pub mod totp;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;

pub use cache::{CachedVault, PasswordCache};
pub use generator::{generate_password, GeneratorOptions};
pub use totp::{TotpCode, TotpSecret};

pub const VAULT_KIND: u64 = 30078;
pub const VAULT_VERSION: u32 = 1;
pub const VAULT_D: &str = "ncc-browser/passwords/v1";
pub const VAULT_TAG: &str = "ncc-browser/passwords";
pub const VAULT_CLIENT: &str = "ncc-browser";

/// Keep the plaintext under the usual 64 KB relay event limit once base64 and NIP-44
/// framing are added.
pub const MAX_VAULT_BYTES: usize = 40_000;

pub const MAX_TITLE: usize = 200;
pub const MAX_USERNAME: usize = 320;
pub const MAX_PASSWORD: usize = 4096;
pub const MAX_NOTES: usize = 4096;
pub const MAX_TOTP: usize = 2048;
pub const MAX_ORIGIN: usize = 2048;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordEntry {
    pub id: String,
    /// The canonical origin, as `password_origin` produces it.
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
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
    /// A tombstone. Kept in the event so a delete survives a merge from a copy that
    /// still has the entry.
    #[serde(default, skip_serializing_if = "is_false")]
    pub deleted: bool,
    /// Optional WebAuthn software-authenticator record. Its private JWK is inside the
    /// encrypted vault payload and must be preserved by every platform implementation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passkey: Option<Value>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PasswordVault {
    pub v: u32,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: u64,
    #[serde(default)]
    pub entries: Vec<PasswordEntry>,
}

impl Default for PasswordVault {
    fn default() -> Self {
        Self {
            v: VAULT_VERSION,
            updated_at: 0,
            entries: Vec::new(),
        }
    }
}

impl PasswordVault {
    pub fn active(&self) -> impl Iterator<Item = &PasswordEntry> {
        self.entries.iter().filter(|entry| !entry.deleted)
    }

    pub fn active_entries(&self) -> Vec<PasswordEntry> {
        self.active().cloned().collect()
    }
}

/// Metadata that is safe to list without revealing a password.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordSummary {
    pub id: String,
    pub origin: String,
    pub title: String,
    pub username: String,
    pub has_totp: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub is_passkey: bool,
    pub created_at: u64,
    pub updated_at: u64,
}

/// The canonical, allowed origin for an address, or `None`.
///
/// Accepts `https://…` and `ncc://…` only, exactly as the desktop's
/// `canUsePasswordOrigin` does. Plain http is refused because a login typed over it
/// can be read in flight; `nsite://` is refused for compatibility, since the desktop
/// would discard the entry on its next read.
pub fn password_origin(raw: &str) -> Option<String> {
    let value = raw.trim();
    if value.is_empty() || value.len() > MAX_ORIGIN {
        return None;
    }

    if value.to_ascii_lowercase().starts_with("ncc:") {
        let address = ncc_core::parse_ncc_address(value).ok()?;
        return Some(format!("ncc://{}/{}", address.pubkey, address.service));
    }

    let url = Url::parse(value).ok()?;
    if url.scheme() != "https" {
        return None;
    }
    let origin = url.origin().ascii_serialization();
    // `ascii_serialization` is `null` for opaque origins, which cannot happen with a
    // https URL that parsed, but the guard keeps the type honest.
    if origin == "null" {
        return None;
    }
    Some(origin)
}

/// Normalise a decrypted or imported vault, dropping anything the desktop would drop.
pub fn normalize_vault(input: &Value) -> PasswordVault {
    let entries = input
        .get("entries")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(normalize_entry)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    PasswordVault {
        v: VAULT_VERSION,
        updated_at: input
            .get("updatedAt")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        entries,
    }
}

pub fn normalize_entry(input: &Value) -> Option<PasswordEntry> {
    let id = input.get("id")?.as_str()?.to_ascii_lowercase();
    if !is_entry_id(&id) {
        return None;
    }

    let origin = password_origin(input.get("origin")?.as_str()?)?;
    let created_at = input
        .get("createdAt")
        .and_then(Value::as_u64)
        .unwrap_or_else(now_seconds);
    let updated_at = input
        .get("updatedAt")
        .and_then(Value::as_u64)
        .unwrap_or(created_at);

    Some(PasswordEntry {
        id,
        origin: origin.clone(),
        title: clamp_text(input.get("title"), MAX_TITLE, &origin),
        username: clamp_text(input.get("username"), MAX_USERNAME, ""),
        // A password is not trimmed: leading or trailing spaces are part of it, and
        // the desktop validator slices rather than trims for the same reason.
        password: slice_text(input.get("password"), MAX_PASSWORD),
        notes: clamp_text(input.get("notes"), MAX_NOTES, ""),
        totp: clamp_text(input.get("totp"), MAX_TOTP, ""),
        created_at,
        updated_at,
        deleted: input
            .get("deleted")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        passkey: input.get("passkey").and_then(normalize_passkey),
    })
}

fn normalize_passkey(value: &Value) -> Option<Value> {
    let string = |key: &str, max: usize| {
        value.get(key).and_then(Value::as_str)
            .filter(|item| !item.is_empty() && item.len() <= max)
    };
    let credential_id = string("credentialId", 1024)?;
    if credential_id.len() < 20 || !credential_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') { return None; }
    let rp_id = string("rpId", 253)?.to_ascii_lowercase();
    if !rp_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') { return None; }
    let user_handle = value.get("userHandle").and_then(Value::as_str).filter(|item| item.len() <= 1024)?;
    let jwk = |key: &str, private: bool| -> Option<Value> {
        let item = value.get(key)?.as_object()?;
        if item.get("kty")?.as_str()? != "EC" || item.get("crv")?.as_str()? != "P-256" { return None; }
        for coordinate in ["x", "y"] {
            let bytes = item.get(coordinate)?.as_str()?;
            if bytes.len() != 43 || !bytes.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') { return None; }
        }
        if private {
            let scalar = item.get("d")?.as_str()?;
            if scalar.len() != 43 || !scalar.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') { return None; }
        }
        Some(Value::Object(item.clone()))
    };
    Some(json!({
        "credentialId": credential_id,
        "rpId": rp_id,
        "userHandle": user_handle,
        "userName": string("userName", MAX_USERNAME).unwrap_or(""),
        "userDisplayName": string("userDisplayName", MAX_TITLE).unwrap_or(""),
        "privateKeyJwk": jwk("privateKeyJwk", true)?,
        "publicKeyJwk": jwk("publicKeyJwk", false)?,
        "signCount": value.get("signCount").and_then(Value::as_u64).unwrap_or(0),
        "discoverable": value.get("discoverable").and_then(Value::as_bool).unwrap_or(false)
    }))
}

/// Sixteen to sixty-four hex characters, matching the desktop's validator.
pub fn is_entry_id(value: &str) -> bool {
    (16..=64).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn clamp_text(value: Option<&Value>, max: usize, fallback: &str) -> String {
    match value.and_then(Value::as_str) {
        Some(text) => text.trim().chars().take(max).collect(),
        None => fallback.to_string(),
    }
}

fn slice_text(value: Option<&Value>, max: usize) -> String {
    value
        .and_then(Value::as_str)
        .map(|text| text.chars().take(max).collect())
        .unwrap_or_default()
}

fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

/// Merge two copies by entry id, newest write wins, tombstones included.
pub fn merge_vaults(local: &PasswordVault, remote: &PasswordVault) -> (PasswordVault, bool) {
    let mut by_id: std::collections::BTreeMap<String, PasswordEntry> =
        std::collections::BTreeMap::new();
    let mut changed = false;

    for entry in &local.entries {
        by_id.insert(entry.id.clone(), entry.clone());
    }
    for entry in &remote.entries {
        match by_id.get(&entry.id) {
            None => {
                by_id.insert(entry.id.clone(), entry.clone());
                changed = true;
            }
            Some(existing) if entry.updated_at > existing.updated_at => {
                by_id.insert(entry.id.clone(), entry.clone());
                changed = true;
            }
            _ => {}
        }
    }

    let mut entries: Vec<PasswordEntry> = by_id.into_values().collect();
    entries.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });

    let updated_at = entries
        .iter()
        .map(|entry| entry.updated_at)
        .max()
        .unwrap_or_default();

    (
        PasswordVault {
            v: VAULT_VERSION,
            updated_at,
            entries,
        },
        changed,
    )
}

pub fn find_entry<'a>(vault: &'a PasswordVault, id: &str) -> Option<&'a PasswordEntry> {
    vault.entries.iter().find(|entry| entry.id == id)
}

/// Active entries at an origin, newest first.
pub fn entries_for_origin(vault: &PasswordVault, origin: &str) -> Vec<PasswordEntry> {
    let mut matches: Vec<PasswordEntry> = vault
        .active()
        .filter(|entry| entry.origin == origin)
        .cloned()
        .collect();
    matches.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.title.cmp(&b.title))
    });
    matches
}

pub fn find_entry_for(
    vault: &PasswordVault,
    origin: &str,
    username: &str,
) -> Option<PasswordEntry> {
    let wanted = username.trim().to_ascii_lowercase();
    vault
        .active()
        .find(|entry| entry.origin == origin && entry.username.to_lowercase() == wanted)
        .cloned()
}

pub fn summarize(entry: &PasswordEntry) -> PasswordSummary {
    PasswordSummary {
        id: entry.id.clone(),
        origin: entry.origin.clone(),
        title: entry.title.clone(),
        username: entry.username.clone(),
        has_totp: !entry.totp.is_empty(),
        is_passkey: entry.passkey.is_some(),
        created_at: entry.created_at,
        updated_at: entry.updated_at,
    }
}

pub fn summarize_vault(vault: &PasswordVault) -> Vec<PasswordSummary> {
    let mut entries: Vec<PasswordSummary> = vault.active().map(summarize).collect();
    entries.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
    });
    entries
}

pub fn vault_byte_length(vault: &PasswordVault) -> usize {
    serde_json::to_vec(vault)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX)
}

pub fn is_vault_within_limit(vault: &PasswordVault) -> bool {
    vault_byte_length(vault) <= MAX_VAULT_BYTES
}

/// The filter that finds the vault event for an identity.
pub fn vault_filter(pubkey: &str) -> Value {
    json!({
        "kinds": [VAULT_KIND],
        "authors": [pubkey],
        "#d": [VAULT_D],
        "limit": 10,
    })
}

pub fn apply_entry(vault: &PasswordVault, entry: PasswordEntry) -> PasswordVault {
    let mut entries: Vec<PasswordEntry> = vault
        .entries
        .iter()
        .filter(|existing| existing.id != entry.id)
        .cloned()
        .collect();
    entries.push(entry);

    let updated_at = entries
        .iter()
        .map(|existing| existing.updated_at)
        .max()
        .unwrap_or_default();

    PasswordVault {
        v: VAULT_VERSION,
        updated_at,
        entries,
    }
}

/// Parse a draft's origin the way the desktop does: a bare host is https.
pub fn draft_origin(raw: &str) -> Option<String> {
    let value = raw.trim();
    let with_scheme = if value.contains("://") {
        value.to_string()
    } else {
        format!("https://{value}")
    };
    password_origin(&with_scheme)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NPUB: &str = "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhs2n3v";

    fn entry(id: &str, origin: &str, updated_at: u64) -> PasswordEntry {
        PasswordEntry {
            id: id.to_string(),
            origin: origin.to_string(),
            title: "Example".into(),
            username: "alice".into(),
            password: "hunter2".into(),
            notes: String::new(),
            totp: String::new(),
            created_at: 1,
            updated_at,
            deleted: false,
            passkey: None,
        }
    }

    #[test]
    fn origins_are_https_or_ncc_only() {
        assert_eq!(
            password_origin("https://example.com/login?x=1").as_deref(),
            Some("https://example.com")
        );
        assert_eq!(
            password_origin("https://example.com:8443/").as_deref(),
            Some("https://example.com:8443")
        );
        assert_eq!(
            password_origin(&format!("ncc://{NPUB}/web")).as_deref(),
            Some(format!("ncc://{NPUB}/web").as_str())
        );
        assert_eq!(
            password_origin(&format!("ncc://{NPUB}")).as_deref(),
            Some(format!("ncc://{NPUB}/addr").as_str())
        );

        // The desktop drops all three, so the vault must too.
        assert_eq!(password_origin("http://example.com"), None);
        assert_eq!(password_origin("nsite://npub1abc"), None);
        assert_eq!(password_origin("ftp://example.com"), None);
    }

    #[test]
    fn drafts_accept_a_bare_host() {
        assert_eq!(
            draft_origin("example.com").as_deref(),
            Some("https://example.com")
        );
        assert_eq!(draft_origin("http://example.com"), None);
    }

    #[test]
    fn ids_are_hex_and_not_uuids() {
        assert!(is_entry_id("0123456789abcdef"));
        assert!(!is_entry_id("01234567-89ab-cdef"));
        assert!(!is_entry_id("abc"));
        assert!(password_origin("https://example.com").is_some());
    }

    #[test]
    fn normalization_clamps_and_drops_what_the_desktop_drops() {
        let input = json!({
            "v": 1,
            "updatedAt": 5,
            "entries": [
                {
                    "id": "0123456789ABCDEF",
                    "origin": "https://example.com/path",
                    "title": "  Example  ",
                    "username": "alice",
                    "password": "hunter2",
                    "totp": "otpauth://totp/x?secret=AAAA",
                    "createdAt": 2,
                    "updatedAt": 3
                },
                {"id": "not-hex", "origin": "https://example.com"},
                {"id": "0123456789abcdee", "origin": "http://insecure.example"},
                {"id": "0123456789abcdff", "origin": "nsite://npub1abc"}
            ]
        });

        let vault = normalize_vault(&input);
        assert_eq!(vault.entries.len(), 1);
        let entry = &vault.entries[0];
        assert_eq!(entry.id, "0123456789abcdef");
        assert_eq!(entry.origin, "https://example.com");
        assert_eq!(entry.title, "Example");
    }

    #[test]
    fn normalization_preserves_desktop_passkey_records_and_marks_summaries() {
        let input = json!({
            "entries": [{
                "id": "0123456789abcdef",
                "origin": "https://webauthn.io",
                "username": "ncc-passkey-smoke-test",
                "passkey": {
                    "credentialId": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                    "rpId": "webauthn.io",
                    "userHandle": "AQID",
                    "userName": "ncc-passkey-smoke-test",
                    "userDisplayName": "NCC smoke test",
                    "privateKeyJwk": { "kty": "EC", "crv": "P-256", "x": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "y": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "d": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
                    "publicKeyJwk": { "kty": "EC", "crv": "P-256", "x": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "y": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
                    "signCount": 0,
                    "discoverable": true
                }
            }]
        });
        let vault = normalize_vault(&input);
        let entry = &vault.entries[0];
        assert_eq!(entry.passkey.as_ref().unwrap()["rpId"], "webauthn.io");
        assert!(summarize(entry).is_passkey);
        let round_trip = serde_json::to_value(entry).unwrap();
        assert_eq!(round_trip["passkey"]["privateKeyJwk"]["d"], "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    }

    #[test]
    fn a_password_keeps_its_spaces() {
        let input = json!({
            "entries": [{
                "id": "0123456789abcdef",
                "origin": "https://example.com",
                "password": "  spaced  "
            }]
        });
        assert_eq!(normalize_vault(&input).entries[0].password, "  spaced  ");
    }

    #[test]
    fn merge_is_newest_wins_and_keeps_tombstones() {
        let a = PasswordVault {
            v: 1,
            updated_at: 3,
            entries: vec![
                entry("0123456789abcdef", "https://a.example", 3),
                entry("fedcba9876543210", "https://b.example", 1),
            ],
        };
        let b = PasswordVault {
            v: 1,
            updated_at: 4,
            entries: vec![
                {
                    let mut changed = entry("0123456789abcdef", "https://a.example", 4);
                    changed.password = "newer".into();
                    changed
                },
                {
                    let mut gone = entry("fedcba9876543210", "https://b.example", 5);
                    gone.deleted = true;
                    gone
                },
            ],
        };

        let (merged, changed) = merge_vaults(&a, &b);
        assert!(changed);
        assert_eq!(
            find_entry(&merged, "0123456789abcdef").unwrap().password,
            "newer"
        );
        assert!(find_entry(&merged, "fedcba9876543210").unwrap().deleted);
        assert_eq!(merged.updated_at, 5);
        assert_eq!(entries_for_origin(&merged, "https://b.example").len(), 0);
    }

    #[test]
    fn an_older_remote_copy_does_not_win() {
        let local = PasswordVault {
            v: 1,
            updated_at: 2,
            entries: vec![entry("0123456789abcdef", "https://a.example", 2)],
        };
        let remote = PasswordVault {
            v: 1,
            updated_at: 1,
            entries: vec![entry("0123456789abcdef", "https://a.example", 1)],
        };
        let (merged, changed) = merge_vaults(&local, &remote);
        assert!(!changed);
        assert_eq!(merged.entries[0].updated_at, 2);
    }

    #[test]
    fn findings_are_scoped_to_the_origin() {
        let vault = PasswordVault {
            v: 1,
            updated_at: 2,
            entries: vec![
                entry("0123456789abcdef", "https://a.example", 2),
                entry("fedcba9876543210", "https://b.example", 2),
            ],
        };
        assert_eq!(entries_for_origin(&vault, "https://a.example").len(), 1);
        assert_eq!(entries_for_origin(&vault, "https://c.example").len(), 0);
    }

    #[test]
    fn the_filter_names_the_vault_and_nothing_else() {
        let filter = vault_filter("abc");
        assert_eq!(filter["kinds"], json!([30078]));
        assert_eq!(filter["#d"], json!([VAULT_D]));
    }

    #[test]
    fn the_limit_is_measured_on_the_plaintext() {
        let mut vault = PasswordVault::default();
        while is_vault_within_limit(&vault) {
            let id = format!("{:016x}", vault.entries.len() as u64);
            vault.entries.push(PasswordEntry {
                title: "x".repeat(MAX_TITLE),
                notes: "y".repeat(MAX_NOTES),
                ..entry(&id, "https://example.com", 1)
            });
            if vault.entries.len() > 200 {
                break;
            }
        }
        assert!(!is_vault_within_limit(&vault));
    }
}
