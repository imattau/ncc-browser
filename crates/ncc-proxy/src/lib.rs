//! A loopback NCC proxy.
//!
//! Android cannot register `ncc://` as a WebView scheme, so the shell maps the
//! origin onto a virtual host instead:
//!
//! ```text
//! ncc://npub1abc….zap.stream/watch   ← what the user types and sees
//! http://npub1abc….zap.stream.localhost:47822/watch
//! ```
//!
//! The service stays a hostname label, so it is still part of the origin: storage,
//! cookies and service workers stay per-service, exactly as `ncc://` gives the
//! desktop build.
//!
//! This crate is the part that needs a socket: relay queries, upstream fetches and
//! the HTTP server. Everything that decides *what* to fetch lives in `ncc-core`, so
//! the two implementations can be checked against the same rules.

pub mod approvals;
pub mod cache;
pub mod inject;
pub mod nsite;
pub mod pins;
pub mod relay;
pub mod resolve;
pub mod server;
pub mod settings;
pub mod signer;
pub mod vhost;

pub use approvals::{ApprovalRequest, Approvals};
pub use inject::{Injection, TokenStore};
pub use pins::PinStore;
pub use resolve::{DiscoveredService, ResolveError, ResolvedService, Resolver};
pub use server::{serve, ProxyConfig, ProxyState};
pub use settings::{HttpsMode, Settings, SettingsStore};
pub use vhost::{host_for, parse_vhost, Vhost};

use std::sync::{Mutex, MutexGuard};

/// Lock a mutex, recovering from poisoning.
///
/// This process lives as long as the app and serves every tab. If a request panics
/// while holding one of these locks, the next request must not panic on the poisoned
/// lock as well: one bad page would otherwise break the proxy until the app restarts.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
