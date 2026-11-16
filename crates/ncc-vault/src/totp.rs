//! TOTP, parsed and generated in Rust so the shared secret never reaches a shell's
//! renderer or a page.

use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Sha256, Sha512};
use url::Url;

pub const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Algorithm {
    Sha1,
    Sha256,
    Sha512,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TotpSecret {
    secret: Vec<u8>,
    algorithm: Algorithm,
    digits: u32,
    period: u64,
    pub label: Option<String>,
    pub issuer: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TotpCode {
    pub code: String,
    pub remaining: u64,
    pub period: u64,
}

impl TotpSecret {
    /// Accepts a bare Base32 secret or a full `otpauth://` URI.
    pub fn parse(input: &str) -> Result<Self, String> {
        let value = input.trim();
        if value.is_empty() {
            return Err("TOTP secret is empty".to_string());
        }

        if value.to_ascii_lowercase().starts_with("otpauth://") {
            return Self::from_uri(value);
        }

        Ok(Self {
            secret: decode_base32(value)?,
            algorithm: Algorithm::Sha1,
            digits: 6,
            period: 30,
            label: None,
            issuer: None,
        })
    }

    fn from_uri(value: &str) -> Result<Self, String> {
        let url = Url::parse(value).map_err(|_| "The TOTP URI is not valid".to_string())?;
        if url.scheme() != "otpauth"
            || !url
                .host_str()
                .unwrap_or_default()
                .eq_ignore_ascii_case("totp")
        {
            return Err("Only otpauth://totp URIs are supported".to_string());
        }

        let mut secret = None;
        let mut algorithm = Algorithm::Sha1;
        let mut digits = 6;
        let mut period = 30;

        for (name, value) in url.query_pairs() {
            match name.to_ascii_lowercase().as_str() {
                "secret" => secret = Some(value.to_string()),
                "algorithm" => {
                    algorithm = match value.to_ascii_uppercase().as_str() {
                        "SHA1" => Algorithm::Sha1,
                        "SHA256" => Algorithm::Sha256,
                        "SHA512" => Algorithm::Sha512,
                        other => return Err(format!("Unsupported TOTP algorithm {other}")),
                    }
                }
                "digits" => {
                    digits = value
                        .parse::<u32>()
                        .ok()
                        .filter(|digits| (6..=10).contains(digits))
                        .ok_or_else(|| "TOTP digits must be between 6 and 10".to_string())?;
                }
                "period" => {
                    period = value
                        .parse::<u64>()
                        .ok()
                        .filter(|period| (1..=3600).contains(period))
                        .ok_or_else(|| "TOTP period must be between 1 and 3600".to_string())?;
                }
                _ => {}
            }
        }

        let secret = secret.ok_or_else(|| "The TOTP URI has no secret".to_string())?;
        let label = url
            .path()
            .trim_start_matches('/')
            .split(':')
            .next_back()
            .filter(|label| !label.is_empty())
            .map(|label| label.replace("%20", " "));

        Ok(Self {
            secret: decode_base32(&secret)?,
            algorithm,
            digits,
            period,
            label,
            issuer: url
                .query_pairs()
                .find(|(name, _)| name.eq_ignore_ascii_case("issuer"))
                .map(|(_, value)| value.into_owned()),
        })
    }

    pub fn code(&self, now_ms: u64) -> TotpCode {
        let seconds = now_ms / 1000;
        let counter = seconds / self.period;
        let remaining = self.period - (seconds % self.period);

        let mut message = [0u8; 8];
        message.copy_from_slice(&counter.to_be_bytes());

        let digest = match self.algorithm {
            Algorithm::Sha1 => {
                let mut mac =
                    Hmac::<Sha1>::new_from_slice(&self.secret).expect("hmac accepts any key");
                mac.update(&message);
                mac.finalize().into_bytes().to_vec()
            }
            Algorithm::Sha256 => {
                let mut mac =
                    Hmac::<Sha256>::new_from_slice(&self.secret).expect("hmac accepts any key");
                mac.update(&message);
                mac.finalize().into_bytes().to_vec()
            }
            Algorithm::Sha512 => {
                let mut mac =
                    Hmac::<Sha512>::new_from_slice(&self.secret).expect("hmac accepts any key");
                mac.update(&message);
                mac.finalize().into_bytes().to_vec()
            }
        };

        let offset = (digest[digest.len() - 1] & 0x0f) as usize;
        let binary = ((digest[offset] & 0x7f) as u32) << 24
            | (digest[offset + 1] as u32) << 16
            | (digest[offset + 2] as u32) << 8
            | digest[offset + 3] as u32;
        let modulus = 10u32.pow(self.digits);
        let code = format!("{:0width$}", binary % modulus, width = self.digits as usize);

        TotpCode {
            code,
            remaining,
            period: self.period,
        }
    }
}

/// Decode RFC 4648 Base32, tolerating spaces, dashes and padding.
pub fn decode_base32(input: &str) -> Result<Vec<u8>, String> {
    let cleaned: Vec<u8> = input
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace() && *byte != b'-' && *byte != b'=')
        .map(|byte| byte.to_ascii_uppercase())
        .collect();

    if cleaned.is_empty() {
        return Err("TOTP secret is empty".to_string());
    }

    let mut bits = 0u32;
    let mut value = 0u32;
    let mut bytes = Vec::with_capacity(cleaned.len() * 5 / 8);

    for character in cleaned {
        let index = BASE32
            .iter()
            .position(|candidate| *candidate == character)
            .ok_or_else(|| "TOTP secret is not valid Base32".to_string())?;
        value = (value << 5) | index as u32;
        bits += 5;
        if bits >= 8 {
            bytes.push((value >> (bits - 8)) as u8);
            bits -= 8;
        }
    }

    if bytes.is_empty() {
        return Err("TOTP secret is too short".to_string());
    }

    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_ignores_the_shape_of_the_text() {
        assert_eq!(decode_base32("JBSWY3DP").unwrap(), b"Hello".to_vec());
        assert_eq!(decode_base32("jbsw y3dp").unwrap(), b"Hello".to_vec());
        assert!(decode_base32("0189").is_err());
    }

    #[test]
    fn rfc_6238_vectors_match_with_eight_digits() {
        // "12345678901234567890" in Base32.
        let secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        let at = |seconds: u64| {
            let mut parsed = TotpSecret::parse(secret).unwrap();
            parsed.digits = 8;
            parsed.code(seconds * 1000).code
        };
        assert_eq!(at(59), "94287082");
        assert_eq!(at(1111111109), "07081804");
        assert_eq!(at(1111111111), "14050471");
    }

    #[test]
    fn a_uri_sets_algorithm_digits_and_period() {
        let parsed = TotpSecret::parse(
            "otpauth://totp/ACME%20Co:alice@example.com?secret=JBSWY3DP&issuer=ACME%20Co&digits=8&period=60&algorithm=SHA256",
        )
        .unwrap();
        assert_eq!(parsed.label.as_deref(), Some("alice@example.com"));
        assert_eq!(parsed.issuer.as_deref(), Some("ACME Co"));
        assert_eq!(parsed.digits, 8);
        assert_eq!(parsed.period, 60);
        assert_eq!(parsed.algorithm, Algorithm::Sha256);

        let code = parsed.code(0);
        assert_eq!(code.code.len(), 8);
        assert_eq!(code.period, 60);
        assert!(code.remaining <= 60 && code.remaining >= 1);
    }

    #[test]
    fn unsupported_shapes_are_refused() {
        assert!(TotpSecret::parse("").is_err());
        assert!(TotpSecret::parse("not base32!").is_err());
        assert!(TotpSecret::parse("otpauth://hotp/x?secret=JBSWY3DP").is_err());
        assert!(TotpSecret::parse("otpauth://totp/x?secret=JBSWY3DP&digits=3").is_err());
    }
}
