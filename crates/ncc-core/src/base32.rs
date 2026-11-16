//! Lowercase RFC 4648 base32 without padding.
//!
//! Service ids that cannot be a hostname label are folded into one DNS-safe label
//! (`x-<base32>`). The label is part of the origin, so the encoding has to be
//! reversible, deterministic and identical on every platform forever.

const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

pub fn encode(input: &str) -> String {
    let mut bits: u32 = 0;
    let mut value: u32 = 0;
    let mut out = String::with_capacity(input.len().div_ceil(5) * 8);

    for &byte in input.as_bytes() {
        value = (value << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            out.push(char::from(ALPHABET[((value >> (bits - 5)) & 31) as usize]));
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(char::from(ALPHABET[((value << (5 - bits)) & 31) as usize]));
    }
    out
}

/// Decode a label, or `None` when it is not canonical base32 or not valid UTF-8.
pub fn decode(input: &str) -> Option<String> {
    let mut bits: u32 = 0;
    let mut value: u32 = 0;
    let mut bytes: Vec<u8> = Vec::with_capacity(input.len() * 5 / 8);

    for character in input.chars() {
        let index = ALPHABET
            .iter()
            .position(|candidate| char::from(*candidate) == character.to_ascii_lowercase())?;
        value = (value << 5) | index as u32;
        bits += 5;
        if bits >= 8 {
            bytes.push((value >> (bits - 8)) as u8);
            bits -= 8;
        }
    }
    // Leftover bits must be zero padding; anything else is a corrupted label.
    if bits > 0 && (value & ((1 << bits) - 1)) != 0 {
        return None;
    }
    String::from_utf8(bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::{decode, encode};

    #[test]
    fn round_trips_arbitrary_service_ids() {
        for service in ["a.b", "a~b", "UPPER", "x-abc", "my.service-1", "ünïcode"] {
            let label = encode(service);
            assert_eq!(decode(&label).as_deref(), Some(service), "label {label}");
        }
    }

    // Values produced by `src/shared/base32.ts`, which is the reference encoder.
    #[test]
    fn encodes_deterministically() {
        assert_eq!(encode("a.b"), "mexge");
        assert_eq!(encode("x-abc"), "pawwcytd");
        assert_eq!(encode("secure"), "onswg5lsmu");
    }

    #[test]
    fn rejects_non_alphabet_and_bad_padding() {
        assert!(decode("meqw1").is_none(), "1 is not in the alphabet");
        assert!(decode("meqwx").is_none(), "trailing bits must be zero");
        assert!(decode("").is_some());
    }
}
