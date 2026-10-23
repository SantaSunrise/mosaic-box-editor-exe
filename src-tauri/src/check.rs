//! AI mosaic check: list targets, sample frames with FFmpeg and ask the
//! Access-protected Worker for regions that still need a mosaic.
//!
//! The pass/fail rule follows the team's mosaic_check.py: ten frames per
//! video, and a single detection in any frame makes the whole file NG.
use crate::{media::media_command, project::collect_media};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    path::{Component, Path},
    sync::{
        atomic::{AtomicBool, Ordering},
        Condvar, Mutex,
    },
    time::Duration,
};

pub const FRAMES_PER_VIDEO: usize = 10;
/// A detection at or above this probability is NG; below it (down to the
/// Worker's threshold, 0.5) the frame only "needs a look". Same rule as ng_check.py.
pub const NG_SCORE: f64 = 0.8;
/// Longest edge sent to the model. Smaller frames keep the request and the
/// input token count bounded; see docs/ai-check/estimate.md.
pub const MAX_EDGE: u32 = 1024;
/// Most frame requests in flight to the Worker at once, across all files.
pub const MAX_IN_FLIGHT: usize = 20;
/// Most FFmpeg frame extractions at once, so decoding does not starve the UI.
pub const MAX_EXTRACTIONS: usize = 6;
/// Retries after a 429/529/5xx or a dropped connection (so up to 4 attempts).
pub const MAX_RETRIES: u32 = 3;
const RETRY_BASE: Duration = Duration::from_secs(1);
const RETRY_AFTER_CAP: Duration = Duration::from_secs(30);
pub const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp"];

/// Counting semaphore. The app-wide instances below bound work across every
/// file being checked, not just within one.
pub struct Limiter {
    used: Mutex<usize>,
    freed: Condvar,
    max: usize,
}

pub struct Permit<'a>(&'a Limiter);

impl Limiter {
    pub const fn new(max: usize) -> Self {
        Self {
            used: Mutex::new(0),
            freed: Condvar::new(),
            max,
        }
    }

    pub fn acquire(&self) -> Permit<'_> {
        let mut used = self.used.lock().unwrap_or_else(|e| e.into_inner());
        while *used >= self.max {
            used = self.freed.wait(used).unwrap_or_else(|e| e.into_inner());
        }
        *used += 1;
        Permit(self)
    }
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        *self.0.used.lock().unwrap_or_else(|e| e.into_inner()) -= 1;
        self.0.freed.notify_one();
    }
}

static REQUEST_SLOTS: Limiter = Limiter::new(MAX_IN_FLIGHT);
static EXTRACTION_SLOTS: Limiter = Limiter::new(MAX_EXTRACTIONS);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckTarget {
    /// Path relative to the checked folder, with `/` separators.
    pub name: String,
    pub path: String,
    /// `image` or `video`.
    pub kind: String,
    /// `original` (the opened folder) or `mosaic` (exported outputs).
    pub source: String,
    /// Relative path without extension. Matches `VideoEntry::box_key` so the
    /// UI can jump from a result to the editor.
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub label: String,
    /// Probability that the frame shows this unmosaicked region.
    pub score: f64,
    /// Normalized `[x0, y0, x1, y1]`, the same 0–1 space as saved selections.
    #[serde(rename = "box")]
    pub box_: [f64; 4],
    /// False when the model gave no usable box and `box` is the whole frame.
    #[serde(default = "located_default")]
    pub located: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_confidence: Option<f64>,
}

