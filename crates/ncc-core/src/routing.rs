//! Pure routing helpers for the NCC proxy: endpoint path joining, upstream header
//! rewriting and redirect rewriting. Kept separate from any shell so both the
//! Electron and Tauri implementations can be checked against the same rules.

use std::collections::HashMap;

use url::Url;

use crate::address::{build_internal_url, parse_ncc_address, BuildAddress};

/// The `scheme://host[:port]` of an http(s) URL, with default ports dropped.
pub fn http_origin(url: &Url) -> Option<String> {
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{}://{}:{}", url.scheme(), host, port),
        None => format!("{}://{}", url.scheme(), host),
    })
}

pub struct RewriteContext {
    pub pubkey: String,
    pub service: String,
    /// The ncc:// URL that produced the response.
    pub current: Url,
    /// Origin of the endpoint that produced the response.
    pub endpoint_origin: String,
    /// Endpoint origin → the ncc/nsite service it was resolved for.
    pub endpoint_owners: HashMap<String, (String, String)>,
}

/// Rewrite a `Location` header so the content view never sees a raw endpoint address.
/// Redirects to other hosts are left alone: the service is telling us to leave NCC.
pub fn rewrite_location(location: &str, context: &RewriteContext) -> String {
    let Ok(resolved) = context.current.join(location) else {
        return location.to_string();
    };

    if resolved.scheme() == "ncc" {
        let Ok(address) = parse_ncc_address(resolved.as_str()) else {
            return resolved.to_string();
        };
        if address.pubkey != context.pubkey {
            return resolved.to_string();
        }
        return build_internal_url(&BuildAddress {
            pubkey: address.pubkey,
            service: Some(address.service),
            path: Some(address.path),
            search: Some(address.search),
            hash: Some(address.hash),
            trailing_slash: None,
        })
        .unwrap_or_else(|_| resolved.to_string());
    }

    if !matches!(resolved.scheme(), "http" | "https") {
        return location.to_string();
    }

    let Some(origin) = http_origin(&resolved) else {
        return location.to_string();
    };

    let (pubkey, service) = if origin == context.endpoint_origin {
        (context.pubkey.clone(), context.service.clone())
    } else {
        match context.endpoint_owners.get(&origin) {
            Some((owner, service)) if owner == &context.pubkey => (owner.clone(), service.clone()),
            _ => return location.to_string(),
        }
    };

    build_internal_url(&BuildAddress {
        pubkey,
        service: Some(service),
        path: Some(resolved.path().to_string()),
        search: Some(query_string(&resolved)),
        hash: Some(fragment_string(&resolved)),
        trailing_slash: None,
    })
    .unwrap_or_else(|_| location.to_string())
}

/// Join an endpoint's base path with the requested path, preserving slashes.
pub fn join_paths(base: &str, path: &str) -> String {
    let clean_base = if base == "/" {
        ""
    } else {
        base.trim_end_matches('/')
    };
    let clean_path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    let joined = format!("{clean_base}{clean_path}");
    if joined.is_empty() {
        "/".to_string()
    } else {
        joined
    }
}

/// Headers to send upstream for a proxied request.
///
/// `Host` and `Content-Length` are dropped (the transport sets them), a `ncc://`
/// origin is replaced by the endpoint origin so servers do not see a custom scheme,
/// and a `ncc://` referer becomes the corresponding endpoint URL.
pub fn upstream_headers(headers: &[(String, String)], target: &Url) -> Vec<(String, String)> {
    let origin = http_origin(target).unwrap_or_default();
    let mut out = Vec::with_capacity(headers.len());

    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if lower == "host" || lower == "content-length" {
            continue;
        }
        if lower == "origin" && value.to_ascii_lowercase().starts_with("ncc://") {
            out.push((name.clone(), origin.clone()));
            continue;
        }
        if lower == "referer" && value.to_ascii_lowercase().starts_with("ncc://") {
            out.push((name.clone(), format!("{origin}{}", target.path())));
            continue;
        }
        out.push((name.clone(), value.clone()));
    }
    out
}

