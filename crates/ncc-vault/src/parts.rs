//! Vaults stored as several encrypted events ("parts"). See
//! `docs/password-vault-sharding.md`. The rest of the app sees one merged vault.
//!
//! `src/shared/password-parts.ts` must agree; both run
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

#[derive(Debug, Clone)]
pub struct VaultPlan {
    /// The layout with new homes added. Nothing saved is removed from it.
    pub layout: VaultLayout,
    /// What each part should hold, with every home filled.
    pub parts: BTreeMap<usize, PasswordVault>,
    /// Entries that must leave a part to keep it within the limit. Each may be removed
    /// only once another of its homes is confirmed saved.
    pub leaving: BTreeMap<usize, BTreeSet<String>>,
    /// True when some part cannot be brought within the limit.
    pub full: bool,
}

type Held = BTreeMap<usize, BTreeMap<String, PasswordEntry>>;

fn size_of<'a>(
    entries: impl IntoIterator<Item = &'a PasswordEntry>,
    extra: Option<&PasswordEntry>,
) -> usize {
    let mut all: Vec<PasswordEntry> = entries.into_iter().cloned().collect();
    all.extend(extra.cloned());
    vault_byte_length(&part_vault(all))
}

/// A part with room for the entry, creating one if allowed.
fn room_for(
    entry: &PasswordEntry,
    not: Option<usize>,
    homes: &mut VaultLayout,
    held: &mut Held,
    upcoming: &mut usize,
) -> Option<usize> {
    let sizes: Vec<(usize, usize)> = held
        .iter()
        .filter(|(index, _)| Some(**index) != not)
        .map(|(index, entries)| (*index, size_of(entries.values(), Some(entry))))
        .collect();
    let found = [VAULT_PART_TARGET_BYTES, MAX_VAULT_BYTES]
        .iter()
        .find_map(|limit| sizes.iter().find(|(_, size)| size <= limit));
    if let Some((index, _)) = found {
        return Some(*index);
    }
    if *upcoming >= MAX_VAULT_PARTS || size_of([entry], None) > MAX_VAULT_BYTES {
        return None;
    }
    let index = *upcoming;
    *upcoming += 1;
    homes.insert(index, BTreeSet::new());
    held.insert(index, BTreeMap::new());
    Some(index)
}

fn put(index: usize, entry: PasswordEntry, homes: &mut VaultLayout, held: &mut Held) {
    homes.entry(index).or_default().insert(entry.id.clone());
    held.entry(index)
        .or_default()
        .insert(entry.id.clone(), entry);
}

