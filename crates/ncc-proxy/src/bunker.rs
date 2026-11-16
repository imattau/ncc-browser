//! NIP-46: signing through a remote signer, a "bunker".
//!
//! The point of the protocol is that the user's key is not on this device. The client
//! generates a disposable key of its own, uses it to encrypt and sign the RPC channel,
//! and the bunker answers with events signed by the key it holds. Two keys, two jobs:
//!
//! ```text
//! client-keypair  →  encrypts and signs the channel (kind 24133)
//! remote-signer   →  holds the user-keypair, signs what the page asked for
//! ```
//!
//! `remote-signer-pubkey` and `user-pubkey` are not the same key in general, which is
//! why `get_public_key` is asked after `connect` rather than assumed.
//!
//! The transport is on demand: each request opens a subscription, publishes, and waits
//! for the matching answer. A long-lived pool would save a round trip, and would also
//! have to survive doze, reconnects and stale sockets; for something a person triggers
//! and a bunker approves by hand, that trade is the wrong way round.

use std::sync::Mutex;
use std::time::Duration;

use futures_util::stream::FuturesUnordered;
use futures_util::{SinkExt, StreamExt};
use nostr::nips::nip44::{self, Version};
use nostr::{Event, EventBuilder, JsonUtil, Keys, Kind, PublicKey, Tag, ToBech32};
use serde_json::{json, Value};
use tokio::time::{timeout_at, Instant};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

/// Kind for NIP-46 requests and responses, both directions.
const RPC_KIND: u16 = 24133;

/// What a `bunker://` link asks this browser to talk to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BunkerTarget {
    /// The signer's own key. Not the user's key.
    pub remote_pubkey: String,
    pub relays: Vec<String>,
    /// Single-use secret, if the link carries one.
    pub secret: Option<String>,
}

/// Read a `bunker://<remote-signer-pubkey>?relay=…&secret=…` link.
///
/// Only the signer-initiated flow is supported: `nostrconnect://` needs a QR code and
/// a listener the other side starts with, which is a different screen.
pub fn parse_bunker(input: &str) -> Result<BunkerTarget, String> {
    let value = input.trim();
    if value.is_empty() {
        return Err("Paste a bunker:// link from your signer".into());
    }

    let parsed =
        url::Url::parse(value).map_err(|_| "That is not a valid bunker:// link".to_string())?;
    if parsed.scheme() != "bunker" {
        return Err("That is not a valid bunker:// link".into());
    }

    let remote_pubkey = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if remote_pubkey.len() != 64 || !remote_pubkey.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("The link is missing the signer's pubkey".into());
    }

    let mut relays: Vec<String> = Vec::new();
    for raw in parsed.query_pairs().filter(|(name, _)| name == "relay") {
        let relay = raw.1.trim();
        if relay.is_empty() {
            continue;
        }
        let normalized = normalize_relay(relay)
            .ok_or_else(|| format!("NIP-46 relays must be ws:// or wss://: {relay}"))?;
        if !relays.contains(&normalized) {
            relays.push(normalized);
        }
    }

    if relays.is_empty() {
        return Err("The link does not list a relay".into());
    }

    let secret = parsed
        .query_pairs()
        .find(|(name, _)| name == "secret")
        .map(|(_, value)| value.into_owned())
        .filter(|value| !value.is_empty());

    Ok(BunkerTarget {
        remote_pubkey,
        relays,
        secret,
    })
}

fn normalize_relay(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    if url.scheme() != "ws" && url.scheme() != "wss" {
        return None;
    }
    Some(url.to_string().trim_end_matches('/').to_string())
}

/// One NIP-46 connection, for the life of one session.
pub struct Bunker {
    target: Mutex<BunkerTarget>,
    client: Keys,
    /// Learned from `get_public_key`; used to reject an answer signed by the wrong key.
    user: Mutex<Option<String>>,
    timeout: Duration,
}

impl Bunker {
    pub fn new(target: BunkerTarget, client: Keys) -> Self {
        Self {
            target: Mutex::new(target),
            client,
            user: Mutex::new(None),
            timeout: Duration::from_secs(120),
        }
    }

