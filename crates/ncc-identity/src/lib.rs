//! The user's Nostr identity, at rest and in memory.
//!
//! One file holds a single secret key, sealed with a key derived from a passphrase.
//! Argon2id derives it (so a stolen file is expensive to attack) and
//! XChaCha20-Poly1305 seals it (so tampering is detected). Nothing else is stored in
//! the clear except the public key, which is needed to show *which* identity is
//! locked before anyone types a passphrase.
//!
//! This crate owns no policy: what a signature is *for*, who may ask, and for how
//! long an unlock lasts belong to the caller. That keeps the signing path testable
//! without a browser.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use nostr::{Event, JsonUtil, Keys, PublicKey, ToBech32, UnsignedEvent};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};

const FILE_VERSION: u32 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const KEY_LEN: usize = 32;
/// Binds the ciphertext to this format, so a sealed blob cannot be replayed as
/// something else.
const AAD: &[u8] = b"ncc-identity-v1";

#[derive(Debug)]
pub enum IdentityError {
    NotInitialised,
    AlreadyInitialised,
    Locked,
    WrongPassphrase,
    InvalidSecret(String),
    Io(String),
    Crypto(String),
    Codec(String),
}

impl std::fmt::Display for IdentityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotInitialised => f.write_str("No identity has been set up yet"),
            Self::AlreadyInitialised => f.write_str("An identity is already stored"),
            Self::Locked => f.write_str("The identity is locked"),
            Self::WrongPassphrase => f.write_str("That passphrase does not open the identity"),
            Self::InvalidSecret(detail) => write!(f, "Not a valid secret key: {detail}"),
            Self::Io(detail) => write!(f, "Identity file: {detail}"),
            Self::Crypto(detail) => write!(f, "Identity crypto: {detail}"),
            Self::Codec(detail) => write!(f, "Identity data: {detail}"),
        }
    }
}

impl std::error::Error for IdentityError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Sealed {
    version: u32,
    /// Hex public key, in the clear on purpose: it identifies the locked identity.
    pubkey: String,
    salt: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    pub initialised: bool,
    /// The npub of the stored identity, available even while locked.
    pub npub: Option<String>,
    pub unlocked: bool,
}

pub struct IdentityStore {
    path: PathBuf,
    keys: Mutex<Option<Keys>>,
}

