use std::sync::{Arc, Mutex};

use base64::Engine as _;
use tauri::{Emitter, Manager};

use ncc_identity::{IdentityStore, KeyEnvelope, PassphraseEnvelope, Status};
use ncc_proxy::{
    vault::{Credentials, Draft, PendingSave, SaveOutcome, VaultStatus},
    ApprovalRequest, Approvals, HttpsMode, ProxyConfig, ProxyState, Settings, SettingsStore,
};
use ncc_vault::{GeneratorOptions, PasswordSummary, TotpCode};
use ncc_proxy::settings::PasswordSettings;
use ncc_proxy::vault::VaultService;
use ncc_tor::{Tor, TorConfig, TorMode, TorState, TorStatus};

#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_imattau_nccbrowser_ContentSurface_nativeProtectionCheck(
    mut env: jni::JNIEnv,
    _this: jni::objects::JObject,
    url: jni::objects::JString,
    source: jni::objects::JString,
    request_type: jni::objects::JString,
    method: jni::objects::JString,
    kind: jni::objects::JString,
) -> jni::sys::jboolean {
    let read = |env: &mut jni::JNIEnv, value: jni::objects::JString| -> String {
        env.get_string(&value).map(|text| text.into()).unwrap_or_default()
    };
    let url = read(&mut env, url);
    let source = read(&mut env, source);
    let request_type = read(&mut env, request_type);
    let method = read(&mut env, method);
    let kind = read(&mut env, kind);
    if ncc_proxy::protection::check_request(&url, &source, &request_type, &method, &kind) { 1 } else { 0 }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_imattau_nccbrowser_ContentSurface_nativeProtectionLevel(
    _env: jni::JNIEnv,
    _this: jni::objects::JObject,
) -> i32 {
    match ncc_proxy::protection::level() {
        ncc_proxy::settings::ProtectionLevel::Off => 0,
        ncc_proxy::settings::ProtectionLevel::Standard => 1,
        ncc_proxy::settings::ProtectionLevel::Strict => 2,
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_imattau_nccbrowser_ContentSurface_nativeCosmeticSelectors(
    mut env: jni::JNIEnv,
    _this: jni::objects::JObject,
    url: jni::objects::JString,
    kind: jni::objects::JString,
) -> jni::sys::jstring {
    let url = env.get_string(&url).map(|text| String::from(text)).unwrap_or_default();
    let kind = env.get_string(&kind).map(|text| String::from(text)).unwrap_or_default();
    let selectors = ncc_proxy::protection::cosmetic_selectors(&url, &kind);
    env.new_string(selectors.join(",")).map(|text| text.into_raw()).unwrap_or(std::ptr::null_mut())
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_imattau_nccbrowser_ContentSurface_nativeClearProtectionSession(
    mut env: jni::JNIEnv,
    _this: jni::objects::JObject,
    kind: jni::objects::JString,
) {
    let kind = env.get_string(&kind).map(|text| String::from(text)).unwrap_or_default();
    ncc_proxy::protection::clear_session_exceptions(&kind);
}

/// The three listeners' states, so a signer call from a clearnet page can reach the
/// one that belongs to its tab: the person's identity for a normal tab, a throwaway
/// key for a private tab, another for Tor.
struct SignerRoutes {
    normal: Arc<ProxyState>,
    private: Option<Arc<ProxyState>>,
    tor: Option<Arc<ProxyState>>,
}

static SIGNER_ROUTES: std::sync::OnceLock<SignerRoutes> = std::sync::OnceLock::new();

/// NIP-07 for a page the proxy does not serve. Blocks until answered (including a
/// user's approval), so the caller runs it off the main thread. The origin comes from
/// the WebView's message listener, never from the page.
///
/// Returns `{"status":<http status>,"body":<json text>}`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_imattau_nccbrowser_ContentSurface_nativeNip07(
    mut env: jni::JNIEnv,
    _this: jni::objects::JObject,
    kind: jni::objects::JString,
    origin: jni::objects::JString,
    method: jni::objects::JString,
    body: jni::objects::JString,
) -> jni::sys::jstring {
    let mut read = |value: jni::objects::JString| -> String {
        env.get_string(&value).map(String::from).unwrap_or_default()
    };
    let kind = read(kind);
    let origin = read(origin);
    let method = read(method);
    let body = read(body);

    let (status, text) = match SIGNER_ROUTES.get() {
        None => (503, r#"{"code":"not-ready","message":"The signer is not ready yet."}"#.to_string()),
        Some(routes) => {
            let state = match kind.as_str() {
                "private" => routes.private.clone(),
                "tor" => routes.tor.clone(),
                _ => Some(routes.normal.clone()),
            };
            match state {
                None => (503, r#"{"code":"no-signer","message":"This kind of tab has no signer."}"#.to_string()),
                Some(state) => tauri::async_runtime::block_on(ncc_proxy::signer::handle_web(
                    &state,
                    &origin,
                    &method,
                    body.as_bytes(),
                )),
            }
        }
    };

    let reply = serde_json::json!({ "status": status, "body": text }).to_string();
    env.new_string(reply)
        .map(|text| text.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

/// Everything the commands need. The proxy shares the same `Arc`s.
struct SignerState {
    identity: Arc<IdentityStore>,
    approvals: Arc<Approvals>,
    proxy: Arc<ProxyState>,
    /// The session file for a remote signer, when one has been connected.
    sessions: ncc_proxy::bunker::Sessions,
    remote_sessions_dir: std::path::PathBuf,
    remote_profiles: Mutex<std::collections::HashMap<String, Arc<ncc_proxy::bunker::Bunker>>>,
    profile_prefs: ProfilePrefs,
}

#[derive(Debug, Clone, serde::Serialize)]
struct IdentityProfileInfo {
    id: String,
    mode: String,
    npub: Option<String>,
    active: bool,
    is_default: bool,
    unlocked: bool,
}

#[derive(Debug, serde::Serialize)]
struct IdentityProfilesInfo {
    identities: Vec<IdentityProfileInfo>,
    active_id: Option<String>,
    default_id: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
struct ProfilePrefsFile {
    version: u32,
    active_id: Option<String>,
    default_id: Option<String>,
    #[serde(default)]
    remote_npubs: std::collections::HashMap<String, String>,
}

struct ProfilePrefs {
    path: std::path::PathBuf,
    value: Mutex<ProfilePrefsFile>,
}

impl ProfilePrefs {
    fn open(path: std::path::PathBuf) -> Self {
        let value = std::fs::read(&path).ok()
            .and_then(|bytes| serde_json::from_slice::<ProfilePrefsFile>(&bytes).ok())
            .filter(|value| value.version == 1).unwrap_or_default();
        Self { path, value: Mutex::new(ProfilePrefsFile { version: 1, ..value }) }
    }

    fn snapshot(&self) -> ProfilePrefsFile { self.value.lock().expect("profile prefs").clone() }

    fn update(&self, update: impl FnOnce(&mut ProfilePrefsFile)) -> Result<(), String> {
        let mut value = self.value.lock().expect("profile prefs");
        update(&mut value);
        value.version = 1;
        write_json_atomic(&self.path, &*value)
    }
}

fn write_json_atomic(path: &std::path::Path, value: &impl serde::Serialize) -> Result<(), String> {
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let temp = path.with_extension("tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(temp, path).map_err(|e| e.to_string())
}

/// The loopback port the NCC proxy is listening on, once it started.
struct ProxyPort(Option<u16>);

/// The second listener private tabs use. Separate on purpose: it is a different origin,
/// so its storage is separate, and it is built without any of the on-disk caches.
struct PrivateProxyPort(Option<u16>);

/// The third listener: onion sites, fetched through Tor. A separate port again, so a
/// Tor tab is its own origin and none of the NCC caches are reachable from it.
struct TorProxyPort(Option<u16>);

/// The local SOCKS endpoint Tor tabs leave through, and its state.
struct TorHandle(Option<Arc<Tor>>);

/// Where arti keeps its guard state and directory cache.
struct AppDataDir(std::path::PathBuf);

/// The password vault. It needs the identity and the settings store, not the proxy.
struct VaultHandle(Arc<VaultService>);

/// Bookmark, history and open-tab sync. Same identity and relays as the vault.
struct SyncHandle(Arc<ncc_proxy::sync::SyncService>);
struct ShareHandle(Arc<ncc_proxy::share::ShareService>);

#[tauri::command]
fn proxy_port(state: tauri::State<'_, ProxyPort>) -> Option<u16> {
    state.0
}

#[tauri::command]
fn private_proxy_port(state: tauri::State<'_, PrivateProxyPort>) -> Option<u16> {
    state.0
}

#[tauri::command]
fn tor_proxy_port(state: tauri::State<'_, TorProxyPort>) -> Option<u16> {
    state.0
}

/// Bootstrap progress, the route in use and the reason for a failure. The shell shows
/// this rather than guessing from an empty page.
#[tauri::command]
fn tor_status(state: tauri::State<'_, TorHandle>) -> Option<TorStatus> {
    state.0.as_ref().map(|tor| tor.status())
}

/// Start resolving a Tor route, if one is not already being resolved. Called when a
/// Tor tab is opened: launching the app on its own must not contact the Tor network.
#[tauri::command]
fn tor_prepare(state: tauri::State<'_, TorHandle>) {
    if let Some(tor) = state.0.as_ref() {
        tor.prepare();
    }
}

#[tauri::command]
fn vault_status(vault: tauri::State<'_, VaultHandle>) -> VaultStatus {
    vault.0.status()
}

/// Unlocking is gated on a device credential in the shell before this is called; the
/// vault itself can only check that the identity is available.
///
/// The identity is opened here too when it is stored with the device envelope. One
/// device-credential prompt should be enough to open both, and a passphrase-sealed
/// identity stays locked and says so.
#[tauri::command]
async fn vault_unlock(
    state: tauri::State<'_, SignerState>,
    vault: tauri::State<'_, VaultHandle>,
) -> Result<VaultStatus, String> {
    let identity = state.identity.status();
    if identity.initialised && !identity.unlocked {
        let _ = state.identity.unlock(envelope(None).as_ref());
    }
    Ok(vault.0.unlock().await)
}

#[tauri::command]
fn vault_lock(vault: tauri::State<'_, VaultHandle>) -> VaultStatus {
    vault.0.lock()
}

#[tauri::command]
fn vault_list(vault: tauri::State<'_, VaultHandle>) -> Vec<PasswordSummary> {
    vault.0.list()
}

#[tauri::command]
fn vault_entry(vault: tauri::State<'_, VaultHandle>, id: String) -> Result<serde_json::Value, String> {
    let entry = vault.0.entry(&id)?;
    Ok(serde_json::to_value(entry).map_err(|error| error.to_string())?)
}

#[tauri::command]
fn vault_matches(
    vault: tauri::State<'_, VaultHandle>,
    url: String,
    kind: String,
) -> Result<Vec<PasswordSummary>, String> {
    vault.0.matches(&url, &kind)
}

#[tauri::command]
fn vault_fill(
    vault: tauri::State<'_, VaultHandle>,
    id: String,
    url: String,
    kind: String,
) -> Result<Credentials, String> {
    vault.0.fill(&id, &url, &kind)
}

#[tauri::command]
fn vault_totp(vault: tauri::State<'_, VaultHandle>, id: String) -> Result<TotpCode, String> {
    vault.0.totp(&id)
}

#[tauri::command]
fn vault_generate(vault: tauri::State<'_, VaultHandle>, options: GeneratorOptions) -> String {
    vault.0.generate(&options)
}

#[tauri::command]
async fn vault_save(
    vault: tauri::State<'_, VaultHandle>,
    draft: Draft,
) -> Result<SaveOutcome, String> {
    Ok(vault.0.save(draft).await)
}

#[tauri::command]
async fn vault_remove(
    vault: tauri::State<'_, VaultHandle>,
    id: String,
) -> Result<SaveOutcome, String> {
    Ok(vault.0.remove(&id).await)
}

#[tauri::command]
fn vault_capture(
    vault: tauri::State<'_, VaultHandle>,
    url: String,
    kind: String,
    title: String,
    username: String,
    password: String,
) -> Result<Option<PendingSave>, String> {
    vault
        .0
        .capture(&url, &kind, &title, &username, &password)
}

#[tauri::command]
async fn vault_respond(
    vault: tauri::State<'_, VaultHandle>,
    id: String,
    action: String,
) -> Result<SaveOutcome, String> {
    Ok(vault.0.respond_to_save(&id, &action).await)
}

#[tauri::command]
fn vault_config(
    state: tauri::State<'_, SignerState>,
    vault: tauri::State<'_, VaultHandle>,
    passwords: PasswordSettings,
) -> Result<Settings, String> {
    let saved = state.proxy.settings().set_passwords(passwords)?;
    let _ = vault;
    Ok(saved)
}

#[tauri::command]
fn vault_forget_never_save(
    state: tauri::State<'_, SignerState>,
    origin: String,
) -> Result<Settings, String> {
    state.proxy.settings().remove_never_save(&origin)
}

/// One sync exchange: the shell hands over what it has for each category that is on,
/// and gets the merged result back to store.
#[tauri::command]
async fn sync_exchange(
    sync: tauri::State<'_, SyncHandle>,
    request: ncc_proxy::sync::SyncRequest,
) -> Result<ncc_proxy::sync::SyncResponse, String> {
    sync.0.exchange(request).await
}

/// Post a page to Nostr as a public note. Normal tabs only; the shell asks first.
#[tauri::command]
async fn share_nostr(
    share: tauri::State<'_, ShareHandle>,
    kind: String,
    url: String,
    title: String,
    comment: String,
) -> Result<ncc_proxy::share::ShareOutcome, String> {
    share.0.post(&kind, &url, &title, &comment).await
}

#[tauri::command]
async fn sync_remove_device(
    sync: tauri::State<'_, SyncHandle>,
    device: ncc_vault::sync::DeviceInfo,
    now: u64,
) -> Result<(), String> {
    sync.0.remove_device(device, now).await
}

/// Called when the shell becomes visible again: pulls the relay copy, throttled.
#[tauri::command]
async fn vault_focus(vault: tauri::State<'_, VaultHandle>) -> Result<VaultStatus, String> {
    Ok(vault.0.on_focus().await)
}

#[tauri::command]
fn browser_settings(state: tauri::State<'_, SignerState>) -> Settings {
    state.proxy.settings().get()
}

#[tauri::command]
async fn settings_set_relays(
    state: tauri::State<'_, SignerState>,
    relays: Vec<String>,
) -> Result<Settings, String> {
    // Android settings accept the same ncc:// identity form as desktop. Resolve it
    // through NCC-05 in relay mode before persisting the concrete websocket URL.
    let mut resolved = Vec::with_capacity(relays.len());
    for relay in relays {
        let value = relay.trim();
        if value.to_ascii_lowercase().starts_with("ncc://") {
            let address = ncc_core::parse_ncc_address(value).map_err(|error| error.to_string())?;
            let bare_identity = !value[6..].trim_end_matches('/').contains('/');
            let service = if bare_identity { "relay" } else { &address.service };
            let record = state.proxy.resolver().resolve_relay(&address.pubkey, service).await
                .map_err(|error| error.to_string())?;
            let endpoint = record.endpoints.iter()
                .filter(|endpoint| endpoint.protocol == "wss" || endpoint.protocol == "ws")
                .min_by_key(|endpoint| (endpoint.protocol != "wss", endpoint.priority))
                .ok_or_else(|| format!("{value} does not publish a ws:// or wss:// relay endpoint"))?;
            resolved.push(endpoint.url.trim_end_matches('/').to_string());
        } else {
            resolved.push(value.to_string());
        }
    }
    state.proxy.settings().set_relays(resolved)
}

#[tauri::command]
fn settings_set_search(
    state: tauri::State<'_, SignerState>,
    engine: String,
    custom: String,
) -> Result<Settings, String> {
    state.proxy.settings().set_search(engine, custom)
}

#[tauri::command]
fn settings_set_https(
    state: tauri::State<'_, SignerState>,
    mode: String,
    warn: bool,
) -> Result<Settings, String> {
    let mode = match mode.as_str() {
        "off" => HttpsMode::Off,
        "only" => HttpsMode::Only,
        _ => HttpsMode::Prefer,
    };
    state.proxy.settings().set_https_mode(mode)?;
    state.proxy.settings().set_warn_insecure(warn)
}

#[tauri::command]
fn settings_set_protection(
    state: tauri::State<'_, SignerState>,
    protection: ncc_proxy::settings::ProtectionSettings,
) -> Result<Settings, String> {
    let saved = state.proxy.settings().set_protection(protection)?;
    ncc_proxy::protection::set_config(saved.protection.clone());
    Ok(saved)
}

#[tauri::command]
fn settings_set_protection_exception(
    state: tauri::State<'_, SignerState>,
    origin: String,
    allowed: bool,
    kind: String,
) -> Result<Settings, String> {
    let parsed = url::Url::parse(&origin).map_err(|error| error.to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" { return Err("Only HTTP and HTTPS sites can have protection exceptions".into()); }
    let origin = parsed.origin().ascii_serialization();
    if kind == "private" || kind == "tor" {
        ncc_proxy::protection::set_session_exception(&kind, &origin, allowed);
        return Ok(state.proxy.settings().get());
    }
    let mut protection = state.proxy.settings().get().protection;
    protection.site_exceptions.retain(|entry| entry != &origin);
    if allowed && protection.site_exceptions.len() < 200 { protection.site_exceptions.push(origin); }
    let saved = state.proxy.settings().set_protection(protection)?;
    ncc_proxy::protection::set_config(saved.protection.clone());
    Ok(saved)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProtectionStatus { level: String, blocked: u64, excepted: bool }

#[tauri::command]
fn protection_status(state: tauri::State<'_, SignerState>, origin: Option<String>, kind: Option<String>) -> ProtectionStatus {
    let level = match state.proxy.settings().get().protection.level {
        ncc_proxy::settings::ProtectionLevel::Off => "off",
        ncc_proxy::settings::ProtectionLevel::Standard => "standard",
        ncc_proxy::settings::ProtectionLevel::Strict => "strict",
    };
    let origin = origin.and_then(|value| url::Url::parse(&value).ok()).map(|value| value.origin().ascii_serialization()).unwrap_or_default();
    ProtectionStatus { level: level.to_string(), blocked: ncc_proxy::protection::blocked_count(), excepted: ncc_proxy::protection::has_exception(kind.as_deref().unwrap_or("normal"), &origin) }
}

#[tauri::command]
fn protection_filters_status() -> ncc_proxy::protection::FilterStatus {
    ncc_proxy::protection::filter_status()
}

#[tauri::command]
async fn protection_update_filters(dir: tauri::State<'_, AppDataDir>) -> Result<ncc_proxy::protection::FilterStatus, String> {
    ncc_proxy::protection::refresh_lists(&dir.0.join("protection")).await;
    Ok(ncc_proxy::protection::filter_status())
}

#[tauri::command]
async fn settings_set_tor(
    state: tauri::State<'_, SignerState>,
    tor_handle: tauri::State<'_, TorHandle>,
    dir: tauri::State<'_, AppDataDir>,
    mode: String,
    socks: String,
) -> Result<Settings, String> {
    let mode = match mode.as_str() {
        "local" => TorMode::Local,
        _ => TorMode::Auto,
    };
    let saved = state.proxy.settings().set_tor(mode, socks.clone())?;

    if let Some(tor) = tor_handle.0.as_ref() {
        // The endpoint stays where it is, so a tab already pointing at it only needs a
        // reload once the new route is ready.
        tor.reconfigure(tor_config(&dir.0, mode, socks));
    }

    Ok(saved)
}

#[tauri::command]
fn settings_set_tor_on_launch(
    state: tauri::State<'_, SignerState>,
    tor_handle: tauri::State<'_, TorHandle>,
    value: bool,
) -> Result<Settings, String> {
    let saved = state.proxy.settings().set_tor_on_launch(value)?;
    if value {
        if let Some(tor) = tor_handle.0.as_ref() {
            tor.prepare();
        }
    }
    Ok(saved)
}

#[tauri::command]
fn settings_set_gossip(
    state: tauri::State<'_, SignerState>,
    value: bool,
) -> Result<Settings, String> {
    state.proxy.settings().set_gossip(value)
}

#[tauri::command]
fn clear_cache(state: tauri::State<'_, SignerState>) -> bool {
    state.proxy.clear_caches();
    true
}

#[derive(serde::Serialize)]
struct BunkerInfo {
    configured: bool,
    npub: Option<String>,
    relays: Vec<String>,
}

fn bunker_profile_id(remote_pubkey: &str) -> String { format!("nip46:{remote_pubkey}") }
fn local_profile_id(pubkey: &str) -> String { format!("local:{pubkey}") }
fn remote_session_path(state: &SignerState, remote_pubkey: &str) -> Result<std::path::PathBuf, String> {
    if remote_pubkey.len() != 64 || !remote_pubkey.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid remote signer profile key".into());
    }
    Ok(state.remote_sessions_dir.join(format!("{remote_pubkey}.json")))
}

fn identity_profiles_info(state: &SignerState) -> IdentityProfilesInfo {
    let prefs = state.profile_prefs.snapshot();
    let local_profiles = state.identity.profiles();
    let mut identities: Vec<IdentityProfileInfo> = local_profiles.iter().map(|profile| IdentityProfileInfo {
        id: local_profile_id(&profile.id), mode: "local".into(), npub: Some(profile.npub.clone()),
        active: false, is_default: false, unlocked: profile.unlocked,
    }).collect();

    let mut remote_ids = std::collections::HashSet::new();
    if let Ok(entries) = std::fs::read_dir(&state.remote_sessions_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") { continue; }
            let Some(remote_pubkey) = path.file_stem().and_then(|value| value.to_str()).filter(|value| value.len() == 64) else { continue };
            remote_ids.insert(remote_pubkey.to_string());
            let id = bunker_profile_id(remote_pubkey);
            let live_npub = state.remote_profiles.lock().expect("remote profiles").get(remote_pubkey)
                .and_then(|bunker| bunker.user_npub());
            identities.push(IdentityProfileInfo { id, mode: "nip46".into(),
                npub: live_npub.or_else(|| prefs.remote_npubs.get(remote_pubkey).cloned()),
                active: false, is_default: false, unlocked: true });
        }
    }

    if let Some((target, _client)) = state.sessions.load(envelope(None).as_ref()) {
        if remote_ids.insert(target.remote_pubkey.clone()) {
            let remote_pubkey = target.remote_pubkey;
            identities.push(IdentityProfileInfo { id: bunker_profile_id(&remote_pubkey), mode: "nip46".into(),
                npub: prefs.remote_npubs.get(&remote_pubkey).cloned(), active: false, is_default: false, unlocked: true });
        }
    }

    let mut active_id = prefs.active_id.clone();
    if active_id.is_none() {
        active_id = state.proxy.remote().map(|bunker| bunker_profile_id(&bunker.target().remote_pubkey))
            .or_else(|| local_profiles.iter().find(|profile| profile.active).map(|profile| local_profile_id(&profile.id)));
    }
    let default_id = prefs.default_id.clone().or_else(|| active_id.clone())
        .or_else(|| local_profiles.iter().find(|profile| profile.default).map(|profile| local_profile_id(&profile.id)));
    for profile in &mut identities {
        profile.active = active_id.as_deref() == Some(&profile.id);
        profile.is_default = default_id.as_deref() == Some(&profile.id);
    }
    identities.sort_by(|a, b| b.is_default.cmp(&a.is_default).then_with(|| a.id.cmp(&b.id)));
    IdentityProfilesInfo { identities, active_id, default_id }
}

fn bunker_info(remote: Option<&ncc_proxy::bunker::Bunker>) -> BunkerInfo {
    let Some(bunker) = remote else {
        return BunkerInfo {
            configured: false,
            npub: None,
            relays: Vec::new(),
        };
    };

    BunkerInfo {
        configured: true,
        npub: bunker.user_npub(),
        relays: bunker.relays(),
    }
}

/// Connect a remote signer. The link carries everything: the signer's key, its relays
/// and the optional single-use secret.
///
/// It connects immediately, so a link the signer refuses fails here, in front of the
/// person who pasted it, rather than on the first signature a page asks for.
#[tauri::command]
async fn bunker_connect(
    state: tauri::State<'_, SignerState>,
    url: String,
) -> Result<BunkerInfo, String> {
    let prior_default = identity_profiles_info(&state).default_id;
    let target = ncc_proxy::bunker::parse_bunker(&url)?;
    let remote_id = target.remote_pubkey.clone();
    let bunker = Arc::new(ncc_proxy::bunker::Bunker::generate(target));

    bunker.connect().await?;

    let envelope = envelope(None);
    let session_path = remote_session_path(&state, &remote_id)?;
    ncc_proxy::bunker::Sessions::open(session_path).save_for(&bunker, envelope.as_ref())?;
    let user_npub = bunker.user_npub().ok_or_else(|| "The remote signer did not return an npub".to_string())?;
    state.remote_profiles.lock().expect("remote profiles").insert(remote_id.clone(), bunker.clone());
    state.profile_prefs.update(|prefs| {
        prefs.active_id = Some(bunker_profile_id(&remote_id));
        if prefs.default_id.is_none() { prefs.default_id = prior_default.clone().or_else(|| prefs.active_id.clone()); }
        prefs.remote_npubs.insert(remote_id, user_npub);
    })?;

    state.proxy.set_remote(Some(bunker));
    Ok(bunker_info(state.proxy.remote().as_deref()))
}

/// A stored session is reused here rather than at startup, so launching the app never
/// waits on a relay.
#[tauri::command]
fn bunker_status(state: tauri::State<'_, SignerState>) -> BunkerInfo {
    if state.proxy.remote().is_none() {
        let prefs = state.profile_prefs.snapshot();
        let active_remote = prefs.active_id.as_deref().and_then(|id| id.strip_prefix("nip46:"));
        let saved = active_remote.and_then(|id| remote_session_path(&state, id).ok())
            .filter(|path| path.exists())
            .and_then(|path| ncc_proxy::bunker::Sessions::open(path).load(envelope(None).as_ref()));
        let legacy = if prefs.active_id.is_none() { state.sessions.load(envelope(None).as_ref()) } else { None };
        if let Some((target, client)) = saved.or(legacy) {
            let remote_id = target.remote_pubkey.clone();
            let bunker = Arc::new(ncc_proxy::bunker::Bunker::new(target, client));
            state.remote_profiles.lock().expect("remote profiles").insert(remote_id, bunker.clone());
            state.proxy.set_remote(Some(bunker));
        }
    }

    bunker_info(state.proxy.remote().as_deref())
}

#[tauri::command]
async fn bunker_disconnect(state: tauri::State<'_, SignerState>) -> Result<BunkerInfo, String> {
    let mut removed_id = None;
    if let Some(bunker) = state.proxy.remote() {
        // A courtesy: the session is forgotten here either way.
        let _ = bunker.logout().await;
        removed_id = Some(bunker.target().remote_pubkey);
    }

    if let Some(remote_id) = removed_id {
        if let Ok(path) = remote_session_path(&state, &remote_id) { let _ = std::fs::remove_file(path); }
        state.remote_profiles.lock().expect("remote profiles").remove(&remote_id);
        if state.sessions.load(envelope(None).as_ref()).map(|(target, _)| target.remote_pubkey) == Some(remote_id.clone()) {
            state.sessions.forget();
        }
        let fallback = {
            let prefs = state.profile_prefs.snapshot();
            prefs.default_id.filter(|id| id != &bunker_profile_id(&remote_id))
                .or_else(|| state.identity.profiles().first().map(|profile| local_profile_id(&profile.id)))
        };
        state.profile_prefs.update(|prefs| {
            prefs.remote_npubs.remove(&remote_id);
            prefs.active_id = fallback.clone();
            if prefs.default_id.as_deref() == Some(&bunker_profile_id(&remote_id)) { prefs.default_id = fallback.clone(); }
        })?;
        if let Some(id) = fallback { let _ = activate_identity(&state, &id).await; }
    }
    state.proxy.set_remote(None);
    Ok(bunker_info(None))
}

/// Keeping the identity unlocked across launches.
///
/// Turning it on unlocks now; turning it off locks now. It can only work where the
/// envelope opens without asking anything, which is the case with the device keystore.
#[tauri::command]
fn settings_set_keep_unlocked(
    state: tauri::State<'_, SignerState>,
    enabled: bool,
) -> Result<Status, String> {
    state.proxy.settings().set_keep_unlocked(enabled)?;

    if enabled {
        let envelope = envelope(None);
        state
            .identity
            .unlock(envelope.as_ref())
            .map_err(|error| error.to_string())?;
    } else {
        state.identity.lock();
    }

    Ok(state.identity.status())
}

#[tauri::command]
fn identity_status(state: tauri::State<'_, SignerState>) -> Status {
    state.identity.status()
}

#[tauri::command]
fn identity_profiles(state: tauri::State<'_, SignerState>) -> IdentityProfilesInfo {
    identity_profiles_info(&state)
}

#[tauri::command]
fn identity_create_profile(state: tauri::State<'_, SignerState>) -> Result<Status, String> {
    let prior_default = state.identity.profiles().into_iter().find(|profile| profile.default)
        .map(|profile| local_profile_id(&profile.id));
    let envelope = envelope(None);
    state.identity.create_profile(envelope.as_ref()).map_err(|error| error.to_string())?;
    let id = state.identity.profiles().into_iter().find(|profile| profile.active)
        .map(|profile| profile.id).ok_or_else(|| "Could not read the new identity".to_string())?;
    state.proxy.set_remote(None);
    state.profile_prefs.update(|prefs| {
        prefs.active_id = Some(local_profile_id(&id));
        if prefs.default_id.is_none() { prefs.default_id = prior_default.clone().or_else(|| prefs.active_id.clone()); }
    })?;
    Ok(state.identity.status())
}

#[tauri::command]
fn identity_import_profile(state: tauri::State<'_, SignerState>, secret: String) -> Result<Status, String> {
    let prior_default = state.identity.profiles().into_iter().find(|profile| profile.default)
        .map(|profile| local_profile_id(&profile.id));
    let envelope = envelope(None);
    state.identity.import_profile(envelope.as_ref(), &secret).map_err(|error| error.to_string())?;
    let id = state.identity.profiles().into_iter().find(|profile| profile.active)
        .map(|profile| profile.id).ok_or_else(|| "Could not read the imported identity".to_string())?;
    state.proxy.set_remote(None);
    state.profile_prefs.update(|prefs| {
        prefs.active_id = Some(local_profile_id(&id));
        if prefs.default_id.is_none() { prefs.default_id = prior_default.clone().or_else(|| prefs.active_id.clone()); }
    })?;
    Ok(state.identity.status())
}

#[tauri::command]
async fn identity_select(state: tauri::State<'_, SignerState>, id: String) -> Result<IdentityProfilesInfo, String> {
    activate_identity(&state, &id).await?;
    Ok(identity_profiles_info(&state))
}

async fn activate_identity(state: &SignerState, id: &str) -> Result<(), String> {
    if let Some(local_id) = id.strip_prefix("local:") {
        let _ = state.identity.select_profile(local_id).map_err(|error| error.to_string())?;
        let device_envelope = envelope(None);
        if let Err(error) = state.identity.unlock(device_envelope.as_ref()) {
            if !matches!(&error, ncc_identity::IdentityError::PassphraseRequired) {
                return Err(error.to_string());
            }
        }
        state.proxy.set_remote(None);
    } else if let Some(remote_id) = id.strip_prefix("nip46:") {
        let path = remote_session_path(&state, remote_id)?;
        let loaded = if path.exists() {
            ncc_proxy::bunker::Sessions::open(path).load(envelope(None).as_ref())
        } else {
            state.sessions.load(envelope(None).as_ref()).filter(|(target, _)| target.remote_pubkey == remote_id)
        }.ok_or_else(|| "That remote signer session is no longer available".to_string())?;
        let bunker = Arc::new(ncc_proxy::bunker::Bunker::new(loaded.0, loaded.1));
        let user_key = bunker.ensure_user().await?;
        let npub = bunker.user_npub().ok_or_else(|| format!("The signer returned no npub for {user_key}"))?;
        state.remote_profiles.lock().expect("remote profiles").insert(remote_id.to_string(), bunker.clone());
        state.proxy.set_remote(Some(bunker));
        state.profile_prefs.update(|prefs| {
            prefs.active_id = Some(id.to_string());
            prefs.remote_npubs.insert(remote_id.to_string(), npub);
        })?;
    } else {
        return Err("Unknown identity profile".into());
    }
    state.profile_prefs.update(|prefs| { prefs.active_id = Some(id.to_string()); })?;
    Ok(())
}

#[tauri::command]
fn identity_set_default(state: tauri::State<'_, SignerState>, id: String) -> Result<IdentityProfilesInfo, String> {
    if let Some(local_id) = id.strip_prefix("local:") {
        state.identity.set_default_profile(local_id).map_err(|error| error.to_string())?;
    } else if !id.starts_with("nip46:") {
        return Err("Unknown identity profile".into());
    }
    if !identity_profiles_info(&state).identities.iter().any(|profile| profile.id == id) {
        return Err("That identity profile is not available".into());
    }
    state.profile_prefs.update(|prefs| { prefs.default_id = Some(id); })?;
    Ok(identity_profiles_info(&state))
}

#[tauri::command]
async fn identity_remove_profile(state: tauri::State<'_, SignerState>, id: String) -> Result<IdentityProfilesInfo, String> {
    if let Some(local_id) = id.strip_prefix("local:") {
        state.identity.remove_profile(local_id).map_err(|error| error.to_string())?;
    } else if let Some(remote_id) = id.strip_prefix("nip46:") {
        let path = remote_session_path(&state, remote_id)?;
        if path.exists() { std::fs::remove_file(path).map_err(|error| error.to_string())?; }
        let remote = { state.remote_profiles.lock().expect("remote profiles").remove(remote_id) };
        if let Some(remote) = remote {
            let _ = remote.logout().await;
        }
        if state.sessions.load(envelope(None).as_ref()).map(|(target, _)| target.remote_pubkey) == Some(remote_id.to_string()) {
            state.sessions.forget();
        }
    } else { return Err("Unknown identity profile".into()); }

    let next = identity_profiles_info(&state);
    let fallback = next.identities.iter().find(|profile| profile.is_default && profile.id != id)
        .map(|profile| profile.id.clone())
        .or_else(|| next.identities.iter().find(|profile| profile.id != id).map(|profile| profile.id.clone()));
    state.profile_prefs.update(|prefs| {
        if prefs.active_id.as_deref() == Some(&id) { prefs.active_id = fallback.clone(); }
        if prefs.default_id.as_deref() == Some(&id) { prefs.default_id = fallback.clone(); }
        if let Some(remote_id) = id.strip_prefix("nip46:") { prefs.remote_npubs.remove(remote_id); }
    })?;
    if let Some(active) = fallback { activate_identity(&state, &active).await?; }
    else { state.proxy.set_remote(None); }
    Ok(identity_profiles_info(&state))
}

/// PSBT signing is exposed only to the browser chrome. The page's separate WebView
/// cannot invoke Tauri commands and never receives the identity secret.
#[tauri::command]
fn bitcoin_sign_psbt(state: tauri::State<'_, SignerState>, psbt_hex: String) -> Result<String, String> {
    if state.proxy.remote().is_some() {
        return Err("Bitcoin spending requires the local Nostr identity".into());
    }
    state.identity.bitcoin_sign_psbt(&psbt_hex).map_err(|error| error.to_string())
}

#[tauri::command]
fn bitcoin_public_key(state: tauri::State<'_, SignerState>) -> Result<String, String> {
    if state.proxy.remote().is_some() {
        return Err("Bitcoin spending requires the local Nostr identity".into());
    }
    state.identity.public_key().map(|key| key.to_hex()).map_err(|error| error.to_string())
}

/// Name the TLS roots explicitly: reqwest's default builds a platform verifier, which
/// panics or fails on Android (no JVM context). Falls back to the default if the roots
/// cannot be built.
fn with_webpki_roots(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    match ncc_proxy::pins::webpki_tls_config() {
        Ok(tls) => builder.use_preconfigured_tls(tls),
        Err(_) => builder,
    }
}

/// Wallet HTTP requests stay in Rust. When the app has a ready Tor route, Esplora
/// traffic follows the same route rather than falling back to the WebView network.
#[tauri::command]
async fn wallet_http(
    tor: tauri::State<'_, TorHandle>,
    url: String,
    method: String,
    body: Option<String>,
) -> Result<String, String> {
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid wallet service URL".to_string())?;
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && matches!(parsed.host_str(), Some("localhost" | "127.0.0.1"))) {
        return Err("Wallet service URLs must use HTTPS (HTTP is allowed for localhost)".into());
    }
    let mut builder = with_webpki_roots(reqwest::Client::builder()).timeout(std::time::Duration::from_secs(20));
    if let Some(route) = tor.0.as_ref() {
        if matches!(route.status().state, TorState::Ready) {
            let proxy = reqwest::Proxy::all(route.socks_url()).map_err(|error| error.to_string())?;
            builder = builder.proxy(proxy);
        }
    }
    let client = builder.build().map_err(|error| error.to_string())?;
    let request = match method.as_str() {
        "GET" => client.get(parsed),
        "POST" => client.post(parsed).header("content-type", "text/plain").body(body.unwrap_or_default()),
        _ => return Err("Unsupported wallet service method".into()),
    };
    let response = request.send().await.map_err(|error| format!("Wallet service request failed: {error}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() { return Err(format!("Wallet service returned HTTP {status}")); }
    Ok(text)
}

fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) { Some("image/jpeg") }
    else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { Some("image/png") }
    else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") { Some("image/gif") }
    else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" { Some("image/webp") }
    else if bytes.len() > 12 && &bytes[4..8] == b"ftyp" && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis") { Some("image/avif") }
    else { None }
}

/// Download a small HTTPS profile image in the trusted shell and return a data URL.
/// The renderer can then keep the bytes in its local profile cache and never needs
/// to load a remote image directly.
#[tauri::command]
async fn profile_picture_data(url: String) -> Result<Option<String>, String> {
    const MAX_BYTES: usize = 4 * 1024 * 1024;
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid profile picture URL".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Profile pictures must use HTTPS".into());
    }

    // Some image hosts refuse requests that carry no User-Agent.
    let client = with_webpki_roots(reqwest::Client::builder())
        .user_agent(concat!("NostrNavigator/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.url().scheme() == "https" && attempt.previous().len() < 5 {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|error| error.to_string())?;
    let mut response = client.get(parsed).send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success()
        || response.content_length().is_some_and(|length| length > MAX_BYTES as u64)
    {
        return Ok(None);
    }

    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if bytes.len().saturating_add(chunk.len()) > MAX_BYTES {
            return Ok(None);
        }
        bytes.extend_from_slice(&chunk);
    }
    // Trust the bytes over the header: hosts often label images as octet-stream.
    let Some(mime) = sniff_image_mime(&bytes).or_else(|| {
        matches!(mime.as_str(), "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/avif").then_some(mime.as_str())
    }) else {
        return Ok(None);
    };

    Ok(Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )))
}

const MONERO_WALLET_RECORD: &str = "monero-wallet.json";
const MONERO_WALLET_CACHE: &str = "monero-wallet-cache.json";

#[tauri::command]
async fn wallet_monero_cache_load(
    state: tauri::State<'_, SignerState>,
    dir: tauri::State<'_, AppDataDir>,
) -> Result<Option<serde_json::Value>, String> {
    if state.proxy.remote().is_some() { return Err("Monero wallet cache requires a local Nostr identity".into()); }
    let path = dir.0.join(MONERO_WALLET_CACHE);
    if !path.exists() { return Ok(None); }
    let data: serde_json::Value = serde_json::from_slice(&std::fs::read(path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    let pubkey = state.identity.public_key().map_err(|error| error.to_string())?.to_hex();
    let plaintext = if let Some(parts) = data.get("parts").and_then(|value| value.as_array()) {
        let mut plaintext = String::new();
        for part in parts {
            let ciphertext = part.as_str().ok_or_else(|| "Stored Monero cache is invalid".to_string())?;
            plaintext.push_str(&state.identity.nip44_decrypt(&pubkey, ciphertext).map_err(|error| error.to_string())?);
        }
        plaintext
    } else {
        let ciphertext = data.get("ciphertext").and_then(|value| value.as_str()).ok_or_else(|| "Stored Monero cache is invalid".to_string())?;
        state.identity.nip44_decrypt(&pubkey, ciphertext).map_err(|error| error.to_string())?
    };
    serde_json::from_str(&plaintext).map(Some).map_err(|error| format!("Stored Monero cache is invalid: {error}"))
}

#[tauri::command]
async fn wallet_monero_cache_save(
    state: tauri::State<'_, SignerState>,
    dir: tauri::State<'_, AppDataDir>,
    data: serde_json::Value,
) -> Result<(), String> {
    if state.proxy.remote().is_some() { return Err("Monero wallet cache requires a local Nostr identity".into()); }
    if data.get("keysData").and_then(|value| value.as_str()).map_or(true, str::is_empty)
        || data.get("cacheData").and_then(|value| value.as_str()).map_or(true, str::is_empty) {
        return Err("Monero wallet cache is incomplete".into());
    }
    let pubkey = state.identity.public_key().map_err(|error| error.to_string())?.to_hex();
    // NIP-44 has a 64 KiB plaintext ceiling. Cache data can exceed it, so
    // encrypt bounded text chunks independently before writing the local file.
    let plaintext = data.to_string();
    let parts = plaintext.as_bytes().chunks(24 * 1024).map(|chunk| {
        let chunk = std::str::from_utf8(chunk).map_err(|error| error.to_string())?;
        state.identity.nip44_encrypt(&pubkey, chunk).map_err(|error| error.to_string())
    }).collect::<Result<Vec<_>, String>>()?;
    let path = dir.0.join(MONERO_WALLET_CACHE);
    let parent = path.parent().ok_or_else(|| "Monero wallet storage path is invalid".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(&serde_json::json!({"version":1,"parts":parts})).map_err(|error| error.to_string())?;
    std::fs::write(&temp, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(temp, path).map_err(|error| error.to_string())
}

#[tauri::command]
async fn wallet_monero_load(
    state: tauri::State<'_, SignerState>,
    sync: tauri::State<'_, SyncHandle>,
    dir: tauri::State<'_, AppDataDir>,
) -> Result<Option<serde_json::Value>, String> {
    if state.proxy.remote().is_some() { return Err("Monero wallet backup requires a local Nostr identity".into()); }
    let pubkey = state.identity.public_key().map_err(|error| error.to_string())?.to_hex();
    let path = dir.0.join(MONERO_WALLET_RECORD);
    let ciphertext = if path.exists() {
        let data: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
        data.get("ciphertext").and_then(|value| value.as_str()).map(str::to_owned)
    } else { None };
    let record = if let Some(ciphertext) = ciphertext {
        let plaintext = state.identity.nip44_decrypt(&pubkey, &ciphertext).map_err(|error| error.to_string())?;
        Some(serde_json::from_str(&plaintext).map_err(|error| format!("Stored Monero record is invalid: {error}"))?)
    } else {
        sync.0.monero_wallet_record(None).await?
    };
    if let Some(record) = &record {
        if !path.exists() {
            let plaintext = record.to_string();
            let sealed = state.identity.nip44_encrypt(&pubkey, &plaintext).map_err(|error| error.to_string())?;
            write_wallet_record_file(&path, &sealed)?;
        }
    }
    Ok(record)
}

#[tauri::command]
async fn wallet_monero_save(
    state: tauri::State<'_, SignerState>,
    sync: tauri::State<'_, SyncHandle>,
    dir: tauri::State<'_, AppDataDir>,
    record: serde_json::Value,
) -> Result<(), String> {
    if state.proxy.remote().is_some() { return Err("Monero wallet backup requires a local Nostr identity".into()); }
    if record.get("version").and_then(|value| value.as_u64()) != Some(1)
        || record.get("backupConfirmed").and_then(|value| value.as_bool()) != Some(true)
        || record.get("seed").and_then(|value| value.as_str()).map_or(true, str::is_empty)
        || record.get("address").and_then(|value| value.as_str()).map_or(true, str::is_empty) {
        return Err("The Monero seed backup check must be complete before saving".into());
    }
    let pubkey = state.identity.public_key().map_err(|error| error.to_string())?.to_hex();
    let plaintext = record.to_string();
    let sealed = state.identity.nip44_encrypt(&pubkey, &plaintext).map_err(|error| error.to_string())?;
    write_wallet_record_file(&dir.0.join(MONERO_WALLET_RECORD), &sealed)?;
    if record.get("syncChoice").and_then(|value| value.as_str()) == Some("encrypted-relay") {
        sync.0.monero_wallet_record(Some(record)).await?;
    }
    Ok(())
}

fn write_wallet_record_file(path: &std::path::Path, ciphertext: &str) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "Monero wallet storage path is invalid".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(&serde_json::json!({"version":1,"ciphertext":ciphertext})).map_err(|error| error.to_string())?;
    std::fs::write(&temp, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(temp, path).map_err(|error| error.to_string())
}

const NWC_CONNECTION_FILE: &str = "nwc-connection.json";

#[tauri::command]
#[cfg(target_os = "android")]
fn wallet_nwc_load(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use ncc_identity::KeyEnvelope;
    let path = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join(NWC_CONNECTION_FILE);
    if !path.exists() { return Ok(None); }
    let data: serde_json::Value = serde_json::from_slice(&std::fs::read(path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    let ciphertext = data.get("ciphertext").and_then(|value| value.as_str()).ok_or_else(|| "Stored NWC connection is invalid".to_string())?;
    ncc_identity::device::DeviceEnvelope.open(ciphertext).map(Some).map_err(|error| error.to_string())
}

#[tauri::command]
#[cfg(target_os = "android")]
fn wallet_nwc_save(app: tauri::AppHandle, uri: String) -> Result<(), String> {
    use ncc_identity::KeyEnvelope;
    if uri.len() > 4096 || !uri.starts_with("nostr+walletconnect://") { return Err("Invalid NWC connection URI".into()); }
    let sealed = ncc_identity::device::DeviceEnvelope.seal(&uri).map_err(|error| error.to_string())?;
    let path = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join(NWC_CONNECTION_FILE);
    write_wallet_record_file(&path, &sealed)
}

#[tauri::command]
#[cfg(target_os = "android")]
fn wallet_nwc_delete(app: tauri::AppHandle) -> Result<(), String> {
    let path = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join(NWC_CONNECTION_FILE);
    if path.exists() { std::fs::remove_file(path).map_err(|error| error.to_string())?; }
    Ok(())
}

/// How the secret is sealed. On Android the keystore holds the wrapping key, so no
/// passphrase is involved; the passphrase envelope is only used elsewhere, and to
/// migrate a file written before the keystore existed.
fn envelope(passphrase: Option<String>) -> Box<dyn KeyEnvelope> {
    #[cfg(target_os = "android")]
    {
        let _ = passphrase;
        Box::new(ncc_identity::device::DeviceEnvelope)
    }
    #[cfg(not(target_os = "android"))]
    {
        Box::new(PassphraseEnvelope::new(passphrase.unwrap_or_default()))
    }
}

#[tauri::command]
fn identity_create(
    state: tauri::State<'_, SignerState>,
    passphrase: Option<String>,
) -> Result<Status, String> {
    let envelope = envelope(passphrase);
    state
        .identity
        .create(envelope.as_ref())
        .map(|_| state.identity.status())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn identity_import(
    state: tauri::State<'_, SignerState>,
    passphrase: Option<String>,
    secret: String,
) -> Result<Status, String> {
    let envelope = envelope(passphrase);
    state
        .identity
        .import(envelope.as_ref(), &secret)
        .map(|_| state.identity.status())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn identity_unlock(
    state: tauri::State<'_, SignerState>,
    passphrase: Option<String>,
) -> Result<Status, String> {
    // A file from before the keystore is opened with its passphrase, then rewritten
    // with the device envelope, so the passphrase is asked for exactly once.
    let legacy = state.identity.status().envelope.as_deref() == Some("legacy");
    let envelope: Box<dyn KeyEnvelope> = if legacy {
        let Some(passphrase) = passphrase else {
            return Err(ncc_identity::IdentityError::PassphraseRequired.to_string());
        };
        Box::new(PassphraseEnvelope::new(passphrase))
    } else {
        envelope(None)
    };

    state
        .identity
        .unlock(envelope.as_ref())
        .map(|_| state.identity.status())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn identity_lock(state: tauri::State<'_, SignerState>) -> Status {
    state.identity.lock();
    state.identity.status()
}

#[tauri::command]
fn signer_permissions(state: tauri::State<'_, SignerState>) -> Vec<String> {
    state.proxy.trusted_keys()
}

/// Trust a service without waiting for it to ask, from the site information sheet. Only
/// the shell can call this: a page never reaches Tauri commands.
#[tauri::command]
fn signer_trust(state: tauri::State<'_, SignerState>, service: String) -> Vec<String> {
    if service.starts_with("ncc://") || service.starts_with("nsite://") {
        state.proxy.trust(&service);
    }
    state.proxy.trusted_keys()
}

/// "Forget trust decisions for this site": the signer permission and a cleartext
/// exception both go, so the next visit asks and warns again. Returns what is still
/// trusted. Passwords' never-save list has its own command.
#[tauri::command]
fn site_forget_trust(
    state: tauri::State<'_, SignerState>,
    service: String,
) -> Result<Vec<String>, String> {
    state.proxy.untrust(&service);
    state.proxy.settings().remove_http_exception(&service)?;
    Ok(state.proxy.trusted_keys())
}

#[tauri::command]
fn signer_revoke(state: tauri::State<'_, SignerState>, service: String) -> Vec<String> {
    state.proxy.untrust(&service);
    state.proxy.trusted_keys()
}

/// Answer a parked signer request. `remember` grants the whole service, and the grant
/// is written to disk, so the shell stops asking across restarts too.
#[tauri::command]
fn signer_respond(
    state: tauri::State<'_, SignerState>,
    id: String,
    allow: bool,
    remember: bool,
    service: Option<String>,
) -> bool {
    let answered = state.approvals.resolve(&id, allow);
    if answered && allow && remember {
        if let Some(service) = service {
            state.proxy.trust(&service);
        }
    }
    answered
}

fn default_relays() -> Vec<String> {
    if let Ok(value) = std::env::var("NCC_RELAYS") {
        let relays: Vec<String> = value
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect();
        if !relays.is_empty() {
            return relays;
        }
    }

    vec![
        "wss://relay.damus.io".to_string(),
        "wss://nos.lol".to_string(),
        "wss://relay.primal.net".to_string(),
    ]
}

/// Tells the Tor listener how far Tor has got, so a tab opened while it is still being
/// built shows "Connecting to Tor" instead of a blank page.
struct TorProgressFeed(Arc<Tor>);

impl std::fmt::Debug for TorProgressFeed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TorProgressFeed")
    }
}

impl ncc_proxy::TorProgressSource for TorProgressFeed {
    fn progress(&self) -> ncc_proxy::TorProgress {
        let status = self.0.status();
        match status.state {
            TorState::Ready => ncc_proxy::TorProgress::Ready,
            TorState::Failed => ncc_proxy::TorProgress::Failed {
                reason: status
                    .error
                    .unwrap_or_else(|| "No route to Tor was found.".to_string()),
            },
            _ => ncc_proxy::TorProgress::Starting {
                percent: status.percent,
            },
        }
    }
}

fn tor_config(dir: &std::path::Path, mode: TorMode, socks: String) -> TorConfig {
    TorConfig {
        mode,
        socks,
        state_dir: dir.join("tor").join("state"),
        cache_dir: dir.join("tor").join("cache"),
    }
}

fn proxy_config(
    data_dir: Option<std::path::PathBuf>,
    settings: Option<Arc<SettingsStore>>,
    nccsearch_directory: Option<std::path::PathBuf>,
) -> ProxyConfig {
    ProxyConfig {
        relays: default_relays(),
        settings,
        permissions_file: data_dir
            .as_ref()
            .map(|dir| dir.join("permissions.json")),
        // Manifests, records and verified site files survive a restart; site files are
        // hash-checked when read back.
        cache_directory: data_dir,
        nccsearch_directory,
        // Only the shell's own bundle may read responses across origins. A page
        // served from a vhost does not need CORS at all.
        allowed_origins: vec![
            "tauri://localhost".to_string(),
            "http://tauri.localhost".to_string(),
            "https://tauri.localhost".to_string(),
        ],
        ..Default::default()
    }
}

/// Bind a loopback socket, on `preferred` when it is free and on any free port when not.
///
/// A page's origin includes the port, so a new port every launch is a new origin for
/// every site: `localStorage`, IndexedDB and service workers all start empty after a
/// restart. Reusing the last port keeps them. It is still a port the OS chose, picked
/// once and remembered, rather than a well-known number another app could squat on, and
/// if something else has taken it the proxy simply moves, as it did before.
fn bind_loopback(preferred: Option<u16>) -> Result<std::net::TcpListener, String> {
    let reused = preferred
        .filter(|port| *port > 0)
        .and_then(|port| std::net::TcpListener::bind(("127.0.0.1", port)).ok());
    if let Some(listener) = reused {
        return Ok(listener);
    }
    std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())
}

/// The port used last time, if one was recorded.
fn remembered_port(file: &std::path::Path) -> Option<u16> {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|text| text.trim().parse::<u16>().ok())
        .filter(|port| *port >= 1024)
}

/// Record the port for the next launch. Failing to write it only costs the next
/// launch its web storage, so it is not an error.
fn remember_port(file: &std::path::Path, port: u16) {
    if remembered_port(file) == Some(port) {
        return;
    }
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(file, port.to_string());
}

/// Start the NCC proxy on a loopback port, `preferred` when it is free.
///
/// The content WebView loads `http://<npub>.<service>.localhost:<port>/`, so the
/// service stays part of the origin the way `ncc://` gives the desktop build. The
/// port is not a fixed number because nothing outside this process is allowed to reach
/// it.
///
/// The socket is bound with `std` and only *converted* inside the async task: tokio's
/// `from_std` registers with the reactor and panics when called outside a runtime,
/// which `setup()` is.
fn start_proxy(proxy: Arc<ProxyState>, preferred: Option<u16>) -> Result<u16, String> {
    let std_listener = bind_loopback(preferred)?;
    std_listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let port = std_listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();

    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(std_listener) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("[proxy] could not attach the listener: {error}");
                return;
            }
        };
        if let Err(error) = ncc_proxy::serve(listener, proxy).await {
            eprintln!("[proxy] {error}");
        }
    });

    Ok(port)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First of all: relay connections need a process-wide TLS default, and with arti linked
    // beside the proxy rustls cannot choose one itself.
    ncc_proxy::install_crypto_provider();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            proxy_port,
            private_proxy_port,
            tor_proxy_port,
            tor_status,
            tor_prepare,
            settings_set_tor,
            vault_status,
            sync_exchange,
            sync_remove_device,
            share_nostr,
            profile_picture_data,
            vault_unlock,
            vault_lock,
            vault_list,
            vault_entry,
            vault_matches,
            vault_fill,
            vault_totp,
            vault_generate,
            vault_save,
            vault_remove,
            vault_capture,
            vault_respond,
            vault_config,
            vault_forget_never_save,
            vault_focus,
            bunker_connect,
            bunker_status,
            bunker_disconnect,
            identity_status,
            identity_profiles,
            identity_select,
            identity_set_default,
            identity_remove_profile,
            identity_create_profile,
            identity_import_profile,
            bitcoin_sign_psbt,
            bitcoin_public_key,
            wallet_http,
            #[cfg(target_os = "android")]
            wallet_nwc_load,
            #[cfg(target_os = "android")]
            wallet_nwc_save,
            #[cfg(target_os = "android")]
            wallet_nwc_delete,
            wallet_monero_load,
            wallet_monero_save,
            wallet_monero_cache_load,
            wallet_monero_cache_save,
            identity_create,
            identity_import,
            identity_unlock,
            identity_lock,
            settings_set_keep_unlocked,
            browser_settings,
            clear_cache,
            settings_set_relays,
            settings_set_search,
            settings_set_https,
            settings_set_protection,
            settings_set_protection_exception,
            protection_status,
            protection_filters_status,
            protection_update_filters,
            settings_set_gossip,
            settings_set_tor_on_launch,
            signer_permissions,
            signer_trust,
            site_forget_trust,
            signer_revoke,
            signer_respond
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            let identity = Arc::new(IdentityStore::open(data_dir.join("identity.json")));
            let remote_sessions_dir = data_dir.join("nip46-profiles");
            let profile_prefs = ProfilePrefs::open(data_dir.join("identity-profile-preferences.json"));

            let handle = app.handle().clone();
            let approvals = Arc::new(Approvals::new(move |request: ApprovalRequest| {
                // The shell renders the prompt; it is the only UI that may ask for a
                // passphrase or grant trust.
                let _ = handle.emit("ncc:signer", request);
            }));

            let settings = Arc::new(SettingsStore::open(data_dir.join("config.json")));
            let nccsearch_directory = if cfg!(debug_assertions) {
                Some(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../mobile/public/nccsearch"))
            } else {
                app.path().resource_dir().ok().map(|directory| directory.join("nccsearch"))
            };
            ncc_proxy::protection::set_config(settings.get().protection.clone());
            let filter_cache = data_dir.join("protection");
            ncc_proxy::protection::load_cached_lists(&filter_cache);
            tauri::async_runtime::spawn(async move {
                ncc_proxy::protection::refresh_lists_if_stale(&filter_cache).await;
            });

            // Staying unlocked is a setting, so it applies before anything asks. A file
            // that still needs a passphrase simply stays locked, and says so in status.
            if settings.get().keep_unlocked {
                let envelope = envelope(None);
                match identity.unlock(envelope.as_ref()) {
                    Ok(npub) => println!("[identity] unlocked at startup: {npub}"),
                    Err(error) => eprintln!("[identity] keep-unlocked did not apply: {error}"),
                }
            }
            let proxy = Arc::new(
                ProxyState::new(&proxy_config(Some(data_dir.clone()), Some(settings.clone()), nccsearch_directory.clone()))
                    .with_signer(identity.clone(), approvals.clone()),
            );

            // A failure here must not take the shell down with it: the app is still
            // usable to show why the proxy could not start.
            // Normal tabs keep their web storage across launches by keeping the port.
            let port_file = data_dir.join("proxy-port");
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                start_proxy(proxy.clone(), remembered_port(&port_file))
            }));
            let port = match outcome {
                Ok(Ok(port)) => {
                    remember_port(&port_file, port);
                    println!("[proxy] listening on 127.0.0.1:{port}");
                    Some(port)
                }
                Ok(Err(error)) => {
                    eprintln!("[proxy] could not start: {error}");
                    None
                }
                Err(_) => {
                    eprintln!("[proxy] panicked while starting");
                    None
                }
            };

            // Private tabs: the same proxy, minus every cache and with a key that exists
            // only in memory. Nothing a private tab does is written down.
            let private_proxy = Arc::new(
                ProxyState::new(&proxy_config(None, Some(settings.clone()), None)).with_signer(
                    Arc::new(IdentityStore::ephemeral()),
                    approvals.clone(),
                ),
            );
            let private_port = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                start_proxy(private_proxy.clone(), None)
            }))
            .ok()
            .and_then(Result::ok);

            match private_port {
                Some(port) => println!("[proxy] private listener on 127.0.0.1:{port}"),
                None => eprintln!("[proxy] could not start the private listener"),
            }

            // Tor tabs: the local SOCKS endpoint starts here and resolves its route in
            // the background. Failing to bind it is not fatal — the rest of the app
            // works, and the Tor status says what happened.
            let (tor_mode, tor_socks) = settings.tor();
            let tor = tauri::async_runtime::block_on(Tor::start(tor_config(
                &data_dir,
                tor_mode,
                tor_socks,
            )))
            .map_err(|error| {
                eprintln!("[tor] could not start the endpoint: {error}");
                error
            })
            .ok();

            // Start building the route now, so the first Tor tab finds it ready instead
            // of waiting on bootstrap. `prepare` is idempotent and returns at once.
            if settings.get().tor_on_launch {
                if let Some(tor) = tor.as_ref() {
                    tor.prepare();
                }
            }

            let mut tor_state: Option<Arc<ProxyState>> = None;
            let tor_port = tor.as_ref().and_then(|tor| {
                let mut config = proxy_config(None, Some(settings.clone()), None);
                config.tor_proxy = Some(tor.socks_url().to_string());
                config.tor_progress = Some(Arc::new(TorProgressFeed(tor.clone())));
                let listener = Arc::new(
                    ProxyState::new(&config).with_signer(
                        Arc::new(IdentityStore::ephemeral()),
                        approvals.clone(),
                    ),
                );
                tor_state = Some(listener.clone());
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    start_proxy(listener, None)
                })) {
                    Ok(Ok(port)) => {
                        println!("[proxy] Tor listener on 127.0.0.1:{port}");
                        Some(port)
                    }
                    _ => {
                        eprintln!("[proxy] could not start the Tor listener");
                        None
                    }
                }
            });

            let _ = SIGNER_ROUTES.set(SignerRoutes {
                normal: proxy.clone(),
                private: Some(private_proxy.clone()),
                tor: tor_state,
            });

            app.manage(ProxyPort(port));
            app.manage(PrivateProxyPort(private_port));
            let vault_service = Arc::new(VaultService::new(
                identity.clone(),
                settings.clone(),
                data_dir.join("vault").join("cache.json"),
            ));

            app.manage(SyncHandle(Arc::new(ncc_proxy::sync::SyncService::new(
                identity.clone(),
                settings.clone(),
            ))));
            app.manage(ShareHandle(Arc::new(ncc_proxy::share::ShareService::new(
                identity.clone(),
                settings.clone(),
            ))));
            app.manage(TorProxyPort(tor_port));
            app.manage(VaultHandle(vault_service));
            app.manage(TorHandle(tor));
            app.manage(AppDataDir(data_dir.clone()));
            app.manage(SignerState {
                identity,
                approvals,
                proxy,
                sessions: ncc_proxy::bunker::Sessions::open(data_dir.join("nip46-session.json")),
                remote_sessions_dir,
                remote_profiles: Mutex::new(std::collections::HashMap::new()),
                profile_prefs,
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ncc-port-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_free_preferred_port_is_reused() {
        // Find a free port, release it, then ask for it.
        let probe = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("probe");
        let port = probe.local_addr().expect("addr").port();
        drop(probe);

        let listener = bind_loopback(Some(port)).expect("bind");
        assert_eq!(listener.local_addr().expect("addr").port(), port);
    }

    #[test]
    fn a_taken_preferred_port_falls_back_to_another() {
        let taken = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("taken");
        let port = taken.local_addr().expect("addr").port();

        let listener = bind_loopback(Some(port)).expect("bind");
        assert_ne!(listener.local_addr().expect("addr").port(), port);
    }

    #[test]
    fn no_preference_still_binds() {
        assert!(bind_loopback(None).is_ok());
        assert!(bind_loopback(Some(0)).is_ok());
    }

    #[test]
    fn the_port_survives_a_restart_and_junk_is_ignored() {
        let dir = scratch("file");
        let file = dir.join("proxy-port");

        assert_eq!(remembered_port(&file), None);
        remember_port(&file, 48_123);
        assert_eq!(remembered_port(&file), Some(48_123));

        // A privileged or malformed value is not trusted.
        std::fs::write(&file, "80").expect("write");
        assert_eq!(remembered_port(&file), None);
        std::fs::write(&file, "not a port").expect("write");
        assert_eq!(remembered_port(&file), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Both TLS back-ends are linked (aws-lc-rs for the proxy, ring for arti), so rustls
    /// has no default of its own and anything that asks for one panics. A relay
    /// connection is the first such thing to run when the app returns from the
    /// background. Building the proxy state, as the app does first, must be enough.
    #[tokio::test]
    async fn relay_tls_survives_two_linked_back_ends() {
        let _state = ncc_proxy::ProxyState::new(&ncc_proxy::ProxyConfig::default());

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            // Accept and say nothing: the TLS config is built once the TCP side is up.
            let _held = listener.accept().await;
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        });

        // The handshake cannot succeed against a silent socket. What matters is that
        // building the TLS config did not panic.
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            tokio_tungstenite::connect_async(format!("wss://127.0.0.1:{port}/")),
        )
        .await;
        assert!(result.is_err() || result.unwrap().is_err());
    }
}