    /// A session with a key of its own, which is the normal way to start one.
    pub fn generate(target: BunkerTarget) -> Self {
        Self::new(target, Keys::generate())
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn client_pubkey(&self) -> String {
        self.client.public_key().to_hex()
    }

    pub fn target(&self) -> BunkerTarget {
        crate::lock(&self.target).clone()
    }

    pub fn relays(&self) -> Vec<String> {
        crate::lock(&self.target).relays.clone()
    }

    /// Ask the signer to accept this client, then learn the key it signs with.
    ///
    /// The answer to `connect` is `ack`, or the secret this client was given — a
    /// signer that returns anything else has refused.
    pub async fn connect(&self) -> Result<String, String> {
        let target = self.target();
        let mut params = vec![target.remote_pubkey.clone()];
        if let Some(secret) = &target.secret {
            params.push(secret.clone());
        }

        let answer = self.request("connect", params).await?;
        let acknowledged = answer == "ack" || target.secret.as_deref() == Some(answer.as_str());
        if !acknowledged {
            return Err(format!(
                "The signer answered the connection with “{answer}”"
            ));
        }

        // The signer decides which relays carry this session, and is entitled to move
        // it. Asking now means later requests already go where it wants them.
        self.follow_switch().await;

        let user = self.request("get_public_key", vec![]).await?;
        PublicKey::parse(user.trim())
            .map_err(|_| "The signer returned a public key that is not a key".to_string())?;
        *crate::lock(&self.user) = Some(user.clone());
        Ok(user)
    }

    /// The key this session signs with, once `connect` has found it.
    pub fn user_pubkey(&self) -> Option<String> {
        crate::lock(&self.user).clone()
    }

    /// The connected identity as an npub, for display.
    pub fn user_npub(&self) -> Option<String> {
        let user = self.user_pubkey()?;
        PublicKey::parse(&user)
            .ok()
            .and_then(|key| key.to_bech32().ok())
    }

    /// The user's key, connecting first if this session has not yet.
    pub async fn ensure_user(&self) -> Result<String, String> {
        match self.user_pubkey() {
            Some(user) => Ok(user),
            None => self.connect().await,
        }
    }

    pub async fn sign_event(&self, template: &Value) -> Result<Event, String> {
        let answer = self
            .request("sign_event", vec![template.to_string()])
            .await?;

        let event = Event::from_json(answer.trim()).map_err(|error| {
            format!("The signer returned something that is not an event: {error}")
        })?;
        if event.verify().is_err() {
            return Err("The signer returned an event with a bad signature".into());
        }

        // A signer that hands back an event from a different key is either confused or
        // is not the signer this page was approved for.
        if let Some(user) = self.user_pubkey() {
            if event.pubkey.to_hex() != user {
                return Err(
                    "The signer signed with a key that is not the connected identity".into(),
                );
            }
        }

        Ok(event)
    }

    pub async fn nip04_encrypt(&self, peer: &str, plaintext: &str) -> Result<String, String> {
        self.request(
            "nip04_encrypt",
            vec![peer.to_string(), plaintext.to_string()],
        )
        .await
    }

    pub async fn nip04_decrypt(&self, peer: &str, ciphertext: &str) -> Result<String, String> {
        self.request(
            "nip04_decrypt",
            vec![peer.to_string(), ciphertext.to_string()],
        )
        .await
    }

    pub async fn nip44_encrypt(&self, peer: &str, plaintext: &str) -> Result<String, String> {
        self.request(
            "nip44_encrypt",
            vec![peer.to_string(), plaintext.to_string()],
        )
        .await
    }

    pub async fn nip44_decrypt(&self, peer: &str, ciphertext: &str) -> Result<String, String> {
        self.request(
            "nip44_decrypt",
            vec![peer.to_string(), ciphertext.to_string()],
        )
        .await
    }

    /// Tell the signer this client is done, as a courtesy. The session is forgotten
    /// locally either way, which is the part that actually matters.
    pub async fn logout(&self) -> Result<(), String> {
        let _ = self.request("logout", vec![]).await;
        *crate::lock(&self.user) = None;
        Ok(())
    }

    /// Adopt the relay list the signer offers, if it offers one.
    async fn follow_switch(&self) {
        let Ok(answer) = self.request("switch_relays", vec![]).await else {
            return;
        };

        let Ok(relays) = serde_json::from_str::<Vec<String>>(answer.trim()) else {
            return;
        };
        let relays: Vec<String> = relays
            .iter()
            .filter_map(|relay| normalize_relay(relay))
            .collect();
        if relays.is_empty() {
            return;
        }

        crate::lock(&self.target).relays = relays;
    }

    async fn request(&self, method: &str, params: Vec<String>) -> Result<String, String> {
        let id = new_id();
        let payload = request_payload(&id, method, params);

        let target = self.target();
        let remote = PublicKey::parse(&target.remote_pubkey)
            .map_err(|error| format!("The signer's pubkey is not valid: {error}"))?;

        let content = nip44::encrypt(
            self.client.secret_key(),
            &remote,
            payload.to_string(),
            Version::V2,
        )
        .map_err(|error| format!("Could not encrypt the request: {error}"))?;

        let event = EventBuilder::new(Kind::Custom(RPC_KIND), content)
            .tag(Tag::public_key(remote))
            .sign_with_keys(&self.client)
            .map_err(|error| format!("Could not sign the request: {error}"))?;

        let filter = json!({
            "kinds": [RPC_KIND],
            "authors": [target.remote_pubkey],
            "#p": [self.client.public_key().to_hex()],
            "since": crate::resolve::unix_now() - 60,
        });

        let deadline = Instant::now() + self.timeout;
        let mut attempts = FuturesUnordered::new();
        for relay in target.relays {
            attempts.push(self.exchange(
                relay,
                event.clone(),
                filter.clone(),
                id.clone(),
                deadline,
            ));
        }

        let mut last = None;
        while let Some(result) = attempts.next().await {
            match result {
                Ok(answer) => return Ok(answer),
                Err(error) => last = Some(error),
            }
        }

        Err(last.unwrap_or_else(|| "No relay was configured for the signer".into()))
    }

    /// Publish on one relay and wait for the answer that matches this request.
    async fn exchange(
        &self,
        relay: String,
        request: Event,
        filter: Value,
        id: String,
        deadline: Instant,
    ) -> Result<String, String> {
        let (socket, _) = timeout_at(deadline, connect_async(&relay))
            .await
            .map_err(|_| format!("{relay}: connect timed out"))?
            .map_err(|error| format!("{relay}: {error}"))?;
        let (mut sink, mut stream) = socket.split();

        let subscription = format!("ncc46-{id}");
        let subscribe = json!(["REQ", subscription, filter]).to_string();
        sink.send(Message::Text(subscribe.into()))
            .await
            .map_err(|error| format!("{relay}: {error}"))?;
        let publish = json!(["EVENT", request]).to_string();
        sink.send(Message::Text(publish.into()))
            .await
            .map_err(|error| format!("{relay}: {error}"))?;

        loop {
            let next = timeout_at(deadline, stream.next())
                .await
                .map_err(|_| format!("{relay}: the signer did not answer in time"))?;
            let Some(Ok(message)) = next else {
                return Err(format!("{relay}: closed before answering"));
            };
            let Message::Text(text) = message else {
                continue;
            };
            let Ok(message) = serde_json::from_str::<Value>(&text) else {
                continue;
            };

            match message.get(0).and_then(Value::as_str) {
                Some("EVENT") => {}
                Some("CLOSED") | Some("NOTICE") => {
                    let detail = message.get(2).and_then(Value::as_str).unwrap_or_default();
                    return Err(format!("{relay}: {detail}"));
                }
                _ => continue,
            }

            let Some(raw) = message.get(2) else {
                continue;
            };
            let Ok(event) = serde_json::from_value::<Event>(raw.clone()) else {
                continue;
            };
            if event.verify().is_err() || event.pubkey.to_hex() != self.target().remote_pubkey {
                continue;
            }

            let Ok(plain) = nip44::decrypt(self.client.secret_key(), &event.pubkey, &event.content)
            else {
                continue;
            };
            let Ok(answer) = serde_json::from_str::<Value>(&plain) else {
                continue;
            };
            if answer.get("id").and_then(Value::as_str) != Some(id.as_str()) {
                continue;
            }

            let close = json!(["CLOSE", subscription]).to_string();
            let _ = sink.send(Message::Text(close.into())).await;
            let _ = sink.close().await;

            return answer_for(&answer);
        }
    }
}

/// The JSON-RPC-shaped request the bunker expects, with every parameter a string.
fn request_payload(id: &str, method: &str, params: Vec<String>) -> Value {
    json!({ "id": id, "method": method, "params": params })
}

/// Read one answer: its result, or the reason it failed.
fn answer_for(answer: &Value) -> Result<String, String> {
    if let Some(error) = answer.get("error").and_then(Value::as_str) {
        // The spec's auth challenge: the signer needs the user to log in somewhere
        // else, and the URL is in the error field.
        if answer.get("result").and_then(Value::as_str) == Some("auth_url") {
            return Err(format!(
                "The signer needs you to authorise this connection: {error}"
            ));
        }
        return Err(format!("The signer refused: {error}"));
    }

    match answer.get("result") {
        Some(Value::String(result)) => Ok(result.clone()),
        Some(other) => Ok(other.to_string()),
        None => Err("The signer answered without a result".into()),
    }
}

fn new_id() -> String {
    format!("{:032x}", rand::random::<u128>())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIGNER: &str = "fa984bd7dbb282f07e16e7ae87b26a2a7b9b90b7246a44771f0cf5ae58018f52";

    #[test]
    fn reads_a_bunker_link() {
        let target = parse_bunker(&format!(
            "bunker://{SIGNER}?relay=wss%3A%2F%2Frelay.example&secret=s3cret"
        ))
        .expect("parsed");

        assert_eq!(target.remote_pubkey, SIGNER);
        assert_eq!(target.relays, vec!["wss://relay.example"]);
        assert_eq!(target.secret.as_deref(), Some("s3cret"));
    }

    #[test]
    fn reads_several_relays_without_duplicates() {
        let target = parse_bunker(&format!(
            "bunker://{SIGNER}?relay=wss%3A%2F%2Fa.example&relay=wss%3A%2F%2Fa.example%2F&relay=ws%3A%2F%2Fb.example"
        ))
        .expect("parsed");

        // A trailing slash is the same relay, and the order the link uses is kept.
        assert_eq!(target.relays, vec!["wss://a.example", "ws://b.example"]);
        assert_eq!(target.secret, None);
    }

    #[test]
    fn refuses_links_it_cannot_use() {
        assert!(parse_bunker("").is_err());
        assert!(parse_bunker("https://relay.example").is_err());
        // No pubkey.
        assert!(parse_bunker("bunker://?relay=wss%3A%2F%2Fa.example").is_err());
        // A short or non-hex key is not a pubkey.
        assert!(parse_bunker("bunker://abc?relay=wss%3A%2F%2Fa.example").is_err());
        // No relay to talk over.
        assert!(parse_bunker(&format!("bunker://{SIGNER}")).is_err());
        // HTTP is not a relay transport.
        assert!(parse_bunker(&format!("bunker://{SIGNER}?relay=https%3A%2F%2Fa.example")).is_err());
    }

    #[test]
    fn a_request_carries_strings_only() {
        let payload = request_payload("id-1", "sign_event", vec!["{\"kind\":1}".into()]);
        assert_eq!(payload["id"], "id-1");
        assert_eq!(payload["method"], "sign_event");
        assert_eq!(payload["params"][0], "{\"kind\":1}");
    }

    #[test]
    fn answers_are_read_or_explained() {
        assert_eq!(
            answer_for(&json!({ "id": "x", "result": "ack" })).unwrap(),
            "ack"
        );
        // A JSON result stays JSON.
        assert_eq!(
            answer_for(&json!({ "id": "x", "result": { "a": 1 } })).unwrap(),
            "{\"a\":1}"
        );
        assert!(answer_for(&json!({ "id": "x", "error": "no" }))
            .unwrap_err()
            .contains("refused"));

        let challenge = answer_for(&json!({
            "id": "x",
            "result": "auth_url",
            "error": "https://signer.example/auth?challenge=1"
        }))
        .unwrap_err();
        assert!(challenge.contains("authorise"));
        assert!(challenge.contains("https://signer.example/auth"));
    }

    /// Stands in for the keystore: the point of the test is the file, not the seal.
    struct Plain;

    impl ncc_identity::KeyEnvelope for Plain {
        fn kind(&self) -> &'static str {
            "plain"
        }
        fn seal(&self, plaintext: &str) -> Result<String, ncc_identity::IdentityError> {
            Ok(plaintext.to_string())
        }
        fn open(&self, sealed: &str) -> Result<String, ncc_identity::IdentityError> {
            Ok(sealed.to_string())
        }
    }

