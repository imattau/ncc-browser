//! NIP-5A site rules that do not touch the network: site ids, host labels, path
//! matching and content types.
//!
//! Ported from `src/main/nsite/{manifest,mime}.ts` so both shells answer the same
//! way. The manifest is a set of `path` tags mapping a request path to a sha256; the
//! bytes themselves live on Blossom servers and are only usable once the hash checks
//! out.

use std::collections::BTreeMap;

pub const NSITE_ROOT_KIND: u16 = 15128;
pub const NSITE_NAMED_KIND: u16 = 35128;

/// Site ids become hostname labels, so they follow the same shape the desktop allows.
pub fn is_valid_site_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 13 || value.ends_with('-') {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

/// The host a shell loads for a site.
///
/// ```text
/// named   <npub>.<d>.nsite.localhost
/// root    <npub>.nsite.localhost
/// ```
///
/// The `nsite` label keeps the two schemes apart: an NCC service host is
/// `<npub>.<service>.localhost`, so four labels means a site and three do not.
pub fn nsite_host(pubkey: &str, site: Option<&str>) -> String {
    match site {
        Some(site) if !site.is_empty() => format!("{pubkey}.{site}.nsite.localhost"),
        _ => format!("{pubkey}.nsite.localhost"),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NsiteAddress {
    pub pubkey: String,
    pub site: Option<String>,
    /// Always begins with `/`; preserves a trailing slash.
    pub path: String,
    pub search: String,
    pub hash: String,
}

/// Parse `nsite://<npub>[/<d>][/<path…>]` and NIP-5A's concatenated base36 named-site
/// form `nsite://<pubkeyB36><d>[/<path…>]`.
///
/// The first segment is a site id only when it could be one, so `index.html` is a
/// root-site path and `blog` is a named site. Deciding properly needs the manifest,
/// which is the caller's job.
pub fn parse_nsite_address(raw: &str) -> Option<NsiteAddress> {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with("nsite://") {
        return None;
    }
    let rest = &trimmed["nsite://".len()..];

    let (before_hash, hash) = match rest.split_once('#') {
        Some((before, fragment)) => (before, format!("#{fragment}")),
        None => (rest, String::new()),
    };
    let (before_search, search) = match before_hash.split_once('?') {
        Some((before, query)) => (before, format!("?{query}")),
        None => (before_hash, String::new()),
    };

    let mut segments = before_search.split('/');
    let host = segments.next().filter(|value| !value.is_empty())?;
    let (pubkey, host_site) = if crate::address::is_nostr_id(host) {
        (host.to_string(), None)
    } else {
        let host = host.to_ascii_lowercase();
        if !(51..=63).contains(&host.len()) || !host.is_ascii() {
            return None;
        }
        let pubkey = decode_base36_pubkey(&host[..50])?;
        let site = host[50..].to_string();
        if !is_valid_site_id(&site) {
            return None;
        }
        (pubkey, Some(site))
    };

    let rest: Vec<&str> = segments.collect();
    let mut site = host_site;
    let mut path_segments: &[&str] = &rest;

    if site.is_none() {
        if let Some(first) = rest.first() {
            let candidate = first.to_ascii_lowercase();
            if is_valid_site_id(&candidate) {
                site = Some(candidate);
                path_segments = &rest[1..];
            }
        }
    }

    let path = if path_segments.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", path_segments.join("/"))
    };

    Some(NsiteAddress {
        pubkey,
        site,
        path,
        search,
        hash,
    })
}

/// Decode exactly 50 lowercase base36 digits as a big-endian 32-byte pubkey.
fn decode_base36_pubkey(input: &str) -> Option<String> {
    if input.len() != 50 || !input.is_ascii() {
        return None;
    }
    let mut bytes = [0u8; 32];
    for character in input.bytes() {
        let digit = match character.to_ascii_lowercase() {
            b'0'..=b'9' => character.to_ascii_lowercase() - b'0',
            b'a'..=b'z' => character.to_ascii_lowercase() - b'a' + 10,
            _ => return None,
        };
        let mut carry = u16::from(digit);
        for byte in bytes.iter_mut().rev() {
            let value = u16::from(*byte) * 36 + carry;
            *byte = value as u8;
            carry = value >> 8;
        }
        if carry != 0 {
            return None;
        }
    }
    Some(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathMatch {
    File { path: String, hash: String },
    Redirect { location: String },
    Missing,
}

/// Resolve a request path against a manifest, following NIP-5A's index rules.
pub fn match_path(paths: &BTreeMap<String, String>, request_path: &str, search: &str) -> PathMatch {
    let Some(mut path) = crate::address::percent_decode(request_path) else {
        return PathMatch::Missing;
    };
    if !path.starts_with('/') {
        path.insert(0, '/');
    }
    if path.contains('\0') || path.split('/').any(|segment| segment == "..") {
        return PathMatch::Missing;
    }

    if path.ends_with('/') {
        let index = format!("{path}index.html");
        return match paths.get(&index) {
            Some(hash) => PathMatch::File {
                path: index,
                hash: hash.clone(),
            },
            None => PathMatch::Missing,
        };
    }

    if let Some(hash) = paths.get(&path) {
        return PathMatch::File {
            path,
            hash: hash.clone(),
        };
    }

    // A directory that has files under it is addressed with a trailing slash, so
    // relative links stay inside it.
    let prefix = format!("{path}/");
    if paths.keys().any(|candidate| candidate.starts_with(&prefix)) {
        return PathMatch::Redirect {
            location: format!("{path}/{search}"),
        };
    }

    PathMatch::Missing
}

const TYPES: &[(&str, &str)] = &[
    (".html", "text/html; charset=utf-8"),
    (".htm", "text/html; charset=utf-8"),
    (".css", "text/css; charset=utf-8"),
    (".js", "text/javascript; charset=utf-8"),
    (".mjs", "text/javascript; charset=utf-8"),
    (".json", "application/json; charset=utf-8"),
    (".map", "application/json; charset=utf-8"),
    (".txt", "text/plain; charset=utf-8"),
    (".md", "text/markdown; charset=utf-8"),
    (".xml", "application/xml; charset=utf-8"),
    (".svg", "image/svg+xml"),
    (".png", "image/png"),
    (".jpg", "image/jpeg"),
    (".jpeg", "image/jpeg"),
    (".webp", "image/webp"),
    (".gif", "image/gif"),
    (".ico", "image/x-icon"),
    (".avif", "image/avif"),
    (".woff", "font/woff"),
    (".woff2", "font/woff2"),
    (".ttf", "font/ttf"),
    (".otf", "font/otf"),
    (".wasm", "application/wasm"),
    (".pdf", "application/pdf"),
    (".mp3", "audio/mpeg"),
    (".ogg", "audio/ogg"),
    (".mp4", "video/mp4"),
    (".webm", "video/webm"),
];

pub fn mime_for_path(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    let Some(dot) = lower.rfind('.') else {
        return "application/octet-stream";
    };
    let extension = &lower[dot..];
    TYPES
        .iter()
        .find(|(candidate, _)| *candidate == extension)
        .map(|(_, mime)| *mime)
        .unwrap_or("application/octet-stream")
}

/// Pick the type to serve a site file with.
///
/// A Blossom server is a content-addressed store and many answer `text/plain` for
/// everything they hold. Trusting that renders an index page as source text and breaks
/// `<script type="module">`, which enforces the type, so the path extension wins and
/// the upstream header only decides for extensionless paths.
pub fn content_type_for(path: &str, upstream: Option<&str>) -> String {
    let guessed = mime_for_path(path);
    if guessed != "application/octet-stream" {
        return guessed.to_string();
    }
    match upstream.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => value.to_string(),
        None => guessed.to_string(),
    }
}

/// sha256 over `"<hash> <path>\n"` lines, sorted ascending, as NIP-5A defines.
pub fn aggregate_hash(paths: &BTreeMap<String, String>) -> String {
    use sha2::{Digest, Sha256};

    let mut lines: Vec<String> = paths
        .iter()
        .map(|(path, hash)| format!("{hash} {path}\n"))
        .collect();
    lines.sort();

    let mut digest = Sha256::new();
    for line in lines {
        digest.update(line.as_bytes());
    }
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries
            .iter()
            .map(|(path, hash)| (path.to_string(), hash.to_string()))
            .collect()
    }

    fn hash(seed: char) -> String {
        std::iter::repeat(seed).take(64).collect()
    }

    #[test]
    fn site_ids_become_host_labels() {
        assert!(is_valid_site_id("myblog"));
        assert!(is_valid_site_id("a-b-1"));
        assert!(!is_valid_site_id(""));
        assert!(!is_valid_site_id("UPPER"));
        assert!(!is_valid_site_id("trailing-"));
        assert!(!is_valid_site_id("this-is-way-too-long"));

        assert_eq!(
            nsite_host("npub1x", Some("myblog")),
            "npub1x.myblog.nsite.localhost"
        );
        assert_eq!(nsite_host("npub1x", None), "npub1x.nsite.localhost");
    }

    const NPUB: &str = "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhs2n3v";

    #[test]
    fn parses_site_addresses() {
        let named = parse_nsite_address(&format!("nsite://{NPUB}/blog/docs/page.html?x=1#top"))
            .expect("named");
        assert_eq!(named.pubkey, NPUB);
        assert_eq!(named.site.as_deref(), Some("blog"));
        assert_eq!(named.path, "/docs/page.html");
        assert_eq!(named.search, "?x=1");
        assert_eq!(named.hash, "#top");

        let root = parse_nsite_address(&format!("nsite://{NPUB}/index.html")).expect("root");
        assert_eq!(root.site, None);
        assert_eq!(root.path, "/index.html");

        let bare = parse_nsite_address(&format!("nsite://{NPUB}")).expect("bare");
        assert_eq!(bare.path, "/");

        let trailing = parse_nsite_address(&format!("nsite://{NPUB}/blog/")).expect("trailing");
        assert_eq!(trailing.site.as_deref(), Some("blog"));
        assert_eq!(trailing.path, "/");

        assert!(parse_nsite_address("nsite://example.com/blog").is_none());
        assert!(parse_nsite_address("https://example.com").is_none());
    }

    #[test]
    fn parses_nip5a_concatenated_base36_named_site() {
        let address = parse_nsite_address(
            "nsite://47h1rs70oqaspur8bichfzalg0wnassb8d7tslfacl7hwyaxhkfreedom-tv",
        )
        .expect("NIP-5A named site");
        assert_eq!(
            address.pubkey,
            "a8d1560d6a647d501699167246f237b36fb123f89168fda11dc743533fec7a08"
        );
        assert_eq!(address.site.as_deref(), Some("freedom-tv"));
        assert_eq!(address.path, "/");

        assert!(parse_nsite_address(&format!("nsite://{}{}", "z".repeat(50), "site")).is_none());
        assert!(parse_nsite_address(&format!("nsite://{}bad-", "1".repeat(50))).is_none());
    }

    #[test]
    fn directories_resolve_to_their_index() {
        let manifest = paths(&[
            ("/index.html", &hash('a')),
            ("/docs/index.html", &hash('b')),
        ]);
        assert_eq!(
            match_path(&manifest, "/", ""),
            PathMatch::File {
                path: "/index.html".into(),
                hash: hash('a')
            }
        );
        assert_eq!(
            match_path(&manifest, "/docs/", ""),
            PathMatch::File {
                path: "/docs/index.html".into(),
                hash: hash('b')
            }
        );
    }

    #[test]
    fn exact_paths_win_and_directories_redirect() {
        let manifest = paths(&[("/app.js", &hash('c')), ("/docs/a.html", &hash('d'))]);
        assert_eq!(
            match_path(&manifest, "/app.js", ""),
            PathMatch::File {
                path: "/app.js".into(),
                hash: hash('c')
            }
        );
        assert_eq!(
            match_path(&manifest, "/docs", "?x=1"),
            PathMatch::Redirect {
                location: "/docs/?x=1".into()
            }
        );
        assert_eq!(match_path(&manifest, "/nope", ""), PathMatch::Missing);
    }

    #[test]
    fn traversal_and_bad_escapes_are_refused() {
        let manifest = paths(&[("/app.js", &hash('c'))]);
        assert_eq!(
            match_path(&manifest, "/../etc/passwd", ""),
            PathMatch::Missing
        );
        assert_eq!(match_path(&manifest, "/%ZZ", ""), PathMatch::Missing);
        assert_eq!(match_path(&manifest, "/a%00b", ""), PathMatch::Missing);
    }

    #[test]
    fn the_path_extension_decides_the_type() {
        assert_eq!(
            content_type_for("/index.html", Some("text/plain")),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            content_type_for("/app.js", None),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(content_type_for("/blob", Some("image/png")), "image/png");
        assert_eq!(content_type_for("/blob", None), "application/octet-stream");
        assert_eq!(mime_for_path("/photo.JPEG"), "image/jpeg");
    }

    #[test]
    fn the_aggregate_is_order_independent() {
        let one = paths(&[("/a", &hash('a')), ("/b", &hash('b'))]);
        let two = paths(&[("/b", &hash('b')), ("/a", &hash('a'))]);
        assert_eq!(aggregate_hash(&one), aggregate_hash(&two));
    }
}
