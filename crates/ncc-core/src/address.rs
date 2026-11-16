//! The `ncc://` address space.
//!
//! Two forms exist and they are not interchangeable:
//!
//! ```text
//! display / input   ncc://<npub>/<service>/<path…>     what the user types and sees
//! internal          ncc://<npub>.<service>/<path…>     what the content view loads
//! ```
//!
//! The internal form puts the service in the host so it is part of the origin. That
//! is what makes absolute-path subresources unambiguous (`/assets/app.js` belongs to
//! the service in the origin) and gives each service its own storage, cookies and
//! service-worker scope. A bare `npub` is never a document origin: it is the input
//! form and is redirected.
//!
//! Shells that cannot register a custom scheme (Android) map the internal form onto
//! a virtual host, but must keep this module's semantics: the service is the host
//! label and the display form is reconstructed with [`to_display_url`].

use std::fmt;

use url::Url;

use crate::base32::{decode as base32_decode, encode as base32_encode};
use crate::DEFAULT_SERVICE;

/// Service ids that can be used verbatim as a hostname label.
const HOST_SAFE_SERVICE_MAX: usize = 41;
const ENCODED_PREFIX: &str = "x-";
const MAX_LABEL: usize = 180;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NccUrlError {
    Empty,
    OnlyNcc,
    NotAUrl,
    NotNccHost,
    MissingPubkey,
    UnreadableService,
    BadServiceName(String),
    ServiceTooLong(String),
}

impl fmt::Display for NccUrlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("Enter an address"),
            Self::OnlyNcc => f.write_str("Only ncc:// addresses are supported here"),
            Self::NotAUrl => f.write_str("That is not a valid URL"),
            Self::NotNccHost => f.write_str(
                "The host must be an npub (npub1…) or a 64-character hex pubkey, \
                 optionally followed by a service",
            ),
            Self::MissingPubkey => f.write_str("Missing npub: use ncc://<npub>/<service>"),
            Self::UnreadableService => f.write_str("That service name is not valid"),
            Self::BadServiceName(service) => {
                write!(f, "\"{service}\" is not a valid service name")
            }
            Self::ServiceTooLong(service) => {
                write!(f, "\"{service}\" is too long to address over ncc://")
            }
        }
    }
}

impl std::error::Error for NccUrlError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NccAddress {
    pub pubkey: String,
    pub service: String,
    /// Either empty, `/`, or a path beginning with `/` and preserving a trailing slash.
    pub path: String,
    /// Includes the leading `?`, or is empty.
    pub search: String,
    /// Includes the leading `#`, or is empty.
    pub hash: String,
    /// True when the input already used the host-based internal form.
    pub internal: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NccHost {
    pub pubkey: String,
    /// `None` for the display/input form (`ncc://<npub>/…`).
    pub service: Option<String>,
}

/// True for an `npub1…` or 64-character hex public key.
pub fn is_nostr_id(value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return true;
    }
    match value.strip_prefix("npub1") {
        Some(rest) => rest.len() >= 20 && rest.chars().all(is_bech32_character),
        None => false,
    }
}

/// The bech32 data alphabet, minus `1` (which only appears in `npub1`).
fn is_bech32_character(character: char) -> bool {
    if character.is_ascii_digit() {
        return character != '1';
    }
    character.is_ascii_lowercase() && !matches!(character, 'b' | 'i' | 'o')
}

pub fn is_valid_service_name(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let mut characters = value.chars();
    match characters.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    value.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '~' | '-')
    })
}