impl IdentityStore {
    pub fn open(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            keys: Mutex::new(None),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn status(&self) -> Status {
        let sealed = self.read().ok();
        let unlocked = self.keys.lock().expect("identity lock").is_some();
        Status {
            initialised: sealed.is_some(),
            npub: sealed.and_then(|sealed| {
                PublicKey::from_hex(&sealed.pubkey)
                    .ok()
                    .and_then(|key| key.to_bech32().ok())
            }),
            unlocked,
        }
    }

    /// Generate a new key, seal it, and leave the store unlocked.
    pub fn create(&self, passphrase: &str) -> Result<String, IdentityError> {
        if self.path.exists() {
            return Err(IdentityError::AlreadyInitialised);
        }
        let keys = Keys::generate();
        self.write_sealed(&keys, passphrase)?;
        let npub = keys
            .public_key()
            .to_bech32()
            .map_err(|error| IdentityError::Codec(error.to_string()))?;
        *self.keys.lock().expect("identity lock") = Some(keys);
        Ok(npub)
    }

    /// Import an `nsec1…` or hex secret key, seal it, and leave the store unlocked.
    pub fn import(&self, passphrase: &str, secret: &str) -> Result<String, IdentityError> {
        if self.path.exists() {
            return Err(IdentityError::AlreadyInitialised);
        }
        let keys = Keys::parse(secret.trim())
            .map_err(|error| IdentityError::InvalidSecret(error.to_string()))?;
        self.write_sealed(&keys, passphrase)?;
        let npub = keys
            .public_key()
            .to_bech32()
            .map_err(|error| IdentityError::Codec(error.to_string()))?;
        *self.keys.lock().expect("identity lock") = Some(keys);
        Ok(npub)
    }

    pub fn unlock(&self, passphrase: &str) -> Result<String, IdentityError> {
        if !self.path.exists() {
            return Err(IdentityError::NotInitialised);
        }
        let sealed = self.read()?;
        let keys = self.open_sealed(&sealed, passphrase)?;
        let npub = keys
            .public_key()
            .to_bech32()
            .map_err(|error| IdentityError::Codec(error.to_string()))?;
        *self.keys.lock().expect("identity lock") = Some(keys);
        Ok(npub)
    }

    pub fn lock(&self) {
        *self.keys.lock().expect("identity lock") = None;
    }

    pub fn is_unlocked(&self) -> bool {
        self.keys.lock().expect("identity lock").is_some()
    }

    pub fn public_key(&self) -> Result<PublicKey, IdentityError> {
        self.with_keys(|keys| Ok(keys.public_key()))
    }

    pub fn npub(&self) -> Result<String, IdentityError> {
        self.public_key()?
            .to_bech32()
            .map_err(|error| IdentityError::Codec(error.to_string()))
    }

    /// Sign an event template supplied by a page, exactly as NIP-07 defines it.
    pub fn sign_event(&self, template: &serde_json::Value) -> Result<Event, IdentityError> {
        self.with_keys(|keys| {
            let mut value = template.clone();
            let object = value
                .as_object_mut()
                .ok_or_else(|| IdentityError::Codec("event template must be an object".into()))?;
            // The page never gets to choose the author.
            object.insert(
                "pubkey".to_string(),
                serde_json::Value::String(keys.public_key().to_hex()),
            );
            object.remove("id");
            object.remove("sig");

            let unsigned = UnsignedEvent::from_json(value.to_string())
                .map_err(|error| IdentityError::Codec(error.to_string()))?;
            unsigned
                .sign_with_keys(keys)
                .map_err(|error| IdentityError::Crypto(error.to_string()))
        })
    }

    pub fn nip04_encrypt(&self, peer: &str, plaintext: &str) -> Result<String, IdentityError> {
        self.with_keys(|keys| {
            let peer = public_key_of(peer)?;
            nostr::nips::nip04::encrypt(keys.secret_key(), &peer, plaintext)
                .map_err(|error| IdentityError::Crypto(error.to_string()))
        })
    }

    pub fn nip04_decrypt(&self, peer: &str, ciphertext: &str) -> Result<String, IdentityError> {
        self.with_keys(|keys| {
            let peer = public_key_of(peer)?;
            nostr::nips::nip04::decrypt(keys.secret_key(), &peer, ciphertext)
                .map_err(|error| IdentityError::Crypto(error.to_string()))
        })
    }

    pub fn nip44_encrypt(&self, peer: &str, plaintext: &str) -> Result<String, IdentityError> {
        self.with_keys(|keys| {
            let peer = public_key_of(peer)?;
            nostr::nips::nip44::encrypt(
                keys.secret_key(),
                &peer,
                plaintext,
                nostr::nips::nip44::Version::V2,
            )
            .map_err(|error| IdentityError::Crypto(error.to_string()))
        })
    }

    pub fn nip44_decrypt(&self, peer: &str, ciphertext: &str) -> Result<String, IdentityError> {
        self.with_keys(|keys| {
            let peer = public_key_of(peer)?;
            nostr::nips::nip44::decrypt(keys.secret_key(), &peer, ciphertext)
                .map_err(|error| IdentityError::Crypto(error.to_string()))
        })
    }

    fn with_keys<T>(
        &self,
        action: impl FnOnce(&Keys) -> Result<T, IdentityError>,
    ) -> Result<T, IdentityError> {
        let guard = self.keys.lock().expect("identity lock");
        let keys = guard.as_ref().ok_or(IdentityError::Locked)?;
        action(keys)
    }

    fn read(&self) -> Result<Sealed, IdentityError> {
        let bytes = fs::read(&self.path).map_err(|error| IdentityError::Io(error.to_string()))?;
        let sealed: Sealed = serde_json::from_slice(&bytes)
            .map_err(|error| IdentityError::Codec(error.to_string()))?;
        if sealed.version != FILE_VERSION {
            return Err(IdentityError::Codec(format!(
                "unsupported identity version {}",
                sealed.version
            )));
        }
        Ok(sealed)
    }

    fn write_sealed(&self, keys: &Keys, passphrase: &str) -> Result<(), IdentityError> {
        let mut salt = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut salt);
        let mut nonce = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce);

