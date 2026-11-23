use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::{Component, Path};

const REPO: &str = "imattau/ncc-browser";
const PUBLIC_KEY: &str = "zGBJNgZh40T4WxQt62ZBV5qbnNNRNKRei3/cUnYKkyQ=";
const MAX_FILE_SIZE: usize = 20 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFile {
    path: String,
    sha256: String,
    asset: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: String,
    release_tag: String,
    files: Vec<ManifestFile>,
    signature: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
}

fn validate(manifest: &Manifest, tag: &str) -> Result<(), String> {
    if !valid_version(&manifest.version)
        || manifest.release_tag != tag
        || manifest.files.is_empty()
        || manifest.files.len() > 500
    {
        return Err("Invalid nccsearch update manifest".into());
    }
    for file in &manifest.files {
        let path = Path::new(&file.path);
        if path.is_absolute()
            || path
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
            || !file.path.is_ascii()
            || !file
                .sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            || file.sha256.len() != 64
            || !file.asset.starts_with("nccsearch-file-")
            || !file
                .asset
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            return Err("Invalid nccsearch update file entry".into());
        }
    }
    let mut files = manifest.files.clone();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let mut payload = format!("{}\n{}", manifest.version, manifest.release_tag);
    for file in files {
        payload.push_str(&format!("\n{}\t{}", file.path, file.sha256));
    }
    let key_bytes = base64::engine::general_purpose::STANDARD
        .decode(PUBLIC_KEY)
        .map_err(|e| e.to_string())?;
    let key: [u8; 32] = key_bytes
        .try_into()
        .map_err(|_| "Invalid pinned nccsearch key")?;
    let key = VerifyingKey::from_bytes(&key).map_err(|e| e.to_string())?;
    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(&manifest.signature)
        .map_err(|e| e.to_string())?;
    let signature = Signature::from_slice(&sig_bytes).map_err(|e| e.to_string())?;
    key.verify(payload.as_bytes(), &signature)
        .map_err(|_| "nccsearch manifest signature is invalid".into())
}

fn valid_version(version: &str) -> bool {
    version.len() >= 7
        && version.len() <= 40
        && version
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

async fn latest() -> Result<(Manifest, String), String> {
    let client = crate::with_webpki_roots(reqwest::Client::builder())
        .user_agent("ncc-browser-nccsearch-updater")
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(format!(
            "https://api.github.com/repos/{REPO}/releases/latest"
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let release: Release =
        serde_json::from_slice(&response.bytes().await.map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if !release.tag_name.starts_with('v')
        || !release.tag_name[1..]
            .chars()
            .all(|c| c.is_ascii_digit() || c == '.' || c == '-')
    {
        return Err("Invalid nccsearch release tag".into());
    }
    let response = client
        .get(format!(
            "https://github.com/{REPO}/releases/download/{}/nccsearch-manifest.json",
            release.tag_name
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let manifest: Manifest =
        serde_json::from_slice(&response.bytes().await.map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    validate(&manifest, &release.tag_name)?;
    Ok((manifest, release.tag_name))
}

pub async fn check(data_dir: &Path, packaged_dir: &Path) -> Result<Option<String>, String> {
    let (manifest, _) = latest().await?;
    let current = std::fs::read_to_string(data_dir.join("nccsearch-updates/active-version"))
        .ok()
        .map(|version| version.trim().to_owned())
        .filter(|version| {
            valid_version(version)
                && data_dir
                    .join("nccsearch-updates")
                    .join(version)
                    .join("index.html")
                    .is_file()
        })
        .or_else(|| {
            std::fs::read_to_string(packaged_dir.join("version.txt"))
                .ok()
                .map(|version| version.trim().to_owned())
        })
        .unwrap_or_else(|| "bundled".into());
    Ok((current != manifest.version).then_some(manifest.version))
}

pub async fn install(data_dir: &Path, version: &str) -> Result<(), String> {
    if !valid_version(version) {
        return Err("Invalid nccsearch version".into());
    }
    let (manifest, tag) = latest().await?;
    if manifest.version != version {
        return Err("The available update changed. Check again.".into());
    }
    let client = crate::with_webpki_roots(reqwest::Client::builder())
        .user_agent("ncc-browser-nccsearch-updater")
        .build()
        .map_err(|e| e.to_string())?;
    let root = data_dir.join("nccsearch-updates");
    let staging = root.join(format!("{version}.staging"));
    let target = root.join(&version);
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let result = async {
        for file in &manifest.files {
            let response = client
                .get(format!(
                    "https://github.com/{REPO}/releases/download/{tag}/{}",
                    file.asset
                ))
                .send()
                .await
                .map_err(|e| e.to_string())?
                .error_for_status()
                .map_err(|e| e.to_string())?;
            let bytes = response.bytes().await.map_err(|e| e.to_string())?;
            if bytes.len() > MAX_FILE_SIZE || format!("{:x}", Sha256::digest(&bytes)) != file.sha256
            {
                return Err("nccsearch update file failed integrity verification".to_string());
            }
            let output = staging.join(&file.path);
            if !output.starts_with(&staging) {
                return Err("Invalid nccsearch update path".into());
            }
            if let Some(parent) = output.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(output, bytes).map_err(|e| e.to_string())?;
        }
        if !staging.join("index.html").is_file() {
            return Err("nccsearch update is missing its entry page".into());
        }
        let _ = std::fs::remove_dir_all(&target);
        std::fs::rename(&staging, &target).map_err(|e| e.to_string())?;
        let pointer_tmp = root.join("pending-version.tmp");
        std::fs::write(&pointer_tmp, format!("{version}\n")).map_err(|e| e.to_string())?;
        std::fs::rename(pointer_tmp, root.join("pending-version")).map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

pub fn activate_pending(data_dir: &Path) {
    let root = data_dir.join("nccsearch-updates");
    let pending_file = root.join("pending-version");
    let Ok(version) = std::fs::read_to_string(&pending_file) else {
        return;
    };
    let version = version.trim();
    if valid_version(version) && root.join(version).join("index.html").is_file() {
        let temp = root.join("active-version.tmp");
        if std::fs::write(&temp, format!("{version}\n")).is_ok()
            && std::fs::rename(temp, root.join("active-version")).is_ok()
        {
            let _ = std::fs::remove_file(pending_file);
            return;
        }
    }
    let _ = std::fs::remove_file(pending_file);
}
