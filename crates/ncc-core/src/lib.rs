//! Platform-neutral core for the NCC address space.
//!
//! This crate is deliberately free of any runtime, transport or UI dependency. It
//! answers the questions that must have the same answer on every shell (Electron,
//! Tauri, Android, a test binary):
//!
//! * what does an `ncc://` address mean, in both its display and host forms;
//! * which `d` tags may satisfy a requested service;
//! * which endpoints a locator offers, and which one a request should use;
//! * how an endpoint request and its redirects map back into the NCC namespace.
//!
//! Nothing here performs I/O. A shell supplies relays, sockets and a clock; this
//! crate supplies the rules. That split is what lets the TypeScript implementation
//! (`src/shared`, `src/main/ncc`) and the Rust one be checked against the same
//! fixtures instead of drifting.

pub mod address;
pub mod base32;
pub mod locator;
pub mod nsite;
pub mod routing;
pub mod transport;

/// The service an identity serves when none is named. `ncc://<npub>/` means this.
pub const DEFAULT_SERVICE: &str = "addr";

pub use address::{
    build_internal_url, build_ncc_url, decode_service_label, display_address, encode_service_label,
    is_nostr_id, is_valid_service_name, looks_like_ncc_input, ncc_storage_origin,
    parse_ncc_address, parse_ncc_host, to_display_url, to_internal_url, BuildAddress, NccAddress,
    NccHost, NccUrlError,
};
pub use locator::{
    candidate_d_tags, d_tag_source, is_relay_endpoint, is_secure_endpoint, normalize_endpoints,
    parse_payload, payload_expiry, select_relay_endpoint, sort_endpoints, DTagSource, Endpoint,
    EndpointFamily, Payload, RelayEndpointRejection, RelayEndpointSelection, DEFAULT_D_TAG,
    DEFAULT_PRIORITY,
};
pub use nsite::{
    aggregate_hash, content_type_for, is_valid_site_id, match_path, mime_for_path, nsite_host,
    parse_nsite_address, NsiteAddress, PathMatch, NSITE_NAMED_KIND, NSITE_ROOT_KIND,
};
pub use routing::{http_origin, join_paths, rewrite_location, upstream_headers, RewriteContext};
pub use transport::{
    has_onion_endpoint, select_transport_endpoints, sort_candidates_for_https, HttpsMode,
    TransportPolicy, TransportSelection,
};