        let key = derive(passphrase, &salt)?;
        let cipher = XChaCha20Poly1305::new_from_slice(&key)
            .map_err(|error| IdentityError::Crypto(error.to_string()))?;

        let secret = hex_encode(&keys.secret_key().secret_bytes());
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: secret.as_bytes(),
                    aad: AAD,
                },
            )
            .map_err(|error| IdentityError::Crypto(error.to_string()))?;

        let sealed = Sealed {
            version: FILE_VERSION,
            pubkey: keys.public_key().to_hex(),
            salt: b64().encode(salt),
            nonce: b64().encode(nonce),
            ciphertext: b64().encode(ciphertext),
        };

        let encoded = serde_json::to_vec_pretty(&sealed)
            .map_err(|error| IdentityError::Codec(error.to_string()))?;

        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| IdentityError::Io(error.to_string()))?;
        }
        // Write beside the target and rename, so a crash cannot leave a half file.
        let temporary = self.path.with_extension("tmp");
        fs::write(&temporary, &encoded).map_err(|error| IdentityError::Io(error.to_string()))?;
        restict_permissions(&temporary);
        fs::rename(&temporary, &self.path).map_err(|error| IdentityError::Io(error.to_string()))?;
        restict_permissions(&self.path);

        Ok(())
    }

    fn open_sealed(&self, sealed: &Sealed, passphrase: &str) -> Result<Keys, IdentityError> {
        let salt = b64()
            .decode(&sealed.salt)
            .map_err(|error| IdentityError::Codec(error.to_string()))?;
        let nonce = b64()
            .decode(&sealed.nonce)
            .map_err(|error| IdentityError::Codec(error.to_string()))?;
        let ciphertext = b64()
            .decode(&sealed.ciphertext)
            .map_err(|error| IdentityError::Codec(error.to_string()))?;

        let key = derive(passphrase, &salt)?;
        let cipher = XChaCha20Poly1305::new_from_slice(&key)
            .map_err(|error| IdentityError::Crypto(error.to_string()))?;

        let plaintext = cipher
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: AAD,
                },
            )
            // A wrong passphrase and a tampered file are indistinguishable here, and
            // both must fail the same way.
            .map_err(|_| IdentityError::WrongPassphrase)?;

        let secret = std::str::from_utf8(&plaintext)
            .map_err(|error| IdentityError::Codec(error.to_string()))?;
        let keys = Keys::parse(secret.trim())
            .map_err(|error| IdentityError::InvalidSecret(error.to_string()))?;

        // The stored public key must match the one inside, or the file was built
        // from two different identities.
        if keys.public_key().to_hex() != sealed.pubkey {
            return Err(IdentityError::Codec(
                "stored public key does not match".into(),
            ));
        }

        Ok(keys)
    }
}