/// True when the id may be used verbatim as a hostname label.
fn is_host_safe_service(value: &str) -> bool {
    if value.is_empty() || value.len() > HOST_SAFE_SERVICE_MAX {
        return false;
    }
    let bytes = value.as_bytes();
    if !(bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit()) {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

/// Host label for a service. Host-safe ids are used verbatim so the origin stays
/// readable (`ncc://<npub>.ditto`); everything else is base32 under an `x-` prefix,
/// which is reversible and stable, so origins survive restarts.
pub fn encode_service_label(service: &str) -> Option<String> {
    if is_host_safe_service(service) && !service.starts_with(ENCODED_PREFIX) {
        return Some(service.to_string());
    }
    let label = format!("{ENCODED_PREFIX}{}", base32_encode(service));
    (label.len() <= MAX_LABEL).then_some(label)
}

pub fn decode_service_label(label: &str) -> Option<String> {
    match label.strip_prefix(ENCODED_PREFIX) {
        None => is_host_safe_service(label).then(|| label.to_string()),
        Some(encoded) => {
            let service = base32_decode(encoded)?;
            is_valid_service_name(&service).then_some(service)
        }
    }
}

pub fn parse_ncc_host(hostname: &str) -> Option<NccHost> {
    let host = hostname.to_ascii_lowercase();
    let Some(dot) = host.find('.') else {
        return is_nostr_id(&host).then_some(NccHost {
            pubkey: host,
            service: None,
        });
    };

    let pubkey = &host[..dot];
    if !is_nostr_id(pubkey) {
        return None;
    }
    let service = decode_service_label(&host[dot + 1..])?;
    Some(NccHost {
        pubkey: pubkey.to_string(),
        service: Some(service),
    })
}

/// True for things the address bar should treat as NCC addresses.
pub fn looks_like_ncc_input(input: &str) -> bool {
    let text = input.trim();
    let lower = text.to_ascii_lowercase();
    if lower.starts_with("ncc:") || lower.starts_with("npub1") {
        return true;
    }
    match lower.find('/') {
        Some(index) => index == 64 && lower[..index].bytes().all(|byte| byte.is_ascii_hexdigit()),
        None => lower.len() == 64 && lower.bytes().all(|byte| byte.is_ascii_hexdigit()),
    }
}

pub fn parse_ncc_address(raw: &str) -> Result<NccAddress, NccUrlError> {
    let input = normalise_input(raw)?;
    let url = Url::parse(&input).map_err(|_| NccUrlError::NotAUrl)?;
    if url.scheme() != "ncc" {
        return Err(NccUrlError::OnlyNcc);
    }

    let raw_host = url.host_str().ok_or(NccUrlError::NotNccHost)?;
    let host = parse_ncc_host(raw_host).ok_or(NccUrlError::NotNccHost)?;
    if host.pubkey.is_empty() {
        return Err(NccUrlError::MissingPubkey);
    }

    let search = query_string(&url);
    let hash = fragment_string(&url);
    let pathname = url.path().to_string();

    if let Some(service) = host.service {
        return Ok(NccAddress {
            pubkey: host.pubkey,
            service,
            path: if pathname.is_empty() {
                "/".to_string()
            } else {
                pathname
            },
            search,
            hash,
            internal: true,
        });
    }

    let without_leading = pathname.trim_start_matches('/');
    // Internal/self-referential URLs may carry the explicit service prefix.
    let without_leading = without_leading
        .strip_prefix("_/")
        .unwrap_or(without_leading);
    let (raw_service, rest) = match without_leading.find('/') {
        Some(index) => (&without_leading[..index], &without_leading[index + 1..]),
        None => (without_leading, ""),
    };

    let service = if raw_service.is_empty() {
        DEFAULT_SERVICE.to_string()
    } else {
        let decoded = percent_decode(raw_service).ok_or(NccUrlError::UnreadableService)?;
        if !is_valid_service_name(&decoded) {
            return Err(NccUrlError::BadServiceName(decoded));
        }
        decoded
    };

    let path = if !rest.is_empty() {
        format!("/{rest}")
    } else if pathname.ends_with('/') {
        "/".to_string()
    } else {
        String::new()
    };

    Ok(NccAddress {
        pubkey: host.pubkey,
        service,
        path,
        search,
        hash,
        internal: false,
    })
}

#[derive(Debug, Clone, Default)]
pub struct BuildAddress {
    pub pubkey: String,
    pub service: Option<String>,
    pub path: Option<String>,
    pub search: Option<String>,
    pub hash: Option<String>,
    /// Always end the URL with a slash so relative subresources stay in the service
    /// namespace. Defaults to true.
    pub trailing_slash: Option<bool>,
}

/// Clean, user-facing form. The default service is omitted.
pub fn build_ncc_url(address: &BuildAddress) -> String {
    let service = match address.service.as_deref() {
        Some(service) if service != DEFAULT_SERVICE => service,
        _ => "",
    };

    let mut path = address.path.clone().unwrap_or_default();
    if !path.is_empty() && !path.starts_with('/') {
        path.insert(0, '/');
    }
    if path == "/" {
        path.clear();
    }

    let mut base = format!("ncc://{}", address.pubkey);
    if !service.is_empty() {
        base.push('/');
        base.push_str(service);
    }
    if path.is_empty() && address.trailing_slash.unwrap_or(true) {
        base.push('/');
    }

    format!(
        "{base}{path}{}{}",
        address.search.as_deref().unwrap_or_default(),
        address.hash.as_deref().unwrap_or_default()
    )
}

/// Internal, origin-scoped form:
/// `ncc://<npub>.<service>/<path>`.
///
/// Every navigation a shell initiates uses this form, so the service is part of the
/// origin and absolute-path subresources cannot be attributed to the wrong one.
pub fn to_internal_url(address: &BuildAddress) -> Result<String, NccUrlError> {
    build_internal_url(address)
}

pub fn build_internal_url(address: &BuildAddress) -> Result<String, NccUrlError> {
    let service = address
        .service
        .clone()
        .filter(|service| !service.is_empty())
        .unwrap_or_else(|| DEFAULT_SERVICE.to_string());
    let label = encode_service_label(&service)
        .ok_or_else(|| NccUrlError::ServiceTooLong(service.clone()))?;

    let mut path = address
        .path
        .clone()
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| "/".to_string());
    if !path.starts_with('/') {
        path.insert(0, '/');
    }

    Ok(format!(
        "ncc://{}.{}{}{}{}",
        address.pubkey,
        label,
        path,
        address.search.as_deref().unwrap_or_default(),
        address.hash.as_deref().unwrap_or_default()
    ))
}

/// The storage origin for a service: `ncc://<npub>.<label>`.
pub fn ncc_storage_origin(pubkey: &str, service: &str) -> String {
    match encode_service_label(service) {
        Some(label) => format!("ncc://{pubkey}.{label}"),
        None => format!("ncc://{pubkey}"),
    }
}

/// Turn an internal (host) URL into the clean form shown to the user.
pub fn to_display_url(url: &str) -> String {
    let Ok(parsed) = Url::parse(url) else {
        return url.to_string();
    };
    if parsed.scheme() != "ncc" {
        return url.to_string();
    }
    let Some(raw_host) = parsed.host_str() else {
        return url.to_string();
    };
    let Some(host) = parse_ncc_host(raw_host) else {
        return url.to_string();
    };
    let Some(service) = host.service else {
        return url.to_string();
    };

    let service_part = if service == DEFAULT_SERVICE {
        String::new()
    } else {
        format!("/{service}")
    };
    format!(
        "ncc://{}{}{}{}{}",
        host.pubkey,
        service_part,
        parsed.path(),
        query_string(&parsed),
        fragment_string(&parsed)
    )
}

/// Strip the scheme so the toolbar can show a compact address.
pub fn display_address(url: &str) -> String {
    url.strip_prefix("ncc://").unwrap_or(url).to_string()
}

fn normalise_input(raw: &str) -> Result<String, NccUrlError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(NccUrlError::Empty);
    }
    let lower = trimmed.to_ascii_lowercase();

    if has_scheme_prefix(trimmed) && !lower.starts_with("ncc://") {
        return Err(NccUrlError::OnlyNcc);
    }
    if lower.starts_with("ncc:") && !lower.starts_with("ncc://") {
        // ncc:npub1…/service → ncc://npub1…/service
        return Ok(format!("ncc://{}", trimmed[4..].trim_start_matches('/')));
    }
    if !lower.starts_with("ncc://") {
        // npub1…/service → ncc://npub1…/service
        return Ok(format!("ncc://{}", trimmed.trim_start_matches('/')));
    }
    Ok(trimmed.to_string())
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