/// Place the vault, adding parts and second homes where the size limit needs them.
/// `saved` is the last known copy of each part: only growth beyond it is limited.
/// `next_part` is the index a new part would take, or `None` when none may be created.
pub fn plan_vault(
    vault: &PasswordVault,
    layout: &VaultLayout,
    saved: &BTreeMap<usize, PasswordVault>,
    next_part: Option<usize>,
) -> VaultPlan {
    let mut homes = layout.clone();
    // With nothing loaded and nothing known, this is a new vault.
    if homes.is_empty() {
        homes.insert(0, BTreeSet::new());
    }
    let after_highest = homes.keys().next_back().map_or(0, |highest| highest + 1);
    let mut upcoming = next_part.map_or(MAX_VAULT_PARTS, |next| next.max(after_highest));

    let mut held: Held = homes.keys().map(|index| (*index, BTreeMap::new())).collect();
    let mut fresh = Vec::new();
    for entry in &vault.entries {
        let mut placed = false;
        for (index, ids) in &homes {
            if ids.contains(&entry.id) {
                held.entry(*index)
                    .or_default()
                    .insert(entry.id.clone(), entry.clone());
                placed = true;
            }
        }
        if !placed {
            fresh.push(entry.clone());
        }
    }

    fresh.sort_by(by_age);
    for entry in fresh {
        let index = room_for(&entry, None, &mut homes, &mut held, &mut upcoming)
            .or_else(|| held.keys().next().copied())
            .unwrap_or_default();
        put(index, entry, &mut homes, &mut held);
    }

    let mut leaving: BTreeMap<usize, BTreeSet<String>> = BTreeMap::new();
    let mut full = false;
    let indexes: Vec<usize> = held.keys().copied().collect();
    for index in indexes {
        let before = saved.get(&index);
        let mut staying = held.get(&index).cloned().unwrap_or_default();
        let fits = |staying: &BTreeMap<String, PasswordEntry>| {
            is_part_change_allowed(before, &part_vault(staying.values().cloned().collect()))
        };
        if fits(&staying) {
            continue;
        }

        let old: BTreeMap<&str, &PasswordEntry> = before
            .into_iter()
            .flat_map(|part| part.entries.iter())
            .map(|entry| (entry.id.as_str(), entry))
            .collect();
        let growth = |entry: &PasswordEntry| {
            let previous = old
                .get(entry.id.as_str())
                .map_or(0, |previous| size_of([*previous], None) as i64);
            size_of([entry], None) as i64 - previous
        };
        // Entries this part has never saved go first: they can move without waiting.
        let mut growers: Vec<(bool, i64, PasswordEntry)> = staying
            .values()
            .map(|entry| {
                (
                    old.contains_key(entry.id.as_str()),
                    growth(entry),
                    entry.clone(),
                )
            })
            .filter(|(known, grown, _)| !known || *grown > 0)
            .collect();
        growers.sort_by(|a, b| {
            a.0.cmp(&b.0)
                .then_with(|| b.1.cmp(&a.1))
                .then_with(|| a.2.id.cmp(&b.2.id))
        });
        for (known, _, entry) in growers {
            if fits(&staying) {
                break;
            }
            let elsewhere = homes
                .iter()
                .any(|(other, ids)| *other != index && ids.contains(&entry.id));
            if !elsewhere {
                let Some(target) = room_for(
                    &entry,
                    Some(index),
                    &mut homes,
                    &mut held,
                    &mut upcoming,
                ) else {
                    continue;
                };
                put(target, entry.clone(), &mut homes, &mut held);
            }
            staying.remove(&entry.id);
            if known {
                leaving.entry(index).or_default().insert(entry.id);
            } else {
                if let Some(ids) = homes.get_mut(&index) {
                    ids.remove(&entry.id);
                }
                if let Some(entries) = held.get_mut(&index) {
                    entries.remove(&entry.id);
                }
            }
        }
        full |= !fits(&staying);
    }

    VaultPlan {
        layout: homes,
        parts: held
            .into_iter()
            .map(|(index, entries)| (index, part_vault(entries.into_values().collect())))
            .collect(),
        leaving,
        full,
    }
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

/// A part holding these entries, in the order both platforms write them.
pub fn part_vault(mut entries: Vec<PasswordEntry>) -> PasswordVault {
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

    fn vectors() -> Value {
        serde_json::from_str(include_str!(
            "../../../test/fixtures/password-parts-vectors.json"
        ))
        .unwrap()
    }

    fn id(n: &Value) -> String {
        format!("{:016x}", n.as_u64().unwrap())
    }

    fn build(specs: &Value) -> PasswordVault {
        let specs = specs.as_array().unwrap();
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
        vault
    }

    fn layout_of(value: &Value) -> VaultLayout {
        value
            .as_object()
            .unwrap()
            .iter()
            .map(|(index, ids)| {
                let ids = ids.as_array().unwrap().iter().map(id).collect();
                (index.parse().unwrap(), ids)
            })
            .collect()
    }

    fn numbers<'a>(ids: impl IntoIterator<Item = &'a String>) -> Value {
        json!(ids
            .into_iter()
            .map(|id| u64::from_str_radix(id, 16).unwrap())
            .collect::<Vec<_>>())
    }

    fn placed(parts: &BTreeMap<usize, PasswordVault>) -> Value {
        Value::Object(
            parts
                .iter()
                .map(|(index, part)| {
                    let ids = numbers(part.entries.iter().map(|entry| &entry.id));
                    (index.to_string(), ids)
                })
                .collect(),
        )
    }

    #[test]
    fn split_matches_the_desktop() {
        for case in vectors()["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let parts = split_vault(&build(&case["entries"]), &layout_of(&case["layout"]));
            assert_eq!(placed(&parts), case["expected"], "{name}");
            let sizes: serde_json::Map<String, Value> = parts
                .iter()
                .map(|(index, part)| (index.to_string(), json!(vault_byte_length(part))))
                .collect();
            assert_eq!(Value::Object(sizes), case["bytes"], "{name}");
        }
    }

    #[test]
    fn planning_matches_the_desktop() {
        for case in vectors()["plans"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let saved = case["saved"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(index, specs)| (index.parse().unwrap(), build(specs)))
                .collect();
            let plan = plan_vault(
                &build(&case["entries"]),
                &layout_of(&case["layout"]),
                &saved,
                case["next"].as_u64().map(|next| next as usize),
            );
            assert_eq!(placed(&plan.parts), case["expected"], "{name}");
            let leaving: serde_json::Map<String, Value> = plan
                .leaving
                .iter()
                .map(|(index, ids)| (index.to_string(), numbers(ids)))
                .collect();
            assert_eq!(Value::Object(leaving), case["leaving"], "{name}");
            assert_eq!(Value::Bool(plan.full), case["full"], "{name}");
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
