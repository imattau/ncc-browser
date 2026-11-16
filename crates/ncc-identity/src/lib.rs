//! The user's Nostr identity, at rest and in memory.
//!
//! One file holds a single secret key, sealed by a [`KeyEnvelope`]. Two envelopes
//! exist: a passphrase (Argon2id + XChaCha20-Poly1305) and, on Android, a key held by
//! the system keystore that the app never sees. The store itself only knows how to
//! ask for "sealed" and "opened", so the signing path is identical either way.
//!
//! This crate owns no policy: what a signature is *for*, who may ask, and for how long
//! an unlock lasts belong to the caller.

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

#[cfg(any(target_os = "android", feature = "android-bridge"))]
pub mod device;

const VERSION_SEALED: u32 = 2;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const KEY_LEN: usize = 32;
/// Binds the passphrase ciphertext to this format, so a sealed blob cannot be
/// replayed as something else.
const AAD: &[u8] = b"ncc-identity-v1";

#[derive(Debug)]
pub enum IdentityError {
    NotInitialised,
    AlreadyInitialised,
    Locked,
    WrongPassphrase,
    PassphraseRequired,
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
            Self::PassphraseRequired => f.write_str(
                "This identity is stored with a passphrase; enter it once to move it to the device",
            ),
            Self::InvalidSecret(detail) => write!(f, "Not a valid secret key: {detail}"),
            Self::Io(detail) => write!(f, "Identity file: {detail}"),
            Self::Crypto(detail) => write!(f, "Identity crypto: {detail}"),
            Self::Codec(detail) => write!(f, "Identity data: {detail}"),
        }
    }
}

impl std::error::Error for IdentityError {}

/// How a secret is sealed for storage.
pub trait KeyEnvelope: Send + Sync {
    /// Short label for the UI, e.g. `device` or `passphrase`.
    fn kind(&self) -> &'static str;

    fn seal(&self, plaintext: &str) -> Result<String, IdentityError>;

    fn open(&self, sealed: &str) -> Result<String, IdentityError>;

    /// Only a passphrase envelope can open a file written before the keystore
    /// existed; everything else returns `None`.
    fn passphrase(&self) -> Option<&str> {
        None
    }
}

/// Argon2id + XChaCha20-Poly1305, the original format.
pub struct PassphraseEnvelope {
    passphrase: String,
}

impl PassphraseEnvelope {
    pub fn new(passphrase: impl Into<String>) -> Self {
        Self {
            passphrase: passphrase.into(),
        }
    }
}