fn located_default() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrameResult {
    pub index: usize,
    /// Seconds from the start; `None` for still images.
    pub time: Option<f64>,
    pub detections: Vec<Detection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCheckResult {
    pub name: String,
    pub kind: String,
    pub source: String,
    pub key: String,
    /// `ng`, `error`, `review` (detections below NG_SCORE only) or `ok`.
    pub verdict: String,
    /// Display size of the original (rotation applied) so boxes, which are
    /// normalized, can be converted to source pixels. `None` if unreadable.
    pub width: Option<usize>,
    pub height: Option<usize>,
    pub frames: Vec<FrameResult>,
    pub model: String,
    /// Input tokens reported by the model, for the free-tier estimate.
    pub input_tokens: u64,
}

pub fn list_check_targets(root: &Path, scope: &str) -> Result<Vec<CheckTarget>, String> {
    if !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }
    let (base, extensions): (_, Vec<&str>) = match scope {
        "original" => (
            root.to_path_buf(),
            IMAGE_EXTENSIONS
                .iter()
                .chain(crate::project::VIDEO_EXTENSIONS)
                .copied()
                .collect(),
        ),
        "mosaic" => (root.join("mosaic"), vec!["mp4"]),
        _ => return Err("invalid check scope".into()),
    };
    if !base.is_dir() {
        return Ok(Vec::new());
    }
    collect_media(&base, &extensions)?
        .into_iter()
        .map(|path| {
            let relative = path.strip_prefix(&base).map_err(|e| e.to_string())?;
            let ext = path
                .extension()
                .and_then(|x| x.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            Ok(CheckTarget {
                name: relative.to_string_lossy().replace('\\', "/"),
                path: path.to_string_lossy().into_owned(),
                kind: if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
                    "image".into()
                } else {
                    "video".into()
                },
                source: scope.into(),
                key: relative
                    .with_extension("")
                    .to_string_lossy()
                    .replace('\\', "/"),
            })
        })
        .collect()
}

/// Evenly spaced sample times, centred in each slice so the first and last
/// frames avoid fades and black leaders.
pub fn frame_times(duration: f64, count: usize) -> Vec<f64> {
    if !duration.is_finite() || duration <= 0.0 || count == 0 {
        return vec![0.0];
    }
    (0..count)
        .map(|i| (i as f64 + 0.5) * duration / count as f64)
        .collect()
}

/// A detection at NG_SCORE or above makes the file NG. Otherwise a frame that
/// could not be checked makes it an error rather than OK, then weaker
/// detections make it `review`.
pub fn verdict(frames: &[FrameResult]) -> &'static str {
    let detections = || frames.iter().flat_map(|f| f.detections.iter());
    if detections().any(|d| d.score >= NG_SCORE) {
        "ng"
    } else if frames.is_empty() || frames.iter().any(|f| f.error.is_some()) {
        "error"
    } else if detections().next().is_some() {
        "review"
    } else {
        "ok"
    }
}

fn safe_relative(name: &str) -> Result<&Path, String> {
    let relative = Path::new(name);
    if name.is_empty()
        || relative.is_absolute()
        || !relative
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err("invalid target path".into());
    }
    Ok(relative)
}

pub(crate) fn probe_duration(source: &Path) -> Result<f64, String> {
    let probe = media_command("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
        ])
        .arg(source)
        .output()
        .map_err(|e| format!("ffprobeを起動できませんでした：{e}"))?;
    if !probe.status.success() {
        return Err(String::from_utf8_lossy(&probe.stderr).trim().to_string());
    }
    let info: serde_json::Value =
        serde_json::from_slice(&probe.stdout).map_err(|e| e.to_string())?;
    info["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .ok_or_else(|| "動画の長さを取得できませんでした".into())
}

/// Decode one frame (or a still image) as a JPEG no larger than `MAX_EDGE`.
fn extract_jpeg(source: &Path, time: Option<f64>) -> Result<Vec<u8>, String> {
    let scale = format!(
        "scale='min({MAX_EDGE},iw)':'min({MAX_EDGE},ih)':force_original_aspect_ratio=decrease"
    );
    extract_jpeg_with(source, time, &scale, "3")
}