    #[test]
    fn a_session_survives_and_keeps_its_client_key() {
        let path = std::env::temp_dir().join(format!(
            "ncc-bunker-{}-{}.json",
            std::process::id(),
            rand::random::<u16>()
        ));
        let sessions = Sessions::open(&path);

        let target = parse_bunker(&format!(
            "bunker://{SIGNER}?relay=wss%3A%2F%2Fa.example&secret=s3cret"
        ))
        .unwrap();
        let client = Keys::generate();
        sessions.save(&target, &client, &Plain).expect("saved");

        let (stored_target, stored_client) = sessions.load(&Plain).expect("loaded");
        assert_eq!(stored_target, target);
        assert_eq!(
            stored_client.public_key().to_hex(),
            client.public_key().to_hex()
        );

        // Forgetting is what a disconnect does, and it has to stick.
        sessions.forget();
        assert!(sessions.load(&Plain).is_none());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_new_bunker_starts_out_unknown() {
        let target =
            parse_bunker(&format!("bunker://{SIGNER}?relay=wss%3A%2F%2Fa.example")).unwrap();
        let bunker = Bunker::new(target, Keys::generate());

        assert_eq!(bunker.user_pubkey(), None);
        assert_eq!(bunker.relays(), vec!["wss://a.example"]);
        assert_eq!(bunker.client_pubkey().len(), 64);
    }
}

/// The connection that outlives the app.
///
/// The remote pubkey and relays are public. The client's own key is not: it is what
/// proves the next launch is the same client, so it is sealed with the same envelope
/// as the identity rather than written out.
#[derive(serde::Serialize, serde::Deserialize)]
struct SessionFile {
    version: u32,
    remote_pubkey: String,
    relays: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secret: Option<String>,
    sealed_client_secret: String,
    created_at: i64,
}

pub struct Sessions {
    path: std::path::PathBuf,
}

impl Sessions {
    pub fn open(path: impl Into<std::path::PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// Store the live session, client key included.
    pub fn save_for(
        &self,
        bunker: &Bunker,
        envelope: &dyn ncc_identity::KeyEnvelope,
    ) -> Result<(), String> {
        self.save(&bunker.target(), &bunker.client, envelope)
    }

    pub fn save(
        &self,
        target: &BunkerTarget,
        client: &Keys,
        envelope: &dyn ncc_identity::KeyEnvelope,
    ) -> Result<(), String> {
        let sealed = envelope
            .seal(&client.secret_key().to_secret_hex())
            .map_err(|error| error.to_string())?;

        let file = SessionFile {
            version: 1,
            remote_pubkey: target.remote_pubkey.clone(),
            relays: target.relays.clone(),
            secret: target.secret.clone(),
            sealed_client_secret: sealed,
            created_at: crate::resolve::unix_now(),
        };

        let encoded = serde_json::to_vec_pretty(&file).map_err(|error| error.to_string())?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }

        // Beside the target, then rename: a crash cannot leave a half session.
        let temporary = self.path.with_extension("tmp");
        std::fs::write(&temporary, encoded).map_err(|error| error.to_string())?;
        std::fs::rename(&temporary, &self.path).map_err(|error| error.to_string())
    }

    /// The stored session, or `None` when there is none or it cannot be opened.
    pub fn load(&self, envelope: &dyn ncc_identity::KeyEnvelope) -> Option<(BunkerTarget, Keys)> {
        let bytes = std::fs::read(&self.path).ok()?;
        let file: SessionFile = serde_json::from_slice(&bytes).ok()?;
        if file.version != 1 || file.relays.is_empty() {
            return None;
        }

        let secret = envelope.open(&file.sealed_client_secret).ok()?;
        let client = Keys::parse(secret.trim()).ok()?;

        Some((
            BunkerTarget {
                remote_pubkey: file.remote_pubkey,
                relays: file.relays,
                secret: file.secret,
            },
            client,
        ))
    }

    pub fn forget(&self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