/// `?…` or empty. A bare `?` produces empty, matching WHATWG `URL.search`.
fn query_string(url: &Url) -> String {
    match url.query() {
        Some(query) if !query.is_empty() => format!("?{query}"),
        _ => String::new(),
    }
}

/// `#…` or empty. A bare `#` produces empty, matching WHATWG `URL.hash`.
fn fragment_string(url: &Url) -> String {
    match url.fragment() {
        Some(fragment) if !fragment.is_empty() => format!("#{fragment}"),
        _ => String::new(),
    }
}

pub(crate) fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = *bytes.get(index + 1)?;
            let low = *bytes.get(index + 2)?;
            let pair = [high, low];
            let text = std::str::from_utf8(&pair).ok()?;
            out.push(u8::from_str_radix(text, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NPUB: &str = "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhs2n3v";

    fn hex_pubkey() -> String {
        "a".repeat(64)
    }

    #[test]
    fn parses_the_canonical_form() {
        let address =
            parse_ncc_address(&format!("ncc://{NPUB}/web/docs/page.html?x=1#top")).unwrap();
        assert_eq!(address.pubkey, NPUB);
        assert_eq!(address.service, "web");
        assert_eq!(address.path, "/docs/page.html");
        assert_eq!(address.search, "?x=1");
        assert_eq!(address.hash, "#top");
        assert!(!address.internal);
    }

    #[test]
    fn accepts_a_missing_service_segment_as_the_default_service() {
        assert_eq!(
            parse_ncc_address(&format!("ncc://{NPUB}")).unwrap().service,
            "addr"
        );
        assert_eq!(
            parse_ncc_address(&format!("ncc://{NPUB}/"))
                .unwrap()
                .service,
            "addr"
        );
        assert_eq!(
            parse_ncc_address(&format!("ncc://{NPUB}/")).unwrap().path,
            "/"
        );
    }

    #[test]
    fn normalises_the_ncc_and_schemeless_forms() {
        for input in [
            format!("ncc:{NPUB}/web"),
            format!("{NPUB}/web"),
            format!("ncc://{NPUB}/web"),
        ] {
            let address = parse_ncc_address(&input).unwrap();
            assert_eq!(address.pubkey, NPUB);
            assert_eq!(address.service, "web");
        }
    }

    #[test]
    fn lowercases_custom_scheme_hosts() {
        let address = parse_ncc_address(&format!("ncc://{}/web", NPUB.to_uppercase())).unwrap();
        assert_eq!(address.pubkey, NPUB);
    }

    #[test]
    fn accepts_a_hex_pubkey() {
        let hex = hex_pubkey();
        let address = parse_ncc_address(&format!("ncc://{hex}/api")).unwrap();
        assert_eq!(address.pubkey, hex);
        assert_eq!(address.service, "api");
    }

    #[test]
    fn preserves_a_trailing_slash_on_a_nested_path() {
        assert_eq!(
            parse_ncc_address(&format!("ncc://{NPUB}/web/a/"))
                .unwrap()
                .path,
            "/a/"
        );
    }

    #[test]
    fn rejects_non_ncc_schemes_and_empty_input() {
        assert_eq!(
            parse_ncc_address("https://example.com"),
            Err(NccUrlError::OnlyNcc)
        );
        assert_eq!(parse_ncc_address(""), Err(NccUrlError::Empty));
    }

    #[test]
    fn parses_the_explicit_underscore_service_form() {
        let address = parse_ncc_address(&format!("ncc://{NPUB}/_/secure/x")).unwrap();
        assert_eq!(address.service, "secure");
        assert_eq!(address.path, "/x");
        assert_eq!(
            parse_ncc_address(&format!("ncc://{NPUB}/_/secure/"))
                .unwrap()
                .path,
            "/"
        );
    }

    #[test]
    fn rejects_hosts_that_are_not_npubs() {
        assert_eq!(
            parse_ncc_address("ncc://example.com/web"),
            Err(NccUrlError::NotNccHost)
        );
    }

    #[test]
    fn rejects_invalid_service_names() {
        assert!(matches!(
            parse_ncc_address(&format!("ncc://{NPUB}/web%2Fevil")),
            Err(NccUrlError::BadServiceName(_))
        ));
        assert!(matches!(
            parse_ncc_address(&format!("ncc://{NPUB}/-bad")),
            Err(NccUrlError::BadServiceName(_))
        ));
    }

    #[test]
    fn omits_the_default_service_and_adds_a_root_slash() {
        let address = BuildAddress {
            pubkey: NPUB.to_string(),
            ..Default::default()
        };
        assert_eq!(build_ncc_url(&address), format!("ncc://{NPUB}/"));

        let explicit = BuildAddress {
            pubkey: NPUB.to_string(),
            service: Some("addr".into()),
            path: Some("/".into()),
            ..Default::default()
        };
        assert_eq!(build_ncc_url(&explicit), format!("ncc://{NPUB}/"));
    }

    #[test]
    fn keeps_the_service_and_path() {
        let address = BuildAddress {
            pubkey: NPUB.to_string(),
            service: Some("web".into()),
            path: Some("/docs".into()),
            ..Default::default()
        };
        assert_eq!(build_ncc_url(&address), format!("ncc://{NPUB}/web/docs"));
    }

    #[test]
    fn round_trips_through_the_parser() {
        let input = format!("ncc://{NPUB}/web/a/b?q=1");
        let parsed = parse_ncc_address(&input).unwrap();
        let rebuilt = build_ncc_url(&BuildAddress {
            pubkey: parsed.pubkey,
            service: Some(parsed.service),
            path: Some(parsed.path),
            search: Some(parsed.search),
            hash: Some(parsed.hash),
            trailing_slash: None,
        });
        assert_eq!(rebuilt, input);
    }

    #[test]
    fn uses_the_host_form_for_loading() {
        let internal = |input: &str| {
            let parsed = parse_ncc_address(input).unwrap();
            to_internal_url(&BuildAddress {
                pubkey: parsed.pubkey,
                service: Some(parsed.service),
                path: Some(parsed.path),
                ..Default::default()
            })
            .unwrap()
        };
        assert_eq!(
            internal(&format!("ncc://{NPUB}/web")),
            format!("ncc://{NPUB}.web/")
        );
        assert_eq!(
            internal(&format!("ncc://{NPUB}/web/x")),
            format!("ncc://{NPUB}.web/x")
        );
        assert_eq!(
            internal(&format!("ncc://{NPUB}")),
            format!("ncc://{NPUB}.addr/")
        );
    }

    #[test]
    fn round_trips_between_the_host_and_display_forms() {
        let display = format!("ncc://{NPUB}/web/docs?x=1#top");
        let parsed = parse_ncc_address(&display).unwrap();
        let internal = to_internal_url(&BuildAddress {
            pubkey: parsed.pubkey.clone(),
            service: Some(parsed.service.clone()),
            path: Some(parsed.path.clone()),
            search: Some(parsed.search.clone()),
            hash: Some(parsed.hash.clone()),
            trailing_slash: None,
        })
        .unwrap();
        assert_eq!(internal, format!("ncc://{NPUB}.web/docs?x=1#top"));
        assert_eq!(to_display_url(&internal), display);
        assert_eq!(
            to_display_url(&format!("ncc://{NPUB}.addr/")),
            format!("ncc://{NPUB}/")
        );
        assert_eq!(to_display_url("https://example.com"), "https://example.com");
    }

    #[test]
    fn parses_the_host_form_as_an_internal_address() {
        let address = parse_ncc_address(&format!("ncc://{NPUB}.web/assets/app.js")).unwrap();
        assert_eq!(address.pubkey, NPUB);
        assert_eq!(address.service, "web");
        assert_eq!(address.path, "/assets/app.js");
        assert!(address.internal);
    }

    #[test]
    fn encodes_service_ids_that_are_not_hostname_safe() {
        for service in ["a.b", "a~b", "UPPER", "x-abc"] {
            let internal = to_internal_url(&BuildAddress {
                pubkey: NPUB.to_string(),
                service: Some(service.to_string()),
                path: Some("/".into()),
                ..Default::default()
            })
            .unwrap();

            let parsed = parse_ncc_address(&internal).unwrap();
            assert_eq!(parsed.service, service);
            assert_eq!(parsed.path, "/");

            let label = internal
                .strip_prefix(&format!("ncc://{NPUB}."))
                .and_then(|rest| rest.split('/').next())
                .unwrap_or_default();
            assert!(label.starts_with("x-"), "unexpected label in {internal}");
            assert!(
                label[2..]
                    .chars()
                    .all(|character| character.is_ascii_lowercase()
                        || ('2'..='7').contains(&character)),
                "unexpected label in {internal}"
            );
            assert_eq!(
                to_display_url(&internal),
                format!("ncc://{NPUB}/{service}/")
            );
        }
    }

    #[test]
    fn storage_origins_are_per_service() {
        assert_eq!(ncc_storage_origin(NPUB, "web"), format!("ncc://{NPUB}.web"));
        assert_eq!(
            ncc_storage_origin(NPUB, "a.b"),
            format!("ncc://{NPUB}.x-mexge")
        );
        assert_ne!(
            ncc_storage_origin(NPUB, "web"),
            ncc_storage_origin(NPUB, "addr")
        );
    }

    #[test]
    fn detects_ncc_input_and_validates_service_names() {
        assert!(looks_like_ncc_input(&format!("ncc://{NPUB}/x")));
        assert!(looks_like_ncc_input(&format!("{NPUB}/x")));
        assert!(!looks_like_ncc_input("https://example.com"));

        assert!(is_valid_service_name("web"));
        assert!(is_valid_service_name("my.service-1"));
        assert!(!is_valid_service_name(""));
        assert!(!is_valid_service_name("/evil"));
    }

    #[test]
    fn display_address_strips_the_scheme() {
        assert_eq!(
            display_address(&format!("ncc://{NPUB}/web")),
            format!("{NPUB}/web")
        );
    }
}