impl KeyEnvelope for PassphraseEnvelope {
    fn kind(&self) -> &'static str {
        "passphrase"
    }

    fn seal(&self, plaintext: &str) -> Result<String, IdentityError> {
        let mut salt = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut salt);
        let mut nonce = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce);

        let key = derive(&self.passphrase, &salt)?;
        let cipher = XChaCha20Poly1305::new_from_slice(&key)
            .map_err(|error| IdentityError::Crypto(error.to_string()))?;
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: plaintext.as_bytes(),
                    aad: AAD,
                },
            )
            .map_err(|error| IdentityError::Crypto(error.to_string()))?;

        // salt and nonce travel with the ciphertext so the envelope is self-contained.
        Ok(format!(
            "{}.{}.{}",
            b64().encode(salt),
            b64().encode(nonce),
            b64().encode(ciphertext)
        ))
    }

    fn open(&self, sealed: &str) -> Result<String, IdentityError> {
        let mut parts = sealed.split('.');
        let (Some(salt), Some(nonce), Some(ciphertext)) =
            (parts.next(), parts.next(), parts.next())
        else {
            return Err(IdentityError::Codec(
                "sealed identity is not in the expected shape".into(),
            ));
        };

        let salt = b64()
            .decode(salt)
            .map_err(|error| IdentityError::Codec(error.to_string()))?;
        let nonce = b64()
            .decode(nonce)
            .map_err(|error| IdentityError::Codec(error.to_string()))?;
        let ciphertext = b64()
            .decode(ciphertext)
            .map_err(|error| IdentityError::Codec(error.to_string()))?;

        let key = derive(&self.passphrase, &salt)?;
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

        String::from_utf8(plaintext).map_err(|error| IdentityError::Codec(error.to_string()))
    }

    fn passphrase(&self) -> Option<&str> {
        Some(&self.passphrase)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SealedFile {
    version: u32,
    /// Hex public key, in the clear on purpose: it identifies the locked identity.
    pubkey: String,
    kind: String,
    sealed: String,
}

/// The original file, before the envelope seam existed.
#[derive(Debug, Deserialize)]
struct LegacyFile {
    #[allow(dead_code)]
    version: u32,
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
    /// How the secret is sealed, or `legacy` for a file from before the keystore.
    pub envelope: Option<String>,
}

pub struct IdentityStore {
    /// `None` for a session key: it exists in memory only, which is what a private tab
    /// signs with. Nothing is written, so there is nothing to leave behind.
    path: Option<PathBuf>,
    keys: Mutex<Option<Keys>>,
}

impl IdentityStore {
    pub fn open(path: impl Into<PathBuf>) -> Self {
        Self {
            path: Some(path.into()),
            keys: Mutex::new(None),
        }
    }

    /// A key that lives only as long as this object does, unlocked from the start.
    pub fn ephemeral() -> Self {
        Self {
            path: None,
            keys: Mutex::new(Some(Keys::generate())),
        }
    }

    /// `None` for a session key.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn status(&self) -> Status {
        if self.path.is_none() {
            let keys = self.keys.lock().expect("identity lock");
            return Status {
                initialised: keys.is_some(),
                npub: keys.as_ref().and_then(|keys| npub_of(keys).ok()),
                unlocked: keys.is_some(),
                envelope: Some("ephemeral".to_string()),
            };
        }

        let file = self.read().ok();
        let unlocked = self.keys.lock().expect("identity lock").is_some();

        let (pubkey, envelope) = match &file {
            Some(File::Sealed(sealed)) => (Some(sealed.pubkey.clone()), Some(sealed.kind.clone())),
            Some(File::Legacy(legacy)) => (Some(legacy.pubkey.clone()), Some("legacy".to_string())),
            None => (None, None),
        };

        Status {
            initialised: file.is_some(),
            npub: pubkey.and_then(|value| {
                PublicKey::from_hex(&value)
                    .ok()
                    .and_then(|key| key.to_bech32().ok())
            }),
            unlocked,
            envelope,
        }
    }

    /// Generate a new key, seal it with `envelope`, and leave the store unlocked.
    pub fn create(&self, envelope: &dyn KeyEnvelope) -> Result<String, IdentityError> {
        if self.is_initialised() {
            return Err(IdentityError::AlreadyInitialised);
        }
        let keys = Keys::generate();
        if self.path.is_some() {
            self.write_sealed(&keys, envelope)?;
        }
        let npub = npub_of(&keys)?;
        *self.keys.lock().expect("identity lock") = Some(keys);
        Ok(npub)
    }

    /// Import an `nsec1…` or hex secret key and seal it with `envelope`.
    pub fn import(
        &self,
        envelope: &dyn KeyEnvelope,
        secret: &str,
    ) -> Result<String, IdentityError> {
        if self.is_initialised() {
            return Err(IdentityError::AlreadyInitialised);
        }
        let keys = Keys::parse(secret.trim())
            .map_err(|error| IdentityError::InvalidSecret(error.to_string()))?;
        if self.path.is_some() {
            self.write_sealed(&keys, envelope)?;
        }
        let npub = npub_of(&keys)?;
        *self.keys.lock().expect("identity lock") = Some(keys);
        Ok(npub)
    }

    /// Open the stored identity.
    ///
    /// A file from before the keystore is opened with the envelope's passphrase and
    /// then re-sealed with the current envelope, so the old format disappears the
    /// first time a user opens it.
    pub fn unlock(&self, envelope: &dyn KeyEnvelope) -> Result<String, IdentityError> {
        if self.path.is_none() {
            return self.with_keys(npub_of);
        }
        if !self.is_initialised() {
            return Err(IdentityError::NotInitialised);
        }
        let file = self.read()?;

        let (keys, migrate) = match file {
            File::Sealed(sealed) => {
                let secret = envelope.open(&sealed.sealed)?;
                (parse_secret(&secret)?, false)
            }
            File::Legacy(legacy) => {
                // The old format is only openable with the passphrase it was written
                // with; the caller supplies it once and the file is rewritten.
                let Some(passphrase) = envelope.passphrase() else {
                    return Err(IdentityError::PassphraseRequired);
                };
                let payload = format!("{}.{}.{}", legacy.salt, legacy.nonce, legacy.ciphertext);
                let secret = PassphraseEnvelope::new(passphrase).open(&payload)?;
                (parse_secret(&secret)?, true)
            }
        };

        if migrate {
            self.write_sealed(&keys, envelope)?;
        }

        let npub = npub_of(&keys)?;
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
        self.with_keys(npub_of)
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

    fn is_initialised(&self) -> bool {
        match &self.path {
            Some(path) => path.exists(),
            None => self.keys.lock().expect("identity lock").is_some(),
        }
    }

    fn read(&self) -> Result<File, IdentityError> {
        let path = self.path.as_ref().ok_or(IdentityError::NotInitialised)?;
        let bytes = fs::read(path).map_err(|error| IdentityError::Io(error.to_string()))?;

        if let Ok(sealed) = serde_json::from_slice::<SealedFile>(&bytes) {
            if sealed.version == VERSION_SEALED {
                return Ok(File::Sealed(sealed));
            }
            return Err(IdentityError::Codec(format!(
                "unsupported identity version {}",
                sealed.version
            )));
        }

        let legacy: LegacyFile = serde_json::from_slice(&bytes)
            .map_err(|error| IdentityError::Codec(error.to_string()))?;
        Ok(File::Legacy(legacy))
    }

    fn write_sealed(&self, keys: &Keys, envelope: &dyn KeyEnvelope) -> Result<(), IdentityError> {
        // A session key is never written; the caller has already checked for a path.
        let Some(path) = self.path.clone() else {
            return Ok(());
        };

        let secret = hex_encode(&keys.secret_key().secret_bytes());
        let sealed = envelope.seal(&secret)?;

        let file = SealedFile {
            version: VERSION_SEALED,
            pubkey: keys.public_key().to_hex(),
            kind: envelope.kind().to_string(),
            sealed,
        };

        let encoded = serde_json::to_vec_pretty(&file)
            .map_err(|error| IdentityError::Codec(error.to_string()))?;

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| IdentityError::Io(error.to_string()))?;
        }
        // Write beside the target and rename, so a crash cannot leave a half file.
        let temporary = path.with_extension("tmp");
        fs::write(&temporary, &encoded).map_err(|error| IdentityError::Io(error.to_string()))?;
        restrict(&temporary);
        fs::rename(&temporary, &path).map_err(|error| IdentityError::Io(error.to_string()))?;
        restrict(&path);

        Ok(())
    }
}

