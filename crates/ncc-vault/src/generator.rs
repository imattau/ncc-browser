//! Password generation, with the desktop's character sets and guarantees.

use rand::seq::SliceRandom;
use rand::Rng;
use serde::{Deserialize, Serialize};

const SYMBOLS: &str = "!@#$%^&*()-_=+[]{};:,.?/";
const DEFAULT_LENGTH: usize = 20;
const AMBIGUOUS: &[char] = &['I', 'l', '1', 'O', '0', 'o'];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GeneratorOptions {
    pub length: Option<usize>,
    pub lowercase: Option<bool>,
    pub uppercase: Option<bool>,
    pub digits: Option<bool>,
    pub symbols: Option<bool>,
    pub avoid_ambiguous: Option<bool>,
}

/// Generate a password with at least one character from every selected class.
pub fn generate_password(options: &GeneratorOptions) -> String {
    let length = options.length.unwrap_or(DEFAULT_LENGTH).clamp(12, 64);
    let avoid_ambiguous = options.avoid_ambiguous.unwrap_or(false);

    let clean = |value: &str| -> String {
        if avoid_ambiguous {
            value.chars().filter(|c| !AMBIGUOUS.contains(c)).collect()
        } else {
            value.to_string()
        }
    };

    let mut sets: Vec<String> = Vec::new();
    if options.lowercase.unwrap_or(true) {
        sets.push(clean("abcdefghijklmnopqrstuvwxyz"));
    }
    if options.uppercase.unwrap_or(true) {
        sets.push(clean("ABCDEFGHIJKLMNOPQRSTUVWXYZ"));
    }
    if options.digits.unwrap_or(true) {
        sets.push(clean("0123456789"));
    }
    if options.symbols.unwrap_or(false) {
        sets.push(clean(SYMBOLS));
    }

    sets.retain(|set| !set.is_empty());
    if sets.is_empty() {
        sets.push(clean("abcdefghijklmnopqrstuvwxyz"));
    }

    let pool: Vec<char> = sets.iter().flat_map(|set| set.chars()).collect();
    let mut random = rand::thread_rng();
    let mut characters: Vec<char> = Vec::with_capacity(length);

    // One from each class first, so the result always satisfies a "must contain"
    // check. The shuffle below removes the ordering this introduces.
    for set in &sets {
        if characters.len() >= length {
            break;
        }
        let class: Vec<char> = set.chars().collect();
        characters.push(class[random.gen_range(0..class.len())]);
    }
    while characters.len() < length {
        characters.push(pool[random.gen_range(0..pool.len())]);
    }

    characters.shuffle(&mut random);
    characters.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> GeneratorOptions {
        GeneratorOptions::default()
    }

    #[test]
    fn defaults_have_every_class_but_symbols() {
        let password = generate_password(&options());
        assert_eq!(password.chars().count(), 20);
        assert!(password.chars().any(|c| c.is_ascii_lowercase()));
        assert!(password.chars().any(|c| c.is_ascii_uppercase()));
        assert!(password.chars().any(|c| c.is_ascii_digit()));
        assert!(!password.chars().any(|c| SYMBOLS.contains(c)));
    }

    #[test]
    fn length_is_clamped_and_classes_are_honoured() {
        let short = GeneratorOptions {
            length: Some(4),
            ..Default::default()
        };
        assert_eq!(generate_password(&short).chars().count(), 12);

        let long = GeneratorOptions {
            length: Some(200),
            symbols: Some(true),
            ..Default::default()
        };
        let password = generate_password(&long);
        assert_eq!(password.chars().count(), 64);
        assert!(password.chars().any(|c| SYMBOLS.contains(c)));
    }

    #[test]
    fn an_impossible_request_still_produces_something_long_enough() {
        let only_symbols = GeneratorOptions {
            length: Some(16),
            lowercase: Some(false),
            uppercase: Some(false),
            digits: Some(false),
            symbols: Some(true),
            ..Default::default()
        };
        let password = generate_password(&only_symbols);
        assert_eq!(password.chars().count(), 16);
        assert!(password.chars().all(|c| SYMBOLS.contains(c)));
    }

    #[test]
    fn ambiguous_characters_can_be_avoided() {
        let options = GeneratorOptions {
            length: Some(64),
            symbols: Some(true),
            avoid_ambiguous: Some(true),
            ..Default::default()
        };
        let password = generate_password(&options);
        assert!(!password.chars().any(|c| AMBIGUOUS.contains(&c)));
    }
}
