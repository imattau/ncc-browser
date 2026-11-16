//! Pure transport selection for records that publish both clearnet and onion
//! endpoints. Kept free of any networking so every rule is unit-testable.

use std::collections::HashSet;

use crate::locator::{Endpoint, EndpointFamily};

/// How the browser treats cleartext (`http://`) endpoints.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpsMode {
    /// Use whatever the publisher offers, in priority order.
    Off,
    /// Warn before using cleartext, but allow it.
    Warn,
    /// Only `https://` endpoints are usable.
    Only,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportSelection {
    /// Endpoints that should be attempted for this request, in priority order.
    pub candidates: Vec<Endpoint>,
    /// The locator publishes at least one usable onion endpoint.
    pub onion_available: bool,
    /// The locator is onion-only and the caller asked for a direct connection.
    pub onion_only: bool,
}

pub fn has_onion_endpoint(endpoints: &[Endpoint]) -> bool {
    endpoints
        .iter()
        .any(|endpoint| endpoint.family == EndpointFamily::Onion)
}

/// Tor mode uses onion endpoints when they exist. Direct mode never tries an onion
/// endpoint, even if its priority would otherwise win: without Tor it can only fail.
pub fn select_transport_endpoints(endpoints: &[Endpoint], use_tor: bool) -> TransportSelection {
    let onion_available = has_onion_endpoint(endpoints);
    let onion: Vec<Endpoint> = endpoints
        .iter()
        .filter(|endpoint| endpoint.family == EndpointFamily::Onion)
        .cloned()
        .collect();
    let direct: Vec<Endpoint> = endpoints
        .iter()
        .filter(|endpoint| endpoint.family != EndpointFamily::Onion)
        .cloned()
        .collect();

    if use_tor && !onion.is_empty() {
        return TransportSelection {
            candidates: onion,
            onion_available,
            onion_only: false,
        };
    }
    TransportSelection {
        onion_only: onion_available && direct.is_empty(),
        candidates: direct,
        onion_available,
    }
}

/// Prefer endpoints the publisher actually published over HTTPS. Stable within the
/// resolver's existing priority order.
pub fn sort_candidates_for_https(endpoints: &[Endpoint], mode: HttpsMode) -> Vec<Endpoint> {
    let mut sorted = endpoints.to_vec();
    if mode == HttpsMode::Off {
        return sorted;
    }
    // Stable sort: `https` first, priority order preserved inside each group.
    sorted.sort_by_key(|endpoint| endpoint.protocol != "https");
    sorted
}

/// Per-service transport overrides for the address-bar onion toggle. Overrides live
/// for the session; changing the global preference clears them.
#[derive(Debug, Clone, Default)]
pub struct TransportPolicy {
    forced: HashSet<String>,
    prefer_tor: bool,
}

impl TransportPolicy {
    pub fn new(prefer_tor: bool) -> Self {
        Self {
            forced: HashSet::new(),
            prefer_tor,
        }
    }

    pub fn set_prefer_tor(&mut self, prefer_tor: bool) {
        self.prefer_tor = prefer_tor;
    }

    pub fn use_tor(&self, pubkey: &str, service: &str, onion_available: bool) -> bool {
        if !onion_available {
            return false;
        }
        self.forced.contains(&key(pubkey, service)) || self.prefer_tor
    }

    /// Flip the per-service override and return the resulting Tor state.
    pub fn toggle(&mut self, pubkey: &str, service: &str, onion_available: bool) -> bool {
        if !onion_available {
            return false;
        }
        let key = key(pubkey, service);
        if !self.forced.remove(&key) {
            self.forced.insert(key);
        }
        self.use_tor(pubkey, service, onion_available)
    }

    pub fn forced_tor(&self, pubkey: &str, service: &str) -> bool {
        self.forced.contains(&key(pubkey, service))
    }

    pub fn clear(&mut self) {
        self.forced.clear();
    }
}

fn key(pubkey: &str, service: &str) -> String {
    format!("{}:{}", pubkey.to_lowercase(), service)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::locator::normalize_endpoints;

    const NPUB: &str = "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhs2n3v";

    fn endpoints(value: serde_json::Value) -> Vec<Endpoint> {
        normalize_endpoints(&value, false)
    }

    #[test]
    fn tor_uses_onion_endpoints_when_they_exist() {
        let all = endpoints(json!([
            { "uri": "https://clearnet.example", "priority": 1 },
            { "uri": "https://abc.onion", "priority": 9 }
        ]));

        let selection = select_transport_endpoints(&all, true);
        assert!(selection.onion_available);
        assert!(!selection.onion_only);
        assert_eq!(selection.candidates.len(), 1);
        assert!(selection.candidates[0].url.contains(".onion"));

        let direct = select_transport_endpoints(&all, false);
        assert_eq!(direct.candidates.len(), 1);
        assert!(direct.candidates[0].url.contains("clearnet"));
    }

    #[test]
    fn reports_onion_only_records() {
        let only = endpoints(json!([{ "uri": "https://abc.onion" }]));
        let selection = select_transport_endpoints(&only, false);
        assert!(selection.onion_only);
        assert!(selection.candidates.is_empty());
        assert!(selection.onion_available);
    }

    #[test]
    fn https_preference_is_stable() {
        let all = endpoints(json!([
            { "uri": "http://First.example", "priority": 1 },
            { "uri": "https://second.example", "priority": 2 },
            { "uri": "https://third.example", "priority": 3 }
        ]));

        assert_eq!(
            sort_candidates_for_https(&all, HttpsMode::Off)[0].url,
            "http://first.example/"
        );
        let sorted = sort_candidates_for_https(&all, HttpsMode::Only);
        assert_eq!(sorted[0].url, "https://second.example/");
        assert_eq!(sorted[2].url, "http://first.example/");
    }

    #[test]
    fn per_service_toggle_survives_until_cleared() {
        let mut policy = TransportPolicy::new(false);
        assert!(
            !policy.use_tor(NPUB, "web", false),
            "no onion endpoint, no Tor"
        );

        assert!(policy.toggle(NPUB, "web", true));
        assert!(policy.forced_tor(NPUB, "web"));
        assert!(policy.use_tor(NPUB, "web", true));
        assert!(!policy.use_tor(NPUB, "other", true));

        assert!(!policy.toggle(NPUB, "web", true));
        assert!(!policy.forced_tor(NPUB, "web"));

        assert!(policy.toggle(NPUB, "web", true));
        policy.clear();
        assert!(!policy.forced_tor(NPUB, "web"));
    }

    #[test]
    fn global_preference_applies_to_every_service() {
        let policy = TransportPolicy::new(true);
        assert!(policy.use_tor(NPUB, "web", true));
        assert!(policy.use_tor(NPUB, "addr", true));
        assert!(!policy.use_tor(NPUB, "addr", false));
    }
}
