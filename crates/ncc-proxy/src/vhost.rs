//! Virtual-host mapping for shells that cannot register `ncc://`.
//!
//! ```text
//! ncc://<npub>.<service>/path          http://<npub>.<service>.localhost:PORT/path
//! ncc://<npub>.addr/path               http://<npub>.localhost:PORT/path
//! ```
//!
//! The service label uses the same encoding as the internal form (`x-<base32>` when
//! the id is not hostname-safe), so a service that works on the desktop keeps the
//! same identity here.

use ncc_core::{
    decode_service_label, encode_service_label, is_nostr_id, is_valid_site_id, DEFAULT_SERVICE,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKind {
    /// `<npub>.<service>.localhost`
    Ncc,
    /// `<npub>.<d>.nsite.localhost`, or `<npub>.nsite.localhost` for the root site.
    Nsite,
    /// `<onion>.onion.localhost`: an onion site, served through Tor.
    Onion,
    /// `<host>.tor.localhost`: an ordinary https site, fetched through Tor by a Tor
    /// tab. The upstream host (`example.com`, or `example.com:8443`) is in `onion`.
    Clearnet,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Vhost {
    pub pubkey: String,
    /// NCC service id; empty for a site.
    pub service: String,
    /// NIP-5A site id; `None` for the root site and for NCC hosts.
    pub site: Option<String>,
    /// The onion host, with its `.onion` suffix, for a Tor vhost.
    pub onion: Option<String>,
    pub kind: HostKind,
}

impl Vhost {
    /// The unit trust and signer approvals are scoped to, and the canonical address.
    pub fn identity_key(&self) -> String {
        match self.kind {
            HostKind::Ncc => format!("ncc://{}/{}", self.pubkey, self.service),
            HostKind::Nsite => match &self.site {
                Some(site) => format!("nsite://{}/{}", self.pubkey, site),
                None => format!("nsite://{}", self.pubkey),
            },
            HostKind::Onion => format!("onion://{}", self.onion.as_deref().unwrap_or_default()),
            HostKind::Clearnet => format!("https://{}", self.onion.as_deref().unwrap_or_default()),
        }
    }
}

pub fn parse_vhost(host: &str) -> Option<Vhost> {
    let host = host
        .split(':')
        .next()
        .unwrap_or(host)
        .trim_end_matches('.')
        .to_ascii_lowercase();

    // `<onion>.onion.localhost` is an onion site. Checked first because the label is
    // not a Nostr id and would otherwise be rejected by the NCC path.
    if let Some(label) = host.strip_suffix(".onion.localhost") {
        let onion = format!("{label}.onion");
        if !ncc_core::is_onion_host(&onion) {
            return None;
        }
        return Some(Vhost {
            pubkey: String::new(),
            service: String::new(),
            site: None,
            onion: Some(onion),
            kind: HostKind::Onion,
        });
    }

    // `<host>[.p<port>].tor.localhost` is a clearnet site reached through Tor.
    if let Some(label) = host.strip_suffix(".tor.localhost") {
        let (name, port) = match label.rsplit_once('.') {
            Some((name, last))
                if last.len() > 1
                    && last.starts_with('p')
                    && last[1..].bytes().all(|byte| byte.is_ascii_digit()) =>
            {
                (name, last[1..].parse::<u16>().ok().filter(|port| *port != 0)?.into())
            }
            _ => (label, 0u16),
        };
        if !is_clearnet_host(name) {
            return None;
        }
        let upstream = if port == 0 || port == 443 {
            name.to_string()
        } else {
            format!("{name}:{port}")
        };
        return Some(Vhost {
            pubkey: String::new(),
            service: String::new(),
            site: None,
            onion: Some(upstream),
            kind: HostKind::Clearnet,
        });
    }

    // `<npub>.<d>.nsite.localhost` and `<npub>.nsite.localhost` are sites; anything
    // else ending in `.localhost` is an NCC service.
    if let Some(prefix) = host.strip_suffix(".nsite.localhost") {
        let (pubkey, site) = match prefix.split_once('.') {
            Some((pubkey, site)) => (pubkey, Some(site.to_string())),
            None => (prefix, None),
        };
        if !is_nostr_id(pubkey) {
            return None;
        }
        if let Some(site) = &site {
            if !is_valid_site_id(site) {
                return None;
            }
        }
        return Some(Vhost {
            pubkey: pubkey.to_string(),
            service: String::new(),
            site,
            onion: None,
            kind: HostKind::Nsite,
        });
    }

    let (pubkey, rest) = host.split_once('.')?;
    if !is_nostr_id(pubkey) {
        return None;
    }

    let (service_label, suffix) = match rest.split_once('.') {
        Some((service, suffix)) => (service, suffix),
        None => ("", rest),
    };
    if suffix != "localhost" {
        return None;
    }

    let service = if service_label.is_empty() {
        DEFAULT_SERVICE.to_string()
    } else {
        decode_service_label(service_label)?
    };

    Some(Vhost {
        pubkey: pubkey.to_string(),
        service,
        site: None,
        onion: None,
        kind: HostKind::Ncc,
    })
}

/// A DNS name a Tor tab may be sent to: dotted labels of letters, digits and hyphens,
/// and a TLD that is not all digits (which rules out IPv4 literals). Onion names have
/// their own vhost, and `.localhost`/`.local` can only be the reader's own network.
pub fn is_clearnet_host(host: &str) -> bool {
    let host = host.trim_end_matches('.');
    if host.is_empty() || host.len() > 253 || !host.contains('.') {
        return false;
    }
    if host.ends_with(".onion") || host.ends_with(".localhost") || host.ends_with(".local") {
        return false;
    }
    let labels: Vec<&str> = host.split('.').collect();
    if labels.last().is_some_and(|tld| tld.bytes().all(|b| b.is_ascii_digit())) {
        return false;
    }
    labels.iter().all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

/// The vhost authority (without listener port) for a clearnet site.
pub fn clearnet_vhost_host(host: &str, port: Option<u16>) -> String {
    match port {
        Some(port) if port != 443 => format!("{host}.p{port}.tor.localhost"),
        _ => format!("{host}.tor.localhost"),
    }
}

/// The host a shell should load for an onion site.
pub fn onion_host(onion: &str) -> String {
    format!("{onion}.localhost")
}

/// The host a shell should load for one service.
pub fn host_for(pubkey: &str, service: &str) -> String {
    match encode_service_label(service) {
        Some(label) => format!("{pubkey}.{label}.localhost"),
        None => format!("{pubkey}.localhost"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NPUB: &str = "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhs2n3v";

    #[test]
    fn maps_two_and_three_label_hosts() {
        assert_eq!(
            parse_vhost(&format!("{NPUB}.web.localhost:47822")),
            Some(Vhost {
                pubkey: NPUB.into(),
                service: "web".into(),
                site: None,
                onion: None,
                kind: HostKind::Ncc
            })
        );
        assert_eq!(
            parse_vhost(&format!("{NPUB}.localhost")),
            Some(Vhost {
                pubkey: NPUB.into(),
                service: "addr".into(),
                site: None,
                onion: None,
                kind: HostKind::Ncc
            })
        );
    }

    #[test]
    fn decodes_service_labels() {
        let host = format!("{NPUB}.x-mexge.localhost");
        assert_eq!(
            parse_vhost(&host).map(|vhost| vhost.service),
            Some("a.b".to_string())
        );
        assert_eq!(host_for(NPUB, "a.b"), host);
        assert_eq!(host_for(NPUB, "addr"), format!("{NPUB}.addr.localhost"));
    }

    #[test]
    fn maps_site_hosts() {
        let named = parse_vhost(&format!("{NPUB}.myblog.nsite.localhost:47822")).expect("named");
        assert_eq!(named.kind, HostKind::Nsite);
        assert_eq!(named.site.as_deref(), Some("myblog"));
        assert_eq!(named.identity_key(), format!("nsite://{NPUB}/myblog"));

        let root = parse_vhost(&format!("{NPUB}.nsite.localhost")).expect("root");
        assert_eq!(root.kind, HostKind::Nsite);
        assert_eq!(root.site, None);
        assert_eq!(root.identity_key(), format!("nsite://{NPUB}"));

        // Hosts are lowercased before parsing, so an uppercase id is fine; a site id
        // still has to follow the desktop's d-tag rules.
        assert!(parse_vhost(&format!("{NPUB}.MyBlog.nsite.localhost")).is_some());
        assert!(parse_vhost(&format!("{NPUB}.trailing-.nsite.localhost")).is_none());
        assert!(parse_vhost("example.nsite.localhost").is_none());
    }

    #[test]
    fn maps_clearnet_hosts() {
        let plain = parse_vhost("example.com.tor.localhost:47822").expect("plain");
        assert_eq!(plain.kind, HostKind::Clearnet);
        assert_eq!(plain.onion.as_deref(), Some("example.com"));
        assert_eq!(plain.identity_key(), "https://example.com");

        let ported = parse_vhost("a.example.com.p8443.tor.localhost").expect("port");
        assert_eq!(ported.onion.as_deref(), Some("a.example.com:8443"));
        assert_eq!(clearnet_vhost_host("a.example.com", Some(8443)), "a.example.com.p8443.tor.localhost");
        assert_eq!(clearnet_vhost_host("example.com", Some(443)), "example.com.tor.localhost");

        for bad in [
            "tor.localhost",
            "localhost.tor.localhost",
            "1.2.3.4.tor.localhost",
            "foo.local.tor.localhost",
            "-a.example.com.tor.localhost",
            "nodots.tor.localhost",
        ] {
            assert!(parse_vhost(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn refuses_foreign_hosts() {
        assert!(parse_vhost("example.com").is_none());
        assert!(parse_vhost("localhost").is_none());
        assert!(parse_vhost("127.0.0.1:47822").is_none());
        assert!(parse_vhost(&format!("{NPUB}.web.example.com")).is_none());
        // A four-label host is not a service address.
        assert!(parse_vhost(&format!("{NPUB}.web.extra.localhost")).is_none());
    }
}
