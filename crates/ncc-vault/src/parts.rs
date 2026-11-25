//! Vaults stored as several encrypted events ("parts"). See
//! `docs/password-vault-sharding.md`. The rest of the app sees one merged vault.
//!
//! This build reads every part and keeps existing ones up to date. It never creates
//! one. `src/shared/password-parts.ts` must agree; both run
//! `test/fixtures/password-parts-vectors.json`.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::{
    is_vault_change_allowed, vault_byte_length, PasswordEntry, PasswordVault, MAX_VAULT_BYTES,
    VAULT_D, VAULT_VERSION,
};

pub const MAX_VAULT_PARTS: usize = 16;
/// New entries prefer a part with this much room left to grow.
pub const VAULT_PART_TARGET_BYTES: usize = 32_000;
pub const VAULT_INCOMPLETE: &str = "Some passwords haven’t synced yet";

/// Which entry ids each loaded part holds. A part that is not loaded has no key.
pub type VaultLayout = BTreeMap<usize, BTreeSet<String>>;

pub fn vault_part_d(index: usize) -> String {
    if index == 0 {
        VAULT_D.to_string()
    } else {
        format!("{VAULT_D}/{index}")
    }
}

/// The part a `d` tag names, or `None` when it is not a vault part.
pub fn vault_part_index(d: &str) -> Option<usize> {
    (0..MAX_VAULT_PARTS).find(|index| vault_part_d(*index) == d)
}

/// How many parts the writer of a decrypted payload knew about.
pub fn declared_parts(payload: &Value) -> usize {
    payload
        .get("parts")
        .and_then(Value::as_u64)
        .map(|parts| parts.min(MAX_VAULT_PARTS as u64) as usize)
        .unwrap_or_default()
}

/// True when a part that is known to exist has not been loaded.
pub fn is_vault_incomplete(layout: &VaultLayout, declared: usize) -> bool {
    let Some(highest) = layout.keys().next_back() else {
        return false;
    };
    (0..declared.max(highest + 1)).any(|index| !layout.contains_key(&index))
}

/// Divide the merged vault between the loaded parts. An entry stays in every part that
/// already holds it, so no copy keeps an old password. A new entry joins one loaded
/// part. An entry the vault lacks is left out here but stays in the layout.
pub fn split_vault(vault: &PasswordVault, layout: &VaultLayout) -> BTreeMap<usize, PasswordVault> {
    let mut held: BTreeMap<usize, Vec<PasswordEntry>> =
        layout.keys().map(|index| (*index, Vec::new())).collect();
    // With nothing loaded and nothing known, this is a new vault.
    if held.is_empty() {
        held.insert(0, Vec::new());
    }

    let mut fresh = Vec::new();
    for entry in &vault.entries {
        let mut placed = false;
        for (index, entries) in held.iter_mut() {
            if layout.get(index).is_some_and(|ids| ids.contains(&entry.id)) {
                entries.push(entry.clone());
                placed = true;
            }
        }
        if !placed {
            fresh.push(entry.clone());
        }
    }

    fresh.sort_by(by_age);
    for entry in fresh {
        let sizes: Vec<(usize, usize)> = held
            .iter()
            .map(|(index, entries)| {
                let mut with = entries.clone();
                with.push(entry.clone());
                (*index, vault_byte_length(&part_vault(with)))
            })
            .collect();
        let index = [VAULT_PART_TARGET_BYTES, MAX_VAULT_BYTES]
            .iter()
            .find_map(|limit| sizes.iter().find(|(_, size)| size <= limit))
            .unwrap_or(&sizes[0])
            .0;
        held.entry(index).or_default().push(entry);
    }

    held.into_iter()
        .map(|(index, entries)| (index, part_vault(entries)))
        .collect()
}

/// The payload that is encrypted. A single-part vault is exactly the old format.
pub fn part_payload(part: &PasswordVault, count: usize) -> Result<Value, serde_json::Error> {
    let mut payload = serde_json::to_value(part)?;
    if count > 1 {
        payload["parts"] = count.into();
    }
    Ok(payload)
}

/// The size limit applies to each part, not to the vault as a whole.
pub fn is_part_change_allowed(before: Option<&PasswordVault>, after: &PasswordVault) -> bool {
    match before {
        Some(before) => is_vault_change_allowed(before, after),
        None => is_vault_change_allowed(&PasswordVault::default(), after),
    }
}

fn by_age(a: &PasswordEntry, b: &PasswordEntry) -> std::cmp::Ordering {
    a.created_at
        .cmp(&b.created_at)
        .then_with(|| a.id.cmp(&b.id))
}

fn part_vault(mut entries: Vec<PasswordEntry>) -> PasswordVault {
    entries.sort_by(by_age);
    PasswordVault {
        v: VAULT_VERSION,
        updated_at: entries
            .iter()
            .map(|entry| entry.updated_at)
            .max()
            .unwrap_or_default(),
        entries,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize_vault;
    use serde_json::json;

    #[test]
    fn split_matches_the_desktop() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/password-parts-vectors.json"
        ))
        .unwrap();
        let id = |n: &Value| format!("{:016x}", n.as_u64().unwrap());
        for case in vectors["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let specs = case["entries"].as_array().unwrap();
            let entries: Vec<Value> = specs
                .iter()
                .map(|spec| {
                    json!({
                        "id": id(&spec["n"]), "origin": "https://example.com",
                        "title": "Example", "username": "alice", "password": "secret",
                        "notes": "", "totp": "", "createdAt": spec["n"], "updatedAt": spec["n"],
                        "deleted": spec["deleted"], "favorite": spec["favorite"],
                    })
                })
                .collect();
            let mut vault = normalize_vault(&json!({ "entries": entries }));
            // Set after normalising, which clamps notes below what these cases need.
            for (entry, spec) in vault.entries.iter_mut().zip(specs) {
                if !entry.deleted {
                    entry.notes = "x".repeat(spec["notes"].as_u64().unwrap() as usize);
                }
            }
            let layout: VaultLayout = case["layout"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(index, ids)| {
                    let ids = ids.as_array().unwrap().iter().map(id).collect();
                    (index.parse().unwrap(), ids)
                })
                .collect();

            let parts = split_vault(&vault, &layout);
            let placed: serde_json::Map<String, Value> = parts
                .iter()
                .map(|(index, part)| {
                    let ids: Vec<u64> = part
                        .entries
                        .iter()
                        .map(|entry| u64::from_str_radix(&entry.id, 16).unwrap())
                        .collect();
                    (index.to_string(), json!(ids))
                })
                .collect();
            assert_eq!(Value::Object(placed), case["expected"], "{name}");
            let sizes: serde_json::Map<String, Value> = parts
                .iter()
                .map(|(index, part)| (index.to_string(), json!(vault_byte_length(part))))
                .collect();
            assert_eq!(Value::Object(sizes), case["bytes"], "{name}");
        }
    }

    #[test]
    fn only_exact_part_tags_count() {
        assert_eq!(vault_part_index(&vault_part_d(0)), Some(0));
        assert_eq!(vault_part_index(&vault_part_d(15)), Some(15));
        for d in ["/0", "/16", "/01"] {
            assert_eq!(vault_part_index(&format!("{VAULT_D}{d}")), None);
        }
    }
}
