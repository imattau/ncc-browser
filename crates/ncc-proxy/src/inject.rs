//! NIP-07 injection for the content WebView.
//!
//! Electron gets this for free: a preload runs in an isolated world at document
//! start and exposes `window.nostr` through `contextBridge`. Android has no preload
//! as this point, and this is the only way to be early enough: rewrite the document
//! on its way through the proxy so the shim is the first script in `<head>`.
//!
//! The shim does not call into the app directly. It posts to `/__ncc/nip07/<method>`
//! on its own origin, which the proxy intercepts before resolution. That keeps the
//! signer in Rust, gives the request an unambiguous origin (the `Host` header, not a
//! value the page supplies) and avoids exposing a JavascriptInterface to pages.
//!
//! The token in the shim identifies one document load. It is visible to the page —
//! that is the NIP-07 trust model, the page is the principal asking for signatures —
//! but not to another origin, and not reusable from a different service.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

/// Bodies larger than this are passed through untouched rather than buffered.
pub const MAX_INJECTION_BYTES: usize = 4 * 1024 * 1024;

static COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
pub struct Injection {
    pub token: String,
    pub nonce: String,
}

impl Injection {
    pub fn new(host_key: &str) -> Self {
        let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);

        let token = digest(&format!("token:{host_key}:{nanos}:{counter}"));
        let nonce = digest(&format!("nonce:{host_key}:{nanos}:{counter}"));

        Self { token, nonce }
    }

    /// The shim, as it will appear inside the document.
    pub fn script(&self) -> String {
        let token = &self.token;
        format!(
            r#"(function(){{
  if (window.__nccInjected) return;
  window.__nccInjected = true;
  var token = "{token}";
  function call(method, params) {{
    return fetch("/__ncc/nip07/" + method, {{
      method: "POST",
      headers: {{ "content-type": "application/json" }},
      body: JSON.stringify({{ token: token, params: params === undefined ? null : params }})
    }}).then(function (response) {{
      return response.json().catch(function () {{ return {{}}; }}).then(function (data) {{
        if (!response.ok) {{
          var error = new Error(data.message || ("NIP-07 " + method + " failed"));
          error.code = data.code;
          throw error;
        }}
        return data.result;
      }});
    }});
  }}
  var nostr = {{
    getPublicKey: function () {{ return call("get-public-key"); }},
    signEvent: function (event) {{ return call("sign-event", event); }},
    getRelays: function () {{ return call("get-relays"); }},
    nip04: {{
      encrypt: function (peer, text) {{ return call("nip04-encrypt", {{ peer: peer, text: text }}); }},
      decrypt: function (peer, text) {{ return call("nip04-decrypt", {{ peer: peer, text: text }}); }}
    }},
    nip44: {{
      encrypt: function (peer, text) {{ return call("nip44-encrypt", {{ peer: peer, text: text }}); }},
      decrypt: function (peer, text) {{ return call("nip44-decrypt", {{ peer: peer, text: text }}); }}
    }}
  }};
  try {{
    Object.defineProperty(window, "nostr", {{ value: nostr, writable: false, configurable: false }});
  }} catch (error) {{
    window.nostr = nostr;
  }}
}})();"#,
            token = token
        )
    }

    pub fn script_tag(&self) -> String {
        format!(
            "<script nonce=\"{nonce}\">{script}</script>",
            nonce = self.nonce,
            script = self.script()
        )
    }
}

/// Issued tokens, so a signer call can only come from a document this proxy served
/// for that same service.
#[derive(Debug, Default)]
pub struct TokenStore {
    tokens: Mutex<HashMap<String, String>>,
}

impl TokenStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn remember(&self, token: &str, host_key: &str) {
        let mut tokens = crate::lock(&self.tokens);
        // A document load can never outlive the process, so a simple bound is enough.
        if tokens.len() > 512 {
            tokens.clear();
        }
        tokens.insert(token.to_string(), host_key.to_string());
    }

    pub fn matches(&self, token: &str, host_key: &str) -> bool {
        if token.is_empty() {
            return false;
        }
        crate::lock(&self.tokens)
            .get(token)
            .map(|stored| stored == host_key)
            .unwrap_or(false)
    }
}

fn digest(input: &str) -> String {
    let hash = Sha256::digest(input.as_bytes());
    hash.iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Insert the shim as the first thing inside `<head>`, so it runs before any page
/// script can look for `window.nostr`.
///
/// No HTML parser is involved on purpose: the transform must be reversible by eye,
/// must not reorder attributes, and must survive malformed documents.
pub fn inject_into_html(html: &str, tag: &str) -> String {
    if let Some(index) = find_head_insertion_point(html) {
        let mut out = String::with_capacity(html.len() + tag.len());
        out.push_str(&html[..index]);
        out.push_str(tag);
        out.push_str(&html[index..]);
        return out;
    }

    if let Some(index) = find_tag_end(html, "<html") {
        let mut out = String::with_capacity(html.len() + tag.len());
        out.push_str(&html[..index]);
        out.push_str(tag);
        out.push_str(&html[index..]);
        return out;
    }

    format!("{tag}{html}")
}

/// Index just past `<head …>`, when the document has one.
fn find_head_insertion_point(html: &str) -> Option<usize> {
    find_tag_end(html, "<head")
}

fn find_tag_end(html: &str, needle: &str) -> Option<usize> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find(needle)?;
    let end = lower[start..].find('>')?;
    Some(start + end + 1)
}

