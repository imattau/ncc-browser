//! Pure NCC-05 payload logic: candidate `d` tags, payload validation, endpoint
//! normalisation and relay endpoint choice. No I/O, so every rule here is testable.

use std::cmp::Ordering;

use serde_json::{Map, Value};
use url::{Host, Url};

use crate::DEFAULT_SERVICE;

pub const DEFAULT_D_TAG: &str = DEFAULT_SERVICE;
pub const DEFAULT_PRIORITY: i64 = 1000;

/// Schemes that can carry a page. `ws`/`wss` are only accepted when the caller asks
/// for a relay resolution.
const WEB_SCHEME_ALIASES: &[(&str, &str)] = &[
    ("http", "http"),
    ("https", "https"),
    ("tcp", "http"),
    ("tls", "https"),
    ("tcps", "https"),
    ("ssl", "https"),
    ("ws", "ws"),
    ("wss", "wss"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EndpointFamily {
    Onion,
    Ipv6,
    Ipv4,
    Unknown,
}

impl EndpointFamily {
    fn rank(self) -> u8 {
        match self {
            Self::Onion => 0,
            Self::Ipv6 => 1,
            Self::Ipv4 => 2,
            Self::Unknown => 3,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Onion => "onion",
            Self::Ipv6 => "ipv6",
            Self::Ipv4 => "ipv4",
            Self::Unknown => "unknown",
        }
    }
}

/// A normalised endpoint from a locator payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    /// Absolute http(s)/ws(s) URL, normalised so it can be handed straight to a fetch.
    pub url: String,
    pub protocol: String,
    pub priority: i64,
    pub family: EndpointFamily,
    /// SPKI fingerprint from the locator (`k`), if the publisher supplied one.
    pub k: Option<String>,
}

/// A validated NCC-05 payload. Unknown fields are preserved so a caller can read
/// extensions without this crate knowing about them.
#[derive(Debug, Clone, PartialEq)]
pub struct Payload {
    pub ttl: i64,
    pub updated_at: i64,
    pub fields: Map<String, Value>,
}

/// The `d` tag is not standardised across publishers: NCC-05 defaults to `addr`,
/// `ncc-sidecar` publishes `<service>-locator`, and NCC-02 uses the bare service id.
/// Probe the most specific first and fall back to the generic record last.
pub fn candidate_d_tags(service: Option<&str>) -> Vec<String> {
    let requested = service.map(str::trim).unwrap_or_default();
    let requested = if requested.is_empty() {
        DEFAULT_D_TAG
    } else {
        requested
    };
    if requested == DEFAULT_D_TAG {
        return vec![DEFAULT_D_TAG.to_string()];
    }
    let mut candidates = vec![
        requested.to_string(),
        format!("{requested}-locator"),
        DEFAULT_D_TAG.to_string(),
    ];
    candidates.dedup();
    candidates
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DTagSource {
    Exact,
    LocatorSuffix,
    Default,
}

impl DTagSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::LocatorSuffix => "locator-suffix",
            Self::Default => "default",
        }
    }
}

pub fn d_tag_source(d_tag: &str, service: &str) -> DTagSource {
    if d_tag == service {
        DTagSource::Exact
    } else if d_tag == format!("{service}-locator") {
        DTagSource::LocatorSuffix
    } else {
        DTagSource::Default
    }
}

fn as_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        // `Number(true)` is 1 in JavaScript; keep the same coercion.
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        _ => None,
    }
}

pub fn parse_payload(value: &Value) -> Option<Payload> {
    let fields = value.as_object()?;
    if !fields.get("endpoints")?.is_array() {
        return None;
    }

    let ttl = as_number(fields.get("ttl"))?;
    let updated_at = as_number(fields.get("updated_at"))?;
    if !ttl.is_finite() || ttl <= 0.0 {
        return None;
    }
    if !updated_at.is_finite() || updated_at <= 0.0 {
        return None;
    }

    Some(Payload {
        ttl: ttl as i64,
        updated_at: updated_at as i64,
        fields: fields.clone(),
    })
}

/// NCC-05 §8: expiry is the earliest of the `expiration` tag and `updated_at + ttl`.
pub fn payload_expiry(payload: &Payload, expiration_tag: Option<&str>) -> i64 {
    let from_tag = expiration_tag.and_then(|value| value.trim().parse::<i64>().ok());
    let from_ttl = payload.updated_at.saturating_add(payload.ttl);
    match from_tag {
        Some(tag) if tag > 0 => tag.min(from_ttl),
        _ => from_ttl,
    }
}