fn derive(passphrase: &str, salt: &[u8]) -> Result<[u8; KEY_LEN], IdentityError> {
    let params = Params::new(19_456, 2, 1, Some(KEY_LEN))
        .map_err(|error| IdentityError::Crypto(error.to_string()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut key = [0u8; KEY_LEN];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|error| IdentityError::Crypto(error.to_string()))?;
    Ok(key)
}

fn public_key_of(input: &str) -> Result<PublicKey, IdentityError> {
    PublicKey::parse(input.trim()).map_err(|error| IdentityError::InvalidSecret(error.to_string()))
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(unix)]
fn restict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restict_permissions(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn store() -> IdentityStore {
        let id = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ncc-identity-test-{}-{id}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        IdentityStore::open(path)
    }

    #[test]
    fn creates_seals_and_reopens() {
        let dir = store();
        let npub = dir.create("correct horse battery staple").expect("create");
        assert!(npub.starts_with("npub1"));
        assert_eq!(dir.status().npub.as_deref(), Some(npub.as_str()));

        let raw = fs::read_to_string(dir.path()).expect("read");
        assert!(!raw.contains("nsec"), "the file must not hold plaintext");
        assert!(raw.contains("argon2") || raw.contains("ciphertext"));

        // A fresh store starts locked and opens with the same passphrase.
        let reopened = IdentityStore::open(dir.path());
        assert!(!reopened.status().unlocked);
        assert_eq!(
            reopened.unlock("correct horse battery staple").unwrap(),
            npub
        );
        assert!(reopened.is_unlocked());

        assert!(matches!(
            reopened.unlock("wrong"),
            Err(IdentityError::WrongPassphrase)
        ));
        let _ = fs::remove_file(dir.path());
    }

    #[test]
    fn imports_an_nsec_and_signs() {
        let dir = store();
        let secret = "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhq3z3t";
        // Any valid nsec works; generate one so the fixture cannot rot.
        let generated = Keys::generate();
        let nsec = generated.secret_key().to_bech32().unwrap();
        let _ = secret;

        let npub = dir.import("pass phrase", &nsec).expect("import");
        assert_eq!(npub, generated.public_key().to_bech32().unwrap());

        let event = dir
            .sign_event(&serde_json::json!({
                "kind": 1,
                "created_at": 1_700_000_000,
                "tags": [["t", "ncc"]],
                "content": "hello"
            }))
            .expect("sign");

        assert_eq!(event.kind.as_u16(), 1);
        assert_eq!(event.content, "hello");
        assert_eq!(event.pubkey, generated.public_key());
        event.verify().expect("signature must verify");

        let _ = fs::remove_file(dir.path());
    }

    #[test]
    fn refuses_when_locked_and_refuses_a_second_identity() {
        let dir = store();
        assert!(matches!(
            dir.sign_event(&serde_json::json!({})),
            Err(IdentityError::Locked)
        ));
        dir.create("pass").unwrap();
        assert!(matches!(
            dir.create("pass"),
            Err(IdentityError::AlreadyInitialised)
        ));
        dir.lock();
        assert!(matches!(dir.public_key(), Err(IdentityError::Locked)));
        let _ = fs::remove_file(dir.path());
    }

    #[test]
    fn nip04_and_nip44_round_trip_between_two_identities() {
        let alice = store();
        let bob = store();
        alice.create("alice pass").unwrap();
        bob.create("bob pass").unwrap();

        let alice_npub = alice.npub().unwrap();
        let bob_npub = bob.npub().unwrap();

        let encrypted = alice.nip04_encrypt(&bob_npub, "hello bob").unwrap();
        assert_eq!(
            bob.nip04_decrypt(&alice_npub, &encrypted).unwrap(),
            "hello bob"
        );

        let encrypted = alice.nip44_encrypt(&bob_npub, "hello again").unwrap();
        assert_eq!(
            bob.nip44_decrypt(&alice_npub, &encrypted).unwrap(),
            "hello again"
        );

        let _ = fs::remove_file(alice.path());
        let _ = fs::remove_file(bob.path());
    }

    #[test]
    fn a_tampered_file_is_rejected() {
        let dir = store();
        dir.create("pass").unwrap();
        dir.lock();

        let mut sealed: Sealed = serde_json::from_slice(&fs::read(dir.path()).unwrap()).unwrap();
        let mut bytes = b64().decode(&sealed.ciphertext).unwrap();
        bytes[0] ^= 0x01;
        sealed.ciphertext = b64().encode(bytes);
        fs::write(dir.path(), serde_json::to_vec(&sealed).unwrap()).unwrap();

        assert!(matches!(
            dir.unlock("pass"),
            Err(IdentityError::WrongPassphrase)
        ));
        let _ = fs::remove_file(dir.path());
    }
}
