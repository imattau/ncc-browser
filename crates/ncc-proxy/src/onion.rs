//! Onion documents, fetched over Tor and served as a virtual host.
//!
//! A `WebView` has no SOCKS setting, so a Tor tab never speaks to the onion itself.
//! The tab loads `http://<onion>.onion.localhost:<port>/…`, this module fetches the
//! same path over Tor, and the result is rewritten so that every link stays inside
//! this namespace.
//!
//! Three rules matter here, and each is enforced rather than documented:
//!
//! * **Names are never resolved locally.** The request goes to a `socks5h` endpoint,
//!   so `.onion` reaches Tor as a name.
//! * **Clearnet is never fetched.** A link to the clearnet is replaced with a blocked
//!   page, and the `Content-Security-Policy` added to every document confines
//!   subresources and scripts to this origin. That is the closest Android gets to the
//!   desktop's request cancelling: the WebView cannot be told to cancel, so the
//!   document is not allowed to ask.
//! * **Nothing is left on disk.** Responses carry `no-store`, and the listener that
//!   runs this module has no cache directory at all.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use lol_html::html_content::ContentType;
use lol_html::{element, rewrite_str, text, RewriteStrSettings};
use url::Url;

use ncc_core::is_onion_host;

use crate::server::{inject_shim, is_document_request, request_headers, ProxyState, TorProgress};
use crate::vhost::Vhost;

/// Documents above this are handed through untouched. Rewriting means holding the
/// whole body, so the limit is the same one the NCC injection path uses.
const MAX_REWRITE_BYTES: usize = 5 * 1024 * 1024;

const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// The policy every onion document is served with.
///
/// `'self'` is the onion vhost. Inline scripts are allowed because rewriting a page
/// without breaking it requires that; external scripts are not, which is what stops
/// a page from fetching a clearnet resource and revealing the reader's address.
fn policy() -> &'static str {
    "default-src 'self'; \
     script-src 'self' 'unsafe-inline' 'unsafe-eval'; \
     style-src 'self' 'unsafe-inline'; \
     img-src 'self' data: blob:; \
     font-src 'self' data:; \
     media-src 'self' data: blob:; \
     connect-src 'self'; \
     frame-src 'self'; \
     worker-src 'self' blob:; \
     form-action 'self'; \
     base-uri 'none'; \
     object-src 'none'"
}

/// Where rewritten references should point.
#[derive(Debug, Clone)]
struct Context {
    port: Option<u16>,
}

impl Context {
    fn new(authority: &str) -> Self {
        let port = authority
            .rsplit_once(':')
            .and_then(|(_, port)| port.parse::<u16>().ok());
        Self { port }
    }

    fn origin(&self, onion: &str) -> String {
        match self.port {
            Some(port) => format!("http://{onion}.onion.localhost:{port}"),
            None => format!("http://{onion}.onion.localhost"),
        }
    }
}

/// Onions that only answer over https, remembered for this process.
///
/// A v3 onion address is the service's key, so Tor already authenticates and encrypts
/// the path and plain http is the common case. Some services (DuckDuckGo's among them)
/// refuse it and redirect to https, which would otherwise loop: the redirect is
/// rewritten back onto this http vhost. Holding only host names in memory keeps the
/// "nothing is left on disk" rule.
fn https_only() -> &'static Mutex<HashSet<String>> {
    static HOSTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    HOSTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn is_https_only(site: &str) -> bool {
    https_only()
        .lock()
        .map(|hosts| hosts.contains(site))
        .unwrap_or(false)
}

fn remember_https_only(site: &str) {
    if let Ok(mut hosts) = https_only().lock() {
        hosts.insert(site.to_string());
    }
}

/// Whether a redirect from the http onion points at the same onion over https.
fn redirects_to_https(response: &reqwest::Response, site: &str) -> bool {
    let location = response
        .headers()
        .get(header::LOCATION)
        .and_then(|value| value.to_str().ok());
    is_https_upgrade(response.status(), location, site)
}