fn string_field(object: &Map<String, Value>, names: &[&str]) -> String {
    for name in names {
        match object.get(*name) {
            Some(Value::String(text)) => return text.trim().to_string(),
            Some(Value::Number(number)) => return number.to_string(),
            Some(Value::Bool(flag)) => return flag.to_string(),
            _ => continue,
        }
    }
    String::new()
}

fn has_scheme_prefix(input: &str) -> bool {
    let Some(index) = input.find("://") else {
        return false;
    };
    let scheme = &input[..index];
    let mut characters = scheme.chars();
    match characters.next() {
        Some(first) if first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    characters
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '+' | '.' | '-'))
}

fn absolute_url(raw: &str, declared_protocol: &str) -> String {
    if has_scheme_prefix(raw) {
        return raw.to_string();
    }
    let protocol = if !declared_protocol.is_empty()
        && declared_protocol
            .chars()
            .enumerate()
            .all(|(index, character)| {
                if index == 0 {
                    character.is_ascii_alphabetic()
                } else {
                    character.is_ascii_alphanumeric() || matches!(character, '+' | '.' | '-')
                }
            }) {
        declared_protocol
    } else {
        "http"
    };
    format!("{protocol}://{raw}")
}

fn detect_family(hostname: &str, declared: Option<&Value>) -> EndpointFamily {
    if let Some(Value::String(value)) = declared {
        match value.to_ascii_lowercase().as_str() {
            "onion" => return EndpointFamily::Onion,
            "ipv6" => return EndpointFamily::Ipv6,
            "ipv4" => return EndpointFamily::Ipv4,
            _ => {}
        }
    }
    let host = hostname.trim_start_matches('[').trim_end_matches(']');
    if host.ends_with(".onion") {
        EndpointFamily::Onion
    } else if host.contains(':') {
        EndpointFamily::Ipv6
    } else if is_ipv4_literal(host) {
        EndpointFamily::Ipv4
    } else {
        EndpointFamily::Unknown
    }
}

fn is_ipv4_literal(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|part| {
            !part.is_empty() && part.len() <= 3 && part.chars().all(|c| c.is_ascii_digit())
        })
}

/// Normalise publisher payload endpoints into fetchable URLs.
///
/// Verified quirks this handles:
/// - the spec says `url`, the JS reference implementation publishes `uri`;
/// - `uri` values frequently have no scheme at all (`192.168.1.42:443`);
/// - `priority` is often omitted (spec default 1000, but one helper defaults to 0).
pub fn normalize_endpoints(input: &Value, allow_ws: bool) -> Vec<Endpoint> {
    let Some(items) = input.as_array() else {
        return Vec::new();
    };

    let mut out = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    for item in items {
        let Some(raw) = item.as_object() else {
            continue;
        };

        let raw_url = string_field(raw, &["url", "uri", "value"]);
        if raw_url.is_empty() {
            continue;
        }

        let declared_protocol =
            string_field(raw, &["protocol", "type", "scheme"]).to_ascii_lowercase();
        let absolute = absolute_url(&raw_url, &declared_protocol);

        let Ok(parsed) = Url::parse(&absolute) else {
            continue;
        };
        let scheme = parsed.scheme().to_ascii_lowercase();
        let Some((_, protocol)) = WEB_SCHEME_ALIASES
            .iter()
            .find(|(alias, _)| *alias == scheme)
        else {
            continue;
        };
        if matches!(*protocol, "ws" | "wss") && !allow_ws {
            continue;
        }

        let Some(host) = parsed.host() else {
            continue;
        };
        // Non-special schemes cannot be re-typed in place, so rebuild the URL.
        let authority = match host {
            Host::Domain(domain) => domain.to_string(),
            Host::Ipv4(address) => address.to_string(),
            Host::Ipv6(address) => format!("[{address}]"),
        };
        let authority = match parsed.port() {
            Some(port) => format!("{authority}:{port}"),
            None => authority,
        };

        let mut rebuilt = format!("{protocol}://{authority}{}", parsed.path());
        if let Some(query) = parsed.query() {
            rebuilt.push('?');
            rebuilt.push_str(query);
        }
        if let Some(fragment) = parsed.fragment() {
            rebuilt.push('#');
            rebuilt.push_str(fragment);
        }

        let Ok(url) = Url::parse(&rebuilt) else {
            continue;
        };
        let href = url.to_string();
        if seen.iter().any(|existing| existing == &href) {
            continue;
        }
        seen.push(href.clone());

        let priority = as_number(raw.get("priority").or_else(|| raw.get("prio")))
            .filter(|value| value.is_finite())
            .map(|value| value as i64)
            .unwrap_or(DEFAULT_PRIORITY);

        let k = ["k", "fingerprint"]
            .iter()
            .find_map(|name| raw.get(*name))
            .and_then(|value| value.as_str())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        out.push(Endpoint {
            url: href,
            protocol: protocol.to_string(),
            priority,
            family: detect_family(url.host_str().unwrap_or_default(), raw.get("family")),
            k,
        });
    }

    out
}

