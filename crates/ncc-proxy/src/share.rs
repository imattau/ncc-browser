//! Share a page to Nostr: a kind 1 note with the page address and an optional comment.
//!
//! Unlike the vault and sync, this is public. It goes to the configured relays plus the
//! write relays from the person's NIP-65 list, never to a dedicated vault relay, and only
//! when the person taps Post in the shell.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::json;

use ncc_identity::IdentityStore;

use crate::own_relays::OwnRelays;
use crate::relay::{self, Signer};
use crate::settings::SettingsStore;

const RELAY_WAIT: Duration = Duration::from_secs(8);
const MAX_COMMENT: usize = 2000;
const MAX_TITLE: usize = 200;
const MAX_URL: usize = 2048;
const NO_IDENTITY: &str = "Sign in to share to Nostr";

#[derive(Debug, Serialize)]
pub struct ShareOutcome {
    pub accepted: usize,
    pub relays: usize,
    pub id: String,
    pub error: Option<String>,
}

/// Query parameters that only identify who clicked, not what the page is.
fn is_tracking(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.starts_with("utm_")
        || matches!(
            name.as_str(),
            "fbclid" | "gclid" | "dclid" | "msclkid" | "mc_eid" | "igshid" | "yclid" | "_ga"
        )
}

/// The address to post: web addresses lose tracking parameters; NCC and Nsite addresses go as-is.
pub fn clean_url(input: &str) -> Result<String, String> {
    let value = input.trim();
    if value.is_empty() || value.len() > MAX_URL {
        return Err("This page has no shareable address".to_string());
    }
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("ncc://") || lower.starts_with("nsite://") {
        return Ok(value.to_string());
    }
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("Only web, ncc:// and nsite:// pages can be shared".to_string());
    }
    let mut url = url::Url::parse(value).map_err(|_| "This page has no shareable address".to_string())?;
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(name, _)| !is_tracking(name))
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect();
    if kept.is_empty() {
        url.set_query(None);
    } else {
        url.query_pairs_mut().clear().extend_pairs(kept);
    }
    Ok(url.to_string())
}

fn truncate(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

/// The note text: your comment then the address, or the title then the address.
pub fn note_content(url: &str, title: &str, comment: &str) -> String {
    let comment = truncate(comment, MAX_COMMENT);
    if !comment.is_empty() {
        return format!("{comment}\n\n{url}");
    }
    let title = truncate(&title.split_whitespace().collect::<Vec<_>>().join(" "), MAX_TITLE);
    if title.is_empty() {
        url.to_string()
    } else {
        format!("{title}\n{url}")
    }
}

pub struct ShareService {
    identity: Arc<IdentityStore>,
    settings: Arc<SettingsStore>,
    own_relays: OwnRelays,
}

impl ShareService {
    pub fn new(identity: Arc<IdentityStore>, settings: Arc<SettingsStore>) -> Self {
        Self {
            identity,
            settings,
            own_relays: OwnRelays::default(),
        }
    }

    pub async fn post(
        &self,
        tab_kind: &str,
        url: &str,
        title: &str,
        comment: &str,
    ) -> Result<ShareOutcome, String> {
        if tab_kind != "normal" {
            return Err("Only normal tabs can be shared to Nostr".to_string());
        }
        let url = clean_url(url)?;
        let pubkey = self
            .identity
            .public_key()
            .map_err(|_| NO_IDENTITY.to_string())?
            .to_hex();
        let relays = self
            .own_relays
            .resolve_public(&self.settings.get(), &pubkey)
            .await;
        if relays.is_empty() {
            return Err("No relay is configured to post to".to_string());
        }

        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or_default();
        let template = json!({
            "kind": 1,
            "created_at": created_at,
            "tags": [["r", url]],
            "content": note_content(&url, title, comment),
        });
        let event = self
            .identity
            .sign_event(&template)
            .map_err(|error| format!("The note could not be signed: {error}"))?;

        let identity = self.identity.clone();
        let signer: Signer = Arc::new(move |template| {
            identity.sign_event(&template).map_err(|e| e.to_string())
        });
        let (accepted, first_error) =
            relay::publish_all(&relays, &event, &signer, RELAY_WAIT).await;
        Ok(ShareOutcome {
            accepted,
            relays: relays.len(),
            id: event.id.to_hex(),
            error: if accepted == 0 { first_error } else { None },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracking_parameters_go_and_the_rest_stay() {
        assert_eq!(
            clean_url("https://example.com/a?id=7&utm_source=x&fbclid=y").unwrap(),
            "https://example.com/a?id=7"
        );
        assert_eq!(
            clean_url("https://example.com/a?utm_medium=x").unwrap(),
            "https://example.com/a"
        );
    }

    #[test]
    fn ncc_addresses_are_posted_as_they_are() {
        let ncc = "ncc://npub1abc/web?utm_source=keep";
        assert_eq!(clean_url(ncc).unwrap(), ncc);
    }

    #[test]
    fn other_schemes_are_refused() {
        assert!(clean_url("javascript:alert(1)").is_err());
        assert!(clean_url("file:///etc/passwd").is_err());
        assert!(clean_url("  ").is_err());
    }

    #[test]
    fn comment_comes_first_then_the_address() {
        assert_eq!(note_content("https://a.b/", "T", " hi "), "hi\n\nhttps://a.b/");
        assert_eq!(note_content("https://a.b/", " My  page ", ""), "My page\nhttps://a.b/");
        assert_eq!(note_content("https://a.b/", "", ""), "https://a.b/");
    }

    #[test]
    fn a_long_comment_is_cut() {
        let long = "x".repeat(5000);
        assert_eq!(note_content("u", "", &long).len(), MAX_COMMENT + 3);
    }
}