fn query_string(url: &Url) -> String {
    match url.query() {
        Some(query) if !query.is_empty() => format!("?{query}"),
        _ => String::new(),
    }
}

fn fragment_string(url: &Url) -> String {
    match url.fragment() {
        Some(fragment) if !fragment.is_empty() => format!("#{fragment}"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NPUB: &str = "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhs2n3v";

    fn context() -> RewriteContext {
        let mut endpoint_owners = HashMap::new();
        endpoint_owners.insert(
            "https://other.example".to_string(),
            (NPUB.to_string(), "web".to_string()),
        );
        endpoint_owners.insert(
            "https://foreign.example".to_string(),
            ("npub1elsewhere".to_string(), "web".to_string()),
        );
        RewriteContext {
            pubkey: NPUB.to_string(),
            service: "web".to_string(),
            current: Url::parse(&format!("ncc://{NPUB}.web/docs/a")).unwrap(),
            endpoint_origin: "https://host.example".to_string(),
            endpoint_owners,
        }
    }

    #[test]
    fn rewrites_same_origin_redirects_into_the_service() {
        assert_eq!(
            rewrite_location("/login?next=/home", &context()),
            format!("ncc://{NPUB}.web/login?next=/home")
        );
        assert_eq!(
            rewrite_location("https://host.example/x#frag", &context()),
            format!("ncc://{NPUB}.web/x#frag")
        );
        assert_eq!(
            rewrite_location("a/b", &context()),
            format!("ncc://{NPUB}.web/docs/a/b")
        );
    }

    #[test]
    fn rewrites_known_sibling_endpoints_to_their_own_service() {
        assert_eq!(
            rewrite_location("https://other.example/y", &context()),
            format!("ncc://{NPUB}.web/y")
        );
    }

    #[test]
    fn leaves_foreign_hosts_alone() {
        assert_eq!(
            rewrite_location("https://elsewhere.example/z", &context()),
            "https://elsewhere.example/z"
        );
        assert_eq!(
            rewrite_location("https://foreign.example/z", &context()),
            "https://foreign.example/z"
        );
        assert_eq!(
            rewrite_location("mailto:hi@example.com", &context()),
            "mailto:hi@example.com"
        );
    }

    #[test]
    fn joins_endpoint_and_request_paths() {
        assert_eq!(join_paths("/", "/a"), "/a");
        assert_eq!(join_paths("", "/a"), "/a");
        assert_eq!(join_paths("/base/", "/a"), "/base/a");
        assert_eq!(join_paths("/base", "a"), "/base/a");
        assert_eq!(join_paths("/", ""), "/");
    }

    #[test]
    fn rewrites_origins_and_referers_and_drops_transport_headers() {
        let target = Url::parse("https://host.example:8443/base").unwrap();
        let headers = vec![
            ("Host".to_string(), "npub1x.web".to_string()),
            ("Content-Length".to_string(), "12".to_string()),
            ("Origin".to_string(), format!("ncc://{NPUB}.web")),
            ("Referer".to_string(), format!("ncc://{NPUB}.web/docs")),
            ("Accept".to_string(), "*/*".to_string()),
        ];

        let rewritten = upstream_headers(&headers, &target);
        assert_eq!(
            rewritten,
            vec![
                (
                    "Origin".to_string(),
                    "https://host.example:8443".to_string()
                ),
                (
                    "Referer".to_string(),
                    "https://host.example:8443/base".to_string()
                ),
                ("Accept".to_string(), "*/*".to_string()),
            ]
        );
    }

    #[test]
    fn leaves_clearnet_origins_and_referers_untouched() {
        let target = Url::parse("https://host.example/").unwrap();
        let headers = vec![
            (
                "Origin".to_string(),
                "https://elsewhere.example".to_string(),
            ),
            (
                "Referer".to_string(),
                "https://elsewhere.example/p".to_string(),
            ),
        ];
        assert_eq!(upstream_headers(&headers, &target), headers);
    }
}