enum File {
    Sealed(SealedFile),
    Legacy(LegacyFile),
}

fn parse_secret(secret: &str) -> Result<Keys, IdentityError> {
    Keys::parse(secret.trim()).map_err(|error| IdentityError::InvalidSecret(error.to_string()))
}

fn npub_of(keys: &Keys) -> Result<String, IdentityError> {
    // Encoding a valid public key cannot fail; the error type is `Infallible`.
    match keys.public_key().to_bech32() {
        Ok(npub) => Ok(npub),
        Err(never) => match never {},
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
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_path: &Path) {}

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
        let envelope = PassphraseEnvelope::new("correct horse battery staple");
        let npub = dir.create(&envelope).expect("create");
        assert!(npub.starts_with("npub1"));

        let status = dir.status();
        assert_eq!(status.npub.as_deref(), Some(npub.as_str()));
        assert_eq!(status.envelope.as_deref(), Some("passphrase"));

        let raw = fs::read_to_string(dir.path().expect("path")).expect("read");
        assert!(!raw.contains("nsec"), "the file must not hold plaintext");

        let reopened = IdentityStore::open(dir.path().expect("path"));
        assert!(!reopened.status().unlocked);
        assert_eq!(
            reopened
                .unlock(&PassphraseEnvelope::new("correct horse battery staple"))
                .unwrap(),
            npub
        );

        assert!(matches!(
            reopened.unlock(&PassphraseEnvelope::new("wrong")),
            Err(IdentityError::WrongPassphrase)
        ));
        let _ = fs::remove_file(dir.path().expect("path"));
    }

    #[test]
    fn imports_an_nsec_and_signs() {
        let dir = store();
        let generated = Keys::generate();
        let nsec = generated.secret_key().to_bech32().unwrap();

        let npub = dir
            .import(&PassphraseEnvelope::new("pass phrase"), &nsec)
            .expect("import");
        assert_eq!(npub, generated.public_key().to_bech32().unwrap());

        let event = dir
            .sign_event(&serde_json::json!({
                "kind": 1,
                "created_at": 1_700_000_000,
                "tags": [["t", "ncc"]],
                "content": "hello"
            }))
            .expect("sign");

        assert_eq!(event.content, "hello");
        assert_eq!(event.pubkey, generated.public_key());
        event.verify().expect("signature must verify");

        let _ = fs::remove_file(dir.path().expect("path"));
    }

    #[test]
    fn a_legacy_file_migrates_to_the_current_envelope() {
        let dir = store();
        let keys = Keys::generate();
        let legacy = PassphraseEnvelope::new("old passphrase");
        let payload = legacy
            .seal(&hex_encode(&keys.secret_key().secret_bytes()))
            .unwrap();
        let (salt, nonce, ciphertext) = {
            let mut parts = payload.split('.');
            (
                parts.next().unwrap().to_string(),
                parts.next().unwrap().to_string(),
                parts.next().unwrap().to_string(),
            )
        };

        let file = serde_json::json!({
            "version": 1,
            "pubkey": keys.public_key().to_hex(),
            "salt": salt,
            "nonce": nonce,
            "ciphertext": ciphertext,
        });
        fs::write(
            dir.path().expect("path"),
            serde_json::to_vec(&file).unwrap(),
        )
        .unwrap();

        assert_eq!(dir.status().envelope.as_deref(), Some("legacy"));

        // An envelope without a passphrase cannot open it...
        struct NoPassphrase;
        impl KeyEnvelope for NoPassphrase {
            fn kind(&self) -> &'static str {
                "device"
            }
            fn seal(&self, plaintext: &str) -> Result<String, IdentityError> {
                Ok(plaintext.to_string())
            }
            fn open(&self, sealed: &str) -> Result<String, IdentityError> {
                Ok(sealed.to_string())
            }
        }

        assert!(matches!(
            IdentityStore::open(dir.path().expect("path")).unlock(&NoPassphrase),
            Err(IdentityError::PassphraseRequired)
        ));

        // ...but with one it opens and is rewritten in the current format.
        let reopened = IdentityStore::open(dir.path().expect("path"));
        let unlocked = reopened
            .unlock(&PassphraseEnvelope::new("old passphrase"))
            .expect("migrate");
        assert_eq!(unlocked, keys.public_key().to_bech32().unwrap());

        let migrated = IdentityStore::open(dir.path().expect("path"));
        assert_eq!(migrated.status().envelope.as_deref(), Some("passphrase"));
        assert!(!fs::read_to_string(dir.path().expect("path"))
            .unwrap()
            .contains("\"salt\""));

        let _ = fs::remove_file(dir.path().expect("path"));
    }

    #[test]
    fn a_tampered_file_is_rejected() {
        let dir = store();
        let envelope = PassphraseEnvelope::new("pass");
        dir.create(&envelope).unwrap();
        dir.lock();

        let mut sealed: SealedFile =
            serde_json::from_slice(&fs::read(dir.path().expect("path")).unwrap()).unwrap();
        let mut parts: Vec<String> = sealed.sealed.split('.').map(str::to_string).collect();
        let mut bytes = b64().decode(&parts[2]).unwrap();
        bytes[0] ^= 0x01;
        parts[2] = b64().encode(bytes);
        sealed.sealed = parts.join(".");
        fs::write(
            dir.path().expect("path"),
            serde_json::to_vec(&sealed).unwrap(),
        )
        .unwrap();

        assert!(matches!(
            dir.unlock(&PassphraseEnvelope::new("pass")),
            Err(IdentityError::WrongPassphrase)
        ));
        let _ = fs::remove_file(dir.path().expect("path"));
    }
}