/// Allow the shim (and its requests) under a page's own policy.
///
/// This loosens the page's CSP, which is a real trade-off: without it, any site with
/// `script-src 'self'` would never see `window.nostr`. The added nonce covers one
/// script; `'self'` is added to `connect-src` because the shim talks to its own
/// origin. Nothing else is relaxed.
pub fn relax_csp(csp: &str, nonce: &str) -> String {
    let mut directives: Vec<String> = Vec::new();
    let mut script_covered = false;
    let mut connect_covered = false;

    for raw in csp.split(';') {
        let directive = raw.trim();
        if directive.is_empty() {
            continue;
        }

        let name = directive
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let sources: Vec<&str> = directive.split_whitespace().collect();

        match name.as_str() {
            "script-src" | "script-src-elem" => {
                script_covered = true;
                if directive.contains(&format!("'nonce-{nonce}'")) {
                    directives.push(directive.to_string());
                } else {
                    directives.push(format!("{directive} 'nonce-{nonce}'"));
                }
            }
            "default-src" => {
                // `'none'` blocks the shim; the policy gets an explicit script-src
                // below instead of rewriting a directive the publisher chose.
                if sources
                    .iter()
                    .any(|source| source.eq_ignore_ascii_case("'none'"))
                {
                    directives.push(directive.to_string());
                } else {
                    script_covered = true;
                    directives.push(format!("{directive} 'nonce-{nonce}'"));
                }
            }
            "connect-src" => {
                connect_covered = true;
                if sources
                    .iter()
                    .any(|source| source.eq_ignore_ascii_case("'self'"))
                {
                    directives.push(directive.to_string());
                } else {
                    directives.push(format!("{directive} 'self'"));
                }
            }
            _ => directives.push(directive.to_string()),
        }
    }

    if !script_covered {
        directives.push(format!("script-src 'nonce-{nonce}'"));
    }
    if !connect_covered {
        directives.push("connect-src 'self'".to_string());
    }

    directives.join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";
    const NONCE: &str = "fedcba9876543210fedcba9876543210";

    fn tag() -> String {
        format!("<script nonce=\"{NONCE}\">{TOKEN}</script>")
    }

    #[test]
    fn inserts_before_the_first_script_in_head() {
        let html = "<!doctype html><html><head><script src=\"/app.js\"></script></head><body></body></html>";
        let out = inject_into_html(html, &tag());
        assert!(out.starts_with("<!doctype html><html><head><script nonce=\""));
        assert!(out.find(TOKEN).unwrap() < out.find("/app.js").unwrap());
    }

    #[test]
    fn handles_head_attributes_and_uppercase() {
        let lower = "<html>\n<head>\n<title>t</title>";
        let out = inject_into_html(lower, &tag());
        assert!(out.contains(&format!("<head>{}", tag())));

        let upper = "<HTML><HEAD profile=\"x\"><title>t</title></HEAD></HTML>";
        let out = inject_into_html(upper, &tag());
        let index = out.find(&tag()).expect("shim inserted");
        assert!(
            out[..index]
                .to_ascii_lowercase()
                .ends_with("<head profile=\"x\">"),
            "shim must land inside head: {}",
            &out[..index]
        );
    }

    #[test]
    fn falls_back_to_html_then_to_the_start() {
        let with_html = "<html lang=\"en\"><body>x</body></html>";
        let out = inject_into_html(with_html, &tag());
        assert!(out.starts_with("<html lang=\"en\">"));
        assert!(out.find(TOKEN).unwrap() < out.find("<body>").unwrap());

        let fragment = "<p>no structure</p>";
        assert!(inject_into_html(fragment, &tag()).starts_with("<script"));
    }

    #[test]
    fn a_duplicate_injection_is_harmless() {
        // The proxy never serves a document twice, but a cached copy could.
        let once = inject_into_html("<html><head></head></html>", &tag());
        let twice = inject_into_html(&once, &tag());
        assert_eq!(twice.matches(TOKEN).count(), 2);
        // The shim itself is guarded, so a duplicate is harmless at runtime.
        assert!(Injection::new("x")
            .script()
            .contains("window.__nccInjected"));
    }

    #[test]
    fn adds_a_nonce_and_self_without_dropping_directives() {
        let csp = "default-src 'self'; script-src 'self' https://cdn.example; img-src *; connect-src https://api.example";
        let relaxed = relax_csp(csp, NONCE);
        assert!(relaxed.contains(&format!(
            "script-src 'self' https://cdn.example 'nonce-{NONCE}'"
        )));
        assert!(relaxed.contains("connect-src https://api.example 'self'"));
        assert!(relaxed.contains("img-src *"));
    }

    #[test]
    fn adds_script_src_when_default_src_is_none() {
        let relaxed = relax_csp("default-src 'none'; img-src 'self'", NONCE);
        assert!(relaxed.contains(&format!("script-src 'nonce-{NONCE}'")));
        assert!(relaxed.contains("connect-src 'self'"));
    }

    #[test]
    fn does_not_duplicate_an_existing_nonce() {
        let csp = format!("script-src 'nonce-{NONCE}'");
        assert_eq!(relax_csp(&csp, NONCE).matches(NONCE).count(), 1);
    }

    #[test]
    fn tokens_are_unique_per_load() {
        let first = Injection::new("npub/web");
        let second = Injection::new("npub/web");
        assert_ne!(first.token, second.token);
        assert_ne!(first.nonce, second.nonce);
        assert_eq!(first.token.len(), 32);
    }
}
