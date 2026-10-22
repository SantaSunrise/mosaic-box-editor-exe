//! Cloudflare Access login for the desktop app.
//!
//! The system browser opens `<api>/auth/desktop`, which Access protects. After
//! the identity provider login, the Worker redirects the browser to a one-shot
//! loopback listener with the Access application token (RFC 8252 style). The
//! token stays in memory and is sent as `cf-access-token` on API calls.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthInfo {
    pub api_base: String,
    pub email: Option<String>,
    /// Unix seconds.
    pub expires_at: Option<i64>,
}

/// Only HTTPS, or plain HTTP to this machine for `wrangler dev`. The token is
/// bound to this origin and is never sent elsewhere.
pub fn normalize_api_base(input: &str) -> Result<String, String> {
    let url = url::Url::parse(input.trim()).map_err(|_| "判定APIのURLが正しくありません")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && local))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("判定APIのURLは https:// で始まるURLを指定してください".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn random_state() -> Result<String, String> {
    let mut bytes = [0_u8; 24];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub struct PendingLogin {
    listener: TcpListener,
    pub state: String,
    pub port: u16,
}

pub fn start_login() -> Result<PendingLogin, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    Ok(PendingLogin {
        listener,
        state: random_state()?,
        port,
    })
}

pub fn login_url(api_base: &str, pending: &PendingLogin) -> String {
    format!(
        "{api_base}/auth/desktop?port={}&state={}",
        pending.port, pending.state
    )
}

/// Parse the first line of a loopback request. `Ok(None)` means an unrelated
/// request (for example `/favicon.ico`) that should be ignored.
pub fn parse_callback(request_line: &str, expected_state: &str) -> Result<Option<String>, String> {
    let mut parts = request_line.split_whitespace();
    let (Some("GET"), Some(target)) = (parts.next(), parts.next()) else {
        return Ok(None);
    };
    let url = url::Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| "invalid callback".to_string())?;
    if url.path() != "/callback" {
        return Ok(None);
    }
    let mut state = None;
    let mut token = None;
    let mut error = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "state" => state = Some(value.into_owned()),
            "token" => token = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            _ => {}
        }
    }
    if state.as_deref() != Some(expected_state) {
        return Err("ログイン応答を確認できませんでした（state 不一致）".into());
    }
    if let Some(error) = error {
        return Err(format!("ログインできませんでした：{error}"));
    }
    match token {
        Some(token) if token.split('.').count() == 3 => Ok(Some(token)),
        _ => Err("ログイン応答にトークンがありません".into()),
    }
}

fn respond(stream: &mut TcpStream, ok: bool) {
    let message = if ok {
        "ログインしました。このタブを閉じて Mosaic Box Editor に戻ってください。"
    } else {
        "ログインできませんでした。Mosaic Box Editor に戻ってやり直してください。"
    };
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>Mosaic Box Editor</title><p>{message}</p>"
    );
    let _ = write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

/// Wait for the browser redirect. Returns the Access application token.
pub fn wait_for_token(pending: PendingLogin, timeout: Duration) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    pending
        .listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;
    while Instant::now() < deadline {
        let mut stream = match pending.listener.accept() {
            Ok((stream, _)) => stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(error) => return Err(error.to_string()),
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buffer = vec![0_u8; 16 * 1024];
        let mut read = 0;
        // The request line is enough; stop at the first CRLF.
        while read < buffer.len() {
            match stream.read(&mut buffer[read..]) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    read += n;
                    if buffer[..read].windows(2).any(|w| w == b"\r\n") {
                        break;
                    }
                }
            }
        }
        let head = String::from_utf8_lossy(&buffer[..read]);
        let line = head.lines().next().unwrap_or("");
        match parse_callback(line, &pending.state) {
            Ok(Some(token)) => {
                respond(&mut stream, true);
                return Ok(token);
            }
            Ok(None) => {
                let _ = stream.write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
            Err(error) => {
                respond(&mut stream, false);
                return Err(error);
            }
        }
    }
    Err("ログインがタイムアウトしました。もう一度お試しください".into())
}

/// Read display claims. The app does not trust these for authorization:
/// Access and the Worker verify the signature on every request.
pub fn token_info(api_base: &str, token: &str) -> Result<AuthInfo, String> {
    let payload = token.split('.').nth(1).ok_or("invalid token")?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .map_err(|_| "invalid token")?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "invalid token")?;
    Ok(AuthInfo {
        api_base: api_base.into(),
        email: claims["email"].as_str().map(str::to_string),
        expires_at: claims["exp"].as_i64(),
    })
}

pub fn is_expired(info: &AuthInfo) -> bool {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    // A minute of slack so a long video check does not start with a dying token.
    info.expires_at.is_some_and(|exp| exp <= now + 60)
}