/// Decode one frame (or a still image) as a JPEG, filtered by `scale` and
/// encoded at ffmpeg quality `quality` (2 best to 31 worst).
pub(crate) fn extract_jpeg_with(
    source: &Path,
    time: Option<f64>,
    scale: &str,
    quality: &str,
) -> Result<Vec<u8>, String> {
    let mut command = media_command("ffmpeg");
    command.args(["-v", "error"]);
    if let Some(time) = time {
        command.args(["-ss", &format!("{time:.3}")]);
    }
    let output = command
        .arg("-i")
        .arg(source)
        .args([
            "-frames:v",
            "1",
            "-vf",
            scale,
            "-f",
            "image2pipe",
            "-c:v",
            "mjpeg",
            "-q:v",
            quality,
            "-",
        ])
        .output()
        .map_err(|e| format!("ffmpegを起動できませんでした：{e}"))?;
    if !output.status.success() || output.stdout.is_empty() {
        return Err(format!(
            "フレームを取り出せませんでした：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output.stdout)
}

#[derive(Serialize)]
struct DetectFrame {
    id: String,
    mime: &'static str,
    data: String,
}

#[derive(Serialize)]
struct DetectRequest {
    frames: Vec<DetectFrame>,
}

#[derive(Debug, Deserialize)]
struct DetectResponseFrame {
    id: String,
    #[serde(default)]
    detections: Vec<Detection>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DetectResponse {
    frames: Vec<DetectResponseFrame>,
    #[serde(default)]
    model: String,
    #[serde(default)]
    usage: Usage,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: u64,
}

/// Errors starting with this prefix tell the UI to show the login button.
pub const AUTH_REQUIRED: &str = "AUTH_REQUIRED";

/// A failed request. `retry` marks overload and transient network failures.
#[derive(Debug)]
pub struct PostError {
    pub message: String,
    pub retry: bool,
    pub retry_after: Option<Duration>,
}

impl PostError {
    fn fatal(message: String) -> Self {
        Self {
            message,
            retry: false,
            retry_after: None,
        }
    }
}

/// The Worker answers 200 with a per-frame error such as
/// `model error (TypeSafe API HTTP 429)` when the model backend is overloaded.
fn frame_error_is_transient(error: &str) -> bool {
    [
        "HTTP 429",
        "HTTP 529",
        "HTTP 502",
        "HTTP 503",
        "HTTP 504",
        "unreachable",
    ]
    .iter()
    .any(|marker| error.contains(marker))
}

fn post_detect_once(
    api_base: &str,
    token: &str,
    request: &DetectRequest,
) -> Result<DetectResponse, PostError> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(180)))
        // Access answers an expired token with a redirect to the login page.
        .max_redirects(0)
        .http_status_as_error(false)
        .build()
        .into();
    let mut response = agent
        .post(&format!("{api_base}/v1/detect"))
        .header("cf-access-token", token)
        .send_json(request)
        .map_err(|e| PostError {
            message: format!("判定APIに接続できませんでした：{e}"),
            retry: true,
            retry_after: None,
        })?;
    let status = response.status().as_u16();
    if matches!(status, 301..=303 | 307 | 308 | 401 | 403) {
        return Err(PostError::fatal(format!(
            "{AUTH_REQUIRED}: ログインの有効期限が切れました（HTTP {status}）"
        )));
    }
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(|secs| Duration::from_secs(secs).min(RETRY_AFTER_CAP));
    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|e| PostError::fatal(e.to_string()))?;
    if !(200..300).contains(&status) {
        return Err(PostError {
            message: format!("判定APIがエラーを返しました（HTTP {status}）：{body}"),
            retry: matches!(status, 429 | 502 | 503 | 504 | 529),
            retry_after,
        });
    }
    serde_json::from_str(&body)
        .map_err(|e| PostError::fatal(format!("判定APIの応答を読めませんでした：{e}")))
}

/// Sends one request, retrying transient failures with Retry-After or
/// exponential backoff (base, 2x base, 4x base). The in-flight slot is held
/// only while a request is on the wire, never while waiting to retry.
/// Auth failures are never retried.
fn post_detect(
    limiter: &Limiter,
    base_delay: Duration,
    api_base: &str,
    token: &str,
    request: &DetectRequest,
) -> Result<DetectResponse, String> {
    let mut attempt = 0;
    loop {
        let outcome = {
            let _slot = limiter.acquire();
            post_detect_once(api_base, token, request)
        };
        let retry_after = match outcome {
            Ok(response) => {
                let transient = response
                    .frames
                    .iter()
                    .any(|f| f.error.as_deref().is_some_and(frame_error_is_transient));
                if !transient || attempt >= MAX_RETRIES {
                    return Ok(response);
                }
                None
            }
            Err(error) if error.retry && attempt < MAX_RETRIES => error.retry_after,
            Err(error) => return Err(error.message),
        };
        std::thread::sleep(retry_after.unwrap_or(base_delay * 2u32.pow(attempt)));
        attempt += 1;
    }
}