fn is_https_upgrade(status: StatusCode, location: Option<&str>, site: &str) -> bool {
    if !status.is_redirection() {
        return false;
    }
    location
        .and_then(|location| Url::parse(location).ok())
        .is_some_and(|url| {
            url.scheme() == "https"
                && url
                    .host_str()
                    .is_some_and(|host| host.eq_ignore_ascii_case(site))
        })
}

/// What a tab shows while Tor is still being set up, or when it could not be.
fn connecting_page(progress: &TorProgress) -> Response {
    let (title, detail, refresh) = match progress {
        TorProgress::Starting { percent } if *percent > 0 => (
            "Connecting to Tor".to_string(),
            format!("Building a connection… {percent}%. This page loads on its own."),
            true,
        ),
        TorProgress::Starting { .. } => (
            "Starting Tor".to_string(),
            "Getting ready to connect. This page loads on its own.".to_string(),
            true,
        ),
        TorProgress::Failed { reason } => (
            "Tor could not start".to_string(),
            format!(
                "{} Check Settings → Tor, or switch to an external Tor such as Orbot.",
                escape(reason)
            ),
            false,
        ),
        TorProgress::Ready => ("Tor is ready".to_string(), String::new(), true),
    };

    let refresh = if refresh {
        "<meta http-equiv=\"refresh\" content=\"2\">"
    } else {
        ""
    };
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <meta name=\"color-scheme\" content=\"light dark\">{refresh}\
         <title>{title}</title>\
         <style>body{{font:16px/1.5 system-ui,sans-serif;margin:0;padding:18vh 28px 28px;\
         max-width:34rem;margin-inline:auto;text-align:center}}\
         h1{{font-size:1.3rem;margin:0 0 .5rem}}p{{opacity:.75;margin:0}}\
         .dot{{width:14px;height:14px;margin:0 auto 1.2rem;border-radius:50%;\
         background:#a855f7;animation:p 1.2s ease-in-out infinite}}\
         @keyframes p{{50%{{transform:scale(1.6);opacity:.35}}}}</style>\
         <div class=\"dot\"></div><h1>{title}</h1><p>{detail}</p>"
    );

    let mut response = Html(body).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

