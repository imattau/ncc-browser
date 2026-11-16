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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Vhost {
    pub pubkey: String,
    /// NCC service id; empty for a site.
    pub service: String,
    /// NIP-5A site id; `None` for the root site and for NCC hosts.
    pub site: Option<String>,
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
        kind: HostKind::Ncc,
    })
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
                kind: HostKind::Ncc
            })
        );
        assert_eq!(
            parse_vhost(&format!("{NPUB}.localhost")),
            Some(Vhost {
                pubkey: NPUB.into(),
                service: "addr".into(),
                site: None,
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
    fn refuses_foreign_hosts() {
        assert!(parse_vhost("example.com").is_none());
        assert!(parse_vhost("localhost").is_none());
        assert!(parse_vhost("127.0.0.1:47822").is_none());
        assert!(parse_vhost(&format!("{NPUB}.web.example.com")).is_none());
        // A four-label host is not a service address.
        assert!(parse_vhost(&format!("{NPUB}.web.extra.localhost")).is_none());
    }
}