struct FrameOutcome {
    result: FrameResult,
    model: String,
    input_tokens: u64,
}

/// Extract and check one frame. `Err` only for a login problem.
#[allow(clippy::too_many_arguments)]
fn check_frame(
    source: &Path,
    index: usize,
    time: Option<f64>,
    api_base: &str,
    token: &str,
    limiter: &Limiter,
    base_delay: Duration,
) -> Result<FrameOutcome, String> {
    let mut outcome = FrameOutcome {
        result: FrameResult {
            index,
            time,
            detections: Vec::new(),
            error: None,
        },
        model: String::new(),
        input_tokens: 0,
    };
    let extracted = {
        let _slot = EXTRACTION_SLOTS.acquire();
        extract_jpeg(source, time)
    };
    let request = match extracted {
        Ok(bytes) => DetectRequest {
            frames: vec![DetectFrame {
                id: index.to_string(),
                mime: "image/jpeg",
                data: STANDARD.encode(bytes),
            }],
        },
        Err(error) => {
            outcome.result.error = Some(error);
            return Ok(outcome);
        }
    };
    match post_detect(limiter, base_delay, api_base, token, &request) {
        Ok(response) => {
            outcome.model = response.model;
            outcome.input_tokens = response.usage.input_tokens;
            match response
                .frames
                .into_iter()
                .find(|f| f.id == request.frames[0].id)
            {
                Some(frame) => {
                    outcome.result.detections = frame
                        .detections
                        .into_iter()
                        .filter(|d| d.box_.iter().all(|v| v.is_finite()))
                        .collect();
                    outcome.result.error = frame.error;
                }
                // A frame the Worker silently dropped must not count as clean.
                None => outcome.result.error = Some("判定結果がありません".into()),
            }
        }
        // Login problems stop the file; the UI asks the user to log in again.
        Err(error) if error.starts_with(AUTH_REQUIRED) => return Err(error),
        Err(error) => outcome.result.error = Some(error),
    }
    Ok(outcome)
}