// The pieces are all distinct and each is used as-is; a parameter struct would only
// move the same names one level down.
#[allow(clippy::too_many_arguments)]
pub async fn serve(
    state: &ProxyState,
    vhost: &Vhost,
    authority: &str,
    path: &str,
    search: &str,
    method: &Method,
    headers: &HeaderMap,
    body: &[u8],
) -> Response {
    let Some(site) = vhost.onion.clone() else {
        return page(
            StatusCode::BAD_REQUEST,
            "Not an onion host",
            "This listener only serves onion sites.",
        );
    };

    // Building the first circuit takes a while, and the tab would sit blank for all of
    // it. A page load gets a page that says what is happening and reloads itself;
    // subresources fall through and simply wait, as they do once the page is real.
    if is_document_request(headers) {
        match state.tor_progress() {
            Some(TorProgress::Ready) | None => {}
            Some(other) => return connecting_page(&other),
        }
    }

    let query_part = if search.is_empty() {
        String::new()
    } else {
        format!("?{search}")
    };

    // Plain http first: most onions serve it, and there is no CA for the address
    // itself, so it is not a downgrade. A service that redirects to https, or does not
    // listen on port 80 at all, is switched to https (verified against the web roots)
    // and remembered, so the next request goes straight there.
    let client = state.tor_client().expect("the Tor listener has a client");
    let send = |scheme: &str| {
        let target = format!("{scheme}://{site}{path}{query_part}");
        let url = Url::parse(&target).map_err(|_| target.clone());
        let upstream = url.as_ref().ok().map(|url| {
            let mut upstream = request_headers(headers, url, true);
            // Documents and stylesheets are rewritten, which needs the text, not a
            // compressed stream.
            upstream.remove(header::ACCEPT_ENCODING);
            upstream
        });
        let method = method.clone();
        async move {
            let (Ok(url), Some(upstream)) = (url, upstream) else {
                return Err(None);
            };
            let mut request = client.request(method.clone(), url).headers(upstream);
            if !matches!(method, Method::GET | Method::HEAD) && !body.is_empty() {
                request = request.body(body.to_vec());
            }
            request.send().await.map_err(Some)
        }
    };

    let first = if is_https_only(&site) {
        "https"
    } else {
        "http"
    };
    let mut result = send(first).await;

    if first == "http" {
        let upgrade = match &result {
            Ok(response) => redirects_to_https(response, &site),
            Err(_) => true,
        };
        if upgrade {
            // An https attempt that also failed says less than the http one did, so
            // the first answer is kept in that case.
            if let Ok(response) = send("https").await {
                remember_https_only(&site);
                result = Ok(response);
            }
        }
    }

    let response = match result {
        Ok(response) => response,
        Err(Some(error)) => {
            return page(
                StatusCode::BAD_GATEWAY,
                "Tor could not load this onion site",
                &error.to_string(),
            )
        }
        Err(None) => {
            return page(
                StatusCode::BAD_REQUEST,
                "Bad onion URL",
                &format!("{site}{path}"),
            )
        }
    };

    let status = response.status();
    let context = Context::new(authority);
    let mut outgoing = HeaderMap::new();

    for (name, value) in response.headers() {
        let name_text = name.as_str().to_ascii_lowercase();
        if HOP_BY_HOP.contains(&name_text.as_str()) {
            continue;
        }

        // The policy below replaces whatever the site said. Two policies would
        // intersect, and the site's one usually assumes the real origin.
        if name_text.starts_with("content-security-policy")
            || name_text == "strict-transport-security"
            || name_text == "report-to"
            || name_text == "nel"
        {
            continue;
        }

        if name_text == "location" {
            if let Ok(location) = value.to_str() {
                if let Ok(rewritten) = HeaderValue::from_str(&rewrite_location(location, &context))
                {
                    outgoing.insert(header::LOCATION, rewritten);
                }
            }
            continue;
        }

        // A `Domain=.onion` cookie cannot match the vhost, so it would be dropped and
        // every onion login would silently fail. Dropping the attribute makes the
        // cookie host-only, which is exactly the scope we want.
        if name_text == "set-cookie" {
            if let Ok(cookie) = value.to_str() {
                if let Ok(rewritten) = HeaderValue::from_str(&strip_cookie_domain(cookie)) {
                    outgoing.append(header::SET_COOKIE, rewritten);
                }
            }
            continue;
        }

        outgoing.append(name.clone(), value.clone());
    }

    outgoing.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    outgoing.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    outgoing.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(policy()),
    );
    outgoing.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    outgoing.remove(header::CONTENT_LENGTH);
    outgoing.remove(header::ETAG);
    outgoing.remove(header::LAST_MODIFIED);

    let content_type = outgoing
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let is_html =
        content_type.starts_with("text/html") || content_type.starts_with("application/xhtml");
    let is_css = content_type.starts_with("text/css");

    if (is_html || is_css)
        && response
            .content_length()
            .map(|length| length as usize <= MAX_REWRITE_BYTES)
            .unwrap_or(true)
    {
        let Ok(bytes) = response.bytes().await else {
            return page(
                StatusCode::BAD_GATEWAY,
                "The onion site stopped responding",
                "",
            );
        };
        if bytes.len() > MAX_REWRITE_BYTES {
            return builder(status, outgoing)
                .body(Body::from(bytes))
                .unwrap_or_else(|_| {
                    page(StatusCode::BAD_GATEWAY, "Could not build the response", "")
                });
        }

        let text = String::from_utf8_lossy(&bytes);
        let rewritten = if is_html {
            let rewritten = rewrite_html(&text, &context);
            // The NIP-07 shim is injected here for the same reason as on NCC pages:
            // the site should see `window.nostr`. It signs with the ephemeral key the
            // Tor listener was built with, never the real identity.
            inject_shim(state, vhost, &rewritten).0
        } else {
            rewrite_css(&text, &context)
        };

        return builder(status, outgoing)
            .body(Body::from(rewritten))
            .unwrap_or_else(|_| page(StatusCode::BAD_GATEWAY, "Could not build the response", ""));
    }

    builder(status, outgoing)
        .body(Body::from_stream(response.bytes_stream()))
        .unwrap_or_else(|_| page(StatusCode::BAD_GATEWAY, "Could not build the response", ""))
}

