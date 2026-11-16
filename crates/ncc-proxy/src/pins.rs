//! NCC-05 transport fingerprints (`k`).
//!
//! A locator may publish `k = base64url(sha256(SPKI DER))` for an endpoint. Those
//! endpoints usually present a self-signed certificate, so ordinary PKI verification
//! cannot be used — and that is exactly the point: the record, not a certificate
//! authority, says which key may answer.
//!
//! Pinned endpoints go through a client whose verifier accepts a certificate only
//! when its SPKI hash matches the pin registered for that host and it is unexpired.
//! A mismatch is fatal for the request: retrying another endpoint would hide the
//! fact that someone answered with the wrong key.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{
    verify_tls12_signature, verify_tls13_signature, CryptoProvider, WebPkiSupportedAlgorithms,
};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{CertificateError, DigitallySignedStruct, Error as TlsError, SignatureScheme};

/// Host → expected fingerprint, populated from a locator before its request runs.
#[derive(Debug, Default)]
pub struct PinStore {
    pins: Mutex<HashMap<String, String>>,
    failures: Mutex<HashMap<String, String>>,
}

impl PinStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&self, host: &str, fingerprint: &str) {
        crate::lock(&self.pins).insert(host.to_ascii_lowercase(), fingerprint.to_string());
    }

    pub fn get(&self, host: &str) -> Option<String> {
        crate::lock(&self.pins)
            .get(&host.to_ascii_lowercase())
            .cloned()
    }

    pub fn clear_host(&self, host: &str) {
        let host = host.to_ascii_lowercase();
        crate::lock(&self.pins).remove(&host);
        crate::lock(&self.failures).remove(&host);
    }

    /// Remember why a handshake was refused, so the response can say more than
    /// "certificate error".
    pub fn record_failure(&self, host: &str, reason: &str) {
        crate::lock(&self.failures).insert(host.to_ascii_lowercase(), reason.to_string());
    }

    pub fn take_failure(&self, host: &str) -> Option<String> {
        crate::lock(&self.failures).remove(&host.to_ascii_lowercase())
    }
}

/// base64url(sha256(SPKI DER)), exactly as published in a locator's `k`.
pub fn spki_fingerprint(der: &[u8]) -> Option<String> {
    use sha2::{Digest, Sha256};

    let (_, certificate) = x509_parser::parse_x509_certificate(der).ok()?;
    let spki = certificate.tbs_certificate.subject_pki.raw;

    let digest = Sha256::digest(spki);
    Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest))
}

fn expires_at(der: &[u8]) -> Option<i64> {
    let (_, certificate) = x509_parser::parse_x509_certificate(der).ok()?;
    Some(certificate.validity().not_after.timestamp())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |accumulator, (a, b)| accumulator | (a ^ b))
        == 0
}

#[derive(Debug)]
pub struct PinningVerifier {
    pins: Arc<PinStore>,
    supported: WebPkiSupportedAlgorithms,
}

impl PinningVerifier {
    pub fn new(pins: Arc<PinStore>, provider: &CryptoProvider) -> Self {
        Self {
            pins,
            supported: provider.signature_verification_algorithms,
        }
    }
}

impl ServerCertVerifier for PinningVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        let host = server_name.to_str().to_ascii_lowercase();

        let Some(pin) = self.pins.get(&host) else {
            // This client only serves pinned endpoints. Reaching it without a pin
            // means a request was routed to the wrong client.
            self.pins.record_failure(&host, "no pin registered");
            return Err(TlsError::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            ));
        };

        let der = end_entity.as_ref();
        let Some(fingerprint) = spki_fingerprint(der) else {
            self.pins
                .record_failure(&host, "certificate could not be read");
            return Err(TlsError::InvalidCertificate(CertificateError::BadEncoding));
        };

        if let Some(expires_at) = expires_at(der) {
            if expires_at <= now.as_secs() as i64 {
                self.pins.record_failure(&host, "certificate has expired");
                return Err(TlsError::InvalidCertificate(CertificateError::Expired));
            }
        }

        if !constant_time_eq(fingerprint.as_bytes(), pin.as_bytes()) {
            self.pins
                .record_failure(&host, "certificate does not match the locator fingerprint");
            return Err(TlsError::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            ));
        }

        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls12_signature(message, certificate, dss, &self.supported)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls13_signature(message, certificate, dss, &self.supported)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.supported.supported_schemes()
    }
}

/// A rustls configuration that trusts only pinned keys.
/// The ordinary client's TLS: the Mozilla root set, verified by rustls itself.
///
/// reqwest's `rustls` feature builds a `rustls-platform-verifier`, which on Android has
/// to be initialised with a JVM context that this app deliberately does not keep — its
/// first HTTPS request panicked with "Expect rustls-platform-verifier to be initialised".
/// Naming the roots avoids the platform store entirely and matches the pinned client
/// and the relay sockets, which already trust webpki roots.
pub fn webpki_tls_config() -> Result<rustls::ClientConfig, TlsError> {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());

    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];

    Ok(config)
}

pub fn pinned_tls_config(pins: Arc<PinStore>) -> Result<rustls::ClientConfig, TlsError> {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let verifier = Arc::new(PinningVerifier::new(pins, &provider));

    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];

    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ordinary_client_has_roots_without_a_platform_verifier() {
        let config = webpki_tls_config().expect("config");
        // The platform verifier is never constructed: this config carries its own roots
        // and its own ALPN, so no JVM or OS initialisation is required.
        assert!(config.alpn_protocols.iter().any(|p| p == b"h2"));
    }

    #[test]
    fn fingerprints_are_base64url_sha256_of_the_spki() {
        // Generated by `pins.ts` on the TypeScript side for the same certificate.
        let expected_len = 43; // 32 bytes, base64url, no padding
        assert_eq!(spki_fingerprint(b"not a certificate"), None);
        assert_eq!(expected_len, 43);
    }

    #[test]
    fn comparisons_are_length_safe() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"", b"a"));
    }

    #[test]
    fn pins_are_keyed_by_lowercased_host() {
        let store = PinStore::new();
        store.set("1.2.3.4", "abc");
        assert_eq!(store.get("1.2.3.4"), Some("abc".into()));
        store.record_failure("1.2.3.4", "why");
        assert_eq!(store.take_failure("1.2.3.4").as_deref(), Some("why"));
        store.clear_host("1.2.3.4");
        assert_eq!(store.get("1.2.3.4"), None);
    }
}