/// Checks every frame in parallel and returns them in frame order. Stops
/// starting new frames once a login problem is seen.
pub fn check_frames(
    source: &Path,
    times: &[Option<f64>],
    api_base: &str,
    token: &str,
    limiter: &Limiter,
    base_delay: Duration,
) -> Result<(Vec<FrameResult>, String, u64), String> {
    let stop = AtomicBool::new(false);
    let outcomes: Vec<Option<Result<FrameOutcome, String>>> = std::thread::scope(|scope| {
        let handles: Vec<_> = times
            .iter()
            .copied()
            .enumerate()
            .map(|(index, time)| {
                let stop = &stop;
                scope.spawn(move || {
                    if stop.load(Ordering::SeqCst) {
                        return None;
                    }
                    let outcome =
                        check_frame(source, index, time, api_base, token, limiter, base_delay);
                    if outcome.is_err() {
                        stop.store(true, Ordering::SeqCst);
                    }
                    Some(outcome)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or(None))
            .collect()
    });
    let mut frames = Vec::with_capacity(outcomes.len());
    let mut model = String::new();
    let mut input_tokens = 0;
    for outcome in outcomes {
        match outcome {
            Some(Ok(outcome)) => {
                if !outcome.model.is_empty() {
                    model = outcome.model;
                }
                input_tokens += outcome.input_tokens;
                frames.push(outcome.result);
            }
            Some(Err(error)) => return Err(error),
            None => {}
        }
    }
    frames.sort_by_key(|f| f.index);
    Ok((frames, model, input_tokens))
}

pub fn check_target(
    root: &Path,
    scope: &str,
    name: &str,
    api_base: &str,
    token: &str,
) -> Result<FileCheckResult, String> {
    let relative = safe_relative(name)?;
    let base = match scope {
        "original" => root.to_path_buf(),
        "mosaic" => root.join("mosaic"),
        _ => return Err("invalid check scope".into()),
    };
    let source = base.join(relative);
    if !source.is_file() {
        return Err("ファイルが見つかりません".into());
    }
    let ext = source
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let is_image = IMAGE_EXTENSIONS.contains(&ext.as_str());
    let times: Vec<Option<f64>> = if is_image {
        vec![None]
    } else {
        frame_times(probe_duration(&source)?, FRAMES_PER_VIDEO)
            .into_iter()
            .map(Some)
            .collect()
    };

    // One frame per request keeps each body small enough for the Workers Free
    // CPU limit and lets a single failed frame be reported without losing the rest.
    // Frames of one file run in parallel; the app-wide limiters cap the total.
    let (frames, model, input_tokens) =
        check_frames(&source, &times, api_base, token, &REQUEST_SLOTS, RETRY_BASE)?;
    let (width, height) = match crate::media::probe_dimensions(&source) {
        Ok((w, h)) => (Some(w), Some(h)),
        Err(_) => (None, None),
    };
    Ok(FileCheckResult {
        name: name.replace('\\', "/"),
        kind: if is_image { "image" } else { "video" }.into(),
        source: scope.into(),
        key: relative
            .with_extension("")
            .to_string_lossy()
            .replace('\\', "/"),
        verdict: verdict(&frames).into(),
        width,
        height,
        frames,
        model,
        input_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    /// (status line, extra headers, body) for the n-th request, 0-based.
    type Reply = (&'static str, &'static str, String);

    struct Server {
        base: String,
        total: Arc<AtomicUsize>,
        peak: Arc<AtomicUsize>,
    }

    /// Threaded stand-in for the Worker. Each request is held for `hold` so
    /// overlap is measurable; `peak` is the most requests in flight at once.
    fn serve(
        hold: Duration,
        reply: impl Fn(usize, &serde_json::Value) -> Reply + Send + Sync + 'static,
    ) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let total = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let reply = Arc::new(reply);
        let (t, p) = (total.clone(), peak.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let stream = stream.unwrap();
                let (total, active, peak, reply) =
                    (t.clone(), active.clone(), p.clone(), reply.clone());
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream);
                    let mut length = 0;
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        if line == "\r\n" {
                            break;
                        }
                        if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                            length = v.trim().parse().unwrap();
                        }
                    }
                    let mut body = vec![0; length];
                    reader.read_exact(&mut body).unwrap();
                    let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
                    let n = total.fetch_add(1, Ordering::SeqCst);
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    std::thread::sleep(hold);
                    active.fetch_sub(1, Ordering::SeqCst);
                    let (status, headers, body) = reply(n, &request);
                    let _ = write!(
                        reader.get_mut(),
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                });
            }
        });
        Server { base, total, peak }
    }

    fn ok_body(id: &str) -> String {
        serde_json::json!({"model": "m", "frames": [{"id": id, "detections": []}], "usage": {"inputTokens": 5}})
            .to_string()
    }

    fn request(id: &str) -> DetectRequest {
        DetectRequest {
            frames: vec![DetectFrame {
                id: id.into(),
                mime: "image/jpeg",
                data: "AA==".into(),
            }],
        }
    }

    const FAST: Duration = Duration::from_millis(1);

    #[test]
    fn limiter_never_exceeds_its_limit() {
        let limiter = Limiter::new(3);
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..12 {
                scope.spawn(|| {
                    let _slot = limiter.acquire();
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(20));
                    active.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        assert_eq!(peak.load(Ordering::SeqCst), 3);
        assert_eq!(MAX_IN_FLIGHT, 20);
    }

    #[test]
    fn overload_is_retried_with_retry_after() {
        // 429 with Retry-After, then 529, then success.
        let server = serve(Duration::ZERO, |n, req| match n {
            0 => ("429 Too Many Requests", "Retry-After: 0\r\n", "{}".into()),
            1 => ("529 Overloaded", "", "{}".into()),
            _ => (
                "200 OK",
                "",
                ok_body(req["frames"][0]["id"].as_str().unwrap()),
            ),
        });
        let response =
            post_detect(&Limiter::new(1), FAST, &server.base, "t", &request("7")).unwrap();
        assert_eq!(response.frames[0].id, "7");
        assert_eq!(server.total.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn model_overload_inside_a_200_is_retried_and_gives_up_after_three_retries() {
        let flaky = serve(Duration::ZERO, |n, req| {
            let id = req["frames"][0]["id"].as_str().unwrap();
            if n == 0 {
                let body = serde_json::json!({"model": "m", "frames": [{"id": id, "detections": [], "error": "model error (TypeSafe API HTTP 429)"}]});
                ("200 OK", "", body.to_string())
            } else {
                ("200 OK", "", ok_body(id))
            }
        });
        let response =
            post_detect(&Limiter::new(1), FAST, &flaky.base, "t", &request("1")).unwrap();
        assert!(response.frames[0].error.is_none());
        assert_eq!(flaky.total.load(Ordering::SeqCst), 2);

        let down = serve(Duration::ZERO, |_, _| {
            ("429 Too Many Requests", "", "busy".into())
        });
        let error =
            post_detect(&Limiter::new(1), FAST, &down.base, "t", &request("1")).unwrap_err();
        assert!(error.contains("HTTP 429"));
        assert_eq!(down.total.load(Ordering::SeqCst), 1 + MAX_RETRIES as usize);
    }

    #[test]
    fn auth_failures_are_not_retried() {
        for status in ["401 Unauthorized", "403 Forbidden"] {
            let server = serve(Duration::ZERO, move |_, _| (status, "", "no".into()));
            let error =
                post_detect(&Limiter::new(1), FAST, &server.base, "t", &request("1")).unwrap_err();
            assert!(error.starts_with(AUTH_REQUIRED));
            assert_eq!(server.total.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn connection_errors_are_retried_then_reported() {
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let error = post_detect(
            &Limiter::new(1),
            FAST,
            &format!("http://127.0.0.1:{port}"),
            "t",
            &request("1"),
        )
        .unwrap_err();
        assert!(error.contains("接続できませんでした"));
    }

    #[test]
    #[ignore = "requires local ffmpeg and ffprobe"]
    fn frames_run_in_parallel_within_the_limit_and_keep_their_order() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("clip.mp4");
        let made = crate::media::media_command("ffmpeg")
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=640x360:rate=10",
                "-t",
                "3",
                "-c:v",
                "libx264",
            ])
            .arg(&source)
            .output()
            .unwrap();
        assert!(made.status.success());
        // Every frame is rejected once with 429 first, and frame ids return
        // out of order because later frames answer faster.
        let seen = Arc::new(Mutex::new(std::collections::HashSet::new()));
        let server = serve(Duration::from_millis(60), move |_, req| {
            let id = req["frames"][0]["id"].as_str().unwrap().to_string();
            if seen.lock().unwrap().insert(id.clone()) {
                return ("429 Too Many Requests", "Retry-After: 0\r\n", "{}".into());
            }
            let detections = if id == "6" {
                serde_json::json!([{"label": "genitals", "score": 0.9, "box": [0.1, 0.1, 0.2, 0.2]}])
            } else {
                serde_json::json!([])
            };
            let body = serde_json::json!({"model": "m", "frames": [{"id": id, "detections": detections}], "usage": {"inputTokens": 100}});
            ("200 OK", "", body.to_string())
        });
        let times: Vec<Option<f64>> = frame_times(3.0, 10).into_iter().map(Some).collect();
        let limiter = Limiter::new(4);
        let (frames, model, tokens) =
            check_frames(&source, &times, &server.base, "t", &limiter, FAST).unwrap();
        assert_eq!(frames.len(), 10);
        assert!(frames
            .iter()
            .enumerate()
            .all(|(i, f)| f.index == i && f.error.is_none()));
        assert!((frames[3].time.unwrap() - 1.05).abs() < 1e-9);
        assert_eq!(frames[6].detections.len(), 1);
        assert_eq!((model.as_str(), tokens), ("m", 1000));
        assert_eq!(server.total.load(Ordering::SeqCst), 20);
        let peak = server.peak.load(Ordering::SeqCst);
        assert!((2..=4).contains(&peak), "peak in flight was {peak}");
    }
}