fn builder(status: StatusCode, headers: HeaderMap) -> axum::http::response::Builder {
    let mut builder = Response::builder().status(status);
    if let Some(out) = builder.headers_mut() {
        *out = headers;
    }
    builder
}

/// Redirects stay inside Tor: another onion becomes another vhost, and anything else
/// becomes the blocked page rather than a request the tab would make itself.
fn rewrite_location(location: &str, context: &Context) -> String {
    let Ok(url) = Url::parse(location) else {
        // A relative Location resolves against the current vhost, which is correct.
        return location.to_string();
    };
    if !matches!(url.scheme(), "http" | "https") {
        return blocked(location);
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if !is_onion_host(&host) {
        return blocked(location);
    }
    let mut target = context.origin(&host);
    target.push_str(url.path());
    if let Some(query) = url.query() {
        target.push('?');
        target.push_str(query);
    }
    if let Some(fragment) = url.fragment() {
        target.push('#');
        target.push_str(fragment);
    }
    target
}

/// `Domain=…` is removed so the cookie is stored for the vhost rather than rejected.
fn strip_cookie_domain(cookie: &str) -> String {
    cookie
        .split(';')
        .filter(|part| {
            let lower = part.trim().to_ascii_lowercase();
            !lower.starts_with("domain=")
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// Rewrite every reference in a document into this listener's namespace.
fn rewrite_html(html: &str, context: &Context) -> String {
    let elements = context.clone();
    let styles = context.clone();
    let settings = RewriteStrSettings::new()
        .append_element_content_handler(element!("*", move |el| {
            let tag = el.tag_name();

            // A `<base>` would silently change what a relative link means, and
            // the rewriting assumes the document's own address.
            if tag == "base" {
                el.remove();
                return Ok(());
            }

            if tag == "meta" {
                let equiv = el
                    .get_attribute("http-equiv")
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if equiv == "content-security-policy"
                    || equiv == "content-security-policy-report-only"
                {
                    el.remove();
                    return Ok(());
                }
                if equiv == "refresh" {
                    if let Some(content) = el.get_attribute("content") {
                        let value = rewrite_refresh(&content, &elements);
                        if value != content {
                            el.set_attribute("content", &value).ok();
                        }
                    }
                }
            }

            for attribute in ["href", "src", "action", "poster", "data", "formaction"] {
                let Some(value) = el.get_attribute(attribute) else {
                    continue;
                };
                let next = rewrite_reference(&value, &elements);
                if next != value {
                    el.set_attribute(attribute, &next).ok();
                }
            }

            if let Some(srcset) = el.get_attribute("srcset") {
                let next = rewrite_srcset(&srcset, &elements);
                if next != srcset {
                    el.set_attribute("srcset", &next).ok();
                }
            }

            if let Some(style) = el.get_attribute("style") {
                let next = rewrite_css(&style, &elements);
                if next != style {
                    el.set_attribute("style", &next).ok();
                }
            }

            Ok(())
        }))
        .append_element_content_handler(text!("style", move |chunk| {
            let value = chunk.as_str();
            let next = rewrite_css(value, &styles);
            if next != value {
                chunk.replace(&next, ContentType::Text);
            }
            Ok(())
        }));

    rewrite_str(html, settings).unwrap_or_else(|_| html.to_string())
}

/// Rewrite a single URL reference. Anything that is not an onion URL becomes the
/// blocked page, because letting the tab fetch it directly is the leak this whole
/// module exists to prevent.
fn rewrite_reference(value: &str, context: &Context) -> String {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();

    if trimmed.is_empty() || trimmed.starts_with('#') {
        return value.to_string();
    }
    for inert in [
        "javascript:",
        "data:",
        "blob:",
        "about:",
        "mailto:",
        "tel:",
        "magnet:",
    ] {
        if lower.starts_with(inert) {
            return value.to_string();
        }
    }

    let rest = if let Some(rest) = trimmed.strip_prefix("//") {
        rest
    } else if lower.starts_with("http://") {
        &trimmed[7..]
    } else if lower.starts_with("https://") {
        &trimmed[8..]
    } else {
        // A relative reference already resolves to the vhost.
        return value.to_string();
    };

    let (authority, tail) = split_authority(rest);
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let authority = authority
        .rsplit_once(':')
        .filter(|(_, port)| port.parse::<u16>().is_ok())
        .map(|(host, _)| host)
        .unwrap_or(authority)
        .to_ascii_lowercase();

    if !is_onion_host(&authority) {
        return blocked(value);
    }

    let mut target = context.origin(&authority);
    target.push_str(tail);
    target
}

fn split_authority(value: &str) -> (&str, &str) {
    let end = value.find(['/', '?', '#']).unwrap_or(value.len());
    (&value[..end], &value[end..])
}

fn rewrite_srcset(value: &str, context: &Context) -> String {
    value
        .split(',')
        .map(|part| {
            let trimmed = part.trim_start();
            let leading = part.len() - trimmed.len();
            let end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
            let (url, descriptor) = trimmed.split_at(end);
            format!(
                "{}{}{}",
                " ".repeat(leading),
                rewrite_reference(url, context),
                descriptor
            )
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn rewrite_refresh(value: &str, context: &Context) -> String {
    // `5; url=/next` and `0;URL='http://…'` are both common.
    let Some((delay, rest)) = value.split_once(';') else {
        return value.to_string();
    };
    let rest = rest.trim();
    let Some((_, target)) = rest.split_once('=') else {
        return value.to_string();
    };
    let target = target.trim().trim_matches(['\'', '"']);
    format!("{delay}; url={}", rewrite_reference(target, context))
}

/// Rewrite `url(…)` and quoted `@import` references in a stylesheet.
fn rewrite_css(css: &str, context: &Context) -> String {
    let lower = css.to_ascii_lowercase();
    let bytes = css.as_bytes();
    let mut out = String::with_capacity(css.len());
    let mut index = 0;

    while index < css.len() {
        let Some(offset) = lower[index..].find("url(") else {
            out.push_str(&css[index..]);
            break;
        };
        let opening = index + offset + 4;
        out.push_str(&css[index..opening]);

        let mut cursor = opening;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        let quote = match bytes.get(cursor) {
            Some(b'\'') => Some(b'\''),
            Some(b'"') => Some(b'"'),
            _ => None,
        };
        if quote.is_some() {
            cursor += 1;
        }
        let start = cursor;
        let terminator = quote.unwrap_or(b')');
        while cursor < bytes.len() && bytes[cursor] != terminator {
            cursor += 1;
        }
        out.push_str(&rewrite_reference(&css[start..cursor], context));

        if quote.is_some() && cursor < bytes.len() {
            out.push(terminator as char);
            cursor += 1;
        }
        if bytes.get(cursor) == Some(&b')') {
            cursor += 1;
        }
        out.push(')');
        index = cursor;
    }

    rewrite_imports(&out, context)
}

fn rewrite_imports(css: &str, context: &Context) -> String {
    let lower = css.to_ascii_lowercase();
    let bytes = css.as_bytes();
    let mut out = String::with_capacity(css.len());
    let mut index = 0;

    while index < css.len() {
        let Some(offset) = lower[index..].find("@import") else {
            out.push_str(&css[index..]);
            break;
        };
        let start = index + offset + "@import".len();
        out.push_str(&css[index..start]);

        let mut cursor = start;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        let quote = match bytes.get(cursor) {
            Some(b'\'') => Some(b'\''),
            Some(b'"') => Some(b'"'),
            _ => None,
        };
        let Some(quote) = quote else {
            index = start;
            continue;
        };
        cursor += 1;
        let value_start = cursor;
        while cursor < bytes.len() && bytes[cursor] != quote {
            cursor += 1;
        }
        out.push(quote as char);
        out.push_str(&rewrite_reference(&css[value_start..cursor], context));
        if cursor < bytes.len() {
            out.push(quote as char);
            cursor += 1;
        }
        index = cursor;
    }

    out
}

fn blocked(value: &str) -> String {
    format!(
        "/__ncc/blocked?u={}",
        url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>()
    )
}

/// The page a clearnet reference lands on. It is same-origin, so the policy allows
/// it, and it never fetches what it names.
pub fn blocked_page(query: &str) -> Response {
    let target = url::form_urlencoded::parse(query.as_bytes())
        .find(|(name, _)| name == "u")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();

    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Blocked in a Tor tab</title>\
         <style>body{{font:15px system-ui;margin:2rem;max-width:40rem}}\
         code{{background:#eee;padding:.1rem .3rem;border-radius:3px;word-break:break-all}}</style>\
         <h1>Not loaded</h1>\
         <p>A Tor tab loads onion sites only. Fetching this would have gone through \
         your connection instead of Tor, which would tell the site and your network \
         where you are.</p>\
         <p>If you meant to open it, paste the address into a normal tab.</p>\
         <p><code>{}</code></p>",
        escape(&target)
    );

    (StatusCode::FORBIDDEN, Html(body)).into_response()
}

/// Shown when an onion address is opened on the listener that has no Tor client.
pub fn needs_tor_page(authority: &str) -> Response {
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Open this in a Tor tab</title>\
         <style>body{{font:15px system-ui;margin:2rem;max-width:40rem}}\
         code{{background:#eee;padding:.1rem .3rem;border-radius:3px}}</style>\
         <h1>This is an onion address</h1>\
         <p>It has to be loaded through Tor, which this tab does not use. Open a \
         Tor tab and load <code>{}</code> there.</p>",
        escape(authority)
    );

    (StatusCode::BAD_REQUEST, Html(body)).into_response()
}

/// Shown when the Tor listener is asked for something that is not an onion.
pub fn not_onion_page() -> Response {
    page(
        StatusCode::FORBIDDEN,
        "This listener serves onion sites only",
        "Open NCC addresses and nsites in a normal tab.",
    )
}

fn page(status: StatusCode, title: &str, detail: &str) -> Response {
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{title}</title>\
         <style>body{{font:15px system-ui;margin:2rem;max-width:40rem}}\
         code{{background:#eee;padding:.1rem .3rem;border-radius:3px;word-break:break-all}}</style>\
         <h1>{title}</h1><p><code>{}</code></p>",
        escape(detail)
    );
    (status, Html(body)).into_response()
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SITE: &str = "duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion";
    const OTHER: &str = "abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx.onion";

    fn context() -> Context {
        Context::new("127.0.0.1:47822")
    }

    #[test]
    fn onion_links_stay_on_their_own_vhost() {
        let context = context();
        assert_eq!(
            rewrite_reference(&format!("http://{SITE}/x?y=1"), &context),
            format!("http://{SITE}.onion.localhost:47822/x?y=1")
        );
        assert_eq!(
            rewrite_reference(&format!("https://{OTHER}/"), &context),
            format!("http://{OTHER}.onion.localhost:47822/")
        );
    }

    #[test]
    fn relative_and_inert_references_are_left_alone() {
        let context = context();
        for value in [
            "/path",
            "path/page",
            "?q=1",
            "#anchor",
            "data:image/png;base64,AAAA",
            "javascript:void(0)",
            "mailto:someone@example.org",
        ] {
            assert_eq!(rewrite_reference(value, &context), value);
        }
    }

    #[test]
    fn clearnet_becomes_a_blocked_reference() {
        let context = context();
        let rewritten = rewrite_reference("https://example.com/a?b=1", &context);
        assert!(rewritten.starts_with("/__ncc/blocked?u="));
        assert!(!rewritten.contains("example.com/"));
    }

    #[test]
    fn documents_lose_base_and_their_own_policy() {
        let html = format!(
            "<html><head><base href=\"https://example.com/\">\
             <meta http-equiv=\"Content-Security-Policy\" content=\"default-src *\">\
             <style>body{{background:url(\"/bg.png\")}}</style></head>\
             <body><a href=\"http://{SITE}/next\">next</a>\
             <img src=\"https://tracker.example/p.gif\">\
             <img srcset=\"/a.png 1x, https://tracker.example/b.png 2x\"></body></html>"
        );
        let rewritten = rewrite_html(&html, &context());

        assert!(!rewritten.contains("<base"));
        assert!(!rewritten.contains("Content-Security-Policy"));
        assert!(rewritten.contains(&format!("http://{SITE}.onion.localhost:47822/next")));
        assert!(rewritten.contains("/__ncc/blocked?u=https%3A%2F%2Ftracker.example"));
        assert!(rewritten.contains("/bg.png"));
    }

    #[test]
    fn stylesheets_only_keep_onion_references() {
        let css = format!(
            "@import \"http://{SITE}/a.css\";\
             body{{background:url(/local.png)}}\
             .x{{background:url('https://example.com/x.png')}}\
             .y{{background:url(http://{OTHER}/y.png)}}"
        );
        let rewritten = rewrite_css(&css, &context());

        assert!(rewritten.contains(&format!("http://{SITE}.onion.localhost:47822/a.css")));
        assert!(rewritten.contains("url(/local.png)"));
        assert!(rewritten.contains("/__ncc/blocked"));
        assert!(rewritten.contains(&format!("http://{OTHER}.onion.localhost:47822/y.png")));
    }

    #[test]
    fn refresh_points_at_the_vhost() {
        let rewritten = rewrite_refresh(&format!("0; url=http://{SITE}/moved"), &context());
        assert_eq!(
            rewritten,
            format!("0; url=http://{SITE}.onion.localhost:47822/moved")
        );
    }

    #[test]
    fn cookie_domains_are_dropped_so_they_match_the_vhost() {
        assert_eq!(
            strip_cookie_domain("session=abc; Domain=.onion; Path=/; Secure; HttpOnly"),
            "session=abc; Path=/; Secure; HttpOnly"
        );
    }

    #[test]
    fn every_document_forbids_external_resources() {
        let policy = policy();
        assert!(policy.contains("default-src 'self'"));
        assert!(policy.contains("connect-src 'self'"));
        assert!(policy.contains("base-uri 'none'"));
        assert!(!policy.contains("https:"));
    }

    #[test]
    fn a_blocked_reference_is_answered_by_this_process() {
        let query =
            url::form_urlencoded::byte_serialize(b"https://example.com/secret").collect::<String>();
        let response = blocked_page(&format!("u={query}"));
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn an_https_redirect_to_the_same_onion_is_an_upgrade() {
        assert!(is_https_upgrade(
            StatusCode::MOVED_PERMANENTLY,
            Some(&format!("https://{SITE}/?q=x")),
            SITE
        ));
        assert!(is_https_upgrade(
            StatusCode::PERMANENT_REDIRECT,
            Some(&format!("HTTPS://{}/a", SITE.to_ascii_uppercase())),
            SITE
        ));
    }

    #[test]
    fn other_redirects_are_not_an_upgrade() {
        // Another onion, clearnet, the same scheme, a relative path, no Location, or
        // not a redirect at all.
        assert!(!is_https_upgrade(
            StatusCode::MOVED_PERMANENTLY,
            Some(&format!("https://{OTHER}/")),
            SITE
        ));
        assert!(!is_https_upgrade(
            StatusCode::FOUND,
            Some("https://example.com/"),
            SITE
        ));
        assert!(!is_https_upgrade(
            StatusCode::FOUND,
            Some(&format!("http://{SITE}/next")),
            SITE
        ));
        assert!(!is_https_upgrade(StatusCode::FOUND, Some("/next"), SITE));
        assert!(!is_https_upgrade(StatusCode::FOUND, None, SITE));
        assert!(!is_https_upgrade(
            StatusCode::OK,
            Some(&format!("https://{SITE}/")),
            SITE
        ));
    }

    #[test]
    fn https_only_onions_are_remembered() {
        const REMEMBERED: &str = "rememberedrememberedrememberedrememberedremembered2.onion";
        assert!(!is_https_only(REMEMBERED));
        remember_https_only(REMEMBERED);
        assert!(is_https_only(REMEMBERED));
    }

    async fn page_text(progress: &TorProgress) -> String {
        let response = connecting_page(progress);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("body");
        String::from_utf8(bytes.to_vec()).expect("utf8")
    }

    #[tokio::test]
    async fn the_connecting_page_shows_progress_and_reloads_itself() {
        let waiting = page_text(&TorProgress::Starting { percent: 45 }).await;
        assert!(waiting.contains("Connecting to Tor"));
        assert!(waiting.contains("45%"));
        assert!(waiting.contains("http-equiv=\"refresh\""));

        let idle = page_text(&TorProgress::Starting { percent: 0 }).await;
        assert!(idle.contains("Starting Tor"));
        assert!(idle.contains("http-equiv=\"refresh\""));
    }

    #[tokio::test]
    async fn a_failed_start_says_why_and_stops_reloading() {
        let failed = page_text(&TorProgress::Failed {
            reason: "Tor could not bootstrap: <timed out>".to_string(),
        })
        .await;
        assert!(failed.contains("Tor could not start"));
        // The reason is text, not markup.
        assert!(failed.contains("&lt;timed out&gt;"));
        assert!(!failed.contains("<timed out>"));
        assert!(!failed.contains("http-equiv=\"refresh\""));
    }

    #[derive(Debug)]
    struct Fixed(TorProgress);

    impl crate::server::TorProgressSource for Fixed {
        fn progress(&self) -> TorProgress {
            self.0.clone()
        }
    }

    /// A page load while Tor is still starting gets the connecting page at once, and
    /// only a page load: a subresource is not answered with a page it cannot show.
    #[tokio::test]
    async fn a_document_waits_on_a_progress_page_and_a_subresource_does_not() {
        let config = crate::server::ProxyConfig {
            // Nothing listens here: reaching it would be a 502, not the progress page.
            tor_proxy: Some("socks5h://127.0.0.1:1".to_string()),
            tor_progress: Some(std::sync::Arc::new(Fixed(TorProgress::Starting {
                percent: 30,
            }))),
            ..Default::default()
        };
        let state = std::sync::Arc::new(ProxyState::new(&config));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(crate::server::serve(listener, state));

        let client = reqwest::Client::new();
        let get = |dest: &'static str| {
            let client = client.clone();
            async move {
                client
                    .get(format!("http://127.0.0.1:{port}/"))
                    .header("host", format!("{SITE}.localhost:{port}"))
                    .header("sec-fetch-dest", dest)
                    .send()
                    .await
                    .unwrap()
            }
        };

        let document = get("document").await;
        assert_eq!(document.status(), StatusCode::OK);
        let text = document.text().await.unwrap();
        assert!(
            text.contains("Connecting to Tor") && text.contains("30%"),
            "{text}"
        );

        let image = get("image").await;
        assert_ne!(image.status(), StatusCode::OK);
        let text = image.text().await.unwrap();
        assert!(!text.contains("Connecting to Tor"), "{text}");
    }
}
