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
    time::Duration,
};

pub const FRAMES_PER_VIDEO: usize = 10;
/// A detection at or above this probability is NG; below it (down to the
/// Worker's threshold, 0.5) the frame only "needs a look". Same rule as ng_check.py.
pub const NG_SCORE: f64 = 0.8;
/// Longest edge sent to the model. Smaller frames keep the request and the
/// input token count bounded; see docs/ai-check/estimate.md.
pub const MAX_EDGE: u32 = 1024;
pub const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp"];

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

fn probe_duration(source: &Path) -> Result<f64, String> {
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
    let mut command = media_command("ffmpeg");
    command.args(["-v", "error"]);
    if let Some(time) = time {
        command.args(["-ss", &format!("{time:.3}")]);
    }
    let scale = format!(
        "scale='min({MAX_EDGE},iw)':'min({MAX_EDGE},ih)':force_original_aspect_ratio=decrease"
    );
    let output = command
        .arg("-i")
        .arg(source)
        .args([
            "-frames:v",
            "1",
            "-vf",
            &scale,
            "-f",
            "image2pipe",
            "-c:v",
            "mjpeg",
            "-q:v",
            "3",
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

#[derive(Deserialize)]
struct DetectResponseFrame {
    id: String,
    #[serde(default)]
    detections: Vec<Detection>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
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

fn post_detect(
    api_base: &str,
    token: &str,
    request: &DetectRequest,
) -> Result<DetectResponse, String> {
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
        .map_err(|e| format!("判定APIに接続できませんでした：{e}"))?;
    let status = response.status().as_u16();
    if matches!(status, 301..=303 | 307 | 308 | 401 | 403) {
        return Err(format!(
            "{AUTH_REQUIRED}: ログインの有効期限が切れました（HTTP {status}）"
        ));
    }
    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    if !(200..300).contains(&status) {
        return Err(format!(
            "判定APIがエラーを返しました（HTTP {status}）：{body}"
        ));
    }
    serde_json::from_str(&body).map_err(|e| format!("判定APIの応答を読めませんでした：{e}"))
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
    let mut frames: Vec<FrameResult> = Vec::with_capacity(times.len());
    let mut model = String::new();
    let mut input_tokens = 0;
    for (index, time) in times.iter().copied().enumerate() {
        let mut result = FrameResult {
            index,
            time,
            detections: Vec::new(),
            error: None,
        };
        let request = match extract_jpeg(&source, time) {
            Ok(bytes) => DetectRequest {
                frames: vec![DetectFrame {
                    id: index.to_string(),
                    mime: "image/jpeg",
                    data: STANDARD.encode(bytes),
                }],
            },
            Err(error) => {
                result.error = Some(error);
                frames.push(result);
                continue;
            }
        };
        match post_detect(api_base, token, &request) {
            Ok(response) => {
                model = response.model;
                input_tokens += response.usage.input_tokens;
                match response
                    .frames
                    .into_iter()
                    .find(|f| f.id == request.frames[0].id)
                {
                    Some(frame) => {
                        result.detections = frame
                            .detections
                            .into_iter()
                            .filter(|d| d.box_.iter().all(|v| v.is_finite()))
                            .collect();
                        result.error = frame.error;
                    }
                    // A frame the Worker silently dropped must not count as clean.
                    None => result.error = Some("判定結果がありません".into()),
                }
            }
            // Login problems stop the file; the UI asks the user to log in again.
            Err(error) if error.starts_with(AUTH_REQUIRED) => return Err(error),
            Err(error) => result.error = Some(error),
        }
        frames.push(result);
    }
    frames.sort_by_key(|f| f.index);
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
