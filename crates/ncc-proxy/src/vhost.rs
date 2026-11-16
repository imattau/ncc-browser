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

use ncc_core::{decode_service_label, encode_service_label, is_nostr_id, DEFAULT_SERVICE};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Vhost {
    pub pubkey: String,
    pub service: String,
}

pub fn parse_vhost(host: &str) -> Option<Vhost> {
    let host = host
        .split(':')
        .next()
        .unwrap_or(host)
        .trim_end_matches('.')
        .to_ascii_lowercase();

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
                service: "web".into()
            })
        );
        assert_eq!(
            parse_vhost(&format!("{NPUB}.localhost")),
            Some(Vhost {
                pubkey: NPUB.into(),
                service: "addr".into()
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
    fn refuses_foreign_hosts() {
        assert!(parse_vhost("example.com").is_none());
        assert!(parse_vhost("localhost").is_none());
        assert!(parse_vhost("127.0.0.1:47822").is_none());
        assert!(parse_vhost(&format!("{NPUB}.web.example.com")).is_none());
        // A four-label host is not a service address.
        assert!(parse_vhost(&format!("{NPUB}.web.extra.localhost")).is_none());
    }
}