fn endpoint_cmp(left: &Endpoint, right: &Endpoint) -> Ordering {
    left.priority
        .cmp(&right.priority)
        .then_with(|| left.family.rank().cmp(&right.family.rank()))
        .then_with(|| left.url.cmp(&right.url))
}

pub fn sort_endpoints(endpoints: &[Endpoint]) -> Vec<Endpoint> {
    let mut sorted = endpoints.to_vec();
    sorted.sort_by(endpoint_cmp);
    sorted
}

/// True when the endpoint's scheme is protected, i.e. pinning is meaningful.
pub fn is_secure_endpoint(endpoint: &Endpoint) -> bool {
    matches!(endpoint.protocol.as_str(), "https" | "wss")
}

/// True when the endpoint can carry a Nostr relay connection.
pub fn is_relay_endpoint(endpoint: &Endpoint) -> bool {
    matches!(endpoint.protocol.as_str(), "ws" | "wss")
}

fn is_loopback_host(hostname: &str) -> bool {
    let host = hostname
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    host == "localhost" || host == "::1" || host == "127.0.0.1" || host.ends_with(".localhost")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayEndpointRejection {
    NoRelayEndpoint,
    OnionRequiresTor,
    InsecureEndpoint,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayEndpointSelection {
    pub endpoint: Option<Endpoint>,
    /// Other usable endpoints, in preference order, for failover or display.
    pub alternatives: Vec<Endpoint>,
    /// Why the preferred endpoints were rejected; `None` when one was chosen.
    pub rejected: Option<RelayEndpointRejection>,
}

/// Choose a relay endpoint from an IPv6/onion/IPv4 mix.
///
/// Rules, in order:
/// - only `ws:`/`wss:` endpoints qualify;
/// - `ws:` is cleartext, so it is only allowed on loopback or an onion address;
/// - onion endpoints need Tor; without it they are skipped rather than failing;
/// - `wss:` beats `ws:` within the publisher's priority order.
pub fn select_relay_endpoint(endpoints: &[Endpoint], tor_ready: bool) -> RelayEndpointSelection {
    let candidates: Vec<Endpoint> = endpoints
        .iter()
        .filter(|endpoint| is_relay_endpoint(endpoint))
        .cloned()
        .collect();

    if candidates.is_empty() {
        return RelayEndpointSelection {
            endpoint: None,
            alternatives: Vec::new(),
            rejected: Some(RelayEndpointRejection::NoRelayEndpoint),
        };
    }

    let mut usable: Vec<Endpoint> = candidates
        .iter()
        .filter(|endpoint| {
            if endpoint.family == EndpointFamily::Onion && !tor_ready {
                return false;
            }
            if endpoint.protocol == "ws" && endpoint.family != EndpointFamily::Onion {
                let loopback = Url::parse(&endpoint.url)
                    .ok()
                    .and_then(|url| url.host_str().map(is_loopback_host))
                    .unwrap_or(false);
                if !loopback {
                    return false;
                }
            }
            true
        })
        .cloned()
        .collect();

    usable.sort_by(endpoint_cmp);
    // Stable sort: `wss:` wins inside the publisher's priority order.
    usable.sort_by_key(|endpoint| endpoint.protocol != "wss");

    if !usable.is_empty() {
        let mut alternatives = usable.clone();
        let endpoint = alternatives.remove(0);
        return RelayEndpointSelection {
            endpoint: Some(endpoint),
            alternatives,
            rejected: None,
        };
    }

    if candidates
        .iter()
        .any(|endpoint| endpoint.family == EndpointFamily::Onion)
    {
        return RelayEndpointSelection {
            endpoint: None,
            alternatives: Vec::new(),
            rejected: Some(RelayEndpointRejection::OnionRequiresTor),
        };
    }
    RelayEndpointSelection {
        endpoint: None,
        alternatives: Vec::new(),
        rejected: Some(RelayEndpointRejection::InsecureEndpoint),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn probes_exact_then_sidecar_suffix_then_default() {
        assert_eq!(
            candidate_d_tags(Some("web")),
            vec!["web", "web-locator", "addr"]
        );
    }

    #[test]
    fn uses_only_addr_when_no_service_is_addressed() {
        assert_eq!(candidate_d_tags(None), vec!["addr"]);
        assert_eq!(candidate_d_tags(Some("")), vec!["addr"]);
        assert_eq!(candidate_d_tags(Some("addr")), vec!["addr"]);
    }

    #[test]
    fn classifies_which_candidate_matched() {
        assert_eq!(d_tag_source("web", "web"), DTagSource::Exact);
        assert_eq!(
            d_tag_source("web-locator", "web"),
            DTagSource::LocatorSuffix
        );
        assert_eq!(d_tag_source("addr", "web"), DTagSource::Default);
    }

    #[test]
    fn accepts_a_valid_payload_and_coerces_numbers() {
        let payload = json!({
            "ttl": "600",
            "updated_at": 1_700_000_000,
            "endpoints": [{ "uri": "1.2.3.4:80" }]
        });
        let parsed = parse_payload(&payload).expect("valid payload");
        assert_eq!(parsed.ttl, 600);
    }

    #[test]
    fn rejects_missing_or_invalid_payload_fields() {
        assert!(parse_payload(&json!(null)).is_none());
        assert!(parse_payload(&json!({ "ttl": 600, "updated_at": 1, })).is_none());
        assert!(parse_payload(&json!({ "ttl": 0, "updated_at": 1, "endpoints": [] })).is_none());
        assert!(parse_payload(&json!({ "ttl": -1, "updated_at": 1, "endpoints": [] })).is_none());
        assert!(
            parse_payload(&json!({ "ttl": 600, "updated_at": "soon", "endpoints": [] })).is_none()
        );
    }

    #[test]
    fn expiry_falls_back_to_updated_at_plus_ttl() {
        let payload =
            parse_payload(&json!({ "ttl": 600, "updated_at": 1000, "endpoints": [] })).unwrap();
        assert_eq!(payload_expiry(&payload, None), 1600);
        assert_eq!(payload_expiry(&payload, Some("1500")), 1500);
        assert_eq!(payload_expiry(&payload, Some("9999")), 1600);
        assert_eq!(payload_expiry(&payload, Some("not-a-number")), 1600);
    }

    #[test]
    fn accepts_both_url_and_uri() {
        let endpoints = normalize_endpoints(
            &json!([
                { "url": "https://one.example:8443", "priority": 1 },
                { "uri": "http://two.example:8080", "priority": 2 }
            ]),
            false,
        );
        let urls: Vec<&str> = endpoints
            .iter()
            .map(|endpoint| endpoint.url.as_str())
            .collect();
        assert_eq!(
            urls,
            vec!["https://one.example:8443/", "http://two.example:8080/"]
        );
    }

    #[test]
    fn gives_schemeless_endpoints_a_scheme_from_type_or_protocol() {
        let endpoints = normalize_endpoints(
            &json!([
                { "type": "https", "uri": "192.168.1.42:443" },
                { "protocol": "http", "uri": "192.168.1.42:8080" }
            ]),
            false,
        );
        assert_eq!(endpoints[0].url, "https://192.168.1.42/");
        assert_eq!(endpoints[0].protocol, "https");
        assert_eq!(endpoints[1].url, "http://192.168.1.42:8080/");
    }

    #[test]
    fn maps_tcp_and_tls_aliases_to_fetchable_schemes() {
        let endpoints = normalize_endpoints(
            &json!([
                { "type": "tcp", "uri": "10.0.0.1:80" },
                { "type": "tls", "uri": "10.0.0.2:443" }
            ]),
            false,
        );
        assert_eq!(endpoints[0].protocol, "http");
        assert_eq!(endpoints[1].protocol, "https");
    }

    #[test]
    fn drops_transports_that_cannot_carry_a_page() {
        let endpoints = normalize_endpoints(
            &json!([
                { "type": "wss", "uri": "wss://relay.example" },
                { "type": "onion", "uri": "abc.onion:80" },
                { "type": "http", "uri": "1.2.3.4:80" }
            ]),
            false,
        );
        assert_eq!(endpoints.len(), 1);
    }

    #[test]
    fn keeps_relay_endpoints_when_asked() {
        let endpoints = normalize_endpoints(
            &json!([{ "type": "wss", "uri": "wss://relay.example" }]),
            true,
        );
        assert_eq!(endpoints.len(), 1);
        assert!(is_relay_endpoint(&endpoints[0]));
        assert!(is_secure_endpoint(&endpoints[0]));
    }

    #[test]
    fn handles_ipv6_literals() {
        let endpoints = normalize_endpoints(
            &json!([{ "type": "http", "uri": "[2001:db8::1]:8080" }]),
            false,
        );
        assert_eq!(endpoints[0].url, "http://[2001:db8::1]:8080/");
        assert_eq!(endpoints[0].family, EndpointFamily::Ipv6);
    }

    #[test]
    fn defaults_priority_to_1000_not_zero() {
        let endpoints = normalize_endpoints(&json!([{ "uri": "1.2.3.4:80" }]), false);
        assert_eq!(endpoints[0].priority, DEFAULT_PRIORITY);
    }

    #[test]
    fn deduplicates_identical_endpoints_and_ignores_junk() {
        let endpoints = normalize_endpoints(
            &json!([
                { "uri": "1.2.3.4:80" },
                { "url": "http://1.2.3.4:80/" },
                null,
                "nope",
                { "uri": "" }
            ]),
            false,
        );
        assert_eq!(endpoints.len(), 1);
    }

    #[test]
    fn keeps_the_k_fingerprint() {
        let endpoints = normalize_endpoints(
            &json!([{ "uri": "1.2.3.4:443", "type": "https", "k": "abc" }]),
            false,
        );
        assert_eq!(endpoints[0].k.as_deref(), Some("abc"));
    }

    #[test]
    fn sorts_by_priority_then_family() {
        let endpoints = normalize_endpoints(
            &json!([
                { "uri": "4.4.4.4:80", "priority": 10 },
                { "uri": "[2001:db8::1]:80", "priority": 10 },
                { "uri": "1.1.1.1:80", "priority": 5 }
            ]),
            false,
        );
        let families: Vec<EndpointFamily> = sort_endpoints(&endpoints)
            .iter()
            .map(|endpoint| endpoint.family)
            .collect();
        assert_eq!(
            families,
            vec![
                EndpointFamily::Ipv4,
                EndpointFamily::Ipv6,
                EndpointFamily::Ipv4
            ]
        );
        assert!(sort_endpoints(&endpoints)[0].url.contains("1.1.1.1"));
    }

    #[test]
    fn relay_selection_requires_tor_for_onion_and_tsl_for_clearnet() {
        let endpoints = normalize_endpoints(
            &json!([
                { "type": "ws", "uri": "ws://relay.example" },
                { "type": "wss", "uri": "wss://relay.example", "priority": 5 },
                { "type": "wss", "uri": "wss://abc.onion", "priority": 1 }
            ]),
            true,
        );

        let selection = select_relay_endpoint(&endpoints, false);
        assert_eq!(
            selection
                .endpoint
                .as_ref()
                .map(|endpoint| endpoint.url.as_str()),
            Some("wss://relay.example/")
        );
        assert_eq!(selection.alternatives.len(), 0);

        let with_tor = select_relay_endpoint(&endpoints, true);
        assert_eq!(
            with_tor
                .endpoint
                .as_ref()
                .map(|endpoint| endpoint.url.as_str()),
            Some("wss://abc.onion/")
        );
    }

    #[test]
    fn relay_selection_reports_why_it_refused() {
        let onion_only =
            normalize_endpoints(&json!([{ "type": "wss", "uri": "wss://abc.onion" }]), true);
        assert_eq!(
            select_relay_endpoint(&onion_only, false).rejected,
            Some(RelayEndpointRejection::OnionRequiresTor)
        );

        let cleartext = normalize_endpoints(
            &json!([{ "type": "ws", "uri": "ws://relay.example" }]),
            true,
        );
        assert_eq!(
            select_relay_endpoint(&cleartext, false).rejected,
            Some(RelayEndpointRejection::InsecureEndpoint)
        );

        let none = normalize_endpoints(&json!([{ "type": "http", "uri": "1.2.3.4:80" }]), true);
        assert_eq!(
            select_relay_endpoint(&none, false).rejected,
            Some(RelayEndpointRejection::NoRelayEndpoint)
        );
    }

    #[test]
    fn loopback_cleartext_relays_are_allowed() {
        let endpoints = normalize_endpoints(
            &json!([{ "type": "ws", "uri": "ws://127.0.0.1:7777" }]),
            true,
        );
        assert!(select_relay_endpoint(&endpoints, false).endpoint.is_some());
    }
}
