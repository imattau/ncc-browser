//! Just enough SOCKS5 for the path into and out of Tor.
//!
//! A `WebView` cannot be handed a proxy per tab, so onion requests arrive at the
//! loopback HTTP listener and have to leave through SOCKS. reqwest is the only thing
//! here that speaks SOCKS by itself. Everything else is this module: the local
//! endpoint that arti sits behind, and the client used when Tor is a separate daemon
//! such as Orbot.
//!
//! Nothing here resolves a name. `socks5h` means the proxy resolves, which is what
//! `.onion` requires — a local lookup either fails or, worse, leaks the address being
//! visited to whatever resolver answered.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub const SUCCESS: u8 = 0x00;
pub const GENERAL_FAILURE: u8 = 0x01;
pub const NETWORK_UNREACHABLE: u8 = 0x03;
pub const HOST_UNREACHABLE: u8 = 0x04;
pub const CONNECTION_REFUSED: u8 = 0x05;
pub const COMMAND_UNSUPPORTED: u8 = 0x07;
pub const ADDRESS_UNSUPPORTED: u8 = 0x08;

/// How long a connection attempt may take before the browser is told it failed.
/// Tor circuit building is slower than a direct dial, which is why this is not a
/// couple of seconds.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(90);

pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}
pub type BoxStream = Box<dyn Stream>;

pub type DialFuture<'a> = Pin<Box<dyn Future<Output = io::Result<BoxStream>> + Send + 'a>>;

/// Where a SOCKS CONNECT can be sent: arti in process, or another daemon.
pub trait Dialer: Send + Sync {
    fn dial<'a>(&'a self, host: &'a str, port: u16) -> DialFuture<'a>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
}

/// Parse `socks5://` or `socks5h://`. Both are accepted and treated the same, because
/// refusing to resolve names locally is the only mode this app has.
pub fn parse_proxy(value: &str) -> Result<Endpoint, String> {
    let raw = value.trim();
    if raw.is_empty() {
        return Err("Enter a SOCKS5 proxy such as socks5h://127.0.0.1:9050".to_string());
    }

    let url = url::Url::parse(raw).map_err(|_| "The Tor proxy is not a valid URL".to_string())?;
    if !matches!(url.scheme(), "socks5" | "socks5h") {
        return Err("The Tor proxy must use socks5:// or socks5h://".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Authenticated SOCKS proxies are not supported".to_string());
    }
    if (!url.path().is_empty() && url.path() != "/") || url.query().is_some() {
        return Err("The Tor proxy must be a host and port, without a path".to_string());
    }

    let host = url
        .host_str()
        .ok_or_else(|| "The Tor proxy has no host".to_string())?;
    let host = host.trim_start_matches('[').trim_end_matches(']');

    Ok(Endpoint {
        host: host.to_string(),
        port: url.port().unwrap_or(9050),
    })
}

/// The canonical form of a proxy URL: `socks5h`, a host and a port. Used wherever
/// the endpoint is stored or shown, so the same address never appears two ways.
pub fn normalize_proxy(value: &str) -> Result<String, String> {
    let endpoint = parse_proxy(value)?;
    let host = if endpoint.host.contains(':') {
        format!("[{}]", endpoint.host)
    } else {
        endpoint.host.clone()
    };
    Ok(format!("socks5h://{host}:{}", endpoint.port))
}

/// Confirm that something is listening and speaking SOCKS5. Used to tell "Tor is not
/// running" apart from "this onion is down", which are the same HTTP failure
/// otherwise.
pub async fn probe(proxy: &Endpoint) -> bool {
    let Ok(Ok(mut stream)) = tokio::time::timeout(
        Duration::from_millis(1500),
        TcpStream::connect((proxy.host.as_str(), proxy.port)),
    )
    .await
    else {
        return false;
    };

    let mut greeting = [0u8; 2];
    let greeted = async {
        stream.write_all(&[0x05, 0x01, 0x00]).await?;
        stream.read_exact(&mut greeting).await
    };
    matches!(
        tokio::time::timeout(Duration::from_millis(1200), greeted).await,
        Ok(Ok(_))
    ) && greeting == [0x05, 0x00]
}

/// Dial `host:port` through an existing SOCKS5 proxy, without resolving it locally.
pub async fn connect_through(proxy: &Endpoint, host: &str, port: u16) -> io::Result<BoxStream> {
    let mut stream = tokio::time::timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((proxy.host.as_str(), proxy.port)),
    )
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "the SOCKS proxy did not answer"))??;
    let _ = stream.set_nodelay(true);

    stream.write_all(&[0x05, 0x01, 0x00]).await?;
    let mut greeting = [0u8; 2];
    stream.read_exact(&mut greeting).await?;
    if greeting != [0x05, 0x00] {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the SOCKS proxy requires authentication",
        ));
    }

    stream.write_all(&connect_request(host, port)?).await?;

    let code = read_reply(&mut stream).await?;
    if code != SUCCESS {
        return Err(io::Error::new(
            io::ErrorKind::ConnectionRefused,
            format!("SOCKS proxy replied {code:#04x}: {}", reply_text(code)),
        ));
    }

    Ok(Box::new(stream))
}

fn connect_request(host: &str, port: u16) -> io::Result<Vec<u8>> {
    let mut request = vec![0x05, 0x01, 0x00];

    if let Ok(address) = host.parse::<std::net::Ipv4Addr>() {
        request.push(0x01);
        request.extend_from_slice(&address.octets());
    } else if let Ok(address) = host.parse::<std::net::Ipv6Addr>() {
        request.push(0x04);
        request.extend_from_slice(&address.octets());
    } else {
        let bytes = host.as_bytes();
        if bytes.is_empty() || bytes.len() > 255 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the SOCKS host name has an unusable length",
            ));
        }
        request.push(0x03);
        request.push(bytes.len() as u8);
        request.extend_from_slice(bytes);
    }

    request.extend_from_slice(&port.to_be_bytes());
    Ok(request)
}

async fn read_reply<S: AsyncRead + Unpin>(stream: &mut S) -> io::Result<u8> {
    let mut head = [0u8; 4];
    stream.read_exact(&mut head).await?;
    if head[0] != 0x05 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the SOCKS proxy did not answer with version 5",
        ));
    }

    let skip = match head[3] {
        0x01 => 4 + 2,
        0x04 => 16 + 2,
        0x03 => {
            let mut length = [0u8; 1];
            stream.read_exact(&mut length).await?;
            length[0] as usize + 2
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "the SOCKS proxy replied with an unknown address type",
            ));
        }
    };
    let mut address = vec![0u8; skip];
    stream.read_exact(&mut address).await?;

    Ok(head[1])
}

/// Serve SOCKS5 CONNECT on `listener`, sending every target through `dialer`.
pub async fn serve(listener: TcpListener, dialer: Arc<dyn Dialer>) {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let dialer = dialer.clone();
                tokio::spawn(async move {
                    if let Err(error) = handle(stream, dialer).await {
                        tracing::debug!(target: "ncc_tor::socks", "connection ended: {error}");
                    }
                });
            }
            Err(error) => {
                tracing::warn!(target: "ncc_tor::socks", "accept failed: {error}");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

struct Request {
    host: String,
    port: u16,
}

async fn handle(mut client: TcpStream, dialer: Arc<dyn Dialer>) -> io::Result<()> {
    let _ = client.set_nodelay(true);

    let Some(request) = read_request(&mut client).await? else {
        return Ok(());
    };

    match dialer.dial(&request.host, request.port).await {
        Ok(mut upstream) => {
            write_reply(&mut client, SUCCESS).await?;
            tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
        }
        Err(error) => {
            // A failed dial is normal: the onion may be down, or Tor may not have a
            // circuit yet. The reply code carries the reason to the browser.
            let code = match error.kind() {
                io::ErrorKind::TimedOut => HOST_UNREACHABLE,
                io::ErrorKind::ConnectionRefused => CONNECTION_REFUSED,
                io::ErrorKind::NetworkUnreachable => NETWORK_UNREACHABLE,
                _ => GENERAL_FAILURE,
            };
            write_reply(&mut client, code).await?;
        }
    }

    Ok(())
}

/// Read the greeting and the CONNECT request. `None` means the client was answered
/// and the connection should close.
async fn read_request(client: &mut TcpStream) -> io::Result<Option<Request>> {
    let mut intro = [0u8; 2];
    client.read_exact(&mut intro).await?;
    if intro[0] != 0x05 {
        return Ok(None);
    }

    let mut methods = vec![0u8; intro[1] as usize];
    client.read_exact(&mut methods).await?;

    if !methods.contains(&0x00) {
        client.write_all(&[0x05, 0xff]).await?;
        return Ok(None);
    }
    client.write_all(&[0x05, 0x00]).await?;

    let mut head = [0u8; 4];
    client.read_exact(&mut head).await?;
    if head[0] != 0x05 {
        return Ok(None);
    }

    let host = match head[3] {
        0x01 => {
            let mut bytes = [0u8; 4];
            client.read_exact(&mut bytes).await?;
            std::net::Ipv4Addr::from(bytes).to_string()
        }
        0x04 => {
            let mut bytes = [0u8; 16];
            client.read_exact(&mut bytes).await?;
            std::net::Ipv6Addr::from(bytes).to_string()
        }
        0x03 => {
            let mut length = [0u8; 1];
            client.read_exact(&mut length).await?;
            let mut bytes = vec![0u8; length[0] as usize];
            client.read_exact(&mut bytes).await?;
            String::from_utf8(bytes)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "host name is not UTF-8"))?
        }
        _ => {
            write_reply(client, ADDRESS_UNSUPPORTED).await?;
            return Ok(None);
        }
    };

    let mut port = [0u8; 2];
    client.read_exact(&mut port).await?;

    if head[1] != 0x01 {
        write_reply(client, COMMAND_UNSUPPORTED).await?;
        return Ok(None);
    }

    Ok(Some(Request {
        host,
        port: u16::from_be_bytes(port),
    }))
}

async fn write_reply<S: AsyncWrite + Unpin>(stream: &mut S, code: u8) -> io::Result<()> {
    // The bound address is meaningless for CONNECT and widely ignored; zeroes are
    // what a browser expects to see.
    stream
        .write_all(&[0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await
}

fn reply_text(code: u8) -> &'static str {
    match code {
        SUCCESS => "succeeded",
        GENERAL_FAILURE => "general SOCKS failure",
        NETWORK_UNREACHABLE => "network unreachable",
        HOST_UNREACHABLE => "host unreachable",
        CONNECTION_REFUSED => "connection refused",
        COMMAND_UNSUPPORTED => "command not supported",
        ADDRESS_UNSUPPORTED => "address type not supported",
        _ => "unknown reply code",
    }
}

/// A dialer that echoes, so a SOCKS round trip can be exercised without Tor. Used by
/// this module's tests and by ncc-tor's own startup tests.
#[cfg(test)]
pub(crate) struct Echo;

#[cfg(test)]
impl Dialer for Echo {
    fn dial<'a>(&'a self, host: &'a str, _port: u16) -> DialFuture<'a> {
        Box::pin(async move {
            assert!(
                host.ends_with(".onion"),
                "the name is passed through unresolved"
            );
            let (near, mut far) = tokio::io::duplex(64);
            tokio::spawn(async move {
                let mut buffer = [0u8; 32];
                loop {
                    match far.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => {
                            if far.write_all(&buffer[..read]).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
            Ok(Box::new(near) as BoxStream)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxies_are_hosts_and_ports_only() {
        assert_eq!(
            parse_proxy("socks5://127.0.0.1:9050").unwrap(),
            Endpoint {
                host: "127.0.0.1".into(),
                port: 9050
            }
        );
        assert_eq!(parse_proxy("socks5h://127.0.0.1").unwrap().port, 9050);
        assert_eq!(
            parse_proxy(" socks5h://[::1]:9150 ").unwrap(),
            Endpoint {
                host: "::1".into(),
                port: 9150
            }
        );

        assert!(parse_proxy("").is_err());
        assert!(parse_proxy("http://127.0.0.1:9050").is_err());
        assert!(parse_proxy("socks5://user:secret@127.0.0.1:9050").is_err());
        assert!(parse_proxy("socks5://127.0.0.1:9050/somewhere").is_err());
    }

    #[test]
    fn host_names_are_sent_as_names() {
        const TARGET: &str = "duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion";
        let request = connect_request(TARGET, 80).unwrap();
        assert_eq!(request[3], 0x03);
        assert_eq!(request[4] as usize, TARGET.len());
        assert_eq!(&request[5..5 + TARGET.len()], TARGET.as_bytes());
        assert_eq!(&request[5 + TARGET.len()..], &[0x00, 80]);
    }

    #[tokio::test]
    async fn a_connect_is_relayed_to_the_dialer() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let endpoint = Endpoint {
            host: "127.0.0.1".into(),
            port: listener.local_addr().unwrap().port(),
        };
        tokio::spawn(serve(listener, Arc::new(Echo)));

        let mut stream = connect_through(&endpoint, "example.onion", 80)
            .await
            .expect("SOCKS connect");
        stream.write_all(b"ping").await.unwrap();
        let mut echoed = [0u8; 4];
        stream.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, b"ping");
    }

    #[tokio::test]
    async fn a_dialer_failure_is_reported_in_the_reply_code() {
        struct Refused;
        impl Dialer for Refused {
            fn dial<'a>(&'a self, _host: &'a str, _port: u16) -> DialFuture<'a> {
                Box::pin(async move {
                    Err(io::Error::new(
                        io::ErrorKind::ConnectionRefused,
                        "nothing there",
                    ))
                })
            }
        }

        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let endpoint = Endpoint {
            host: "127.0.0.1".into(),
            port: listener.local_addr().unwrap().port(),
        };
        tokio::spawn(serve(listener, Arc::new(Refused)));

        let error = connect_through(&endpoint, "gone.onion", 80)
            .await
            .err()
            .expect("a refused dial");
        assert!(error.to_string().contains("connection refused"));
    }

    #[tokio::test]
    async fn probes_tell_a_dead_proxy_from_a_socks_one() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let endpoint = Endpoint {
            host: "127.0.0.1".into(),
            port: listener.local_addr().unwrap().port(),
        };
        tokio::spawn(serve(listener, Arc::new(Echo)));
        assert!(probe(&endpoint).await);

        let closed = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let endpoint = Endpoint {
            host: "127.0.0.1".into(),
            port: closed.local_addr().unwrap().port(),
        };
        drop(closed);
        assert!(!probe(&endpoint).await);
    }
}
